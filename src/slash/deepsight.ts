import { AttachmentBuilder, ChatInputCommandInteraction, ForumChannel, SlashCommandBuilder } from "discord.js";
import SlashCommand, { SlashCommandOptionType } from "../models/slash_command";

const helpText = `
TODO:
`

export const deepsight: SlashCommand = {
  name: "deepsight",
  helpText,
  builder: new SlashCommandBuilder()
    .setName("deepsight")
    .setDescription("Embrace the Darkness and tap into the memory of the universe."),
  options: [
    {
      type: SlashCommandOptionType.STRING,
      name: "prompt",
      description: "The prompt",
      required: true
    }
  ],
  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply()
    const opt = {
      prompt: ""
    }
    interaction.options.data.forEach(option => {
      if(option.name === "prompt") {
        opt.prompt = option.value as string
      }
    })

    const res = await fetch(`${process.env.DEEPSIGHT_URL}/question?q=${opt.prompt}`)
    const data = await res.json()

    await interaction.followUp({
      content: data.response
    })
  },
};
