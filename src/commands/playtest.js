'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');
const { getConnection } = require('../voice/manager');
const { isPlaying, playFile } = require('../voice/player');

// Deliberately NOT /play — that will take a song name and search external
// sources in a later phase. This only proves local file → voice works.
const TEST_AUDIO_PATH = path.join(__dirname, '..', '..', 'assets', 'test-audio.mp3');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playtest')
    .setDescription('Play a short local test sound in your voice channel'),

  async execute(interaction) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    // Case 1 — user is not in a voice channel.
    const channel = interaction.member?.voice?.channel;
    if (!channel) {
      await interaction.reply({ content: '❌ Join a voice channel first.', ephemeral: true });
      return;
    }

    // Case 2 — bot is not connected. Do NOT auto-join; tell them to /join.
    const connection = getConnection(interaction.guildId);
    if (!connection) {
      await interaction.reply({ content: '❌ I\'m not in a voice channel yet. Use /join first.', ephemeral: true });
      return;
    }

    // Case 3 — already playing: don't stack a second player/resource.
    if (isPlaying(interaction.guildId)) {
      await interaction.reply('▶️ Audio is already playing.');
      return;
    }

    if (!fs.existsSync(TEST_AUDIO_PATH)) {
      await interaction.reply({
        content: '❌ Test audio file is missing. Place a short MP3 at assets/test-audio.mp3.',
        ephemeral: true,
      });
      return;
    }

    try {
      playFile(connection, interaction.guildId, TEST_AUDIO_PATH);
      await interaction.reply('▶️ Playing test audio.');
    } catch (err) {
      console.error(`[Churan] /playtest failed for guild ${interaction.guildId}:`, err.message || err);
      const reply = { content: '❌ Could not play test audio.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};
