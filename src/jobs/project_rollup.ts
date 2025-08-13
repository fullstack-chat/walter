import { ChannelType, ForumChannel, ThreadChannel, Message, EmbedBuilder } from "discord.js";
import { getInstance } from "../container";
import ScheduledJob from "../models/scheduled_job";
import { db, dbSchema } from "../db/client";
import { eq } from "drizzle-orm";

type ThreadMemory = {
  summary?: string
  keyPoints?: string[]
  contributors?: string[]
  lastActiveAt?: string
}

const log = getInstance("logger")

async function getProjectForumChannel(): Promise<ForumChannel | null> {
  const client = getInstance("DiscordClient");
  const forumId = process.env.PROJECT_FORUM_CHANNEL_ID || process.env.PROJECT_FORUM_ID;
  if (!forumId) {
    log.error("PROJECT_FORUM_CHANNEL_ID is not set");
    return null;
  }
  try {
    const ch = await client.channels.fetch(forumId);
    if (ch && ch.type === ChannelType.GuildForum) {
      return ch as ForumChannel;
    }
    log.error(`Channel ${forumId} is not a forum channel.`);
  } catch (e) {
    log.error("Failed to fetch forum channel", e);
  }
  return null;
}

async function fetchAllThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ fetchAll: true });
  const threads: ThreadChannel[] = [];
  active.threads.forEach(t => threads.push(t));
  archived.threads.forEach(t => threads.push(t));
  return threads;
}

async function getOrCreateThreadMemory(thread: ThreadChannel) {
  const existing = await db
    .select()
    .from(dbSchema.projectThreadMemory)
    .where(eq(dbSchema.projectThreadMemory.threadId, thread.id))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(dbSchema.projectThreadMemory)
    .values({
      threadId: thread.id,
      threadName: thread.name ?? "Untitled",
    })
    .returning();
  return inserted[0];
}

async function fetchNewMessages(thread: ThreadChannel, afterMessageId?: string) {
  try {
    const messages = await thread.messages.fetch(
      afterMessageId ? { after: afterMessageId, limit: 100 } : { limit: 50 }
    );
    // Sort ascending by createdTimestamp
    const arr = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    return arr;
  } catch (e) {
    log.error(`Failed to fetch messages for thread ${thread.id}`, e);
    return [];
  }
}

function buildPrompt(threadName: string, prior: ThreadMemory | null, messages: { author: string; content: string }[]) {
  const priorText = prior?.summary ? `Prior memory summary: ${prior.summary}\n` : "";
  const body = messages.map(m => `- ${m.author}: ${m.content}`).join("\n");
  return `You summarize progress updates for software projects concisely.
Thread: ${threadName}
${priorText}
New messages (chronological):\n${body}

Requirements:
- 1-3 sentences, crisp and specific about what progressed, decisions, blockers, and next steps.
- Include names of key contributors if clear.
- Avoid pleasantries and meta-chatter.`;
}

async function summarizeWithOpenAI(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.error("OPENAI_API_KEY not set; skipping AI summary");
    return null;
  }
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    log.error("OpenAI summary failed", e);
    return null;
  }
}

type RollupItem = {
  threadId: string;
  threadName: string;
  url: string;
  summary: string;
  authorMention?: string;
  mentions?: string[];
  userMap?: Record<string, string>; // username (case-insensitive) -> userId
  keyPoints?: string[];
  contributors?: string[];
}

async function postSummaryToGeneral(items: RollupItem[]) {
  if (items.length === 0) return;
  const client = getInstance("DiscordClient");
  const channelId = process.env.GENERAL_CHANNEL_ID as string;
  if (!channelId) {
    log.error("GENERAL_CHANNEL_ID is not set");
    return;
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    log.error("General channel is not a text channel");
    return;
  }
  const embeds = items.map(i => buildProjectEmbed(i));
  for (let i = 0; i < embeds.length; i += 10) {
    // @ts-ignore
    await channel.send({ embeds: embeds.slice(i, i + 10) });
  }
}

