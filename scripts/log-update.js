require('dotenv').config();

const fs = require('fs');
const path = require('path');

const UPDATE_LOG_CHANNEL_ID = '1485584578927132863';
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_HISTORY_PATH = path.join(REPO_ROOT, 'HISTORY.md');
const DESKTOP_HISTORY_PATH = 'C:\\Users\\chugc\\Desktop\\Aavgo Bot\\History.md';

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function readHistoryTail(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function buildHistoryEntry({ title, summary, files, notes }) {
  const fileList = files.length > 0 ? files.map(file => `- ${file}`).join('\n') : '- Not specified';
  const noteList = notes.length > 0 ? notes.map(note => `- ${note}`).join('\n') : '- None';

  return [
    `- ${title}`,
    `  - Summary: ${summary}`,
    `  - Files touched:`,
    fileList.split('\n').map(line => `    ${line}`).join('\n'),
    `  - Notes:`,
    noteList.split('\n').map(line => `    ${line}`).join('\n')
  ].join('\n');
}

function buildDiscordMessage({ title, summary, files, notes }) {
  const lines = [
    `Aavgo update: ${title}`,
    '',
    `Summary: ${summary}`
  ];

  if (files.length > 0) {
    lines.push('', `Files: ${files.join(', ')}`);
  }

  if (notes.length > 0) {
    lines.push('', `Notes: ${notes.join(' | ')}`);
  }

  lines.push('', `This update was also logged to HISTORY.md and the desktop history file.`);
  return lines.join('\n');
}

async function postToDiscord(message) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    return { posted: false, reason: 'DISCORD_TOKEN missing' };
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${UPDATE_LOG_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content: message })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  return { posted: true };
}

function appendHistory(filePath, entry) {
  const current = readHistoryTail(filePath);
  const marker = '## Latest Changes\n';

  if (!current.includes(marker)) {
    const fallback = `${current.trimEnd()}\n\n## Latest Changes\n${entry}\n`;
    fs.writeFileSync(filePath, fallback);
    return;
  }

  const updated = current.replace(marker, `${marker}${entry}\n`);
  fs.writeFileSync(filePath, updated);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const title = String(args.title || '').trim();
  const summary = String(args.summary || '').trim();
  const files = splitCsv(args.files);
  const notes = splitCsv(args.notes);

  if (!title || !summary) {
    console.error('Usage: node scripts/log-update.js --title "Short title" --summary "Plain English summary" [--files "a,b,c"] [--notes "x,y"]');
    process.exitCode = 1;
    return;
  }

  const entry = buildHistoryEntry({ title, summary, files, notes });
  appendHistory(REPO_HISTORY_PATH, entry);

  if (fs.existsSync(DESKTOP_HISTORY_PATH)) {
    appendHistory(DESKTOP_HISTORY_PATH, entry);
  }

  const message = buildDiscordMessage({ title, summary, files, notes });

  try {
    const result = await postToDiscord(message);
    if (result.posted) {
      console.log(`[UPDATE-LOG] Posted to Discord channel ${UPDATE_LOG_CHANNEL_ID}.`);
    } else {
      console.log('[UPDATE-LOG] Discord post skipped because DISCORD_TOKEN is missing.');
    }
  } catch (error) {
    console.warn('[UPDATE-LOG] Discord post failed:', error.message);
  }

  console.log('[UPDATE-LOG] History files updated.');
}

main().catch(error => {
  console.error('[UPDATE-LOG] Failed:', error);
  process.exitCode = 1;
});
