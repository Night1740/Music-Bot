'use strict';

// Lyrics provider for Phase 5+: LRCLIB (https://lrclib.net).
//
// Why LRCLIB (unchanged): purpose-built synced (LRC timestamped) lyrics,
// documented public JSON API, NO api key or account, free for personal/test
// use (asks only for a descriptive User-Agent). No auth/DRM bypass, no
// audio download, plain HTTPS GET. If LRCLIB ever becomes unsuitable, only
// this file (plus resolve below) needs replacing — the parser consumes
// plain LRC text.
//
// Resolution pipeline (Hindi-robust, still bounded and deterministic):
//
//   YouTube metadata
//     → title parsing (Bollywood "Song - Movie | cast | singer" shapes,
//       Western "Artist - Song", "Movie: Song", Devanagari titles)
//     → direct LRCLIB lookup (≤3 queries)
//     → if no confident match: ONE YouTube metadata-discovery search,
//       ≤2 fresh LRCLIB queries built from alternate variants
//     → synced LRC → existing parser → existing sync engine
//
// Responsibilities: find lyrics for a track, return synchronized data,
// surface provider errors readably. Never touches Discord or playback.

const API_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'Churan/0.1.0 (Discord music bot test project; +https://github.com/)';
const FETCH_TIMEOUT_MS = 15000;
const MIN_ACCEPT_SCORE = 3;
const VERSION_PENALTY = 5;

// Suffixes that describe the VIDEO, not the song. Stripped cautiously:
// only inside trailing (...) / [...] groups, never from the bare title.
const VIDEO_SUFFIX_WORDS =
  /(official\s*(music\s*)?video|official\s*audio|official\s*lyric(al)?\s*video|lyrics?|lyric\s*video|audio|music\s*video|\bm\/v\b|\bmv\b|\bmv\b|\bhd\b|\b4k\b|topic)/i;

// Bare trailing tokens/phrases that are video packaging, not song identity.
// Singletons (song/video/audio/...) are NOT stripped here — that happens
// only at the pipe-segment level below, so "My Song" is never mangled.
const BARE_TRAILING_JUNK =
  /\s+(4k|8k|hd|hq|full\s+song|full\s+video|video\s+song|film\s+version|lyrical\s+video|lyrical|official)\s*$/i;

// Whole pipe-segments that carry no song/artist identity.
const JUNK_SEGMENT =
  /^(4k|8k|hd|hq|dolby\s+atmos|\d+\s*fps|full\s+song|full\s+video|video\s+song|film\s+version|lyrics?|audio|video|official(\s+video)?)\s*$/i;

// Channels that are labels/aggregators, not artists — never used as the
// artist hint in queries.
const LABEL_CHANNEL =
  /t-?series|sony\s*music|zee\s*music|tips|saregama|saregama|venus|eros|yrf|bhushan|lahari|aditya\s*music|think\s*music|vevo|music|films?|records|studio|official|entertainment|media|production|movies?|series|cloud|lyrics?|status|\bdj\b/i;

// Candidate version words that change WHAT the recording is. Penalized
// unless the original YouTube title asks for that version.
const VERSION_WORDS =
  /\b(lofi|lo-fi|slowed|reverb|sped\s*up|speed\s*up|8d|9d|cover|karaoke|unplugged|acoustic|live|remix|remake|mashup|\bdj\b|ringtone|tiktok|nightcore|reversed|echoed)\b/i;

const DEVANAGARI_RE = /[\u0900-\u097F]/;

function stripVideoSuffixes(title) {
  let out = String(title || '').trim();
  // Remove trailing bracket groups that are pure video descriptors.
  for (;;) {
    const m = out.match(/[\(\[]([^\(\)\[\]]+)[\)\]]\s*$/);
    if (!m || !VIDEO_SUFFIX_WORDS.test(m[1])) break;
    out = out.slice(0, m.index).trim();
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

// Split "Artist - Song" (YouTube's common Western shape) without
// destroying info.
function splitArtistTitle(clean) {
  const idx = clean.indexOf(' - ');
  if (idx > 0 && idx < clean.length - 3) {
    return { artist: clean.slice(0, idx).trim(), song: clean.slice(idx + 3).trim() };
  }
  return { artist: '', song: clean };
}

// Unicode-awareapropos tokenization: ASCII keeps the old length>2 rule,
// non-Latin scripts (Devanagari, etc.) keep length>=2 tokens — Hindi words
// like "ही" must survive as matchable tokens.
function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 || (w.length >= 2 && /[^\x00-\x7F]/.test(w)));
}

