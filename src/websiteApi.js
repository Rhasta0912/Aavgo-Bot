const http = require('http');
const https = require('https');
const db = require('./database');
const { calculateAgentHourTotals, buildPeriodHourHistory, parseDbTimestamp, formatHours } = require('./hours');

const AAVGO_GUILD_ID = '1482220918355922974';
const DEVELOPER_ROLE_ID = '1482312134875418737';
const TEAM_LEADER_ROLE_ID = '1482732583660818636';
const OPERATIONS_MANAGER_ROLE_ID = '1482226842047090809';
const SME_ROLE_ID = '1482382342621233153';
const AGENT_ROLE_ID = '1482227287159078964';
const TRAINEE_ROLE_ID = '1484705126026449029';

let websiteApiServer = null;
let websiteSyncTimer = null;
let websiteSyncInFlight = false;

function getWebsiteApiConfig() {
  const token = String(process.env.AAVGO_WEBSITE_API_TOKEN || '').trim();
  const host = String(process.env.AAVGO_WEBSITE_API_HOST || '0.0.0.0').trim() || '0.0.0.0';
  const syncUrl = String(process.env.AAVGO_WEBSITE_SYNC_URL || '').trim();
  const port = Number.parseInt(
    String(process.env.AAVGO_WEBSITE_API_PORT || process.env.PORT || '3000').trim(),
    10
  );
  const syncIntervalMs = Number.parseInt(
    String(process.env.AAVGO_WEBSITE_SYNC_INTERVAL_MS || '30000').trim(),
    10
  );

  return {
    token,
    host,
    syncUrl,
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    syncIntervalMs: Number.isFinite(syncIntervalMs) && syncIntervalMs >= 10000 ? syncIntervalMs : 30000
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function getHotelNameMap() {
  const hotels = db.prepare('SELECT id, name FROM hotels').all();
  return new Map(hotels.map(hotel => [String(hotel.id), String(hotel.name)]));
}

function toRoleLabel(row, member) {
  const roleIds = new Set(member?.roles?.cache?.keys?.() || []);

  if (roleIds.has(DEVELOPER_ROLE_ID)) return 'Developer';
  if (roleIds.has(OPERATIONS_MANAGER_ROLE_ID)) return 'Operations Manager';
  if (roleIds.has(TEAM_LEADER_ROLE_ID)) return 'Team Leader';
  if (roleIds.has(SME_ROLE_ID)) return 'SME';
  if (roleIds.has(TRAINEE_ROLE_ID)) return 'Trainee';
  if (roleIds.has(AGENT_ROLE_ID)) return 'Agent';

  const isDeveloper = db.prepare('SELECT 1 FROM developers WHERE discord_id = ?').get(row.discord_id);
  if (isDeveloper) return 'Developer';

  switch (String(row.role || '').toLowerCase()) {
    case 'developer':
      return 'Developer';
    case 'operations_manager':
      return 'Operations Manager';
    case 'team_leader':
      return 'Team Leader';
    case 'sme':
      return 'SME';
    case 'trainee':
      return 'Trainee';
    case 'applicant':
      return 'Applicant';
    case 'agent':
    default:
      return 'Agent';
  }
}

function toRouteLabel(roleLabel) {
  if (['Developer', 'Operations Manager', 'Team Leader'].includes(roleLabel)) {
    return '/admin';
  }
  return '/user';
}

function toSessionLabel(sessionKind) {
  return String(sessionKind || '').toLowerCase() === 'training' ? 'Training' : 'Live Shift';
}

function toSessionDurationHours(loginTime, nowMs) {
  const loginMs = parseDbTimestamp(loginTime, NaN);
  if (!Number.isFinite(loginMs)) return 0;
  return Math.max(0, (nowMs - loginMs) / (60 * 60 * 1000));
}

async function buildAdminHoursSnapshot(client) {
  const now = new Date();
  const nowMs = now.getTime();
  const hotelNames = getHotelNameMap();
  const guild = client?.guilds?.cache?.get(AAVGO_GUILD_ID) || null;
  const memberCache = guild?.members?.cache || null;

  const rows = db.prepare(`
    SELECT
      a.id,
      a.discord_id,
      a.username,
      a.role,
      a.team,
      a.agent_status,
      a.hotel_id,
      s.id AS active_session_id,
      s.session_kind,
      s.login_time
    FROM agents a
    LEFT JOIN sessions s
      ON s.agent_id = a.id
     AND s.status = 'active'
    WHERE lower(COALESCE(a.role, 'agent')) != 'applicant'
    ORDER BY
      CASE WHEN s.id IS NULL THEN 1 ELSE 0 END,
      lower(a.username) ASC
  `).all();

  const people = [];
  for (const row of rows) {
    const member = memberCache?.get?.(row.discord_id) || null;
    const displayName = member?.displayName || row.username || 'Unknown';
    const roleLabel = toRoleLabel(row, member);
    const totals = calculateAgentHourTotals(db, row.id, now);
    const dayHistory = buildPeriodHourHistory(db, row.id, 'day', now);
    const linkedHotel = row.hotel_id ? (hotelNames.get(String(row.hotel_id)) || String(row.hotel_id)) : 'Unassigned';
    const activeNow = Boolean(row.active_session_id);
    const activeSession = activeNow
      ? {
          kind: toSessionLabel(row.session_kind),
          loginTime: row.login_time,
          elapsedHours: Number(toSessionDurationHours(row.login_time, nowMs).toFixed(2))
        }
      : null;

    people.push({
      agentId: row.id,
      discordId: row.discord_id,
      username: row.username,
      displayName,
      role: roleLabel,
      route: toRouteLabel(roleLabel),
      team: row.team || 'Unassigned',
      agentStatus: row.agent_status || 'standby',
      linkedHotel,
      activeNow,
      activeSession,
      todayHours: Number(dayHistory.totalHours.toFixed(2)),
      weeklyHours: Number(totals.weeklyHours.toFixed(2)),
      monthlyHours: Number(totals.monthlyHours.toFixed(2)),
      allHours: Number(totals.allHours.toFixed(2))
    });
  }

  const teams = new Map();
  for (const person of people) {
    const key = person.team || 'Unassigned';
    const existing = teams.get(key) || {
      name: key,
      people: 0,
      activeNow: 0,
      todayHours: 0,
      weeklyHours: 0,
      monthlyHours: 0
    };
    existing.people += 1;
    existing.activeNow += person.activeNow ? 1 : 0;
    existing.todayHours += person.todayHours;
    existing.weeklyHours += person.weeklyHours;
    existing.monthlyHours += person.monthlyHours;
    teams.set(key, existing);
  }

  const teamSummaries = [...teams.values()]
    .map(team => ({
      ...team,
      todayHours: Number(team.todayHours.toFixed(2)),
      weeklyHours: Number(team.weeklyHours.toFixed(2)),
      monthlyHours: Number(team.monthlyHours.toFixed(2))
    }))
    .sort((a, b) => {
      if (a.name === 'Unassigned') return 1;
      if (b.name === 'Unassigned') return -1;
      return a.name.localeCompare(b.name);
    });

  const summary = people.reduce((acc, person) => {
    acc.totalPeople += 1;
    acc.activeNow += person.activeNow ? 1 : 0;
    acc.readyNow += String(person.agentStatus).toLowerCase() === 'ready' ? 1 : 0;
    acc.todayHours += person.todayHours;
    acc.weeklyHours += person.weeklyHours;
    acc.monthlyHours += person.monthlyHours;
    return acc;
  }, {
    totalPeople: 0,
    activeNow: 0,
    readyNow: 0,
    todayHours: 0,
    weeklyHours: 0,
    monthlyHours: 0
  });

  return {
    generatedAt: now.toISOString(),
    summary: {
      totalPeople: summary.totalPeople,
      activeNow: summary.activeNow,
      readyNow: summary.readyNow,
      todayHours: Number(summary.todayHours.toFixed(2)),
      weeklyHours: Number(summary.weeklyHours.toFixed(2)),
      monthlyHours: Number(summary.monthlyHours.toFixed(2)),
      weeklyHoursLabel: formatHours(summary.weeklyHours),
      monthlyHoursLabel: formatHours(summary.monthlyHours)
    },
    teams: teamSummaries,
    people
  };
}

function postJson(urlString, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      ...payload,
      token
    });
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;

    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Aavgo-Token': token,
        'X-Aavgo-Website-Token': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 20000
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => {
        const statusCode = Number(response.statusCode || 0);
        if (statusCode >= 200 && statusCode < 300) {
          resolve({ statusCode, body: responseBody });
          return;
        }

        reject(new Error(`Snapshot push failed (${statusCode}): ${responseBody || 'No response body.'}`));
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('Snapshot push timed out.'));
    });

    request.write(body);
    request.end();
  });
}

