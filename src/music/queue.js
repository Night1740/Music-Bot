'use strict';

// Per-guild music state for Phase 4C. Sits ABOVE voice/player.js: the player
// remains the playback engine, this module remembers WHAT is playing and
// WHAT comes next.
//
// A track is metadata only — never an extracted Googlevideo URL (those are
// temporary). A fresh live URL is extracted via youtube/media.js every time
// a track starts:
//
//   { title, youtubeUrl, durationSeconds, duration, channel,
//     requester: { id, username } }
//
// State per guild:
//   current      currently (or paused-) playing track, or null
//   queue        upcoming tracks, FIFO
//   epoch        bumped on every state mutation; async continuations
//                (extraction → play) abort when it changed — this is what
//                prevents stale advances after /stop, /skip or /leave
//   suppressIdle set when WE stop the player on purpose (skip/stop/leave);
//                the resulting Idle event must not trigger auto-advance.
//                Only ever set while stopping an ACTIVE player, so exactly
//                one Idle consumes it — no stale flags.

const states = new Map(); // guildId -> state

function getState(guildId) {
  let st = states.get(guildId);
  if (!st) {
    st = { current: null, queue: [], epoch: 0, suppressIdle: false };
    states.set(guildId, st);
  }
  return st;
}

function bumpEpoch(guildId) {
  getState(guildId).epoch += 1;
}

function suppressNextIdle(guildId) {
  getState(guildId).suppressIdle = true;
}

// Returns true exactly once per suppressNextIdle() call.
function consumeSuppressIdle(guildId) {
  const st = getState(guildId);
  if (!st.suppressIdle) return false;
  st.suppressIdle = false;
  return true;
}

function clearGuild(guildId) {
  bumpEpoch(guildId);
  states.delete(guildId);
}

function formatDuration(track) {
  if (!track) return '';
  if (track.duration) return track.duration;
  const s = track.durationSeconds;
  if (typeof s !== 'number' || s < 0) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function trackLabel(track) {
  if (!track) return '(nothing)';
  const dur = formatDuration(track);
  return dur ? `${track.title} — ${dur}` : track.title;
}

module.exports = {
  getState,
  bumpEpoch,
  suppressNextIdle,
  consumeSuppressIdle,
  clearGuild,
  formatDuration,
  trackLabel,
};
