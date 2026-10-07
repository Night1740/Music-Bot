'use strict';

// LRC parser/normalizer for Phase 5. Converts provider LRC text into the
// internal synced-lyrics format:
//
//   [ { startMs: 4200, text: "I found a love for me" }, ... ]
//
// sorted ascending by startMs. The rest of the bot only ever sees this
// shape — never raw provider output.

const TAG_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
const META_RE = /^\[(ar|ti|al|au|by|offset|length|re|ve):/i;

function tagToMs(min, sec, frac) {
  const minutes = parseInt(min, 10);
  const seconds = parseInt(sec, 10);
  let ms = 0;
  if (frac !== undefined) {
    // LRC standard is hundredths; some files use milliseconds.
    ms = frac.length === 3 ? parseInt(frac, 10) : parseInt(frac, 10) * 10;
  }
  return minutes * 60000 + seconds * 1000 + ms;
}

function parseOffsetMs(line) {
  const m = line.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
  return m ? parseInt(m[1], 10) : 0;
}

function parseLrc(text) {
  const lines = [];
  if (typeof text !== 'string' || !text.trim()) return lines;

  let offsetMs = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[offset:/i.test(line)) {
      const off = parseOffsetMs(line);
      if (Number.isFinite(off)) offsetMs = off;
      continue;
    }
    if (META_RE.test(line)) continue;

    TAG_RE.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = TAG_RE.exec(line)) !== null) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      if (Number.isFinite(mm) && Number.isFinite(ss) && ss < 60) {
        stamps.push(tagToMs(m[1], m[2], m[3]));
      }
    }
    if (stamps.length === 0) continue; // untagged line: not synced data

    const lyric = line.replace(TAG_RE, '').trim();
    if (!lyric) continue; // timestamp-only separator lines carry no text
    for (const t of stamps) {
      lines.push({ startMs: t + offsetMs, text: lyric });
    }
  }

  lines.sort((a, b) => a.startMs - b.startMs);
  return lines.filter((l) => l.startMs >= 0);
}

module.exports = { parseLrc };
