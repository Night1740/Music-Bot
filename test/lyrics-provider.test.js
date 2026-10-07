'use strict';

// Phase 5.2 regression suite: lyrics provider (LRCLIB) metadata / scoring /
// resolution behavior.
//
// Deterministic by design: every LRCLIB HTTP response and every YouTube
// metadata-discovery result is mocked, so these tests never touch the
// network. There is no lyric text anywhere here — synced payloads are
// synthetic two-line placeholders of our own invention, and assertions cover
// only titles, artists, durations, scores, rejection reasons, query paths
// and resolution outcomes.
//
// Run: npm test   (node --test test/)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../src/lyrics/provider');
const { parseLrc } = require('../src/lyrics/parser');

const SEARCH_MODULE_PATH = require.resolve('../src/youtube/search');

// --- synthetic fixtures (own placeholder content, never real lyrics) --------

const SYNTH_LRC =
  '[00:01.00] synthetic placeholder alpha\n[00:05.00] synthetic placeholder beta\n';

function lrcRow({ trackName, artistName, duration = 240, instrumental = false, synced = true }) {
  return {
    id: 7,
    trackName,
    artistName,
    duration,
    instrumental,
    syncedLyrics: synced ? SYNTH_LRC : null,
  };
}

// --- mocks -----------------------------------------------------------------

let fetchCalls;
let ytCalls;
let realFetch;
let realSearchCacheEntry;

function installFetch(routes) {
  fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(String(url));
    const decoded = decodeURIComponent(String(url));
    for (const r of routes) {
      if (r.match(decoded)) {
        if (r.error) throw r.error;
        const status = r.status ?? 200;
        return { status, ok: status >= 200 && status < 300, json: async () => r.body };
      }
    }
    return { status: 200, ok: true, json: async () => [] };
  };
}

function lrclibSearchCalls() {
  return fetchCalls.filter((u) => u.includes('/search?q='));
}

// Stub the lazily-required ../youtube/search module via require.cache.
// provider.js requires it inside runDiscovery, so the stub is picked up.
function installSearchYouTube(impl) {
  ytCalls = [];
  realSearchCacheEntry = require.cache[SEARCH_MODULE_PATH];
  require.cache[SEARCH_MODULE_PATH] = {
    id: SEARCH_MODULE_PATH,
    filename: SEARCH_MODULE_PATH,
    loaded: true,
    exports: {
      searchYouTube: async (query, opts) => {
        ytCalls.push({ query, opts });
        return impl(query, opts);
      },
    },
  };
}

// Discovery must stay silent on pure direct-path tests.
function noDiscovery() {
  installSearchYouTube(async () => []);
}

beforeEach(() => {
  realFetch = global.fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  if (realSearchCacheEntry) require.cache[SEARCH_MODULE_PATH] = realSearchCacheEntry;
  else delete require.cache[SEARCH_MODULE_PATH];
  realSearchCacheEntry = undefined;
});

// --- 1. English direct match ------------------------------------------------

describe('1. English direct match (normal LRCLIB path)', () => {
  it('resolves without touching discovery', async () => {
    installFetch([
      {
        match: (u) => u.includes('Die With A Smile'),
        body: [lrcRow({ trackName: 'Die With A Smile', artistName: 'Lady Gaga, Bruno Mars', duration: 240 })],
      },
    ]);
    noDiscovery();
    const track = {
      title: 'Lady Gaga, Bruno Mars - Die With A Smile',
      channel: 'Lady Gaga - Topic',
      durationSeconds: 241,
    };
    const found = await provider.findSyncedLyrics(track);
    assert.ok(found, 'expected a candidate');
    assert.equal(found.trackName, 'Die With A Smile');
    assert.equal(found.artistName, 'Lady Gaga, Bruno Mars');
    const diag = await provider.diagnoseTrack(track);
    assert.equal(diag.selected && diag.selected.score, 'direct');
    assert.equal(ytCalls.length, 0, 'direct match must not run discovery');
  });
});

// --- 2. Hindi direct match ---------------------------------------------------

describe('2. Hindi direct match (romanized Bollywood title)', () => {
  it('resolves romanized Hindi titles normally', async () => {
    installFetch([
      {
        match: (u) => u.includes('Tum Hi Ho'),
        body: [lrcRow({ trackName: 'Tum Hi Ho', artistName: 'Arijit Singh', duration: 262 })],
      },
    ]);
    noDiscovery();
    const track = {
      title: 'Tum Hi Ho - Aashiqui 2 | Aditya Roy Kapur | Arijit Singh',
      channel: 'T-Series',
    };
    const parsed = provider.parseYouTubeTitle(track.title, track.channel);
    assert.equal(parsed.song, 'Tum Hi Ho');
    assert.equal(parsed.movie, 'Aashiqui 2');
    assert.equal(parsed.channelArtist, '', 'label channels must not pollute queries');
    const found = await provider.findSyncedLyrics(track);
    assert.ok(found, 'expected a candidate');
    assert.equal(found.trackName, 'Tum Hi Ho');
    const diag = await provider.diagnoseTrack(track);
    assert.equal(diag.selected && diag.selected.score, 'direct');
    assert.equal(ytCalls.length, 0, 'direct match must not run discovery');
  });
});

