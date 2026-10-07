'use strict';

// YouTube media/source utility (Phase 4B). Turns a YouTube watch URL into a
// directly playable audio source WITHOUT saving anything to disk.
//
// Approach: `yt-dlp -f bestaudio --get-url` resolves the video to a direct
// Googlevideo media URL (short-lived process, exits immediately). That URL
// is then used as FFmpeg's `-i` input by voice/player.js — the compressed
// bytes stream straight from YouTube to FFmpeg, never through Node, never
// to disk. Preferred over piping yt-dlp's stdout through Node.
//
// Knows nothing about Discord or voice. The Discord command coordinates;
// this module only handles YouTube/yt-dlp concerns.

const { runYtDlp } = require('./search');

// Light shape check so the command can reject obvious non-URLs early.
// yt-dlp itself remains the real validator.
function isYouTubeUrl(value) {
  if (typeof value !== 'string') return false;
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/watch\?|youtu\.be\/)/i.test(value.trim());
}

// Resolve a YouTube URL to a direct audio media URL.
// Rejects with a readable error when yt-dlp cannot extract one
// (private/removed/age-gated video, network failure, ...).
async function getAudioUrl(youtubeUrl) {
  const url = (youtubeUrl || '').trim();
  if (!isYouTubeUrl(url)) {
    throw new Error('Not a YouTube watch URL.');
  }

  let stdout;
  try {
    ({ stdout } = await runYtDlp(
      [
        '--no-playlist',
        '-f',
        'bestaudio[ext=m4a]/bestaudio',
        '--get-url',
        '--no-download',
        url,
      ],
      { timeoutMs: 60000 },
    ));
  } catch (err) {
    const detail = String(err.stderr || err.message || err)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' ')
      .slice(0, 300);
    throw new Error(`yt-dlp could not resolve audio for that URL. ${detail}`);
  }

  const mediaUrl = (stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('http'));

  if (!mediaUrl) {
    throw new Error('yt-dlp returned no media URL.');
  }
  return mediaUrl;
}

module.exports = { isYouTubeUrl, getAudioUrl };
