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
    pin_is_set INTEGER DEFAULT 1,
    role TEXT DEFAULT 'agent',
    agent_status TEXT DEFAULT 'standby',
    team TEXT,
    hotel_compatibility TEXT DEFAULT '[]',
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
    session_kind TEXT DEFAULT 'shift',
    time_travel_offset_ms INTEGER DEFAULT 0,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    status TEXT DEFAULT 'active',
    overtime_warning_at DATETIME,
    overtime_confirmed INTEGER DEFAULT 0,
    overtime_next_warning_at DATETIME,
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

  CREATE TABLE IF NOT EXISTS hour_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    hotel_id TEXT,
    shift_date TEXT,
    login_time TEXT,
    logout_time TEXT,
    hours REAL NOT NULL,
    mode TEXT NOT NULL DEFAULT 'shift',
    reason TEXT,
    note TEXT,
    effective_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (hotel_id) REFERENCES hotels(id)
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

  CREATE TABLE IF NOT EXISTS hotel_shift_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL UNIQUE,
    primary_hotel_id TEXT NOT NULL,
    secondary_hotel_id TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    FOREIGN KEY (primary_hotel_id) REFERENCES hotels(id),
    FOREIGN KEY (secondary_hotel_id) REFERENCES hotels(id)
  );


  -- Seed initial Developers
  INSERT OR IGNORE INTO developers (discord_id, username) VALUES ('320128931971727360', 'itzrvjplayz');
  INSERT OR IGNORE INTO developers (discord_id, username) VALUES ('1186978205018632242', 'xs10921');

  -- Clear old seeds to avoid ID conflicts with new hotel list

  -- Seed new hotels with teams
  INSERT INTO hotels (id, name, team) VALUES ('BW_TO', 'Indianhead/Magnuson', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('GICP', 'The Garden Inn At Campsite', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('SUP8', 'Super 8', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('RMDA', 'Ramada', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('AD1', 'AD1', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('TRVL', 'Travelodge', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('DIBS', 'Day Inns Bishop', 'Team 1')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('PROS', 'Prospero Flagship', 'Team 2')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('GLDL', 'Glendale / The Leef Hotel', 'Team 2')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('INFL', 'Inn at the Fingerlakes', 'Team 2')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('VALS', 'Value Suites', 'Team 2')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('BAYT', 'Bayside / Townhouse', 'Team 2')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('ANPI', 'Anchor Beach / Pacific Inn', 'Team 2')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('ECON', 'Econolodge', 'Team 3')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('BUEN', 'Buenavista', 'Team 3')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('QI_RV', 'Quality Russelville', 'Team 3')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('THOK', 'Thousand Oaks', 'Team 3')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('BRNT', 'Brentwood', 'Team 3')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;
  INSERT INTO hotels (id, name, team) VALUES ('TEAM_SHIFT', 'Team Operations', 'Global')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team;

  -- Seed hotel_status
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BW_TO');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('GICP');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('RMDA');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('AD1');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('TRVL');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('DIBS');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('QI_RV');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('PROS');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('GLDL');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('INFL');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('VALS');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BAYT');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('ANPI');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('ECON');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BUEN');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('THOK');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BRNT');
  INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('TEAM_SHIFT');

  -- Seed team_status

  -- Seed team_status
  INSERT OR IGNORE INTO team_status (team) VALUES ('Team 1');
  INSERT OR IGNORE INTO team_status (team) VALUES ('Team 2');
  INSERT OR IGNORE INTO team_status (team) VALUES ('Team 3');
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
    if (!tableInfo.find(col => col.name === 'pin_is_set')) {
      db.prepare("ALTER TABLE agents ADD COLUMN pin_is_set INTEGER DEFAULT 1").run();
    }
    if (!tableInfo.find(col => col.name === 'hotel_compatibility')) {
      db.prepare("ALTER TABLE agents ADD COLUMN hotel_compatibility TEXT DEFAULT '[]'").run();
    }
    db.prepare("UPDATE agents SET pin_is_set = 1 WHERE pin_is_set IS NULL").run();
    db.prepare("UPDATE agents SET hotel_compatibility = '[]' WHERE hotel_compatibility IS NULL OR hotel_compatibility = ''").run();
    const sessionTableInfo = db.prepare("PRAGMA table_info(sessions)").all();
    if (!sessionTableInfo.find(col => col.name === 'session_kind')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN session_kind TEXT DEFAULT 'shift'").run();
    }
    if (!sessionTableInfo.find(col => col.name === 'time_travel_offset_ms')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN time_travel_offset_ms INTEGER DEFAULT 0").run();
    }
    if (!sessionTableInfo.find(col => col.name === 'overtime_warning_at')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN overtime_warning_at DATETIME").run();
    }
    if (!sessionTableInfo.find(col => col.name === 'overtime_confirmed')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN overtime_confirmed INTEGER DEFAULT 0").run();
    }
    if (!sessionTableInfo.find(col => col.name === 'overtime_next_warning_at')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN overtime_next_warning_at DATETIME").run();
    }
    let hourAdjustmentsTableInfo = db.prepare("PRAGMA table_info(hour_adjustments)").all();
    if (!hourAdjustmentsTableInfo || hourAdjustmentsTableInfo.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hour_adjustments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER NOT NULL,
          hotel_id TEXT,
          shift_date TEXT,
          login_time TEXT,
          logout_time TEXT,
          hours REAL NOT NULL,
          mode TEXT NOT NULL DEFAULT 'shift',
          reason TEXT,
          note TEXT,
          effective_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
          FOREIGN KEY (hotel_id) REFERENCES hotels(id)
        );
      `);
      hourAdjustmentsTableInfo = db.prepare("PRAGMA table_info(hour_adjustments)").all();
    }
    if (!hourAdjustmentsTableInfo.find(col => col.name === 'hotel_id')) {
      db.prepare("ALTER TABLE hour_adjustments ADD COLUMN hotel_id TEXT").run();
    }
    if (!hourAdjustmentsTableInfo.find(col => col.name === 'shift_date')) {
      db.prepare("ALTER TABLE hour_adjustments ADD COLUMN shift_date TEXT").run();
    }
    if (!hourAdjustmentsTableInfo.find(col => col.name === 'login_time')) {
      db.prepare("ALTER TABLE hour_adjustments ADD COLUMN login_time TEXT").run();
    }
    if (!hourAdjustmentsTableInfo.find(col => col.name === 'logout_time')) {
      db.prepare("ALTER TABLE hour_adjustments ADD COLUMN logout_time TEXT").run();
    }
    if (!hourAdjustmentsTableInfo.find(col => col.name === 'reason')) {
      db.prepare("ALTER TABLE hour_adjustments ADD COLUMN reason TEXT").run();
    }
    if (!hourAdjustmentsTableInfo.find(col => col.name === 'mode')) {
      db.prepare("ALTER TABLE hour_adjustments ADD COLUMN mode TEXT DEFAULT 'shift'").run();
    }
    if (!hourAdjustmentsTableInfo.find(col => col.name === 'effective_at')) {
      db.prepare("ALTER TABLE hour_adjustments ADD COLUMN effective_at DATETIME").run();
    }
    db.prepare("UPDATE hour_adjustments SET mode = 'shift' WHERE mode IS NULL OR TRIM(mode) = ''").run();
    db.prepare("UPDATE hour_adjustments SET effective_at = created_at WHERE effective_at IS NULL OR TRIM(effective_at) = ''").run();
    db.prepare("UPDATE sessions SET session_kind = 'shift' WHERE session_kind IS NULL OR session_kind = ''").run();
    db.prepare("UPDATE sessions SET time_travel_offset_ms = 0 WHERE time_travel_offset_ms IS NULL").run();
    db.prepare("UPDATE sessions SET overtime_confirmed = 0 WHERE overtime_confirmed IS NULL").run();
    db.prepare("UPDATE agents SET agent_status = 'standby' WHERE agent_status IS NULL").run();
    db.transaction(() => {
      db.prepare("UPDATE hotels SET name = 'Indianhead/Magnuson' WHERE id = 'BW_TO'").run();
      db.prepare("UPDATE hotels SET name = 'AD1' WHERE id = 'AD1'").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('TRVL', 'Travelodge', 'Team 1') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('DIBS', 'Day Inns Bishop', 'Team 1') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('GLDL', 'Glendale / The Leef Hotel', 'Team 2') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('INFL', 'Inn at the Fingerlakes', 'Team 2') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('VALS', 'Value Suites', 'Team 2') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('BAYT', 'Bayside / Townhouse', 'Team 2') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('ANPI', 'Anchor Beach / Pacific Inn', 'Team 2') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('ECON', 'Econolodge', 'Team 3') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('BUEN', 'Buenavista', 'Team 3') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('QI_RV', 'Quality Russelville', 'Team 3') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('THOK', 'Thousand Oaks', 'Team 3') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT INTO hotels (id, name, team) VALUES ('BRNT', 'Brentwood', 'Team 3') ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = excluded.team").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('QI_RV')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('GLDL')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('INFL')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('VALS')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BAYT')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('ANPI')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('ECON')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BUEN')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('THOK')").run();
      db.prepare("INSERT OR IGNORE INTO hotel_status (hotel_id) VALUES ('BRNT')").run();
    })();
    db.transaction(() => {
      const retiredHotelIds = [];
      for (const hotelId of retiredHotelIds) {
        db.prepare("UPDATE agents SET hotel_id = 'BW_TO' WHERE hotel_id = ?").run(hotelId);
        db.prepare("UPDATE sessions SET hotel_id = 'BW_TO' WHERE hotel_id = ?").run(hotelId);
        db.prepare("UPDATE maintenance_logs SET hotel_id = 'BW_TO' WHERE hotel_id = ?").run(hotelId);
        db.prepare("UPDATE handover_notes SET hotel_id = 'BW_TO' WHERE hotel_id = ?").run(hotelId);
        db.prepare("UPDATE schedules SET hotel_id = 'BW_TO' WHERE hotel_id = ?").run(hotelId);
        db.prepare("UPDATE sop_guides SET hotel_id = 'BW_TO' WHERE hotel_id = ?").run(hotelId);
        db.prepare("UPDATE hotel_shift_assignments SET primary_hotel_id = 'BW_TO' WHERE primary_hotel_id = ?").run(hotelId);
        db.prepare("UPDATE hotel_shift_assignments SET secondary_hotel_id = 'BW_TO' WHERE secondary_hotel_id = ?").run(hotelId);
        db.prepare("DELETE FROM hotel_status WHERE hotel_id = ?").run(hotelId);
        db.prepare("DELETE FROM hotels WHERE id = ?").run(hotelId);
      }
      db.prepare("UPDATE hotels SET name = 'Super 8' WHERE id = 'SUP8'").run();
      db.prepare("UPDATE hotels SET name = 'Ramada' WHERE id = 'RMDA'").run();
      db.prepare("INSERT OR IGNORE INTO team_status (team) VALUES ('Team 3')").run();
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
