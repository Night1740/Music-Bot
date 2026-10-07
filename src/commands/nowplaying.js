'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { getPlayer } = require('../voice/player');
const { getState, formatDuration } = require('../music/queue');

function describe(track, paused) {
  const icon = paused ? '⏸️ Paused' : '🎶 Now playing';
  const parts = [`${icon}: ${track.title}`];
  const details = [
    track.channel,
    formatDuration(track),
    track.requester?.username ? `requested by ${track.requester.username}` : '',
  ].filter(Boolean);
  if (details.length > 0) parts.push(details.join(' • '));
  return parts.join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing song'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const track = getState(interaction.guildId).current;
    if (!track) {
      await interaction.reply('❌ Nothing is playing right now.');
      return;
    }
    const paused = getPlayer(interaction.guildId)?.state?.status === AudioPlayerStatus.Paused;
    await interaction.reply(describe(track, paused));
  },
};
