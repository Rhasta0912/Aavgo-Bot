require('dotenv').config();
const path = require('path');
const { Client, GatewayIntentBits, Collection, REST, Routes, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const db = require('./database');
const auth = require('./auth');
const { HOTEL_CHOICES } = require('./commands');
const tools = require('./tools');
const profilePanel = require('./profilePanel');
const devTodo = require('./devTodo');
const { upsertBotStatusCard } = require('./botStatus');
const REAL_NAME_TUTORIAL_DIR = path.join(__dirname, 'assets', 'real-name-tutorial');
const NEWCOMER_CHANNEL_ID = '1482259779991764992';
const OPERATIONS_MANAGER_ROLE_ID = '1482226842047090809';
const TEAM_LEADER_ROLE_ID = '1482732583660818636';
const SME_ROLE_ID = '1482382342621233153';
const AAVGO_GUILD_ID = '1482220918355922974';
const LOGIN_CHANNEL_ID = '1482228169485582446';
const ATTENDANCE_CHANNEL_ID = '1489840627209470022';
const ATTENDANCE_PROTOTYPE_CHANNEL_ID = '1494866014461104128';
const TL_SME_LOGIN_CHANNEL_ID = '1494867053604245554';
const TEST_ROLE_ID = '1487369607772766208';
const ATTENDANCE_LOGIN_REMINDER_DELAY_MS = 30 * 60 * 1000;
const ATTENDANCE_TEST_DELAY_MS = 10 * 1000;
const ATTENDANCE_LOGOUT_REPLY_DELETE_MS = 10 * 1000;
const ATTENDANCE_CONFIRM_SUCCESS_DELETE_MS = 10 * 1000;
const ATTENDANCE_BACKDATED_CONFIRM_THRESHOLD_MS = 2 * 60 * 1000;
const ATTENDANCE_TIME_ZONE = 'Asia/Manila';
const ATTENDANCE_REMINDER_BUTTON_PREFIX = 'attendance_reminder';
const ATTENDANCE_ACTION_BUTTON_PREFIX = 'attendance_action';
const DEFAULT_TEMP_MESSAGE_TTL_MS = 10 * 60 * 1000;
const SHORT_TEMP_MESSAGE_TTL_MS = 60 * 1000;
const TRAINING_VOICE_CHANNEL_IDS = [
  '1484706127685091415',
  '1484854340249190422',
  '1484854380254466058',
  '1484854396717236244',
  '1495013995088969798'
];
const HOTEL_LIVE_VOICE_CHANNEL_IDS = {
  BW_TO: '1493890379857133628',
  GICP: '1494857168049143838',
  RMDA: '1493674598233804842',
  SUP8: '1493674598233804842',
  AD1: '1494857257647603822',
  TRVL: '1494857143046897695',
  DIBS: '1494857111505469611',
  PROS: '1482249225398915102',
  GLDL: '1493674469980377088',
  INFL: '1494857730387742760',
  VALS: '1493890419543638107',
  BAYT: '1494857758099636275',
  ANPI: '1494857785828184125',
  ECON: '1482225519977041981',
  BUEN: '1493763350448963615',
  THOK: '1494858037683421234',
  BWPE: '1501086191280324710',
  BRNT: '1494858131094900817'
};

function normalizeAutocompleteToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function buildHotelAutocompleteChoices(query, includeGlobal = false) {
  const normalizedQuery = normalizeAutocompleteToken(query);
  const choices = includeGlobal
    ? [{ name: 'Global (All Hotels)', value: 'GLOBAL' }, ...HOTEL_CHOICES]
    : [...HOTEL_CHOICES];

  const scored = choices
    .map(choice => ({
      ...choice,
      score: normalizeAutocompleteToken(choice.name).includes(normalizedQuery) || normalizeAutocompleteToken(choice.value).includes(normalizedQuery)
        ? 1
        : 0
    }))
    .filter(choice => !normalizedQuery || choice.score > 0);

  const sorted = scored
    .sort((a, b) => {
      if (a.name === 'Global (All Hotels)') return -1;
      if (b.name === 'Global (All Hotels)') return 1;
      if (a.score !== b.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 25)
    .map(({ name, value }) => ({ name, value }));

  if (sorted.length === 0 && includeGlobal) {
    return [{ name: 'Global (All Hotels)', value: 'GLOBAL' }];
  }

  return sorted;
}

const QI_RV_TEAM_VOICE_CHANNEL_IDS = {
  'Team 1': '1482225371398017044',
  'Team 3': '1493890481363484755'
};
const TEAM_ROLE_IDS = {
  'Team 1': '1482290433236402216',
  'Team 2': '1482255399510872105',
  'Team 3': '1482290586831552534'
};
const pendingAttendanceLoginReminders = new Map();
const pendingAttendanceActionConfirmations = new Map();
const scheduledAttendanceActionsByUser = new Map();

const ATTENDANCE_HOTEL_KEYWORDS = {
  BW_TO: ['indianhead', 'magnuson', 'ironwood'],
  GICP: ['garden inn', 'campsite', 'gicp'],
  RMDA: ['ramada', 'super 8', 'super8', 'sup8', 'rmda'],
  AD1: ['ad1'],
  TRVL: ['travelodge', 'trvl'],
  DIBS: ['days inn bishop', 'day inns bishop', 'day inn bishop', 'dibs', 'bishop'],
  PROS: ['prospero', 'flagship'],
  GLDL: ['glendale', 'leef'],
  INFL: ['fingerlakes', 'inn at the fingerlakes', 'infl'],
  VALS: ['value suites', 'vals'],
  BAYT: ['bayside', 'townhouse'],
  ANPI: ['anchor beach', 'pacific inn', 'anpi'],
  ECON: ['econolodge', 'econ'],
  BUEN: ['buenavista', 'buena vista', 'buen'],
  QI_RV: ['quality inn russellville', 'quality inn russelville', 'quality russellville', 'quality russelville', 'qi rv', 'russellville', 'russelville'],
  THOK: ['thousand oaks', 'thousandoaks', 'thok'],
  BRNT: ['brentwood', 'brnt'],
  WGFR: ['wyndham garden fresno', 'windham garden fresno', 'garden fresno', 'wg fresno', 'wgfr'],
  BWSF: ['brentwood springfield', 'bw springfield', 'bwsf'],
  LQST: ['la quinta stockton', 'lq stockton', 'lqst'],
  LQFR: ['la quinta fresno', 'lq fresno', 'lqfr'],
  BWVI: ['brentwood visalia', 'bw visalia', 'bwvi'],
  BWPE: ['bw petaluma', 'petaluma', 'bwpetaluma']
};

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAttendanceText(content) {
  return String(content || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getTimeZoneDateParts(timestampMs, timeZone = ATTENDANCE_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(new Date(timestampMs));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function getTimeZoneOffsetMs(timestampMs, timeZone = ATTENDANCE_TIME_ZONE) {
  const parts = getTimeZoneDateParts(timestampMs, timeZone);
  const asUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtcMs - timestampMs;
}

function buildTimeZoneTimestampMs({ year, month, day, hour, minute, second = 0 }, timeZone = ATTENDANCE_TIME_ZONE) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  return utcGuess - offsetMs;
}

function shouldHandleAttendancePrototypeMessage(message) {
  if (!message?.guild || message?.author?.bot) return false;
  const channelId = String(message.channelId);
  return channelId === ATTENDANCE_CHANNEL_ID || channelId === ATTENDANCE_PROTOTYPE_CHANNEL_ID;
}

function parseAttendanceAction(content) {
  const text = String(content || '');
  const hasLogin = /\blog\s*in\b/i.test(text) || /\blogin\b/i.test(text);
  const hasLogout = /\blog\s*out\b/i.test(text) || /\blogout\b/i.test(text);
  if (hasLogin) return 'login';
  if (hasLogout) return 'logout';
  return null;
}

function normalizeDiscordRoleName(roleName) {
  return String(roleName || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function hasTrainingAttendanceRole(member) {
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some(role => {
    const roleName = normalizeDiscordRoleName(role?.name);
    return roleName === 'trainee' || roleName === 'trainees';
  });
}

function parseAttendanceMode(content, member = null) {
  const text = String(content || '');
  if (/\b(training|shadowing)\b/i.test(text)) return 'training';
  if (/\b(live|on\s*shift|onshift)\b/i.test(text)) return 'shift';
  if (hasTrainingAttendanceRole(member)) return 'training';
  return 'shift';
}

function parseAttendanceTargetTime(content, nowMs = Date.now()) {
  const source = String(content || '');
  const nowParts = getTimeZoneDateParts(nowMs, ATTENDANCE_TIME_ZONE);

  const pickClosestAttendanceCandidate = candidateMs => {
    const offsets = [0, 12 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
    let bestMs = candidateMs;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (const offset of offsets) {
      const optionMs = candidateMs + offset;
      const diff = Math.abs(optionMs - nowMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMs = optionMs;
      }
    }

    return bestMs;
  };

  const amPmMatch = source.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m?\.?|p\.?m?\.?)\b/i);
  if (amPmMatch) {
    const hourRaw = Number(amPmMatch[1]);
    const minuteRaw = Number(amPmMatch[2] || 0);
    const suffix = String(amPmMatch[3] || '').toLowerCase();
    if (hourRaw >= 1 && hourRaw <= 12 && minuteRaw >= 0 && minuteRaw <= 59) {
      let hours24 = hourRaw % 12;
      if (suffix.startsWith('p')) hours24 += 12;
      let candidateMs = buildTimeZoneTimestampMs({
        year: nowParts.year,
        month: nowParts.month,
        day: nowParts.day,
        hour: hours24,
        minute: minuteRaw,
        second: 0
      }, ATTENDANCE_TIME_ZONE);
      return { targetMs: pickClosestAttendanceCandidate(candidateMs), explicit: true };
    }
  }

  const militaryMatch = source.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (militaryMatch) {
    const hours24 = Number(militaryMatch[1]);
    const minuteRaw = Number(militaryMatch[2] || 0);
    let candidateMs = buildTimeZoneTimestampMs({
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: hours24,
      minute: minuteRaw,
      second: 0
    }, ATTENDANCE_TIME_ZONE);
    if (candidateMs < nowMs - (6 * 60 * 60 * 1000)) {
      candidateMs += (24 * 60 * 60 * 1000);
    }
    return { targetMs: candidateMs, explicit: true };
  }

  return { targetMs: nowMs, explicit: false };
}

function resolveAttendanceLogoutTimeMs(content, nowMs = Date.now()) {
  const { targetMs, explicit } = parseAttendanceTargetTime(content, nowMs);
  if (!explicit || !Number.isFinite(Number(targetMs))) {
    return nowMs;
  }

  return Number(targetMs);
}

function resolveAttendanceTeamName(member) {
  if (!member) return null;
  if (member.roles?.cache?.has(TEAM_ROLE_IDS['Team 1'])) return 'Team 1';
  if (member.roles?.cache?.has(TEAM_ROLE_IDS['Team 2'])) return 'Team 2';
  if (member.roles?.cache?.has(TEAM_ROLE_IDS['Team 3'])) return 'Team 3';
  const dbTeam = db.prepare('SELECT team FROM agents WHERE discord_id = ?').get(member.id)?.team;
  return auth.normalizeTeamInput(dbTeam) || null;
}

function detectAttendanceHotelId(content) {
  const normalized = normalizeAttendanceText(content);
  if (!normalized) return 'AD1';

  let best = null;
  for (const [hotelId, phrases] of Object.entries(ATTENDANCE_HOTEL_KEYWORDS)) {
    let score = 0;
    let lastIndex = -1;
    for (const phrase of phrases) {
      const expression = new RegExp(`\\b${escapeRegex(phrase).replace(/\s+/g, '\\s+')}\\b`, 'gi');
      let match;
      while ((match = expression.exec(normalized)) !== null) {
        score += (phrase.split(/\s+/).filter(Boolean).length * 100) + phrase.length;
        lastIndex = Math.max(lastIndex, match.index);
      }
    }
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && lastIndex > best.lastIndex)) {
      best = { hotelId, score, lastIndex };
    }
  }

  if (best?.hotelId) return best.hotelId;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const maxWindow = Math.min(4, tokens.length);
  for (let size = maxWindow; size >= 1; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(' ');
      const aliasHotel = auth.normalizeHotelInput(phrase);
      if (aliasHotel && aliasHotel !== 'TEAM_SHIFT') return aliasHotel;
    }
  }

  const aliasFromFull = auth.normalizeHotelInput(content);
  if (aliasFromFull && aliasFromFull !== 'TEAM_SHIFT') return aliasFromFull;
  return 'AD1';
}

function pickTrainingVoiceChannelId(seedValue = '') {
  const pool = TRAINING_VOICE_CHANNEL_IDS.filter(Boolean);
  if (pool.length === 0) return null;
  const seedText = String(seedValue || Date.now());
  let hash = 0;
  for (const char of seedText) {
    hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  }
  return pool[hash % pool.length] || pool[0];
}

function resolveAttendanceVoiceChannelId({ hotelId, mode, teamName, userId }) {
  if (mode === 'training') {
    return pickTrainingVoiceChannelId(userId || `${teamName || 'team'}:${hotelId || 'hotel'}`);
  }
  if (hotelId === 'QI_RV') {
    return QI_RV_TEAM_VOICE_CHANNEL_IDS[teamName] || QI_RV_TEAM_VOICE_CHANNEL_IDS['Team 3'];
  }
  return HOTEL_LIVE_VOICE_CHANNEL_IDS[hotelId] || HOTEL_LIVE_VOICE_CHANNEL_IDS.AD1;
}

function isTestRoleMember(member) {
  return Boolean(member?.roles?.cache?.has(TEST_ROLE_ID));
}

function getAttendanceDelayMs(member) {
  return isTestRoleMember(member) ? ATTENDANCE_TEST_DELAY_MS : ATTENDANCE_LOGIN_REMINDER_DELAY_MS;
}

function formatAttendanceTimeLabel(ms) {
  const datePart = new Date(ms).toLocaleDateString('en-PH', {
    timeZone: ATTENDANCE_TIME_ZONE,
    month: 'short',
    day: 'numeric'
  });
  const timePart = new Date(ms).toLocaleTimeString('en-PH', {
    timeZone: ATTENDANCE_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  return `${datePart} ${timePart} PHT`;
}

function formatDurationFromMs(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSeconds <= 0) return 'right now';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && hours === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function buildAttendanceBackdateImpact(action, targetMs, nowMs = Date.now()) {
  if (!Number.isFinite(Number(targetMs)) || !Number.isFinite(Number(nowMs))) return null;
  const diffMs = Number(nowMs) - Number(targetMs);
  if (diffMs < ATTENDANCE_BACKDATED_CONFIRM_THRESHOLD_MS) return null;

  const impactDuration = formatDurationFromMs(diffMs);
  const targetLabel = formatAttendanceTimeLabel(targetMs);
  const isLogin = action === 'login';
  const actionLabel = isLogin ? 'login' : 'logout';
  const impactLabel = isLogin
    ? `Adds about ${impactDuration} compared with logging in right now.`
    : `Deducts about ${impactDuration} compared with logging out right now.`;

  return {
    impactDuration,
    impactLabel,
    description:
      `Are you sure you want to backdate this ${actionLabel} to **${targetLabel}**?\n\n` +
      (isLogin
        ? `If you confirm, the shift will start from that time and add about **${impactDuration}** to the tracked shift.`
        : `If you confirm, the shift will end at that time and deduct about **${impactDuration}** from the tracked shift.`)
  };
}

function buildAttendanceActionKey(userId, action) {
  return `${userId}:${action}`;
}

function upsertAttendanceQueuedAction(key, entry) {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO attendance_action_queue (
        action_key,
        guild_id,
        user_id,
        action,
        hotel_id,
        mode,
        target_ms,
        is_test_role,
        time_explicit,
        team_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      String(entry.guildId || ''),
      String(entry.userId || ''),
      String(entry.action || ''),
      entry.hotelId || null,
      entry.mode || null,
      Number.isFinite(Number(entry.targetMs)) ? Math.floor(Number(entry.targetMs)) : Date.now(),
      entry.isTestRole ? 1 : 0,
      entry.timeExplicit ? 1 : 0,
      entry.teamName || null
    );
  } catch (error) {
    console.warn('[ATTENDANCE] Failed to persist scheduled action:', error.message);
  }
}

function deleteAttendanceQueuedAction(key) {
  try {
    db.prepare('DELETE FROM attendance_action_queue WHERE action_key = ?').run(String(key || ''));
  } catch (error) {
    console.warn('[ATTENDANCE] Failed to clear scheduled action queue row:', error.message);
  }
}

function cancelAttendanceQueuedAction(userId, action = 'login') {
  const key = buildAttendanceActionKey(userId, action);
  const existing = scheduledAttendanceActionsByUser.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  scheduledAttendanceActionsByUser.delete(key);
  deleteAttendanceQueuedAction(key);
}

function getAttendanceActionDelayMs(entry) {
  if (entry?.action === 'logout') return 0;
  if (entry?.timeExplicit) return Math.max(0, Number(entry.targetMs || 0) - Date.now());
  if (entry?.isTestRole) return ATTENDANCE_TEST_DELAY_MS;
  return Math.max(0, Number(entry?.targetMs || 0) - Date.now());
}

async function executeScheduledAttendanceAction(client, entry) {
  const guild = client.guilds.cache.get(entry.guildId) || await client.guilds.fetch(entry.guildId).catch(() => null);
  if (!guild) return;
  const member = await guild.members.fetch(entry.userId).catch(() => null);
  if (!member) return;

  const previewOnly = entry?.previewOnly === true;
  const effectiveMs = entry.isTestRole ? Date.now() : entry.targetMs;
  if (entry.action === 'login') {
    if (previewOnly) {
      console.log(`[ATTENDANCE] Preview-only login skipped for ${entry.userId}.`);
      return;
    }
    try {
      const loginTimeIso = new Date(effectiveMs).toISOString();
      const result = await auth.handleAttendanceTextLogin({
        client,
        guild,
        member,
        hotelId: entry.hotelId,
        sessionMode: entry.mode,
        loginTimeIso
      });
        if (!result?.ok) {
          console.warn(`[ATTENDANCE] Scheduled login failed for ${entry.userId}`);
        }
      } finally {
        await auth.setAttendanceQueueRole(member, false).catch(() => {});
      }
      return;
    }

    if (entry.action === 'logout') {
      if (previewOnly) {
        console.log(`[ATTENDANCE] Preview-only logout skipped for ${entry.userId}.`);
        return;
      }
      cancelAttendanceQueuedAction(entry.userId, 'login');
      auth.clearAttendanceReactionTimer(entry.userId);
      await auth.setAttendanceQueueRole(member, false).catch(() => {});
      const logoutTimeIso = new Date(effectiveMs).toISOString();
      const result = await auth.handleAttendanceTextLogout({
        client,
        guild,
        member,
      logoutTimeIso
    });
    if (!result?.ok) {
      console.warn(`[ATTENDANCE] Scheduled logout failed for ${entry.userId}`);
    }
  }
}

function scheduleAttendanceActionExecution(client, entry, delayMs) {
  const key = buildAttendanceActionKey(entry.userId, entry.action);
  const existing = scheduledAttendanceActionsByUser.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  if (!entry?.previewOnly) {
    upsertAttendanceQueuedAction(key, entry);
  }

  const runNow = async () => {
    scheduledAttendanceActionsByUser.delete(key);
    deleteAttendanceQueuedAction(key);
    try {
      await executeScheduledAttendanceAction(client, entry);
    } catch (error) {
      console.warn('[ATTENDANCE] Scheduled action execution failed:', error.message);
    }
  };

  if (delayMs <= 0) {
    runNow();
    return;
  }

  const timer = setTimeout(runNow, delayMs);
  timer.unref?.();
  scheduledAttendanceActionsByUser.set(key, { timer, entry, createdAt: Date.now() });
}

function recoverScheduledAttendanceActions(client) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT action_key, guild_id, user_id, action, hotel_id, mode, target_ms, is_test_role, time_explicit, team_name
      FROM attendance_action_queue
      ORDER BY created_at ASC
    `).all();
  } catch (error) {
    console.warn('[ATTENDANCE] Failed to read queued actions during startup:', error.message);
    return;
  }

  if (!Array.isArray(rows) || rows.length === 0) return;

  let restoredCount = 0;
  for (const row of rows) {
      const entry = {
        guildId: String(row.guild_id || ''),
        userId: String(row.user_id || ''),
        action: String(row.action || ''),
        hotelId: row.hotel_id || null,
      mode: row.mode || null,
      targetMs: Number.isFinite(Number(row.target_ms)) ? Number(row.target_ms) : Date.now(),
      isTestRole: Number(row.is_test_role || 0) === 1,
        timeExplicit: Number(row.time_explicit || 0) === 1,
        teamName: row.team_name || null
      };

      if (entry.previewOnly) {
        const fallbackKey = String(row.action_key || buildAttendanceActionKey(entry.userId, entry.action));
        deleteAttendanceQueuedAction(fallbackKey);
        continue;
      }

      if (!entry.guildId || !entry.userId || !entry.action) {
        const fallbackKey = String(row.action_key || buildAttendanceActionKey(entry.userId, entry.action));
        deleteAttendanceQueuedAction(fallbackKey);
        continue;
    }

    scheduleAttendanceActionExecution(client, entry, getAttendanceActionDelayMs(entry));
    restoredCount += 1;
  }

  console.log(`[ATTENDANCE] Restored ${restoredCount} queued attendance action(s) on startup.`);
}

function scheduleAttendanceLoginReminder(message, context) {
  const userId = message?.author?.id;
  if (!userId) return;

  const defaultDelayMs = getAttendanceDelayMs(context.member);
  const requestedDelayMs = Number(context?.reminderDelayMs);
  const delayMs = Number.isFinite(requestedDelayMs)
    ? Math.max(0, Math.floor(requestedDelayMs))
    : defaultDelayMs;
  const usesScheduledDelay = context?.useScheduledDelay === true;
  const targetLabel = context?.targetLabel || (Number.isFinite(context?.targetMs) ? formatAttendanceTimeLabel(context.targetMs) : null);
  const estimatedDelayLabel = formatDurationFromMs(delayMs);
  const reminderToken = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const existing = pendingAttendanceLoginReminders.get(userId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(async () => {
    pendingAttendanceLoginReminders.delete(userId);
    try {
      const reminderEmbed = new EmbedBuilder()
        .setTitle('Login Reminder')
        .setDescription(
          usesScheduledDelay && targetLabel
            ? `Your scheduled login time (**${targetLabel}**) is now due.\nPlease join your assigned voice channel now.`
            : `It has been ${delayMs === ATTENDANCE_TEST_DELAY_MS ? '10 seconds (test mode)' : '30 minutes'} since your attendance message.\nPlease join your assigned voice channel now.`
        )
        .setColor(0xFEE75C)
        .setFooter({ text: 'Aavgo Operations - Attendance Reminder' })
        .setTimestamp();

      const joinButton = new ButtonBuilder()
        .setCustomId(`shift_call_join:${context.voiceChannelId}`)
        .setLabel('Join Voice')
        .setStyle(ButtonStyle.Primary);

      await message.author.send({
        embeds: [reminderEmbed],
        components: [new ActionRowBuilder().addComponents(joinButton)]
      });
    } catch (error) {
      console.warn(`[ATTENDANCE] Failed to send voice reminder DM to ${userId}:`, error.message);
    }
  }, delayMs);

  timer.unref?.();
  pendingAttendanceLoginReminders.set(userId, {
    timer,
    reminderToken,
    createdAt: Date.now(),
    messageId: message.id
  });

  const preferenceEmbed = new EmbedBuilder()
    .setTitle('Attendance Reminder Preference')
    .setDescription(
      usesScheduledDelay && targetLabel
        ? (
          'You posted a `log in` attendance message.\n' +
          `Do you want to keep a reminder DM for your scheduled time (**${targetLabel}**)?\n` +
          `Estimated reminder in: **${estimatedDelayLabel}**.\n\n` +
          'If you ignore this, the reminder will still be sent.'
        )
        : (
          'You posted a `log in` attendance message.\n' +
          `Do you want to keep a reminder DM for ${delayMs === ATTENDANCE_TEST_DELAY_MS ? '10 seconds (test)' : '30 minutes'} later?\n\n` +
          'If you ignore this, the reminder will still be sent.'
        )
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations - Attendance Reminder' })
    .setTimestamp();

  const yesButton = new ButtonBuilder()
    .setCustomId(`${ATTENDANCE_REMINDER_BUTTON_PREFIX}:yes:${reminderToken}`)
    .setLabel('Yes, Remind Me')
    .setStyle(ButtonStyle.Success);
  const noButton = new ButtonBuilder()
    .setCustomId(`${ATTENDANCE_REMINDER_BUTTON_PREFIX}:no:${reminderToken}`)
    .setLabel("Don't Remind Me")
    .setStyle(ButtonStyle.Secondary);

  message.author.send({
    embeds: [preferenceEmbed],
    components: [new ActionRowBuilder().addComponents(yesButton, noButton)]
  }).catch(error => {
    console.warn(`[ATTENDANCE] Failed to send reminder preference DM to ${userId}:`, error.message);
  });
}

async function sendAttendanceActionConfirmation(message, context) {
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const userId = message.author.id;
  const isLogin = context.action === 'login';
  const modeLabel = context.mode === 'training' ? 'Training' : 'Live Shift';
  const targetLabel = formatAttendanceTimeLabel(context.targetMs);
  const hotelLabel = isLogin ? auth.getCombinedHotelLabel(context.hotelId) : null;
  const detectedText = String(message.content || '').trim();
  const impactDescription = context?.pastImpact?.description || null;
  const impactLabel = context?.pastImpact?.impactLabel || null;
  const requiresManualConfirm = context?.requiresManualConfirm === true || Boolean(impactDescription);

    const pendingEntry = {
      token,
      action: context.action,
      userId,
      guildId: message.guild.id,
    hotelId: context.hotelId,
    mode: context.mode,
    targetMs: context.targetMs,
    isTestRole: context.isTestRole,
    timeExplicit: context.timeExplicit === true,
    teamName: context.teamName,
    modeLabel,
      targetLabel,
      hotelLabel,
      detectedText,
      previewOnly: context.previewOnly === true,
      requiresManualConfirm,
      impactDescription,
      impactLabel,
      promptCleanupTimer: null
    };
  pendingAttendanceActionConfirmations.set(token, pendingEntry);

  const confirmationEmbed = new EmbedBuilder()
    .setTitle(
      requiresManualConfirm
        ? (isLogin ? 'Backdated Login Check' : 'Backdated Logout Check')
        : (isLogin ? 'Attendance Login Confirmation' : 'Attendance Logout Confirmation')
    )
    .setDescription(
      impactDescription
        ? impactDescription
        : isLogin
        ? (
          `Please confirm if you want to log in on this hotel and time from your attendance message.\n\n` +
          `**Hotel:** ${hotelLabel}\n` +
          `**Mode:** ${modeLabel}\n` +
          `**Time:** ${targetLabel}\n` +
          `**Estimated from now:** ${formatDurationFromMs(Math.max(0, context.targetMs - Date.now()))}`
        )
        : 'Please confirm logout.\n\nThis will end your shift immediately once you confirm.'
    )
    .addFields(
      { name: 'Detected Attendance Text', value: detectedText ? `\`${detectedText.slice(0, 950)}\`` : '`(empty)`' },
      ...(impactLabel ? [{ name: 'Hour Impact', value: impactLabel }] : []),
      { name: 'Access', value: `Buttons are locked to <@${userId}> only.` }
    )
    .setColor(requiresManualConfirm ? 0xFEE75C : (isLogin ? 0x57F287 : 0xED4245))
    .setFooter({
      text: requiresManualConfirm
        ? 'Aavgo Operations - Backdated Attendance (manual confirmation required)'
        : isLogin
        ? 'Aavgo Operations - Attendance Confirmation (auto-confirms in 1 minute if ignored)'
        : 'Aavgo Operations - Attendance Confirmation (auto-delete after decision)'
    })
    .setTimestamp();

  const confirmButton = new ButtonBuilder()
    .setCustomId(`${ATTENDANCE_ACTION_BUTTON_PREFIX}:${context.action}:confirm:${token}`)
    .setLabel(isLogin ? 'Confirm Login' : 'Confirm Logout')
    .setStyle(ButtonStyle.Success);
  const cancelButton = new ButtonBuilder()
    .setCustomId(`${ATTENDANCE_ACTION_BUTTON_PREFIX}:${context.action}:cancel:${token}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  const sent = await message.reply({
    content: `<@${userId}>`,
    embeds: [confirmationEmbed],
    allowedMentions: { users: [userId], repliedUser: false },
    components: [new ActionRowBuilder().addComponents(confirmButton, cancelButton)]
  }).catch(error => {
    console.warn(`[ATTENDANCE] Failed to send in-channel action confirmation to ${userId}:`, error.message);
    return null;
  });

  if (sent?.id) {
    pendingEntry.confirmationMessageId = sent.id;
    pendingEntry.confirmationChannelId = sent.channelId;
    const timer = setTimeout(() => {
      const active = pendingAttendanceActionConfirmations.get(token);
      if (!active || active.confirmationMessageId !== sent.id) return;
      pendingAttendanceActionConfirmations.delete(token);
      if (isLogin && !requiresManualConfirm) {
        const delayMs = getAttendanceActionDelayMs(active);
        scheduleAttendanceActionExecution(message.client, active, delayMs);
      }
      sent.delete().catch(() => {});
    }, (isLogin && !requiresManualConfirm) ? 60 * 1000 : 10 * 60 * 1000);
    timer.unref?.();
    pendingEntry.promptCleanupTimer = timer;
  } else {
    pendingAttendanceActionConfirmations.delete(token);
  }
}

async function handleAttendanceReminderButton(interaction) {
  const parts = String(interaction.customId || '').split(':');
  if (parts.length < 3) {
    return interaction.reply({ content: 'Invalid reminder action.', ephemeral: true }).catch(() => {});
  }

  const action = parts[1];
  const reminderToken = parts[2];
  const userId = interaction.user.id;
  const pending = pendingAttendanceLoginReminders.get(userId) || null;

  if (action === 'no') {
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    pendingAttendanceLoginReminders.delete(userId);
  }

  const yesButton = new ButtonBuilder()
    .setCustomId(`${ATTENDANCE_REMINDER_BUTTON_PREFIX}:yes:${reminderToken}`)
    .setLabel('Yes, Remind Me')
    .setStyle(action === 'yes' ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(true);
  const noButton = new ButtonBuilder()
    .setCustomId(`${ATTENDANCE_REMINDER_BUTTON_PREFIX}:no:${reminderToken}`)
    .setLabel("Don't Remind Me")
    .setStyle(action === 'no' ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(true);

  await interaction.update({
    components: [new ActionRowBuilder().addComponents(yesButton, noButton)]
  }).catch(() => {});

  const statusText = action === 'no'
    ? 'Reminder canceled. You will not get the delayed attendance reminder from this check-in.'
    : (pending
      ? 'Reminder kept. You will receive the delayed attendance reminder.'
      : 'No active reminder timer was found, but your preference was noted.');

  await interaction.followUp({ content: statusText }).catch(() => {});
}

async function handleAttendanceActionButton(interaction) {
  const parts = String(interaction.customId || '').split(':');
  if (parts.length < 4) {
    return interaction.reply({ content: 'Invalid attendance action.', ephemeral: true }).catch(() => {});
  }

  const action = parts[1];
  const decision = parts[2];
  const token = parts[3];
  const pending = pendingAttendanceActionConfirmations.get(token);

  if (!pending || pending.userId !== interaction.user.id) {
    return interaction.reply({ content: 'This attendance confirmation is no longer active.', ephemeral: true }).catch(() => {});
  }

  const scheduleDeleteConfirmationMessage = (delayMs = 1400) => {
    const timer = setTimeout(() => {
      interaction.deleteReply().catch(() => {
        interaction.message?.delete().catch(() => {});
      });
    }, delayMs);
    timer.unref?.();
  };

  const clearPromptTimer = () => {
    if (pending.promptCleanupTimer) {
      clearTimeout(pending.promptCleanupTimer);
      pending.promptCleanupTimer = null;
    }
  };

  const buildPrimaryEmbed = () => new EmbedBuilder()
    .setTitle(
      pending.requiresManualConfirm
        ? (action === 'login' ? 'Backdated Login Check' : 'Backdated Logout Check')
        : (action === 'login' ? 'Attendance Login Confirmation' : 'Attendance Logout Confirmation')
    )
    .setDescription(
      pending.impactDescription
        ? pending.impactDescription
        : action === 'login'
        ? `Please confirm if you want to log in on this hotel and time from your attendance message.\n\n**Hotel:** ${pending.hotelLabel}\n**Mode:** ${pending.modeLabel}\n**Time:** ${pending.targetLabel}`
        : 'Please confirm logout.\n\nThis will end your shift immediately once you confirm.'
    )
    .addFields(
      { name: 'Detected Attendance Text', value: pending.detectedText ? `\`${pending.detectedText.slice(0, 950)}\`` : '`(empty)`' },
      ...(pending.impactLabel ? [{ name: 'Hour Impact', value: pending.impactLabel }] : []),
      { name: 'Access', value: `Buttons are locked to <@${pending.userId}> only.` }
    )
    .setColor(pending.requiresManualConfirm ? 0xFEE75C : (action === 'login' ? 0x57F287 : 0xED4245))
    .setFooter({
      text: pending.requiresManualConfirm
        ? 'Aavgo Operations - Backdated Attendance (manual confirmation required)'
        : action === 'login'
        ? 'Aavgo Operations - Attendance Confirmation (auto-confirms in 1 minute if ignored)'
        : 'Aavgo Operations - Attendance Confirmation (auto-delete after decision)'
    })
    .setTimestamp();

  const buildPrimaryButtons = () => {
    const confirmButton = new ButtonBuilder()
      .setCustomId(`${ATTENDANCE_ACTION_BUTTON_PREFIX}:${action}:confirm:${token}`)
      .setLabel(action === 'login' ? 'Confirm Login' : 'Confirm Logout')
      .setStyle(ButtonStyle.Success);
    const cancelButton = new ButtonBuilder()
      .setCustomId(`${ATTENDANCE_ACTION_BUTTON_PREFIX}:${action}:cancel:${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);
    return new ActionRowBuilder().addComponents(confirmButton, cancelButton);
  };

  if (decision === 'open') {
    await interaction.update({
      embeds: [buildPrimaryEmbed()],
      components: [buildPrimaryButtons()]
    }).catch(() => {});
    return;
  }

  if (decision === 'cancel') {
    const warningEmbed = new EmbedBuilder()
      .setTitle('Cancel Confirmation')
      .setDescription(
        `Are you sure you want to cancel this ${action} request?\n` +
        'If you continue, please retype your attendance message again.'
      )
      .setColor(0xFEE75C)
      .setFooter({ text: 'Aavgo Operations - Second Confirmation' })
      .setTimestamp();

    const yesCancelButton = new ButtonBuilder()
      .setCustomId(`${ATTENDANCE_ACTION_BUTTON_PREFIX}:${action}:cancel_yes:${token}`)
      .setLabel('Yes, Cancel It')
      .setStyle(ButtonStyle.Danger);
    const goBackButton = new ButtonBuilder()
      .setCustomId(`${ATTENDANCE_ACTION_BUTTON_PREFIX}:${action}:cancel_back:${token}`)
      .setLabel('Go Back')
      .setStyle(ButtonStyle.Secondary);

    await interaction.update({
      embeds: [warningEmbed],
      components: [new ActionRowBuilder().addComponents(yesCancelButton, goBackButton)]
    }).catch(() => {});
    return;
  }

  if (decision === 'cancel_back') {
    await interaction.update({
      embeds: [buildPrimaryEmbed()],
      components: [buildPrimaryButtons()]
    }).catch(() => {});
    return;
  }

  if (decision === 'cancel_yes') {
    clearPromptTimer();
    pendingAttendanceActionConfirmations.delete(token);
    const canceledEmbed = new EmbedBuilder()
      .setTitle(`${action === 'login' ? 'Login' : 'Logout'} Request Canceled`)
      .setDescription('Request canceled. Please retype your attendance message if needed.')
      .setColor(0xED4245)
      .setTimestamp();
    await interaction.update({
      embeds: [canceledEmbed],
      components: []
    }).catch(() => {});
    scheduleDeleteConfirmationMessage();
    return;
  }

  if (decision !== 'confirm') {
    return interaction.reply({ content: 'Invalid attendance decision.', ephemeral: true }).catch(() => {});
  }

  clearPromptTimer();
  pendingAttendanceActionConfirmations.delete(token);

  const delayMs = getAttendanceActionDelayMs(pending);

  scheduleAttendanceActionExecution(interaction.client, pending, delayMs);
  const successEmbed = buildAttendanceConfirmationEmbed({
    action,
    delayMs,
    targetLabel: pending.targetLabel,
    impactLabel: pending.impactLabel,
    previewOnly: pending.previewOnly,
    modeLabel: pending.modeLabel
  });
  await interaction.update({
    embeds: [successEmbed],
    components: []
  }).catch(() => {});
  scheduleDeleteConfirmationMessage(action === 'login' ? ATTENDANCE_CONFIRM_SUCCESS_DELETE_MS : undefined);
}

function buildAttendanceConfirmationEmbed({ action, delayMs = 0, targetLabel = '', impactLabel = '', previewOnly = false, modeLabel = '' }) {
  const isLogin = action === 'login';
  const actionLabel = isLogin ? 'Login' : 'Logout';
  const isRecorded = Boolean(impactLabel) || delayMs <= 0;
  const fields = [];

  if (targetLabel) {
    fields.push({ name: '\u{23F0} EFFECTIVE TIME', value: `> **${targetLabel}**`, inline: true });
  }
  if (impactLabel) {
    fields.push({ name: '\u{26A0}\u{FE0F} HOUR IMPACT', value: `> **${impactLabel}**`, inline: true });
  } else if (delayMs > 0) {
    fields.push({ name: '\u{23F3} STARTS IN', value: `> **${formatDurationFromMs(delayMs)}**`, inline: true });
  }
  if (modeLabel) {
    fields.push({ name: '\u{1F4CD} SHIFT TYPE', value: `> **${modeLabel}**`, inline: true });
  }
  if (previewOnly) {
    fields.push({
      name: '\u{1F9EA} PREVIEW MODE',
      value: '> This is a test entry. **No hours were recorded.**',
      inline: false
    });
  }

  const description = isRecorded
    ? `## **${actionLabel.toUpperCase()} CONFIRMED**\nYour attendance entry is now part of the shift timeline.\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`
    : `## **${actionLabel.toUpperCase()} SCHEDULED**\nYour attendance entry will be recorded automatically at the selected time.\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;

  return new EmbedBuilder()
    .setTitle(`${isRecorded ? '\u{2705}' : '\u{1F552}'} Attendance ${isRecorded ? 'Updated' : 'Scheduled'}`)
    .setDescription(description)
    .setColor(0x57F287)
    .setFields(fields)
    .setFooter({ text: previewOnly ? 'Aavgo Attendance | Preview entry' : 'Aavgo Attendance | Shift timeline updated' })
    .setTimestamp();
}

function isLoginSystemInteraction(interaction) {
  const commandName = String(interaction?.commandName || '').toLowerCase();
  if (['login', 'logout', 'status', 'setup-login', 'setup-login-team', 'setup-rules', 'refresh-rules', 'setup-applicants', 'refresh-applicants', 'setup-training-status', 'refresh-training-status', 'end-shift'].includes(commandName)) {
    return true;
  }

  const customId = String(interaction?.customId || '').toLowerCase();
  if (!customId) return false;

  return (
    customId.startsWith('start_shift') ||
    customId.startsWith('shift_') ||
    customId.startsWith('agent_shift_') ||
    customId.startsWith('same_hotel_confirm_') ||
    customId.startsWith('loginmodal_') ||
    customId === 'hotel_link_start_yes_btn' ||
    customId === 'hotel_link_start_no_btn' ||
    customId === 'hotel_select_menu' ||
    customId === 'training_hotel_select_menu'
  );
}

function isEphemeralInteractionContext(interaction) {
  if (interaction?.ephemeral === true) return true;
  try {
    return Boolean(interaction?.message?.flags?.has?.(MessageFlags.Ephemeral));
  } catch (_) {
    return false;
  }
}

function isShortCommandConfirmation(message) {
  if (!message) return false;
  if (Array.isArray(message.components) && message.components.length > 0) return false;

  const content = String(message.content || '').trim();
  const isShort = content.length > 0 && content.length <= 220 && !content.includes('\n');
  if (!isShort) return false;

  const quickPattern = /(success|successfully|done|deleted|removed|updated|saved|assigned|promoted|demoted|cleared|refreshed|set|completed|logged)/i;
  return quickPattern.test(content);
}

async function getDefaultTempMessageTtl(interaction) {
  try {
    if (!interaction?.fetchReply) return DEFAULT_TEMP_MESSAGE_TTL_MS;
    const reply = await interaction.fetchReply().catch(() => null);
    if (isShortCommandConfirmation(reply)) {
      return SHORT_TEMP_MESSAGE_TTL_MS;
    }
  } catch (_) {}
  return DEFAULT_TEMP_MESSAGE_TTL_MS;
}

async function scheduleDefaultTempMessageCleanup(interaction) {
  if (!interaction || isLoginSystemInteraction(interaction)) return;
  if (!isEphemeralInteractionContext(interaction)) return;
  if (!(interaction.deferred || interaction.replied)) return;

  const delayMs = await getDefaultTempMessageTtl(interaction);
  const timer = setTimeout(() => {
    interaction.deleteReply?.().catch(() => {});
  }, delayMs);
  timer.unref?.();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

client.commands = new Collection();
let shutdownInProgress = false;
let botStatusHeartbeat = null;
let roleSyncWatcher = null;
let roleSyncWatcherBusy = false;
const roleSyncSnapshotCache = new Map();
const ROLE_SYNC_INTERVAL_MS = 500;

async function runStartupChecks(clientInstance) {
  const checks = [];
  try {
    const quickCheck = db.prepare('PRAGMA quick_check').pluck().get();
    checks.push(`database=${quickCheck === 'ok' ? 'ok' : quickCheck}`);
  } catch (error) {
    checks.push(`database=failed (${error.message})`);
  }

  const guild = clientInstance.guilds.cache.get(AAVGO_GUILD_ID);
  checks.push(`guild=${guild ? 'available' : 'missing'}`);
  try {
    const loginChannel = await clientInstance.channels.fetch(LOGIN_CHANNEL_ID);
    checks.push(`login-channel=${loginChannel ? 'available' : 'missing'}`);
  } catch (error) {
    checks.push(`login-channel=failed (${error.message})`);
  }

  console.log(`[STARTUP-CHECK] ${checks.join(' | ')}`);
}

function getRoleSyncSnapshot(member) {
  const roleIds = [...member.roles.cache.keys()].sort().join(',');
  const displayName = member.displayName || member.user?.username || '';
  return `${displayName}|${roleIds}`;
}

async function runRoleSyncWatcher(clientInstance) {
  if (roleSyncWatcherBusy) return;
  roleSyncWatcherBusy = true;

  try {
    for (const guild of clientInstance.guilds.cache.values()) {
      const members = guild.members.cache;
      for (const member of members.values()) {
        const currentSnapshot = getRoleSyncSnapshot(member);
        const cacheKey = `${guild.id}:${member.id}`;
        const previousSnapshot = roleSyncSnapshotCache.get(cacheKey);

        if (previousSnapshot === currentSnapshot) continue;
        roleSyncSnapshotCache.set(cacheKey, currentSnapshot);
        await auth.syncAgentRecordFromDiscordMember(member, guild, 'ROLE SYNC WATCH', {
          skipRankExclusivity: true
        });
      }
    }
  } catch (error) {
    console.warn('[ROLE SYNC] Watcher tick failed:', error.message);
  } finally {
    roleSyncWatcherBusy = false;
  }
}

function startRoleSyncWatcher(clientInstance) {
  if (roleSyncWatcher) return;

  roleSyncWatcher = setInterval(() => {
    runRoleSyncWatcher(clientInstance).catch(error => {
      console.warn('[ROLE SYNC] Watcher crashed:', error.message);
    });
  }, ROLE_SYNC_INTERVAL_MS);

  roleSyncWatcher.unref?.();
}

function startBotStatusHeartbeat() {
  if (botStatusHeartbeat) return;

  // Keep the status card fresh so stale "online" states are easy to spot.
  botStatusHeartbeat = setInterval(() => {
    upsertBotStatusCard({
      title: 'Bot Online',
      description: 'The Aavgo Bot is connected to Discord and reporting healthy heartbeat updates.',
      color: 0x57F287,
      stateLabel: 'Online'
    }).catch(error => {
      console.warn('[BOT-STATUS] Heartbeat update failed:', error.message);
    });
  }, 45000);

  botStatusHeartbeat.unref?.();
}

async function sendRealNameTutorial(member) {
  const tutorialFiles = [
    new AttachmentBuilder(path.join(REAL_NAME_TUTORIAL_DIR, '1.png'), { name: 'step-1.png' }),
    new AttachmentBuilder(path.join(REAL_NAME_TUTORIAL_DIR, '2.png'), { name: 'step-2.png' }),
    new AttachmentBuilder(path.join(REAL_NAME_TUTORIAL_DIR, '3.png'), { name: 'step-3.png' })
  ];

  const introEmbed = new EmbedBuilder()
    .setTitle('Aavgo Onboarding - Real Name Required')
    .setDescription(
      `Welcome to Aavgo, <@${member.id}>.\n\n` +
      `Before doing anything else, please update your **server nickname** to your **real name** or **surname**.\n\n` +
      `Do not keep usernames such as \`xxSmithyxx\`, gamer tags, aliases, or joke names. ` +
      `Management needs to recognize you immediately inside the server.\n\n` +
      `Follow these steps in order:\n` +
      `**1.** Open your profile and click **Edit Profile**.\n` +
      `**2.** Select **Edit Per-server Profile**.\n` +
      `**3.** Set your server nickname to your real name and save changes.\n\n` +
      `After that, head to <#1482258940879306753> to continue onboarding.`
    )
    .addFields({
      name: 'Important',
      value: 'If your nickname is not your real name, onboarding may be delayed.'
    })
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Operations - Onboarding' })
    .setTimestamp();

  const step1Embed = new EmbedBuilder()
    .setTitle('Step 1')
    .setDescription('Open your profile and click **Edit Profile**.')
    .setColor(0xF1C40F)
    .setImage('attachment://step-1.png');

  const step2Embed = new EmbedBuilder()
    .setTitle('Step 2')
    .setDescription('Select **Edit Per-server Profile**.')
    .setColor(0xF1C40F)
    .setImage('attachment://step-2.png');

  const step3Embed = new EmbedBuilder()
    .setTitle('Step 3')
    .setDescription('Set your server nickname to your real name, then click **Save Changes**.')
    .setColor(0xF1C40F)
    .setImage('attachment://step-3.png');

  try {
    await member.send({
      embeds: [introEmbed, step1Embed, step2Embed, step3Embed],
      files: tutorialFiles
    });
    console.log(`[ONBOARDING] Sent real-name tutorial DM to ${member.user.tag}`);
  } catch (error) {
    console.warn(`[ONBOARDING] Could not send tutorial images to ${member.user.tag}:`, error.message);

    try {
      await member.send({
        content:
          `Welcome to Aavgo.\n\n` +
          `Please change your server nickname to your real name or surname, then go to <#1482258940879306753> to continue onboarding.`
      });
      console.log(`[ONBOARDING] Sent text-only onboarding fallback to ${member.user.tag}`);
    } catch (fallbackError) {
      console.warn(`[ONBOARDING] Could not send fallback onboarding DM to ${member.user.tag}:`, fallbackError.message);
    }
  }
}
function buildNewcomerActionRow(targetUserId, announcementMessageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`newcomer_promote_trainee:${targetUserId}:${announcementMessageId}`)
      .setLabel('Promote to Trainee')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`newcomer_promote_agent:${targetUserId}:${announcementMessageId}`)
      .setLabel('Promote to Agent')
      .setStyle(ButtonStyle.Success)
  );
}

