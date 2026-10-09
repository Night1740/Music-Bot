'use strict';

// Playback completion-detection regression tests. Proves that an
// AudioPlayer Idle is NEVER treated as a finished track without positive
// completion evidence (stream EOF), that a dead stream replays the CURRENT
// track, and that retry accounting cannot launder failures into a natural
// completion. Also pins the /skip, /stop and stale-extraction guarantees.
//
// No network, no Discord: voice/player.js, youtube/media.js and
// voice/manager.js are stubbed BEFORE playback.js is required (playback
// destructures them at load time). Deterministic — run: npm test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// --- seams (patched before playback.js loads) -------------------------------

const media = require('../src/youtube/media');
const playerMod = require('../src/voice/player');
const manager = require('../src/voice/manager');
const queue = require('../src/music/queue');

const defaultExtract = (url) => `https://media.test/audio?v=${encodeURIComponent(url)}`;
let extractImpl = defaultExtract;
media.getAudioUrl = (url) => extractImpl(url);

const playedCalls = []; // every playUrl, in order: { gid, mediaUrl }
const stoppedCalls = [];
const players = new Map(); // gid -> FakePlayer
let lastResource = null; // resource created by the most recent playUrl

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'idle', resource: null };
  }
}

// Stand-in for an AudioResource: playStream carries the completion flags
// the classifier reads, playbackDuration carries what was actually heard.
function makeResource(opts = {}) {
  const playStream = new EventEmitter();
  playStream.readableEnded = !!opts.readableEnded;
  playStream._readableState = { ended: !!opts.readableEnded };
  playStream.errored = opts.errored || null;
  return { playStream, playbackDuration: opts.playbackDuration || 0 };
}

playerMod.getPlayer = (gid) => players.get(gid);
playerMod.isPlaying = (gid) => {
  const p = players.get(gid);
  return !!p && p.state.status !== 'idle';
};
playerMod.playUrl = (connection, gid, mediaUrl) => {
  if (!mediaUrl || typeof mediaUrl !== 'string') throw new Error('playUrl: mediaUrl must be a non-empty string');
  let p = players.get(gid);
  if (!p) {
    p = new FakePlayer();
    players.set(gid, p);
  }
  p.state.status = 'playing';
  p.state.resource = makeResource();
  lastResource = p.state.resource;
  playedCalls.push({ gid, mediaUrl });
  return p;
};
// Deliberately does NOT emit Idle: each test delivers the Idle itself so it
// can assert exactly what a given Idle did (suppress, retry, or advance).
playerMod.stopGuild = (gid) => {
  stoppedCalls.push(gid);
  const p = players.get(gid);
  if (!p) return false;
  p.state.status = 'idle';
  p.state.resource = null;
  return true;
};
manager.getConnection = (gid) => (gid ? { guildId: gid } : undefined);

const playback = require('../src/music/playback');

// --- helpers ----------------------------------------------------------------

function track(title, durationSeconds) {
  return {
    title,
    youtubeUrl: `https://www.youtube.com/watch?v=${title}`,
    durationSeconds,
    requester: { id: 'u1', username: 'tester' },
  };
}

function urls() {
  return playedCalls.map((c) => c.mediaUrl);
}

let seq = 0;
function freshGuild() {
  seq += 1;
  const gid = `guild-${seq}`;
  queue.clearGuild(gid);
  players.delete(gid);
  playback.clearPlaybackState(gid);
  extractImpl = defaultExtract;
  playedCalls.length = 0;
  stoppedCalls.length = 0;
  lastResource = null;
  return gid;
}

// Seed `current` as playing, with `rest` queued.
async function seed(gid, current, rest = []) {
  const st = queue.getState(gid);
  st.current = null;
  st.queue = rest.slice();
  const res = await playback.playTrackNow({ id: 'fake-connection' }, gid, current, null);
  assert.equal(res.status, 'played');
  assert.equal(st.current, current);
  assert.ok(lastResource, 'playUrl should have built a resource');
  return res;
}

// Simulate the player having died mid-track with no EOF evidence.
function starve(playedMs) {
  lastResource.playbackDuration = playedMs;
  // readableEnded stays false, errored stays null: stream still "open".
}

