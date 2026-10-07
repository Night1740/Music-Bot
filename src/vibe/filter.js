'use strict';

// Candidate filtering for vibe playlists (Phase 6 V1).
// Reuses the philosophy of src/youtube/select.js (prefer official, proper
// songs, reasonable duration) plus junk rejection for playlist mode.
//
// Reject (unless the original query explicitly asks for that style):
//   slowed, reverb, 8d/9d, sped up, nightcore, bass boosted, remix, edit,
//   mashup, shorts, compilations, over-long mixes, live streams, too-short clips.
//
// Prefer: verified channel, sane duration (90s–480s), decent views.

const JUNK_PATTERNS = [
  /slowed/i,
  /reverb/i,
  /\b8d\b/i,
  /\b9d\b/i,
  /sped\s*up/i,
  /speed\s*up/i,
  /nightcore/i,
  /bass\s*boost/i,
  /\bremix\b/i,
  /\bmashup\b/i,
  /\bcover\b/i,
  /\bkaraoke\b/i,
  /\bshorts\b/i,
  /#shorts/i,
  /\bcompilation\b/i,
  /\bplaylist\b/i,
  /\bmix\b.*\b\d+\s*(songs|min)/i,
  /top\s+\d+/i,
  /\b\d+\s*[-–]\s*\d+\s*songs\b/i,
  /\b(edit|edits)\b/i,
  /\b1\s*hour\b/i,
  /\b3\s*hours?\b/i,
  /\b10\s*hours?\b/i,
  /loop/i,
  /tiktok/i,
];

const MIN_SECONDS = 60;
const MAX_SECONDS = 600; // hard reject: compilations / mixes live above this
const PREFERRED_MIN = 90;
const PREFERRED_MAX = 480;

function normalizeLower(s) {
  return String(s || '').toLowerCase();
}

function wantsStyle(originalQuery, junkHit) {
  if (!junkHit) return false;
  const q = normalizeLower(originalQuery);
  // If the query names the style, forgive that style: extract the matched
  // word and check the query contains it.
  const m = String(junkHit).replace(/[\\/.*+?^${}()|[\]]/g, '');
  void m;
  // Simple approach: if any junk pattern matches the QUERY too, forgive.
  for (const p of JUNK_PATTERNS) {
    // Reset lastIndex for global patterns (none are global, but safe).
    p.lastIndex = 0;
    if (p.test(q)) return true;
  }
  return false;
}

function junkHitFor(title) {
  const t = String(title || '');
  for (const p of JUNK_PATTERNS) {
    p.lastIndex = 0;
    if (p.test(t)) return p;
  }
  return null;
}

function isLiveResult(r) {
  const s = normalizeLower(r && r.live);
  return s === 'is_live' || s === 'is_upcoming' || s === 'live';
}

function durationOf(r) {
  return typeof r.durationSeconds === 'number' ? r.durationSeconds : null;
}

// Returns { ok, reason } — ok=false means reject.
function judgeCandidate(r, originalQuery) {
  if (!r || !r.id || !r.url) return { ok: false, reason: 'missing-id-url' };
  if (isLiveResult(r)) return { ok: false, reason: 'live' };
  const hit = junkHitFor(r.title);
  if (hit && !wantsStyle(originalQuery, hit)) return { ok: false, reason: 'junk-title' };
  const d = durationOf(r);
  if (d !== null) {
    if (d < MIN_SECONDS) return { ok: false, reason: 'too-short' };
    if (d > MAX_SECONDS) return { ok: false, reason: 'too-long' };
  }
  return { ok: true, reason: 'ok' };
}

function scoreVibeCandidate(r) {
  let score = 0;
  if (r.channelVerified) score += 2;
  const d = durationOf(r);
  if (d !== null && d >= PREFERRED_MIN && d <= PREFERRED_MAX) score += 1;
  const views = typeof r.viewCount === 'number' ? r.viewCount : 0;
  score += Math.min(1, Math.log10(views + 1) / 10);
  return score;
}

// Filter + rank one bucket of results. Returns accepted candidates best-first.
function filterVibeCandidates(results, originalQuery) {
  const accepted = [];
  for (const r of results || []) {
    const j = judgeCandidate(r, originalQuery);
    if (!j.ok) continue;
    accepted.push({ result: r, score: scoreVibeCandidate(r) });
  }
  accepted.sort((a, b) => b.score - a.score);
  return accepted.map((e) => e.result);
}

module.exports = {
  filterVibeCandidates,
  judgeCandidate,
  scoreVibeCandidate,
  JUNK_PATTERNS,
  MIN_SECONDS,
  MAX_SECONDS,
  PREFERRED_MIN,
  PREFERRED_MAX,
};
