'use strict';

// Playback orchestrator for Phase 4C. Sits between Discord commands and
// voice/player.js: commands decide WHAT should happen, this module makes
// the player do it and advances the queue when tracks finish.
//
// Key correctness mechanisms:
//   - ONE Idle listener per AudioPlayer (WeakSet-guarded). The listener
//     calls handleIdle(), which auto-plays the next queued track.
//   - Natural finish vs manual stop/skip is distinguished with the
//     suppressIdle flag in music/queue.js: skip/stop/leave set it BEFORE
//     stopping an ACTIVE player, so exactly one Idle consumes it. The flag
//     is never set when idle, so it can never go stale.
//   - Every state mutation bumps queue epoch; async continuations
//     (extraction → play) abort when it changed, so a /stop during a slow
//     extraction can't be followed by a stale song starting.

const { AudioPlayerStatus } = require('@discordjs/voice');
const { getConnection } = require('../voice/manager');
const { getPlayer, isPlaying, playUrl, stopGuild } = require('../voice/player');
const { getAudioUrl } = require('../youtube/media');
const {
  getState,
  bumpEpoch,
  suppressNextIdle,
  consumeSuppressIdle,
} = require('./queue');

const wiredPlayers = new WeakSet();

async function handleIdle(guildId) {
  if (consumeSuppressIdle(guildId)) return { status: 'suppressed' };
  const st = getState(guildId);
  const token = st.epoch;
  if (!st.current && st.queue.length === 0) return { status: 'stray' };
  st.current = null; // finished track leaves, whatever comes next is new
  return playNextInQueue(guildId, token);
}

function ensureAdvanceListener(guildId) {
  const player = getPlayer(guildId);
  if (!player || wiredPlayers.has(player)) return;
  wiredPlayers.add(player);
  player.on(AudioPlayerStatus.Idle, () => {
    handleIdle(guildId).catch((err) =>
      console.error(`[Churan] Auto-advance failed (guild ${guildId}):`, err.message || err),
    );
  });
}

// Start a track NOW: extract a fresh live URL (never reuse stored ones),
// play it on the guild player, remember it as current.
async function playTrackNow(connection, guildId, track) {
  const mediaUrl = await getAudioUrl(track.youtubeUrl);
  playUrl(connection, guildId, mediaUrl);
  getState(guildId).current = track;
  ensureAdvanceListener(guildId);
  console.log(`[Churan] Now playing (guild ${guildId}): ${track.title}`);
  return track;
}

// Shift the next queued track and play it. Returns a status object:
//   played | empty | no-connection | failed | stale
// On 'failed' every queued track was unplayable (each failure is logged);
// the queue is then drained and current is null.
async function playNextInQueue(guildId, expectedEpoch = null) {
  for (;;) {
    const st = getState(guildId);
    if (expectedEpoch !== null && st.epoch !== expectedEpoch) return { status: 'stale' };
    const next = st.queue.shift();
    if (!next) {
      st.current = null;
      return { status: 'empty' };
    }
    const connection = getConnection(guildId);
    if (!connection) {
      st.current = null;
      st.queue.length = 0;
      console.log(`[Churan] Auto-play stopped (guild ${guildId}): no voice connection.`);
      return { status: 'no-connection' };
    }
    let mediaUrl;
    try {
      mediaUrl = await getAudioUrl(next.youtubeUrl);
    } catch (err) {
      console.error(`[Churan] Skipping unplayable queued track (guild ${guildId}): ${next.title} —`, err.message || err);
      continue;
    }
    if (expectedEpoch !== null && getState(guildId).epoch !== expectedEpoch) {
      return { status: 'stale' };
    }
    try {
      playUrl(connection, guildId, mediaUrl);
    } catch (err) {
      console.error(`[Churan] Skipping track that failed to start (guild ${guildId}): ${next.title} —`, err.message || err);
      continue;
    }
    getState(guildId).current = next;
    ensureAdvanceListener(guildId);
    console.log(`[Churan] Now playing (guild ${guildId}): ${next.title}`);
    return { status: 'played', track: next };
  }
}

// Skip the current track and advance. Safe when idle too (recovers stale
// queues); reports 'empty' when there is nothing anywhere.
async function skipGuild(guildId) {
  if (isPlaying(guildId)) suppressNextIdle(guildId);
  stopGuild(guildId);
  bumpEpoch(guildId);
  return playNextInQueue(guildId, getState(guildId).epoch);
}

// Stop everything: no advance, queue wiped, current cleared. Synchronous,
// so no interleaving with an in-flight extraction (it aborts on the bump).
function stopEverything(guildId) {
  if (isPlaying(guildId)) suppressNextIdle(guildId);
  stopGuild(guildId);
  bumpEpoch(guildId);
  const st = getState(guildId);
  st.current = null;
  st.queue.length = 0;
}

module.exports = {
  handleIdle,
  ensureAdvanceListener,
  playTrackNow,
  playNextInQueue,
  skipGuild,
  stopEverything,
};
