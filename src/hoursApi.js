const crypto = require('crypto');
const http = require('http');
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
let inboundServer = null;
const inboundRateWindows = new Map();
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

function getInboundHoursApiConfig() {
  const readToken = String(process.env.AAVGO_HOURS_API_V1_READ_TOKEN || '').trim();
  const writeSecret = String(process.env.AAVGO_HOURS_API_V1_WRITE_SECRET || '').trim();
  const port = boundedInteger(process.env.AAVGO_HOURS_API_V1_PORT || process.env.SERVER_PORT || process.env.PORT, 0, 1, 65535);
  const writeEnabled = enabled(process.env.AAVGO_HOURS_API_V1_WRITE_ENABLED);
  return {
    enabled: enabled(process.env.AAVGO_HOURS_API_V1_INBOUND_ENABLED),
    allowHttp: enabled(process.env.AAVGO_HOURS_API_V1_INBOUND_ALLOW_HTTP),
    configured: readToken.length >= 32 && port > 0,
    writeEnabled,
    writeConfigured: !writeEnabled || writeSecret.length >= 32,
    readToken,
    writeSecret,
    host: String(process.env.AAVGO_HOURS_API_V1_HOST || '0.0.0.0').trim() || '0.0.0.0',
    port
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

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function allowInboundRequest(request) {
  const key = String(request.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const window = inboundRateWindows.get(key) || { startedAt: now, count: 0 };
  if (now - window.startedAt >= 60 * 1000) {
    window.startedAt = now;
    window.count = 0;
  }
  window.count += 1;
  inboundRateWindows.set(key, window);
  return window.count <= 60;
}

function readRawBody(request, maximumBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function validManualAdjustment(payload) {
  const requestId = String(payload?.request_id || '').trim();
  const discordId = String(payload?.agent_discord_id || '').trim();
  const operation = String(payload?.operation || '').trim().toLowerCase();
  const hours = Number(payload?.hours);
  const mode = String(payload?.mode || 'shift').trim().toLowerCase();
  const shiftDate = String(payload?.shift_date || '').trim();
  const reason = String(payload?.reason || '').trim();
  const requestedBy = String(payload?.requested_by || 'partner-api').trim().slice(0, 100);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) return { error: 'invalid request_id' };
  if (!/^\d{10,25}$/.test(discordId)) return { error: 'invalid agent_discord_id' };
  if (!['add', 'remove'].includes(operation)) return { error: 'operation must be add or remove' };
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return { error: 'hours must be greater than 0 and no more than 24' };
  if (!['shift', 'training'].includes(mode)) return { error: 'mode must be shift or training' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) return { error: 'shift_date must use YYYY-MM-DD' };
  if (reason.length < 5 || reason.length > 500) return { error: 'reason must be 5 to 500 characters' };
  return { requestId, discordId, operation, hours, mode, shiftDate, reason, requestedBy };
}

function applyManualAdjustment(payload, rawBody) {
  const input = validManualAdjustment(payload);
  if (input.error) return { ok: false, status: 400, error: input.error };
  const prior = db.prepare('SELECT adjustment_id FROM hours_api_v1_requests WHERE request_id = ?').get(input.requestId);
  if (prior) return { ok: true, status: 200, duplicate: true, adjustment_id: prior.adjustment_id };

  const agent = db.prepare('SELECT id, hotel_id FROM agents WHERE discord_id = ?').get(input.discordId);
  if (!agent) return { ok: false, status: 404, error: 'agent not found' };
  const signedHours = input.operation === 'remove' ? -input.hours : input.hours;
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const transaction = db.transaction(() => {
    const adjustment = db.prepare(`
      INSERT INTO hour_adjustments (agent_id, hotel_id, shift_date, hours, mode, reason, note, effective_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      agent.hotel_id || null,
      input.shiftDate,
      signedHours,
      input.mode,
      input.reason,
      `Hours API v1 ${input.operation}; request ${input.requestId}`,
      `${input.shiftDate} 12:00:00`,
      `hours-api-v1:${input.requestedBy}`
    );
    db.prepare(`
      INSERT INTO hours_api_v1_requests (request_id, action, actor, payload_hash, adjustment_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.requestId, `manual_hours_${input.operation}`, input.requestedBy, payloadHash, adjustment.lastInsertRowid);
    return adjustment.lastInsertRowid;
  });
  return { ok: true, status: 201, adjustment_id: transaction() };
}

function isValidWriteSignature(request, rawBody, secret) {
  const timestamp = String(request.headers['x-aavgo-timestamp'] || '').trim();
  const signature = String(request.headers['x-aavgo-signature'] || '').trim();
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
  return secureEqual(signature, `sha256=${signPayload(secret, timestamp, rawBody)}`);
}

function buildInboundRouter() {
  const config = getInboundHoursApiConfig();
  return async (request, response) => {
    if (!allowInboundRequest(request)) return sendJson(response, 429, { ok: false, error: 'rate limit exceeded' });
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/v1/hours') {
      const token = url.searchParams.get('access_token') || request.headers['x-aavgo-read-token'];
      if (!secureEqual(token, config.readToken)) return sendJson(response, 401, { ok: false, error: 'unauthorized' });
      return sendJson(response, 200, buildHoursApiSnapshot());
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/hours/adjustments') {
      if (!config.writeEnabled) return sendJson(response, 403, { ok: false, error: 'hour corrections are disabled' });
      let rawBody;
      try {
        rawBody = await readRawBody(request);
      } catch (error) {
        return sendJson(response, 413, { ok: false, error: error.message });
      }
      if (!isValidWriteSignature(request, rawBody, config.writeSecret)) return sendJson(response, 401, { ok: false, error: 'unauthorized' });
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (_) {
        return sendJson(response, 400, { ok: false, error: 'invalid JSON' });
      }
      const result = applyManualAdjustment(payload, rawBody);
      return sendJson(response, result.status, result);
    }
    return sendJson(response, 404, { ok: false, error: 'not found' });
  };
}

function startInboundHoursApiV1() {
  const config = getInboundHoursApiConfig();
  if (!config.enabled) return;
  if (!config.configured) {
    console.warn('[HOURS-API-V1] Inbound API disabled: port and a 32+ character read token are required.');
    return;
  }
  if (!config.writeConfigured) {
    console.warn('[HOURS-API-V1] Inbound API disabled: the enabled write route requires a 32+ character write secret.');
    return;
  }
  if (!config.allowHttp) {
    console.warn('[HOURS-API-V1] Inbound API disabled: configure HTTPS termination, then explicitly set AAVGO_HOURS_API_V1_INBOUND_ALLOW_HTTP=true.');
    return;
  }
  if (inboundServer) return;
  inboundServer = http.createServer(buildInboundRouter());
  inboundServer.requestTimeout = 15000;
  inboundServer.headersTimeout = 16000;
  inboundServer.listen(config.port, config.host, () => {
    console.log(`[HOURS-API-V1] Inbound API listening on ${config.host}:${config.port}; hour corrections ${config.writeEnabled ? 'enabled' : 'disabled'}.`);
  });
  inboundServer.on('error', error => console.error('[HOURS-API-V1] Inbound API error:', error.message));
}

function stopInboundHoursApiV1() {
  if (!inboundServer) return;
  inboundServer.close();
  inboundServer = null;
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

module.exports = { applyManualAdjustment, buildHoursApiSnapshot, getHoursApiConfig, getInboundHoursApiConfig, publishHoursSnapshot, signPayload, startHoursApiV1, startInboundHoursApiV1, stopHoursApiV1, stopInboundHoursApiV1 };
