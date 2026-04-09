const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const db = require('./database');
const auth = require('./auth');
const { calculateAgentHourTotals, getMonthDailyHourHistory, formatHours } = require('./hours');

const PROFILES_CHANNEL_ID = '1485256962617643098';
const PROFILE_PANEL_KEY_PREFIX = 'profiles_dashboard_msg_';
const TEAM_1 = 'Team 1';
const TEAM_2 = 'Team 2';
const TEAM_3 = 'Team 3';
const TEAM_AGENTS = 'Agents';
const TEAM_SME = 'SME';
const TEAM_TEAM_LEADER = 'Team Leader';
const TEAM_TRAINEES = 'Trainees';
const TEAM_APPLICANTS = 'Applicants';
const TRAINEE_ROLE_ID = '1484705126026449029';
const AGENT_ROLE_ID = '1482227287159078964';
const SME_ROLE_ID = '1482382342621233153';
const TEAM_LEADER_ROLE_ID = '1482732583660818636';
const OPERATIONS_MANAGER_ROLE_ID = '1482226842047090809';
const DEVELOPER_ROLE_ID = '1482312134875418737';
const APPLICANTS_ROLE_ID = '1484919969689894912';
const VALID_TEAMS = [TEAM_1, TEAM_2, TEAM_3, TEAM_AGENTS, TEAM_SME, TEAM_TEAM_LEADER, TEAM_TRAINEES, TEAM_APPLICANTS];
const ROLE_LABELS = {
  trainee: 'Trainee',
  agent: 'Agent',
  sme: 'Subject Matter Expert (SME)',
  team_leader: 'Team Leader',
  operations_manager: 'Operations Manager',
  applicant: 'Applicant'
};
const TEAM_ROLE_LOOKUPS = {
  [TEAM_1]: { names: ['team 1', 'team one'] },
  [TEAM_2]: { names: ['team 2', 'team two'] },
  [TEAM_3]: { names: ['team 3', 'team three'] }
};
const SME_ROLE_NAMES = ['subject matter expert', 'sme'];
const TEAM_LEADER_ROLE_NAMES = ['team leader'];
const OPERATIONS_MANAGER_ROLE_NAMES = ['operations manager'];
const DEVELOPER_ROLE_NAMES = ['developer', 'developers'];
const TEAM_ASSIGNMENT_ROLE_NAMES = ['team 1', 'team one', 'team 2', 'team two', 'team 3', 'team three'];
const HOTEL_IDS = ['BW_TO', 'GICP', 'SUP8', 'RMDA', 'AD1', 'TRVL', 'DIBS', 'PROS', 'GLDL', 'INFL', 'VALS', 'BAYT', 'ANPI', 'ECON', 'BUEN', 'QI_RV'];
const HOTEL_GREY_ROLE_IDS = {
  BW_TO: '1483429969807020032',
  GICP: '1484531611549831189',
  SUP8: '1483430096013623427',
  RMDA: '1483430118016684135',
  AD1: '1483430144449187923',
  TRVL: '1484859243671847114',
  DIBS: '1483430045153362012',
  PROS: '1489855140767993997',
  GLDL: '1491275580706918460',
  INFL: '1491280813810126939',
  VALS: '1491280729982898317',
  BAYT: '1491280851785355284',
  ANPI: '1491280889026449589',
  ECON: '1491280957859434576',
  BUEN: '1491281133323681792',
  QI_RV: '1491281264647344268'
};
const HOTEL_GREEN_ROLE_IDS = {
  BW_TO: '1482227783232000070',
  GICP: '1484531060699168778',
  SUP8: '1482227848440971408',
  RMDA: '1483418491464843345',
  AD1: '1483418531180843049',
  TRVL: '1484858995150684170',
  DIBS: '1482227230343041115',
  PROS: '1489855054134640740',
  GLDL: '1491275580706918460',
  INFL: '1491280813810126939',
  VALS: '1491280729982898317',
  BAYT: '1491280851785355284',
  ANPI: '1491280889026449589',
  ECON: '1491280957859434576',
  BUEN: '1491281133323681792',
  QI_RV: '1491281264647344268'
};
const PAYROLL_TEAM_VIEWS = [TEAM_AGENTS, TEAM_SME, TEAM_TEAM_LEADER, TEAM_TRAINEES];
const CUTOFF_FIRST_HALF = 'cutoff_1_15';
const CUTOFF_SECOND_HALF = 'cutoff_16_end';
const FULL_MONTH_EXPORT = 'full_month';
const MANILA_TIMEZONE = 'Asia/Manila';
const CUTOFF_TABLE_MAX_CHARS = 3200;
const ROSTER_PAGE_SIZE = 12;
const CUTOFF_ACTIVE_DAY_PREVIEW_LIMIT = 6;
const CUTOFF_DAILY_LINE_MAX_CHARS = 280;

function normalizeTeamName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'team 1' || raw === 'team1' || raw === '1') return TEAM_1;
  if (raw === 'team 2' || raw === 'team2' || raw === '2') return TEAM_2;
  if (raw === 'team 3' || raw === 'team3' || raw === '3') return TEAM_3;
  if (raw === 'agents' || raw === 'agent') return TEAM_AGENTS;
  if (raw === 'sme' || raw === 'subject matter expert') return TEAM_SME;
  if (raw === 'team leader' || raw === 'teamlead' || raw === 'tl') return TEAM_TEAM_LEADER;
  if (raw === 'trainees' || raw === 'trainee') return TEAM_TRAINEES;
  if (raw === 'applicants' || raw === 'applicant') return TEAM_APPLICANTS;
  return null;
}

function trimToTwoWords(value) {
  const words = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'Unknown';
  return words.slice(0, 2).join(' ');
}

function trimLabel(value, maxLength = 100) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function normalizeRoleKey(role) {
  return String(role || '').trim().toLowerCase();
}

function roleHidesStatus(role) {
  const key = normalizeRoleKey(role);
  return key === 'trainee' || key === 'applicant';
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function uniqueMembersByDiscordId(members = []) {
  const seen = new Set();
  const unique = [];
  for (const member of members || []) {
    const discordId = String(member?.discord_id || '');
    if (!discordId || seen.has(discordId)) continue;
    seen.add(discordId);
    unique.push(member);
  }
  return unique;
}

function getRosterPageData(members = [], requestedPage = 0) {
  const safeMembers = Array.isArray(members) ? members : [];
  const totalMembers = safeMembers.length;
  const totalPages = Math.max(1, Math.ceil(totalMembers / ROSTER_PAGE_SIZE));
  const currentPage = Math.min(parseNonNegativeInt(requestedPage, 0), totalPages - 1);
  const startIndex = currentPage * ROSTER_PAGE_SIZE;
  const endIndexExclusive = Math.min(startIndex + ROSTER_PAGE_SIZE, totalMembers);
  return {
    totalMembers,
    totalPages,
    currentPage,
    startIndex,
    endIndexExclusive,
    pageMembers: safeMembers.slice(startIndex, endIndexExclusive)
  };
}

function buildMemberNameCountMap(members = []) {
  const counts = new Map();
  for (const member of members || []) {
    const baseName = trimToTwoWords(member?.display_name || member?.username).toLowerCase();
    counts.set(baseName, (counts.get(baseName) || 0) + 1);
  }
  return counts;
}

function getRosterMemberName(member, nameCountMap = new Map()) {
  const baseName = trimToTwoWords(member?.display_name || member?.username);
  const duplicateCount = nameCountMap.get(baseName.toLowerCase()) || 0;
  if (duplicateCount <= 1) return baseName;
  const suffix = String(member?.discord_id || '').slice(-4);
  return `${baseName} #${suffix || 'user'}`;
}

function getMemberPickerDescription(member) {
  const roleText = roleLabel(member?.role);
  if (roleHidesStatus(member?.role)) return roleText;
  return `${roleText} | ${statusLabel(member?.agent_status)}`;
}

function serializeHotelSelection(ids = []) {
  const cleaned = [...new Set((ids || []).map(id => String(id || '').trim().toUpperCase()).filter(id => HOTEL_IDS.includes(id)))];
  return cleaned.length > 0 ? cleaned.join(',') : 'none';
}

function parseHotelSelection(value) {
  if (!value || value === 'none') return [];
  return [...new Set(
    String(value)
      .split(',')
      .map(id => id.trim().toUpperCase())
      .filter(id => HOTEL_IDS.includes(id))
  )];
}

function roleLabel(role) {
  const normalized = String(role || '').toLowerCase();
  return ROLE_LABELS[normalized] || 'Agent';
}

function statusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'standby') return 'Standby';
  if (normalized === 'ready') return 'Ready';
  if (normalized === 'pending') return 'Pending';
  return 'Ready';
}

function dateTag(value) {
  if (!value) return 'Not recorded';
  const timestamp = Math.floor(new Date(value).getTime() / 1000);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Not recorded';
  return `<t:${timestamp}:F>`;
}

function getManilaDateParts(nowInput = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = formatter.formatToParts(nowInput).reduce((acc, part) => {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      acc[part.type] = Number.parseInt(part.value, 10);
    }
    return acc;
  }, {});
  return {
    year: Number.isFinite(parts.year) ? parts.year : nowInput.getUTCFullYear(),
    month: Number.isFinite(parts.month) ? parts.month : (nowInput.getUTCMonth() + 1),
    day: Number.isFinite(parts.day) ? parts.day : nowInput.getUTCDate()
  };
}

function isPayrollTeamView(teamName) {
  const normalized = normalizeTeamName(teamName);
  return PAYROLL_TEAM_VIEWS.includes(normalized);
}

function getDaysInManilaMonth(nowInput = new Date()) {
  const manila = getManilaDateParts(nowInput);
  const daysInMonth = new Date(Date.UTC(manila.year, manila.month, 0, 12, 0, 0)).getUTCDate();
  return { manila, daysInMonth };
}

function getCutoffConfig(cutoffKey, nowInput = new Date()) {
  const normalizedKey = cutoffKey === CUTOFF_SECOND_HALF ? CUTOFF_SECOND_HALF : CUTOFF_FIRST_HALF;
  const { daysInMonth } = getDaysInManilaMonth(nowInput);
  const startDay = normalizedKey === CUTOFF_SECOND_HALF ? 16 : 1;
  const endDay = normalizedKey === CUTOFF_SECOND_HALF ? daysInMonth : 15;
  return {
    key: normalizedKey,
    startDay,
    endDay,
    rangeLabel: normalizedKey === CUTOFF_SECOND_HALF ? '16-End' : '1-15',
    exportLabel: normalizedKey === CUTOFF_SECOND_HALF ? 'Days 16-End' : 'Days 1-15'
  };
}

function getFullMonthExportConfig(nowInput = new Date()) {
  const { daysInMonth } = getDaysInManilaMonth(nowInput);
  return {
    key: FULL_MONTH_EXPORT,
    startDay: 1,
    endDay: daysInMonth,
    rangeLabel: '1-End',
    exportLabel: 'Full Month'
  };
}