// Simulate a clean end of media.
function reachEof(playedMs, { listener = true } = {}) {
  lastResource.playbackDuration = playedMs;
  lastResource.playStream.readableEnded = true;
  lastResource.playStream._readableState = { ended: true };
  if (listener) lastResource.playStream.emit('end');
}

function failStream(message) {
  const err = new Error(message);
  lastResource.playStream.errored = err;
  lastResource.playStream.emit('error', err);
}

// --- the bug this fixes -----------------------------------------------------

describe('premature track transition regression', () => {
  it('replays the SAME track when a known-duration stream dies at 90%', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    await seed(gid, a, [b]);

    // 90% played: the old duration heuristic (>= 50% / known-20s) called
    // this "natural-complete" and skipped to b. No EOF evidence exists.
    starve(270000);

    const res = await playback.handleIdle(gid);

    assert.equal(res.status, 'replayed');
    assert.equal(res.reason, 'stream-starved');
    assert.equal(queue.getState(gid).current, a, 'current track must be preserved');
    assert.deepEqual(queue.getState(gid).queue, [b], 'queue must be untouched');
    assert.equal(playedCalls.length, 2, 'exactly one replay of the same track');
    assert.equal(urls()[0], urls()[1], 'replay must re-extract the same track');
    assert.notEqual(urls()[1], `https://media.test/audio?v=${encodeURIComponent(b.youtubeUrl)}`);
  });

  it('replays when an UNKNOWN-duration stream dies (guard cannot be disabled)', async () => {
    const gid = freshGuild();
    const a = track('aaa'); // no durationSeconds -> known === null
    const b = track('bbb', 300);
    await seed(gid, a, [b]);

    starve(10000);

    const res = await playback.handleIdle(gid);

    assert.equal(res.status, 'replayed');
    assert.equal(res.reason, 'stream-starved');
    assert.equal(queue.getState(gid).current, a);
    assert.deepEqual(queue.getState(gid).queue, [b]);
    assert.equal(playedCalls.length, 2);
  });

  it('replays on stream error instead of calling it completion', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    await seed(gid, a, [b]);

    failStream('ffmpeg/pipe failure');

    const res = await playback.handleIdle(gid);

    assert.equal(res.status, 'replayed');
    assert.equal(res.reason, 'stream-error');
    assert.equal(queue.getState(gid).current, a);
    assert.deepEqual(queue.getState(gid).queue, [b]);
    assert.equal(playedCalls.length, 2);
  });

  it('replays on a clean EOF that stops halfway through a known track', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    await seed(gid, a, [b]);

    // EOF evidence, but only 40% of the expected media was heard.
    reachEof(120000, { listener: false });

    const res = await playback.handleIdle(gid);

    assert.equal(res.status, 'replayed');
    assert.equal(res.reason, 'truncated-eof');
    assert.equal(queue.getState(gid).current, a);
    assert.deepEqual(queue.getState(gid).queue, [b]);
    assert.equal(playedCalls.length, 2);
  });

  it('advances exactly once on a genuine EOF that ran to the end', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    await seed(gid, a, [b]);

    reachEof(300000);

    const res = await playback.handleIdle(gid);

    assert.equal(res.status, 'played');
    assert.equal(res.reason, 'natural-complete');
    assert.equal(queue.getState(gid).current, b, 'next track plays');
    assert.deepEqual(queue.getState(gid).queue, []);
    assert.equal(playedCalls.length, 2);
    assert.equal(
      urls()[1],
      `https://media.test/audio?v=${encodeURIComponent(b.youtubeUrl)}`,
    );
  });

  it('two same-epoch Idle deliveries advance only once', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    await seed(gid, a, [b]);

    reachEof(300000);

    const [first, second] = await Promise.all([
      playback.handleIdle(gid),
      playback.handleIdle(gid),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, ['duplicate', 'played']);
    assert.equal(playedCalls.length, 2, 'b must be extracted exactly once');
    assert.equal(queue.getState(gid).current, b);
    assert.deepEqual(queue.getState(gid).queue, []);
  });
});