async function pushWebsiteHoursSnapshot(client, { silent = false } = {}) {
  const config = getWebsiteApiConfig();
  if (!config.token || !config.syncUrl) {
    return false;
  }

  if (websiteSyncInFlight) {
    return false;
  }

  websiteSyncInFlight = true;

  try {
    const snapshot = await buildAdminHoursSnapshot(client);
    await postJson(config.syncUrl, config.token, {
      ok: true,
      configured: true,
      source: 'bot_push',
      syncedAt: new Date().toISOString(),
      data: snapshot
    });

    if (!silent) {
      console.log(`[WEBSITE-SYNC] Pushed admin hours snapshot to ${config.syncUrl}`);
    }

    return true;
  } catch (error) {
    console.error('[WEBSITE-SYNC] Snapshot push failed:', error.message);
    return false;
  } finally {
    websiteSyncInFlight = false;
  }
}

function startWebsiteHoursSync(client) {
  const config = getWebsiteApiConfig();
  if (!config.token || websiteSyncTimer) {
    return;
  }

  if (!config.syncUrl) {
    console.log('[WEBSITE-SYNC] Disabled because AAVGO_WEBSITE_SYNC_URL is not configured.');
    return;
  }

  pushWebsiteHoursSnapshot(client).catch(error => {
    console.error('[WEBSITE-SYNC] Initial push crashed:', error.message);
  });

  websiteSyncTimer = setInterval(() => {
    pushWebsiteHoursSnapshot(client, { silent: true }).catch(error => {
      console.error('[WEBSITE-SYNC] Interval push crashed:', error.message);
    });
  }, config.syncIntervalMs);

  websiteSyncTimer.unref?.();
  console.log(`[WEBSITE-SYNC] Pushing admin hours snapshots to ${config.syncUrl} every ${config.syncIntervalMs}ms.`);
}