function buildCutoffDailyLine(monthHistory, startDay, endDay) {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const entries = monthHistory.days
    .filter(day => day.day >= startDay && day.day <= endDay && Number(day.totalHours || 0) > 0)
    .map(day => {
      const weekday = dayNames[new Date(Date.UTC(monthHistory.year, monthHistory.month, day.day, 12, 0, 0)).getUTCDay()];
      const date = String(day.day).padStart(2, '0');
      return `${weekday} ${date} (${formatHours(day.totalHours)}h)`;
    });

  if (entries.length === 0) {
    return 'No logged hours in this cutoff.';
  }

  const preview = entries.slice(0, CUTOFF_ACTIVE_DAY_PREVIEW_LIMIT);
  const moreCount = entries.length - preview.length;
  const moreText = moreCount > 0 ? `, +${moreCount} more day(s)` : '';
  const line = `Active days: ${preview.join(', ')}${moreText}`;
  return line.length > CUTOFF_DAILY_LINE_MAX_CHARS
    ? `${line.slice(0, CUTOFF_DAILY_LINE_MAX_CHARS - 3).trimEnd()}...`
    : line;
}

function getProfilePanelKey(channelId) {
  return `${PROFILE_PANEL_KEY_PREFIX}${channelId}`;
}

function buildTeamPickerRow(customId = 'profiles_team_pick', selectedTeam = null, placeholder = 'Select Group') {
  const normalizedSelected = normalizeTeamName(selectedTeam);
  const team1Description = normalizedSelected === TEAM_1
    ? 'Browse Team 1 members (current)'
    : 'Browse Team 1 members';
  const team2Description = normalizedSelected === TEAM_2
    ? 'Browse Team 2 members (current)'
    : 'Browse Team 2 members';
  const team3Description = normalizedSelected === TEAM_3
    ? 'Browse Team 3 members (current)'
    : 'Browse Team 3 members';
  const agentsDescription = normalizedSelected === TEAM_AGENTS
    ? 'Browse all agent-role members (current)'
    : 'Browse all agent-role members';
  const smeDescription = normalizedSelected === TEAM_SME
    ? 'Browse SME only (current)'
    : 'Browse SME only';
  const teamLeaderDescription = normalizedSelected === TEAM_TEAM_LEADER
    ? 'Browse Team Leader only (current)'
    : 'Browse Team Leader only';
  const traineesDescription = normalizedSelected === TEAM_TRAINEES
    ? 'Browse trainees only (current)'
    : 'Browse trainees only';
  const applicantsDescription = normalizedSelected === TEAM_APPLICANTS
    ? 'Browse applicants only (current)'
    : 'Browse applicants only';

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_1)
        .setDescription(team1Description)
        .setValue(TEAM_1),
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_2)
        .setDescription(team2Description)
        .setValue(TEAM_2),
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_3)
        .setDescription(team3Description)
        .setValue(TEAM_3),
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_AGENTS)
        .setDescription(agentsDescription)
        .setValue(TEAM_AGENTS),
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_SME)
        .setDescription(smeDescription)
        .setValue(TEAM_SME),
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_TEAM_LEADER)
        .setDescription(teamLeaderDescription)
        .setValue(TEAM_TEAM_LEADER),
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_TRAINEES)
        .setDescription(traineesDescription)
        .setValue(TEAM_TRAINEES),
      new StringSelectMenuOptionBuilder()
        .setLabel(TEAM_APPLICANTS)
        .setDescription(applicantsDescription)
        .setValue(TEAM_APPLICANTS)
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildTeamRosterControlRow(teamName, currentPage = 0, totalPages = 1) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_reload_team:${teamName}:${currentPage}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`profiles_roster_page_prev:${teamName}:${currentPage}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalPages <= 1 || currentPage <= 0),
    new ButtonBuilder()
      .setCustomId(`profiles_roster_page_next:${teamName}:${currentPage}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalPages <= 1 || currentPage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`profiles_change_group:${teamName}`)
      .setLabel('Change Group')
      .setStyle(ButtonStyle.Primary)
  );
}

function buildCutoffShortcutRow(teamName) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_view_cutoff:${teamName}:${CUTOFF_FIRST_HALF}`)
      .setLabel('Cutoff 1-15')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`profiles_view_cutoff:${teamName}:${CUTOFF_SECOND_HALF}`)
      .setLabel('Cutoff 16-End')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`profiles_export_month:${teamName}`)
      .setLabel('Excel Month')
      .setStyle(ButtonStyle.Success)
  );
}

function buildCutoffViewRow(teamName, activeCutoff = CUTOFF_FIRST_HALF) {
  const firstStyle = activeCutoff === CUTOFF_FIRST_HALF ? ButtonStyle.Primary : ButtonStyle.Secondary;
  const secondStyle = activeCutoff === CUTOFF_SECOND_HALF ? ButtonStyle.Primary : ButtonStyle.Secondary;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_view_cutoff:${teamName}:${CUTOFF_FIRST_HALF}`)
      .setLabel('Cutoff 1-15')
      .setStyle(firstStyle),
    new ButtonBuilder()
      .setCustomId(`profiles_view_cutoff:${teamName}:${CUTOFF_SECOND_HALF}`)
      .setLabel('Cutoff 16-End')
      .setStyle(secondStyle),
    new ButtonBuilder()
      .setCustomId(`profiles_export_cutoff:${teamName}:${activeCutoff}`)
      .setLabel('Excel')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`profiles_back_team:${teamName}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildDashboardEmbed(activeTeam = null) {
  const selected = normalizeTeamName(activeTeam);
  return new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations - Profiles Kiosk')
    .setDescription(
      '## Welcome to the Profiles Portal\n' +
      '### Secure Agent Management System\n' +
      'This portal is built for fast group browsing, profile review, and developer actions.\n\n' +
      '──────────────────────────────\n' +
      '📋 **Protocol**\n' +
      '1. Select a group below\n' +
      '2. Pick an agent profile\n' +
      '3. Run an approved action\n' +
      '4. Use cutoff shortcuts or Excel Month for payroll checks\n\n' +
      '──────────────────────────────\n' +
      `🏨 **Current Group:** ${selected || 'Not selected'}\n` +
      `👤 **Agents View:** Includes agent-role members across team assignments\n` +
      `🎯 **SME View:** Available in the group picker\n` +
      `🧭 **Team Leader View:** Available in the group picker\n` +
      `🎓 **Trainees View:** Available in the group picker\n` +
      `📄 **Applicants View:** Available in the group picker`
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations - Automated Access Control' })
    .setTimestamp();
}

function formatMemberLine(member, index, nameCountMap = new Map()) {
  const name = getRosterMemberName(member, nameCountMap);
  const role = roleLabel(member.role);
  const status = statusLabel(member.agent_status);
  const details = [role];
  if (!roleHidesStatus(member.role)) {
    details.push(status);
  }
  return `**${index + 1}. ${name}** - ${details.join(' - ')}`;
}

function buildTeamRosterEmbed(teamName, members) {
  const roleCount = members.reduce((acc, member) => {
    const key = String(member.role || 'agent').toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const allRows = members.map(formatMemberLine);
  let rosterText = allRows.length > 0 ? allRows.join('\n') : 'No members found for this view.';
  const maxRosterChars = 3200;
  if (rosterText.length > maxRosterChars) {
    rosterText = `${rosterText.slice(0, maxRosterChars).trimEnd()}\n[Roster trimmed to fit Discord embed limit.]`;
  }

  return new EmbedBuilder()
    .setTitle(`🧾 ${teamName} - Member Profiles`)
    .setDescription(
      `### Group Roster\n${rosterText}\n\n` +
      'Select a member below.'
    )
    .addFields(
      { name: '👥 Total', value: String(members.length), inline: true },
      { name: '🧭 Leads', value: String((roleCount.team_leader || 0) + (roleCount.operations_manager || 0)), inline: true },
      { name: '🎯 SME', value: String(roleCount.sme || 0), inline: true }
    )
    .setColor(
      teamName === TEAM_1 ? 0x2ECC71 :
      teamName === TEAM_AGENTS ? 0x3498DB :
      teamName === TEAM_SME ? 0xE67E22 :
      teamName === TEAM_TEAM_LEADER ? 0x9B59B6 :
      teamName === TEAM_TRAINEES ? 0xF1C40F :
      0x5865F2
    )
    .setFooter({ text: 'Aavgo Operations - Team Browser' })
    .setTimestamp();
}

