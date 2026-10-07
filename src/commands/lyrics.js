'use strict';

// /lyrics: Spotify-style synced lyrics for the currently playing track.
// Creates ONE message and edits it as playback progresses (only when the
// visible line window changes). Never touches audio playback.
//
// Position comes from the live AudioResource (opus packets consumed ×
// 20ms), so pause/resume are reflected automatically and no extra timers
// estimate the timeline.

const { SlashCommandBuilder } = require('discord.js');
const { getPlayer } = require('../voice/player');
const { getState } = require('../music/queue');
const { findSyncedLyrics } = require('../lyrics/provider');
const { parseLrc } = require('../lyrics/parser');
const { startSession, getSession } = require('../lyrics/sync');

function positionMsOf(guildId) {
  const resource = getPlayer(guildId)?.state?.resource;
  const dur = resource?.playbackDuration;
  return typeof dur === 'number' && dur >= 0 ? dur : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show synced lyrics for the currently playing song'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const guildId = interaction.guildId;
    const current = getState(guildId).current;
    if (!current) {
      await interaction.reply('🎤 Nothing is playing right now.');
      return;
    }

    // Fast idempotent path: same song generation already has a display.
    const epoch = getState(guildId).epoch;
    const trackKey = current.youtubeUrl;
    const dupe = getSession(guildId);
    if (dupe && !dupe.dead && dupe.trackKey === trackKey && dupe.epoch === epoch) {
      await interaction.reply({ content: '🎤 Lyrics are already showing for this song.', ephemeral: true });
      return;
    }

    // Provider lookup can take seconds — ack first, answer via edits.
    await interaction.deferReply();

    let candidate;
    try {
      candidate = await findSyncedLyrics(current);
    } catch (err) {
      console.error(`[Churan] /lyrics lookup failed (guild ${guildId}):`, err.message || err);
      await interaction.editReply('🎤 Couldn\'t load lyrics right now.').catch(() => {});
      return;
    }

    if (!candidate) {
      await interaction.editReply('🎤 No synced lyrics found for this song.').catch(() => {});
      return;
    }

    const lines = parseLrc(candidate.syncedLrc);
    if (lines.length === 0) {
      await interaction.editReply('🎤 No synced lyrics found for this song.').catch(() => {});
      return;
    }

    // The track may have changed while we were fetching: never attach a
    // session to the wrong song.
    const now = getState(guildId);
    if (now.epoch !== epoch || now.current?.youtubeUrl !== trackKey) {
      await interaction.editReply('🎤 Track changed while loading lyrics — run /lyrics again.').catch(() => {});
      return;
    }

    console.log(`[Churan] Synced lyrics: "${candidate.trackName}" by ${candidate.artistName} (${lines.length} lines, guild ${guildId}).`);
    const { created } = startSession({
      guildId,
      epoch,
      trackKey,
      title: current.title,
      channel: current.channel,
      lines,
      getPositionMs: () => positionMsOf(guildId),
      isValid: () => {
        const st = getState(guildId);
        return st.epoch === epoch && st.current?.youtubeUrl === trackKey;
      },
      editMessage: (text) => interaction.editReply(text),
    });
    if (!created) {
      await interaction.editReply('🎤 Lyrics are already showing for this song.').catch(() => {});
    }
    // Otherwise the session's immediate first tick turns this deferred
    // reply into the lyrics display.
  },
};
