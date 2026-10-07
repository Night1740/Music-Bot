'use strict';

// Isolated YouTube discovery via yt-dlp. Phase 4A scope: SEARCH ONLY.
//
// Knows nothing about Discord, voice connections, or audio playback.
// Later phases will feed a selected result into media extraction → FFmpeg
// → the existing Phase 3 player. This module stops at candidate results.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Prefer the project-local binary (bin/yt-dlp.exe); fall back to a
// PATH-installed `yt-dlp` so the module also works when the user installs
// yt-dlp system-wide later.
const LOCAL_BINARY = path.join(__dirname, '..', '..', 'bin', 'yt-dlp.exe');

function resolveBinary() {
  try {
    if (fs.existsSync(LOCAL_BINARY)) return LOCAL_BINARY;
  } catch {
    // Fall through to PATH lookup.
  }
  return 'yt-dlp';
}

function runBinary(binary, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// Shared yt-dlp runner for other src/youtube/ modules (e.g. media.js).
// Same binary resolution, same no-shell execFile. Additive only — existing
// search functions are unchanged.
//
// --js-runtimes node: YouTube extraction increasingly needs a JS runtime
// for signature challenges; without one yt-dlp warns that formats may go
// missing. Node is already installed here, so use it explicitly.
function runYtDlp(args, opts) {
  return runBinary(resolveBinary(), ['--js-runtimes', 'node', ...args], opts);
}

function toResult(entry) {
  const id = entry.id || null;
  return {
    title: entry.title || null,
    channel: entry.channel || entry.uploader || null,
    uploader: entry.uploader || entry.channel || null,
    id,
    url: entry.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : null),
    durationSeconds: typeof entry.duration === 'number' ? entry.duration : null,
    duration: entry.duration_string || null,
    viewCount: typeof entry.view_count === 'number' ? entry.view_count : null,
    live: entry.live_status || null,
    channelVerified: entry.channel_is_verified ?? null,
  };
}

// Search YouTube for `query` and return up to `limit` video candidates.
// Uses `ytsearchN:` (YouTube-only search), flat playlist mode (metadata
// only — nothing is downloaded), one JSON object per stdout line.
async function searchYouTube(query, { limit = 5 } = {}) {
  if (!query || !query.trim()) {
    throw new Error('searchYouTube: query must be a non-empty string.');
  }
  const n = Math.max(1, Math.min(limit, 20));
  const binary = resolveBinary();
  const { stdout } = await runBinary(binary, [
    `ytsearch${n}:${query.trim()}`,
    '--flat-playlist',
    '--dump-json',
    '--no-download',
  ]);

  const results = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      results.push(toResult(JSON.parse(trimmed)));
    } catch {
      // Skip a malformed line rather than failing the whole search.
    }
  }
  return results;
}

async function binaryVersion() {
  const binary = resolveBinary();
  try {
    const { stdout } = await runBinary(binary, ['--version'], { timeoutMs: 30000 });
    return { binary, version: stdout.trim() };
  } catch (err) {
    return { binary, version: null, error: err.message };
  }
}

module.exports = { searchYouTube, binaryVersion, resolveBinary, runYtDlp };