function buildMemberPickerRow(teamName, members) {
  const options = members.slice(0, 25).map(member => {
    const name = trimToTwoWords(member.display_name || member.username);
    return new StringSelectMenuOptionBuilder()
      .setLabel(trimLabel(name))
      .setDescription(trimLabel(`${roleLabel(member.role)} | ${statusLabel(member.agent_status)}`))
      .setValue(member.discord_id);
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`profiles_agent_pick:${teamName}`)
    .setPlaceholder('Select Member')
    .setOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function buildTeamRosterEmbedPaged(teamName, members, pageIndex = 0) {
  const uniqueMembers = uniqueMembersByDiscordId(members);
  const roleCount = uniqueMembers.reduce((acc, member) => {
    const key = String(member.role || 'agent').toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const pageData = getRosterPageData(uniqueMembers, pageIndex);
  const nameCountMap = buildMemberNameCountMap(uniqueMembers);
  const hasDuplicateNames = [...nameCountMap.values()].some(count => count > 1);
  const allRows = pageData.pageMembers.map((member, rowIndex) =>
    formatMemberLine(member, pageData.startIndex + rowIndex, nameCountMap)
  );
  const rangeText = uniqueMembers.length === 0
    ? '0-0'
    : `${pageData.startIndex + 1}-${pageData.endIndexExclusive}`;

  let rosterText = allRows.length > 0 ? allRows.join('\n') : 'No members found for this view.';
  const maxRosterChars = 3200;
  if (rosterText.length > maxRosterChars) {
    rosterText = `${rosterText.slice(0, maxRosterChars).trimEnd()}\n[Roster trimmed to fit Discord embed limit.]`;
  }
  const duplicateHint = hasDuplicateNames ? '\nDuplicate names are tagged with `#last4` for easier picking.' : '';

  return new EmbedBuilder()
    .setTitle(`🧾 ${teamName} - Member Profiles`)
    .setDescription(
      `### Group Roster (Page ${pageData.currentPage + 1}/${pageData.totalPages})\n` +
      `Showing **${rangeText}** of **${uniqueMembers.length}** members.\n\n` +
      `${rosterText}\n\n` +
      `Select a member below.${duplicateHint}`
    )
    .addFields(
      { name: '👥 Total', value: String(uniqueMembers.length), inline: true },
      { name: '🧭 Leads', value: String((roleCount.team_leader || 0) + (roleCount.operations_manager || 0)), inline: true },
      { name: '🎯 SME', value: String(roleCount.sme || 0), inline: true }
    )
    .setColor(
      teamName === TEAM_1 ? 0x2ECC71 :
      teamName === TEAM_AGENTS ? 0x3498DB :
      teamName === TEAM_SME ? 0xE67E22 :
      teamName === TEAM_TEAM_LEADER ? 0x9B59B6 :
      teamName === TEAM_TRAINEES ? 0xF1C40F :
      0x5865F2
    )
    .setFooter({ text: 'Aavgo Operations - Team Browser' })
    .setTimestamp();
}

function buildMemberPickerRowPaged(teamName, members, pageIndex = 0) {
  const uniqueMembers = uniqueMembersByDiscordId(members);
  const pageData = getRosterPageData(uniqueMembers, pageIndex);
  const nameCountMap = buildMemberNameCountMap(uniqueMembers);
  const options = pageData.pageMembers.map(member => {
    const name = getRosterMemberName(member, nameCountMap);
    return new StringSelectMenuOptionBuilder()
      .setLabel(trimLabel(name))
      .setDescription(trimLabel(getMemberPickerDescription(member)))
      .setValue(member.discord_id);
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`profiles_agent_pick:${teamName}:${pageData.currentPage}`)
    .setPlaceholder('Select Member')
    .setOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function buildTeamRosterPayload(teamName, members, pageIndex = 0) {
  const uniqueMembers = uniqueMembersByDiscordId(members);
  const pageData = getRosterPageData(uniqueMembers, pageIndex);
  const components = [];
  if (uniqueMembers.length > 0) {
    components.push(buildMemberPickerRowPaged(teamName, uniqueMembers, pageData.currentPage));
  }
  components.push(buildTeamRosterControlRow(teamName, pageData.currentPage, pageData.totalPages));
  if (isPayrollTeamView(teamName)) {
    components.push(buildCutoffShortcutRow(teamName));
  }

  return {
    embeds: [buildTeamRosterEmbedPaged(teamName, uniqueMembers, pageData.currentPage)],
    components
  };
}

function buildGroupPickerPayload(selectedTeam = null) {
  return {
    embeds: [buildDashboardEmbed(selectedTeam)],
    components: [buildTeamPickerRow('profiles_team_pick_local', selectedTeam, 'Select Group')]
  };
}

function buildCutoffHoursEmbed(teamName, members, cutoffKey = CUTOFF_FIRST_HALF) {
  const normalizedTeam = normalizeTeamName(teamName) || TEAM_AGENTS;
  const cutoff = getCutoffConfig(cutoffKey);
  const includedMembers = uniqueMembersByDiscordId((members || [])
    .filter(member => member && member.id && member.discord_id)
    .sort((a, b) => String(a.display_name || a.username || '').localeCompare(String(b.display_name || b.username || ''))));

  if (includedMembers.length === 0) {
    return new EmbedBuilder()
      .setTitle(`Cutoff Hours - ${normalizedTeam} (${cutoff.rangeLabel})`)
      .setDescription('No active members found in this view.')
      .setColor(0xED4245)
      .setFooter({ text: 'Aavgo Operations - Cutoff Hours' })
      .setTimestamp();
  }

  let description = '';
  let omitted = 0;
  let combinedHours = 0;
  let activeHoursCount = 0;
  let monthLabel = null;

  for (const member of includedMembers) {
    const monthHistory = getMonthDailyHourHistory(db, member.id, 0);
    if (!monthLabel) monthLabel = monthHistory.label;
    const relevantDays = monthHistory.days.filter(day => day.day >= cutoff.startDay && day.day <= cutoff.endDay);
    const memberTotal = relevantDays.reduce((sum, day) => sum + Number(day.totalHours || 0), 0);
    if (memberTotal > 0) {
      activeHoursCount += 1;
    }
    combinedHours += memberTotal;

    const memberLine = `**${trimToTwoWords(member.display_name || member.username)}** - **${formatHours(memberTotal)}h**\n` +
      `> ${buildCutoffDailyLine(monthHistory, cutoff.startDay, cutoff.endDay)}\n`;
    if ((description + memberLine).length > CUTOFF_TABLE_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    description += memberLine;
  }

  if (!description) {
    description = 'No logged hours found for this cutoff window.';
  }
  if (omitted > 0) {
    description += `\n[${omitted} member row(s) omitted due to Discord length limits.]`;
  }

  return new EmbedBuilder()
    .setTitle(`Cutoff Hours - ${normalizedTeam} (${cutoff.rangeLabel})`)
    .setDescription(
      `**Month:** ${monthLabel || 'Current month'}\n` +
      `**Members Listed:** ${includedMembers.length}\n` +
      `**With Logged Hours:** ${activeHoursCount}\n` +
      `**Combined Hours:** ${formatHours(combinedHours)}h\n\n` +
      `${description}`
    )
    .setColor(0x3498DB)
    .setFooter({ text: 'Aavgo Operations - Cutoff Hours' })
    .setTimestamp();
}

function buildCutoffHoursPayload(teamName, members, cutoffKey = CUTOFF_FIRST_HALF) {
  return {
    embeds: [buildCutoffHoursEmbed(teamName, members, cutoffKey)],
    components: [buildCutoffViewRow(teamName, cutoffKey)]
  };
}

function escapeCsvValue(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function slugifyFilePart(value, fallback = 'export') {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function formatRoundedHourTotal(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return '0';
  return String(Math.round(numeric));
}

function buildHoursExportTitle(teamName, rangeConfig, monthHistory) {
  const teamLabel = normalizeTeamName(teamName) || TEAM_AGENTS;
  const rangeLabel = String(rangeConfig?.exportLabel || rangeConfig?.rangeLabel || 'Hours').trim() || 'Hours';
  const monthLabel = String(monthHistory?.label || 'Current Month').trim() || 'Current Month';
  return `Aavgo ${teamLabel} Hours Export - ${rangeLabel} - ${monthLabel}`;
}

function getCutoffExportSectionLabel(teamName, member) {
  const normalizedTeam = normalizeTeamName(teamName) || TEAM_AGENTS;
  if (normalizedTeam === TEAM_SME || normalizedTeam === TEAM_TEAM_LEADER) {
    return 'SME / TL';
  }

  const primaryLabel = String(member?.primary_hotel_name || '').trim();
  const assignedLabel = String(member?.assigned_hotel_name || '').trim();
  if (primaryLabel) return primaryLabel;
  if (assignedLabel) return assignedLabel;

  return normalizedTeam === TEAM_TRAINEES ? 'Trainees' : 'Unassigned';
}

function getCutoffExportSectionOrder(member) {
  const primaryHotelId = String(member?.primary_hotel_id || '').trim().toUpperCase();
  const assignedHotelId = String(member?.hotel_id || '').trim().toUpperCase();
  const hotelId = primaryHotelId || assignedHotelId;
  const hotelIndex = HOTEL_IDS.indexOf(hotelId);
  return hotelIndex === -1 ? Number.MAX_SAFE_INTEGER : hotelIndex;
}

function buildHoursExportCsv(teamName, members, rangeConfig) {
  const normalizedTeam = normalizeTeamName(teamName) || TEAM_AGENTS;
  const resolvedRange = rangeConfig && Number.isFinite(rangeConfig.startDay) && Number.isFinite(rangeConfig.endDay)
    ? rangeConfig
    : getCutoffConfig(CUTOFF_FIRST_HALF);
  const includedMembers = uniqueMembersByDiscordId((members || [])
    .filter(member => member && member.id && member.discord_id)
    .sort((a, b) => String(a.display_name || a.username || '').localeCompare(String(b.display_name || b.username || ''))));

  const currentManila = getManilaDateParts(new Date());
  const monthHistoryPreview = getMonthDailyHourHistory(db, includedMembers[0]?.id || 0, 0);
  const isCurrentMonthExport =
    monthHistoryPreview.year === currentManila.year &&
    (monthHistoryPreview.month + 1) === currentManila.month;
  const dayHeaders = Array.from({ length: resolvedRange.endDay - resolvedRange.startDay + 1 }, (_, index) => String(resolvedRange.startDay + index));
  const rows = [
    [buildHoursExportTitle(normalizedTeam, resolvedRange, monthHistoryPreview)],
    [],
    ['Name', ...dayHeaders, 'Total']
  ];

  if (includedMembers.length === 0) {
    rows.push(['No active members found in this view.']);
    return rows.map(row => row.map(escapeCsvValue).join(',')).join('\n');
  }

  const sectionBuckets = new Map();
  for (const member of includedMembers) {
    const sectionLabel = getCutoffExportSectionLabel(normalizedTeam, member);
    const monthHistory = getMonthDailyHourHistory(db, member.id, 0);
    const dayValues = [];
    let cutoffTotal = 0;

    for (let day = resolvedRange.startDay; day <= resolvedRange.endDay; day += 1) {
      const dayEntry = monthHistory.days[day - 1];
      const dayHours = Number(dayEntry?.totalHours || 0);
      cutoffTotal += dayHours;
      const isFutureDay = isCurrentMonthExport && day > currentManila.day;
      if (isFutureDay) {
        dayValues.push('');
      } else {
        dayValues.push(dayHours > 0 ? formatHours(dayHours) : 'OFF');
      }
    }

    const bucket = sectionBuckets.get(sectionLabel) || {
      order: getCutoffExportSectionOrder(member),
      members: []
    };
    bucket.order = Math.min(bucket.order, getCutoffExportSectionOrder(member));
    bucket.members.push({
      name: String(member.display_name || member.username || 'Unknown').trim() || 'Unknown',
      dayValues,
      total: formatRoundedHourTotal(cutoffTotal)
    });
    sectionBuckets.set(sectionLabel, bucket);
  }

  const orderedSections = [...sectionBuckets.entries()].sort((a, b) => {
    if (a[1].order !== b[1].order) return a[1].order - b[1].order;
    return a[0].localeCompare(b[0]);
  });

  for (const [sectionLabel, bucket] of orderedSections) {
    rows.push([]);
    rows.push([sectionLabel]);
    const sortedMembers = bucket.members.sort((a, b) => a.name.localeCompare(b.name));
    for (const memberRow of sortedMembers) {
      rows.push([memberRow.name, ...memberRow.dayValues, memberRow.total]);
    }
  }

  while (rows.length > 0 && rows[rows.length - 1].every(cell => !cell)) {
    rows.pop();
  }

  return rows.map(row => row.map(escapeCsvValue).join(',')).join('\n');
}

function buildCutoffExportCsv(teamName, members, cutoffKey = CUTOFF_FIRST_HALF) {
  return buildHoursExportCsv(teamName, members, getCutoffConfig(cutoffKey));
}

function buildMonthExportCsv(teamName, members) {
  return buildHoursExportCsv(teamName, members, getFullMonthExportConfig());
}

async function exportCutoffHoursSpreadsheet(interaction, teamName, cutoffKey = CUTOFF_FIRST_HALF) {
  const normalizedTeam = normalizeTeamName(teamName);
  if (!normalizedTeam || !isPayrollTeamView(normalizedTeam)) {
    return sendComponentReply(interaction, {
      content: 'Cutoff export is available for Agents, SME, Team Leader, and Trainees only.',
      ephemeral: true
    });
  }

  const members = await fetchTeamMembers(interaction.guild, normalizedTeam);
  const cutoff = getCutoffConfig(cutoffKey);
  const csv = buildCutoffExportCsv(normalizedTeam, members, cutoffKey);
  const fileName = [
    'aavgo-cutoff',
    slugifyFilePart(normalizedTeam, 'group'),
    slugifyFilePart(cutoff.rangeLabel, 'cutoff'),
    slugifyFilePart(getMonthDailyHourHistory(db, members[0]?.id || 0, 0).label, 'month')
  ].join('-') + '.csv';

  return sendComponentReply(interaction, {
    content: `Excel cutoff export ready for **${normalizedTeam} (${cutoff.rangeLabel})**. Open the attached CSV in Excel or Google Sheets.`,
    files: [{ attachment: Buffer.from(csv, 'utf8'), name: fileName }],
    ephemeral: true
  });
}

async function exportMonthHoursSpreadsheet(interaction, teamName) {
  const normalizedTeam = normalizeTeamName(teamName);
  if (!normalizedTeam || !isPayrollTeamView(normalizedTeam)) {
    return sendComponentReply(interaction, {
      content: 'Monthly export is available for Agents, SME, Team Leader, and Trainees only.',
      ephemeral: true
    });
  }

  const members = await fetchTeamMembers(interaction.guild, normalizedTeam);
  const monthConfig = getFullMonthExportConfig();
  const csv = buildMonthExportCsv(normalizedTeam, members);
  const fileName = [
    'aavgo-month',
    slugifyFilePart(normalizedTeam, 'group'),
    slugifyFilePart(getMonthDailyHourHistory(db, members[0]?.id || 0, 0).label, 'month')
  ].join('-') + '.csv';

  return sendComponentReply(interaction, {
    content: `Excel month export ready for **${normalizedTeam} (${monthConfig.rangeLabel})**. Open the attached CSV in Excel or Google Sheets.`,
    files: [{ attachment: Buffer.from(csv, 'utf8'), name: fileName }],
    ephemeral: true
  });
}

async function syncLeadershipDiscordRoles(member, role) {
  if (!member) return;

  const leadershipRoleIds = [TEAM_LEADER_ROLE_ID, SME_ROLE_ID, OPERATIONS_MANAGER_ROLE_ID];
  const removeById = leadershipRoleIds
    .map(roleId => member.guild.roles.cache.get(roleId))
    .filter(guildRole => guildRole && member.roles.cache.has(guildRole.id));

  if (removeById.length > 0) {
    await member.roles.remove(removeById).catch(() => {});
  } else {
    const removeNames = ['team leader', 'subject matter expert', 'sme', 'operations manager'];
    const removeRoles = member.guild.roles.cache.filter(guildRole => removeNames.includes(guildRole.name.toLowerCase()));
    if (removeRoles.size > 0) {
      await member.roles.remove(removeRoles).catch(() => {});
    }
  }

  const roleTargetsById = {
    sme: SME_ROLE_ID,
    team_leader: TEAM_LEADER_ROLE_ID,
    operations_manager: OPERATIONS_MANAGER_ROLE_ID
  };
  const roleTargetsByName = {
    sme: ['subject matter expert', 'sme'],
    team_leader: ['team leader'],
    operations_manager: ['operations manager']
  };
  const targetRoleId = roleTargetsById[role] || null;
  if (targetRoleId) {
    const targetRole = member.guild.roles.cache.get(targetRoleId);
    if (targetRole) {
      await member.roles.add(targetRole).catch(() => {});
      return;
    }
  }

  const names = roleTargetsByName[role] || [];

  for (const name of names) {
    const target = member.guild.roles.cache.find(guildRole => guildRole.name.toLowerCase() === name);
    if (target) {
      await member.roles.add(target).catch(() => {});
      break;
    }
  }
}

function canUsePanel(interaction) {
  return auth.isDeveloper(interaction);
}

async function safeDeferComponentUpdate(interaction) {
  if (!interaction || interaction.deferred || interaction.replied) return;
  await interaction.deferUpdate().catch(() => {});
}

function sendComponentUpdate(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.update(payload);
}

function sendComponentReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

async function resolveDisplayName(guild, discordId, fallback) {
  const cached = guild?.members?.cache?.get(discordId);
  if (cached) return cached.displayName;

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (member) return member.displayName;
  return fallback || 'Unknown';
}

function resolveRoleByNames(guild, names = []) {
  const lowered = names.map(name => String(name || '').toLowerCase()).filter(Boolean);
  if (lowered.length === 0) return null;
  return guild.roles.cache.find(role => lowered.includes(String(role.name || '').toLowerCase())) || null;
}

async function getRoleMemberIds(guild, { roleId = null, roleNames = [] } = {}) {
  await guild.members.fetch().catch(() => null);

  const role =
    (roleId ? guild.roles.cache.get(roleId) : null) ||
    resolveRoleByNames(guild, roleNames);

  if (!role) return [];
  return [...role.members.keys()];
}

function memberHasAnyRoleByName(member, names = []) {
  if (!member || !Array.isArray(names) || names.length === 0) return false;
  const lowered = names.map(name => String(name || '').toLowerCase()).filter(Boolean);
  if (lowered.length === 0) return false;
  return member.roles.cache.some(role => lowered.includes(String(role.name || '').toLowerCase()));
}

function memberHasAnyRoleById(member, ids = []) {
  if (!member || !Array.isArray(ids) || ids.length === 0) return false;
  return ids.some(roleId => roleId && member.roles.cache.has(roleId));
}

async function fetchAgentsByDiscordIds(guild, discordIds, forcedRole = null) {
  if (!Array.isArray(discordIds) || discordIds.length === 0) return [];

  const placeholders = discordIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      a.id,
      a.discord_id,
      a.username,
      a.role,
      a.agent_status,
      a.team,
      a.hotel_id,
      h_agent.name AS assigned_hotel_name,
      hsa.primary_hotel_id,
      h_primary.name AS primary_hotel_name,
      hsa.secondary_hotel_id,
      h_secondary.name AS secondary_hotel_name,
      COALESCE(NULLIF(a.team, ''), h_agent.team, h_primary.team, h_secondary.team, 'Team 1') AS effective_team
    FROM agents a
    LEFT JOIN hotels h_agent ON h_agent.id = a.hotel_id
    LEFT JOIN hotel_shift_assignments hsa ON hsa.agent_id = a.id
    LEFT JOIN hotels h_primary ON h_primary.id = hsa.primary_hotel_id
    LEFT JOIN hotels h_secondary ON h_secondary.id = hsa.secondary_hotel_id
    WHERE a.discord_id IN (${placeholders})
    ORDER BY a.username COLLATE NOCASE ASC
  `).all(...discordIds);

  return Promise.all(rows.map(async row => ({
    ...row,
    role: forcedRole || row.role,
    display_name: await resolveDisplayName(guild, row.discord_id, row.username)
  })));
}

async function fetchStrictRoleMembers(guild, {
  includeRoleId = null,
  includeRoleNames = [],
  excludeRoleIds = [],
  excludeRoleNames = [],
  forcedRole = null,
  enforceNoTeamAssignment = false
} = {}) {
  const candidateIds = await getRoleMemberIds(guild, {
    roleId: includeRoleId,
    roleNames: includeRoleNames
  });
  if (candidateIds.length === 0) return [];

  const developerRows = db.prepare('SELECT discord_id FROM developers').all();
  const developerIds = new Set(developerRows.map(row => String(row.discord_id || '')));

  const allowedIds = candidateIds.filter(discordId => {
    const member = guild.members.cache.get(discordId);
    if (!member) return false;
    if (developerIds.has(discordId)) return false;
    if (memberHasAnyRoleById(member, excludeRoleIds)) return false;
    if (memberHasAnyRoleByName(member, excludeRoleNames)) return false;

    if (enforceNoTeamAssignment && memberHasAnyRoleByName(member, TEAM_ASSIGNMENT_ROLE_NAMES)) {
      return false;
    }

    return true;
  });

  return fetchAgentsByDiscordIds(guild, allowedIds, forcedRole);
}

async function fetchTeamMembers(guild, teamName) {
  const normalizedTeam = normalizeTeamName(teamName);
  if (!normalizedTeam || !VALID_TEAMS.includes(normalizedTeam)) return [];

  if (normalizedTeam === TEAM_1 || normalizedTeam === TEAM_2) {
    const teamRoleIds = await getRoleMemberIds(guild, {
      roleNames: TEAM_ROLE_LOOKUPS[normalizedTeam]?.names || [normalizedTeam]
    });
    return fetchAgentsByDiscordIds(guild, teamRoleIds);
  }

  if (normalizedTeam === TEAM_AGENTS) {
    return fetchStrictRoleMembers(guild, {
      includeRoleId: AGENT_ROLE_ID,
      includeRoleNames: ['agents', 'agent'],
      excludeRoleIds: [TRAINEE_ROLE_ID, SME_ROLE_ID, TEAM_LEADER_ROLE_ID, OPERATIONS_MANAGER_ROLE_ID, DEVELOPER_ROLE_ID, APPLICANTS_ROLE_ID],
      excludeRoleNames: ['trainees', 'trainee', 'applicants', 'applicant', ...SME_ROLE_NAMES, ...TEAM_LEADER_ROLE_NAMES, ...OPERATIONS_MANAGER_ROLE_NAMES, ...DEVELOPER_ROLE_NAMES],
      forcedRole: 'agent',
      enforceNoTeamAssignment: false
    });
  }

  if (normalizedTeam === TEAM_SME) {
    return fetchStrictRoleMembers(guild, {
      includeRoleId: SME_ROLE_ID,
      includeRoleNames: SME_ROLE_NAMES,
      excludeRoleIds: [DEVELOPER_ROLE_ID],
      excludeRoleNames: [...DEVELOPER_ROLE_NAMES],
      forcedRole: 'sme',
      enforceNoTeamAssignment: false
    });
  }

  if (normalizedTeam === TEAM_TEAM_LEADER) {
    return fetchStrictRoleMembers(guild, {
      includeRoleNames: TEAM_LEADER_ROLE_NAMES,
      excludeRoleIds: [DEVELOPER_ROLE_ID],
      excludeRoleNames: [...DEVELOPER_ROLE_NAMES],
      forcedRole: 'team_leader',
      enforceNoTeamAssignment: false
    });
  }

  if (normalizedTeam === TEAM_TRAINEES) {
    const traineeRoleIds = await getRoleMemberIds(guild, {
      roleId: TRAINEE_ROLE_ID,
      roleNames: ['trainees', 'trainee']
    });
    return fetchAgentsByDiscordIds(guild, traineeRoleIds, 'trainee');
  }

  if (normalizedTeam === TEAM_APPLICANTS) {
    const applicantIds = await getRoleMemberIds(guild, {
      roleId: APPLICANTS_ROLE_ID,
      roleNames: ['applicants', 'applicant']
    });
    const filtered = applicantIds.filter(discordId => {
      const member = guild.members.cache.get(discordId);
      if (!member) return false;
      if (memberHasAnyRoleById(member, [AGENT_ROLE_ID, TRAINEE_ROLE_ID, SME_ROLE_ID, OPERATIONS_MANAGER_ROLE_ID, DEVELOPER_ROLE_ID])) return false;
      if (memberHasAnyRoleByName(member, [...SME_ROLE_NAMES, ...TEAM_LEADER_ROLE_NAMES, ...OPERATIONS_MANAGER_ROLE_NAMES, ...DEVELOPER_ROLE_NAMES, ...TEAM_ASSIGNMENT_ROLE_NAMES])) return false;
      return true;
    });

    const rows = [];
    for (const discordId of filtered) {
      const member = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
      if (!member) continue;
      rows.push({
        id: null,
        discord_id: discordId,
        username: member.user.username,
        role: 'applicant',
        agent_status: 'pending',
        team: TEAM_APPLICANTS,
        effective_team: TEAM_APPLICANTS,
        display_name: member.displayName
      });
    }
    return rows;
  }

  return [];
}

function hotelName(hotelId) {
  if (!hotelId) return 'Not linked';
  const row = db.prepare('SELECT name FROM hotels WHERE id = ?').get(hotelId);
  return row?.name || hotelId;
}

async function getProfileContext(guild, discordId) {
  const agent = db.prepare(`
    SELECT
      a.id,
      a.discord_id,
      a.username,
      a.pin,
      a.pin_is_set,
      a.role,
      a.team,
      a.hotel_id,
      a.phone,
      a.email,
      a.agent_status,
      COALESCE(NULLIF(a.team, ''), h_agent.team, h_primary.team, h_secondary.team, 'Team 1') AS effective_team
    FROM agents a
    LEFT JOIN hotels h_agent ON h_agent.id = a.hotel_id
    LEFT JOIN hotel_shift_assignments hsa ON hsa.agent_id = a.id
    LEFT JOIN hotels h_primary ON h_primary.id = hsa.primary_hotel_id
    LEFT JOIN hotels h_secondary ON h_secondary.id = hsa.secondary_hotel_id
    WHERE a.discord_id = ?
  `).get(discordId);

  if (!agent) return null;

  const pair = db.prepare(`
    SELECT primary_hotel_id, secondary_hotel_id, created_at
    FROM hotel_shift_assignments
    WHERE agent_id = ?
  `).get(agent.id);

  const pending = db.prepare(`
    SELECT requested_at, email, phone
    FROM pending_registrations
    WHERE discord_id = ?
  `).get(discordId);

  const firstSession = db.prepare(`
    SELECT MIN(login_time) AS first_login
    FROM sessions
    WHERE agent_id = ?
  `).get(agent.id);

  const activeSession = db.prepare(`
    SELECT hotel_id, login_time
    FROM sessions
    WHERE agent_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(agent.id);

  const member = await guild.members.fetch(discordId).catch(() => null);
  const displayName = member?.displayName || agent.username;
  const shortName = trimToTwoWords(displayName);
  const email = agent.email || pending?.email || 'Not set';
  const phone = agent.phone || pending?.phone || 'Not set';
  const appliedAt = pending?.requested_at || firstSession?.first_login;
  const hourTotals = calculateAgentHourTotals(db, agent.id);

  return {
    agent,
    member,
    displayName,
    shortName,
    email,
    phone,
    appliedAt,
    pair,
    activeSession,
    hourTotals
  };
}

function buildProfileEmbed(profile, reviewerTag, notice = null) {
  const { agent, member, shortName, phone, appliedAt, pair, activeSession, hourTotals } = profile;
  const pinText = agent?.pin ? `\`${agent.pin}\`` : 'Not set';
  const pairText = pair
    ? `${hotelName(pair.primary_hotel_id)} + ${hotelName(pair.secondary_hotel_id)}`
    : 'Not set';
  const activeText = activeSession
    ? `${hotelName(activeSession.hotel_id)} since ${dateTag(activeSession.login_time)}`
    : 'Not on an active shift';
  const shiftWeeklyHours = formatHours(hourTotals?.shift?.weeklyHours || 0);
  const shiftMonthlyHours = formatHours(hourTotals?.shift?.monthlyHours || 0);
  const shiftAllTimeHours = formatHours(hourTotals?.shift?.allHours || 0);
  const trainingWeeklyHours = formatHours(hourTotals?.training?.weeklyHours || 0);
  const trainingMonthlyHours = formatHours(hourTotals?.training?.monthlyHours || 0);
  const trainingAllTimeHours = formatHours(hourTotals?.training?.allHours || 0);

  const embed = new EmbedBuilder()
    .setTitle('✅ Active Agent · Verified')
    .setDescription(
      `## 👤 ${shortName}\n` +
      '──────────────────────────────\n' +
      `> 🧑 Discord: <@${agent.discord_id}> (\`${agent.discord_id}\`)\n` +
      `> 📱 Phone (PH): ${phone}\n` +
      `> 🔐 PIN: ${pinText}\n` +
      `> ⏰ Applied At: ${dateTag(appliedAt)}\n` +
      `> 🧩 Role: ${roleLabel(agent.role)}\n` +
      `> 🏨 Team: ${agent.team || profile.agent.effective_team || TEAM_1}\n` +
      `> 🏢 Primary Hotel: ${hotelName(agent.hotel_id)}\n` +
      `> 🔗 Hotel Pair: ${pairText}\n` +
      `> 🟢 Live Session: ${activeText}\n` +
      `> ✅ Live Shift Hours: Weekly ${shiftWeeklyHours} hrs | Monthly ${shiftMonthlyHours} hrs | All-Time ${shiftAllTimeHours} hrs\n` +
      `> 🧪 Training Hours: Weekly ${trainingWeeklyHours} hrs | Monthly ${trainingMonthlyHours} hrs | All-Time ${trainingAllTimeHours} hrs\n` +
      '──────────────────────────────\n' +
      '*Review the profile below.*\n\n' +
      `**Reviewed by:** ${reviewerTag || 'System'}\n` +
      `Member ID: ${agent.discord_id}`
    )
    .setColor(0x2ECC71)
    .setFooter({ text: 'Aavgo Operations - Profile Review' })
    .setTimestamp();

  if (member) {
    embed.setThumbnail(member.displayAvatarURL({ size: 256, extension: 'png' }));
  }

  if (notice) {
    embed.addFields({ name: 'Update', value: notice, inline: false });
  }

  return embed;
}

function getHotelChoiceRows() {
  const placeholders = HOTEL_IDS.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, name
    FROM hotels
    WHERE id IN (${placeholders})
  `).all(...HOTEL_IDS);

  if (!rows || rows.length === 0) {
    return HOTEL_IDS.map(id => ({ id, name: hotelName(id) }));
  }

  const byId = new Map(rows.map(row => [row.id, row]));
  return HOTEL_IDS
    .map(id => byId.get(id))
    .filter(Boolean);
}

function buildProfileActionRow(targetDiscordId, teamName) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_set_role:${targetDiscordId}:${teamName}`)
      .setLabel('Set Role')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`profiles_set_team:${targetDiscordId}:${teamName}`)
      .setLabel('Set Team')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`profiles_set_hotel:${targetDiscordId}:${teamName}`)
      .setLabel('Set Hotel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`profiles_kick:${targetDiscordId}`)
      .setLabel('Kick')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`profiles_view_hours:${targetDiscordId}:${teamName}`)
      .setLabel('View Hour History')
      .setStyle(ButtonStyle.Primary)
  );
}

function buildProfileBackRow(teamName) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_back_team:${teamName}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildBackToProfileRow(targetDiscordId, teamName) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_back_profile:${targetDiscordId}:${teamName}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildSetRoleMenuRow(targetDiscordId, teamName) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`profiles_set_role_pick:${targetDiscordId}:${teamName}`)
      .setPlaceholder('Select role rank')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Applicant').setDescription('Set as Applicant role').setValue('applicant'),
        new StringSelectMenuOptionBuilder().setLabel('Trainee').setDescription('Set as Trainee role').setValue('trainee'),
        new StringSelectMenuOptionBuilder().setLabel('Agent').setDescription('Set as Agent role').setValue('agent'),
        new StringSelectMenuOptionBuilder().setLabel('SME').setDescription('Set as Subject Matter Expert').setValue('sme'),
        new StringSelectMenuOptionBuilder().setLabel('Team Leader').setDescription('Set as Team Leader').setValue('team_leader')
      )
  );
}

function buildSetTeamMenuRow(targetDiscordId, teamName) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`profiles_set_team_pick:${targetDiscordId}:${teamName}`)
      .setPlaceholder('Select team')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel(TEAM_1).setDescription('Assign Team 1 role').setValue(TEAM_1),
        new StringSelectMenuOptionBuilder().setLabel(TEAM_2).setDescription('Assign Team 2 role').setValue(TEAM_2),
        new StringSelectMenuOptionBuilder().setLabel(TEAM_3).setDescription('Assign Team 3 role').setValue(TEAM_3)
      )
  );
}

