'use strict';

// Search planner (Phase 6 V1). Turns a playlist Intent into a BOUNDED list
// of YouTube search strings. Never creates dozens of searches.
//
// Rules:
//   explicit languages (<=4 kept) -> one query per language:
//       "<descriptor> <Language> songs"
//   mixed (no language given)    -> generic + small default set:
//       "<descriptor> songs",
//       "<descriptor> Hindi songs", "<descriptor> English songs",
//       "<descriptor> Punjabi songs", "<descriptor> Gujarati songs"
//   context words join the descriptor: "energetic workout", "focus study".

const MAX_SEARCHES = 5;
const MAX_EXPLICIT_LANGUAGES = 4;
const RESULTS_PER_SEARCH = 8;

// Small default mixed set — bounded by design, biased to the server's most
// common languages (Hindi + English first). Easy to extend later.
const MIXED_DEFAULT_LANGUAGES = ['Hindi', 'English', 'Punjabi', 'Gujarati'];

const CONTEXT_LABEL = {
  workout: 'workout',
  study: 'study',
  'date-night': 'date night',
  party: 'party',
};

function descriptorOf(intent) {
  const parts = [];
  if (intent.mood) parts.push(intent.mood);
  if (intent.context) {
    const label = CONTEXT_LABEL[intent.context] || intent.context;
    // Avoid "party party" when mood==party and context==party.
    if (!parts.includes(label)) {
      // Avoid "energetic workout workout" style dupes: if the mood word
      // already equals the label, skip.
      parts.push(label);
    }
  }
  // "study focus" case: mood=focus + context=study -> "focus study".
  // "energetic gym" case: mood=energetic + context=workout -> keep both
  // ("energetic workout") — matches spec example.
  if (parts.length === 0) return 'songs';
  return parts.join(' ');
}

function intentToSearches(intent, opts = {}) {
  if (!intent || intent.mode !== 'playlist') {
    return intent && intent.originalQuery ? [intent.originalQuery] : [];
  }
  const maxSearches = Math.max(1, Math.min(opts.maxSearches || MAX_SEARCHES, MAX_SEARCHES));
  const descriptor = descriptorOf(intent);
  const langs = Array.isArray(intent.languages) ? intent.languages : [];

  if (langs.length === 0 || (langs.length === 1 && langs[0] === 'mixed')) {
    const queries = [`${descriptor} songs`];
    for (const L of MIXED_DEFAULT_LANGUAGES) {
      queries.push(`${descriptor} ${L} songs`);
      if (queries.length >= maxSearches) break;
    }
    return queries.slice(0, maxSearches);
  }

  const explicit = langs.filter((l) => l && l.toLowerCase() !== 'mixed').slice(0, MAX_EXPLICIT_LANGUAGES);
  if (explicit.length === 0) return [`${descriptor} songs`];
  return explicit.map((L) => `${descriptor} ${L} songs`).slice(0, maxSearches);
}

module.exports = {
  intentToSearches,
  descriptorOf,
  MAX_SEARCHES,
  MAX_EXPLICIT_LANGUAGES,
  RESULTS_PER_SEARCH,
  MIXED_DEFAULT_LANGUAGES,
};
