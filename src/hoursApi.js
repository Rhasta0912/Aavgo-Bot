const crypto = require('crypto');
const db = require('./database');
const { calculateAgentHourTotals } = require('./hours');

const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

let syncTimer = null;
let syncInFlight = false;
let nextRetryAt = 0;
let failureCount = 0;
const health = { lastSuccessAt: '', lastError: '', lastAttemptAt: '' };

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function getHoursApiConfig() {
  const rawUrl = String(process.env.AAVGO_HOURS_API_V1_URL || '').trim();
  const secret = String(process.env.AAVGO_HOURS_API_V1_SECRET || '').trim();
  let endpoint = null;
  try {
    endpoint = rawUrl ? new URL(rawUrl) : null;
  } catch (_) {}

  const configured = Boolean(endpoint && endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && secret.length >= 32);
  return {
    enabled: enabled(process.env.AAVGO_HOURS_API_V1_ENABLED),
    configured,
    endpoint,
    secret,
    intervalMs: boundedInteger(process.env.AAVGO_HOURS_API_V1_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, 24 * 60 * 60 * 1000),
    timeoutMs: boundedInteger(process.env.AAVGO_HOURS_API_V1_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 30000)
  };
}

function roundHours(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function buildHoursApiSnapshot(now = new Date()) {
  const activeSessions = new Map(db.prepare(`
    SELECT agent_id, hotel_id, session_kind, login_time
    FROM sessions
    WHERE status = 'active'
    ORDER BY id DESC
  `).all().map(session => [session.agent_id, session]));

  const agents = db.prepare(`
    SELECT id, discord_id, username, role, agent_status, team, hotel_id
    FROM agents
    ORDER BY username COLLATE NOCASE ASC
  `).all().map(agent => {
    const totals = calculateAgentHourTotals(db, agent.id, now);
    const active = activeSessions.get(agent.id) || null;
    return {
      discord_id: String(agent.discord_id),
      display_name: String(agent.username),
      role: String(agent.role || 'agent'),
      status: active ? 'active' : String(agent.agent_status || 'standby'),
      team: agent.team || null,
      hotel_id: active?.hotel_id || agent.hotel_id || null,
      active_session: active ? {
        kind: String(active.session_kind || 'shift'),
        started_at: new Date(active.login_time).toISOString()
      } : null,
      hours: {
        weekly: roundHours(totals.weeklyHours),
        monthly: roundHours(totals.monthlyHours),
        all_time: roundHours(totals.allHours),
        live_shift: {
          weekly: roundHours(totals.shift?.weeklyHours),
          monthly: roundHours(totals.shift?.monthlyHours),
          all_time: roundHours(totals.shift?.allHours)
        },
        training: {
          weekly: roundHours(totals.training?.weeklyHours),
          monthly: roundHours(totals.training?.monthlyHours),
          all_time: roundHours(totals.training?.allHours)
        }
      }
    };
  });

  return {
    api_version: 'v1',
    snapshot_id: crypto.randomUUID(),
    generated_at: now.toISOString(),
    timezone: 'Asia/Manila',
    hours_policy: {
      active_sessions: 'reported as active; excluded from finalized hour totals',
      closed_sessions: 'counted as completed full hours',
      manual_adjustments: 'included in totals'
    },
    agents
  };
}

function signPayload(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function publishHoursSnapshot() {
  const config = getHoursApiConfig();
  if (!config.enabled || !config.configured || syncInFlight || Date.now() < nextRetryAt) return false;

  syncInFlight = true;
  health.lastAttemptAt = new Date().toISOString();
  try {
    const snapshot = buildHoursApiSnapshot();
    const body = JSON.stringify(snapshot);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    timeout.unref?.();
    let response;
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Aavgo-Hours-API/1.0',
          'X-Aavgo-Api-Version': 'v1',
          'X-Aavgo-Timestamp': timestamp,
          'X-Aavgo-Snapshot-Id': snapshot.snapshot_id,
          'X-Aavgo-Signature': `sha256=${signPayload(config.secret, timestamp, body)}`
        },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`partner returned HTTP ${response.status}`);

    failureCount = 0;
    nextRetryAt = 0;
    health.lastSuccessAt = new Date().toISOString();
    health.lastError = '';
    console.log(`[HOURS-API-V1] Published ${snapshot.agents.length} agent hour records.`);
    return true;
  } catch (error) {
    failureCount += 1;
    const backoffMs = Math.min(MAX_BACKOFF_MS, 60000 * (2 ** Math.min(failureCount - 1, 6)));
    nextRetryAt = Date.now() + backoffMs;
    health.lastError = error.name === 'AbortError' ? 'request timed out' : error.message;
    console.warn(`[HOURS-API-V1] Publish failed; retrying in ${Math.ceil(backoffMs / 60000)} minute(s): ${health.lastError}`);
    return false;
  } finally {
    syncInFlight = false;
  }
}

function startHoursApiV1() {
  const config = getHoursApiConfig();
  if (!config.enabled) {
    console.log('[HOURS-API-V1] Disabled by AAVGO_HOURS_API_V1_ENABLED.');
    return;
  }
  if (!config.configured) {
    console.warn('[HOURS-API-V1] Disabled: HTTPS endpoint and a 32+ character shared secret are required.');
    return;
  }
  if (syncTimer) return;

  publishHoursSnapshot().catch(() => {});
  syncTimer = setInterval(() => publishHoursSnapshot().catch(() => {}), config.intervalMs);
  syncTimer.unref?.();
  console.log(`[HOURS-API-V1] Enabled; publishing every ${Math.round(config.intervalMs / 60000)} minute(s).`);
}

function stopHoursApiV1() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

module.exports = { buildHoursApiSnapshot, getHoursApiConfig, publishHoursSnapshot, signPayload, startHoursApiV1, stopHoursApiV1 };