function buildSetHotelModeRow(targetDiscordId, teamName) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_set_hotel_mode_single:${targetDiscordId}:${teamName}`)
      .setLabel('1 Hotel')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`profiles_set_hotel_mode_multi:${targetDiscordId}:${teamName}`)
      .setLabel('+2 Hotels')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`profiles_back_profile:${targetDiscordId}:${teamName}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildSingleHotelMenuRow(targetDiscordId, teamName) {
  const options = getHotelChoiceRows().map(row =>
    new StringSelectMenuOptionBuilder()
      .setLabel(trimLabel(row.name, 100))
      .setDescription(trimLabel(`Assign ${row.name}`, 100))
      .setValue(row.id)
  );

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`profiles_set_hotel_single_pick:${targetDiscordId}:${teamName}`)
      .setPlaceholder('Select one hotel')
      .setOptions(options)
  );
}

function buildMultiHotelMenuRow(targetDiscordId, teamName, selectedHotels = []) {
  const selected = parseHotelSelection(serializeHotelSelection(selectedHotels));
  const availableRows = getHotelChoiceRows().filter(row => !selected.includes(row.id));
  const options = availableRows.map(row =>
    new StringSelectMenuOptionBuilder()
      .setLabel(trimLabel(row.name, 100))
      .setDescription(trimLabel(`Add ${row.name}`, 100))
      .setValue(row.id)
  );
  const fallbackOption = new StringSelectMenuOptionBuilder()
    .setLabel('No more hotels available')
    .setDescription('All available hotels are already selected')
    .setValue('none');

  const serialized = serializeHotelSelection(selected);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`profiles_set_hotel_multi_pick:${targetDiscordId}:${teamName}:${serialized}`)
      .setPlaceholder(selected.length < 2 ? `Select hotel #${selected.length + 1}` : 'Add another hotel')
      .setOptions(options.length > 0 ? options : [fallbackOption])
      .setDisabled(options.length === 0)
  );
}