// --- retry accounting -------------------------------------------------------

describe('stream-failure retries', () => {
  async function exhaust(gid, a, b) {
    await seed(gid, a, [b]);
    const first = await playback.handleIdle(gid); // 1/2
    const second = await playback.handleIdle(gid); // 2/2
    const third = await playback.handleIdle(gid); // exhausted -> advance
    return [first, second, third];
  }

  it('gives a new track a fresh budget after the old track exhausted its retries', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);

    const [first, second, third] = await exhaust(gid, a, b);
    assert.equal(first.status, 'replayed');
    assert.equal(first.reason, 'stream-starved');
    assert.equal(second.status, 'replayed');
    assert.equal(second.reason, 'stream-starved');
    assert.equal(third.status, 'played');
    assert.equal(third.reason, 'retries-exhausted', 'exhaustion must never be natural-complete');
    assert.notEqual(third.reason, 'natural-complete');

    // a played 3x (initial + 2 retries), b once: 4 extractions total.
    assert.equal(playedCalls.length, 4);
    assert.equal(queue.getState(gid).current, b);
    assert.deepEqual(queue.getState(gid).queue, []);

    // b now fails once: its budget must be fresh (1/2 -> replay), proving
    // a's exhausted counter could not leak into b's accounting.
    starve(1000);
    const onB = await playback.handleIdle(gid);
    assert.equal(onB.status, 'replayed');
    assert.equal(onB.reason, 'stream-starved');
    assert.equal(queue.getState(gid).current, b, 'b is replayed, not skipped');
    assert.equal(playedCalls.length, 5);
    assert.equal(urls()[4], urls()[3], 'replay must be b again');
  });

  it('bounds consecutive stream failures, then advances without a natural verdict', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    const c = track('ccc', 300);

    await seed(gid, a, [b, c]);
    starve(100000); // failure 1/2 on a
    assert.equal((await playback.handleIdle(gid)).status, 'replayed');

    starve(100000); // failure 2/2 on a
    assert.equal((await playback.handleIdle(gid)).status, 'replayed');

    starve(100000); // failure 3 -> exhausted -> advance to b
    const advanced = await playback.handleIdle(gid);
    assert.equal(advanced.status, 'played');
    assert.equal(advanced.reason, 'retries-exhausted');
    assert.equal(queue.getState(gid).current, b);

    // b must start at 1/2, not carry a's count.
    starve(1000);
    assert.equal((await playback.handleIdle(gid)).status, 'replayed');
    assert.equal(queue.getState(gid).current, b);
  });
});

// --- command guarantees -----------------------------------------------------

describe('command guarantees', () => {
  it('/skip advances exactly once and its Idle never advances again', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    const c = track('ccc', 300);
    await seed(gid, a, [b, c]);

    const res = await playback.skipGuild(gid);
    assert.equal(res.status, 'played');
    assert.equal(queue.getState(gid).current, b, 'exactly one advance: b');
    assert.deepEqual(queue.getState(gid).queue, [c]);
    assert.equal(playedCalls.length, 2);

    // The Idle produced by skip's stop() is delivered here.
    const idle = await playback.handleIdle(gid);
    assert.equal(idle.status, 'suppressed');
    assert.equal(playedCalls.length, 2, 'no second advance, no retry');
    assert.equal(queue.getState(gid).current, b);
    assert.deepEqual(queue.getState(gid).queue, [c]);
  });

  it('/stop never starts the next track', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    const c = track('ccc', 300);
    await seed(gid, a, [b, c]);

    playback.stopEverything(gid);

    const idle = await playback.handleIdle(gid);
    assert.equal(idle.status, 'suppressed');
    assert.equal(playedCalls.length, 1, 'nothing new was played');
    assert.equal(queue.getState(gid).current, null);
    assert.deepEqual(queue.getState(gid).queue, []);
  });

  it('a stale extraction (epoch moved) never plays anything', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);

    let release;
    extractImpl = () => new Promise((resolve) => { release = resolve; });
    const pending = playback.playTrackNow({ id: 'fake-connection' }, gid, a, null);
    await new Promise((r) => setImmediate(r)); // reach the extraction await

    queue.bumpEpoch(gid); // a competing /play or /stop won
    release('https://media.test/audio?v=stale');

    const res = await pending;
    assert.equal(res.status, 'stale');
    assert.equal(playedCalls.length, 0, 'stale extraction must not play');
    assert.equal(queue.getState(gid).current, null);
  });

  it('a natural completion forgets the failure budget', async () => {
    const gid = freshGuild();
    const a = track('aaa', 300);
    const b = track('bbb', 300);
    await seed(gid, a, [b]);

    starve(100000); // failure 1/2
    assert.equal((await playback.handleIdle(gid)).status, 'replayed');

    reachEof(300000); // genuine finish -> budget cleared, b starts
    const done = await playback.handleIdle(gid);
    assert.equal(done.status, 'played');
    assert.equal(done.reason, 'natural-complete');
    assert.equal(queue.getState(gid).current, b);

    starve(1000); // b fails once -> b's own 1/2, not a's 2/2
    assert.equal((await playback.handleIdle(gid)).status, 'replayed');
    assert.equal(queue.getState(gid).current, b);
  });
});

