'use strict';

// Playback orchestrator for Phase 4C (+ Phase 6 Vibe, + playback-lifecycle
// hardening). Sits between Discord commands and voice/player.js: commands
// decide WHAT should happen, this module makes the player do it and advances
// the queue when tracks finish.
//
// State machine (the only legal transitions):
//   playTrackNow / playNextInQueue --playUrl--> Playing --Idle(natural)--> handleIdle --> advance|retry
//   skip/stop/leave --suppress+stop--> Idle(intentional) --> suppressed (no advance)
//
// Correctness mechanisms:
//   - ONE advancing Idle listener per AudioPlayer (WeakSet-guarded).
//   - suppressIdle distinguishes intentional stop/skip from natural finish.
//     Set ONLY while stopping an ACTIVE player, consumed exactly once.
//   - Epoch: every mutation bumps it; async continuations (extraction ->
//     play) abort when it changed. playNextInQueue PEEKS (queue[0]) before
//     extraction and SHIFTS only when committed, so a stale abort never
//     loses a track.
//   - advanceClaim: same-epoch duplicate Idle deliveries cannot advance
//     twice (@discordjs/voice itself emits Idle once per resource; this is
//     defense-in-depth + makes the guarantee testable).
//   - Completion evidence (NOT duration): AudioPlayer Idle alone never
//     proves a track finished. The stream record for the resource being
//     played captures whether its playStream reached EOF ('end') or
//     failed ('error'), and handleIdle additionally reads the stream's
//     own flags (readableEnded / _readableState.ended / errored) at Idle
//     time. Only positive EOF evidence -- plus a duration sanity check
//     (played >= known - tolerance) when the duration is known -- is
//     classified as natural-complete. No EOF evidence (FFmpeg
//     starvation, maxMissedFrames stop, throttled/reset Googlevideo
//     stream), an errored stream, or a clean-but-early EOF all count as
//     stream failures: replay the CURRENT track with a fresh URL. After
//     MAX_STREAM_RETRIES failures on the same track, advance -- but
//     labelled retries-exhausted, never natural-complete. Duration is
//     used ONLY as a failure detector, never to end playback.
//   - Diagnostic logs ([Churan:play]) correlate one session: extraction,
//     play(), state changes, Idle classification, epoch/queue/current
//     before/after. Never log media URLs (short-lived signed URLs).

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

// guildId -> { key, title, session, resource, eof, errored } for the latest
// play() call. Used to classify Idle (completion evidence vs stream death)
// and to correlate logs.
const activeRecords = new Map();

// guildId -> epoch token of the currently running advance. Same-token
// duplicate deliveries are rejected; a newer epoch always preempts.
const advanceClaims = new Map();

// guildId -> { key, count } of consecutive stream failures for the track
// identified by `key`. Keyed by track so a natural completion (or a new
// track starting) gives a fresh budget, and a failure can never be
// laundered into a clean slate by an unrelated advance.
const failureCounts = new Map();

// When a track of KNOWN duration ends cleanly this far below its expected
// length, the media/pipe was truncated (FFmpeg exit, bad demux) rather
// than finished. Plausible end-of-track jitter (encoder padding, metadata
// drift) stays inside the tolerance and counts as a natural completion.
const MAX_STREAM_RETRIES = 2;
const COMPLETION_TOLERANCE_MS = 5 * 1000;

// Idle verdicts (see classifyIdleEnd).
const IDLE_NATURAL = 'natural-complete';
const IDLE_STARVED = 'stream-starved';
const IDLE_ERRORED = 'stream-error';
const IDLE_TRUNCATED = 'truncated-eof';

let sessionSeq = 0;

function diag(msg, extra) {
  if (extra && typeof extra === 'object') {
    console.log(`[Churan:play] ${msg}`, extra);
  } else {
    console.log(`[Churan:play] ${msg}`);
  }
}

function trackKey(track) {
  if (!track) return '(none)';
  return track.youtubeUrl || track.title || '(unknown)';
}

