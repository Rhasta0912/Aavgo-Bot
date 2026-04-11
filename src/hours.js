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

function getDayResetStartMs(nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const ph = getPhilippineParts(now);
  return Date.UTC(ph.year, ph.month, ph.day, 0, 0, 0) - PH_OFFSET_MS;
}

function parseManualShiftDateStartMs(shiftDate) {
  const match = String(shiftDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;

  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - PH_OFFSET_MS;
  const check = getPhilippineParts(new Date(utcMs));
  if (check.year !== year || (check.month + 1) !== month || check.day !== day) return NaN;
  return utcMs;
}

function parseManualClockMinutes(value) {
  const match = String(value || '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return NaN;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return NaN;
  return (hours * 60) + minutes;
}

function getManualShiftTimestampMs(shiftDate, clockValue) {
  const dayStartMs = parseManualShiftDateStartMs(shiftDate);
  const clockMinutes = parseManualClockMinutes(clockValue);
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(clockMinutes)) return NaN;
  return dayStartMs + (clockMinutes * 60 * 1000);
}

function getAdjustmentReferenceMs(adjustment) {
  const effectiveAtMs = parseDbTimestamp(adjustment?.effective_at, NaN);
  if (Number.isFinite(effectiveAtMs)) return effectiveAtMs;

  const manualLoginMs = getManualShiftTimestampMs(adjustment?.shift_date, adjustment?.login_time);
  if (Number.isFinite(manualLoginMs)) return manualLoginMs;

  const shiftDateMs = parseManualShiftDateStartMs(adjustment?.shift_date);
  if (Number.isFinite(shiftDateMs)) return shiftDateMs + (12 * 60 * 60 * 1000);
  return parseDbTimestamp(adjustment?.created_at, NaN);
}

function getOverlapMs(startMs, endMs, rangeStartMs, rangeEndMs) {
  const overlapStart = Math.max(startMs, rangeStartMs);
  const overlapEnd = Math.min(endMs, rangeEndMs);
  return Math.max(0, overlapEnd - overlapStart);
}

function normalizeSessionKind(sessionKind) {
  return String(sessionKind || 'shift').toLowerCase() === 'training' ? 'training' : 'shift';
}

function normalizeAdjustmentMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'training') return 'training';
  return 'shift';
}

function mergeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];

  const sorted = intervals
    .filter(item => Number.isFinite(item?.startMs) && Number.isFinite(item?.endMs) && item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (sorted.length === 0) return [];

  const merged = [Object.assign({}, sorted[0])];
  for (let idx = 1; idx < sorted.length; idx += 1) {
    const next = sorted[idx];
    const current = merged[merged.length - 1];
    if (next.startMs <= current.endMs) {
      current.endMs = Math.max(current.endMs, next.endMs);
    } else {
      merged.push(Object.assign({}, next));
    }
  }
  return merged;
}

function buildMergedSessionIntervals(sessions, nowMs, rangeStartMs = Number.NEGATIVE_INFINITY, rangeEndMs = Number.POSITIVE_INFINITY) {
  const buckets = { shift: [], training: [] };
  for (const session of sessions || []) {
    const loginMs = parseDbTimestamp(session.login_time, NaN);
    if (!Number.isFinite(loginMs)) continue;

    const rawLogoutMs = session.status === 'active' || !session.logout_time
      ? nowMs
      : parseDbTimestamp(session.logout_time, NaN);
    if (!Number.isFinite(rawLogoutMs) || rawLogoutMs <= loginMs) continue;

    const clippedStartMs = Math.max(loginMs, rangeStartMs);
    const clippedEndMs = Math.min(rawLogoutMs, rangeEndMs);
    if (clippedEndMs <= clippedStartMs) continue;

    const kind = normalizeSessionKind(session.session_kind);
    buckets[kind].push({ startMs: clippedStartMs, endMs: clippedEndMs });
  }

  return {
    shift: mergeIntervals(buckets.shift),
    training: mergeIntervals(buckets.training)
  };
}

