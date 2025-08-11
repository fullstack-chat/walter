import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import SlashCommand from "../models/slash_command";
import { runProjectRollup } from "../jobs/project_rollup";

export const rollup: SlashCommand = {
  name: "rollup",
  builder: new SlashCommandBuilder()
    .setName("rollup")
    .setDescription("Generate and post a project rollup for the last 24 hours in this channel"),
  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000; // last 24 hours
    const postChannelId = interaction.channelId;

    try {
      await runProjectRollup({ cutoffMs, postChannelId, updateLastSeen: false });
      await interaction.editReply("Project rollup posted for the last 24 hours.");
    } catch (e) {
      await interaction.editReply("Failed to generate project rollup. Check logs.");
    }
  },
};
