import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'telegram';

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { ...options, parse_mode: 'Markdown' });
  } catch (err) {
    log.debug('Markdown send failed, falling back to plain text', { err });
    await api.sendMessage(chatId, text, options);
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function createAdapter(): ChannelAdapter | null {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    log.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  let bot: Bot | null = null;

  const adapter: ChannelAdapter = {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      bot = new Bot(token);

      bot.command('chatid', (ctx) => {
        const chatId = ctx.chat.id;
        const chatType = ctx.chat.type;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chatName =
          chatType === 'private' ? ctx.from?.first_name || 'Private' : (ctx.chat as any).title || 'Unknown';
        ctx.reply(`Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`, { parse_mode: 'Markdown' });
      });

      bot.command('ping', (ctx) => {
        ctx.reply(`${ASSISTANT_NAME} is online.`);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleMessage = (ctx: any, contentOverride?: string) => {
        const chatJid = `tg:${ctx.chat.id}`;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
        const senderId = `telegram:${ctx.from?.id}`;
        const msgId = ctx.message.message_id.toString();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chatName = ctx.chat.type === 'private' ? senderName : (ctx.chat as any).title || chatJid;
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        const content = contentOverride ?? ctx.message.text ?? '';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const finalContent = contentOverride ? `${contentOverride}${caption}` : content;

        config.onMetadata(chatJid, chatName, isGroup);
        void config.onInbound(chatJid, null, {
          id: msgId,
          kind: 'chat',
          timestamp,
          content: { text: finalContent, sender: senderName, senderId },
          isGroup,
        });
      };

      bot.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) return;
        let content = ctx.message.text;
        const botUsername = ctx.me?.username?.toLowerCase();
        if (botUsername) {
          const entities = ctx.message.entities || [];
          const isBotMentioned = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = content.substring(entity.offset, entity.offset + entity.length).toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
        handleMessage(ctx, content);
      });

      bot.on('message:photo', (ctx) => handleMessage(ctx, '[Photo]'));
      bot.on('message:video', (ctx) => handleMessage(ctx, '[Video]'));
      bot.on('message:voice', (ctx) => handleMessage(ctx, '[Voice message]'));
      bot.on('message:audio', (ctx) => handleMessage(ctx, '[Audio]'));
      bot.on('message:document', (ctx) => {
        const name = ctx.message.document?.file_name || 'file';
        handleMessage(ctx, `[Document: ${name}]`);
      });
      bot.on('message:sticker', (ctx) => {
        const emoji = ctx.message.sticker?.emoji || '';
        handleMessage(ctx, `[Sticker ${emoji}]`);
      });
      bot.on('message:location', (ctx) => handleMessage(ctx, '[Location]'));
      bot.on('message:contact', (ctx) => handleMessage(ctx, '[Contact]'));

      bot.catch((err) => {
        log.error('Telegram bot error', { err: err.message });
      });

      return new Promise<void>((resolve) => {
        bot!.start({
          onStart: (botInfo) => {
            log.info('Telegram bot connected', { username: botInfo.username, id: botInfo.id });
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
            resolve();
          },
        });
      });
    },

    async teardown(): Promise<void> {
      if (bot) {
        bot.stop();
        bot = null;
        log.info('Telegram bot stopped');
      }
    },

    isConnected(): boolean {
      return bot !== null;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!bot) return undefined;

      const text = extractText(message);
      if (!text) return undefined;

      try {
        const numericId = platformId.replace(/^tg:/, '');
        const MAX_LENGTH = 4096;
        if (text.length <= MAX_LENGTH) {
          await sendTelegramMessage(bot.api, numericId, text);
        } else {
          for (let i = 0; i < text.length; i += MAX_LENGTH) {
            await sendTelegramMessage(bot.api, numericId, text.slice(i, i + MAX_LENGTH));
          }
        }
        log.info('Telegram message sent', { platformId, length: text.length });
      } catch (err) {
        log.error('Failed to send Telegram message', { platformId, err });
      }
      return undefined;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!bot) return;
      try {
        const numericId = platformId.replace(/^tg:/, '');
        await bot.api.sendChatAction(numericId, 'typing');
      } catch (err) {
        log.debug('Failed to send Telegram typing indicator', { platformId, err });
      }
    },
  };

  return adapter;
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