function buildMultiHotelActionRow(targetDiscordId, teamName, selectedHotels = []) {
  const selected = parseHotelSelection(serializeHotelSelection(selectedHotels));
  const serialized = serializeHotelSelection(selected);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_set_hotel_multi_add:${targetDiscordId}:${teamName}:${serialized}`)
      .setLabel('+ Add Hotel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(selected.length >= HOTEL_IDS.length),
    new ButtonBuilder()
      .setCustomId(`profiles_set_hotel_multi_save:${targetDiscordId}:${teamName}:${serialized}`)
      .setLabel('Save Hotels')
      .setStyle(ButtonStyle.Success)
      .setDisabled(selected.length < 2),
    new ButtonBuilder()
      .setCustomId(`profiles_back_profile:${targetDiscordId}:${teamName}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildConfirmEmbed(action, discordId) {
  const actionLabel = action === 'ban' ? 'BAN' : 'KICK';
  return new EmbedBuilder()
    .setTitle(`Confirm ${actionLabel}`)
    .setDescription(
      `Are you sure you want to ${action.toUpperCase()} <@${discordId}>?\n\n` +
      'This action needs a second confirmation.'
    )
    .setColor(0xED4245)
    .setFooter({ text: 'Aavgo Operations - Safety Confirmation' })
    .setTimestamp();
}

function buildConfirmRow(action, discordId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_confirm:${action}:${discordId}`)
      .setLabel(`Yes, ${action}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`profiles_cancel:${discordId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildProfileRows(profile, teamName) {
  return [
    buildProfileActionRow(profile.agent.discord_id, teamName),
    buildProfileBackRow(teamName)
  ];
}

function buildConfigEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Operations - Profile Actions' })
    .setTimestamp();
}

function buildHourHistoryEmbed(profile, monthHistory) {
  const header = 'Date | Shift | Training | Total';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows = monthHistory.days.map(day => {
    const date = String(day.day).padStart(2, '0');
    const weekday = dayNames[new Date(Date.UTC(monthHistory.year, monthHistory.month, day.day, 12, 0, 0)).getUTCDay()];
    return `${weekday} ${date} | ${formatHours(day.shiftHours)}h | ${formatHours(day.trainingHours)}h | ${formatHours(day.totalHours)}h`;
  });

  let calendarTable = `${header}\n${rows.join('\n')}`;
  const maxChars = 1700;
  if (calendarTable.length > maxChars) {
    calendarTable = `${calendarTable.slice(0, maxChars).trimEnd()}\n[Trimmed for Discord limit]`;
  }

  return new EmbedBuilder()
    .setTitle('Hour History Calendar')
    .setDescription(
      `## ${profile.shortName} - ${monthHistory.label}\n` +
      `> Live Shift Total (Month): ${formatHours(monthHistory.monthShiftHours)} hrs\n` +
      `> Training Total (Month): ${formatHours(monthHistory.monthTrainingHours)} hrs\n` +
      `> Combined Total (Month): ${formatHours(monthHistory.monthTotalHours)} hrs\n\n` +
      '```text\n' +
      `${calendarTable}\n` +
      '```\n\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '**Month Summary**\n' +
      `Live Shift: **${formatHours(monthHistory.monthShiftHours)} hrs**\n` +
      `Training: **${formatHours(monthHistory.monthTrainingHours)} hrs**\n` +
      `Total: **${formatHours(monthHistory.monthTotalHours)} hrs**`
    )
    .setColor(0x3498DB)
    .setFooter({ text: 'Aavgo Operations - Monthly Hour History' })
    .setTimestamp();
}