function trackShort(track) {
  const t = track && track.title ? String(track.title) : '(unknown)';
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

function playedMsOf(record) {
  const d = record && record.resource ? record.resource.playbackDuration : null;
  return typeof d === 'number' && d >= 0 ? d : null;
}

function knownMsOf(track) {
  const s = track ? track.durationSeconds : null;
  return typeof s === 'number' && s > 0 ? s * 1000 : null;
}

// Why the player went Idle, decided ONLY from evidence on the stream that
// was playing the resource:
//   error   -> the stream failed (FFmpeg/pipe/googlevideo error)
//   eof     -> the stream genuinely ran out of media ('end' fired, or the
//              readable reports it reached EOF)
//   open    -> neither: the player gave up while the stream was still
//              alive (starvation / maxMissedFrames / process exit)
//   unknown -> no record for this track: never evidence of completion
function streamOutcome(record, track) {
  if (!record || !track || record.key !== trackKey(track)) return 'unknown';
  const s = record.resource ? record.resource.playStream : null;
  if (record.errored || (s && s.errored)) return 'error';
  if (record.eof) return 'eof';
  if (!s || typeof s !== 'object') return 'unknown';
  if (s.readableEnded === true) return 'eof';
  const st = s._readableState;
  if (st && st.ended === true) return 'eof';
  return 'open';
}

// Classify an Idle delivery for `track` (which may be null when nothing is
// current). Returns one of the IDLE_* verdicts. Completion requires
// positive EOF evidence; everything else is a stream failure.
function classifyIdleEnd(record, track, played, known) {
  const outcome = streamOutcome(record, track);
  if (outcome === 'error') return IDLE_ERRORED;
  if (outcome === 'open') return IDLE_STARVED;
  if (outcome === 'unknown') return IDLE_STARVED; // no evidence: never assume completion
  // outcome === 'eof': positive media completion, sanity-checked.
  if (!played) return IDLE_TRUNCATED; // ended before a single frame was heard
  if (known !== null && played + COMPLETION_TOLERANCE_MS < known) return IDLE_TRUNCATED;
  return IDLE_NATURAL;
}

function snapshot(guildId) {
  const st = getState(guildId);
  return {
    epoch: st.epoch,
    queueLen: st.queue.length,
    current: trackShort(st.current),
  };
}

// Count one stream failure against the CURRENT track. Returns the new
// count. Reset only when a different track starts (or on a proven-natural
// completion), so failures cannot be laundered into a clean slate.
function bumpFailure(guildId, track) {
  const key = trackKey(track);
  const prev = failureCounts.get(guildId);
  const count = prev && prev.key === key ? prev.count + 1 : 1;
  failureCounts.set(guildId, { key, count });
  return count;
}

async function handleIdle(guildId) {
  const st = getState(guildId);
  const record = activeRecords.get(guildId) || null;
  const played = playedMsOf(record);
  const known = knownMsOf(st.current);
  const before = snapshot(guildId);

  if (consumeSuppressIdle(guildId)) {
    diag(
      `idle guild=${guildId} class=intentional-stop playedMs=${played} ` +
        `knownMs=${known} epoch=${before.epoch} queue=${before.queueLen} current="${before.current}"`,
    );
    return { status: 'suppressed' };
  }

  const token = st.epoch;
  if (!st.current && st.queue.length === 0) {
    diag(`idle guild=${guildId} class=stray epoch=${token} queue=0`);
    return { status: 'stray' };
  }

  // Same-epoch duplicate delivery guard (see advanceClaims).
  if (advanceClaims.get(guildId) === token) {
    diag(`idle guild=${guildId} class=duplicate-ignored epoch=${token} current="${before.current}"`);
    return { status: 'duplicate' };
  }

  let verdict = IDLE_NATURAL;
  if (st.current) {
    verdict = classifyIdleEnd(record, st.current, played, known);
    if (verdict !== IDLE_NATURAL) {
      const failures = bumpFailure(guildId, st.current);
      if (failures <= MAX_STREAM_RETRIES) {
        diag(
          `idle guild=${guildId} class=${verdict} playedMs=${played} knownMs=${known} ` +
            `retry=${failures}/${MAX_STREAM_RETRIES} epoch=${token} track="${trackShort(st.current)}"`,
        );
        const res = await retryCurrentTrack(guildId, token);
        return res && typeof res === 'object' ? { ...res, reason: verdict } : res;
      }
      diag(
        `idle guild=${guildId} class=${verdict} playedMs=${played} knownMs=${known} ` +
          `retries-exhausted=${failures} epoch=${token} track="${trackShort(st.current)}" -> advancing`,
      );
    }
  }

  // Natural completion (proven by EOF evidence) or retries exhausted.
  if (verdict === IDLE_NATURAL) failureCounts.delete(guildId);
  advanceClaims.set(guildId, token);
  const reason = verdict === IDLE_NATURAL ? IDLE_NATURAL : 'retries-exhausted';
  try {
    diag(
      `idle guild=${guildId} class=${reason} playedMs=${played} knownMs=${known} ` +
        `epoch=${token} queue=${before.queueLen} finished="${before.current}"`,
    );
    st.current = null; // finished track leaves, whatever comes next is new
    const res = await playNextInQueue(guildId, token);
    const after = snapshot(guildId);
    diag(
      `advanced guild=${guildId} result=${res.status} reason=${reason} epoch=${after.epoch} ` +
        `queue=${after.queueLen} current="${after.current}"`,
    );
    return res && typeof res === 'object' ? { ...res, reason } : res;
  } finally {
    if (advanceClaims.get(guildId) === token) advanceClaims.delete(guildId);
  }
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
  // Diagnostics only: never advances, never mutates. Correlates the raw
  // player state machine with the queue-level decisions above.
  if (typeof player.on === 'function') {
    try {
      player.on('stateChange', (oldState, newState) => {
        const oldStatus = oldState && oldState.status;
        const newStatus = newState && newState.status;
        const res = (newState && newState.resource) || (oldState && oldState.resource);
        const dur = res && typeof res.playbackDuration === 'number' ? res.playbackDuration : null;
        diag(
          `state guild=${guildId} ${oldStatus} -> ${newStatus} ` +
            `playbackDurationMs=${dur} current="${trackShort(getState(guildId).current)}"`,
        );
      });
    } catch {
      // Non-standard player (tests): diagnostics are optional.
    }
  }
}

// Record a successful play() for Idle classification + log correlation.
// Captures completion evidence on the resource's playStream: whether the
// media stream reached EOF ('end') or failed ('error') before the player
// reported Idle. The player's own state-setter destroys the stream before
// emitting Idle, so these listener flags are the durable record; the raw
// stream flags are read as a cross-check at classification time.
function notePlay(guildId, track, session) {
  let resource = null;
  try {
    resource = getPlayer(guildId)?.state?.resource || null;
  } catch {
    resource = null;
  }
  const record = { key: trackKey(track), title: trackShort(track), session, resource, eof: false, errored: false };
  const stream = resource ? resource.playStream : null;
  if (stream && typeof stream.once === 'function') {
    stream.once('end', () => {
      record.eof = true;
    });
    stream.once('error', () => {
      record.errored = true;
    });
  }
  activeRecords.set(guildId, record);
}

// Start a track NOW: extract a fresh live URL (never reuse stored ones),
// play it on the guild player, remember it as current.
// Epoch-guarded: when expectedEpoch is given and the epoch moved during
// extraction, NOTHING is played and { status: 'stale' } is returned so the
// caller can re-decide (queue instead of cutting off the winner).
async function playTrackNow(connection, guildId, track, expectedEpoch = null) {
  const token = expectedEpoch !== null ? expectedEpoch : getState(guildId).epoch;
  const session = (sessionSeq += 1);
  diag(
    `extract-begin guild=${guildId} session=${session} epoch=${token} ` +
      `track="${trackShort(track)}" mode=now`,
  );
  const mediaUrl = await getAudioUrl(track.youtubeUrl);
  if (getState(guildId).epoch !== token) {
    diag(`extract-stale guild=${guildId} session=${session} epoch=${token}->${getState(guildId).epoch} track="${trackShort(track)}" (not played)`);
    return { status: 'stale', track };
  }
  const beforeStatus = getPlayer(guildId)?.state?.status || '(no-player)';
  diag(`resource-play guild=${guildId} session=${session} playerBefore=${beforeStatus} track="${trackShort(track)}"`);
  playUrl(connection, guildId, mediaUrl);
  getState(guildId).current = track;
  failureCounts.delete(guildId); // new track: fresh failure budget
  notePlay(guildId, track, session);
  ensureAdvanceListener(guildId);
  diag(
    `playing guild=${guildId} session=${session} epoch=${getState(guildId).epoch} ` +
      `playerAfter=${getPlayer(guildId)?.state?.status} track="${trackShort(track)}"`,
  );
  return { status: 'played', track, session };
}

// Replay the CURRENT track with a fresh URL (stream-failure path). Current
// is intentionally preserved; only the underlying stream is replaced.
async function retryCurrentTrack(guildId, expectedEpoch) {
  const cur = getState(guildId).current;
  if (!cur) return playNextInQueue(guildId, expectedEpoch);
  const session = (sessionSeq += 1);
  diag(`extract-begin guild=${guildId} session=${session} epoch=${expectedEpoch} track="${trackShort(cur)}" mode=retry`);
  let mediaUrl;
  try {
    mediaUrl = await getAudioUrl(cur.youtubeUrl);
  } catch (err) {
    console.error(`[Churan] Retry extraction failed (guild ${guildId}): ${cur.title} —`, err.message || err);
    getState(guildId).current = null;
    failureCounts.delete(guildId);
    return playNextInQueue(guildId, expectedEpoch);
  }
  if (getState(guildId).epoch !== expectedEpoch) {
    diag(`extract-stale guild=${guildId} session=${session} (retry not played)`);
    return { status: 'stale' };
  }
  const connection = getConnection(guildId);
  if (!connection) {
    getState(guildId).current = null;
    getState(guildId).queue.length = 0;
    failureCounts.delete(guildId);
    diag(`retry-aborted guild=${guildId} session=${session} reason=no-connection (queue drained)`);
    return { status: 'no-connection' };
  }
  playUrl(connection, guildId, mediaUrl);
  notePlay(guildId, cur, session);
  ensureAdvanceListener(guildId);
  diag(`replaying guild=${guildId} session=${session} track="${trackShort(cur)}"`);
  return { status: 'replayed', track: cur, session };
}

// Shift the next queued track and play it. Returns a status object:
//   played | replayed | empty | no-connection | stale | duplicate
// PEEKS at queue[0] before the slow extraction and SHIFTS only when
// committed, so stale aborts never lose a track. Unplayable tracks are
// dropped (shifted) and skipped, as before.
async function playNextInQueue(guildId, expectedEpoch = null) {
  for (;;) {
    const st = getState(guildId);
    if (expectedEpoch !== null && st.epoch !== expectedEpoch) {
      diag(`advance-stale guild=${guildId} expected=${expectedEpoch} actual=${st.epoch} (queue untouched, len=${st.queue.length})`);
      return { status: 'stale' };
    }
    const next = st.queue[0]; // peek: do NOT remove until we commit
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
    const session = (sessionSeq += 1);
    diag(
      `extract-begin guild=${guildId} session=${session} epoch=${st.epoch} ` +
        `track="${trackShort(next)}" mode=next queueLen=${st.queue.length}`,
    );
    let mediaUrl;
    try {
      mediaUrl = await getAudioUrl(next.youtubeUrl);
    } catch (err) {
      console.error(`[Churan] Skipping unplayable queued track (guild ${guildId}): ${next.title} —`, err.message || err);
      getState(guildId).queue.shift(); // drop only the proven-bad head
      continue;
    }
    if (expectedEpoch !== null && getState(guildId).epoch !== expectedEpoch) {
      diag(`extract-stale guild=${guildId} session=${session} track="${trackShort(next)}" (kept in queue)`);
      return { status: 'stale' };
    }
    try {
      const live = getState(guildId);
      if (live.queue[0] !== next) {
        // Head changed without an epoch bump (shouldn't happen: every
        // mutation bumps). Abort rather than play the wrong track.
        diag(`advance-aborted guild=${guildId} session=${session} reason=head-changed`);
        return { status: 'stale' };
      }
      live.queue.shift(); // commit point: track leaves the queue exactly once
      playUrl(connection, guildId, mediaUrl);
    } catch (err) {
      console.error(`[Churan] Skipping track that failed to start (guild ${guildId}): ${next.title} —`, err.message || err);
      continue;
    }
    const done = getState(guildId);
    done.current = next;
    failureCounts.delete(guildId); // new track: fresh failure budget
    notePlay(guildId, next, session);
    ensureAdvanceListener(guildId);
    diag(
      `playing guild=${guildId} session=${session} epoch=${done.epoch} ` +
        `queue=${done.queue.length} track="${trackShort(next)}"`,
    );
    return { status: 'played', track: next, session };
  }
}

// Skip the current track and advance. Safe when idle too (recovers stale
// queues); reports 'empty' when there is nothing anywhere.
async function skipGuild(guildId) {
  const before = snapshot(guildId);
  diag(`skip guild=${guildId} epoch=${before.epoch} queue=${before.queueLen} current="${before.current}"`);
  if (isPlaying(guildId)) suppressNextIdle(guildId);
  stopGuild(guildId);
  bumpEpoch(guildId);
  const res = await playNextInQueue(guildId, getState(guildId).epoch);
  const after = snapshot(guildId);
  diag(`skipped guild=${guildId} result=${res.status} epoch=${after.epoch} queue=${after.queueLen} current="${after.current}"`);
  return res;
}

// Stop everything: no advance, queue wiped, current cleared. Synchronous,
// so no interleaving with an in-flight extraction (it aborts on the bump).
function stopEverything(guildId) {
  const before = snapshot(guildId);
  diag(`stop guild=${guildId} epoch=${before.epoch} queue=${before.queueLen} current="${before.current}"`);
  if (isPlaying(guildId)) suppressNextIdle(guildId);
  stopGuild(guildId);
  bumpEpoch(guildId);
  const st = getState(guildId);
  st.current = null;
  st.queue.length = 0;
  activeRecords.delete(guildId);
  advanceClaims.delete(guildId);
  failureCounts.delete(guildId);
}

// Forget per-guild playback bookkeeping (stream records, advance claims,
// failure budgets) without touching the queue itself. Used by /leave,
// which wipes queue state separately via clearGuild().
function clearPlaybackState(guildId) {
  activeRecords.delete(guildId);
  advanceClaims.delete(guildId);
  failureCounts.delete(guildId);
}

module.exports = {
  handleIdle,
  ensureAdvanceListener,
  playTrackNow,
  playNextInQueue,
  retryCurrentTrack,
  skipGuild,
  stopEverything,
  clearPlaybackState,
  classifyIdleEnd,
  MAX_STREAM_RETRIES,
  COMPLETION_TOLERANCE_MS,
};
