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

function getMonthYearFromOffset(nowInput = new Date(), monthOffset = 0) {
  const ph = getPhilippineParts(nowInput);
  const total = (ph.year * 12) + ph.month + Number(monthOffset || 0);
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return { year, month };
}

function getMonthLabel(year, month) {
  return new Date(Date.UTC(year, month, 1, 12, 0, 0)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Manila'
  });
}

function getMonthDailyHourHistory(db, agentId, monthOffset = 0, nowInput = new Date()) {
  const nowMs = nowInput instanceof Date ? nowInput.getTime() : parseDbTimestamp(nowInput, Date.now());
  const target = getMonthYearFromOffset(nowInput, monthOffset);
  const monthStartMs = Date.UTC(target.year, target.month, 1, 0, 0, 0) - PH_OFFSET_MS;
  const nextMonthStartMs = Date.UTC(target.year, target.month + 1, 1, 0, 0, 0) - PH_OFFSET_MS;
  const daysInMonth = new Date(Date.UTC(target.year, target.month + 1, 0, 12, 0, 0)).getUTCDate();

  const daily = Array.from({ length: daysInMonth }, () => ({
    shiftMs: 0,
    trainingMs: 0
  }));

  const sessions = db.prepare(`
    SELECT login_time, logout_time, status, session_kind
    FROM sessions
    WHERE agent_id = ?
      AND login_time < datetime(?, 'unixepoch')
      AND (logout_time IS NULL OR logout_time >= datetime(?, 'unixepoch'))
  `).all(agentId, Math.floor(nextMonthStartMs / 1000), Math.floor(monthStartMs / 1000));

  for (const session of sessions) {
    const loginMs = parseDbTimestamp(session.login_time, NaN);
    if (!Number.isFinite(loginMs)) continue;
    const rawLogoutMs = session.status === 'active' || !session.logout_time
      ? nowMs
      : parseDbTimestamp(session.logout_time, NaN);
    if (!Number.isFinite(rawLogoutMs) || rawLogoutMs <= loginMs) continue;

    const clippedStartMs = Math.max(loginMs, monthStartMs);
    const clippedEndMs = Math.min(rawLogoutMs, nextMonthStartMs);
    if (clippedEndMs <= clippedStartMs) continue;

    const isTraining = String(session.session_kind || 'shift').toLowerCase() === 'training';
    let cursor = clippedStartMs;
    while (cursor < clippedEndMs) {
      const dayIndex = Math.floor((cursor - monthStartMs) / DAY_MS);
      if (dayIndex < 0 || dayIndex >= daysInMonth) break;

      const dayStartMs = monthStartMs + (dayIndex * DAY_MS);
      const dayEndMs = dayStartMs + DAY_MS;
      const sliceEndMs = Math.min(dayEndMs, clippedEndMs);
      const sliceMs = Math.max(0, sliceEndMs - cursor);
      if (sliceMs > 0) {
        if (isTraining) daily[dayIndex].trainingMs += sliceMs;
        else daily[dayIndex].shiftMs += sliceMs;
      }
      cursor = sliceEndMs;
    }
  }

  const adjustments = db.prepare(`
    SELECT hours, created_at
    FROM hour_adjustments
    WHERE agent_id = ?
      AND created_at >= datetime(?, 'unixepoch')
      AND created_at < datetime(?, 'unixepoch')
  `).all(agentId, Math.floor(monthStartMs / 1000), Math.floor(nextMonthStartMs / 1000));

  for (const adjustment of adjustments) {
    const createdMs = parseDbTimestamp(adjustment.created_at, NaN);
    const hours = Number(adjustment.hours || 0);
    if (!Number.isFinite(createdMs) || !Number.isFinite(hours) || hours === 0) continue;

    const dayIndex = Math.floor((createdMs - monthStartMs) / DAY_MS);
    if (dayIndex < 0 || dayIndex >= daysInMonth) continue;
    daily[dayIndex].shiftMs += hours * HOUR_MS;
  }

  const days = daily.map((item, idx) => {
    const shiftHours = item.shiftMs / HOUR_MS;
    const trainingHours = item.trainingMs / HOUR_MS;
    return {
      day: idx + 1,
      shiftHours,
      trainingHours,
      totalHours: shiftHours + trainingHours
    };
  });

  const monthShiftHours = days.reduce((sum, d) => sum + d.shiftHours, 0);
  const monthTrainingHours = days.reduce((sum, d) => sum + d.trainingHours, 0);
  return {
    year: target.year,
    month: target.month,
    label: getMonthLabel(target.year, target.month),
    days,
    monthShiftHours,
    monthTrainingHours,
    monthTotalHours: monthShiftHours + monthTrainingHours
  };
}