function stripBareJunk(s) {
  let out = String(s || '').trim();
  for (;;) {
    const next = out.replace(BARE_TRAILING_JUNK, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function splitNames(s) {
  return String(s || '')
    .split(/[,，、&]/)
    .flatMap((p) => p.split(/\s+and\s+/i))
    .map((p) => p.trim().replace(/^(ft|feat|featuring)\.?\s+/i, '').trim())
    .filter((p) => p.length > 1);
}

// Artist hint from the channel: "X - Topic" is artist-owned; labels and
// generic/aggregator channels are rejected (they poison queries).
function channelArtist(channel) {
  const ch = String(channel || '').trim();
  if (!ch) return '';
  const topic = ch.match(/^(.*?)\s*-\s*Topic\s*$/i);
  if (topic && topic[1].trim()) return topic[1].trim();
  if (LABEL_CHANNEL.test(ch)) return '';
  return ch;
}

// Parse Bollywood/Western/Devanagari YouTube title shapes into song parts.
// Never throws; unknown shapes degrade to { song: whole title }.
function parseYouTubeTitle(title, channel) {
  const raw = String(title || '').trim();
  const segments = raw
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s && !JUNK_SEGMENT.test(s));
  const first = stripBareJunk(stripVideoSuffixes(segments[0] || raw));
  const artists = [];
  let song = first;
  let movie = '';

  // "Song (ft. X)" credits belong to artists, not the song title.
  const feat = first.match(/\((?:ft|feat|featuring)\.?\s*([^()]+)\)\s*$/i);
  let head = first;
  if (feat) {
    artists.push(...splitNames(feat[1]));
    head = first.slice(0, feat.index).trim();
  }

  const hasPipes = segments.length > 1;
  const dash = head.indexOf(' - ');
  if (hasPipes && dash > 0 && dash < head.length - 3) {
    // Bollywood official shape: "Kesariya - Brahmāstra | cast | singer…"
    song = head.slice(0, dash).trim();
    movie = head.slice(dash + 3).trim();
    for (const seg of segments.slice(1)) artists.push(...splitNames(seg));
  } else if (!hasPipes && dash > 0 && dash < head.length - 3 && !DEVANAGARI_RE.test(head)) {
    // Western shape: "Lady Gaga, Bruno Mars - Die With A Smile"
    const west = splitArtistTitle(head);
    artists.push(...splitNames(west.artist));
    song = west.song;
  } else {
    const colon = head.match(/^(.+?)\s*:\s*(.+)$/);
    if (colon && colon[2].trim()) {
      // "Aashiqui 2: Tum Hi Ho 8K Full Song" (bare junk already stripped)
      movie = colon[1].trim();
      song = colon[2].trim();
      for (const seg of segments.slice(1)) artists.push(...splitNames(seg));
    } else {
      song = head;
      for (const seg of segments.slice(1)) artists.push(...splitNames(seg));
    }
  }

  song = stripBareJunk(song);
  const chArtist = channelArtist(channel);
  if (chArtist) artists.push(chArtist);
  const seen = new Set();
  const deduped = artists.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    song,
    movie,
    artists: deduped,
    channelArtist: chArtist,
    hasDevanagari: DEVANAGARI_RE.test(song),
    clean: first,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(1000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if ((res.status === 502 || res.status === 503) && attempt === 0) {
        lastErr = new Error(`Lyrics provider responded with HTTP ${res.status}.`);
        continue; // transient overload: single retry
      }
      if (res.status === 429) throw new Error('Lyrics provider is rate-limiting right now.');
      if (!res.ok) throw new Error(`Lyrics provider responded with HTTP ${res.status}.`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Lyrics provider timed out.');
      if (/^Lyrics provider (responded|is rate)/.test(err.message)) throw err;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function toCandidate(r) {
  return {
    id: r.id ?? null,
    trackName: r.trackName || r.name || null,
    artistName: r.artistName || null,
    duration: typeof r.duration === 'number' ? r.duration : null,
    instrumental: r.instrumental === true,
    syncedLrc: typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim() ? r.syncedLyrics : null,
  };
}

async function searchRaw(query) {
  const data = await fetchJson(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
  return (Array.isArray(data) ? data : []).map(toCandidate);
}

function versionPenalty(candidateTitle, queryWords) {
  const m = String(candidateTitle || '').match(VERSION_WORDS);
  if (!m) return 0;
  const flagged = m[1].toLowerCase().replace(/\s+/g, ' ');
  // Forgiven when the original request names that version ("… live").
  for (const w of queryWords) {
    if (flagged.includes(w) || w.includes(flagged.replace(/\s+/g, ''))) return 0;
  }
  return VERSION_PENALTY;
}

function scoreDetail(c, songWords, artistWords, durationSeconds, queryWords) {
  if (!c.syncedLrc) return { score: -Infinity, titleHits: 0, artistHits: 0, reason: 'no-synced-lyrics' };
  if (c.instrumental) return { score: -Infinity, titleHits: 0, artistHits: 0, reason: 'instrumental' };
  const titleWords = new Set(wordsOf(c.trackName));
  const candArtistWords = new Set(wordsOf(c.artistName));
  let titleHits = 0;
  for (const w of songWords) if (titleWords.has(w)) titleHits += 1;
  let artistHits = 0;
  for (const w of artistWords) if (candArtistWords.has(w)) artistHits += 1;
  if (titleHits === 0 && artistHits === 0) {
    return { score: -Infinity, titleHits, artistHits, reason: 'no-title-artist-overlap' };
  }
  let score = titleHits * 3 + artistHits * 2;
  if (typeof durationSeconds === 'number' && typeof c.duration === 'number') {
    const diff = Math.abs(durationSeconds - c.duration);
    if (diff <= 5) score += 2;
    else if (diff <= 12) score += 1;
  }
  const penalty = versionPenalty(c.trackName, queryWords);
  score -= penalty;
  if (score < MIN_ACCEPT_SCORE) {
    return { score, titleHits, artistHits, reason: penalty > 0 ? 'version-mismatch' : 'below-threshold' };
  }
  return { score, titleHits, artistHits, reason: penalty > 0 ? 'scored-penalized' : 'scored' };
}

function scoreCandidate(c, songWords, artistWords, durationSeconds, queryWords) {
  return scoreDetail(c, songWords, artistWords, durationSeconds, queryWords).score;
}

// Direct-pass queries from parsed metadata (≤3, most specific first).
function directQueries(parsed) {
  const out = [];
  const push = (q) => {
    const t = String(q || '').replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  if (parsed.song && parsed.movie) push(`${parsed.song} ${parsed.movie}`);
  if (parsed.song && parsed.artists.length > 0) push(`${parsed.song} ${parsed.artists.slice(0, 2).join(' ')}`);
  else if (parsed.song && parsed.channelArtist) push(`${parsed.song} ${parsed.channelArtist}`);
  if (parsed.song) push(parsed.song);
  return out.slice(0, 3);
}

function scoringContext(track, parsed) {
  const songWords = wordsOf(parsed.song);
  const artistWords = wordsOf([...parsed.artists, parsed.movie].filter(Boolean).join(' '));
  const queryWords = wordsOf([parsed.song, parsed.movie, ...parsed.artists].join(' '));
  const durationSeconds =
    typeof track?.durationSeconds === 'number' ? track.durationSeconds : null;
  return { songWords, artistWords, queryWords, durationSeconds };
}

function pickBest(candidates, ctx) {
  let best = null;
  let bestScore = -Infinity;
  const rows = [];
  for (const c of candidates) {
    const d = scoreDetail(c, ctx.songWords, ctx.artistWords, ctx.durationSeconds, ctx.queryWords);
    rows.push({
      trackName: c.trackName,
      artistName: c.artistName,
      duration: c.duration,
      hasSynced: !!c.syncedLrc,
      instrumental: c.instrumental,
      titleHits: d.titleHits,
      artistHits: d.artistHits,
      score: d.score,
      rejected: d.reason,
    });
    if (d.score > bestScore) {
      best = c;
      bestScore = d.score;
    }
  }
  return { best: bestScore >= MIN_ACCEPT_SCORE ? best : null, bestScore, rows };
}

async function runDirect(track, parsed) {
  const ctx = scoringContext(track, parsed);
  const lookups = [];
  let selected = null;
  for (const q of directQueries(parsed)) {
    const candidates = await searchRaw(q);
    const entry = { query: q, status: 'ok', candidateCount: candidates.length, candidates: [] };
    const { best, rows } = pickBest(candidates, ctx);
    entry.candidates = rows.slice(0, 8);
    lookups.push(entry);
    if (best) {
      selected = best;
      break; // first qualifying query wins (fewer requests)
    }
  }
  return { selected, lookups };
}

// Discovery pass: when direct lookup fails, ask YouTube (already in the
// project — no new services, no scraping) for alternate metadata variants:
// romanized titles for Devanagari uploads, cleaner lyric-video titles,
// singer-owned "- Topic" channels. ONE yt-dlp search, ≤2 fresh LRCLIB
// queries, all deterministic.
async function runDiscovery(track, parsed, triedQueries) {
  const { searchYouTube } = require('../youtube/search');
  const core = parsed.song || stripVideoSuffixes(track?.title);
  const summary = { ytQuery: core || null, ytTitles: [], lookups: [] };
  if (!core) return { selected: null, ...summary };
  let ytResults;
  try {
    ytResults = await searchYouTube(core, { limit: 5 });
  } catch (err) {
    console.warn(`[Churan] Lyrics discovery search failed: ${err.message || err}`);
    return { selected: null, ...summary };
  }
  const ctx = scoringContext(track, parsed);
  // Each fresh query is scored with the context of the ALTERNATE (usually
  // romanized) parse that produced it — NOT the original parse. The original
  // parse may be Devanagari (e.g. "केसरिया") while LRCLIB indexes romanized
  // titles ("Kesariya"); scoring romanized candidates against Devanagari
  // tokens yields zero overlap and rejects the correct match. Thresholds
  // are unchanged — only the word sets come from the alt metadata.
  const fresh = [];
  const freshCtx = [];
  for (const r of ytResults.slice(0, 3)) {
    const alt = parseYouTubeTitle(r.title, r.channel);
    const altCtx = scoringContext(track, alt);
    const shapes = [];
    if (alt.song) shapes.push(alt.song);
    // Same priority as directQueries: song+movie first (the stable
    // Bollywood key); song+cast queries often return zero LRCLIB rows and
    // would waste the ≤2 fresh-query budget.
    if (alt.song && alt.movie) shapes.push(`${alt.song} ${alt.movie}`);
    if (alt.song && alt.artists.length > 0) shapes.push(`${alt.song} ${alt.artists.slice(0, 2).join(' ')}`);
    summary.ytTitles.push({ title: r.title, channel: r.channel });
    for (const s of shapes) {
      const t = s.replace(/\s+/g, ' ').trim();
      if (t && !triedQueries.has(t.toLowerCase()) && !fresh.includes(t)) {
        fresh.push(t);
        freshCtx.push(altCtx);
      }
      if (fresh.length >= 2) break;
    }
    if (fresh.length >= 2) break;
  }
  let selected = null;
  for (let i = 0; i < fresh.length; i += 1) {
    const q = fresh[i];
    triedQueries.add(q.toLowerCase());
    const candidates = await searchRaw(q);
    const entry = { query: q, status: 'ok', candidateCount: candidates.length, candidates: [] };
    const { best, rows } = pickBest(candidates, freshCtx[i] || ctx);
    entry.candidates = rows.slice(0, 8);
    summary.lookups.push(entry);
    if (best) {
      selected = best;
      break;
    }
  }
  return { selected, ...summary };
}

// Find the best SYNCED lyrics for a track. `track` is the existing queue
// metadata: { title, channel, durationSeconds }. Same contract as before:
// candidate object or null. Direct lookup first, bounded discovery second.
async function findSyncedLyrics(track) {
  if (!track?.title?.trim()) return null;
  const parsed = parseYouTubeTitle(track.title, track.channel);
  if (!parsed.song) return null;
  const tried = new Set();
  const direct = await runDirect(track, parsed);
  for (const lu of direct.lookups) tried.add(lu.query.toLowerCase());
  if (direct.selected) return direct.selected;
  const disco = await runDiscovery(track, parsed, tried);
  return disco.selected;
}

// Metadata-only diagnosis of WHY a track does or doesn't match. Returns
// titles, artists, durations, scores and rejection reasons — NEVER lyric
// text. Used by diagnostics and regression tests.
async function diagnoseTrack(track) {
  const report = {
    input: {
      title: track?.title || null,
      channel: track?.channel || null,
      durationSeconds: typeof track?.durationSeconds === 'number' ? track.durationSeconds : null,
    },
    normalized: null,
    lookups: [],
    discovery: null,
    selected: null,
  };
  if (!track?.title?.trim()) {
    report.normalized = { empty: true };
    return report;
  }
  const parsed = parseYouTubeTitle(track.title, track.channel);
  report.normalized = {
    song: parsed.song,
    movie: parsed.movie,
    artists: parsed.artists,
    channelArtist: parsed.channelArtist,
    hasDevanagari: parsed.hasDevanagari,
    queries: directQueries(parsed),
  };
  if (!parsed.song) return report;
  const direct = await runDirect(track, parsed);
  report.lookups = direct.lookups;
  const tried = new Set(direct.lookups.map((lu) => lu.query.toLowerCase()));
  if (direct.selected) {
    report.selected = {
      trackName: direct.selected.trackName,
      artistName: direct.selected.artistName,
      score: 'direct',
    };
    return report;
  }
  try {
    const disco = await runDiscovery(track, parsed, tried);
    report.discovery = {
      ytQuery: disco.ytQuery,
      ytTitles: disco.ytTitles,
      lookups: disco.lookups,
    };
    if (disco.selected) {
      report.selected = {
        trackName: disco.selected.trackName,
        artistName: disco.selected.artistName,
        score: 'discovery',
      };
    }
  } catch (err) {
    report.discovery = { error: err.message };
  }
  return report;
}

module.exports = {
  findSyncedLyrics,
  diagnoseTrack,
  // Exported for unit tests:
  stripVideoSuffixes,
  splitArtistTitle,
  parseYouTubeTitle,
  channelArtist,
};
