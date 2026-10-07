'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getState, trackLabel } = require('../music/queue');

const MAX_SHOWN = 10;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current song queue'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const st = getState(interaction.guildId);
    if (!st.current && st.queue.length === 0) {
      await interaction.reply('📭 The queue is empty. Use /play to add a song.');
      return;
    }

    const lines = [];
    if (st.current) lines.push(`🎶 Now: ${trackLabel(st.current)}`);
    if (st.queue.length > 0) {
      lines.push(`📜 Queue (${st.queue.length}):`);
      st.queue.slice(0, MAX_SHOWN).forEach((t, i) => {
        const req = t.requester?.username ? ` (req. by ${t.requester.username})` : '';
        lines.push(`${i + 1}. ${trackLabel(t)}${req}`);
      });
      if (st.queue.length > MAX_SHOWN) {
        lines.push(`…and ${st.queue.length - MAX_SHOWN} more.`);
      }
    }
    await interaction.reply(lines.join('\n').slice(0, 1900));
  },
};