async function sendNewcomerAnnouncement(member) {
  const channel = await member.guild.channels.fetch(NEWCOMER_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[NEWCOMER] Newcomers channel not found or not text-based:', NEWCOMER_CHANNEL_ID);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('👋 Newcomer Joined Aavgo')
    .setDescription(`### Welcome, ${member.user.username}\nA new member has joined the server and is ready for review.`)
    .addFields(
      { name: 'Username', value: member.user.tag, inline: true },
      { name: 'Display Name', value: member.displayName, inline: true },
      { name: 'User ID', value: member.id, inline: true },
      { name: 'Account Created', value: member.user.createdAt ? `<t:${Math.floor(member.user.createdAt.getTime() / 1000)}:F>` : 'Unknown', inline: true },
      { name: 'Joined Server', value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:F>` : 'Just joined', inline: true },
      { name: 'Profile Link', value: `[Open Discord Profile](https://discord.com/users/${member.id})`, inline: true }
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 512, extension: 'png' }))
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Newcomers Channel' })
    .setTimestamp();

  const message = await channel.send({
    content: `<@&${OPERATIONS_MANAGER_ROLE_ID}> <@${member.id}>`,
    embeds: [embed],
    allowedMentions: { roles: [OPERATIONS_MANAGER_ROLE_ID], users: [member.id] }
  });

  await message.edit({
    components: [buildNewcomerActionRow(member.id, message.id)]
  }).catch(() => {});
}

async function handleBotShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  if (botStatusHeartbeat) {
    clearInterval(botStatusHeartbeat);
    botStatusHeartbeat = null;
  }
  if (roleSyncWatcher) {
    clearInterval(roleSyncWatcher);
    roleSyncWatcher = null;
  }

  console.log(`[DISCORD] Received ${signal}. Marking bot offline before exit...`);
  await upsertBotStatusCard({
    title: 'Bot Offline',
    description: `The bot process received \`${signal}\` and shut down cleanly.`,
    color: 0xED4245,
    stateLabel: 'Offline'
  });

  try {
    await client.destroy();
  } catch (error) {
    console.warn('[DISCORD] Failed to destroy client cleanly:', error.message);
  }

  process.exit(0);
}

