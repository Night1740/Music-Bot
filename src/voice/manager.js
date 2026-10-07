'use strict';

// Small voice-connection layer for Phase 2.
// Commands (/join, /leave, and later /play, /stop, …) should use these
// helpers instead of calling @discordjs/voice directly, so future playback
// code can reuse the same connection handling without rewrites.
//
// Storage: we deliberately do NOT keep our own Map of connections.
// @discordjs/voice already stores one connection per guild internally
// (keyed by guildId). getConnection() reads from that store, joinChannel()
// creates/replaces it, leaveGuild() destroys it.

const { getVoiceConnection, joinVoiceChannel } = require('@discordjs/voice');

function getConnection(guildId) {
  if (!guildId) return undefined;
  return getVoiceConnection(guildId);
}

function joinChannel({ guildId, channelId, adapterCreator }) {
  return joinVoiceChannel({
    guildId,
    channelId,
    adapterCreator,
  });
}

function leaveGuild(guildId) {
  const connection = getConnection(guildId);
  if (!connection) return false;
  connection.destroy();
  return true;
}

module.exports = { getConnection, joinChannel, leaveGuild };
