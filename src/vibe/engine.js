'use strict';

// Vibe engine (Phase 6 V1): intent -> bounded searches -> candidates ->
// dedup -> interleave -> Track[]. Produces NORMAL Churan track objects for
// the existing queue; creates no second queue.
//
//   buildVibePlaylist(intent, { searchYouTube, resultsPerSearch, maxTracks })

const { intentToSearches, RESULTS_PER_SEARCH } = require('./planner');
const { filterVibeCandidates } = require('./filter');

const TARGET_MIN_TRACKS = 10;
const TARGET_MAX_TRACKS = 15;

function dedupeByVideoId(candidates) {
  const seen = new Set();
  const out = [];
  for (const r of candidates || []) {
    if (!r || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// Round-robin interleave across per-bucket lists so mixed playlists are
// actually mixed (Hindi, English, Gujarati, ...), not language blocks.
// Buckets arrive already filtered+ranked best-first; dedup is by video id.
function interleaveBuckets(buckets) {
  const lists = (buckets || []).map((b) => (Array.isArray(b) ? b.slice() : []));
  const seen = new Set();
  const out = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const list of lists) {
      while (list.length > 0) {
        const r = list.shift();
        if (!r || !r.id) continue; // eslint-disable-line no-continue
        if (seen.has(r.id)) continue; // eslint-disable-line no-continue
        seen.add(r.id);
        out.push(r);
        progress = true;
        break;
      }
    }
  }
  return out;
}

function toTrack(result, requester) {
  return {
    title: result.title || 'Unknown title',
    youtubeUrl: result.url,
    durationSeconds: result.durationSeconds ?? null,
    duration: result.duration ?? null,
    channel: result.channel ?? null,
    requester: requester ? { id: requester.id, username: requester.username } : undefined,
  };
}

async function buildVibePlaylist(intent, deps = {}) {
  const searchYouTube = deps.searchYouTube || require('../youtube/search').searchYouTube;
  const resultsPerSearch = deps.resultsPerSearch || RESULTS_PER_SEARCH;
  const maxTracks = Math.max(1, Math.min(deps.maxTracks || TARGET_MAX_TRACKS, TARGET_MAX_TRACKS));
  const queries = intentToSearches(intent, { maxSearches: deps.maxSearches });

  const buckets = [];
  for (const q of queries) {
    let results = [];
    try {
      results = await searchYouTube(q, { limit: resultsPerSearch });
    } catch (err) {
      console.warn(`[Churan] Vibe search failed for "${q}":`, err.message || err);
      buckets.push([]);
      continue;
    }
    buckets.push(filterVibeCandidates(results || [], intent.originalQuery));
  }

  const mixed = interleaveBuckets(buckets);
  const picked = mixed.slice(0, maxTracks);
  return {
    queries,
    tracks: picked.map((r) => toTrack(r, deps.requester)),
    totalCandidates: buckets.reduce((n, b) => n + b.length, 0),
  };
}

module.exports = {
  buildVibePlaylist,
  interleaveBuckets,
  dedupeByVideoId,
  toTrack,
  TARGET_MIN_TRACKS,
  TARGET_MAX_TRACKS,
};
