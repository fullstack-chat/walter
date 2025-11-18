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

    const xpManager = getInstance(XpManager.name)
    let currentXp = xpManager.getXpForUserId(interaction.user.id)

    if (currentXp) {
      const NUM_PROGRESS_BAR_SEGMENTS = 10
      let currentLevel = xpManager.getLevelForUserId(interaction.user.id)
      let progressPercentage: number = xpManager
        .getLevelUpProgressPercentage(currentXp)

      let numGreenSegments = Math.floor(
        progressPercentage / NUM_PROGRESS_BAR_SEGMENTS
      )
      let progressBar = "🟩"
        .repeat(numGreenSegments)
        .padEnd(NUM_PROGRESS_BAR_SEGMENTS, "⬛")

      let embed = new EmbedBuilder()
        .setTitle(interaction.user.displayName)
        .setDescription(
          `**Level**: ${currentLevel}\n**XP**: ${currentXp}\nLevel up progress:${progressPercentage.toFixed()}%\n\n${progressBar}`
        )
        .setTimestamp()

      return interaction.editReply({ embeds: [embed] })
    } else {
      return interaction.editReply("I cant find you :(")
    }
  },
};