async function clearGlobalCommands(clientUserId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(clientUserId), { body: [] });
}

async function deployGuildCommands(clientUserId) {
  const commands = require('./commands').commandData;
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  console.log('Started refreshing guild application (/) commands.');
  await rest.put(
    Routes.applicationGuildCommands(clientUserId, AAVGO_GUILD_ID),
    { body: commands },
  );
  console.log('Successfully reloaded guild application (/) commands for Guild:', AAVGO_GUILD_ID);
}

// Initialized inside ready event to avoid blocking startup
client.once('ready', async () => {
    console.log(`[DISCORD] Ready! Logged in as ${client.user.tag}`);
    await runStartupChecks(client);
    
    auth.ensureAgentKioskMessage(client, '1482228169485582446').catch(error => {
      console.warn('[KIOSK] Failed to restore agent kiosk on boot:', error.message);
    });
    client.guilds.cache.forEach(guild => {
      auth.syncGuildAgentRecordsFromRoles(guild, 'ROLE SYNC BOOT').catch(error => {
        console.warn(`[ROLE SYNC] Boot sync failed for ${guild.name}:`, error.message);
      });
    });
    profilePanel.ensureProfilesDashboard(client).catch(error => {
      console.warn('[PROFILES] Failed to restore profiles dashboard on boot:', error.message);
    });
    devTodo.ensureDevTodoBoard(client).catch(error => {
      console.warn('[DEV-TODO] Failed to restore dev to-do board on boot:', error.message);
    });
    
    // Start Scheduler Loop (Every 5 minutes)
    setInterval(() => {
      auth.checkSchedules(client);
    }, 5 * 60000);

    // Overtime/session enforcement loop (every 15 seconds):
    // warning cycles, overtime auto-end, and offline auto-end checks.
    setInterval(() => {
      auth.monitorOvertimeSessions(client);
    }, 15 * 1000);

    // Live status board refresh loop (every minute).
    setInterval(() => {
      auth.refreshLiveStatusBoard(client).catch(error => {
        console.warn('[LIVE-STATUS] Scheduled refresh failed:', error.message);
      });
    }, 60 * 1000);
    
    // Initial check on boot
    auth.checkSchedules(client);
    recoverScheduledAttendanceActions(client);
    auth.monitorOvertimeSessions(client).catch(error => {
      console.warn('[OVERTIME] Initial monitor pass failed:', error.message);
    });
    auth.broadcastUpdateLog(client).catch(error => {
      console.warn('[UPDATE-LOG] Startup broadcast failed:', error.message);
    });
    auth.refreshApplicantsNoticeBoard(client).catch(error => {
      console.warn('[APPLICANTS] Boot refresh failed:', error.message);
    });
    auth.refreshRulesBoard(client).catch(error => {
      console.warn('[RULES] Boot refresh failed:', error.message);
    });
    auth.refreshOperationalBoards(client).catch(error => {
      console.warn('[STATUS] Boot refresh failed:', error.message);
    });
    client.guilds.cache.forEach(guild => {
      guild.members.fetch().catch(error => {
        console.warn(`[ROLE SYNC] Failed to warm member cache for ${guild.name}:`, error.message);
      });
    });
    startRoleSyncWatcher(client);
    runRoleSyncWatcher(client).catch(error => {
      console.warn('[ROLE SYNC] Initial watcher pass failed:', error.message);
    });

    // Startup Audit Log
    upsertBotStatusCard({
      title: '🟢 System Online',
      description: 'The Aavgo Bot is connected to Discord and core systems are responding normally.',
      color: 0x57F287,
      stateLabel: 'Online'
    });
    startBotStatusHeartbeat();
  // Register Slash Commands
  try {
    if (String(process.env.AAVGO_WIPE_GLOBAL_COMMANDS || '').toLowerCase() === 'true') {
      await clearGlobalCommands(client.user.id);
      console.warn('[COMMANDS] Global command wipe executed from AAVGO_WIPE_GLOBAL_COMMANDS=true.');
    }
    await deployGuildCommands(client.user.id);
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('guildMemberAdd', async member => {
  try {
    const applicantsRole = member.guild.roles.cache.get('1484919969689894912') || member.guild.roles.cache.find(r => r.name.toLowerCase() === 'applicants');
    if (applicantsRole) {
      await member.roles.add(applicantsRole);
      console.log(`[JOIN] Assigned Applicants role to ${member.user.username}`);
    }
  } catch (error) {
    console.warn('[JOIN] Failed to assign Applicants role:', error.message);
  }

  try {
    await sendNewcomerAnnouncement(member);
  } catch (error) {
    console.warn('[NEWCOMER] Failed to send newcomer announcement:', error.message);
  }

  try {
    await sendRealNameTutorial(member);
  } catch (error) {
    console.warn('[ONBOARDING] Failed to send real-name tutorial:', error.message);
  }

});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    await auth.handleSensitivePromotionRoleAddAttempt(oldMember, newMember);

    const applicantRoleId = '1484919969689894912';
    const traineeRoleId = '1484705126026449029';
    const agentRoleId = '1482227287159078964';
    const smeRoleId = '1482382342621233153';
    const teamLeaderRoleId = '1482732583660818636';
    const rankRolePriority = [
      teamLeaderRoleId,
      smeRoleId,
      agentRoleId,
      traineeRoleId,
      applicantRoleId
    ];

    const gainedRankRoleIds = rankRolePriority.filter(
      roleId => !oldMember.roles.cache.has(roleId) && newMember.roles.cache.has(roleId)
    );
    const preferredRankRoleId = gainedRankRoleIds.length > 0
      ? rankRolePriority.find(roleId => gainedRankRoleIds.includes(roleId)) || gainedRankRoleIds[0]
      : null;

    if (preferredRankRoleId) {
      const preferredRoleName = newMember.guild.roles.cache.get(preferredRankRoleId)?.name || preferredRankRoleId;
      const memberLabel = newMember.displayName || newMember.user?.username || newMember.id;
      console.log(`[ROLE SYNC] Rank role change detected for ${memberLabel}; prioritizing ${preferredRoleName}`);
    }

    await auth.syncAgentRecordFromDiscordMember(newMember, newMember.guild, 'ROLE SYNC UPDATE', {
      preferredRankRoleId
    });
  } catch (error) {
    console.warn('[ROLE SYNC] Failed to process member role update:', error.message);
  }
});

