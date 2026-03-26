require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

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

function trimLine(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const output = [];
  for (const raw of values || []) {
    const text = trimLine(raw, 320);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function extractUniqueMatches(text, pattern) {
  const source = String(text || '');
  if (!source) return [];

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const seen = new Set();
  const output = [];
  let match;
  while ((match = regex.exec(source)) !== null) {
    const value = String(match[0] || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function extractIdsByContext(text, keywords = []) {
  const source = String(text || '');
  if (!source) return [];
  const keys = keywords.map(key => String(key || '').toLowerCase()).filter(Boolean);
  if (keys.length === 0) return [];

  const ids = new Set();
  const regex = /\b\d{17,20}\b/g;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const id = match[0];
    const start = Math.max(0, match.index - 48);
    const end = Math.min(source.length, match.index + id.length + 48);
    const context = source.slice(start, end).toLowerCase();
    if (keys.some(key => context.includes(key))) {
      ids.add(id);
    }
  }

  return [...ids];
}

function extractImpactLines(lines, keywords = [], limit = 8) {
  const keys = keywords.map(key => String(key || '').toLowerCase()).filter(Boolean);
  if (keys.length === 0) return [];
  return uniqueNonEmpty(lines)
    .filter(line => keys.some(key => line.toLowerCase().includes(key)))
    .slice(0, limit);
}

function fitFieldValue(lines, fallback) {
  const normalized = uniqueNonEmpty(lines);
  const text = (normalized.length > 0 ? normalized : [fallback]).join('\n');
  if (text.length <= 1024) return text;
  return `${text.slice(0, 1000)}\n- ...trimmed`;
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
    '  - Files touched:',
    fileList.split('\n').map(line => `    ${line}`).join('\n'),
    '  - Notes:',
    noteList.split('\n').map(line => `    ${line}`).join('\n')
  ].join('\n');
}

function buildDiscordMessage({ title, summary, files, notes }) {
  const detailSource = uniqueNonEmpty([title, summary, ...files, ...notes]).join('\n');
  const featureKeywords = [
    'added', 'updated', 'fixed', 'removed', 'renamed', 'expanded',
    'refined', 'implemented', 'moved', 'hardened', 'restored',
    'merged', 'reworked', 'improved'
  ];
  const permissionLogicKeywords = [
    'permission', 'access', 'authority', 'developer', 'operations manager',
    'team leader', 'role-only', 'gate', 'blocked', 'allow', 'deny',
    'logic', 'flow', 'route', 'handler', 'sync', 'filter', 'function'
  ];

  const featureLines = extractImpactLines([title, summary, ...notes], featureKeywords, 8)
    .map(line => `- ${line}`);
  if (featureLines.length === 0) {
    featureLines.push(`- ${trimLine(summary, 220)}`);
  }

  const commandLines = extractUniqueMatches(detailSource, /\/[a-z0-9-]+/gi)
    .slice(0, 12)
    .map(command => `- \`${command}\``);

  const channelIds = extractIdsByContext(detailSource, ['channel', 'channels', 'kiosk', 'portal', 'board', 'log']);
  const roleIds = extractIdsByContext(detailSource, ['role', 'roles', 'agent', 'sme', 'team leader', 'operations manager', 'developer', 'trainee', 'applicant', 'unverified']);
  const channelSet = new Set(channelIds);
  const channelLines = channelIds.map(id => `- <#${id}> (\`${id}\`)`);
  const roleLines = roleIds.filter(id => !channelSet.has(id)).map(id => `- \`${id}\``);

  const permissionLogicLines = extractImpactLines([summary, ...notes], permissionLogicKeywords, 8)
    .map(line => `- ${line}`);

  return new EmbedBuilder()
    .setTitle('Aavgo Update Log')
    .setDescription(`**${trimLine(title, 180)}**\n\n${trimLine(summary, 320)}`)
    .addFields(
      {
        name: 'Features / Functions',
        value: fitFieldValue(featureLines, `- ${trimLine(summary, 220)}`)
      },
      {
        name: 'Commands',
        value: fitFieldValue(commandLines, '- No command surface changes detected')
      },
      {
        name: 'Channels',
        value: fitFieldValue(channelLines, '- No specific channels detected')
      },
      {
        name: 'Roles',
        value: fitFieldValue(roleLines, '- No specific role IDs detected')
      },
      {
        name: 'Permissions & Logic',
        value: fitFieldValue(permissionLogicLines, '- No explicit permission/logic changes noted')
      },
      {
        name: 'Files Touched',
        value: fitFieldValue(files.map(file => `- ${file}`), '- Not specified')
      },
      {
        name: 'Notes',
        value: fitFieldValue(notes.map(note => `- ${note}`), '- None')
      }
    )
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Operations - Detailed Update Log' })
    .setTimestamp()
    .toJSON();
}

async function postToDiscord(embed) {
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
    body: JSON.stringify({ embeds: [embed] })
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

  const embed = buildDiscordMessage({ title, summary, files, notes });

  try {
    const result = await postToDiscord(embed);
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
