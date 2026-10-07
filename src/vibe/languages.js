'use strict';

// Language detection (Phase 6 V1). Canonical display name + alias list.
// Matching is TOKEN-level only — an arbitrary two-letter word is never a
// language; only these explicit aliases count.

const LANGUAGES = {
  English: ['english', 'eng', 'en'],
  Hindi: ['hindi', 'hin', 'hi'],
  Gujarati: ['gujarati', 'guj', 'gu'],
  Marathi: ['marathi', 'mar', 'mr'],
  Malayalam: ['malayalam', 'mal', 'ml'],
  Tamil: ['tamil', 'tam', 'ta'],
  Telugu: ['telugu', 'tel', 'te'],
  Punjabi: ['punjabi', 'pun', 'pa'],
  Bengali: ['bengali', 'beng', 'bn', 'bangla'],
  Kannada: ['kannada', 'kan', 'kn'],
  Korean: ['korean', 'kor', 'kr', 'kpop', 'k-pop'],
  Japanese: ['japanese', 'jpn', 'jp', 'jpop', 'j-pop'],
  Spanish: ['spanish', 'esp', 'es', 'espanol', 'español'],
  French: ['french', 'fre', 'fra', 'fr', 'francais', 'français'],
};

// Alias -> canonical lookup (lowercase).
const ALIAS_TO_LANGUAGE = {};
for (const [canonical, aliases] of Object.entries(LANGUAGES)) {
  for (const a of aliases) ALIAS_TO_LANGUAGE[a.toLowerCase()] = canonical;
}

// Very short aliases (<=2 chars) are only trusted as standalone tokens when
// the query ALSO carries a mood/context signal — resolveIntent enforces
// that by requiring a mood for vibe mode anyway. This helper just reports
// what the tokens say; intent.js decides whether to trust the result.
function detectLanguages(tokens) {
  const found = [];
  for (const t of tokens) {
    const canon = ALIAS_TO_LANGUAGE[String(t || '').toLowerCase()];
    if (canon && !found.includes(canon)) found.push(canon);
  }
  return found;
}

module.exports = { LANGUAGES, ALIAS_TO_LANGUAGE, detectLanguages };
