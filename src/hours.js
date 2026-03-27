const PH_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseDbTimestamp(value, fallback = Date.now()) {
  if (!value) return fallback;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const text = String(value).trim();
  if (!text) return fallback;

  const normalized = text.includes('T') || text.includes('Z')
    ? text
    : `${text.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : fallback;
}

function getPhilippineParts(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const shifted = new Date(date.getTime() + PH_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    dayOfWeek: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

function getWeeklyResetStartMs(nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const ph = getPhilippineParts(now);
  const phMidnightUtcMs = Date.UTC(ph.year, ph.month, ph.day, 0, 0, 0) - PH_OFFSET_MS;
  const daysSinceMonday = (ph.dayOfWeek + 6) % 7;
  let startMs = phMidnightUtcMs - (daysSinceMonday * DAY_MS) + HOUR_MS;

  if (now.getTime() < startMs) {
    startMs -= 7 * DAY_MS;
  }

  return startMs;
}

function getMonthlyResetStartMs(nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const ph = getPhilippineParts(now);
  let startMs = Date.UTC(ph.year, ph.month, 1, 1, 0, 0) - PH_OFFSET_MS;

  if (now.getTime() < startMs) {
    startMs = Date.UTC(ph.year, ph.month - 1, 1, 1, 0, 0) - PH_OFFSET_MS;
  }

  return startMs;
}

function getOverlapMs(startMs, endMs, rangeStartMs, rangeEndMs) {
  const overlapStart = Math.max(startMs, rangeStartMs);
  const overlapEnd = Math.min(endMs, rangeEndMs);
  return Math.max(0, overlapEnd - overlapStart);
}

function formatHours(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0';
  return num.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function calculateAgentHourTotals(db, agentId, nowInput = new Date()) {
  const nowMs = nowInput instanceof Date ? nowInput.getTime() : parseDbTimestamp(nowInput, Date.now());
  const weeklyStartMs = getWeeklyResetStartMs(nowMs);
  const monthlyStartMs = getMonthlyResetStartMs(nowMs);

  const sessions = db.prepare(`
    SELECT login_time, logout_time, status
    FROM sessions
    WHERE agent_id = ?
  `).all(agentId);

  const adjustments = db.prepare(`
    SELECT hours, created_at
    FROM hour_adjustments
    WHERE agent_id = ?
  `).all(agentId);

  let allMs = 0;
  let weeklyMs = 0;
  let monthlyMs = 0;

  for (const session of sessions) {
    const loginMs = parseDbTimestamp(session.login_time, NaN);
    if (!Number.isFinite(loginMs)) continue;

    const logoutMs = session.status === 'active' || !session.logout_time
      ? nowMs
      : parseDbTimestamp(session.logout_time, NaN);

    if (!Number.isFinite(logoutMs) || logoutMs <= loginMs) continue;

    const durationMs = logoutMs - loginMs;
    allMs += durationMs;
    weeklyMs += getOverlapMs(loginMs, logoutMs, weeklyStartMs, nowMs);
    monthlyMs += getOverlapMs(loginMs, logoutMs, monthlyStartMs, nowMs);
  }

  for (const adjustment of adjustments) {
    const hours = Number(adjustment.hours || 0);
    if (!Number.isFinite(hours) || hours === 0) continue;

    const adjustmentMs = hours * HOUR_MS;
    allMs += adjustmentMs;

    const createdMs = parseDbTimestamp(adjustment.created_at, NaN);
    if (Number.isFinite(createdMs) && createdMs >= weeklyStartMs) {
      weeklyMs += adjustmentMs;
    }
    if (Number.isFinite(createdMs) && createdMs >= monthlyStartMs) {
      monthlyMs += adjustmentMs;
    }
  }

  return {
    allHours: allMs / HOUR_MS,
    weeklyHours: weeklyMs / HOUR_MS,
    monthlyHours: monthlyMs / HOUR_MS,
    weeklyStartMs,
    monthlyStartMs
  };
}

module.exports = {
  calculateAgentHourTotals,
  formatHours,
  getWeeklyResetStartMs,
  getMonthlyResetStartMs,
  parseDbTimestamp
};
