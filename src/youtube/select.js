'use strict';

// Pick the most sensible video from YouTube search results (Phase 4C).
// Deliberately a small heuristic, NOT a recommendation engine:
//
//   +3 per significant query word found in the title
//   +2 for a verified channel (official uploads)
//   +1 for non-live videos (unless the query asks for live)
//   +small view-count tiebreak (log scale, capped)
//
// Search order wins remaining ties (YouTube already ranked them).

function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

function isLiveResult(r) {
  const s = String(r.live || '').toLowerCase();
  return s === 'is_live' || s === 'is_upcoming' || s === 'live';
}

function scoreResult(r, queryWords, wantsLive) {
  const titleWords = new Set(wordsOf(r.title));
  let hits = 0;
  for (const w of queryWords) {
    if (titleWords.has(w)) hits += 1;
  }
  let score = hits * 3;
  if (r.channelVerified) score += 2;
  if (!wantsLive && !isLiveResult(r)) score += 1;
  if (wantsLive && isLiveResult(r)) score += 2;
  const views = typeof r.viewCount === 'number' ? r.viewCount : 0;
  score += Math.min(1, Math.log10(views + 1) / 10);
  return score;
}

function selectBestResult(results, query) {
  const list = (results || []).filter((r) => r && r.id && r.url);
  if (list.length === 0) return null;

  const q = String(query || '');
  const wantsLive = /live\s?(stream)?|livestream|live version/i.test(q);
  const queryWords = wordsOf(q);

  let pool = list;
  if (wantsLive) {
    const lives = list.filter(isLiveResult);
    if (lives.length > 0) pool = lives;
  } else {
    const nonLive = list.filter((r) => !isLiveResult(r));
    // Only filter lives out when something remains; never fail just
    // because every candidate is a stream.
    if (nonLive.length > 0) pool = nonLive;
  }

  let best = pool[0];
  let bestScore = -Infinity;
  for (const r of pool) {
    const s = scoreResult(r, queryWords, wantsLive);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

module.exports = { selectBestResult };
