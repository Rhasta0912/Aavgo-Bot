const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aavgo-hours-api-test-'));
process.env.AAVGO_DB_PATH = path.join(tempDirectory, 'aavgo.db');
const db = require('../src/database');
const { buildHoursApiSnapshot, signPayload } = require('../src/hoursApi');

test('Hours API v1 snapshot contains operational hours without sensitive fields', () => {
  const now = new Date('2026-07-11T08:00:00.000Z');
  db.prepare(`
    INSERT INTO agents (discord_id, username, pin, role, agent_status, team, hotel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('agent-1', 'Test Agent', 'do-not-export', 'agent', 'ready', 'Team 1', 'AD1');
  const agent = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get('agent-1');
  db.prepare(`
    INSERT INTO sessions (agent_id, hotel_id, session_kind, login_time, logout_time, status)
    VALUES (?, ?, 'shift', ?, ?, 'closed')
  `).run(agent.id, 'AD1', '2026-07-11T03:00:00.000Z', '2026-07-11T06:00:00.000Z');

  const snapshot = buildHoursApiSnapshot(now);
  const record = snapshot.agents.find(item => item.discord_id === 'agent-1');
  assert.equal(snapshot.api_version, 'v1');
  assert.equal(record.display_name, 'Test Agent');
  assert.equal(record.hours.all_time, 3);
  assert.equal(Object.hasOwn(record, 'pin'), false);
  assert.equal(JSON.stringify(snapshot).includes('do-not-export'), false);
  assert.equal(signPayload('a'.repeat(32), '123', '{"ok":true}').length, 64);
});

test.after(() => {
  db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});