// --- 3. Devanagari discovery regression --------------------------------------

describe('3. Devanagari discovery regression (kesariya)', () => {
  it('romanized discovery candidate is accepted for Devanagari input', async () => {
    installFetch([
      // Devanagari direct queries: LRCLIB indexes romanized titles only.
      { match: (u) => /[\u0900-\u097F]/.test(u), body: [] },
      {
        match: (u) => u.includes('Kesariya'),
        body: [lrcRow({ trackName: 'Kesariya', artistName: 'Pritam, Arijit Singh', duration: 268 })],
      },
    ]);
    installSearchYouTube(async () => [
      {
        title: 'Kesariya - Brahmastra | Ranbir Kapoor, Alia Bhatt | Pritam, Arijit Singh',
        channel: 'Sony Music India',
      },
    ]);
    const track = {
      title: 'केसरिया - ब्रह्मास्त्र | रणबीर कपूर, आलिया भट्ट',
      channel: 'Sony Music India',
    };
    const parsed = provider.parseYouTubeTitle(track.title, track.channel);
    assert.equal(parsed.hasDevanagari, true);

    const found = await provider.findSyncedLyrics(track);
    assert.ok(found, 'discovery must accept the romanized candidate (pre-fix returned null)');
    assert.equal(found.trackName, 'Kesariya');
    assert.equal(ytCalls.length, 1, 'exactly one metadata-discovery search');
    assert.ok(lrclibSearchCalls().length <= 5, 'bounded: ≤3 direct + ≤2 discovery LRCLIB lookups');

    const diag = await provider.diagnoseTrack(track);
    assert.equal(diag.selected && diag.selected.score, 'discovery');
    assert.ok(
      diag.lookups.every((l) => l.candidateCount === 0),
      'direct Devanagari lookups return no rows',
    );
    assert.ok(
      (diag.discovery.lookups || []).length <= 2,
      'discovery stays within the ≤2 fresh-query budget',
    );
  });
});

// --- 4. Title normalization / suffix variation --------------------------------

describe('4. title normalization / suffix variation', () => {
  it('video-suffix variants keep song/movie identity', () => {
    const a = provider.parseYouTubeTitle(
      'Apna Time Aayega - Gully Boy (Official Lyric Video) | Ranveer Singh | DIVINE',
      'Zee Music Company',
    );
    assert.equal(a.song, 'Apna Time Aayega');
    assert.equal(a.movie, 'Gully Boy');

    const b = provider.parseYouTubeTitle(
      'Kesariya - Brahmastra | Ranbir Kapoor, Alia Bhatt | Pritam, Arijit Singh | 4K',
      'T-Series',
    );
    assert.equal(b.song, 'Kesariya');
    assert.equal(b.movie, 'Brahmastra');

    const c = provider.parseYouTubeTitle('Tum Hi Ho (Official Video)', 'T-Series');
    assert.equal(c.song, 'Tum Hi Ho');

    assert.equal(provider.stripVideoSuffixes('Kesariya (Official Music Video)'), 'Kesariya');
  });

  it('suffix-laden input still resolves', async () => {
    installFetch([
      {
        match: (u) => u.includes('Apna Time Aayega'),
        body: [lrcRow({ trackName: 'Apna Time Aayega', artistName: 'Ranveer Singh, DIVINE', duration: 260 })],
      },
    ]);
    noDiscovery();
    const found = await provider.findSyncedLyrics({
      title: 'Apna Time Aayega - Gully Boy (Official Lyric Video) | Ranveer Singh | DIVINE',
      channel: 'Zee Music Company',
    });
    assert.ok(found, 'suffix must not cause rejection');
    assert.equal(found.trackName, 'Apna Time Aayega');
  });
});

// --- 5. Artist variation ------------------------------------------------------