function buildRouter(client) {
  const { token } = getWebsiteApiConfig();

  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'aavgo-website-api' });
      }

      if (req.method === 'GET' && url.pathname === '/api/website/admin-hours') {
        const authHeader = String(req.headers.authorization || '');
        if (!token || authHeader !== `Bearer ${token}`) {
          return json(res, 401, { ok: false, error: 'Unauthorized.' });
        }

        const snapshot = await buildAdminHoursSnapshot(client);
        return json(res, 200, { ok: true, data: snapshot });
      }

      return json(res, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      console.error('[WEBSITE-API] Request failed:', error);
      return json(res, 500, { ok: false, error: 'Internal server error.' });
    }
  };
}

function startWebsiteApiServer(client) {
  const config = getWebsiteApiConfig();
  if (!config.token) {
    console.log('[WEBSITE-API] Disabled because AAVGO_WEBSITE_API_TOKEN is not configured.');
    return null;
  }

  if (websiteApiServer) {
    return websiteApiServer;
  }

  websiteApiServer = http.createServer(buildRouter(client));
  websiteApiServer.listen(config.port, config.host, () => {
    console.log(`[WEBSITE-API] Listening on ${config.host}:${config.port}`);
  });

  websiteApiServer.on('error', error => {
    console.error('[WEBSITE-API] Server error:', error.message);
  });

  startWebsiteHoursSync(client);

  return websiteApiServer;
}

function stopWebsiteApiServer() {
  if (websiteSyncTimer) {
    clearInterval(websiteSyncTimer);
    websiteSyncTimer = null;
  }

  if (!websiteApiServer) return;
  websiteApiServer.close(() => {
    console.log('[WEBSITE-API] Server stopped.');
  });
  websiteApiServer = null;
}

module.exports = {
  buildAdminHoursSnapshot,
  startWebsiteApiServer,
  stopWebsiteApiServer
};
