'use strict';

// /play "<song name>": search YouTube → pick the best result → play now or
// enqueue. Phase 4C replaces the temporary /playyoutube command.

const { SlashCommandBuilder } = require('discord.js');
const { getConnection, joinChannel } = require('../voice/manager');
const { isPlaying } = require('../voice/player');
const { searchYouTube } = require('../youtube/search');
const { selectBestResult } = require('../youtube/select');
const { getState, bumpEpoch } = require('../music/queue');
const { playTrackNow } = require('../music/playback');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Search YouTube and play a song (or add it to the queue)')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Song name to search for').setRequired(true),
    ),

  async execute(interaction) {
    const rawQuery = interaction.options.getString('query', false);
    const query = (rawQuery || '').trim();
    if (!query) {
      await interaction.reply({ content: '❌ Give me a song name to search for.', ephemeral: true });
      return;
    }

    // Search/extraction can take many seconds — ack within Discord's 3s
    // window first; everything below answers via editReply.
    await interaction.deferReply();

    const fail = (text) => interaction.editReply({ content: text });

    if (!interaction.guildId || !interaction.guild) {
      await fail('❌ This command can only be used in a server.');
      return;
    }

    const memberChannel = interaction.member?.voice?.channel;
    if (!memberChannel) {
      await fail('❌ Join a voice channel first.');
      return;
    }

    // Auto-join the user's channel when not connected yet.
    let connection = getConnection(interaction.guildId);
    if (!connection) {
      try {
        connection = joinChannel({
          guildId: interaction.guildId,
          channelId: memberChannel.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });
        console.log(`[Churan] Auto-joined voice for /play (guild ${interaction.guildId}).`);
      } catch (err) {
        console.error(`[Churan] /play auto-join failed (guild ${interaction.guildId}):`, err.message || err);
        await fail('❌ Could not join your voice channel. Check my permissions.');
        return;
      }
    }

    let results;
    try {
      results = await searchYouTube(query, { limit: 8 });
    } catch (err) {
      console.error(`[Churan] /play search failed (guild ${interaction.guildId}):`, err.message || err);
      await fail('❌ YouTube search failed. Try again in a moment.');
      return;
    }

    if (!results || results.length === 0) {
      await fail(`❌ No YouTube results for "${query}".`);
      return;
    }

    const best = selectBestResult(results, query);
    if (!best) {
      await fail(`❌ No playable YouTube results for "${query}".`);
      return;
    }

    const track = {
      title: best.title || query,
      youtubeUrl: best.url,
      durationSeconds: best.durationSeconds,
      duration: best.duration,
      channel: best.channel,
      requester: { id: interaction.user.id, username: interaction.user.username },
    };

    // Play now only when the player is truly idle; otherwise queue. Queued
    // tracks store metadata (NOT extracted URLs) — a fresh live URL is
    // extracted when each track starts.
    if (!isPlaying(interaction.guildId)) {
      bumpEpoch(interaction.guildId);
      try {
        await playTrackNow(connection, interaction.guildId, track);
        await fail(`▶️ Now playing: ${track.title}`);
      } catch (err) {
        console.error(`[Churan] /play playback failed (guild ${interaction.guildId}):`, err.message || err);
        await fail('❌ Found the song but could not play it. Try again in a moment.');
      }
      return;
    }

    const st = getState(interaction.guildId);
    st.queue.push(track);
    await fail(`➕ Added to queue (#${st.queue.length} in queue): ${track.title}`);
  },
};
