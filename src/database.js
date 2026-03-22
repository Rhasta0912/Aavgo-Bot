const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../aavgo.db');
const db = new Database(dbPath);
// Foreign keys disabled during init to allow hotel rotation/seeding
db.pragma('foreign_keys = OFF');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    hotel_id TEXT,
    pin TEXT NOT NULL,
    role TEXT DEFAULT 'agent',
    agent_status TEXT DEFAULT 'standby',
    team TEXT,
    phone TEXT,
    approval_message_id TEXT,
    FOREIGN KEY (hotel_id) REFERENCES hotels(id)
  );

  CREATE TABLE IF NOT EXISTS hotels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team TEXT NOT NULL DEFAULT 'Team 1'
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    hotel_id TEXT NOT NULL,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    status TEXT DEFAULT 'active',
    break_status TEXT,
    break_covering_id TEXT,
    break_start_time DATETIME,
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    FOREIGN KEY (hotel_id) REFERENCES hotels(id)
  );

  CREATE TABLE IF NOT EXISTS hotel_status (
    hotel_id TEXT PRIMARY KEY,
    message_id TEXT,
    FOREIGN KEY (hotel_id) REFERENCES hotels(id)
  );

  CREATE TABLE IF NOT EXISTS pending_registrations (
    discord_id TEXT PRIMARY KEY,
    pin TEXT,
    phone TEXT,
    email TEXT,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS developers (
    discord_id TEXT PRIMARY KEY,
    username TEXT
  );

  CREATE TABLE IF NOT EXISTS dev_approvals (
    target_id TEXT PRIMARY KEY,
    proposed_by TEXT,
    approvals TEXT DEFAULT '[]', -- JSON array of discord IDs
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_status (
    team TEXT PRIMARY KEY,
    message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS rac_codes (
    code TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    expires_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- 'check-in', 'check-out', 'call'
    guest_name TEXT,
    room_number TEXT,
    details TEXT, -- JSON string for extra fields
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS maintenance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id TEXT NOT NULL,
    agent_id INTEGER NOT NULL,
    room_number TEXT,
    category TEXT,
    description TEXT,
    status TEXT DEFAULT 'pending',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (hotel_id) REFERENCES hotels(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS sop_guides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id TEXT, -- NULL means Global
    topic TEXT NOT NULL,
    content TEXT NOT NULL,
    UNIQUE(hotel_id, topic),
    FOREIGN KEY (hotel_id) REFERENCES hotels(id)
  );

  CREATE TABLE IF NOT EXISTS handover_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id TEXT NOT NULL,
    agent_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'unread',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (hotel_id) REFERENCES hotels(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    hotel_id TEXT NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    notified INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending', -- pending, attended, missed
    FOREIGN KEY (hotel_id) REFERENCES hotels(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );


  -- Seed initial Developers
  INSERT OR IGNORE INTO developers (discord_id, username) VALUES ('320128931971727360', 'itzrvjplayz');
  INSERT OR IGNORE INTO developers (discord_id, username) VALUES ('1186978205018632242', 'xs10921');

  -- Clear old seeds to avoid ID conflicts with new hotel list

  -- Seed new hotels with teams
  INSERT INTO hotels (id, name, team) VALUES ('BW_TO', 'Indianhead/Magnuson', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('VALS', 'Value Suites', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('GICP', 'The Garden Inn At Campsite', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('QI_RV', 'Russelville', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('SUP8', 'Super8', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('RMDA', 'Ramada', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('AD1', 'AD1', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('TEAM_SHIFT', 'Team Operations', 'Global')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;

  -- Seed hotel_status
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BW_TO');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('VALS');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('GICP');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('QI_RV');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('SUP8');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('RMDA');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('AD1');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('TEAM_SHIFT');

  -- Seed team_status

  -- Seed team_status
  INSERT OR IGNORE INTO team_status (team) VALUES ('Team 1');
  INSERT OR IGNORE INTO team_status (team) VALUES ('Team 2');
`);

// Re-enable foreign keys after init
db.pragma('foreign_keys = ON');

// Migration: Add team column to agents/hotels if they don't exist
(function() {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(agents)").all();
    if (!tableInfo.find(col => col.name === 'team')) {
      db.prepare("ALTER TABLE agents ADD COLUMN team TEXT").run();
    }
    const hotelTableInfo = db.prepare("PRAGMA table_info(hotels)").all();
    if (!hotelTableInfo.find(col => col.name === 'team')) {
      db.prepare("ALTER TABLE hotels ADD COLUMN team TEXT DEFAULT 'Team 1'").run();
    }
    if (!tableInfo.find(col => col.name === 'phone')) {
      db.prepare("ALTER TABLE agents ADD COLUMN phone TEXT").run();
    }
    if (!tableInfo.find(col => col.name === 'email')) {
      db.prepare("ALTER TABLE agents ADD COLUMN email TEXT").run();
    }
    if (!tableInfo.find(col => col.name === 'agent_status')) {
      db.prepare("ALTER TABLE agents ADD COLUMN agent_status TEXT DEFAULT 'standby'").run();
    }
    db.prepare("UPDATE agents SET agent_status = 'standby' WHERE agent_status IS NULL").run();
    db.transaction(() => {
      db.prepare("UPDATE agents SET hotel_id = 'BW_TO' WHERE hotel_id = 'BRNT'").run();
      db.prepare("UPDATE sessions SET hotel_id = 'BW_TO' WHERE hotel_id = 'BRNT'").run();
      db.prepare("UPDATE maintenance_logs SET hotel_id = 'BW_TO' WHERE hotel_id = 'BRNT'").run();
      db.prepare("UPDATE handover_notes SET hotel_id = 'BW_TO' WHERE hotel_id = 'BRNT'").run();
      db.prepare("UPDATE schedules SET hotel_id = 'BW_TO' WHERE hotel_id = 'BRNT'").run();
      db.prepare("UPDATE sop_guides SET hotel_id = 'BW_TO' WHERE hotel_id = 'BRNT'").run();
      db.prepare("DELETE FROM hotel_status WHERE hotel_id = 'BRNT'").run();
      db.prepare("DELETE FROM hotels WHERE id = 'BRNT'").run();
      db.prepare("UPDATE hotels SET name = 'Indianhead/Magnuson' WHERE id = 'BW_TO'").run();
    })();
    const pendingTableInfo = db.prepare("PRAGMA table_info(pending_registrations)").all();
    if (!pendingTableInfo.find(col => col.name === 'pin')) {
      db.prepare("ALTER TABLE pending_registrations ADD COLUMN pin TEXT").run();
    }
    if (!pendingTableInfo.find(col => col.name === 'phone')) {
      db.prepare("ALTER TABLE pending_registrations ADD COLUMN phone TEXT").run();
    }
    if (!pendingTableInfo.find(col => col.name === 'email')) {
      db.prepare("ALTER TABLE pending_registrations ADD COLUMN email TEXT").run();
    }
    const racTableInfo = db.prepare("PRAGMA table_info(rac_codes)").all();
    if (!racTableInfo.find(col => col.name === 'expires_at')) {
      db.prepare("ALTER TABLE rac_codes ADD COLUMN expires_at DATETIME").run();
    }
    db.prepare("UPDATE rac_codes SET expires_at = datetime(created_at, '+1 day') WHERE expires_at IS NULL").run();
    db.prepare("UPDATE agents SET role = 'sme' WHERE lower(role) IN ('sme', 'subject matter expert', 'subject_matter_expert')").run();
    db.prepare("UPDATE agents SET role = 'team_leader' WHERE lower(replace(role, ' ', '_')) IN ('team_leader', 'teamleader')").run();
    db.prepare("UPDATE agents SET role = 'operations_manager' WHERE lower(replace(role, ' ', '_')) IN ('operations_manager', 'operation_manager', 'operationsmanager')").run();
  } catch (e) {
    console.warn('[DB] Migration skip or error:', e.message);
  }
})();

module.exports = db;
