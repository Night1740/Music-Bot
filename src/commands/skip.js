'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { trackLabel } = require('../music/queue');
const { skipGuild } = require('../music/playback');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song and play the next queued one'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    // Advancing may extract the next song (slow) — defer first.
    await interaction.deferReply();
    const fail = (text) => interaction.editReply({ content: text });

    try {
      const res = await skipGuild(interaction.guildId);
      if (res.status === 'played') {
        await fail(`⏭️ Skipped. ▶️ Now playing: ${trackLabel(res.track)}`);
      } else if (res.status === 'empty') {
        await fail('⏭️ Skipped. The queue is empty.');
      } else if (res.status === 'no-connection') {
        await fail('⏭️ Skipped, but I am no longer connected to voice.');
      } else if (res.status === 'failed') {
        await fail('⏭️ Skipped, but the remaining queued tracks failed to play and were removed.');
      } else {
        await fail('⏭️ Skipped.');
      }
    } catch (err) {
      console.error(`[Churan] /skip failed (guild ${interaction.guildId}):`, err.message || err);
      await fail('❌ Could not skip right now.');
    }
  },
};
