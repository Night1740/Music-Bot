'use strict';

// /play "<song name | vibe>": exact song search OR Churan Vibe Mode.
// Phase 6 adds an intent/resolution layer on top of the existing YouTube
// search: vibe requests ("happy", "romantic hindi english", "something
// energetic for the gym") build a bounded mixed playlist; everything else
// keeps the exact-song path below byte-for-byte.

const { SlashCommandBuilder } = require('discord.js');
const { getConnection, joinChannel } = require('../voice/manager');
const { isPlaying } = require('../voice/player');
const { searchYouTube } = require('../youtube/search');
const { selectBestResult } = require('../youtube/select');
const { getState, bumpEpoch } = require('../music/queue');
const { playTrackNow, playNextInQueue } = require('../music/playback');
const { resolveIntent } = require('../vibe/intent');
const { buildVibePlaylist } = require('../vibe/engine');

function cap(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function vibeReply(intent, tracks) {
  const moodLabel = intent.mood
    ? intent.mood.charAt(0).toUpperCase() + intent.mood.slice(1)
    : 'Mixed';
  const langLabel =
    intent.languages.length === 1 && intent.languages[0] === 'mixed'
      ? 'Mixed'
      : intent.languages.join(' + ');
  const lines = [
    '🎭 Churan Vibe Mode',
    '',
    `Mood: ${moodLabel}`,
    `Languages: ${langLabel}`,
    `Queued: ${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
  ];
  // List titles without spamming: up to 12, truncated to fit Discord limits.
  const maxList = Math.min(tracks.length, 12);
  for (let i = 0; i < maxList; i += 1) {
    lines.push(`${i + 1}. ${cap(tracks[i].title, 80)}`);
  }
  let out = lines.join('\n');
  if (out.length > 1900) out = `${out.slice(0, 1899)}…`;
  return out;
}

  // Play-now attempt with stale protection. The search/extraction above
  // took seconds: another transition (skip, stop, auto-advance, another
  // /play) may have won meanwhile. On stale we NEVER cut off the winner —
  // re-decide once against live state, then queue. Bumping before the
  // safety kick makes this attempt the sole owner so it cannot double-
  // commit alongside an in-flight advance.
  async function startNowOrQueue(guildId, connection, track, fail, nowMsg) {
    bumpEpoch(guildId);
    const token = getState(guildId).epoch;
    let res;
    try {
      res = await playTrackNow(connection, guildId, track, token);
    } catch (err) {
      console.error(`[Churan] /play playback failed (guild ${guildId}):`, err.message || err);
      await fail('❌ Found the song but could not play it. Try again in a moment.');
      return;
    }
    if (res.status === 'played') {
      await fail(nowMsg(track));
      return;
    }
    if (!isPlaying(guildId)) {
      bumpEpoch(guildId);
      const token2 = getState(guildId).epoch;
      try {
        const res2 = await playTrackNow(connection, guildId, track, token2);
        if (res2.status === 'played') {
          await fail(nowMsg(track));
          return;
        }
      } catch (err) {
        console.error(`[Churan] /play playback failed (guild ${guildId}):`, err.message || err);
        await fail('❌ Found the song but could not play it. Try again in a moment.');
        return;
      }
    }
    const st = getState(guildId);
    st.queue.push(track);
    if (!isPlaying(guildId)) {
      bumpEpoch(guildId);
      const adv = await playNextInQueue(guildId, getState(guildId).epoch);
      if (adv.status === 'played' || adv.status === 'replayed') {
        await fail(nowMsg(adv.track));
        return;
      }
    }
    await fail(`➕ Added to queue (#${st.queue.length} in queue): ${track.title}`);
  }

  // Vibe variant: same stale discipline, but keeps playlist order (first
  // goes to the FRONT when it loses the race) and rolls back the queued
  // rest when extraction itself fails, so no orphaned tracks linger.
  async function startVibeOrQueue(guildId, connection, intent, tracks, fail) {
    const [first, ...rest] = tracks;
    bumpEpoch(guildId);
    const token = getState(guildId).epoch;
    const st = getState(guildId);
    st.queue.push(...rest);
    const rollbackRest = () => {
      const q = getState(guildId).queue;
      for (const t of rest) {
        const i = q.indexOf(t);
        if (i >= 0) q.splice(i, 1);
      }
    };
    let res;
    try {
      res = await playTrackNow(connection, guildId, first, token);
    } catch (err) {
      rollbackRest();
      console.error(`[Churan] /play vibe playback failed (guild ${guildId}):`, err.message || err);
      await fail('❌ Found the vibe but could not play it. Try again in a moment.');
      return;
    }
    const nowMsg = () => `${vibeReply(intent, tracks)}\n\n▶️ Now playing: ${first.title}`;
    if (res.status === 'played') {
      await fail(nowMsg());
      return;
    }
    if (!isPlaying(guildId)) {
      bumpEpoch(guildId);
      const token2 = getState(guildId).epoch;
      try {
        const res2 = await playTrackNow(connection, guildId, first, token2);
        if (res2.status === 'played') {
          await fail(nowMsg());
          return;
        }
      } catch (err) {
        rollbackRest();
        console.error(`[Churan] /play vibe playback failed (guild ${guildId}):`, err.message || err);
        await fail('❌ Found the vibe but could not play it. Try again in a moment.');
        return;
      }
    }
    const live = getState(guildId);
    live.queue.unshift(first); // front: preserve vibe order
    if (!isPlaying(guildId)) {
      bumpEpoch(guildId);
      const adv = await playNextInQueue(guildId, getState(guildId).epoch);
      if (adv.status === 'played' || adv.status === 'replayed') {
        await fail(nowMsg());
        return;
      }
    }
    await fail(vibeReply(intent, tracks));
  }

async function playExactSong(interaction, connection, query, fail) {
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
  // extracted when each track starts. The helper re-validates after the
  // slow extraction so a late finish can never cut off another track.
  if (!isPlaying(interaction.guildId)) {
    await startNowOrQueue(
      interaction.guildId,
      connection,
      track,
      fail,
      (t) => `▶️ Now playing: ${t.title}`,
    );
    return;
  }

  const st = getState(interaction.guildId);
  st.queue.push(track);
  await fail(`➕ Added to queue (#${st.queue.length} in queue): ${track.title}`);
}

async function playVibePlaylist(interaction, connection, query, intent, fail) {
  const requester = { id: interaction.user.id, username: interaction.user.username };
  let built;
  try {
    built = await buildVibePlaylist(intent, { requester });
  } catch (err) {
    console.error(`[Churan] /play vibe build failed (guild ${interaction.guildId}):`, err.message || err);
    await fail('❌ Vibe search failed. Try again in a moment.');
    return;
  }

  const tracks = built.tracks || [];
  if (tracks.length === 0) {
    await fail(`❌ No high-quality results for that vibe ("${query}"). Try a song name instead.`);
    return;
  }

  // Feed NORMAL track objects into the EXISTING queue/playback system
  // (same safe start path as exact songs).
  if (!isPlaying(interaction.guildId)) {
    await startVibeOrQueue(interaction.guildId, connection, intent, tracks, fail);
    return;
  }

  const st = getState(interaction.guildId);
  st.queue.push(...tracks);
  await fail(vibeReply(intent, tracks));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song — or a mood/vibe playlist (e.g. "romantic hindi")')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Song name or vibe (mood + language)').setRequired(true),
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

    // Vibe layer: deterministic local intent check. Exact songs fall
    // through to the untouched path; vibe requests build a playlist.
    let intent = null;
    try {
      intent = resolveIntent(query);
    } catch (err) {
      console.warn('[Churan] /play intent resolver failed, using exact path:', err.message || err);
      intent = { mode: 'song', originalQuery: query };
    }

    if (intent && intent.mode === 'playlist') {
      await playVibePlaylist(interaction, connection, query, intent, fail);
      return;
    }

    await playExactSong(interaction, connection, query, fail);
  },
};
