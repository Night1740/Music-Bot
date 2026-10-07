'use strict';

require('dotenv').config();

function getEnv(name, { required = false } = {}) {
  const value = process.env[name];
  if (required && (!value || value.trim() === '')) {
    throw new Error(`Missing required environment variable: ${name}. Check your .env file (see .env.example).`);
  }
  return value ? value.trim() : '';
}

let config;
try {
  config = {
    token: getEnv('DISCORD_TOKEN', { required: true }),
    clientId: getEnv('CLIENT_ID', { required: true }),
    // Optional — enables fast guild-scoped command registration in dev.
    guildId: getEnv('GUILD_ID'),
  };
} catch (err) {
  // Throw so index.js / deploy-commands.js can handle startup errors uniformly.
  throw err;
}

module.exports = config;
