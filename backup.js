const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PROJECT_ROOT = __dirname;
const BACKUPS_ROOT = path.join(PROJECT_ROOT, 'backups');
const DEFAULT_RETENTION_DAYS = 14;

function getRetentionDays() {
  const value = Number.parseInt(process.env.AAVGO_BACKUP_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function removeExpiredBackups(retentionDays) {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(BACKUPS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const backupPath = path.join(BACKUPS_ROOT, entry.name);
    if (fs.statSync(backupPath).mtimeMs < cutoffMs) {
      fs.rmSync(backupPath, { recursive: true, force: true });
      console.log(`[BACKUP] Removed expired backup: ${entry.name}`);
    }
  }
}

async function performBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUPS_ROOT, timestamp);
  const sourceDbPath = path.resolve(process.env.AAVGO_DB_PATH || path.join(PROJECT_ROOT, 'aavgo.db'));

  fs.mkdirSync(backupDir, { recursive: true });
  console.log(`[BACKUP] Starting verified snapshot: ${timestamp}`);

  const sourceDb = new Database(sourceDbPath);
  try {
    await sourceDb.backup(path.join(backupDir, 'aavgo.db'));
    const tables = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const exportData = Object.fromEntries(tables.map(({ name }) => [name, sourceDb.prepare(`SELECT * FROM \"${name.replace(/\"/g, '\"\"')}\"`).all()]));
    fs.writeFileSync(path.join(backupDir, 'database_export.json'), JSON.stringify(exportData, null, 2));
  } finally {
    sourceDb.close();
  }

  copyDirectory(path.join(PROJECT_ROOT, 'src'), path.join(backupDir, 'src'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'package.json'), path.join(backupDir, 'package.json'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'package-lock.json'), path.join(backupDir, 'package-lock.json'));

  removeExpiredBackups(getRetentionDays());
  console.log(`[BACKUP] Completed: ${backupDir}`);
  return backupDir;
}

if (require.main === module) {
  performBackup().catch(error => {
    console.error('[BACKUP] Failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { performBackup };
