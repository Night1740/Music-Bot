'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { leaveGuild } = require('../voice/manager');
const { isPlaying, stopGuild } = require('../voice/player');
const { suppressNextIdle, clearGuild } = require('../music/queue');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Make Churan leave the voice channel'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    try {
      // Stop any active playback first so destroying the connection
      // never leaves a live player behind. The suppress flag keeps the
      // resulting Idle from auto-advancing the queue (set only while
      // active, so exactly one Idle consumes it), then music state is
      // wiped so /nowplaying and /queue can't go stale.
      if (isPlaying(interaction.guildId)) suppressNextIdle(interaction.guildId);
      stopGuild(interaction.guildId);
      const left = leaveGuild(interaction.guildId);
      clearGuild(interaction.guildId);
      if (!left) {
        await interaction.reply('❌ I\'m not in a voice channel.');
        return;
      }
      await interaction.reply('🔇 Left the voice channel.');
    } catch (err) {
      console.error(`[Churan] /leave failed for guild ${interaction.guildId}:`, err.message || err);
      const reply = { content: '❌ Could not leave the voice channel.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};
