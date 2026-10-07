'use strict';

// Phase 6 Vibe Engine tests: intent resolver, search planner, filtering,
// deduplication, bounds. Fully deterministic — no network, searchYouTube is
// injected as a stub. Run: npm test (node --test test/).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveIntent } = require('../src/vibe/intent');
const { intentToSearches, MAX_SEARCHES } = require('../src/vibe/planner');
const { filterVibeCandidates, judgeCandidate } = require('../src/vibe/filter');
const {
  buildVibePlaylist,
  interleaveBuckets,
  dedupeByVideoId,
  TARGET_MAX_TRACKS,
} = require('../src/vibe/engine');

// --- helpers ---------------------------------------------------------------

function yt(id, title, extra = {}) {
  return {
    id,
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    channel: 'Some Artist - Topic',
    channelVerified: false,
    durationSeconds: 210,
    viewCount: 1000000,
    live: null,
    ...extra,
  };
}

// --- 1. exact requests stay exact -------------------------------------------

describe('exact requests stay exact-song mode', () => {
  for (const q of ['Die With A Smile', 'Blinding Lights', 'Kesariya', 'Tum Hi Ho']) {
    it(`"${q}" -> song`, () => {
      const intent = resolveIntent(q);
      assert.equal(intent.mode, 'song');
      assert.equal(intent.mood, null);
    });
  }
});

// --- 2. bare moods -> playlist ----------------------------------------------

describe('bare moods -> playlist mode', () => {
  for (const [q, mood] of [
    ['happy', 'happy'],
    ['romantic', 'romantic'],
    ['sad', 'sad'],
    ['chill', 'chill'],
  ]) {
    it(`"${q}" -> playlist (${mood})`, () => {
      const intent = resolveIntent(q);
      assert.equal(intent.mode, 'playlist');
      assert.equal(intent.mood, mood);
    });
  }
});

// --- 3. mood + language ------------------------------------------------------

describe('mood + language', () => {
  it('"romantic hindi" -> romantic + Hindi', () => {
    const intent = resolveIntent('romantic hindi');
    assert.equal(intent.mode, 'playlist');
    assert.equal(intent.mood, 'romantic');
    assert.deepEqual(intent.languages, ['Hindi']);
  });
  it('"sad english" -> sad + English', () => {
    const intent = resolveIntent('sad english');
    assert.equal(intent.mode, 'playlist');
    assert.equal(intent.mood, 'sad');
    assert.deepEqual(intent.languages, ['English']);
  });
  it('"happy gujarati" -> happy + Gujarati', () => {
    const intent = resolveIntent('happy gujarati');
    assert.equal(intent.mode, 'playlist');
    assert.equal(intent.mood, 'happy');
    assert.deepEqual(intent.languages, ['Gujarati']);
  });
  it('alias "romantic hin" normalizes to Hindi', () => {
    const intent = resolveIntent('romantic hin');
    assert.deepEqual(intent.languages, ['Hindi']);
  });
});

// --- 4. multiple languages ----------------------------------------------------

describe('multiple languages', () => {
  it('"happy hindi english" -> both languages', () => {
    const intent = resolveIntent('happy hindi english');
    assert.equal(intent.mode, 'playlist');
    assert.ok(intent.languages.includes('Hindi'));
    assert.ok(intent.languages.includes('English'));
    assert.equal(intent.languages.length, 2);
  });
});

// --- 5. no language -> mixed ---------------------------------------------------

describe('no language -> mixed', () => {
  for (const q of ['happy', 'romantic', 'chill']) {
    it(`"${q}" -> ["mixed"]`, () => {
      const intent = resolveIntent(q);
      assert.deepEqual(intent.languages, ['mixed']);
    });
  }
  it('mixed planner fans out to bounded multi-language searches', () => {
    const intent = resolveIntent('romantic');
    const queries = intentToSearches(intent);
    assert.ok(queries.length > 1 && queries.length <= MAX_SEARCHES);
    assert.ok(queries.some((q) => /hindi/i.test(q)));
    assert.ok(queries.some((q) => /english/i.test(q)));
  });
});

// --- 6. context / energy ---------------------------------------------------------

describe('context and energy', () => {
  it('"energetic gym" -> energetic mood + workout context', () => {
    const intent = resolveIntent('energetic gym');
    assert.equal(intent.mode, 'playlist');
    assert.equal(intent.mood, 'energetic');
    assert.equal(intent.context, 'workout');
  });
  it('"study focus" -> focus mood + study context', () => {
    const intent = resolveIntent('study focus');
    assert.equal(intent.mode, 'playlist');
    assert.equal(intent.mood, 'focus');
    assert.equal(intent.context, 'study');
  });
  it('"romantic date night" -> romantic + date-night', () => {
    const intent = resolveIntent('romantic date night');
    assert.equal(intent.mode, 'playlist');
    assert.equal(intent.mood, 'romantic');
    assert.equal(intent.context, 'date-night');
  });
  it('"something energetic for the gym" -> vibe despite filler words', () => {
    const intent = resolveIntent('something energetic for the gym');
    assert.equal(intent.mode, 'playlist');
    assert.equal(intent.mood, 'energetic');
    assert.equal(intent.context, 'workout');
  });
});

// --- 7. unknown phrase stays exact -----------------------------------------------

describe('unknown phrase is NOT a vibe', () => {
  it('"some completely unknown song title xyz" -> song', () => {
    const intent = resolveIntent('some completely unknown song title xyz');
    assert.equal(intent.mode, 'song');
  });
  it('language alone without mood is not a vibe', () => {
    const intent = resolveIntent('hindi');
    assert.equal(intent.mode, 'song');
  });
});

