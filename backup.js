const fs = require('fs');
const path = require('path');
const sqlite3 = require('better-sqlite3');

async function performBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, 'backups', timestamp);

    if (!fs.existsSync('backups')) fs.mkdirSync('backups');
    fs.mkdirSync(backupDir);

    console.log(`[BACKUP] Starting backup: ${timestamp}...`);

    // 1. Export Database to TXT (JSON)
    try {
        const db = new sqlite3('aavgo.db');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const exportData = {};
        
        tables.forEach(t => {
            exportData[t.name] = db.prepare(`SELECT * FROM ${t.name}`).all();
        });

        const exportPath = path.join(backupDir, 'database_export.txt');
        fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
        console.log(`[BACKUP] DB Exported to ${exportPath}`);

        // Also copy the raw binary db file
        fs.copyFileSync('aavgo.db', path.join(backupDir, 'aavgo.db'));
    } catch (err) {
        console.error('[BACKUP] DB Export failed:', err.message);
    }

    // 2. Backup Source Files
    const srcDir = path.join(__dirname, 'src');
    const targetSrcDir = path.join(backupDir, 'src');
    if (fs.existsSync(srcDir)) {
        fs.mkdirSync(targetSrcDir);
        const files = fs.readdirSync(srcDir);
        files.forEach(file => {
            if (fs.statSync(path.join(srcDir, file)).isFile()) {
                fs.copyFileSync(path.join(srcDir, file), path.join(targetSrcDir, file));
            }
        });
        console.log(`[BACKUP] Source files copied to ${targetSrcDir}`);
    }

    return backupDir;
}

if (require.main === module) {
    performBackup().then(dir => console.log(`[BACKUP] Completed: ${dir}`));
}

module.exports = { performBackup };
