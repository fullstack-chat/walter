import { AttachmentBuilder, ChatInputCommandInteraction, ForumChannel, SlashCommandBuilder } from "discord.js";
import SlashCommand, { SlashCommandOptionType } from "../models/slash_command";
import { isAiDisabled } from "../config";

const helpText = `
TODO:
`

export const img: SlashCommand = {
  name: "img",
  helpText,
  builder: new SlashCommandBuilder()
    .setName("img")
    .setDescription("Generates an image using AI"),
  options: [
    {
      type: SlashCommandOptionType.STRING,
      name: "prompt",
      description: "The prompt",
      required: true
    },
    {
      type: SlashCommandOptionType.INTEGER,
      name: "height",
      description: "The image height",
      required: false
    },
    {
      type: SlashCommandOptionType.INTEGER,
      name: "width",
      description: "The image width",
      required: false
    },
    {
      type: SlashCommandOptionType.BOOLEAN,
      name: "debug",
      description: "Include technical details in the image",
      required: false
    }
  ],
  execute: async (interaction: ChatInputCommandInteraction) => {
    if(isAiDisabled) {
      await interaction.reply("Sorry, I can't do that for you. The AI is disabled right now.");
      return;
    }
    await interaction.deferReply()
    let includeTechnicalDetails = false
    const body = {
      prompt: "",
      sendImages: true,
      saveImages: true,
      height: 512,
      width: 512
    }
    interaction.options.data.forEach(option => {
      if(option.name === "prompt") {
        body.prompt = option.value as string
      }
      if(option.name === "height") {
        body.height = option.value as number
      }
      if(option.name === "width") {
        body.width = option.value as number
      }
      if(option.name === "debug") {
        includeTechnicalDetails = option.value as boolean
      }
    })
    await interaction.followUp({
      content: `Generating image for \`${body.prompt}\` ...`
    })

    console.log(`[img] "${body.prompt}" requested by ${interaction.user.tag}`)
    const res = await fetch(`${process.env.STABLE_DIFFUSION_URL}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body)
    })
    console.log(`[img] "${body.prompt}" requested by ${interaction.user.tag} DONE!`)
    let data = await res.json()
    const buffer = Buffer.from(data.images[0], "base64")
    const attachment = new AttachmentBuilder(buffer)
    let threadName = body.prompt
    if(threadName.length > 30) {
      threadName = `${threadName.substring(0, 30)}...`
    }
    delete data.images

    const forumChannel = interaction.guild?.channels.cache.find(channel => channel.id === process.env.IMG_GEN_CHANNEL_ID) as ForumChannel

    const thread = await forumChannel.threads.create({
      name: `🌅 ${threadName}`,
      message: {
        content: `Here is the image for \`${body.prompt}\` requested by <@${interaction.user.id}>:`,
        files: [attachment]
      },
      autoArchiveDuration: 1440
    })
    if(includeTechnicalDetails) {
      await thread.send(`Parameters:\n\`\`\`json\n${JSON.stringify(data.parameters, null, 2)}\n\`\`\``)
      let info = JSON.parse(data.info)
      await thread.send(`Info:\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\``)
    }
  },
};
