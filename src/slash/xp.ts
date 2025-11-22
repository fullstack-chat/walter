import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getInstance } from "../container";
import XpManager from "../managers/xp_manager";
import SlashCommand from "../models/slash_command";

const helpText = `
  Command: xp
  Description: The 'xp' command can be used to fetch the user's current XP.
  Subcommands: none
  Examples:
    - Input: /xp
      Output: @brianmmdev Level: 15 XP: 1445, Level up progress: 19%
`

export const xp: SlashCommand = {
  name: "xp",
  helpText,
  builder: new SlashCommandBuilder()
    .setName("xp")
    .setDescription("Returns your current XP and level"),
  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply();

    const xpManager: XpManager = getInstance(XpManager.name)
    let currentXp = xpManager.getXpForUserId(interaction.user.id)

    if (currentXp) {
      let currentLevel: number = xpManager.getLevelForUserId(interaction.user.id)
      let progressPercentage: number = xpManager.getLevelUpProgressPercentage(currentXp)

      let embed = new EmbedBuilder()
        .setTitle(interaction.user.displayName)
        .addFields(
          {
            name: "Level",
            value: currentLevel.toString(),
            inline: true
          },
          {
            name: "XP",
            value: new Intl.NumberFormat("en-US").format(currentXp),
            inline: true
          },
        )
        .setImage(
          `https://progressbar.maciejpedzi.ch/${progressPercentage.toFixed()}.png/`
        )
        .setTimestamp()

      return interaction.editReply({ embeds: [embed] })
    } else {
      return interaction.editReply("I cant find you :(")
    }
  },
};
