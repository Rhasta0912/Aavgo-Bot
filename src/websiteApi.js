const http = require('http');
const https = require('https');
const db = require('./database');
const auth = require('./auth');
const profilePanel = require('./profilePanel');
const {
  calculateAgentHourTotals,
  buildPeriodHourHistory,
  getMonthDailyHourHistory,
  parseDbTimestamp,
  formatHours
} = require('./hours');

const AAVGO_GUILD_ID = '1482220918355922974';
const DEVELOPER_ROLE_ID = '1482312134875418737';
const TEAM_LEADER_ROLE_ID = '1482732583660818636';
const OPERATIONS_MANAGER_ROLE_ID = '1482226842047090809';
const SME_ROLE_ID = '1482382342621233153';
const AGENT_ROLE_ID = '1482227287159078964';
const TRAINEE_ROLE_ID = '1484705126026449029';
const TEAM_ROLE_NAMES = ['team 1', 'team 2', 'team 3'];
const WEBSITE_COMMAND_BATCH_LIMIT = 25;

let websiteApiServer = null;
let websiteSyncTimer = null;
let websiteSyncInFlight = false;
let websiteCommandTimer = null;
let websiteCommandInFlight = false;

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
  let commandUrl = String(process.env.AAVGO_WEBSITE_COMMAND_URL || '').trim();
  if (!commandUrl && syncUrl) {
    try {
      const derived = new URL(syncUrl);
      derived.pathname = '/api/admin-command-sync/';
      derived.search = '';
      commandUrl = derived.toString();
    } catch (_) {
      commandUrl = '';
    }
  }

  return {
    token,
    host,
    syncUrl,
    commandUrl,
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

function roundHours(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

function combineHotelId(hotelId) {
  return String(hotelId || '').trim().toUpperCase() === 'SUP8' ? 'RMDA' : String(hotelId || '').trim().toUpperCase();
}

function getHotelNameMap() {
  const hotels = db.prepare('SELECT id, name, team FROM hotels WHERE id != ?').all('TEAM_SHIFT');
  return new Map(hotels.map(hotel => [String(hotel.id), {
    id: String(hotel.id),
    name: String(hotel.name),
    team: String(hotel.team || '')
  }]));
}

function buildHotelOptions() {
  const hotels = db.prepare('SELECT id, name, team FROM hotels WHERE id != ? ORDER BY team ASC, name ASC').all('TEAM_SHIFT');
  const combined = new Map();

  for (const hotel of hotels) {
    const combinedId = combineHotelId(hotel.id);
    if (!combinedId) continue;
    if (!combined.has(combinedId)) {
      combined.set(combinedId, {
        id: combinedId,
        name: auth.getCombinedHotelLabel(combinedId),
        team: String(hotel.team || 'Unassigned')
      });
    }
  }

  return [...combined.values()].sort((left, right) => {
    const teamCompare = String(left.team).localeCompare(String(right.team));
    if (teamCompare !== 0) return teamCompare;
    return String(left.name).localeCompare(String(right.name));
  });
}

function buildTeamOptions(rows) {
  const values = new Set();
  for (const row of rows) {
    const team = auth.normalizeTeamInput(row?.team || '');
    if (team) values.add(team);
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

function toRoleLabels(row, member) {
  const roleIds = new Set(member?.roles?.cache?.keys?.() || []);
  const labels = [];

  if (roleIds.has(DEVELOPER_ROLE_ID)) labels.push('Developer');
  if (roleIds.has(OPERATIONS_MANAGER_ROLE_ID)) labels.push('Operations Manager');
  if (roleIds.has(TEAM_LEADER_ROLE_ID)) labels.push('Team Leader');
  if (roleIds.has(SME_ROLE_ID)) labels.push('SME');
  if (roleIds.has(TRAINEE_ROLE_ID)) labels.push('Trainee');
  if (roleIds.has(AGENT_ROLE_ID)) labels.push('Agent');

  const isDeveloper = db.prepare('SELECT 1 FROM developers WHERE discord_id = ?').get(row.discord_id);
  if (isDeveloper && !labels.includes('Developer')) {
    labels.unshift('Developer');
  }

  if (labels.length > 0) {
    return labels;
  }

  switch (String(row.role || '').toLowerCase()) {
    case 'developer':
      return ['Developer'];
    case 'operations_manager':
      return ['Operations Manager'];
    case 'team_leader':
      return ['Team Leader'];
    case 'sme':
      return ['SME'];
    case 'trainee':
      return ['Trainee'];
    case 'applicant':
      return ['Applicant'];
    case 'agent':
    default:
      return ['Agent'];
  }
}

function mergeRoleLabels(baseLabels = [], nextLabels = []) {
  const merged = new Set();
  for (const label of [...baseLabels, ...nextLabels]) {
    const value = String(label || '').trim();
    if (value) merged.add(value);
  }
  return [...merged];
}

function buildAuthRosterEntry({ discordId, username, displayName, roleLabels }) {
  const normalizedLabels = mergeRoleLabels([], roleLabels);
  if (!discordId || normalizedLabels.length === 0) return null;

  const primaryRole = normalizedLabels[0] || 'Agent';
  return {
    discordId: String(discordId),
    username: String(username || displayName || 'Unknown'),
    displayName: String(displayName || username || 'Unknown'),
    role: primaryRole,
    roleLabels: normalizedLabels,
    roleSummary: normalizedLabels.join(' / ') || primaryRole,
    route: toRouteLabel(primaryRole)
  };
}

function buildAuthRoster(guild, people) {
  const roster = new Map();
  const developerRows = db.prepare('SELECT discord_id, username FROM developers ORDER BY lower(username) ASC').all();

  for (const person of people) {
    const entry = buildAuthRosterEntry({
      discordId: person.discordId,
      username: person.username,
      displayName: person.displayName,
      roleLabels: person.roleLabels
    });
    if (entry) {
      roster.set(entry.discordId, entry);
    }
  }

  const memberCollection = guild?.members?.cache || null;
  if (memberCollection) {
    for (const member of memberCollection.values()) {
      const roleLabels = toRoleLabels({ discord_id: member.id, role: '' }, member)
        .filter(label => label !== 'Applicant');
      const entry = buildAuthRosterEntry({
        discordId: member.id,
        username: member.user?.username || member.displayName || member.id,
        displayName: member.displayName || member.user?.username || member.id,
        roleLabels
      });
      if (!entry) continue;

      const existing = roster.get(entry.discordId);
      if (!existing) {
        roster.set(entry.discordId, entry);
        continue;
      }

      const mergedLabels = mergeRoleLabels(existing.roleLabels, entry.roleLabels);
      roster.set(entry.discordId, {
        ...existing,
        username: existing.username || entry.username,
        displayName: existing.displayName || entry.displayName,
        role: mergedLabels[0] || existing.role || entry.role,
        roleLabels: mergedLabels,
        roleSummary: mergedLabels.join(' / ') || existing.roleSummary || entry.roleSummary,
        route: toRouteLabel(mergedLabels[0] || existing.role || entry.role)
      });
    }
  }

  for (const developer of developerRows) {
    const discordId = String(developer.discord_id || '').trim();
    if (!discordId) continue;

    const existing = roster.get(discordId);
    if (!existing) {
      const entry = buildAuthRosterEntry({
        discordId,
        username: developer.username,
        displayName: developer.username,
        roleLabels: ['Developer']
      });
      if (entry) {
        roster.set(discordId, entry);
      }
      continue;
    }

    const mergedLabels = mergeRoleLabels(existing.roleLabels, ['Developer']);
    roster.set(discordId, {
      ...existing,
      role: mergedLabels[0] || existing.role,
      roleLabels: mergedLabels,
      roleSummary: mergedLabels.join(' / ') || existing.roleSummary,
      route: toRouteLabel(mergedLabels[0] || existing.role)
    });
  }

  return [...roster.values()].sort((left, right) => {
    return String(left.displayName || left.username).localeCompare(String(right.displayName || right.username));
  });
}

function toRouteLabel(roleLabel) {
  if (['Developer', 'Operations Manager', 'Team Leader', 'SME'].includes(roleLabel)) {
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

function buildPayPeriodSegment(monthHistory, startDay, endDay, label) {
  const rows = (monthHistory?.days || [])
    .filter(day => Number(day.day) >= startDay && Number(day.day) <= endDay)
    .map(day => ({
      day: Number(day.day),
      totalHours: roundHours(day.totalHours),
      shiftHours: roundHours(day.shiftHours),
      trainingHours: roundHours(day.trainingHours)
    }));

  const activeDays = rows.filter(day => day.totalHours > 0);
  return {
    label,
    totalHours: roundHours(activeDays.reduce((sum, day) => sum + day.totalHours, 0)),
    days: activeDays
  };
}

function buildRecentMonthSummaries(agentId, now) {
  return [0, -1, -2].map(offset => {
    const history = getMonthDailyHourHistory(db, agentId, offset, now);
    return {
      label: history.label,
      totalHours: roundHours(history.monthTotalHours),
      shiftHours: roundHours(history.monthShiftHours),
      trainingHours: roundHours(history.monthTrainingHours)
    };
  });
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
    const roleLabels = toRoleLabels(row, member);
    const roleLabel = roleLabels[0] || 'Agent';
    const roleSummary = roleLabels.join(' / ') || roleLabel;
    const totals = calculateAgentHourTotals(db, row.id, now);
    const dayHistory = buildPeriodHourHistory(db, row.id, 'day', now);
    const monthHistory = getMonthDailyHourHistory(db, row.id, 0, now);
    const linkedHotelId = combineHotelId(row.hotel_id);
    const linkedHotel = linkedHotelId
      ? (hotelNames.get(String(row.hotel_id))?.name || auth.getCombinedHotelLabel(linkedHotelId))
      : 'Unassigned';
    const activeNow = Boolean(row.active_session_id);
    const activeSession = activeNow
      ? {
          kind: toSessionLabel(row.session_kind),
          loginTime: row.login_time,
          elapsedHours: roundHours(toSessionDurationHours(row.login_time, nowMs))
        }
      : null;

    const payPeriods = {
      firstHalf: buildPayPeriodSegment(monthHistory, 1, 15, '1-15'),
      secondHalf: buildPayPeriodSegment(monthHistory, 16, monthHistory.days.length, '16-end')
    };

    people.push({
      agentId: row.id,
      discordId: row.discord_id,
      username: row.username,
      displayName,
      role: roleLabel,
      roleLabels,
      roleSummary,
      route: toRouteLabel(roleLabel),
      team: auth.normalizeTeamInput(row.team) || row.team || 'Unassigned',
      agentStatus: row.agent_status || 'standby',
      linkedHotelId: linkedHotelId || '',
      linkedHotel,
      activeNow,
      activeSession,
      todayHours: roundHours(dayHistory.totalHours),
      weeklyHours: roundHours(totals.weeklyHours),
      monthlyHours: roundHours(totals.monthlyHours),
      allHours: roundHours(totals.allHours),
      payPeriods,
      currentMonth: {
        label: monthHistory.label,
        totalHours: roundHours(monthHistory.monthTotalHours),
        days: monthHistory.days.map(day => ({
          day: Number(day.day),
          totalHours: roundHours(day.totalHours),
          shiftHours: roundHours(day.shiftHours),
          trainingHours: roundHours(day.trainingHours)
        }))
      },
      recentMonths: buildRecentMonthSummaries(row.id, now)
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
      todayHours: roundHours(team.todayHours),
      weeklyHours: roundHours(team.weeklyHours),
      monthlyHours: roundHours(team.monthlyHours)
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

  const authRoster = buildAuthRoster(guild, people);

  return {
    generatedAt: now.toISOString(),
    summary: {
      totalPeople: summary.totalPeople,
      activeNow: summary.activeNow,
      readyNow: summary.readyNow,
      todayHours: roundHours(summary.todayHours),
      weeklyHours: roundHours(summary.weeklyHours),
      monthlyHours: roundHours(summary.monthlyHours),
      weeklyHoursLabel: formatHours(summary.weeklyHours),
      monthlyHoursLabel: formatHours(summary.monthlyHours)
    },
    meta: {
      hotels: buildHotelOptions(),
      teams: buildTeamOptions(rows)
    },
    teams: teamSummaries,
    people,
    authRoster
  };
}

function requestJson(urlString, token, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Aavgo-Token': token,
      'X-Aavgo-Website-Token': token
    };

    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: 20000
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => {
        const statusCode = Number(response.statusCode || 0);
        let decoded = null;
        try {
          decoded = responseBody ? JSON.parse(responseBody) : null;
        } catch (_) {
          decoded = null;
        }

        if (statusCode >= 200 && statusCode < 300) {
          resolve({ statusCode, body: responseBody, data: decoded });
          return;
        }

        const errorMessage = decoded?.error || responseBody || 'Request failed.';
        reject(new Error(`${method} ${urlString} failed (${statusCode}): ${errorMessage}`));
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error(`${method} ${urlString} timed out.`));
    });

    if (payload !== null) {
      request.write(payload);
    }
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
    await requestJson(config.syncUrl, config.token, {
      method: 'POST',
      body: {
        ok: true,
        configured: true,
        source: 'bot_push',
        syncedAt: new Date().toISOString(),
        data: snapshot
      }
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

async function fetchWebsiteCommands(config) {
  if (!config.commandUrl) return [];
  const response = await requestJson(config.commandUrl, config.token, { method: 'GET' });
  const commands = response?.data?.commands;
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands.slice(0, WEBSITE_COMMAND_BATCH_LIMIT);
}

async function postWebsiteCommandResults(config, results) {
  if (!config.commandUrl || !Array.isArray(results) || results.length === 0) {
    return;
  }

  await requestJson(config.commandUrl, config.token, {
    method: 'POST',
    body: { results }
  });
}

function normalizeDiscordRoleName(roleName) {
  return String(roleName || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function syncMemberTeamRoles(member, teamName) {
  if (!member) return;
  const normalizedTeam = auth.normalizeTeamInput(teamName);
  if (!normalizedTeam) return;

  const teamRolesToRemove = member.roles.cache.filter(role => TEAM_ROLE_NAMES.includes(normalizeDiscordRoleName(role?.name)));
  if (teamRolesToRemove.size > 0) {
    await member.roles.remove(teamRolesToRemove).catch(() => {});
  }

  const targetTeamRole = member.guild.roles.cache.find(
    role => normalizeDiscordRoleName(role?.name) === normalizeDiscordRoleName(normalizedTeam)
  );
  if (targetTeamRole && !member.roles.cache.has(targetTeamRole.id)) {
    await member.roles.add(targetTeamRole).catch(() => {});
  }
}

function getCombinedHotelTargets(hotelId) {
  const normalized = combineHotelId(hotelId);
  if (!normalized) return [];
  if (normalized === 'RMDA') {
    return ['RMDA', 'SUP8'];
  }
  return [normalized];
}

async function fetchGuildMember(guild, discordId) {
  return guild.members.fetch(discordId).catch(() => guild.members.cache.get(discordId) || null);
}

function buildActionActor(command) {
  return {
    discordId: String(command?.actor?.discordId || ''),
    name: String(command?.actor?.name || 'Aavgo Leadership')
  };
}

async function applyTeamAssignmentCommand(client, guild, command) {
  const discordId = String(command?.payload?.discordId || '').trim();
  const nextTeam = auth.normalizeTeamInput(command?.payload?.team || '');
  if (!discordId || !nextTeam) {
    throw new Error('Team update is missing a valid staff member or target team.');
  }

  const agent = db.prepare('SELECT id, username, team FROM agents WHERE discord_id = ?').get(discordId);
  if (!agent) {
    throw new Error('The selected staff member does not exist in the live database.');
  }

  const member = await fetchGuildMember(guild, discordId);
  if (!member) {
    throw new Error('The selected Discord member could not be found in the server.');
  }

  db.prepare('UPDATE agents SET team = ? WHERE discord_id = ?').run(nextTeam, discordId);
  await syncMemberTeamRoles(member, nextTeam);

  const actor = buildActionActor(command);
  await auth.sendAuditLog(client, {
    title: '🌐 Website Team Reassignment',
    description:
      `**User:** ${agent.username} (<@${discordId}>)\n` +
      `**Previous Team:** ${agent.team || 'None'}\n` +
      `**New Team:** ${nextTeam}\n` +
      '**Requested By:** {{AGENT_NAME}}',
    color: 0x57F287,
    userId: actor.discordId,
    guild
  });

  return {
    message: `${agent.username} moved to ${nextTeam}.`
  };
}

async function applyHotelAssignmentCommand(client, guild, command) {
  const discordId = String(command?.payload?.discordId || '').trim();
  const requestedHotelId = auth.normalizeHotelInput(String(command?.payload?.hotelId || '').trim());
  if (!discordId || !requestedHotelId) {
    throw new Error('Hotel update is missing a valid staff member or hotel.');
  }

  const hotelTeamRow = db.prepare("SELECT id, team FROM hotels WHERE id = ? AND id != 'TEAM_SHIFT'").get(requestedHotelId);
  if (!hotelTeamRow) {
    throw new Error('The selected hotel does not exist in the live database.');
  }

  const agent = db.prepare('SELECT id, username, team, hotel_id FROM agents WHERE discord_id = ?').get(discordId);
  if (!agent) {
    throw new Error('The selected staff member does not exist in the live database.');
  }

  const member = await fetchGuildMember(guild, discordId);
  if (!member) {
    throw new Error('The selected Discord member could not be found in the server.');
  }

  const nextTeam = auth.normalizeTeamInput(hotelTeamRow.team || '') || auth.normalizeTeamInput(agent.team || '') || null;

  db.prepare('UPDATE agents SET hotel_id = ?, hotel_compatibility = ?, team = COALESCE(?, team) WHERE discord_id = ?')
    .run(requestedHotelId, JSON.stringify([combineHotelId(requestedHotelId)]), nextTeam, discordId);

  if (nextTeam) {
    await syncMemberTeamRoles(member, nextTeam);
  }
  await profilePanel.syncHotelDiscordRoles(member, [combineHotelId(requestedHotelId)]);

  const actor = buildActionActor(command);
  await auth.sendAuditLog(client, {
    title: '🏨 Website Hotel Reassignment',
    description:
      `**User:** ${agent.username} (<@${discordId}>)\n` +
      `**Previous Hotel:** ${auth.getCombinedHotelLabel(agent.hotel_id || 'Unassigned')}\n` +
      `**New Hotel:** ${auth.getCombinedHotelLabel(requestedHotelId)}\n` +
      `**Team Sync:** ${nextTeam || 'Unchanged'}\n` +
      '**Requested By:** {{AGENT_NAME}}',
    color: 0x3498DB,
    userId: actor.discordId,
    guild
  });

  return {
    message: `${agent.username} linked to ${auth.getCombinedHotelLabel(requestedHotelId)}.`
  };
}

async function forceLogoutAgentByRecord(client, guild, agentRecord) {
  const sessionRefs = await auth.closeAllActiveSessionsForAgent(agentRecord.id, client);
  const member = await fetchGuildMember(guild, agentRecord.discord_id);
  if (member) {
    await auth.applyLoggedOutRolesForMember(guild, member, sessionRefs);
  }
  return sessionRefs.length;
}

async function applyForceLogoutAgentCommand(client, guild, command) {
  const discordId = String(command?.payload?.discordId || '').trim();
  if (!discordId) {
    throw new Error('Force logout needs a target staff member.');
  }

  const agent = db.prepare('SELECT id, discord_id, username FROM agents WHERE discord_id = ?').get(discordId);
  if (!agent) {
    throw new Error('The selected staff member does not exist in the live database.');
  }

  const closedCount = await forceLogoutAgentByRecord(client, guild, agent);
  const actor = buildActionActor(command);

  await auth.sendAuditLog(client, {
    title: '🛑 Website Force Logout',
    description:
      `**User:** ${agent.username} (<@${discordId}>)\n` +
      `**Closed Sessions:** ${closedCount}\n` +
      '**Requested By:** {{AGENT_NAME}}',
    color: 0xED4245,
    userId: actor.discordId,
    guild
  });

  return {
    message: closedCount > 0
      ? `${agent.username} was logged out from ${closedCount} active session(s).`
      : `${agent.username} had no active sessions to close.`
  };
}

async function applyForceLogoutHotelCommand(client, guild, command) {
  const hotelId = auth.normalizeHotelInput(String(command?.payload?.hotelId || '').trim());
  if (!hotelId) {
    throw new Error('Force logout by hotel needs a valid hotel.');
  }

  const targetHotelIds = getCombinedHotelTargets(hotelId);
  const placeholders = targetHotelIds.map(() => '?').join(', ');
  const activeAgents = db.prepare(`
    SELECT DISTINCT a.id, a.discord_id, a.username
    FROM sessions s
    INNER JOIN agents a ON a.id = s.agent_id
    WHERE s.status = 'active'
      AND s.hotel_id IN (${placeholders})
  `).all(...targetHotelIds);

  let closedTotal = 0;
  for (const agent of activeAgents) {
    closedTotal += await forceLogoutAgentByRecord(client, guild, agent);
  }

  const actor = buildActionActor(command);
  await auth.sendAuditLog(client, {
    title: '🏨 Hotel Force Logout',
    description:
      `**Hotel:** ${auth.getCombinedHotelLabel(hotelId)}\n` +
      `**Closed Sessions:** ${closedTotal}\n` +
      '**Requested By:** {{AGENT_NAME}}',
    color: 0xED4245,
    userId: actor.discordId,
    guild
  });

  return {
    message: closedTotal > 0
      ? `${closedTotal} active session(s) were closed for ${auth.getCombinedHotelLabel(hotelId)}.`
      : `No active sessions were open for ${auth.getCombinedHotelLabel(hotelId)}.`
  };
}

async function applySyncAllRolesCommand(client, guild, command) {
  await auth.syncGuildAgentRecordsFromRoles(guild, 'WEBSITE TOOL');
  const actor = buildActionActor(command);

  await auth.sendAuditLog(client, {
    title: '🧰 Developer Role Resync',
    description:
      `**Action:** Discord-to-database role sync for the full guild\n` +
      '**Requested By:** {{AGENT_NAME}}',
    color: 0x5865F2,
    userId: actor.discordId,
    guild
  });

  return {
    message: 'Triggered a full Discord role resync for the guild.'
  };
}

async function applyPushSnapshotCommand() {
  return {
    message: 'Queued an immediate snapshot refresh.'
  };
}

async function applyWebsiteCommand(client, guild, command) {
  switch (String(command?.action || '')) {
    case 'update_team':
      return applyTeamAssignmentCommand(client, guild, command);
    case 'update_hotel':
      return applyHotelAssignmentCommand(client, guild, command);
    case 'force_logout_agent':
      return applyForceLogoutAgentCommand(client, guild, command);
    case 'force_logout_hotel':
      return applyForceLogoutHotelCommand(client, guild, command);
    case 'sync_all_roles':
      return applySyncAllRolesCommand(client, guild, command);
    case 'push_snapshot':
      return applyPushSnapshotCommand();
    default:
      throw new Error(`Unsupported website command: ${String(command?.action || 'unknown')}`);
  }
}

async function processWebsiteCommands(client) {
  const config = getWebsiteApiConfig();
  if (!config.token || !config.commandUrl) {
    return false;
  }

  if (websiteCommandInFlight) {
    return false;
  }

  websiteCommandInFlight = true;

  try {
    const commands = await fetchWebsiteCommands(config);
    if (commands.length === 0) {
      return false;
    }

    const guild = client?.guilds?.cache?.get(AAVGO_GUILD_ID) || null;
    if (!guild) {
      console.warn('[WEBSITE-COMMANDS] Skipping queue processing because the guild is not cached.');
      return false;
    }

    const results = [];
    let shouldRefreshSnapshot = false;

    for (const command of commands) {
      try {
        const outcome = await applyWebsiteCommand(client, guild, command);
        results.push({
          id: command.id,
          status: 'completed',
          message: outcome?.message || 'Completed.',
          completedAt: new Date().toISOString()
        });

        if (String(command?.action || '') !== 'push_snapshot') {
          shouldRefreshSnapshot = true;
        }
      } catch (error) {
        results.push({
          id: command.id,
          status: 'failed',
          message: error.message,
          completedAt: new Date().toISOString()
        });
      }
    }

    await postWebsiteCommandResults(config, results);

    if (results.length > 0 || shouldRefreshSnapshot) {
      await pushWebsiteHoursSnapshot(client, { silent: true });
    }

    return true;
  } catch (error) {
    console.error('[WEBSITE-COMMANDS] Command sync failed:', error.message);
    return false;
  } finally {
    websiteCommandInFlight = false;
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

function startWebsiteCommandSync(client) {
  const config = getWebsiteApiConfig();
  if (!config.token || websiteCommandTimer) {
    return;
  }

  if (!config.commandUrl) {
    console.log('[WEBSITE-COMMANDS] Disabled because AAVGO_WEBSITE_COMMAND_URL is not configured.');
    return;
  }

  processWebsiteCommands(client).catch(error => {
    console.error('[WEBSITE-COMMANDS] Initial poll crashed:', error.message);
  });

  websiteCommandTimer = setInterval(() => {
    processWebsiteCommands(client).catch(error => {
      console.error('[WEBSITE-COMMANDS] Interval poll crashed:', error.message);
    });
  }, Math.max(10000, Math.floor(config.syncIntervalMs / 2)));

  websiteCommandTimer.unref?.();
  console.log(`[WEBSITE-COMMANDS] Polling ${config.commandUrl} for admin commands.`);
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
  startWebsiteCommandSync(client);

  return websiteApiServer;
}

function stopWebsiteApiServer() {
  if (websiteSyncTimer) {
    clearInterval(websiteSyncTimer);
    websiteSyncTimer = null;
  }

  if (websiteCommandTimer) {
    clearInterval(websiteCommandTimer);
    websiteCommandTimer = null;
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
