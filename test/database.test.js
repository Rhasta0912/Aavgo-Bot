const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aavgo-db-test-'));
process.env.AAVGO_DB_PATH = path.join(tempDirectory, 'aavgo.db');
const db = require('../src/database');

test('database starts with integrity and operational indexes', () => {
  assert.equal(db.prepare('PRAGMA quick_check').pluck().get(), 'ok');

  const indexNames = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name)
  );
  for (const indexName of [
    'idx_sessions_status_login',
    'idx_sessions_agent_status',
    'idx_sessions_hotel_status',
    'idx_schedules_status_start',
    'idx_attendance_queue_target'
  ]) {
    assert.ok(indexNames.has(indexName), `expected ${indexName} to exist`);
  }
});

test.after(() => {
  db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});
