import { Client, Events, GatewayIntentBits, Message, TextChannel } from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'discord';

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function createAdapter(): ChannelAdapter | null {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token = process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    log.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }

  let client: Client | null = null;

  const adapter: ChannelAdapter = {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.bot) return;

        const channelId = message.channelId;
        const platformId = `dc:${channelId}`;
        let content = message.content;
        const timestamp = message.createdAt.toISOString();
        const senderName = message.member?.displayName || message.author.displayName || message.author.username;
        const senderId = `discord:${message.author.id}`;
        const msgId = message.id;

        let chatName: string;
        if (message.guild) {
          const textChannel = message.channel as TextChannel;
          chatName = `${message.guild.name} #${textChannel.name}`;
        } else {
          chatName = senderName;
        }

        if (client?.user) {
          const botId = client.user.id;
          const isBotMentioned =
            message.mentions.users.has(botId) || content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);

          if (isBotMentioned) {
            content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
            if (!TRIGGER_PATTERN.test(content)) {
              content = `@${ASSISTANT_NAME} ${content}`;
            }
          }
        }

        if (message.attachments.size > 0) {
          const attachmentDescriptions = [...message.attachments.values()].map((att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) return `[Image: ${att.name || 'image'}]`;
            if (contentType.startsWith('video/')) return `[Video: ${att.name || 'video'}]`;
            if (contentType.startsWith('audio/')) return `[Audio: ${att.name || 'audio'}]`;
            return `[File: ${att.name || 'file'}]`;
          });
          content = content ? `${content}\n${attachmentDescriptions.join('\n')}` : attachmentDescriptions.join('\n');
        }

        if (message.reference?.messageId) {
          try {
            const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
            const replyAuthor =
              repliedTo.member?.displayName || repliedTo.author.displayName || repliedTo.author.username;
            content = `[Reply to ${replyAuthor}] ${content}`;
          } catch {
            // Referenced message may have been deleted
          }
        }

        const isGroup = message.guild !== null;
        config.onMetadata(platformId, chatName, isGroup);

        await config.onInbound(platformId, null, {
          id: msgId,
          kind: 'chat',
          timestamp,
          content: { text: content, sender: senderName, senderId },
          isGroup,
        });

        log.info('Discord message received', { platformId, chatName, sender: senderName });
      });

      client.on(Events.Error, (err) => {
        log.error('Discord client error', { err: err.message });
      });

      return new Promise<void>((resolve) => {
        client!.once(Events.ClientReady, (readyClient) => {
          log.info('Discord bot connected', { username: readyClient.user.tag, id: readyClient.user.id });
          console.log(`\n  Discord bot: ${readyClient.user.tag}`);
          console.log(`  Use /chatid command or check channel IDs in Discord settings\n`);
          resolve();
        });
        client!.login(token);
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        client.destroy();
        client = null;
        log.info('Discord bot stopped');
      }
    },

    isConnected(): boolean {
      return client !== null && client.isReady();
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!client) return undefined;

      const text = extractText(message);
      if (!text) return undefined;

      try {
        const channelId = platformId.replace(/^dc:/, '');
        const channel = await client.channels.fetch(channelId);
        if (!channel || !('send' in channel)) {
          log.warn('Discord channel not found or not text-based', { platformId });
          return undefined;
        }
        const textChannel = channel as TextChannel;
        const MAX_LENGTH = 2000;
        if (text.length <= MAX_LENGTH) {
          const sent = await textChannel.send(text);
          return sent.id;
        }
        let lastId: string | undefined;
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const sent = await textChannel.send(text.slice(i, i + MAX_LENGTH));
          lastId = sent.id;
        }
        return lastId;
      } catch (err) {
        log.error('Failed to send Discord message', { platformId, err });
        return undefined;
      }
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!client) return;
      try {
        const channelId = platformId.replace(/^dc:/, '');
        const channel = await client.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        log.debug('Failed to send Discord typing indicator', { platformId, err });
      }
    },
  };

  return adapter;
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
