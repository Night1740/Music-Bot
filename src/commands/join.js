'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { joinChannel } = require('../voice/manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Make Churan join your voice channel'),

  async execute(interaction) {
    const channel = interaction.member?.voice?.channel;

    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    if (!channel) {
      await interaction.reply({ content: '❌ You need to be in a voice channel first.', ephemeral: true });
      return;
    }

    try {
      joinChannel({
        guildId: interaction.guildId,
        channelId: channel.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });
      await interaction.reply('🔊 Joined your voice channel.');
    } catch (err) {
      console.error(`[Churan] /join failed for guild ${interaction.guildId}:`, err.message || err);
      const reply = { content: '❌ Could not join your voice channel.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};