async function postSummaryToChannel(channelId: string, items: RollupItem[]) {
  if (items.length === 0) return;
  const client = getInstance("DiscordClient");
  const channel = await client.channels.fetch(channelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    log.error("Target channel is not a text or announcement channel");
    return;
  }
  const embeds = items.map(i => buildProjectEmbed(i));
  for (let i = 0; i < embeds.length; i += 10) {
    // @ts-ignore
    await channel.send({ embeds: embeds.slice(i, i + 10) });
  }
}

function buildProjectEmbed(item: RollupItem) {
  const color = 0x0099FF;
  const base = item.summary || "";
  const desc = truncate(mentionizeSummary(base, item.userMap), 4096);
  const emb = new EmbedBuilder()
    .setColor(color)
    .setTitle(item.threadName || "Project Update")
    .setDescription(desc)
    .setTimestamp(new Date());

  const fields: { name: string; value: string; inline?: boolean }[] = [];
  // Always include project and author fields if available
  fields.push({ name: "Project", value: `<#${item.threadId}>`, inline: true });
  if (item.authorMention) fields.push({ name: "Author", value: item.authorMention, inline: true });
  if (item.keyPoints && item.keyPoints.length) {
    const value = truncate(item.keyPoints.map(k => `• ${k}`).join("\n"), 1024);
    if (value) fields.push({ name: "Key Points", value });
  }
  if (item.contributors && item.contributors.length) {
    const value = truncate(item.contributors.join(", "), 1024);
    if (value) fields.push({ name: "Contributors", value, inline: true });
  }
  if (fields.length) emb.addFields(fields);
  return emb;
}

