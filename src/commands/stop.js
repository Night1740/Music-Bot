'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { stopEverything } = require('../music/playback');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    // Fully synchronous: no defer needed. stopEverything suppresses the
    // resulting Idle so no queued song starts afterwards.
    stopEverything(interaction.guildId);
    await interaction.reply('⏹️ Stopped playback and cleared the queue.');
  },
};