function calculateAgentHourTotals(db, agentId, nowInput = new Date()) {
  const nowMs = nowInput instanceof Date ? nowInput.getTime() : parseDbTimestamp(nowInput, Date.now());
  const weeklyStartMs = getWeeklyResetStartMs(nowMs);
  const monthlyStartMs = getMonthlyResetStartMs(nowMs);

  const sessions = db.prepare(`
    SELECT login_time, logout_time, status, session_kind
    FROM sessions
    WHERE agent_id = ?
  `).all(agentId);

  const adjustments = db.prepare(`
    SELECT hours, created_at
    FROM hour_adjustments
    WHERE agent_id = ?
  `).all(agentId);

  const shiftTotals = { allMs: 0, weeklyMs: 0, monthlyMs: 0 };
  const trainingTotals = { allMs: 0, weeklyMs: 0, monthlyMs: 0 };

  for (const session of sessions) {
    const loginMs = parseDbTimestamp(session.login_time, NaN);
    if (!Number.isFinite(loginMs)) continue;

    const logoutMs = session.status === 'active' || !session.logout_time
      ? nowMs
      : parseDbTimestamp(session.logout_time, NaN);

    if (!Number.isFinite(logoutMs) || logoutMs <= loginMs) continue;

    const durationMs = logoutMs - loginMs;
    const bucket = String(session.session_kind || 'shift').toLowerCase() === 'training'
      ? trainingTotals
      : shiftTotals;

    bucket.allMs += durationMs;
    bucket.weeklyMs += getOverlapMs(loginMs, logoutMs, weeklyStartMs, nowMs);
    bucket.monthlyMs += getOverlapMs(loginMs, logoutMs, monthlyStartMs, nowMs);
  }

  for (const adjustment of adjustments) {
    const hours = Number(adjustment.hours || 0);
    if (!Number.isFinite(hours) || hours === 0) continue;

    const adjustmentMs = hours * HOUR_MS;
    shiftTotals.allMs += adjustmentMs;

    const createdMs = parseDbTimestamp(adjustment.created_at, NaN);
    if (Number.isFinite(createdMs) && createdMs >= weeklyStartMs) {
      shiftTotals.weeklyMs += adjustmentMs;
    }
    if (Number.isFinite(createdMs) && createdMs >= monthlyStartMs) {
      shiftTotals.monthlyMs += adjustmentMs;
    }
  }

  const combinedAllMs = shiftTotals.allMs + trainingTotals.allMs;
  const combinedWeeklyMs = shiftTotals.weeklyMs + trainingTotals.weeklyMs;
  const combinedMonthlyMs = shiftTotals.monthlyMs + trainingTotals.monthlyMs;

  return {
    allHours: combinedAllMs / HOUR_MS,
    weeklyHours: combinedWeeklyMs / HOUR_MS,
    monthlyHours: combinedMonthlyMs / HOUR_MS,
    shift: {
      allHours: shiftTotals.allMs / HOUR_MS,
      weeklyHours: shiftTotals.weeklyMs / HOUR_MS,
      monthlyHours: shiftTotals.monthlyMs / HOUR_MS
    },
    training: {
      allHours: trainingTotals.allMs / HOUR_MS,
      weeklyHours: trainingTotals.weeklyMs / HOUR_MS,
      monthlyHours: trainingTotals.monthlyMs / HOUR_MS
    },
    weeklyStartMs,
    monthlyStartMs
  };
}

module.exports = {
  calculateAgentHourTotals,
  getMonthDailyHourHistory,
  formatHours,
  getWeeklyResetStartMs,
  getMonthlyResetStartMs,
  parseDbTimestamp
};