function buildHourHistoryRowsForOffset(discordId, teamName, monthOffset = 0) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`profiles_view_hours_prev:${discordId}:${teamName}:${monthOffset - 1}`)
        .setLabel('Previous Records')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`profiles_back_profile:${discordId}:${teamName}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function summarizeHotelSelection(selectedHotels = []) {
  const selected = parseHotelSelection(serializeHotelSelection(selectedHotels));
  if (selected.length === 0) return 'No hotels selected yet.';
  return selected.map((hotelId, index) => `${index + 1}. ${hotelName(hotelId)} (\`${hotelId}\`)`).join('\n');
}

async function syncTeamDiscordRoles(member, teamName) {
  if (!member || !teamName) return;
  const target = member.guild.roles.cache.find(role => String(role.name || '').toLowerCase() === String(teamName || '').toLowerCase());
  const otherTeamName = teamName === TEAM_1 ? TEAM_2 : TEAM_1;
  const other = member.guild.roles.cache.find(role => String(role.name || '').toLowerCase() === String(otherTeamName || '').toLowerCase());

  if (other && member.roles.cache.has(other.id)) {
    await member.roles.remove(other).catch(() => {});
  }
  if (target && !member.roles.cache.has(target.id)) {
    await member.roles.add(target).catch(() => {});
  }
}

async function syncBaseRoleDiscordRoles(member, roleValue) {
  if (!member) return;

  const applicantRole = member.guild.roles.cache.get(APPLICANTS_ROLE_ID) ||
    member.guild.roles.cache.find(role => String(role.name || '').toLowerCase() === 'applicants');
  const traineeRole = member.guild.roles.cache.get(TRAINEE_ROLE_ID) ||
    member.guild.roles.cache.find(role => String(role.name || '').toLowerCase() === 'trainees');
  const agentsRole = member.guild.roles.cache.get(AGENT_ROLE_ID) ||
    member.guild.roles.cache.find(role => String(role.name || '').toLowerCase() === 'agents');

  const normalized = String(roleValue || '').toLowerCase();
  if (normalized === 'applicant') {
    if (traineeRole && member.roles.cache.has(traineeRole.id)) {
      await member.roles.remove(traineeRole).catch(() => {});
    }
    if (agentsRole && member.roles.cache.has(agentsRole.id)) {
      await member.roles.remove(agentsRole).catch(() => {});
    }
    if (applicantRole && !member.roles.cache.has(applicantRole.id)) {
      await member.roles.add(applicantRole).catch(() => {});
    }
    return;
  }

  if (normalized === 'trainee') {
    if (applicantRole && member.roles.cache.has(applicantRole.id)) {
      await member.roles.remove(applicantRole).catch(() => {});
    }
    if (agentsRole && member.roles.cache.has(agentsRole.id)) {
      await member.roles.remove(agentsRole).catch(() => {});
    }
    if (traineeRole && !member.roles.cache.has(traineeRole.id)) {
      await member.roles.add(traineeRole).catch(() => {});
    }
    return;
  }

  if (normalized === 'agent') {
    if (applicantRole && member.roles.cache.has(applicantRole.id)) {
      await member.roles.remove(applicantRole).catch(() => {});
    }
    if (traineeRole && member.roles.cache.has(traineeRole.id)) {
      await member.roles.remove(traineeRole).catch(() => {});
    }
    if (agentsRole && !member.roles.cache.has(agentsRole.id)) {
      await member.roles.add(agentsRole).catch(() => {});
    }
    return;
  }

  if (applicantRole && member.roles.cache.has(applicantRole.id)) {
    await member.roles.remove(applicantRole).catch(() => {});
  }
  if (traineeRole && member.roles.cache.has(traineeRole.id)) {
    await member.roles.remove(traineeRole).catch(() => {});
  }
  if (agentsRole && member.roles.cache.has(agentsRole.id)) {
    await member.roles.remove(agentsRole).catch(() => {});
  }
}

async function syncHotelDiscordRoles(member, selectedHotels = []) {
  if (!member) return;
  const selected = parseHotelSelection(serializeHotelSelection(selectedHotels));

  const selectedRoleIds = selected.flatMap(hotelId => [
    HOTEL_GREY_ROLE_IDS[hotelId],
    HOTEL_GREEN_ROLE_IDS[hotelId]
  ].filter(Boolean));
  if (selectedRoleIds.length === 0) return;

  const allHotelRoleIds = [
    ...Object.values(HOTEL_GREY_ROLE_IDS),
    ...Object.values(HOTEL_GREEN_ROLE_IDS)
  ];
  const allHotelRoles = allHotelRoleIds
    .map(roleId => member.guild.roles.cache.get(roleId))
    .filter(Boolean);
  if (allHotelRoles.length > 0) {
    await member.roles.remove(allHotelRoles).catch(() => {});
  }

  const selectedGreyRoles = selected
    .map(hotelId => member.guild.roles.cache.get(HOTEL_GREY_ROLE_IDS[hotelId]))
    .filter(Boolean);
  if (selectedGreyRoles.length > 0) {
    await member.roles.add(selectedGreyRoles).catch(() => {});
  }
}

function memberHasAgentAccess(member) {
  return memberHasAnyRoleById(member, [AGENT_ROLE_ID]) || memberHasAnyRoleByName(member, ['agents', 'agent']);
}

function memberHasTeamAccess(member) {
  return memberHasAnyRoleByName(member, [TEAM_1, TEAM_2, TEAM_3, 'team 1', 'team 2', 'team 3', 'team one', 'team two', 'team three']);
}

function buildAccessRequirementEmbed(title, description, requirement) {
  return buildConfigEmbed(
    title,
    `${description}\n\n**Required before continuing:** ${requirement}`
  );
}

async function applyRoleUpdate(interaction, discordId, roleValue, teamName) {
  const normalized = String(roleValue || '').toLowerCase();
  const allowed = ['applicant', 'trainee', 'agent', 'sme', 'team_leader'];
  if (!allowed.includes(normalized)) {
    return sendComponentUpdate(interaction, { content: 'Invalid role selected.', embeds: [], components: [] });
  }

  const current = db.prepare('SELECT role, team FROM agents WHERE discord_id = ?').get(discordId);
  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  const displayName = member?.displayName || member?.user?.username || 'Unknown';
  const seededTeam = normalizeTeamName(teamName);
  const resolvedTeam = [TEAM_1, TEAM_2].includes(seededTeam) ? seededTeam : current?.team || null;

  if (!current) {
    const bootstrapPin = String(Math.floor(100000 + Math.random() * 900000));
    const bootstrapStatus = normalized === 'applicant' ? 'pending' : (normalized === 'trainee' ? 'standby' : 'ready');
    db.prepare(
      'INSERT INTO agents (discord_id, username, pin, pin_is_set, role, agent_status, team, hotel_compatibility) VALUES (?, ?, ?, 0, ?, ?, ?, ?)'
    ).run(discordId, displayName, bootstrapPin, normalized, bootstrapStatus, resolvedTeam, '[]');
  } else {
    db.prepare('UPDATE agents SET role = ?, team = COALESCE(?, team) WHERE discord_id = ?').run(normalized, resolvedTeam, discordId);
  }

  await syncBaseRoleDiscordRoles(member, normalized);
  await syncLeadershipDiscordRoles(member, normalized === 'trainee' ? 'agent' : normalized);

  return showProfileCard(interaction, discordId, {
    teamName,
    notice: `Role set to ${roleLabel(normalized)}.`
  });
}

async function applyTeamUpdate(interaction, discordId, selectedTeam, teamName) {
  const normalizedTeam = normalizeTeamName(selectedTeam);
  if (![TEAM_1, TEAM_2].includes(normalizedTeam)) {
    return sendComponentUpdate(interaction, { content: 'Invalid team selected.', embeds: [], components: [] });
  }

  const current = db.prepare('SELECT role FROM agents WHERE discord_id = ?').get(discordId);
  if (!current) {
    return sendComponentUpdate(interaction, { content: 'Agent not found in database.', embeds: [], components: [] });
  }

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!memberHasAgentAccess(member)) {
    return sendComponentUpdate(interaction, {
      embeds: [
        buildAccessRequirementEmbed(
          'Set Team Locked',
          `You are trying to assign a team to <@${discordId}>.`,
          'They must already have the Agent role first.'
        )
      ],
      components: [buildBackToProfileRow(discordId, teamName)]
    });
  }

  db.prepare('UPDATE agents SET team = ? WHERE discord_id = ?').run(normalizedTeam, discordId);
  await syncTeamDiscordRoles(member, normalizedTeam);

  return showProfileCard(interaction, discordId, {
    teamName,
    notice: `Team set to ${normalizedTeam}.`
  });
}

async function applySingleHotelUpdate(interaction, discordId, hotelId, teamName) {
  if (!HOTEL_IDS.includes(hotelId)) {
    return sendComponentUpdate(interaction, { content: 'Invalid hotel selected.', embeds: [], components: [] });
  }

  const current = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get(discordId);
  if (!current) {
    return sendComponentUpdate(interaction, { content: 'Agent not found in database.', embeds: [], components: [] });
  }

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!memberHasAgentAccess(member) || !memberHasTeamAccess(member)) {
    return sendComponentUpdate(interaction, {
      embeds: [
        buildAccessRequirementEmbed(
          'Set Hotel Locked',
          `You are trying to assign a hotel to <@${discordId}>.`,
          'They must already have the Agent role and a Team 1 / Team 2 / Team 3 role first.'
        )
      ],
      components: [buildBackToProfileRow(discordId, teamName)]
    });
  }

  db.transaction(() => {
    db.prepare('UPDATE agents SET hotel_id = ? WHERE id = ?').run(hotelId, current.id);
    db.prepare('DELETE FROM hotel_shift_assignments WHERE agent_id = ?').run(current.id);
  })();

  await syncHotelDiscordRoles(member, [hotelId]);

  return showProfileCard(interaction, discordId, {
    teamName,
    notice: `Primary hotel set to ${hotelName(hotelId)}.`
  });
}

