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

const PROFILES_CHANNEL_ID = '1485256962617643098';
const PROFILE_PANEL_KEY_PREFIX = 'profiles_dashboard_msg_';
const TEAM_1 = 'Team 1';
const TEAM_2 = 'Team 2';
const TEAM_AGENTS = 'Agents';
const TEAM_SME = 'SME';
const TEAM_TEAM_LEADER = 'Team Leader';
const TEAM_TRAINEES = 'Trainees';
const TRAINEE_ROLE_ID = '1484705126026449029';
const AGENT_ROLE_ID = '1482227287159078964';
const SME_ROLE_ID = '1482382342621233153';
const OPERATIONS_MANAGER_ROLE_ID = '1482226842047090809';
const DEVELOPER_ROLE_ID = '1482312134875418737';
const VALID_TEAMS = [TEAM_1, TEAM_2, TEAM_AGENTS, TEAM_SME, TEAM_TEAM_LEADER, TEAM_TRAINEES];
const ROLE_STEPS = ['agent', 'sme', 'team_leader', 'operations_manager'];
const ROLE_LABELS = {
  trainee: 'Trainee',
  agent: 'Agent',
  sme: 'Subject Matter Expert (SME)',
  team_leader: 'Team Leader',
  operations_manager: 'Operations Manager'
};
const TEAM_ROLE_LOOKUPS = {
  [TEAM_1]: { names: ['team 1', 'team one'] },
  [TEAM_2]: { names: ['team 2', 'team two'] }
};
const SME_ROLE_NAMES = ['subject matter expert', 'sme'];
const TEAM_LEADER_ROLE_NAMES = ['team leader'];
const OPERATIONS_MANAGER_ROLE_NAMES = ['operations manager'];
const DEVELOPER_ROLE_NAMES = ['developer', 'developers'];
const TEAM_ASSIGNMENT_ROLE_NAMES = ['team 1', 'team one', 'team 2', 'team two'];

function normalizeTeamName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'team 1' || raw === 'team1' || raw === '1') return TEAM_1;
  if (raw === 'team 2' || raw === 'team2' || raw === '2') return TEAM_2;
  if (raw === 'agents' || raw === 'agent') return TEAM_AGENTS;
  if (raw === 'sme' || raw === 'subject matter expert') return TEAM_SME;
  if (raw === 'team leader' || raw === 'teamlead' || raw === 'tl') return TEAM_TEAM_LEADER;
  if (raw === 'trainees' || raw === 'trainee') return TEAM_TRAINEES;
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

function roleLabel(role) {
  const normalized = String(role || '').toLowerCase();
  return ROLE_LABELS[normalized] || 'Agent';
}

function statusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'standby') return 'Standby';
  if (normalized === 'ready') return 'Ready';
  return 'Ready';
}

function dateTag(value) {
  if (!value) return 'Not recorded';
  const timestamp = Math.floor(new Date(value).getTime() / 1000);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Not recorded';
  return `<t:${timestamp}:F>`;
}

function getProfilePanelKey(channelId) {
  return `${PROFILE_PANEL_KEY_PREFIX}${channelId}`;
}

