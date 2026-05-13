import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { pino } from 'pino';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'whatsapp';
const baileysLogger = pino({ level: 'silent' });

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function createAdapter(): ChannelAdapter | null {
  const authDir = path.join(STORE_DIR, 'auth');

  // If no auth credentials exist, bail out — user needs to run /setup
  if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
    log.warn('WhatsApp: no auth credentials found, channel skipped');
    return null;
  }

  let sock: WASocket | null = null;
  let connected = false;
  const lidToPhoneMap: Record<string, string> = {};
  const outgoingQueue: Array<{ jid: string; text: string }> = [];
  let flushing = false;
  let setupConfig: ChannelSetup | null = null;

  async function connectInternal(onFirstOpen?: () => void): Promise<void> {
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      log.warn('Failed to fetch latest WA Web version, using default', { err });
      return { version: undefined };
    });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg = 'WhatsApp authentication required. Run /setup in Claude Code.';
        log.error(msg);
        exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        connected = false;
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        log.info('Connection closed', { reason, shouldReconnect, queuedMessages: outgoingQueue.length });

        if (shouldReconnect) {
          log.info('Reconnecting...');
          connectInternal().catch((err) => {
            log.error('Failed to reconnect, retrying in 5s', { err });
            setTimeout(() => {
              connectInternal().catch((err2) => {
                log.error('Reconnection retry failed', { err: err2 });
              });
            }, 5000);
          });
        } else {
          log.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        connected = true;
        log.info('Connected to WhatsApp');

        sock!.sendPresenceUpdate('available').catch((err) => {
          log.warn('Failed to send presence update', { err });
        });

        if (sock!.user) {
          const phoneUser = sock!.user.id.split(':')[0];
          const lidUser = (sock!.user as { lid?: string }).lid?.split(':')[0];
          if (lidUser && phoneUser) {
            lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          }
        }

        flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      if (!setupConfig) return;
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          const chatJid = await translateJid(rawJid);
          const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
          const isGroup = chatJid.endsWith('@g.us');

          setupConfig.onMetadata(chatJid, undefined, isGroup);

          const content =
            normalized.conversation ||
            normalized.extendedTextMessage?.text ||
            normalized.imageMessage?.caption ||
            normalized.videoMessage?.caption ||
            '';

          if (!content) continue;

          const fromMe = msg.key.fromMe || false;
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? fromMe : content.startsWith(`${ASSISTANT_NAME}:`);

          if (isBotMessage) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          await setupConfig.onInbound(chatJid, null, {
            id: msg.key.id || '',
            kind: 'chat',
            timestamp,
            content: {
              text: content,
              sender: senderName,
              senderId: `whatsapp:${sender}`,
              is_from_me: fromMe,
            },
            isGroup,
          });
        } catch (err) {
          log.error('Error processing incoming message', { err, remoteJid: msg.key?.remoteJid });
        }
      }
    });
  }

  async function translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];
    const cached = lidToPhoneMap[lidUser];
    if (cached) return cached;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pn = await (sock as any)?.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        lidToPhoneMap[lidUser] = phoneJid;
        return phoneJid;
      }
    } catch (err) {
      log.debug('Failed to resolve LID via signalRepository', { err, jid });
    }
    return jid;
  }

  async function flushOutgoingQueue(): Promise<void> {
    if (flushing || outgoingQueue.length === 0) return;
    flushing = true;
    try {
      log.info('Flushing outgoing message queue', { count: outgoingQueue.length });
      while (outgoingQueue.length > 0) {
        const item = outgoingQueue.shift()!;
        await sock!.sendMessage(item.jid, { text: item.text });
        log.info('Queued message sent', { jid: item.jid, length: item.text.length });
      }
    } finally {
      flushing = false;
    }
  }

  const adapter: ChannelAdapter = {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
      return new Promise<void>((resolve, reject) => {
        connectInternal(resolve).catch(reject);
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      sock?.end(undefined);
      sock = null;
      log.info('WhatsApp disconnected');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const text = extractText(message);
      if (!text) return undefined;

      const prefixed = ASSISTANT_HAS_OWN_NUMBER ? text : `${ASSISTANT_NAME}: ${text}`;

      if (!connected || !sock) {
        outgoingQueue.push({ jid: platformId, text: prefixed });
        log.info('WA disconnected, message queued', {
          jid: platformId,
          length: prefixed.length,
          queueSize: outgoingQueue.length,
        });
        return undefined;
      }

      try {
        await sock.sendMessage(platformId, { text: prefixed });
        log.info('WhatsApp message sent', { jid: platformId, length: prefixed.length });
      } catch (err) {
        outgoingQueue.push({ jid: platformId, text: prefixed });
        log.warn('Failed to send, message queued', { jid: platformId, err, queueSize: outgoingQueue.length });
      }
      return undefined;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!sock || !connected) return;
      try {
        await sock.sendPresenceUpdate('composing', platformId);
      } catch (err) {
        log.debug('Failed to send WhatsApp typing indicator', { platformId, err });
      }
    },
  };

  return adapter;
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
