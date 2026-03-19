require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const { upsertBotStatusCard } = require('./src/botStatus');

const RESTART_DELAY_MS = 5000;

let botProcess = null;
let isShuttingDown = false;

async function setBotStatus({ title, description, color, stateLabel }) {
  await upsertBotStatusCard({ title, description, color, stateLabel });
}

async function setOfflineStatus(description, stateLabel = 'Offline') {
  await setBotStatus({
    title: 'Bot Offline',
    description,
    color: 0xED4245,
    stateLabel
  });
}

async function handleGuardianShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[GUARDIAN] Received ${signal}. Marking bot offline and shutting down...`);

  await setOfflineStatus(
    `Guardian received \`${signal}\` and shut down the bot monitor.`,
    'Offline'
  );

  if (botProcess && !botProcess.killed) {
    try {
      botProcess.kill(signal);
    } catch (error) {
      console.warn('[GUARDIAN] Failed to stop child bot process cleanly:', error.message);
    }
  }

  process.exit(0);
}

function startBot() {
  console.log('[GUARDIAN] Starting bot...');
  setBotStatus({
    title: 'Bot Starting',
    description: 'Guardian launched a fresh bot process and is waiting for Discord readiness.',
    color: 0xFEE75C,
    stateLabel: 'Starting'
  });

  const bot = spawn('node', [path.join(__dirname, 'src/index.js')], {
    stdio: 'inherit',
    shell: true
  });
  botProcess = bot;

  bot.on('exit', (code, signal) => {
    if (isShuttingDown) return;

    console.log(`[GUARDIAN] Bot exited with code ${code} and signal ${signal}. Restarting in 5 seconds...`);
    setOfflineStatus(
      `The bot process exited with code \`${code}\` and signal \`${signal || 'none'}\`. Guardian will restart it in 5 seconds.`,
      'Offline'
    );
    setTimeout(startBot, RESTART_DELAY_MS);
  });

  bot.on('error', err => {
    if (isShuttingDown) return;

    console.error('[GUARDIAN] Failed to start bot:', err);
    setBotStatus({
      title: 'Bot Start Failure',
      description: `Guardian could not start the bot process.\n\`${err.message}\`\nRetrying in 5 seconds.`,
      color: 0xED4245,
      stateLabel: 'Start Failure'
    });
    setTimeout(startBot, RESTART_DELAY_MS);
  });
}

process.on('SIGINT', () => {
  handleGuardianShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  handleGuardianShutdown('SIGTERM');
});

process.on('SIGHUP', () => {
  handleGuardianShutdown('SIGHUP');
});

startBot();
