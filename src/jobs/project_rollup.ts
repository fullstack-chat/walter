import { ChannelType, ForumChannel, ThreadChannel, Message, EmbedBuilder } from "discord.js";
import { getInstance } from "../container";
import ScheduledJob from "../models/scheduled_job";
import { db, dbSchema } from "../db/client";
import { eq } from "drizzle-orm";
import { logger as log } from "../logger";

type ThreadMemory = {
  summary?: string
  keyPoints?: string[]
  contributors?: string[]
  lastActiveAt?: string
}

async function getProjectForumChannel(): Promise<ForumChannel | null> {
  try {
    log.info("Getting project forum channel");
    const client = getInstance("DiscordClient");
    const forumId = process.env.PROJECT_FORUM_CHANNEL_ID || process.env.PROJECT_FORUM_ID;
    if (!forumId) {
      log.error("PROJECT_FORUM_CHANNEL_ID is not set");
      return null;
    }
    
    log.info(`Attempting to fetch channel with ID: ${forumId}`);
    const ch = await client.channels.fetch(forumId);
    
    if (!ch) {
      log.error(`Channel ${forumId} not found`);
      return null;
    }
    
    log.info(`Channel ${forumId} found with type: ${ch.type}`);
    if (ch && ch.type === ChannelType.GuildForum) {
      log.info(`Successfully found forum channel: ${ch.id}`);
      return ch as ForumChannel;
    }
    
    log.error(`Channel ${forumId} is not a forum channel. Found type: ${ch.type}`);
  } catch (e) {
    log.error("Failed to fetch forum channel", e);
  }
  return null;
}

async function fetchAllThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
  try {
    log.info(`Fetching threads for forum channel: ${forum.id}`);
    const threads: ThreadChannel[] = [];
    
    try {
      log.info('Fetching active threads...');
      const active = await forum.threads.fetchActive();
      log.info(`Found ${active.threads.size} active threads`);
      active.threads.forEach(t => threads.push(t));
    } catch (e) {
      log.error('Error fetching active threads:', e);
    }
    
    try {
      log.info('Fetching archived threads...');
      const archived = await forum.threads.fetchArchived({ fetchAll: true });
      log.info(`Found ${archived.threads.size} archived threads`);
      archived.threads.forEach(t => threads.push(t));
    } catch (e) {
      log.error('Error fetching archived threads:', e);
    }
    
    log.info(`Total threads found: ${threads.length}`);
    return threads;
  } catch (e) {
    log.error('Error in fetchAllThreads:', e);
    return [];
  }
}