client.on('guildMemberRemove', async member => {
  await auth.handleMemberLeave(member);
});

  client.on('messageCreate', async message => {
    try {
      const isAttendanceChannel = String(message.channelId) === ATTENDANCE_CHANNEL_ID;
      const isPreviewAttendanceChannel = String(message.channelId) === ATTENDANCE_PROTOTYPE_CHANNEL_ID;

      if (!shouldHandleAttendancePrototypeMessage(message)) return;

      const action = parseAttendanceAction(message.content);
      if (!action) return;

      const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return;

      const nowMs = Date.now();
      const { targetMs, explicit: timeExplicit } = parseAttendanceTargetTime(message.content, nowMs);
      if (isAttendanceChannel || isPreviewAttendanceChannel) {
        await auth.processAttendanceMessage(message, {
          previewOnly: isPreviewAttendanceChannel,
          nowMs,
          targetMs
        });
      }

      if (action === 'logout') {
        const logoutMs = resolveAttendanceLogoutTimeMs(message.content, nowMs);
        const logoutTimeIso = new Date(logoutMs).toISOString();
        cancelAttendanceQueuedAction(message.author.id, 'login');
        auth.clearAttendanceReactionTimer(message.author.id);
        if (!isPreviewAttendanceChannel) {
          await auth.setAttendanceQueueRole(member, false).catch(() => {});
        }
        const result = await auth.handleAttendanceTextLogout({
          client,
          guild: message.guild,
          member,
          logoutTimeIso,
          previewOnly: isPreviewAttendanceChannel
        });

        const logoutEmbed = result?.ok
          ? buildAttendanceConfirmationEmbed({
              action: 'logout',
              targetLabel: formatAttendanceTimeLabel(logoutMs),
              previewOnly: isPreviewAttendanceChannel,
              modeLabel: isPreviewAttendanceChannel ? 'Preview Attendance' : 'Live Shift'
            })
          : new EmbedBuilder()
              .setTitle('Attendance Logout Failed')
              .setDescription('Could not complete your logout right now. Please try again or use `/logout`.')
              .setColor(0xED4245)
              .setTimestamp();

      const logoutReply = await message.reply({
        content: `<@${message.author.id}>`,
        embeds: [logoutEmbed],
        allowedMentions: { users: [message.author.id], repliedUser: false }
      }).catch(() => null);

      await auth.setAttendanceQueueRole(member, false).catch(() => {});

      if (logoutReply) {
        const timer = setTimeout(() => {
          logoutReply.delete().catch(() => {});
        }, ATTENDANCE_LOGOUT_REPLY_DELETE_MS);
        timer.unref?.();
      }
      return;
    }

    const mode = parseAttendanceMode(message.content, member);
    const teamName = resolveAttendanceTeamName(member);
    const hotelId = detectAttendanceHotelId(message.content);
    const voiceChannelId = resolveAttendanceVoiceChannelId({ hotelId, mode, teamName, userId: message.author.id });
    const isTestRole = isTestRoleMember(member);
      const reminderDelayMs = Math.max(0, targetMs - nowMs);
      const targetLabel = formatAttendanceTimeLabel(targetMs);
      const previewOnly = isPreviewAttendanceChannel;
      const loginBackdateImpact = timeExplicit
        ? buildAttendanceBackdateImpact('login', targetMs, nowMs)
        : null;
      if (loginBackdateImpact) {
        await sendAttendanceActionConfirmation(message, {
          action: 'login',
          member,
          hotelId,
          mode,
          targetMs,
          isTestRole,
          timeExplicit: true,
          teamName,
          previewOnly,
          requiresManualConfirm: true,
          pastImpact: loginBackdateImpact
        });
        return;
      }

      scheduleAttendanceLoginReminder(message, {
        member,
        voiceChannelId,
        targetMs,
        targetLabel,
        useScheduledDelay: timeExplicit,
        reminderDelayMs: timeExplicit ? reminderDelayMs : undefined,
        previewOnly
      });

      if (!previewOnly) {
        await auth.setAttendanceQueueRole(member, true).catch(error => {
          console.warn(`[ATTENDANCE] Failed to grant queue role to ${message.author.id}:`, error.message);
        });
      }

      const scheduledLoginEntry = {
        action: 'login',
        userId: message.author.id,
        guildId: message.guild.id,
      hotelId,
      mode,
      targetMs,
      isTestRole,
      timeExplicit,
      teamName,
        modeLabel: mode === 'training' ? 'Training' : 'Live Shift',
        targetLabel,
        hotelLabel: auth.getCombinedHotelLabel(hotelId),
        detectedText: String(message.content || '').trim(),
        previewOnly
      };
      const delayMs = getAttendanceActionDelayMs(scheduledLoginEntry);
      scheduleAttendanceActionExecution(client, scheduledLoginEntry, delayMs);

      const confirmedEmbed = buildAttendanceConfirmationEmbed({
        action: 'login',
        delayMs,
        targetLabel,
        previewOnly,
        modeLabel: mode === 'training' ? 'Training' : 'Live Shift'
      });

    const confirmedReply = await message.reply({
      content: `<@${message.author.id}>`,
      embeds: [confirmedEmbed],
      allowedMentions: { users: [message.author.id], repliedUser: false }
    }).catch(() => null);

    if (confirmedReply) {
      const timer = setTimeout(() => {
        confirmedReply.delete().catch(() => {});
      }, ATTENDANCE_CONFIRM_SUCCESS_DELETE_MS);
      timer.unref?.();
    }
  } catch (error) {
    console.warn('[ATTENDANCE] Failed to process attendance message:', error.message);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (oldState.channelId === newState.channelId) return;

    const member = newState.member || oldState.member;
    const guild = newState.guild || oldState.guild;
    if (!member || !guild || member.user?.bot) return;

    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(member.id);
    if (!agent) return;

    const activeSessions = db.prepare(
      "SELECT id, hotel_id, session_kind, status FROM sessions WHERE agent_id = ? AND status = 'active'"
    ).all(agent.id);
    if (activeSessions.length === 0) return;

    const destinationChannelId = newState.channelId;
    // Soft-lock behavior: while on an active shift, users can move to ANY voice channel,
    // but they cannot fully disconnect from voice until they end shift.
    if (destinationChannelId) return;

    let fallbackChannelId = oldState.channelId || null;
    if (!fallbackChannelId) {
      const allowedChannelIds = auth.getAllowedShiftVoiceChannelIds(guild, member, activeSessions, agent);
      if (!Array.isArray(allowedChannelIds) || allowedChannelIds.length === 0) return;
      fallbackChannelId = allowedChannelIds.find(channelId => {
        const channel = guild.channels.cache.get(channelId);
        return channel && typeof channel.isVoiceBased === 'function' && channel.isVoiceBased();
      }) || null;
    }

    if (!fallbackChannelId || fallbackChannelId === destinationChannelId) return;

    await member.voice.setChannel(fallbackChannelId, 'Active shift voice lock');

    await member.send('⚠️ You must end your shift before disconnecting from voice chat.').catch(() => {});
  } catch (error) {
    console.warn('[VOICE LOCK] Failed to enforce active shift voice channel lock:', error.message);
  }
});