async function applyMultiHotelUpdate(interaction, discordId, selectedHotels, teamName) {
  const selected = parseHotelSelection(serializeHotelSelection(selectedHotels));
  if (selected.length < 2) {
    return sendComponentUpdate(interaction, { content: 'Please select at least 2 hotels for this mode.', embeds: [], components: [] });
  }

  const current = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get(discordId);
  if (!current) {
    return sendComponentUpdate(interaction, { content: 'Agent not found in database.', embeds: [], components: [] });
  }

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!memberHasAgentAccess(member) || !memberHasTeamAccess(member)) {
    return sendComponentUpdate(interaction, {
      embeds: [
        buildAccessRequirementEmbed(
          'Set Hotel Locked',
          `You are trying to assign multiple hotels to <@${discordId}>.`,
          'They must already have the Agent role and a Team 1 / Team 2 / Team 3 role first.'
        )
      ],
      components: [buildBackToProfileRow(discordId, teamName)]
    });
  }

  db.transaction(() => {
    db.prepare('UPDATE agents SET hotel_id = ? WHERE id = ?').run(selected[0], current.id);
    db.prepare('DELETE FROM hotel_shift_assignments WHERE agent_id = ?').run(current.id);
    db.prepare(`
      INSERT INTO hotel_shift_assignments (agent_id, primary_hotel_id, secondary_hotel_id, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(current.id, selected[0], selected[1]);
  })();

  await syncHotelDiscordRoles(member, selected);

  const selectedLabel = selected.map(hotelId => hotelName(hotelId)).join(', ');
  const note = selected.length > 2
    ? `Hotels updated: ${selectedLabel}. (DB pair stores first two; roles include all selected.)`
    : `Hotels updated: ${selectedLabel}.`;

  return showProfileCard(interaction, discordId, {
    teamName,
    notice: note
  });
}

async function showProfileCard(interaction, discordId, options = {}) {
  const profile = await getProfileContext(interaction.guild, discordId);
  if (!profile) {
    const teamName = normalizeTeamName(options.teamName);
    if (teamName === TEAM_APPLICANTS) {
      const member = await interaction.guild.members.fetch(discordId).catch(() => null);
      if (member) {
        return sendComponentUpdate(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('📄 Applicant · Pending Review')
              .setDescription(
                `## 👤 ${trimToTwoWords(member.displayName || member.user.username)}\n` +
                '────────────────────────\n' +
                `> 🧑 Discord: <@${member.id}> (\`${member.id}\`)\n` +
                `> 🏷️ Username: ${member.user.username}\n` +
                `> 📌 Role: Applicant\n` +
                `> 🟡 Status: Pending\n` +
                '────────────────────────\n' +
                '*This member is only in the Applicant pool right now.*'
              )
              .setColor(0xF1C40F)
              .setThumbnail(member.displayAvatarURL({ size: 256, extension: 'png' }))
              .setFooter({ text: 'Aavgo Operations - Applicant Review' })
              .setTimestamp()
          ],
          components: [
            buildProfileActionRow(discordId, teamName || TEAM_APPLICANTS),
            buildProfileBackRow(teamName || TEAM_APPLICANTS)
          ]
        });
      }
    }

    return sendComponentUpdate(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Profile Not Found')
          .setDescription('That user is not registered as an agent.')
          .setColor(0xED4245)
      ],
      components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_AGENTS, 'Select Group')]
    });
  }

  const teamName = normalizeTeamName(options.teamName) || normalizeTeamName(profile.agent.effective_team) || TEAM_1;
  const embed = buildProfileEmbed(profile, interaction.user.tag, options.notice || null);
  const rows = buildProfileRows(profile, teamName);

  return sendComponentUpdate(interaction, {
    embeds: [embed],
    components: rows
  });
}

async function ensureProfilesDashboard(client, channelId = PROFILES_CHANNEL_ID) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[PROFILES] Profiles channel not found or not text-based:', channelId);
    return null;
  }

  const key = getProfilePanelKey(channelId);
  const existingId = db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value;
  const payload = {
    embeds: [buildDashboardEmbed()],
    components: [buildTeamPickerRow('profiles_team_pick')]
  };

  if (existingId) {
    const existingMessage = await channel.messages.fetch(existingId).catch(() => null);
    if (existingMessage) {
      await existingMessage.edit(payload).catch(() => {});
      return existingMessage;
    }
  }

  const message = await channel.send(payload);
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, message.id);
  return message;
}

async function handleSetupProfiles(interaction) {
  if (!canUsePanel(interaction)) {
    return interaction.reply({ content: 'Developer access required.', ephemeral: true });
  }

  await ensureProfilesDashboard(interaction.client, PROFILES_CHANNEL_ID);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content: `Profiles dashboard refreshed in <#${PROFILES_CHANNEL_ID}>.` });
  }
  return interaction.reply({ content: `Profiles dashboard refreshed in <#${PROFILES_CHANNEL_ID}>.`, ephemeral: true });
}

async function handleTeamPick(interaction) {
  if (!canUsePanel(interaction)) {
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: 'Developer access required.' });
    }
    return interaction.reply({ content: 'Developer access required.', ephemeral: true });
  }

  await safeDeferComponentUpdate(interaction);

  const teamName = normalizeTeamName(interaction.values?.[0]);
  if (!teamName) {
    if (interaction.customId === 'profiles_team_pick_local') {
      return sendComponentUpdate(interaction, buildGroupPickerPayload());
    }
    return sendComponentReply(interaction, { content: 'Invalid team selection.', ephemeral: true });
  }

  const members = await fetchTeamMembers(interaction.guild, teamName);
  const payload = buildTeamRosterPayload(teamName, members);

  if (interaction.customId === 'profiles_team_pick') {
    await sendComponentUpdate(interaction, {
      embeds: [buildDashboardEmbed(teamName)],
      components: [buildTeamPickerRow('profiles_team_pick', teamName, 'Select Group')]
    });
    return sendComponentReply(interaction, { ...payload, ephemeral: true });
  }

  return sendComponentUpdate(interaction, payload);
}

async function handleBackToTeam(interaction) {
  const { teamName, pageIndex } = parseTeamPageContext(interaction.customId, 'profiles_back_team:');
  const members = await fetchTeamMembers(interaction.guild, teamName);
  return sendComponentUpdate(interaction, buildTeamRosterPayload(teamName, members, pageIndex));
}

async function handleChangeGroup(interaction) {
  const currentTeam = normalizeTeamName(interaction.customId.split(':')[1]) || null;
  return sendComponentUpdate(interaction, buildGroupPickerPayload(currentTeam));
}

async function handleAgentPick(interaction) {
  if (!canUsePanel(interaction)) {
    return sendComponentUpdate(interaction, { content: 'Developer access required.', embeds: [], components: [] });
  }

  await safeDeferComponentUpdate(interaction);

  const { teamName } = parseTeamPageContext(interaction.customId, 'profiles_agent_pick:');
  const discordId = interaction.values?.[0];

  return showProfileCard(interaction, discordId, { teamName });
}

function parseProfileActionContext(customId, prefix) {
  const raw = String(customId || '').slice(prefix.length);
  const [discordId = '', rawTeam = TEAM_1, extra = ''] = raw.split(':');
  return {
    discordId,
    teamName: normalizeTeamName(rawTeam) || TEAM_1,
    extra
  };
}

function parseTeamPageContext(customId, prefix) {
  const raw = String(customId || '').slice(prefix.length);
  const [rawTeam = TEAM_AGENTS, rawPage = '0'] = raw.split(':');
  return {
    teamName: normalizeTeamName(rawTeam) || TEAM_AGENTS,
    pageIndex: parseNonNegativeInt(rawPage, 0)
  };
}

async function showSetRoleView(interaction, discordId, teamName) {
  return sendComponentUpdate(interaction, {
    embeds: [
      buildConfigEmbed(
        'Set Role',
        `Select the rank for <@${discordId}>.\n\nOptions: Applicant, Trainee, Agent, SME, Team Leader.`
      )
    ],
    components: [
      buildSetRoleMenuRow(discordId, teamName),
      buildBackToProfileRow(discordId, teamName)
    ]
  });
}

async function showSetTeamView(interaction, discordId, teamName) {
  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!memberHasAgentAccess(member)) {
    return sendComponentUpdate(interaction, {
      embeds: [
        buildAccessRequirementEmbed(
          'Set Team Locked',
          `You are trying to assign a team to <@${discordId}>.`,
          'They must already have the Agent role first.'
        )
      ],
      components: [buildBackToProfileRow(discordId, teamName)]
    });
  }

  return sendComponentUpdate(interaction, {
    embeds: [
      buildConfigEmbed(
        'Set Team',
        `Select the team role for <@${discordId}>.`
      )
    ],
    components: [
      buildSetTeamMenuRow(discordId, teamName),
      buildBackToProfileRow(discordId, teamName)
    ]
  });
}

async function showSetHotelModeView(interaction, discordId, teamName) {
  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!memberHasAgentAccess(member) || !memberHasTeamAccess(member)) {
    return sendComponentUpdate(interaction, {
      embeds: [
        buildAccessRequirementEmbed(
          'Set Hotel Locked',
          `You are trying to assign hotel access to <@${discordId}>.`,
          'They must already have the Agent role and a Team 1 / Team 2 / Team 3 role first.'
        )
      ],
      components: [buildBackToProfileRow(discordId, teamName)]
    });
  }

  return sendComponentUpdate(interaction, {
    embeds: [
      buildConfigEmbed(
        'Set Hotel',
        `Choose hotel assignment mode for <@${discordId}>.\n\nUse \`1 Hotel\` for a single assignment, or \`+2 Hotels\` to assign multiple hotels.`
      )
    ],
    components: [buildSetHotelModeRow(discordId, teamName)]
  });
}

async function showSingleHotelPickerView(interaction, discordId, teamName) {
  return sendComponentUpdate(interaction, {
    embeds: [
      buildConfigEmbed(
        'Set Hotel - 1 Hotel',
        `Select one hotel for <@${discordId}>.`
      )
    ],
    components: [
      buildSingleHotelMenuRow(discordId, teamName),
      buildBackToProfileRow(discordId, teamName)
    ]
  });
}

async function showMultiHotelPickerView(interaction, discordId, teamName, selectedHotels = []) {
  const selected = parseHotelSelection(serializeHotelSelection(selectedHotels));
  const summary = summarizeHotelSelection(selected);
  const guidance = selected.length < 2
    ? 'Select at least 2 hotels, then click Save Hotels.'
    : 'You can add more hotels with + Add Hotel, then click Save Hotels.';

  return sendComponentUpdate(interaction, {
    embeds: [
      buildConfigEmbed(
        'Set Hotel - +2 Hotels',
        `Current selection for <@${discordId}>:\n${summary}\n\n${guidance}`
      )
    ],
    components: [
      buildMultiHotelMenuRow(discordId, teamName, selected),
      buildMultiHotelActionRow(discordId, teamName, selected)
    ]
  });
}