// --- classifier unit checks -------------------------------------------------

describe('classifyIdleEnd verdicts', () => {
  const { classifyIdleEnd, MAX_STREAM_RETRIES, COMPLETION_TOLERANCE_MS } = playback;
  const t = { title: 'x', youtubeUrl: 'https://www.youtube.com/watch?v=x' };
  const key = t.youtubeUrl;

  function rec(over = {}) {
    const resource = makeResource(over.resource || {});
    return { key: over.key === undefined ? key : over.key, title: 'x', session: 1, resource, eof: !!over.eof, errored: !!over.errored };
  }

  it('exports a bounded retry budget and a sane tolerance', () => {
    assert.equal(MAX_STREAM_RETRIES, 2);
    assert.equal(typeof COMPLETION_TOLERANCE_MS, 'number');
    assert.ok(COMPLETION_TOLERANCE_MS > 0 && COMPLETION_TOLERANCE_MS <= 30000);
  });

  it('no record / mismatched record => never a completion', () => {
    assert.equal(classifyIdleEnd(null, t, 300000, 300000), 'stream-starved');
    const foreign = rec({ key: 'other' });
    assert.equal(classifyIdleEnd(foreign, t, 300000, 300000), 'stream-starved');
  });

  it('EOF with plausible duration => natural-complete', () => {
    assert.equal(classifyIdleEnd(rec({ resource: { readableEnded: true } }), t, 298000, 300000), 'natural-complete');
    assert.equal(classifyIdleEnd(rec({ eof: true }), t, 300000, 300000), 'natural-complete');
    assert.equal(classifyIdleEnd(rec({ resource: { readableEnded: true } }), t, 300000, null), 'natural-complete');
  });

  it('EOF too short of the known duration => truncated-eof', () => {
    assert.equal(
      classifyIdleEnd(rec({ resource: { readableEnded: true } }), t, 120000, 300000),
      'truncated-eof',
    );
    assert.equal(classifyIdleEnd(rec({ resource: { readableEnded: true } }), t, 0, 300000), 'truncated-eof');
    assert.equal(classifyIdleEnd(rec({ resource: { readableEnded: true } }), t, 0, null), 'truncated-eof');
  });

  it('no EOF evidence => stream-starved, even at 99% played', () => {
    assert.equal(classifyIdleEnd(rec(), t, 297000, 300000), 'stream-starved');
    assert.equal(classifyIdleEnd(rec(), t, 297000, null), 'stream-starved');
  });

  it('errored stream => stream-error regardless of how much played', () => {
    assert.equal(classifyIdleEnd(rec({ errored: true }), t, 299000, 300000), 'stream-error');
    assert.equal(classifyIdleEnd(rec({ resource: { errored: new Error('x') } }), t, 100, 300000), 'stream-error');
  });

  it('errored beats EOF evidence (both can be recorded)', () => {
    assert.equal(
      classifyIdleEnd(rec({ eof: true, errored: true, resource: { readableEnded: true } }), t, 300000, 300000),
      'stream-error',
    );
  });
});
