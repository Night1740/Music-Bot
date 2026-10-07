'use strict';

// Intent resolver (Phase 6 V1). Deterministic, local, no LLM.
//
//   "/play <query>" -> Intent
//     { mode, mood, languages, context, energy, originalQuery }
//
// mode is "playlist" only when the query carries a mood/context/energy
// signal. Anything else (including unknown song titles) stays "song" so
// exact-song behavior never breaks.

const { MOODS, CONTEXTS, ENERGY_WORDS, FILLER_WORDS } = require('./moods');
const { detectLanguages } = require('./languages');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(norm) {
  return norm.split(' ').filter(Boolean);
}

function stripFillers(tokens) {
  return tokens.filter((t) => !FILLER_WORDS.has(t));
}

// Whole-phrase match against normalized text with word boundaries.
function phraseHit(normPadded, phrase) {
  return normPadded.includes(` ${phrase} `);
}

function detectMood(normPadded) {
  // Longest phrases first so "date night" beats "love"-style collisions
  // and "deep work" beats generic "work".
  const entries = [];
  for (const [mood, phrases] of Object.entries(MOODS)) {
    for (const p of phrases) entries.push({ mood, phrase: p.toLowerCase() });
  }
  entries.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const { mood, phrase } of entries) {
    if (phraseHit(normPadded, phrase.toLowerCase())) return { mood, matched: phrase };
  }
  return { mood: null, matched: null };
}

function detectContext(normPadded) {
  const entries = [];
  for (const [ctx, phrases] of Object.entries(CONTEXTS)) {
    for (const p of phrases) entries.push({ ctx, phrase: p.toLowerCase() });
  }
  entries.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const { ctx, phrase } of entries) {
    if (phraseHit(normPadded, phrase.toLowerCase())) return { context: ctx, matched: phrase };
  }
  return { context: null, matched: null };
}

function detectEnergy(normPadded) {
  for (const w of ENERGY_WORDS.high) {
    if (phraseHit(normPadded, w.toLowerCase())) return 'high';
  }
  for (const w of ENERGY_WORDS.low) {
    if (phraseHit(normPadded, w.toLowerCase())) return 'low';
  }
  return null;
}

function resolveIntent(rawQuery) {
  const originalQuery = String(rawQuery || '').trim();
  const norm = normalize(originalQuery);
  const padded = ` ${norm} `;
  const tokens = tokenize(norm);

  const { mood } = detectMood(padded);
  const { context } = detectContext(padded);
  const energy = detectEnergy(padded);

  // Languages: token-level alias match. Multi-word languages are single
  // tokens here, so token match suffices. Also try joined-phrase fallback
  // for safety (harmless for the current single-word list).
  let languages = detectLanguages(tokens);
  // "k-pop"/"j-pop" contain a hyphen; normalize() keeps hyphens, tokenize
  // splits on spaces only, so "k-pop" survives as one token already.

  const hasVibeSignal = !!(mood || context || energy);

  if (!hasVibeSignal) {
    return {
      mode: 'song',
      mood: null,
      languages: [],
      context: null,
      energy: null,
      originalQuery,
    };
  }

  // Vibe mode. No language specified -> intentional mixed (never default
  // to English).
  if (languages.length === 0) languages = ['mixed'];

  // Derive energy from mood when not explicitly stated: energetic/party
  // moods imply high energy; chill/focus/sad imply low. Romantic/n happy
  // stay null (neutral) unless the words say otherwise.
  let resolvedEnergy = energy;
  if (!resolvedEnergy) {
    if (mood === 'energetic' || mood === 'party') resolvedEnergy = 'high';
    else if (mood === 'chill' || mood === 'focus' || mood === 'sad') resolvedEnergy = 'low';
  }

  // Deduplicate mood/context overlap: e.g. "gym" triggers both energetic
  // mood and workout context — that is fine, keep both.
  void stripFillers; // documented helper for planner-side reuse

  return {
    mode: 'playlist',
    mood,
    languages,
    context,
    energy: resolvedEnergy,
    originalQuery,
  };
}

module.exports = { resolveIntent, normalize, tokenize };