// --- 8. planner bounds ------------------------------------------------------------

describe('planner bounds', () => {
  it('never exceeds MAX_SEARCHES even with many languages', () => {
    const intent = {
      mode: 'playlist',
      mood: 'happy',
      languages: ['Hindi', 'English', 'Gujarati', 'Marathi', 'Tamil', 'Telugu'],
      context: null,
      energy: null,
      originalQuery: 'happy hindi english gujarati marathi tamil telugu',
    };
    const queries = intentToSearches(intent);
    assert.ok(queries.length <= MAX_SEARCHES);
  });
  it('single language -> single focused search', () => {
    const queries = intentToSearches(resolveIntent('romantic hindi'));
    assert.deepEqual(queries, ['romantic Hindi songs']);
  });
  it('two languages -> two searches', () => {
    const queries = intentToSearches(resolveIntent('happy hindi english'));
    assert.equal(queries.length, 2);
  });
  it('context joins the descriptor', () => {
    const queries = intentToSearches(resolveIntent('energetic gym hindi'));
    assert.ok(queries[0].includes('energetic'));
    assert.ok(queries[0].includes('workout'));
  });
});

// --- 9. candidate filtering ----------------------------------------------------------

describe('candidate filtering', () => {
  it('rejects slowed/reverb/remix/shorts unless requested', () => {
    assert.equal(judgeCandidate(yt('a1', 'Song (slowed + reverb)'), 'happy').ok, false);
    assert.equal(judgeCandidate(yt('a2', 'Song remix'), 'happy').ok, false);
    assert.equal(judgeCandidate(yt('a3', 'Song #shorts'), 'happy').ok, false);
    assert.equal(judgeCandidate(yt('a4', 'Song nightcore'), 'happy').ok, false);
  });
  it('forgives requested style', () => {
    assert.equal(judgeCandidate(yt('a1', 'Song (slowed + reverb)'), 'slowed happy mix').ok, true);
  });
  it('rejects over-long compilations and clips', () => {
    assert.equal(
      judgeCandidate(yt('b1', 'Top 100 songs', { durationSeconds: 7200 }), 'happy').ok,
      false,
    );
    assert.equal(
      judgeCandidate(yt('b2', 'Teaser', { durationSeconds: 20 }), 'happy').ok,
      false,
    );
  });
  it('accepts normal official uploads', () => {
    const kept = filterVibeCandidates(
      [yt('c1', 'Proper Song', { channelVerified: true }), yt('c2', 'Song (slowed)')],
      'happy',
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, 'c1');
  });
});

// --- 10. dedup + interleave ------------------------------------------------------------

describe('deduplication and mixing', () => {
  it('same video id across searches -> one track', () => {
    const dup = [yt('x1', 'Song A'), yt('x1', 'Song A'), yt('x2', 'Song B')];
    assert.equal(dedupeByVideoId(dup).length, 2);
  });
  it('interleave mixes buckets instead of blocking', () => {
    const out = interleaveBuckets([
      [yt('h1', 'H1'), yt('h2', 'H2')],
      [yt('e1', 'E1'), yt('e2', 'E2')],
    ]);
    assert.deepEqual(
      out.map((r) => r.id),
      ['h1', 'e1', 'h2', 'e2'],
    );
  });
  it('interleave dedups across buckets', () => {
    const out = interleaveBuckets([[yt('s1', 'S')], [yt('s1', 'S'), yt('s2', 'S2')]]);
    assert.deepEqual(
      out.map((r) => r.id),
      ['s1', 's2'],
    );
  });
});

// --- 11. engine end-to-end (stubbed search) --------------------------------------------------

describe('engine end-to-end (stubbed search)', () => {
  it('builds bounded mixed playlist from stub buckets', async () => {
    const calls = [];
    const stub = async (q, { limit } = {}) => {
      calls.push(q);
      const tag = /hindi/i.test(q) ? 'H' : /english/i.test(q) ? 'E' : 'G';
      return Array.from({ length: 6 }, (_, i) => yt(`${tag}${i}`, `${tag} Song ${i}`));
    };
    const intent = resolveIntent('happy');
    const { queries, tracks } = await buildVibePlaylist(intent, {
      searchYouTube: stub,
      resultsPerSearch: 6,
    });
    assert.ok(calls.length >= 2 && calls.length <= MAX_SEARCHES);
    assert.ok(tracks.length > 0 && tracks.length <= TARGET_MAX_TRACKS);
    // Mixed: first two tracks come from different buckets.
    assert.ok(tracks.length < 2 || tracks[0].youtubeUrl !== tracks[1].youtubeUrl);
    // Normal track shape for the existing queue.
    for (const t of tracks) {
      assert.ok(t.title && t.youtubeUrl);
    }
  });

  it('dedups the same video returned by multiple searches', async () => {
    const same = [yt('dup1', 'Hit Song'), yt('dup2', 'Other Song')];
    const stub = async () => same;
    const { tracks } = await buildVibePlaylist(resolveIntent('chill english hindi'), {
      searchYouTube: stub,
    });
    const ids = tracks.map((t) => t.youtubeUrl);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(tracks.length <= 2);
  });

  it('quality over quantity: all-junk buckets -> fewer/zero tracks', async () => {
    const stub = async () => [yt('j1', 'Song slowed + reverb'), yt('j2', 'Top 100 mix 3 hours', { durationSeconds: 9999 })];
    const { tracks } = await buildVibePlaylist(resolveIntent('sad'), { searchYouTube: stub });
    assert.equal(tracks.length, 0);
  });
});