function buildTeamPickerRow(customId = 'profiles_team_pick', selectedTeam = null) {
  const normalizedSelected = normalizeTeamName(selectedTeam);
  const team1Description = normalizedSelected === TEAM_1
    ? 'Browse Team 1 members (current)'
    : 'Browse Team 1 members';
  const team2Description = normalizedSelected === TEAM_2
    ? 'Browse Team 2 members (current)'
    : 'Browse Team 2 members';
  const agentsDescription = normalizedSelected === TEAM_AGENTS
    ? 'Browse agents only (current)'
    : 'Browse agents only';
  const smeDescription = normalizedSelected === TEAM_SME
    ? 'Browse SME only (current)'
    : 'Browse SME only';
  const teamLeaderDescription = normalizedSelected === TEAM_TEAM_LEADER
    ? 'Browse Team Leader only (current)'
    : 'Browse Team Leader only';
  const traineesDescription = normalizedSelected === TEAM_TRAINEES
    ? 'Browse trainees only (current)'
    : 'Browse trainees only';

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Select team')
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
        .setValue(TEAM_TRAINEES)
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildTeamRefreshRow(teamName) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_reload_team:${teamName}`)
      .setLabel(`Refresh ${teamName}`)
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
      'This portal is built for fast team browsing, profile review, and developer actions.\n\n' +
      '──────────────────────────────\n' +
      '📋 **Protocol**\n' +
      '1. Select a team below\n' +
      '2. Pick an agent profile\n' +
      '3. Run an approved action\n' +
      '4. Refresh team data if needed\n\n' +
      '──────────────────────────────\n' +
      `🏨 **Current Team:** ${selected || 'Not selected'}\n` +
      `👤 **Agents View:** Available in the team picker\n` +
      `🎯 **SME View:** Available in the team picker\n` +
      `🧭 **Team Leader View:** Available in the team picker\n` +
      `🎓 **Trainees View:** Available in the team picker`
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations - Automated Access Control' })
    .setTimestamp();
}

function formatMemberLine(member, index) {
  const name = trimToTwoWords(member.display_name || member.username);
  const role = roleLabel(member.role);
  const status = statusLabel(member.agent_status);
  return `**${index + 1}. ${name}** - ${role} - ${status}`;
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
      `### Team Roster\n${rosterText}\n\n` +
      'Open a profile below.'
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
    .setPlaceholder('Select member profile')
    .setOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function buildTeamRosterPayload(teamName, members) {
  const components = [buildTeamPickerRow('profiles_team_pick_local', teamName), buildTeamRefreshRow(teamName)];
  if (members.length > 0) {
    components.splice(1, 0, buildMemberPickerRow(teamName, members));
  }

  return {
    embeds: [buildTeamRosterEmbed(teamName, members)],
    components
  };
}

function nextRole(currentRole) {
  const normalized = String(currentRole || '').toLowerCase();
  const index = ROLE_STEPS.indexOf(normalized);
  if (index < 0) return 'sme';
  if (index >= ROLE_STEPS.length - 1) return normalized;
  return ROLE_STEPS[index + 1];
}

function previousRole(currentRole) {
  const normalized = String(currentRole || '').toLowerCase();
  const index = ROLE_STEPS.indexOf(normalized);
  if (index <= 0) return 'agent';
  return ROLE_STEPS[index - 1];
}

async function syncLeadershipDiscordRoles(member, role) {
  if (!member) return;

  const removeNames = ['team leader', 'subject matter expert', 'sme', 'operations manager'];
  const removeRoles = member.guild.roles.cache.filter(guildRole => removeNames.includes(guildRole.name.toLowerCase()));
  if (removeRoles.size > 0) {
    await member.roles.remove(removeRoles).catch(() => {});
  }

  const roleTargets = {
    sme: ['subject matter expert', 'sme'],
    team_leader: ['team leader'],
    operations_manager: ['operations manager']
  };
  const names = roleTargets[role] || [];

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
    const rows = await fetchStrictRoleMembers(guild, {
      includeRoleId: AGENT_ROLE_ID,
      includeRoleNames: ['agents', 'agent'],
      excludeRoleIds: [TRAINEE_ROLE_ID, SME_ROLE_ID, OPERATIONS_MANAGER_ROLE_ID, DEVELOPER_ROLE_ID],
      excludeRoleNames: [...SME_ROLE_NAMES, ...TEAM_LEADER_ROLE_NAMES, ...OPERATIONS_MANAGER_ROLE_NAMES, ...DEVELOPER_ROLE_NAMES],
      forcedRole: 'agent',
      enforceNoTeamAssignment: true
    });
    return rows.filter(row => !normalizeTeamName(row.team));
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

  return {
    agent,
    member,
    displayName,
    shortName,
    email,
    phone,
    appliedAt,
    pair,
    activeSession
  };
}

function buildProfileEmbed(profile, reviewerTag, notice = null) {
  const { agent, member, shortName, email, phone, appliedAt, pair, activeSession } = profile;
  const pairText = pair
    ? `${hotelName(pair.primary_hotel_id)} + ${hotelName(pair.secondary_hotel_id)}`
    : 'Not set';
  const activeText = activeSession
    ? `${hotelName(activeSession.hotel_id)} since ${dateTag(activeSession.login_time)}`
    : 'Not on an active shift';

  const embed = new EmbedBuilder()
    .setTitle('✅ Active Agent · Verified')
    .setDescription(
      `## 👤 ${shortName}\n` +
      '──────────────────────────────\n' +
      `> 🧑 Discord: <@${agent.discord_id}> (\`${agent.discord_id}\`)\n` +
      `> 📧 Email: ${email}\n` +
      `> 📱 Phone (PH): ${phone}\n` +
      `> ⏰ Applied At: ${dateTag(appliedAt)}\n` +
      `> 🧩 Role: ${roleLabel(agent.role)}\n` +
      `> 🏨 Team: ${agent.team || profile.agent.effective_team || TEAM_1}\n` +
      `> 🏢 Primary Hotel: ${hotelName(agent.hotel_id)}\n` +
      `> 🔗 Hotel Pair: ${pairText}\n` +
      `> 🟢 Live Session: ${activeText}\n` +
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

function buildMoreActionsRow(targetDiscordId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`profiles_more:${targetDiscordId}`)
    .setPlaceholder('More actions')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Refresh Profile').setDescription('Reload the profile card').setValue('refresh'),
      new StringSelectMenuOptionBuilder().setLabel('Kick Agent').setDescription('Open kick confirmation').setValue('kick'),
      new StringSelectMenuOptionBuilder().setLabel('Ban Agent').setDescription('Open ban confirmation').setValue('ban'),
      new StringSelectMenuOptionBuilder().setLabel('Assign Team 1').setDescription('Move the agent to Team 1').setValue('assign_team_1'),
      new StringSelectMenuOptionBuilder().setLabel('Assign Team 2').setDescription('Move the agent to Team 2').setValue('assign_team_2'),
      new StringSelectMenuOptionBuilder().setLabel('Clear Team Assignment').setDescription('Remove explicit team assignment').setValue('clear_team'),
      new StringSelectMenuOptionBuilder().setLabel('Clear Primary Hotel').setDescription('Unset the linked hotel').setValue('clear_hotel'),
      new StringSelectMenuOptionBuilder().setLabel('Unlink Paired Hotels').setDescription('Remove paired hotel assignment').setValue('clear_pair'),
      new StringSelectMenuOptionBuilder().setLabel('End Active Sessions').setDescription('Close open sessions for this agent').setValue('end_sessions'),
      new StringSelectMenuOptionBuilder().setLabel('Remove Agent Record').setDescription('Delete database records only').setValue('remove_agent_record')
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildActionButtonRow(targetDiscordId, currentRole, teamName) {
  const normalizedRole = String(currentRole || '').toLowerCase();
  const index = ROLE_STEPS.indexOf(normalizedRole);
  const promoteDisabled = index >= ROLE_STEPS.length - 1;
  const demoteDisabled = index <= 0;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profiles_promote:${targetDiscordId}`)
      .setLabel('Promote')
      .setStyle(ButtonStyle.Success)
      .setDisabled(promoteDisabled),
    new ButtonBuilder()
      .setCustomId(`profiles_demote:${targetDiscordId}`)
      .setLabel('Demote')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(demoteDisabled),
    new ButtonBuilder()
      .setCustomId(`profiles_back_team:${teamName}`)
      .setLabel('Back to Team')
      .setStyle(ButtonStyle.Primary)
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
    buildActionButtonRow(profile.agent.discord_id, profile.agent.role, teamName),
    buildMoreActionsRow(profile.agent.discord_id)
  ];
}

async function showProfileCard(interaction, discordId, options = {}) {
  const profile = await getProfileContext(interaction.guild, discordId);
  if (!profile) {
    return sendComponentUpdate(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Profile Not Found')
          .setDescription('That user is not registered as an agent.')
          .setColor(0xED4245)
      ],
      components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_1)]
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
      return sendComponentUpdate(interaction, { content: 'Invalid team selection.', embeds: [], components: [] });
    }
    return sendComponentReply(interaction, { content: 'Invalid team selection.', ephemeral: true });
  }

  const members = await fetchTeamMembers(interaction.guild, teamName);
  const payload = buildTeamRosterPayload(teamName, members);

  if (interaction.customId === 'profiles_team_pick') {
    await sendComponentUpdate(interaction, {
      embeds: [buildDashboardEmbed(teamName)],
      components: [buildTeamPickerRow('profiles_team_pick', teamName)]
    });
    return sendComponentReply(interaction, { ...payload, ephemeral: true });
  }

  return sendComponentUpdate(interaction, payload);
}

async function handleBackToTeam(interaction, discordId) {
  const teamName = normalizeTeamName(interaction.customId.split(':')[1]) || TEAM_1;
  const members = await fetchTeamMembers(interaction.guild, teamName);
  return sendComponentUpdate(interaction, buildTeamRosterPayload(teamName, members));
}

async function handleAgentPick(interaction) {
  if (!canUsePanel(interaction)) {
    return sendComponentUpdate(interaction, { content: 'Developer access required.', embeds: [], components: [] });
  }

  await safeDeferComponentUpdate(interaction);

  const teamNameRaw = interaction.customId.split(':')[1];
  const teamName = normalizeTeamName(teamNameRaw) || TEAM_1;
  const discordId = interaction.values?.[0];

  return showProfileCard(interaction, discordId, { teamName });
}

async function handlePromote(interaction, discordId) {
  const current = db.prepare('SELECT role, team FROM agents WHERE discord_id = ?').get(discordId);
  if (!current) {
    return sendComponentUpdate(interaction, { content: 'Agent not found in database.', embeds: [], components: [] });
  }

  const newRole = nextRole(current.role);
  db.prepare('UPDATE agents SET role = ? WHERE discord_id = ?').run(newRole, discordId);

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  await syncLeadershipDiscordRoles(member, newRole);

  return showProfileCard(interaction, discordId, {
    teamName: current.team,
    notice: `Role updated to ${roleLabel(newRole)}.`
  });
}

async function handleDemote(interaction, discordId) {
  const current = db.prepare('SELECT role, team FROM agents WHERE discord_id = ?').get(discordId);
  if (!current) {
    return sendComponentUpdate(interaction, { content: 'Agent not found in database.', embeds: [], components: [] });
  }

  const newRole = previousRole(current.role);
  db.prepare('UPDATE agents SET role = ? WHERE discord_id = ?').run(newRole, discordId);

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  await syncLeadershipDiscordRoles(member, newRole);

  return showProfileCard(interaction, discordId, {
    teamName: current.team,
    notice: `Role updated to ${roleLabel(newRole)}.`
  });
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
      components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_1)]
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
    components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_1)]
  });
}

function removeAgentFromDb(discordId) {
  const agent = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get(discordId);
  db.transaction(() => {
    if (agent) {
      db.prepare('DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)').run(agent.id);
      db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(agent.id);
      db.prepare('DELETE FROM maintenance_logs WHERE agent_id = ?').run(agent.id);
      db.prepare('DELETE FROM handover_notes WHERE agent_id = ?').run(agent.id);
      db.prepare('DELETE FROM schedules WHERE agent_id = ?').run(agent.id);
      db.prepare('DELETE FROM hotel_shift_assignments WHERE agent_id = ?').run(agent.id);
    }
    db.prepare('DELETE FROM agents WHERE discord_id = ?').run(discordId);
    db.prepare('DELETE FROM pending_registrations WHERE discord_id = ?').run(discordId);
    db.prepare('DELETE FROM developers WHERE discord_id = ?').run(discordId);
    db.prepare('DELETE FROM dev_approvals WHERE target_id = ? OR proposed_by = ?').run(discordId, discordId);
  })();
}

async function handleMisc(interaction, discordId) {
  await safeDeferComponentUpdate(interaction);

  const action = interaction.values?.[0];
  const agent = db.prepare('SELECT id, team FROM agents WHERE discord_id = ?').get(discordId);
  if (!agent) {
    return sendComponentUpdate(interaction, { content: 'Agent not found in database.', embeds: [], components: [] });
  }

  if (action === 'refresh') {
    return showProfileCard(interaction, discordId, { teamName: agent.team, notice: 'Profile refreshed.' });
  }

  if (action === 'assign_team_1') {
    db.prepare('UPDATE agents SET team = ? WHERE discord_id = ?').run(TEAM_1, discordId);
    return showProfileCard(interaction, discordId, { teamName: TEAM_1, notice: 'Assigned to Team 1.' });
  }

  if (action === 'assign_team_2') {
    db.prepare('UPDATE agents SET team = ? WHERE discord_id = ?').run(TEAM_2, discordId);
    return showProfileCard(interaction, discordId, { teamName: TEAM_2, notice: 'Assigned to Team 2.' });
  }

  if (action === 'clear_team') {
    db.prepare('UPDATE agents SET team = NULL WHERE discord_id = ?').run(discordId);
    return showProfileCard(interaction, discordId, { teamName: TEAM_1, notice: 'Explicit team assignment cleared.' });
  }

  if (action === 'clear_hotel') {
    db.prepare('UPDATE agents SET hotel_id = NULL WHERE discord_id = ?').run(discordId);
    return showProfileCard(interaction, discordId, { teamName: agent.team, notice: 'Primary hotel link removed.' });
  }

  if (action === 'clear_pair') {
    db.prepare('DELETE FROM hotel_shift_assignments WHERE agent_id = ?').run(agent.id);
    return showProfileCard(interaction, discordId, { teamName: agent.team, notice: 'Paired hotel assignment removed.' });
  }

  if (action === 'end_sessions') {
    db.prepare("UPDATE sessions SET status = 'closed', logout_time = CURRENT_TIMESTAMP WHERE agent_id = ? AND status = 'active'").run(agent.id);
    return showProfileCard(interaction, discordId, { teamName: agent.team, notice: 'All active sessions have been closed.' });
  }

  if (action === 'remove_agent_record') {
    removeAgentFromDb(discordId);
    return sendComponentUpdate(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Agent Record Removed')
          .setDescription(`<@${discordId}> was removed from database records.`)
          .setColor(0xF1C40F)
          .setTimestamp()
      ],
      components: [buildTeamPickerRow('profiles_team_pick_local', TEAM_1)]
    });
  }

  return showProfileCard(interaction, discordId, { teamName: agent.team, notice: 'No action executed.' });
}

async function handleButton(interaction) {
  if (!canUsePanel(interaction)) {
    return interaction.reply({ content: 'Developer access required.', ephemeral: true });
  }

  await safeDeferComponentUpdate(interaction);

  const customId = interaction.customId || '';
  if (customId.startsWith('profiles_promote:')) {
    const discordId = customId.split(':')[1];
    return handlePromote(interaction, discordId);
  }

  if (customId.startsWith('profiles_demote:')) {
    const discordId = customId.split(':')[1];
    return handleDemote(interaction, discordId);
  }

  if (customId.startsWith('profiles_back_team:')) {
    const teamName = normalizeTeamName(customId.split(':')[1]) || TEAM_1;
    const members = await fetchTeamMembers(interaction.guild, teamName);
    return sendComponentUpdate(interaction, buildTeamRosterPayload(teamName, members));
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
    const teamRaw = customId.split(':')[1];
    const teamName = normalizeTeamName(teamRaw) || TEAM_1;
    const members = await fetchTeamMembers(interaction.guild, teamName);
    return sendComponentUpdate(interaction, buildTeamRosterPayload(teamName, members));
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

  if (interaction.customId.startsWith('profiles_more:')) {
    if (!canUsePanel(interaction)) {
      return sendComponentUpdate(interaction, { content: 'Developer access required.', embeds: [], components: [] });
    }
    const discordId = interaction.customId.split(':')[1];
    const action = interaction.values?.[0];
    if (action === 'kick') {
      return sendComponentUpdate(interaction, {
        embeds: [buildConfirmEmbed('kick', discordId)],
        components: [buildConfirmRow('kick', discordId)]
      });
    }
    if (action === 'ban') {
      return sendComponentUpdate(interaction, {
        embeds: [buildConfirmEmbed('ban', discordId)],
        components: [buildConfirmRow('ban', discordId)]
      });
    }
    return handleMisc(interaction, discordId);
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
