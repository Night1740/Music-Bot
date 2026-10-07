'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

let config;
try {
  config = require('./config');
} catch (err) {
  console.error('[Churan] Deploy failed:', err.message);
  process.exit(1);
}

async function main() {
  const commandsDir = path.join(__dirname, 'commands');
  const commands = [];

  for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
    const command = require(path.join(commandsDir, file));
    if (command?.data) {
      commands.push(command.data.toJSON());
    } else {
      console.warn(`[Churan] Skipped invalid command file: ${file}`);
    }
  }

  const rest = new REST().setToken(config.token);

  try {
    if (config.guildId) {
      console.log(`[Churan] Registering ${commands.length} global command(s)…`);
      await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
        console.log('[Churan] Global commands registered.');
    } else {
      console.log(`[Churan] Registering ${commands.length} global command(s)…`);
      await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
      console.log('[Churan] Global commands registered (may take up to 1 hour to appear).');
    }
  } catch (err) {
    console.error('[Churan] Command registration failed:', err.message || err);
    process.exit(1);
  }
}

main();
