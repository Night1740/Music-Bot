'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');

let config;
try {
  config = require('./config');
} catch (err) {
  console.error('[Churan] Startup failed:', err.message);
  console.error('[Churan] Tip: copy .env.example to .env and set DISCORD_TOKEN and CLIENT_ID.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.commands = new Collection();

// Load commands from src/commands/*.js (extensible for future phases).
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  try {
    const command = require(path.join(commandsDir, file));
    if (command?.data?.name && typeof command.execute === 'function') {
      client.commands.set(command.data.name, command);
    } else {
      console.warn(`[Churan] Skipped invalid command file: ${file}`);
    }
  } catch (err) {
    console.error(`[Churan] Failed to load command file ${file}:`, err.message || err);
  }
}
console.log(`[Churan] Loaded commands: ${[...client.commands.keys()].join(', ') || '(none)'}`);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[Churan] Logged in as ${readyClient.user.tag}`);
  console.log(`[Churan] Serving ${readyClient.guilds.cache.size} guild(s).`);
  console.log('[Churan] Ready. Try /ping in Discord.');
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    console.warn(`[Churan] Unknown command received: ${interaction.commandName} (loaded: ${[...client.commands.keys()].join(', ') || '(none)'} — is this an old bot process? Restart to pick up new commands.)`);
    await interaction.reply({ content: '❌ Unknown command. The bot may need a restart to pick up new commands.', ephemeral: true }).catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[Churan] Error running /${interaction.commandName}:`, err);
    const reply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (err) => {
  console.error('[Churan] Unhandled promise rejection:', err);
});

async function start() {
  try {
    console.log('[Churan] Starting…');
    await client.login(config.token);
  } catch (err) {
    // Never print the token itself.
    if (err?.code === 'TokenInvalid') {
      console.error('[Churan] Login failed: the DISCORD_TOKEN is invalid.');
    } else {
      console.error('[Churan] Login failed:', err.message || err);
    }
    process.exit(1);
  }
}

start();