async function showHourHistoryView(interaction, discordId, teamName, monthOffset = 0) {
  const profile = await getProfileContext(interaction.guild, discordId);
  if (!profile) {
    return sendComponentUpdate(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Profile Not Found')
          .setDescription('That user is not registered as an agent.')
          .setColor(0xED4245)
      ],
      components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_AGENTS, 'Select Group')]
    });
  }

  const monthHistory = getMonthDailyHourHistory(db, profile.agent.id, monthOffset);
  return sendComponentUpdate(interaction, {
    embeds: [buildHourHistoryEmbed(profile, monthHistory)],
    components: buildHourHistoryRowsForOffset(discordId, teamName, monthOffset)
  });
}

async function showCutoffHoursView(interaction, teamName, cutoffKey = CUTOFF_FIRST_HALF) {
  const normalizedTeam = normalizeTeamName(teamName);
  if (!normalizedTeam || !isPayrollTeamView(normalizedTeam)) {
    return sendComponentUpdate(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Cutoff Hours Not Available')
          .setDescription(
            'Cutoff hours are available for these group views only:\n' +
            '- Agents\n' +
            '- SME\n' +
            '- Team Leader\n' +
            '- Trainees\n\n' +
            'Use Change Group first, then open cutoff hours.'
          )
          .setColor(0xED4245)
          .setFooter({ text: 'Aavgo Operations - Cutoff Hours' })
          .setTimestamp()
      ],
      components: [buildTeamRosterControlRow(normalizedTeam || TEAM_AGENTS)]
    });
  }

  const members = await fetchTeamMembers(interaction.guild, normalizedTeam);
  return sendComponentUpdate(interaction, buildCutoffHoursPayload(normalizedTeam, members, cutoffKey));
}

async function handleKickOrBanConfirm(interaction, action, discordId) {
  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    return sendComponentUpdate(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Action Failed')
          .setDescription('Member is no longer in this server.')
          .setColor(0xED4245)
      ],
      components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_AGENTS, 'Select Group')]
    });
  }

  const reason = `Profiles panel action by ${interaction.user.tag}`;
  if (action === 'ban') {
    await member.ban({ reason }).catch(() => {});
  } else {
    await member.kick(reason).catch(() => {});
  }

  return sendComponentUpdate(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle(`${action === 'ban' ? 'Ban' : 'Kick'} Completed`)
        .setDescription(`<@${discordId}> was ${action === 'ban' ? 'banned' : 'kicked'} from the server.`)
        .setColor(0x57F287)
        .setTimestamp()
    ],
    components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_AGENTS, 'Select Group')]
  });
}

async function handleButton(interaction) {
  if (!canUsePanel(interaction)) {
    return interaction.reply({ content: 'Developer access required.', ephemeral: true });
  }

  await safeDeferComponentUpdate(interaction);

  const customId = interaction.customId || '';
  if (customId.startsWith('profiles_back_team:')) {
    return handleBackToTeam(interaction);
  }

  if (customId.startsWith('profiles_change_group:')) {
    return handleChangeGroup(interaction);
  }

  if (customId.startsWith('profiles_roster_page_prev:')) {
    const { teamName, pageIndex } = parseTeamPageContext(customId, 'profiles_roster_page_prev:');
    const members = await fetchTeamMembers(interaction.guild, teamName);
    const targetPage = pageIndex > 0 ? pageIndex - 1 : 0;
    return sendComponentUpdate(interaction, buildTeamRosterPayload(teamName, members, targetPage));
  }

  if (customId.startsWith('profiles_roster_page_next:')) {
    const { teamName, pageIndex } = parseTeamPageContext(customId, 'profiles_roster_page_next:');
    const members = await fetchTeamMembers(interaction.guild, teamName);
    return sendComponentUpdate(interaction, buildTeamRosterPayload(teamName, members, pageIndex + 1));
  }

  if (customId.startsWith('profiles_back_profile:')) {
    const { discordId, teamName } = parseProfileActionContext(customId, 'profiles_back_profile:');
    return showProfileCard(interaction, discordId, { teamName });
  }

  if (customId.startsWith('profiles_set_role:')) {
    const { discordId, teamName } = parseProfileActionContext(customId, 'profiles_set_role:');
    return showSetRoleView(interaction, discordId, teamName);
  }

  if (customId.startsWith('profiles_set_team:')) {
    const { discordId, teamName } = parseProfileActionContext(customId, 'profiles_set_team:');
    return showSetTeamView(interaction, discordId, teamName);
  }

  if (customId.startsWith('profiles_set_hotel:')) {
    const { discordId, teamName } = parseProfileActionContext(customId, 'profiles_set_hotel:');
    return showSetHotelModeView(interaction, discordId, teamName);
  }

  if (customId.startsWith('profiles_set_hotel_mode_single:')) {
    const { discordId, teamName } = parseProfileActionContext(customId, 'profiles_set_hotel_mode_single:');
    return showSingleHotelPickerView(interaction, discordId, teamName);
  }

  if (customId.startsWith('profiles_set_hotel_mode_multi:')) {
    const { discordId, teamName } = parseProfileActionContext(customId, 'profiles_set_hotel_mode_multi:');
    return showMultiHotelPickerView(interaction, discordId, teamName, []);
  }

  if (customId.startsWith('profiles_set_hotel_multi_add:')) {
    const { discordId, teamName, extra } = parseProfileActionContext(customId, 'profiles_set_hotel_multi_add:');
    return showMultiHotelPickerView(interaction, discordId, teamName, parseHotelSelection(extra));
  }

  if (customId.startsWith('profiles_set_hotel_multi_save:')) {
    const { discordId, teamName, extra } = parseProfileActionContext(customId, 'profiles_set_hotel_multi_save:');
    return applyMultiHotelUpdate(interaction, discordId, parseHotelSelection(extra), teamName);
  }

  if (customId.startsWith('profiles_view_hours:')) {
    const { discordId, teamName } = parseProfileActionContext(customId, 'profiles_view_hours:');
    return showHourHistoryView(interaction, discordId, teamName, 0);
  }

  if (customId.startsWith('profiles_view_hours_prev:')) {
    const { discordId, teamName, extra } = parseProfileActionContext(customId, 'profiles_view_hours_prev:');
    const monthOffset = Number.parseInt(extra, 10);
    return showHourHistoryView(interaction, discordId, teamName, Number.isFinite(monthOffset) ? monthOffset : -1);
  }

  if (customId.startsWith('profiles_view_cutoff:')) {
    const parts = customId.split(':');
    const teamName = normalizeTeamName(parts[1]) || TEAM_AGENTS;
    const cutoffKey = parts[2] === CUTOFF_SECOND_HALF ? CUTOFF_SECOND_HALF : CUTOFF_FIRST_HALF;
    return showCutoffHoursView(interaction, teamName, cutoffKey);
  }

  if (customId.startsWith('profiles_export_cutoff:')) {
    const parts = customId.split(':');
    const teamName = normalizeTeamName(parts[1]) || TEAM_AGENTS;
    const cutoffKey = parts[2] === CUTOFF_SECOND_HALF ? CUTOFF_SECOND_HALF : CUTOFF_FIRST_HALF;
    return exportCutoffHoursSpreadsheet(interaction, teamName, cutoffKey);
  }

  if (customId.startsWith('profiles_export_month:')) {
    const teamName = normalizeTeamName(customId.split(':')[1]) || TEAM_AGENTS;
    return exportMonthHoursSpreadsheet(interaction, teamName);
  }

  if (customId.startsWith('profiles_kick:')) {
    const discordId = customId.split(':')[1];
    return sendComponentUpdate(interaction, {
      embeds: [buildConfirmEmbed('kick', discordId)],
      components: [buildConfirmRow('kick', discordId)]
    });
  }

  if (customId.startsWith('profiles_ban:')) {
    const discordId = customId.split(':')[1];
    return sendComponentUpdate(interaction, {
      embeds: [buildConfirmEmbed('ban', discordId)],
      components: [buildConfirmRow('ban', discordId)]
    });
  }

  if (customId.startsWith('profiles_confirm:')) {
    const parts = customId.split(':');
    const action = parts[1];
    const discordId = parts[2];
    if (!['kick', 'ban'].includes(action)) {
      return sendComponentUpdate(interaction, { content: 'Invalid confirmation action.', embeds: [], components: [] });
    }
    return handleKickOrBanConfirm(interaction, action, discordId);
  }

  if (customId.startsWith('profiles_cancel:')) {
    const discordId = customId.split(':')[1];
    return showProfileCard(interaction, discordId, { notice: 'Action canceled.' });
  }

  if (customId.startsWith('profiles_reload_team:')) {
    const { teamName, pageIndex } = parseTeamPageContext(customId, 'profiles_reload_team:');
    const members = await fetchTeamMembers(interaction.guild, teamName);
    return sendComponentUpdate(interaction, buildTeamRosterPayload(teamName, members, pageIndex));
  }

  return null;
}

async function handleSelectMenu(interaction) {
  if (interaction.customId === 'profiles_team_pick' || interaction.customId === 'profiles_team_pick_local') {
    return handleTeamPick(interaction);
  }

  if (interaction.customId.startsWith('profiles_agent_pick:')) {
    return handleAgentPick(interaction);
  }

  if (!canUsePanel(interaction)) {
    return sendComponentUpdate(interaction, { content: 'Developer access required.', embeds: [], components: [] });
  }

  await safeDeferComponentUpdate(interaction);

  if (interaction.customId.startsWith('profiles_set_role_pick:')) {
    const { discordId, teamName } = parseProfileActionContext(interaction.customId, 'profiles_set_role_pick:');
    const roleValue = interaction.values?.[0];
    return applyRoleUpdate(interaction, discordId, roleValue, teamName);
  }

  if (interaction.customId.startsWith('profiles_set_team_pick:')) {
    const { discordId, teamName } = parseProfileActionContext(interaction.customId, 'profiles_set_team_pick:');
    const selectedTeam = interaction.values?.[0];
    return applyTeamUpdate(interaction, discordId, selectedTeam, teamName);
  }

  if (interaction.customId.startsWith('profiles_set_hotel_single_pick:')) {
    const { discordId, teamName } = parseProfileActionContext(interaction.customId, 'profiles_set_hotel_single_pick:');
    const hotelId = String(interaction.values?.[0] || '').trim().toUpperCase();
    return applySingleHotelUpdate(interaction, discordId, hotelId, teamName);
  }

  if (interaction.customId.startsWith('profiles_set_hotel_multi_pick:')) {
    const { discordId, teamName, extra } = parseProfileActionContext(interaction.customId, 'profiles_set_hotel_multi_pick:');
    const selected = parseHotelSelection(extra);
    const picked = String(interaction.values?.[0] || '').trim().toUpperCase();
    if (!HOTEL_IDS.includes(picked)) {
      return showMultiHotelPickerView(interaction, discordId, teamName, selected);
    }
    const nextSelection = parseHotelSelection(serializeHotelSelection([...selected, picked]));
    return showMultiHotelPickerView(interaction, discordId, teamName, nextSelection);
  }

  return null;
}

module.exports = {
  PROFILES_CHANNEL_ID,
  ensureProfilesDashboard,
  handleSetupProfiles,
  handleButton,
  handleSelectMenu
};