function distributeMergedIntervalsAcrossDays(intervals, daily, rangeStartMs, accumulatorKey) {
  for (const interval of intervals) {
    let cursor = interval.startMs;
    while (cursor < interval.endMs) {
      const dayIndex = Math.floor((cursor - rangeStartMs) / DAY_MS);
      if (dayIndex < 0 || dayIndex >= daily.length) break;

      const dayStartMs = rangeStartMs + (dayIndex * DAY_MS);
      const dayEndMs = dayStartMs + DAY_MS;
      const sliceEndMs = Math.min(dayEndMs, interval.endMs);
      const sliceMs = Math.max(0, sliceEndMs - cursor);
      if (sliceMs > 0) {
        daily[dayIndex][accumulatorKey] += sliceMs;
        daily[dayIndex].firstLoginMs = daily[dayIndex].firstLoginMs === null
          ? cursor
          : Math.min(daily[dayIndex].firstLoginMs, cursor);
        daily[dayIndex].lastLogoutMs = daily[dayIndex].lastLogoutMs === null
          ? sliceEndMs
          : Math.max(daily[dayIndex].lastLogoutMs, sliceEndMs);
      }
      cursor = sliceEndMs;
    }
  }
}

function sumIntervalDurations(intervals) {
  return (intervals || []).reduce((sum, item) => sum + Math.max(0, item.endMs - item.startMs), 0);
}

function sumIntervalOverlaps(intervals, rangeStartMs, rangeEndMs) {
  return (intervals || []).reduce((sum, item) => sum + getOverlapMs(item.startMs, item.endMs, rangeStartMs, rangeEndMs), 0);
}

function formatHours(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0';
  return num.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatHoursClock(value, options = {}) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0h 0m';

  const sign = num < 0 ? '-' : '';
  const absoluteSeconds = Math.round(Math.abs(num) * 60 * 60);
  const includeSeconds = options?.includeSeconds === true;

  if (includeSeconds) {
    const hours = Math.floor(absoluteSeconds / 3600);
    const minutes = Math.floor((absoluteSeconds % 3600) / 60);
    const seconds = absoluteSeconds % 60;
    return `${sign}${hours}h ${minutes}m ${seconds}s`;
  }

  const roundedMinutes = Math.round(absoluteSeconds / 60);
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return `${sign}${hours}h ${minutes}m`;
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

function getDateLabelFromMs(ms) {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'Asia/Manila'
  });
}

function getPeriodRangeMs(period, nowInput = new Date()) {
  const normalized = String(period || 'month').toLowerCase();

  if (normalized === 'day') {
    const startMs = getDayResetStartMs(nowInput);
    return {
      period: 'day',
      startMs,
      endMs: startMs + DAY_MS,
      label: getDateLabelFromMs(startMs)
    };
  }

  if (normalized === 'week') {
    const startMs = getWeeklyResetStartMs(nowInput);
    return {
      period: 'week',
      startMs,
      endMs: startMs + (7 * DAY_MS),
      label: 'Current Week'
    };
  }

  const startMs = getMonthlyResetStartMs(nowInput);
  const ph = getPhilippineParts(nowInput);
  const monthStartMs = Date.UTC(ph.year, ph.month, 1, 0, 0, 0) - PH_OFFSET_MS;
  const nextMonthStartMs = Date.UTC(ph.year, ph.month + 1, 1, 0, 0, 0) - PH_OFFSET_MS;
  return {
    period: 'month',
    startMs,
    endMs: nextMonthStartMs,
    label: getMonthLabel(ph.year, ph.month)
  };
}

