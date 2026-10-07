'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { getPlayer } = require('../voice/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const player = getPlayer(interaction.guildId);
    const status = player?.state?.status;
    if (!player || status === AudioPlayerStatus.Idle) {
      await interaction.reply('❌ Nothing is playing right now.');
      return;
    }
    if (status === AudioPlayerStatus.Paused) {
      await interaction.reply('⏸️ Already paused. Use /resume to continue.');
      return;
    }
    if (player.pause()) {
      await interaction.reply('⏸️ Paused. Use /resume to continue.');
    } else {
      await interaction.reply('❌ Could not pause right now.');
    }
  },
};
