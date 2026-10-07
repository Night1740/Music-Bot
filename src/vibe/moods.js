'use strict';

// Vibe mood vocabulary (Phase 6 V1). Rule-based, easy to extend.
// Each key maps to a list of trigger phrases (all lowercase).
// Matching is whole-phrase, case-insensitive, on the normalized query.

const MOODS = {
  happy: [
    'happy',
    'joyful',
    'cheerful',
    'feel good',
    'feelgood',
    'upbeat',
    'good vibes',
    'good mood',
  ],
  romantic: ['romantic', 'romance', 'love', 'loving', 'date night'],
  sad: [
    'sad',
    'heartbreak',
    'heartbroken',
    'melancholy',
    'cry',
    'depressed',
    'broken',
  ],
  chill: [
    'chill',
    'relax',
    'relaxed',
    'relaxing',
    'calm',
    'peaceful',
    'laid back',
    'laidback',
    'lofi',
    'lo-fi',
  ],
  energetic: [
    'energetic',
    'energy',
    'hype',
    'hyped',
    'pump',
    'pumped',
    'workout',
    'gym',
  ],
  party: ['party', 'dance', 'dancefloor', 'club', 'celebration', 'celebrate'],
  nostalgic: ['nostalgic', 'nostalgia', 'throwback', 'old memories', 'retro'],
  focus: ['focus', 'study', 'studying', 'concentration', 'deep work'],
};

// Context phrases: WHERE / WHAT the music is for. Overlaps with moods
// intentionally (e.g. "gym" implies energetic); intent.js resolves both.
const CONTEXTS = {
  workout: ['gym', 'workout', 'running', 'exercise', 'training'],
  study: ['study', 'studying', 'concentration', 'deep work', 'reading'],
  'date-night': ['date night', 'date-night', 'datenight', 'candle light', 'candlelight'],
  party: ['party', 'club', 'dancefloor', 'celebration', 'dance'],
};

// Energy/style words independent of mood.
const ENERGY_WORDS = {
  high: ['energetic', 'energy', 'hype', 'hyped', 'pump', 'pumped', 'fast', 'beast mode'],
  low: ['chill', 'calm', 'relax', 'relaxed', 'relaxing', 'peaceful', 'slow', 'soft', 'mellow'],
};

// Style words that change WHAT the recording is (used by filter forgiveness).
const STYLE_WORDS = [
  'slowed',
  'reverb',
  'sped up',
  'speed up',
  '8d',
  '9d',
  'nightcore',
  'bass boosted',
  'remix',
  'mashup',
  'cover',
  'acoustic',
  'unplugged',
  'live',
  'karaoke',
  'lofi',
  'lo-fi',
  'edit',
  'shorts',
];

// Filler words stripped before matching so natural phrasing works:
// "something energetic for the gym" -> "energetic gym".
const FILLER_WORDS = new Set(
  [
    'something',
    'some',
    'songs',
    'song',
    'music',
    'playlist',
    'playlists',
    'mix',
    'vibes',
    'vibe',
    'for',
    'the',
    'a',
    'an',
    'me',
    'my',
    'please',
    'play',
    'with',
    'of',
    'that',
    'is',
    'and',
  ],
);

module.exports = { MOODS, CONTEXTS, ENERGY_WORDS, STYLE_WORDS, FILLER_WORDS };