function buildPeriodHourHistory(db, agentId, period = 'month', nowInput = new Date()) {
  const range = getPeriodRangeMs(period, nowInput);
  const dayCount = Math.max(1, Math.ceil((range.endMs - range.startMs) / DAY_MS));

  const daily = Array.from({ length: dayCount }, (_, index) => ({
    dayStartMs: range.startMs + (index * DAY_MS),
    shiftMs: 0,
    trainingMs: 0,
    firstLoginMs: null,
    lastLogoutMs: null
  }));

  const sessions = db.prepare(`
    SELECT login_time, logout_time, status, session_kind
    FROM sessions
    WHERE agent_id = ?
      AND login_time < datetime(?, 'unixepoch')
      AND (logout_time IS NULL OR logout_time >= datetime(?, 'unixepoch'))
  `).all(agentId, Math.floor(range.endMs / 1000), Math.floor(range.startMs / 1000));

  const nowMs = nowInput instanceof Date ? nowInput.getTime() : parseDbTimestamp(nowInput, Date.now());
  const mergedIntervals = buildMergedSessionIntervals(sessions, nowMs, range.startMs, range.endMs);
  distributeMergedIntervalsAcrossDays(mergedIntervals.shift, daily, range.startMs, 'shiftMs');
  distributeMergedIntervalsAcrossDays(mergedIntervals.training, daily, range.startMs, 'trainingMs');

  const adjustments = db.prepare(`
    SELECT hours, mode, created_at, effective_at, shift_date, login_time, logout_time
    FROM hour_adjustments
    WHERE agent_id = ?
      AND (
        (shift_date IS NOT NULL AND shift_date != '')
        OR (COALESCE(effective_at, created_at) >= datetime(?, 'unixepoch') AND COALESCE(effective_at, created_at) < datetime(?, 'unixepoch'))
      )
  `).all(agentId, Math.floor(range.startMs / 1000), Math.floor(range.endMs / 1000));

  for (const adjustment of adjustments) {
    const createdMs = getAdjustmentReferenceMs(adjustment);
    const hours = Number(adjustment.hours || 0);
    if (!Number.isFinite(createdMs) || !Number.isFinite(hours) || hours === 0) continue;

    const dayIndex = Math.floor((createdMs - range.startMs) / DAY_MS);
    if (dayIndex < 0 || dayIndex >= daily.length) continue;
    const adjustmentMode = normalizeAdjustmentMode(adjustment.mode);
    if (adjustmentMode === 'training') {
      daily[dayIndex].trainingMs += hours * HOUR_MS;
    } else {
      daily[dayIndex].shiftMs += hours * HOUR_MS;
    }

    const manualLoginMs = getManualShiftTimestampMs(adjustment.shift_date, adjustment.login_time);
    let manualLogoutMs = getManualShiftTimestampMs(adjustment.shift_date, adjustment.logout_time);
    if (Number.isFinite(manualLoginMs) && Number.isFinite(manualLogoutMs) && manualLogoutMs <= manualLoginMs) {
      manualLogoutMs += DAY_MS;
    }
    if (adjustmentMode === 'shift' && Number.isFinite(manualLoginMs)) {
      daily[dayIndex].firstLoginMs = daily[dayIndex].firstLoginMs === null
        ? manualLoginMs
        : Math.min(daily[dayIndex].firstLoginMs, manualLoginMs);
    }
    if (adjustmentMode === 'shift' && Number.isFinite(manualLogoutMs)) {
      daily[dayIndex].lastLogoutMs = daily[dayIndex].lastLogoutMs === null
        ? manualLogoutMs
        : Math.max(daily[dayIndex].lastLogoutMs, manualLogoutMs);
    }
  }

  const rows = daily.map(item => {
    const shiftHours = item.shiftMs / HOUR_MS;
    const trainingHours = item.trainingMs / HOUR_MS;
    return {
      dayStartMs: item.dayStartMs,
      dateLabel: getDateLabelFromMs(item.dayStartMs),
      firstLoginMs: item.firstLoginMs,
      lastLogoutMs: item.lastLogoutMs,
      shiftHours,
      trainingHours,
      totalHours: shiftHours + trainingHours
    };
  });

  const totalShiftHours = rows.reduce((sum, row) => sum + row.shiftHours, 0);
  const totalTrainingHours = rows.reduce((sum, row) => sum + row.trainingHours, 0);
  return {
    period: range.period,
    label: range.label,
    rows,
    totalShiftHours,
    totalTrainingHours,
    totalHours: totalShiftHours + totalTrainingHours
  };
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

  const mergedIntervals = buildMergedSessionIntervals(sessions, nowMs, monthStartMs, nextMonthStartMs);
  for (const interval of mergedIntervals.shift) {
    let cursor = interval.startMs;
    while (cursor < interval.endMs) {
      const dayIndex = Math.floor((cursor - monthStartMs) / DAY_MS);
      if (dayIndex < 0 || dayIndex >= daysInMonth) break;
      const dayStartMs = monthStartMs + (dayIndex * DAY_MS);
      const dayEndMs = dayStartMs + DAY_MS;
      const sliceEndMs = Math.min(dayEndMs, interval.endMs);
      const sliceMs = Math.max(0, sliceEndMs - cursor);
      if (sliceMs > 0) daily[dayIndex].shiftMs += sliceMs;
      cursor = sliceEndMs;
    }
  }
  for (const interval of mergedIntervals.training) {
    let cursor = interval.startMs;
    while (cursor < interval.endMs) {
      const dayIndex = Math.floor((cursor - monthStartMs) / DAY_MS);
      if (dayIndex < 0 || dayIndex >= daysInMonth) break;
      const dayStartMs = monthStartMs + (dayIndex * DAY_MS);
      const dayEndMs = dayStartMs + DAY_MS;
      const sliceEndMs = Math.min(dayEndMs, interval.endMs);
      const sliceMs = Math.max(0, sliceEndMs - cursor);
      if (sliceMs > 0) daily[dayIndex].trainingMs += sliceMs;
      cursor = sliceEndMs;
    }
  }

  const adjustments = db.prepare(`
    SELECT hours, mode, created_at, effective_at, shift_date
    FROM hour_adjustments
    WHERE agent_id = ?
      AND (
        (shift_date IS NOT NULL AND shift_date != '')
        OR (COALESCE(effective_at, created_at) >= datetime(?, 'unixepoch') AND COALESCE(effective_at, created_at) < datetime(?, 'unixepoch'))
      )
  `).all(agentId, Math.floor(monthStartMs / 1000), Math.floor(nextMonthStartMs / 1000));

  for (const adjustment of adjustments) {
    const createdMs = getAdjustmentReferenceMs(adjustment);
    const hours = Number(adjustment.hours || 0);
    if (!Number.isFinite(createdMs) || !Number.isFinite(hours) || hours === 0) continue;

    const dayIndex = Math.floor((createdMs - monthStartMs) / DAY_MS);
    if (dayIndex < 0 || dayIndex >= daysInMonth) continue;
    const adjustmentMode = normalizeAdjustmentMode(adjustment.mode);
    if (adjustmentMode === 'training') {
      daily[dayIndex].trainingMs += hours * HOUR_MS;
    } else {
      daily[dayIndex].shiftMs += hours * HOUR_MS;
    }
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
    SELECT hours, mode, created_at, effective_at, shift_date
    FROM hour_adjustments
    WHERE agent_id = ?
  `).all(agentId);

  const shiftTotals = { allMs: 0, weeklyMs: 0, monthlyMs: 0 };
  const trainingTotals = { allMs: 0, weeklyMs: 0, monthlyMs: 0 };
  const mergedIntervals = buildMergedSessionIntervals(sessions, nowMs);
  shiftTotals.allMs += sumIntervalDurations(mergedIntervals.shift);
  shiftTotals.weeklyMs += sumIntervalOverlaps(mergedIntervals.shift, weeklyStartMs, nowMs);
  shiftTotals.monthlyMs += sumIntervalOverlaps(mergedIntervals.shift, monthlyStartMs, nowMs);

  trainingTotals.allMs += sumIntervalDurations(mergedIntervals.training);
  trainingTotals.weeklyMs += sumIntervalOverlaps(mergedIntervals.training, weeklyStartMs, nowMs);
  trainingTotals.monthlyMs += sumIntervalOverlaps(mergedIntervals.training, monthlyStartMs, nowMs);

  for (const adjustment of adjustments) {
    const hours = Number(adjustment.hours || 0);
    if (!Number.isFinite(hours) || hours === 0) continue;

    const adjustmentMs = hours * HOUR_MS;
    const adjustmentMode = normalizeAdjustmentMode(adjustment.mode);
    const targetTotals = adjustmentMode === 'training' ? trainingTotals : shiftTotals;
    targetTotals.allMs += adjustmentMs;

    const createdMs = getAdjustmentReferenceMs(adjustment);
    if (Number.isFinite(createdMs) && createdMs >= weeklyStartMs) {
      targetTotals.weeklyMs += adjustmentMs;
    }
    if (Number.isFinite(createdMs) && createdMs >= monthlyStartMs) {
      targetTotals.monthlyMs += adjustmentMs;
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
  buildPeriodHourHistory,
  formatHours,
  formatHoursClock,
  getWeeklyResetStartMs,
  getMonthlyResetStartMs,
  getPeriodRangeMs,
  parseDbTimestamp
};
