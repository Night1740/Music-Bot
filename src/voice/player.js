'use strict';

// Small playback layer (Phase 3 local files, Phase 4B remote URLs).
// Owns one AudioPlayer per guild and plays audio through the
// VoiceConnection created by ./manager.js. Commands (/playtest, /playyoutube
// now, /play etc. later) should use these helpers instead of talking
// to @discordjs/voice directly.
//
// Pipelines (same Arbitrary → FFmpeg → opus → player → connection path):
//   local file → FFmpeg (MP3 → PCM) → opus encoder → AudioPlayer → …
//   remote media URL → FFmpeg (-i <url> → PCM) → opus encoder → …

const { createReadStream } = require('node:fs');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  createAudioPlayer,
  createAudioResource,
} = require('@discordjs/voice');

// guildId -> AudioPlayer. Kept (not recreated per command) so future
// pause/resume/stop commands can act on the same player.
const players = new Map();

function getPlayer(guildId) {
  return players.get(guildId);
}

// True while audio is actively playing or buffering. Idle means finished
// (or never started), in which case a new play is allowed.
function isPlaying(guildId) {
  const player = players.get(guildId);
  return !!player && player.state.status !== AudioPlayerStatus.Idle;
}

function ensurePlayer(guildId) {
  let player = players.get(guildId);
  if (player) return player;

  player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  player.on(AudioPlayerStatus.Idle, () => {
    // Natural end of audio: stay in the voice channel, just log.
    // The player is kept in the map for reuse; isPlaying() goes false.
    console.log(`[Churan] Playback finished (guild ${guildId}). Staying connected.`);
  });

  player.on('error', (err) => {
    console.error(`[Churan] Playback error (guild ${guildId}):`, err.message || err);
  });

  players.set(guildId, player);
  return player;
}

// Play an already-built AudioResource over an existing connection.
// Caller must have checked isPlaying() first to avoid overlapping playback.
function playResource(connection, guildId, resource) {
  const player = ensurePlayer(guildId);
  connection.subscribe(player);
  player.play(resource);
  return player;
}

// Play a local audio file over an existing connection (from manager.js).
// Unchanged Phase 3 behavior: file path → Arbitrary pipeline (FFmpeg).
function playFile(connection, guildId, filePath) {
  return playResource(connection, guildId, createAudioResource(createReadStream(filePath)));
}

// Play a remote media URL (e.g. yt-dlp direct audio URL) over an existing
// connection. A string input takes the exact same Arbitrary pipeline as a
// local file: prism-media runs `ffmpeg -i <url> …`, so the compressed bytes
// stream straight from the source into FFmpeg — nothing via Node, nothing
// on disk. Natural finish → Idle (stay connected); errors → logged, no crash.
function playUrl(connection, guildId, mediaUrl) {
  if (!mediaUrl || typeof mediaUrl !== 'string') {
    throw new Error('playUrl: mediaUrl must be a non-empty string.');
  }
  return playResource(connection, guildId, createAudioResource(mediaUrl));
}

// Stop playback and forget the player. Called by /leave so destroying the
// connection never leaves a live player (or uncaught errors) behind.
function stopGuild(guildId) {
  const player = players.get(guildId);
  if (!player) return false;
  try {
    player.stop(true);
  } catch (err) {
    console.error(`[Churan] Error stopping playback (guild ${guildId}):`, err.message || err);
  }
  players.delete(guildId);
  return true;
}

module.exports = { getPlayer, isPlaying, playFile, playUrl, stopGuild };