describe('5. artist variation', () => {
  it('reasonable artist/title variation still matches', async () => {
    assert.equal(provider.channelArtist('Arijit Singh - Topic'), 'Arijit Singh');
    assert.equal(provider.channelArtist('T-Series'), '');
    assert.equal(provider.channelArtist('Sony Music India'), '');
    installFetch([
      {
        match: (u) => u.includes('Tum Hi Ho'),
        body: [lrcRow({ trackName: 'Tum Hi Ho', artistName: 'Mithoon, Arijit Singh', duration: 262 })],
      },
    ]);
    noDiscovery();
    const found = await provider.findSyncedLyrics({
      title: 'Tum Hi Ho - Aashiqui 2 | Aditya Roy Kapur | Arijit Singh',
      channel: 'Arijit Singh - Topic',
    });
    assert.ok(found, 'reordered/extra artist credit must still match');
    assert.equal(found.artistName, 'Mithoon, Arijit Singh');
  });
});

// --- 6. Duration mismatch / version penalty ------------------------------------

describe('6. duration mismatch / version handling', () => {
  it('unrequested version is rejected; requested version is forgiven', async () => {
    installFetch([
      {
        match: (u) => u.includes('Lumen Dreams'),
        body: [lrcRow({ trackName: 'Lumen Dreams (slowed + reverb)', artistName: 'Night Drive', duration: 999 })],
      },
    ]);
    installSearchYouTube(async () => []);
    const plainTrack = { title: 'Lumen Dreams | Aurora Field', channel: 'Aurora Field - Topic', durationSeconds: 210 };
    assert.equal(
      await provider.findSyncedLyrics(plainTrack),
      null,
      'unrequested slowed+reverb version with no artist overlap must be rejected',
    );
    const diag = await provider.diagnoseTrack(plainTrack);
    assert.equal(diag.selected, null);
    assert.ok(
      diag.lookups.some((l) => l.candidates.some((c) => c.rejected === 'version-mismatch')),
      'expected the version-penalty rejection reason',
    );

    const asked = await provider.findSyncedLyrics({
      title: 'Lumen Dreams (slowed + reverb) | Aurora Field',
      channel: 'Aurora Field - Topic',
      durationSeconds: 999,
    });
    assert.ok(asked, 'explicitly requested version must be forgiven');
  });
});

// --- 7. Low-confidence candidate -------------------------------------------------

describe('7. low-confidence candidate', () => {
  it('insufficient title/artist overlap is rejected', async () => {
    installFetch([
      {
        match: (u) => u.includes('Lumen Dreams'),
        body: [lrcRow({ trackName: 'Midnight Carousel', artistName: 'Neon Parade', duration: 200 })],
      },
    ]);
    installSearchYouTube(async () => []);
    const track = { title: 'Lumen Dreams | Aurora Field', channel: 'Aurora Field - Topic' };
    assert.equal(await provider.findSyncedLyrics(track), null);
    const diag = await provider.diagnoseTrack(track);
    assert.equal(diag.selected, null);
    assert.ok(
      diag.lookups.some((l) => l.candidates.some((c) => c.rejected === 'no-title-artist-overlap')),
    );
  });
});

// --- 8. No-result case ------------------------------------------------------------

describe('8. no-result case', () => {
  it('returns null cleanly instead of throwing', async () => {
    installFetch([]);
    installSearchYouTube(async () => []);
    const track = { title: 'Some Unreleased Demo Track XYZ | Unknown Artist', channel: 'Random Channel' };
    assert.equal(await provider.findSyncedLyrics(track), null);
    const diag = await provider.diagnoseTrack(track);
    assert.equal(diag.selected, null);
    assert.ok(diag.lookups.length > 0, 'direct pass is still attempted');
    assert.equal(await provider.findSyncedLyrics({ title: '   ', channel: 'X' }), null);
    assert.equal(await provider.findSyncedLyrics(null), null);
  });
});

// --- 9. Provider failure --------------------------------------------------------------

describe('9. provider failure', () => {
  it('network/provider errors surface instead of returning garbage', async () => {
    installFetch([{ match: () => true, error: new Error('socket hang up') }]);
    installSearchYouTube(async () => {
      throw new Error('must not reach discovery');
    });
    await assert.rejects(
      provider.findSyncedLyrics({ title: 'Die With A Smile', channel: 'Lady Gaga - Topic' }),
      /socket hang up/,
    );

    installFetch([{ match: () => true, status: 500, body: null }]);
    await assert.rejects(
      provider.findSyncedLyrics({ title: 'Die With A Smile', channel: 'Lady Gaga - Topic' }),
      /HTTP 500/,
    );
  });
});

// --- parser link sanity (synthetic payload shape only) -------------------------------

describe('synced payload shape', () => {
  it('parser consumes the synthetic synced payload', () => {
    const lines = parseLrc(SYNTH_LRC);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startMs < lines[1].startMs);
  });
});
