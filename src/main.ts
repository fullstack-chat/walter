import * as dotenv from "dotenv";
dotenv.config();

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node"

Sentry.init({
  dsn: "https://e61d0f42684fb253f4583324606fccaa@o4507352039424000.ingest.us.sentry.io/4507352043225088",
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

import { ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, Interaction } from "discord.js";
import { isSenderPatron, sendModBroadcast } from "./security";
import { logger as log } from "./logger";

// Commands
import { xp } from "./slash/xp"
import { help } from "./slash/help"
import { joke } from "./slash/dadjoke"
import { leaderboard } from "./slash/leaderboard"
import { img } from "./slash/img"
import { deepsight } from "./slash/deepsight"
import dailyDiscussionCmd from "./slash/discussionQuestion";
import { rollup } from "./slash/rollup";

import XpManager from "./managers/xp_manager";
import { RegisteredNames, registerService } from "./container";
import SlashCommandManager from "./managers/slash_manager";
import { mentionRole } from "./helpers";
import { Roles } from "./data/roles";
import { isAiDisabled } from "./config";
import ScheduledJobManager from "./managers/scheduled_job_manager";
import { helloWorldJob } from "./jobs/hello_world";
import { projectRollupJob } from "./jobs/project_rollup";

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],
});

registerService(client, RegisteredNames.DiscordClient)
registerService(log, "logger")

const slashCommandManager = new SlashCommandManager(log);
registerService(slashCommandManager)

const scheduledJobManager = new ScheduledJobManager();
registerService(scheduledJobManager)

let xpManager: XpManager;

client.on(Events.ClientReady, async () => {
  try {
    if (process.env.IS_XP_ENABLED) {
      xpManager = new XpManager(log);
      await xpManager.init();
      registerService(xpManager);
    }

    // Register slash commands
    slashCommandManager.addCommand(xp)
    slashCommandManager.addCommand(help);
    slashCommandManager.addCommand(joke);
    slashCommandManager.addCommand(leaderboard);
    slashCommandManager.addCommand(dailyDiscussionCmd);
    slashCommandManager.addCommand(img);
    slashCommandManager.addCommand(deepsight);
    slashCommandManager.addCommand(rollup);
    slashCommandManager.registerCommands();

    scheduledJobManager.registerJob(helloWorldJob)
    scheduledJobManager.registerJob(projectRollupJob)

    log.info("=====")
    log.info("Registered slash commands:");
    Object.keys(slashCommandManager.commands).forEach(c => log.info(c));
    log.info("=====")
  } catch (err) {
    log.error("Init failed:", err);
  }

  log.info(`${client?.user?.username} is ready!`);
  Sentry.captureMessage(`${client?.user?.username} is ready!`);
});


// Log errors to Sentry
client.on(Events.Error, e => {
  log.info(`${client?.user?.username} borked: ${e}`);
  Sentry.captureException(e);
});

// Inform the mods that a new member joined the server!
client.on(Events.GuildMemberAdd, async member => {
  await sendModBroadcast(member.guild, `**${member.user.username}** just joined **${member.guild.name}**!`);
});

/** Slash Commands */
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  await slashCommandManager.handleCommand(interaction)
});

client.on(Events.ThreadCreate, async thread => {
  if(thread.parentId === process.env.PROJECT_FORUM_CHANNEL_ID) {
    // Send announcement to general channel
    const channelId = process.env.GENERAL_CHANNEL_ID as string;
    const channel = await client.channels.fetch(channelId)
    
    if (channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)) {
      // Create an embed similar to project_rollup.ts
      
      // Fetch the starter message to get its content
      let description = "A new project thread has been created!";
      try {
        const starterMessage = await thread.fetchStarterMessage();
        if (starterMessage && starterMessage.content) {
          description = starterMessage.content.length > 1500 
            ? starterMessage.content.slice(0, 1500) + "..."
            : starterMessage.content;
        }
      } catch (e) {
        log.error(`Failed to fetch starter message for thread ${thread.id}`, e);
      }
      
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`New Project: ${thread.name || 'Untitled Project'}`)
        .setDescription(description)
        .addFields(
          { name: 'Project', value: `<#${thread.id}>`, inline: true },
          { name: 'Creator', value: `<@${thread.ownerId}>`, inline: true }
        )
        .setTimestamp(new Date());
      
      await channel.send({ embeds: [embed] });
    }
    
    // Send welcome message in the thread itself
    try {
      const welcomeMessage = `👋 **Welcome to Your Project Thread, <@${thread.ownerId}>!** 🎉

Thanks for logging your project! This thread will help you track progress and share updates with the community.

**Daily Updates**
We encourage you to post updates here daily. Each morning (8:00 AM CT), a summary of your updates will be posted to the general channel.

**Opt-Out of Daily Summaries**
If you prefer not to have your updates included in the daily rollup, react to this thread's starter message with the :no_mobile_phones: (🚫📱) emoji.

**Best Practices**
Share your progress, blockers, and wins! The more you share, the more the community can help and celebrate with you.`;
      
      await thread.send(welcomeMessage);
    } catch (e) {
      log.error(`Failed to send welcome message to thread ${thread.id}`, e);
    }
  }
})

// Standard messages
client.on(Events.MessageCreate, async message => {
  log.info(`Message from ${message.author.username}: ${message.content}`);
  if (message.author.bot) {
    return;
  }

  if (xpManager) {
    xpManager.logXp(message, message.author.id, message.author.username);
  }

  const tag = `<@${client.user!.id}>`

  // Someone has mentioned the bot
  if(message.mentions.has(client.user!.id) &&
    (message.content.startsWith(tag) || message.content.endsWith(tag))) {
    if(isAiDisabled) {
      await message.reply("Sorry, I can't do that for you. The AI is disabled right now.");
      return;
    }
    // Check if the user has the Patron role, DM them if not
    if(!isSenderPatron(message)) {
      await message.author.send("Sorry, I can't do that for you. Become a patron to unlock this feature!");
      await message.delete()
    } else {
      // Remove the mention from the message
      let msg = message.content.replace(tag, "").trim();
      // Show a typing indicator
      await message.channel.sendTyping();
      // Send the message to the Ollama API
      let res = await fetch(`${process.env.OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: msg,
          model: "llama3",
          stream: false
        })
      })
      let data = await res.json();
      const response = data.response.trim();
      if(response.length > 1500) {
        let destination = message.channel;
        // Create a thread ONLY if were not in one already
        if(message.channel.type === ChannelType.GuildText) {
          let threadname = `"${msg.length > 50 ? msg : `${msg.slice(0, 70)}...`}" by @${message.author.username}`
          destination = await message.startThread({
            name: threadname,
            autoArchiveDuration: 1440
          })
        }
        let spl = response.split("\n");
        let isWritingCodeBlock = false
        let agg = ""
        for(const chunk of spl) {
          await destination.sendTyping();
          if(chunk !== "") {
            if(chunk.startsWith("```")) {
              isWritingCodeBlock = !isWritingCodeBlock
            }
            agg += `${chunk}\n`
            if(!isWritingCodeBlock)  {
              await destination.send(agg)
              agg = ""
            }
          }
        }
      } else {
        // Send the response to the user
        await message.reply(data.response.trim());
      }
    }
  }
});

client.login(process.env.BOT_TOKEN);