process.on('SIGINT', () => {
  handleBotShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  handleBotShutdown('SIGTERM');
});

process.on('SIGHUP', () => {
  handleBotShutdown('SIGHUP');
});

client.on('interactionCreate', async interaction => {
  const auth = require('./auth');
  const tools = require('./tools');
  try {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);
    const focusedName = String(focused?.name || '').toLowerCase();
    const focusedValue = String(focused?.value || '');
    const commandName = String(interaction.commandName || '').toLowerCase();

    if (focusedName.includes('hotel')) {
      const includeGlobal = commandName === 'add-guide' && focusedName === 'hotel';
      return interaction.respond(buildHotelAutocompleteChoices(focusedValue, includeGlobal)).catch(() => {});
    }

    return interaction.respond([]).catch(() => {});
  }

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'login') {
      await auth.handleLogin(interaction);
    } else if (commandName === 'logout') {
      await auth.handleLogout(interaction);
    } else if (commandName === 'status') {
      await auth.handleStatus(interaction);
    } else if (commandName === 'check-heartbeat') {
      await auth.handleCheckHeartbeat(interaction);
    } else if (commandName === 'setup-login') {
      await auth.handleSetupLogin(interaction);
    } else if (commandName === 'setup-login-team') {
      await auth.handleSetupLoginTeam(interaction);
    } else if (commandName === 'setup-rules' || commandName === 'refresh-rules') {
      await auth.handleSetupRules(interaction);
    } else if (commandName === 'setup-applicants' || commandName === 'refresh-applicants') {
      await auth.handleSetupApplicantsNotice(interaction);
    } else if (commandName === 'setup-training-status') {
      await auth.handleSetupTrainingStatus(interaction);
    } else if (commandName === 'refresh-training-status') {
      await auth.handleRefreshTrainingStatus(interaction);
    } else if (commandName === 'setup-register') {
      await interaction.reply({ content: '⛔ Registration is disabled. Use `/add-agent` for onboarding.', ephemeral: true });
    } else if (commandName === 'register') {
      await interaction.reply({ content: '⛔ Self-registration is disabled. Please ask Operations Manager or Developer to run `/add-agent`.', ephemeral: true });
    } else if (commandName === 'add-agent') {
      await auth.handleAddAgent(interaction);
    } else if (commandName === 'reset-pin') {
      await auth.handleResetPin(interaction);
    } else if (commandName === 'setup-profiles') {
      await profilePanel.handleSetupProfiles(interaction);
    } else if (commandName === 'setup-dev-todo') {
      await devTodo.handleSetupDevTodo(interaction);
    } else if (commandName === 'todo-add') {
      await devTodo.handleTodoAddCommand(interaction);
    } else if (commandName === 'todo-move') {
      await devTodo.handleTodoMoveCommand(interaction);
    } else if (commandName === 'todo-refresh') {
      await devTodo.handleTodoRefreshCommand(interaction);
    } else if (commandName === 'remove-agent') {
      await auth.handleRemoveAgentCommand(interaction);
    } else if (commandName === 'check-hours') {
      await auth.handleCheckHours(interaction);
    } else if (commandName === 'add-hours') {
      await auth.handleAddHours(interaction);
    } else if (commandName === 'remove-hours') {
      await auth.handleRemoveHours(interaction);
    } else if (commandName === 'hours-export') {
      await auth.handleHoursExport(interaction);
    } else if (commandName === 'end-shift') {
      await auth.handleLogout(interaction);
    } else if (commandName === 'clear-hours') {
      await auth.handleClearHours(interaction);
    } else if (commandName === 'tools') {
      await tools.handleToolsCommand(interaction);
    } else if (commandName === 'tools-team') {
      await tools.handleToolsCommand(interaction);
    } else if (commandName === 'purge') {
      await auth.handlePurge(interaction);
    } else if (commandName === 'db-remove-all') {
      await auth.handleDbRemoveAll(interaction);
    } else if (commandName === 'db-delete-agent') {
      await auth.handleDbDeleteAgent(interaction);
    } else if (commandName === 'db-clear-pending') {
      await auth.handleDbClearPending(interaction);
    } else if (commandName === 'db-query') {
      await auth.handleDbQuery(interaction);
    } else if (commandName === 'db-log-checkin') {
      await auth.handleDbLogCheckin(interaction);
    } else if (commandName === 'db-backup') {
      await handleDbBackup(interaction);
    } else if (commandName === 'db-add-developer') {
      await auth.handleDbAddDeveloper(interaction);
    } else if (commandName === 'db-set-phone') {
      await auth.handleDbSetPhone(interaction);
    } else if (commandName === 'db-promote-tl') {
      await auth.handlePromoteTL(interaction);
    } else if (commandName === 'db-promote-sme') {
      await auth.handlePromoteSME(interaction);
    } else if (commandName === 'db-set-operation-manager') {
      await auth.handleSetOperationManager(interaction);
    } else if (commandName === 'promote') {
      await auth.handlePromote(interaction);
    } else if (commandName === 'db-demote') {
      await auth.handleDemote(interaction);
    } else if (commandName === 'db-remove-user') {
      await auth.handleDbRemoveUser(interaction);
    } else if (commandName === 'db-info') {
      await auth.handleDbInfo(interaction);
    } else if (commandName === 'see-all-pins') {
      await auth.handleSeeAllPins(interaction);
    } else if (commandName === 'db-set-pin') {
      await auth.handleDbSetPin(interaction);
    } else if (commandName === 'help-staff') {
      await auth.handleHelpStaff(interaction);
    } else if (commandName === 'test-ui' || commandName === 'test-gui') {
      await auth.handleTestUiCommand(interaction);
    } else if (commandName === 'help-agent') {
      await auth.handleHelpAgent(interaction);
    } else if (commandName === 'limit-warning') {
      await auth.handleLimitWarning(interaction);
    } else if (commandName === 'time-travel') {
      await auth.handleTimeTravel(interaction);
    } else if (commandName === 'select-trainee') {
      await auth.handleSelectTrainee(interaction);
    } else if (commandName === 'assign-team') {
      await auth.handleAssignTeam(interaction);
    } else if (commandName === 'help-team-leader') {
      await auth.handleHelpTeamLeader(interaction);
    } else if (commandName === 'hotel-status') {
      await auth.handleHotelStatusRefresh(interaction);
    } else if (commandName === 'db-assign-hotel') {
      await auth.handleDbAssignHotel(interaction);
    } else if (commandName === 'find-guest') {
      await auth.handleFindGuest(interaction);
    } else if (commandName === 'guide') {
      await auth.handleGuide(interaction);
    } else if (commandName === 'add-guide') {
      await auth.handleAddGuide(interaction);
    } else if (commandName === 'maintenance-list') {
      await auth.handleMaintenanceList(interaction);
    } else if (commandName === 'db-set-schedule') {
      await auth.handleSetSchedule(interaction);
    } else if (commandName === 'set-hotel-shifts') {
      await auth.handleAddHotelShifts(interaction);
    } else if (commandName === 'schedule-view') {
      await auth.handleScheduleView(interaction);
    } else if (commandName === 'schedule-export') {
      await auth.handleScheduleExport(interaction);
    } else if (commandName === 'schedule-import') {
      await auth.handleScheduleImport(interaction);
    } else if (commandName === 'my-schedule') {
      await auth.handleMySchedule(interaction);
    } else if (commandName === 'attendance-report') {
      await auth.handleAttendanceReport(interaction);
    }
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId === 'register_modal') {
      await interaction.reply({ content: '⛔ Registration is disabled. Please contact Operations Manager or Developer.', ephemeral: true });
    } else if (interaction.customId === 'security_setup_modal') {
      await auth.handleSecuritySetupSubmit(interaction);
    } else if (interaction.customId.startsWith('activity_modal_')) {
      await auth.handleActivityModalSubmit(interaction);
    } else if (interaction.customId.startsWith('bio_deny_modal_') || interaction.customId.startsWith('bio_deny_modal:')) {
      await tools.handleBioDenySubmit(interaction);
    } else if (interaction.customId.startsWith('loginmodal_')) {
      await auth.handleModalSubmit(interaction);
    } else if (interaction.customId.startsWith('newcomer_agent_pin_modal:')) {
      await auth.handleNewcomerAgentPinSubmit(interaction);
    } else if (interaction.customId === 'devtodo_add_modal' || interaction.customId === 'devtodo_log_done_modal') {
      await devTodo.handleModalSubmit(interaction);
    }
  } else if (interaction.isButton()) {
    if (interaction.customId.startsWith(`${ATTENDANCE_REMINDER_BUTTON_PREFIX}:`)) {
      await handleAttendanceReminderButton(interaction);
    } else if (interaction.customId.startsWith(`${ATTENDANCE_ACTION_BUTTON_PREFIX}:`)) {
      await handleAttendanceActionButton(interaction);
    } else if (interaction.customId.startsWith('devtodo_')) {
      await devTodo.handleButton(interaction);
    } else if (interaction.customId.startsWith('profiles_')) {
      await profilePanel.handleButton(interaction);
    } else if (interaction.customId.startsWith('test_ui_')) {
      await auth.handleTestUiButton(interaction);
    } else if (interaction.customId === 'start_shift_btn') {
      if (String(interaction.channelId) === TL_SME_LOGIN_CHANNEL_ID) {
        const isOm = interaction.member?.roles?.cache?.has(OPERATIONS_MANAGER_ROLE_ID);
        const isTl = interaction.member?.roles?.cache?.has(TEAM_LEADER_ROLE_ID);
        const isSme = interaction.member?.roles?.cache?.has(SME_ROLE_ID);
        if (!isOm && !isTl && !isSme) {
          return interaction.reply({
            content: 'This portal is for Team Leaders, SMEs, and Operations Managers only.',
            ephemeral: true
          });
        }
        const managementLabel = isOm ? 'Operations Manager' : (isTl ? 'Team Leader' : 'SME');
        await auth.handleManagementRoutePick(interaction, managementLabel);
      } else {
        await auth.handleShiftRolePrompt(interaction);
      }
    } else if (interaction.customId === 'shift_role_agent_btn') {
      await auth.handleAgentRoutePick(interaction);
    } else if (interaction.customId === 'shift_role_team_leader_btn') {
      await auth.handleManagementRoutePick(interaction, 'Team Leader');
    } else if (interaction.customId === 'shift_role_sme_btn') {
      await auth.handleManagementRoutePick(interaction, 'SME');
    } else if (interaction.customId === 'shift_mgmt_mode_live_btn') {
      await auth.handleManagementLiveStart(interaction);
    } else if (interaction.customId === 'shift_mgmt_team_1_btn') {
      await auth.handleManagementTeamStart(interaction, 'Team 1');
    } else if (interaction.customId === 'shift_mgmt_team_2_btn') {
      await auth.handleManagementTeamStart(interaction, 'Team 2');
    } else if (
      interaction.customId === 'shift_mode_hotel_btn' ||
      interaction.customId === 'start_shift_single_confirm_btn' ||
      interaction.customId === 'start_shift_multi_confirm_btn'
    ) {
      await auth.handleStartShiftClick(interaction);
    } else if (interaction.customId === 'training_start_btn') {
      await auth.handleTrainingStartClick(interaction);
    } else if (interaction.customId === 'hotel_link_start_yes_btn' || interaction.customId === 'hotel_link_start_no_btn') {
      await auth.handleHotelLinkStartChoice(interaction);
    } else if (interaction.customId.startsWith('agent_shift_confirm_yes:') || interaction.customId === 'agent_shift_confirm_no') {
      await auth.handleAgentShiftStartConfirm(interaction);
    } else if (interaction.customId.startsWith('shift_call_join:')) {
      await auth.handleShiftCallJoin(interaction);
    } else if (interaction.customId === 'training_end_btn') {
      await auth.handleLogout(interaction);
    } else if (interaction.customId === 'kiosk_end_shift_btn') {
      await auth.handleLogout(interaction);
    } else if (interaction.customId === 'security_setup_btn') {
      await auth.handleSecuritySetupStart(interaction);
    } else if (interaction.customId === 'register_start_btn') {
      await interaction.reply({ content: '⛔ Registration is disabled. Use `/add-agent` onboarding instead.', ephemeral: true });
    } else if (interaction.customId.startsWith('team_btn_')) {
      await auth.handleTeamSelect(interaction);
    } else if (interaction.customId.startsWith('logout_btn')) {
      await auth.handleLogout(interaction);
    } else if (interaction.customId === 'reset_team_btn') {
      await auth.handleResetTeam(interaction);
    } else if (interaction.customId.startsWith('approve_reg_')) {
      await auth.handleApproveReg(interaction);
    } else if (interaction.customId.startsWith('deny_reg_')) {
      await auth.handleDenyReg(interaction);
    } else if (interaction.customId.startsWith('remove_agent_')) {
      await auth.handleRemoveAgent(interaction);
    } else if (interaction.customId.startsWith('newcomer_promote_')) {
      await auth.handleNewcomerPromotion(interaction);
    } else if (interaction.customId.startsWith('overtime_confirm:')) {
      await auth.handleOvertimeConfirm(interaction);
    } else if (interaction.customId.startsWith('overtime_endshift:')) {
      await auth.handleOvertimeEndShift(interaction);
    } else if (interaction.customId === 'tools_normal_break') {
      await tools.handleNormalBreak(interaction);
    } else if (interaction.customId === 'tools_emergency') {
      await tools.handleEmergency(interaction);
    } else if (interaction.customId === 'tools_bio_break') {
      await tools.handleBioBreak(interaction);
    } else if (interaction.customId.startsWith('tools_end_bio_')) {
      await tools.handleEndBioBreak(interaction);
    } else if (interaction.customId.startsWith('tl_accept_')) {
      await tools.handleTLAccept(interaction);
    } else if (interaction.customId.startsWith('tl_done_')) {
      await tools.handleTLDone(interaction);
    } else if (interaction.customId.startsWith('bio_approve_')) {
      await tools.handleBioApprove(interaction);
    } else if (interaction.customId.startsWith('bio_deny_')) {
      await tools.handleBioDeny(interaction);
    } else if (interaction.customId.startsWith('hotel_btn_')) {
      await auth.handleHotelSelect(interaction); // legacy - kept for backwards compat
    } else if (interaction.customId.startsWith('confirm_hotel_')) {
      await auth.handleConfirmHotelLink(interaction);
    } else if (interaction.customId === 'cancel_hotel_link') {
      await auth.handleCancelHotelLink(interaction);
    } else if (interaction.customId.startsWith('purge_confirm_')) {
      await auth.handlePurgeConfirm(interaction);
    } else if (interaction.customId.startsWith('purge_deny_')) {
      await auth.handlePurgeDeny(interaction);
    } else if (interaction.customId.startsWith('takeover_btn_')) {
      await auth.handleTakeoverShift(interaction);
    } else if (interaction.customId === 'tl_call_agent_menu') {
      await tools.handleCallAgentMenu(interaction);
    } else if (interaction.customId === 'cancel_takeover_btn') {
      await auth.handleCancelTakeover(interaction);
    } else if (interaction.customId === 'start_shift_multi_cancel_btn') {
      await auth.handleCancelMultiHotelStart(interaction);
    } else if (interaction.customId.startsWith('same_hotel_confirm_')) {
      await auth.handleSameHotelConfirm(interaction);
    } else if (interaction.customId.startsWith('dev_approve_')) {
      await auth.handleDevApprove(interaction);
    } else if (interaction.customId.startsWith('dev_deny_')) {
      await auth.handleDevDeny(interaction);
    } else if (interaction.customId.startsWith('promote_req_approve:')) {
      await auth.handlePromotionRequestApprove(interaction);
    } else if (interaction.customId.startsWith('promote_req_deny:')) {
      await auth.handlePromotionRequestDeny(interaction);
    } else if (
      interaction.customId === 'tl_start_shift_btn' ||
      interaction.customId === 'tl_start_shift_single_confirm_btn' ||
      interaction.customId === 'tl_start_shift_multi_confirm_btn'
    ) {
      await auth.handleStartShiftClick(interaction);
    } else if (interaction.customId === 'tl_logout_btn') {
      await auth.handleLogout(interaction);
    } else if (interaction.customId.startsWith('activity_')) {
      await auth.handleActivityClick(interaction);
    }
  } else if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('devtodo_')) {
      await devTodo.handleSelectMenu(interaction);
    } else if (interaction.customId.startsWith('profiles_')) {
      await profilePanel.handleSelectMenu(interaction);
    } else if (interaction.customId.startsWith('test_ui_')) {
      await auth.handleTestUiSelect(interaction);
    } else if (interaction.customId === 'tl_call_select_agent') {
      await tools.handleAgentCallStart(interaction);
    } else if (interaction.customId.startsWith('shift_hotel_pick_menu')) {
      await auth.handleShiftHotelPickMenu(interaction);
    } else if (interaction.customId === 'hotel_select_menu') {
      await auth.handleHotelSelectMenu(interaction);
    } else if (interaction.customId === 'training_hotel_select_menu') {
      await auth.handleTrainingHotelSelectMenu(interaction);
    }
  }
  } catch (error) {
    console.error('[INTERACTION] Handler failure:', error);
    if (error?.code === 10062) {
      console.warn('[INTERACTION] Skipping fallback response for expired interaction (10062).');
      return;
    }
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Command failed while processing. Please try again.' });
      } else {
        await interaction.reply({ content: '❌ Command failed while processing. Please try again.', ephemeral: true });
      }
    } catch (respondErr) {
      console.warn('[INTERACTION] Failed to send fallback error response:', respondErr.message);
    }
  } finally {
    scheduleDefaultTempMessageCleanup(interaction).catch(() => {});
  }
});