function truncate(s: string, max: number) {
  if (!s) return s;
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function mentionizeSummary(text: string, userMap?: Record<string, string>) {
  if (!text || !userMap || Object.keys(userMap).length === 0) return text;
  let out = text;
  const entries = Object.entries(userMap).sort((a, b) => b[0].length - a[0].length);
  for (const [username, userId] of entries) {
    const name = username.trim();
    if (!name) continue;
    const escaped = escapeRegExp(name);
    // Replace @username and bare username tokens, avoiding already-mention tokens like <@123>
    const atPattern = new RegExp(`(?<!<@)!?@${escaped}(?!\\w)`, "gi");
    const barePattern = new RegExp(`(?<!<@)\\b${escaped}\\b`, "gi");
    out = out.replace(atPattern, `<@${userId}>`);
    out = out.replace(barePattern, `<@${userId}>`);
  }
  return out;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const projectRollupJob: ScheduledJob = {
  name: "ProjectRollup",
  cron: "0 8 * * *",
  timezone: "America/Chicago",
  execute: async () => {
    await runProjectRollup();
  },
}

export async function runProjectRollup(options?: {
  cutoffMs?: number; // if provided, summarize messages since this timestamp (manual mode)
  postChannelId?: string; // if provided, post results here; else GENERAL_CHANNEL_ID
  updateLastSeen?: boolean; // default true; set false for manual mode so scheduled job remains accurate
}) {
  const forum = await getProjectForumChannel();
  if (!forum) return;

  const threads = await fetchAllThreads(forum);
  const rollupItems: RollupItem[] = [];

  const now = Date.now();
  const cutoffTs = options?.cutoffMs;
  const updateLastSeen = options?.updateLastSeen ?? (cutoffTs ? false : true);

  for (const thread of threads) {
    if (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread && thread.type !== ChannelType.AnnouncementThread) continue;
    
    // Check if thread creator has reacted with :no_mobile_phones: to the starter message
    try {
      const starterMessage = await thread.fetchStarterMessage();
      if (starterMessage) {
        const noMobileReaction = starterMessage.reactions.cache.find(
          reaction => reaction.emoji.name === '🚫📱' || reaction.emoji.name === 'no_mobile_phones'
        );
        
        if (noMobileReaction) {
          const reactors = await noMobileReaction.users.fetch();
          if (reactors.has(thread.ownerId || '')) {
            // Thread creator has opted out with the no_mobile_phones reaction
            log.info(`Skipping thread ${thread.id} due to no_mobile_phones reaction from creator`);
            continue;
          }
        }
      }
    } catch (e) {
      log.error(`Failed to check reactions for thread ${thread.id}`, e);
    }

    const memoryRow = await getOrCreateThreadMemory(thread);
    let msgs;
    if (cutoffTs) {
      msgs = await fetchMessagesSince(thread, cutoffTs);
    } else {
      const lastSeenId = memoryRow.lastSeenMessageId ?? undefined;
      msgs = await fetchNewMessages(thread, lastSeenId);
    }
    if (msgs.length === 0) continue;

    const prepared = msgs
      .filter(m => !m.author.bot && m.content && m.content.trim() !== "")
      .map(m => ({ author: m.author.username, content: m.content.slice(0, 1500) }));
    if (prepared.length === 0) continue;

    const prior: ThreadMemory | null = (memoryRow.memory as any) ?? null;
    const prompt = buildPrompt(thread.name ?? "Untitled", prior, prepared);
    const summary = await summarizeWithOpenAI(prompt);
    if (!summary) continue;

    const guildId = thread.guild?.id ?? "";
    const parentId = thread.parentId ?? thread.id;
    const authorMention = thread.ownerId ? `<@${thread.ownerId}>` : undefined;
    const nonBotMsgs = msgs.filter(m => !m.author.bot && m.content && m.content.trim() !== "");
    const participantMentions = Array.from(new Set(nonBotMsgs.map(m => m.author.id))).map(id => `<@${id}>`);
    const userMap: Record<string, string> = {};
    for (const m of nonBotMsgs) {
      if (m.author?.username && m.author?.id) {
        userMap[m.author.username.toLowerCase()] = m.author.id;
      }
    }
    rollupItems.push({
      threadId: thread.id,
      threadName: thread.name ?? "Untitled",
      url: guildId ? `https://discord.com/channels/${guildId}/${parentId}/${thread.id}` : `https://discord.com/channels/@me/${thread.id}`,
      summary,
      authorMention,
      mentions: participantMentions,
      userMap,
    });

    // Update memory. Only advance lastSeen for scheduled mode.
    const newestId = msgs[msgs.length - 1].id;
    await db
      .update(dbSchema.projectThreadMemory)
      .set({
        lastSeenMessageId: updateLastSeen ? newestId : memoryRow.lastSeenMessageId,
        lastSummaryAt: new Date(),
        memory: {summary},
        threadName: thread.name ?? memoryRow.threadName,
        updatedAt: new Date(),
      })
      .where(eq(dbSchema.projectThreadMemory.threadId, thread.id));
  }

  if (options?.postChannelId) {
    await postSummaryToChannel(options.postChannelId, rollupItems);
  } else {
    await postSummaryToGeneral(rollupItems);
  }
}

async function fetchMessagesSince(thread: ThreadChannel, sinceTs: number) {
  const collected: Message[] = [];
  let before: string | undefined = undefined;
  const maxPages = 10; // up to ~1000 messages guardrail
  for (let i = 0; i < maxPages; i++) {
    const batch = await thread.messages.fetch(before ? { before, limit: 100 } : { limit: 100 });
    if (batch.size === 0) break;
    const arr: Message[] = Array.from(batch.values());
    // messages are newest first; stop when older than sinceTs
    for (const m of arr) {
      if (m.createdTimestamp >= sinceTs) collected.push(m);
    }
    const oldest: Message | undefined = arr[arr.length - 1];
    if (!oldest) break;
    if (oldest.createdTimestamp < sinceTs) break;
    before = oldest.id;
  }
  // Sort ascending
  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return collected;
}