async function getOrCreateThreadMemory(thread: ThreadChannel) {
  try {
    log.info(`Getting thread memory for thread: ${thread.id} (${thread.name})`);
    
    try {
      log.info(`Querying database for existing thread memory: ${thread.id}`);
      const existing = await db
        .select()
        .from(dbSchema.projectThreadMemory)
        .where(eq(dbSchema.projectThreadMemory.threadId, thread.id))
        .limit(1);
      
      if (existing[0]) {
        log.info(`Found existing thread memory for: ${thread.id}`);
        log.debug(`Thread memory data:`, existing[0]);
        return existing[0];
      }
      
      log.info(`No existing thread memory found for: ${thread.id}, creating new entry`);
    } catch (e) {
      log.error(`Error querying thread memory for: ${thread.id}`, e);
      throw e; // Re-throw to be caught by outer try-catch
    }
    
    try {
      log.info(`Inserting new thread memory for: ${thread.id}`);
      const inserted = await db
        .insert(dbSchema.projectThreadMemory)
        .values({
          threadId: thread.id,
          threadName: thread.name ?? "Untitled",
        })
        .returning();
      
      if (inserted[0]) {
        log.info(`Successfully created thread memory for: ${thread.id}`);
        log.debug(`New thread memory data:`, inserted[0]);
        return inserted[0];
      } else {
        throw new Error(`Failed to create thread memory for: ${thread.id}`);
      }
    } catch (e) {
      log.error(`Error creating thread memory for: ${thread.id}`, e);
      throw e; // Re-throw to be caught by outer try-catch
    }
  } catch (e) {
    log.error(`Critical error in getOrCreateThreadMemory for thread: ${thread.id}`, e);
    // Return a minimal object to prevent further errors
    return {
      threadId: thread.id,
      threadName: thread.name ?? "Untitled",
      lastSeenMessageId: null,
      memory: null,
      lastSummaryAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
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
- Avoid pleasantries and meta-chatter.
- Assume that there's only a single contributor to the project. Unless clearly stated that a team
  is involved, avoid references to "the team" in the summary.`;
}

async function summarizeWithOpenAI(prompt: string): Promise<string | null> {
  try {
    log.info('Summarizing with OpenAI');
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      log.error("OPENAI_API_KEY not set; skipping AI summary");
      return null;
    }
    
    try {
      log.info('Sending request to OpenAI API');
      const startTime = Date.now();
      
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
      
      const responseTime = Date.now() - startTime;
      log.info(`OpenAI API response received in ${responseTime}ms`);
      
      if (!res.ok) {
        log.error(`OpenAI API returned status ${res.status}: ${res.statusText}`);
        const errorText = await res.text();
        log.error(`Error response: ${errorText}`);
        return null;
      }
      
      const data = await res.json();
      
      if (!data.choices || !data.choices.length) {
        log.error('OpenAI response missing choices', data);
        return null;
      }
      
      const summary = data.choices[0]?.message?.content?.trim();
      if (summary) {
        log.info(`Successfully generated summary (${summary.length} chars)`);
        log.debug('Summary content:', summary);
        return summary;
      } else {
        log.error('OpenAI response missing content in message', data.choices[0]);
        return null;
      }
    } catch (e) {
      log.error("OpenAI API request failed", e);
      return null;
    }
  } catch (e) {
    log.error("Critical error in summarizeWithOpenAI", e);
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
  try {
    log.info(`Posting summary to general channel, ${items.length} items`);
    if (items.length === 0) {
      log.info('No items to post, skipping');
      return;
    }
    
    const client = getInstance("DiscordClient");
    const channelId = process.env.GENERAL_CHANNEL_ID as string;
    
    if (!channelId) {
      log.error("GENERAL_CHANNEL_ID is not set");
      return;
    }
    log.info(`Fetching general channel: ${channelId}`);
    
    try {
      const channel = await client.channels.fetch(channelId);
      
      if (!channel) {
        log.error(`Channel ${channelId} not found`);
        return;
      }
      
      log.info(`Channel ${channelId} found with type: ${channel.type}`);
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        log.error(`General channel ${channelId} is not a text or announcement channel, found type: ${channel.type}`);
        return;
      }
      
      log.info('Building embeds for rollup items');
      const embeds = items.map(i => buildProjectEmbed(i));
      log.info(`Created ${embeds.length} embeds`);
      
      // Discord has a limit of 10 embeds per message
      for (let i = 0; i < embeds.length; i += 10) {
        const batch = embeds.slice(i, i + 10);
        log.info(`Sending batch ${Math.floor(i/10) + 1}/${Math.ceil(embeds.length/10)} with ${batch.length} embeds`);
        try {
          // @ts-ignore
          await channel.send({ embeds: batch });
          log.info(`Successfully sent batch ${Math.floor(i/10) + 1}`);
        } catch (e) {
          log.error(`Failed to send embed batch ${Math.floor(i/10) + 1}`, e);
        }
      }
      
      log.info('Successfully posted all rollup items to general channel');
    } catch (e) {
      log.error(`Failed to fetch channel ${channelId}`, e);
    }
  } catch (e) {
    log.error('Critical error in postSummaryToGeneral', e);
  }
}

async function postSummaryToChannel(channelId: string, items: RollupItem[]) {
  try {
    log.info(`Posting summary to channel ${channelId}, ${items.length} items`);
    if (items.length === 0) {
      log.info('No items to post, skipping');
      return;
    }
    
    const client = getInstance("DiscordClient");
    
    try {
      log.info(`Fetching channel: ${channelId}`);
      const channel = await client.channels.fetch(channelId);
      
      if (!channel) {
        log.error(`Channel ${channelId} not found`);
        return;
      }
      
      log.info(`Channel ${channelId} found with type: ${channel.type}`);
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        log.error(`Channel ${channelId} is not a text or announcement channel, found type: ${channel.type}`);
        return;
      }
      
      log.info('Building embeds for rollup items');
      const embeds = items.map(i => buildProjectEmbed(i));
      log.info(`Created ${embeds.length} embeds`);
      
      // Discord has a limit of 10 embeds per message
      for (let i = 0; i < embeds.length; i += 10) {
        const batch = embeds.slice(i, i + 10);
        log.info(`Sending batch ${Math.floor(i/10) + 1}/${Math.ceil(embeds.length/10)} with ${batch.length} embeds`);
        try {
          // @ts-ignore
          await channel.send({ embeds: batch });
          log.info(`Successfully sent batch ${Math.floor(i/10) + 1}`);
        } catch (e) {
          log.error(`Failed to send embed batch ${Math.floor(i/10) + 1}`, e);
        }
      }
      
      log.info(`Successfully posted all rollup items to channel ${channelId}`);
    } catch (e) {
      log.error(`Failed to fetch channel ${channelId}`, e);
    }
  } catch (e) {
    log.error(`Critical error in postSummaryToChannel for channel ${channelId}`, e);
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
  try {
    log.info("Starting project rollup job", { options });
    
    const forum = await getProjectForumChannel();
    if (!forum) {
      log.error("Could not find project forum channel, aborting rollup");
      return;
    }
    log.info(`Found forum channel: ${forum.id} (${forum.name})`);

    const threads = await fetchAllThreads(forum);
    log.info(`Processing ${threads.length} threads`);
    
    const rollupItems: RollupItem[] = [];

    const now = Date.now();
    const cutoffTs = options?.cutoffMs;
    const updateLastSeen = options?.updateLastSeen ?? (cutoffTs ? false : true);
    log.info(`Rollup configuration: cutoffTs=${cutoffTs}, updateLastSeen=${updateLastSeen}`);

    for (const thread of threads) {
      try {
        log.info(`Processing thread: ${thread.id} (${thread.name})`);
        
        if (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread && thread.type !== ChannelType.AnnouncementThread) {
          log.info(`Skipping thread ${thread.id} due to unsupported type: ${thread.type}`);
          continue;
        }
        
        // Check if thread creator has reacted with :no_mobile_phones: to the starter message
        try {
          log.info(`Checking for no_mobile_phones reaction in thread: ${thread.id}`);
          const starterMessage = await thread.fetchStarterMessage();
          
          if (!starterMessage) {
            log.warn(`Could not fetch starter message for thread: ${thread.id}`);
          } else {
            log.info(`Found starter message: ${starterMessage.id} for thread: ${thread.id}`);
            log.debug(`Reactions on starter message:`, Array.from(starterMessage.reactions.cache.values()).map(r => r.emoji.name));
            
            const noMobileReaction = starterMessage.reactions.cache.find(
              reaction => reaction.emoji.name === '🚫📱' || reaction.emoji.name === 'no_mobile_phones'
            );
            
            if (noMobileReaction) {
              log.info(`Found no_mobile_phones reaction on thread: ${thread.id}`);
              const reactors = await noMobileReaction.users.fetch();
              log.info(`Reactors for no_mobile_phones: ${Array.from(reactors.keys()).join(', ')}`);
              log.info(`Thread owner ID: ${thread.ownerId}`);
              
              if (reactors.has(thread.ownerId || '')) {
                // Thread creator has opted out with the no_mobile_phones reaction
                log.info(`Skipping thread ${thread.id} due to no_mobile_phones reaction from creator`);
                continue;
              }
            } else {
              log.info(`No 'no_mobile_phones' reaction found on thread: ${thread.id}`);
            }
          }
        } catch (e) {
          log.error(`Failed to check reactions for thread ${thread.id}`, e);
        }

        log.info(`Getting thread memory for: ${thread.id}`);
        const memoryRow = await getOrCreateThreadMemory(thread);
        log.info(`Last seen message ID for thread ${thread.id}: ${memoryRow.lastSeenMessageId || 'none'}`);
        
        let msgs;
        if (cutoffTs) {
          log.info(`Fetching messages since timestamp ${cutoffTs} for thread: ${thread.id}`);
          msgs = await fetchMessagesSince(thread, cutoffTs);
        } else {
          const lastSeenId = memoryRow.lastSeenMessageId ?? undefined;
          log.info(`Fetching messages after ID ${lastSeenId || 'none'} for thread: ${thread.id}`);
          msgs = await fetchNewMessages(thread, lastSeenId);
        }
        
        log.info(`Found ${msgs.length} messages for thread: ${thread.id}`);
        if (msgs.length === 0) {
          log.info(`No new messages for thread: ${thread.id}, skipping`);
          continue;
        }

        log.info(`Filtering and preparing messages for thread: ${thread.id}`);
        const prepared = msgs
          .filter(m => !m.author.bot && m.content && m.content.trim() !== "")
          .map(m => ({ author: m.author.username, content: m.content.slice(0, 1500) }));
          
        log.info(`${prepared.length} messages after filtering for thread: ${thread.id}`);
        if (prepared.length === 0) {
          log.info(`No valid messages for thread: ${thread.id} after filtering, skipping`);
          continue;
        }

        const prior: ThreadMemory | null = (memoryRow.memory as any) ?? null;
        log.info(`Building prompt for thread: ${thread.id}`);
        log.debug(`Prior memory:`, prior);
        
        const prompt = buildPrompt(thread.name ?? "Untitled", prior, prepared);
        log.info(`Summarizing with OpenAI for thread: ${thread.id}`);
        const summary = await summarizeWithOpenAI(prompt);
        
        if (!summary) {
          log.warn(`Failed to get summary for thread: ${thread.id}, skipping`);
          continue;
        }
        log.info(`Got summary for thread: ${thread.id}`);
        log.debug(`Summary: ${summary}`);

        const guildId = thread.guild?.id ?? "";
        const parentId = thread.parentId ?? thread.id;
        const authorMention = thread.ownerId ? `<@${thread.ownerId}>` : undefined;
        
        log.info(`Processing participants for thread: ${thread.id}`);
        const nonBotMsgs = msgs.filter(m => !m.author.bot && m.content && m.content.trim() !== "");
        const participantMentions = Array.from(new Set(nonBotMsgs.map(m => m.author.id))).map(id => `<@${id}>`);
        log.info(`Participants: ${participantMentions.join(', ')}`);
        
        const userMap: Record<string, string> = {};
        for (const m of nonBotMsgs) {
          if (m.author?.username && m.author?.id) {
            userMap[m.author.username.toLowerCase()] = m.author.id;
          }
        }
        
        log.info(`Creating rollup item for thread: ${thread.id}`);
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
        try {
          const newestId = msgs[msgs.length - 1].id;
          log.info(`Updating thread memory for: ${thread.id}, newest message ID: ${newestId}`);
          
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
            
          log.info(`Successfully updated thread memory for: ${thread.id}`);
        } catch (e) {
          log.error(`Failed to update thread memory for: ${thread.id}`, e);
        }
      } catch (e) {
        log.error(`Error processing thread: ${thread.id}`, e);
        // Continue with next thread
      }
    }

    log.info(`Rollup complete, ${rollupItems.length} items to post`);
    try {
      if (options?.postChannelId) {
        log.info(`Posting rollup to specified channel: ${options.postChannelId}`);
        await postSummaryToChannel(options.postChannelId, rollupItems);
      } else {
        log.info(`Posting rollup to general channel`);
        await postSummaryToGeneral(rollupItems);
      }
      log.info(`Successfully posted rollup summary`);
    } catch (e) {
      log.error(`Failed to post rollup summary`, e);
    }
  } catch (e) {
    log.error(`Critical error in runProjectRollup`, e);
  }
}

async function fetchMessagesSince(thread: ThreadChannel, sinceTs: number) {
  try {
    log.info(`Fetching messages since timestamp ${sinceTs} for thread: ${thread.id}`);
    const collected: Message[] = [];
    let before: string | undefined = undefined;
    const maxPages = 10; // up to ~1000 messages guardrail
    
    for (let i = 0; i < maxPages; i++) {
      try {
        log.info(`Fetching batch ${i+1}/${maxPages} for thread: ${thread.id}${before ? `, before message: ${before}` : ''}`);
        const batch = await thread.messages.fetch(before ? { before, limit: 100 } : { limit: 100 });
        
        if (batch.size === 0) {
          log.info(`No more messages in batch for thread: ${thread.id}`);
          break;
        }
        
        log.info(`Fetched ${batch.size} messages in batch ${i+1} for thread: ${thread.id}`);
        const arr: Message[] = Array.from(batch.values());
        
        // messages are newest first; stop when older than sinceTs
        let matchingMessages = 0;
        for (const m of arr) {
          if (m.createdTimestamp >= sinceTs) {
            collected.push(m);
            matchingMessages++;
          }
        }
        log.info(`Found ${matchingMessages} messages after timestamp ${sinceTs} in batch ${i+1}`);
        
        const oldest: Message | undefined = arr[arr.length - 1];
        if (!oldest) {
          log.info(`No oldest message found in batch ${i+1}, stopping`);
          break;
        }
        
        log.info(`Oldest message in batch ${i+1} has timestamp: ${oldest.createdTimestamp}`);
        if (oldest.createdTimestamp < sinceTs) {
          log.info(`Reached messages older than cutoff timestamp ${sinceTs}, stopping`);
          break;
        }
        
        before = oldest.id;
        log.info(`Will fetch next batch before message: ${before}`);
      } catch (e) {
        log.error(`Error fetching batch ${i+1} for thread: ${thread.id}`, e);
        break; // Stop on error
      }
    }
    
    // Sort ascending
    collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    log.info(`Total messages collected for thread ${thread.id}: ${collected.length}`);
    return collected;
  } catch (e) {
    log.error(`Critical error in fetchMessagesSince for thread: ${thread.id}`, e);
    return [];
  }
}

