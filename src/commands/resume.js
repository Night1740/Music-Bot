'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { getPlayer } = require('../voice/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const player = getPlayer(interaction.guildId);
    const status = player?.state?.status;
    if (!player || status !== AudioPlayerStatus.Paused) {
      await interaction.reply('❌ Nothing is paused right now.');
      return;
    }
    if (player.unpause()) {
      await interaction.reply('▶️ Resumed.');
    } else {
      await interaction.reply('❌ Could not resume right now.');
    }
  },
};