async function handleDbBackup(interaction) {
  if (!auth.isDeveloper(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // 3s Timeout safety - if backup is too slow, we still tell the user we're working on it
    const backupPromise = (async () => {
        const backup = require('../backup');
        return await backup.performBackup();
    })();

    const backupDir = await backupPromise;
    const path = require('path');
    const exportFile = path.join(backupDir, 'database_export.txt');
    
    await interaction.editReply({ 
      content: `✅ **Backup Completed!**\n📁 Folder: \`${backupDir}\`\n📄 Use \`!db-export-get\` (scripted) or check the filesystem for the text export.`,
      files: [exportFile]
    });
  } catch (error) {
    console.error('Backup failed:', error);
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Backup failed: ' + error.message });
    } else {
        await interaction.reply({ content: '❌ Backup failed: ' + error.message, ephemeral: true });
    }
  }
}

client.login(process.env.DISCORD_TOKEN);

// Anti-Crash Protection
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ANTI-CRASH] Unhandled Rejection at:', promise, 'reason:', reason);
  // Optional: If it's a fatal error, we might want to exit and let the guardian restart
  if (reason && reason.code === 10062) {
      console.warn('[ANTI-CRASH] Ignoring "Unknown interaction" error to prevent crash.');
  }
});

process.on('uncaughtException', (err, origin) => {
  console.error('[ANTI-CRASH] Uncaught Exception:', err, 'at:', origin);
  if (err && err.code === 10062) {
      console.warn('[ANTI-CRASH] Ignoring "Unknown interaction" uncaught exception to keep the bot alive.');
      return;
  }
  // Force exit on uncaught exception to allow guardian to restart
  process.exit(1);
});


