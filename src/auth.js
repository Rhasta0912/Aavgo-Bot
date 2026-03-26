const { 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ActionRowBuilder, 
  EmbedBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  MessageFlags,
  StringSelectMenuBuilder, 
  StringSelectMenuOptionBuilder 
} = require('discord.js');
const db = require('./database');
const { execSync } = require('child_process');

// ─── Identity Helpers ────────────────────────────────
async function getAgentDisplayName(guild, discordId) {
  try {
    if (!guild) return 'Unknown Agent';
    const member = await guild.members.fetch(discordId).catch(() => null);
    return member ? member.displayName : 'Unknown Agent';
  } catch (e) {
    return 'Unknown Agent';
  }
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

// ─── Constants ───────────────────────────────────────
const ROLE_NAMES = {
  ON_SHIFT: 'On-Shift',
  LOGGED_OUT: 'Logged Out',
  AGENTS: 'Agents',
  TEAM_1: 'Team 1',
  // Green (On-Shift / Permission) Roles
  GREEN: {
    'BW_TO': '1482227783232000070',
    'GICP': '1484531060699168778',
    'SUP8': '1482227848440971408',
    'RMDA': '1483418491464843345',
    'AD1': '1483418531180843049'
  },
  // Grey (Permanent / Assignment) Roles
  GREY: {
    'BW_TO': '1483429969807020032',
    'GICP': '1484531611549831189',
    'SUP8': '1483430096013623427',
    'RMDA': '1483430118016684135',
    'AD1': '1483430144449187923'
  }
};

// Map hotel IDs to display names
const HOTEL_NAMES = {
  'BW_TO': 'Indianhead/Magnuson',
  'GICP': 'The Garden Inn At Campsite',
  'SUP8': 'Super 8',
  'RMDA': 'Ramada',
  'AD1': 'AD1'
};
// Map hotel IDs to log-in channel IDs
const HOTEL_LOGIN_CHANNELS = {
  'BW_TO': '1482303551614095441',
  'GICP': '1484531330308903005',
  'SUP8': '1483417977859870881',
  'RMDA': '1483417977859870881',
  'AD1': '1483418055538376735'
};

const APPROVAL_CHANNEL_ID = '1482240202503098398';
const AUDIT_LOG_CHANNEL_ID = '1482239767134339182';
const SHIFT_ACTIVITY_LOG_CHANNEL_ID = '1484192529485140099';
const TEAM_1_LOG_CHANNEL_ID = '1482383356753612991';
const TL_PORTAL_CHANNEL_ID = '1484878480046031099';
const TL_STATUS_CHANNEL_ID = '1486347360417349682';
const TRAINING_STATUS_CHANNEL_ID = '1486623221225750660';
const NEWCOMER_CHANNEL_ID = '1482259779991764992';

const TEAM_1_HOTELS = ['BW_TO', 'GICP', 'SUP8', 'RMDA', 'AD1'];
const TEAM_NAMES = ['Team 1', 'Team 2'];
const TRAINING_HOTEL_GROUPS = [
  { label: 'Indianhead/Magnuson', hotelIds: ['BW_TO'] },
  { label: 'Ramada / Super 8', hotelIds: ['RMDA', 'SUP8'] },
  { label: 'The Garden Inn At Campsite', hotelIds: ['GICP'] },
  { label: 'AD1', hotelIds: ['AD1'] }
];
const AGENT_STATUS_LABELS = {
  standby: 'Standby Agent',
  ready: 'Ready for Live Shifts'
};
const ROLE_LABELS = {
  agent: 'Agent',
  sme: 'Subject Matter Expert (SME)',
  team_leader: 'Team Leader',
  operations_manager: 'Operations Manager'
};
const ROLE_HIERARCHY = {
  agent: 1,
  sme: 2,
  team_leader: 3,
  operations_manager: 5
};

function buildAuditFields(resolvedDescription) {
  const lines = String(resolvedDescription || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const fields = [];
  const summaryLines = [];

  for (const line of lines) {
    const match = line.match(/^\*\*(.+?):\*\*\s*(.+)$/);
    if (match) {
      fields.push({
        name: match[1],
        value: match[2],
        inline: true
      });
    } else {
      summaryLines.push(line.replace(/^>\s*/, ''));
    }
  }

  return {
    summary: summaryLines.join('\n').trim() || 'Operational event recorded.',
    fields: fields.slice(0, 6)
  };
}

// ─── Audit Logger ────────────────────────────────────
async function sendAuditLog(client, { title, description, color, hotelId, userId, forceManagerLog, guild }) {
  try {
    let targetChannelId = AUDIT_LOG_CHANNEL_ID;

    // Resolve Nickname if userId is provided
    let agentName = 'Aavgo System';
    if (userId && guild) {
      agentName = await getAgentDisplayName(guild, userId);
    }

    // Categorized Logging
    if (hotelId === 'TEAM_SHIFT') {
      targetChannelId = TL_PORTAL_CHANNEL_ID;
    } else if (forceManagerLog) {
      targetChannelId = AUDIT_LOG_CHANNEL_ID; // Ensure manager audit
    } else if (hotelId && TEAM_1_HOTELS.includes(hotelId)) {
      targetChannelId = TEAM_1_LOG_CHANNEL_ID;
    } else if (userId) {
      // Check if user is on an active Team 1 shift
      const agentSession = db.prepare(`
        SELECT hotel_id FROM sessions 
        WHERE agent_id = (SELECT id FROM agents WHERE discord_id = ?) 
        AND status = 'active'
      `).get(userId);
      if (agentSession && TEAM_1_HOTELS.includes(agentSession.hotel_id)) {
        targetChannelId = TEAM_1_LOG_CHANNEL_ID;
      }
    }

    const channel = await client.channels.fetch(targetChannelId);
    if (!channel) return console.warn('[AUDIT] Log channel not found.');

    const resolvedDescription = description.replace('{{AGENT_NAME}}', agentName);
    const { summary, fields } = buildAuditFields(resolvedDescription);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(summary)
      .setColor(color)
      .setFooter({ text: `🛡️ Aavgo Audit System • ${agentName}` })
      .setTimestamp();

    if (fields.length > 0) embed.addFields(fields);

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn('[AUDIT] Failed to send audit log:', err.message);
  }
}

async function sendShiftActivityLogLegacy(client, { title, color, description, fields = [] }) {
  try {
    const channel = await client.channels.fetch(SHIFT_ACTIVITY_LOG_CHANNEL_ID);
    if (!channel) return console.warn('[SHIFT-ACTIVITY] Log channel not found.');

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setFooter({ text: 'Aavgo Operations • Shift Activity' })
      .setTimestamp();

    if (fields.length > 0) embed.addFields(fields.slice(0, 10));

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn('[SHIFT-ACTIVITY] Failed to send activity log:', err.message);
  }
}

function formatActivityLabel(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

// Override with richer activity-card layout for cleaner ops logs.
async function sendShiftActivityLog(client, { title, color, description, fields = [], activityType = '', agentName = '', hotelName = '', guestName = '' }) {
  try {
    const channel = await client.channels.fetch(SHIFT_ACTIVITY_LOG_CHANNEL_ID);
    if (!channel) return console.warn('[SHIFT-ACTIVITY] Log channel not found.');

    const typeMap = {
      checkin: { emoji: '🛎️', label: 'Guest Check-In' },
      checkout: { emoji: '🗝️', label: 'Guest Check-Out' },
      call: { emoji: '📞', label: 'Call Activity' },
      maintenance: { emoji: '🛠️', label: 'Maintenance' },
      handover: { emoji: '📝', label: 'Handover' }
    };
    const typeInfo = typeMap[activityType] || { emoji: '📌', label: 'Shift Activity' };

    const summaryFields = [
      { name: '👤 Agent', value: agentName || 'Unknown', inline: true },
      { name: '🏨 Hotel', value: hotelName || 'Unknown', inline: true }
    ];
    if (guestName) {
      summaryFields.push({ name: '🧾 Guest / Ref', value: guestName, inline: true });
    }

    const detailFields = fields
      .filter(field => String(field?.value || '').trim().length > 0)
      .map(field => ({
        name: `• ${formatActivityLabel(field.name)}`.slice(0, 256),
        value: String(field.value).slice(0, 1024),
        inline: false
      }))
      .slice(0, 7);

    const embed = new EmbedBuilder()
      .setTitle(`${typeInfo.emoji} ${title}`)
      .setDescription(`### ${typeInfo.label} Logged\n${description || 'Operational event recorded.'}`)
      .setColor(color || 0xF1C40F)
      .setFooter({ text: 'Aavgo Operations • Shift Activity Feed' })
      .setTimestamp();

    embed.addFields(summaryFields);
    if (detailFields.length > 0) {
      embed.addFields({ name: '📋 Details', value: '━━━━━━━━━━━━━━━━━━', inline: false });
      embed.addFields(detailFields);
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn('[SHIFT-ACTIVITY] Failed to send activity log:', err.message);
  }
}

// ─── Centralized Session Maintenance ────────────────
async function broadcastUpdateLog(client) {
  const UPDATE_LOG_CHANNEL_ID = '1485584578927132863';
  try {
    const channel = await client.channels.fetch(UPDATE_LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const currentCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    if (!currentCommit) return;

    const lastPosted = db.prepare("SELECT value FROM config WHERE key = ?").get('update_log_last_commit')?.value || null;
    if (lastPosted === currentCommit) return;

    let commitLines = [];
    try {
      if (lastPosted) {
        const raw = execSync(`git log --pretty=format:%h|%s ${lastPosted}..HEAD`, { encoding: 'utf8' }).trim();
        commitLines = raw ? raw.split('\n').filter(Boolean) : [];
      } else {
        const raw = execSync('git log -1 --pretty=format:%h|%s', { encoding: 'utf8' }).trim();
        commitLines = raw ? [raw] : [];
      }
    } catch (rangeErr) {
      console.warn('[UPDATE-LOG] Commit range lookup failed:', rangeErr.message);
      const fallback = execSync('git log -1 --pretty=format:%h|%s', { encoding: 'utf8' }).trim();
      commitLines = fallback ? [fallback] : [];
    }

    const lines = commitLines.slice(0, 10).map(line => {
      const [hash, ...subjectParts] = line.split('|');
      const subject = subjectParts.join('|').trim() || 'Updated bot behavior';
      return `- \`${hash}\` ${subject}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('📢 Aavgo Bot Update Log')
      .setDescription(
        'A new deployment is now live.\n\n' +
        (lines.length ? lines.join('\n') : '- Latest deployment applied.')
      )
      .addFields({ name: 'Current Commit', value: `\`${currentCommit}\``, inline: true })
      .setColor(0xF1C40F)
      .setFooter({ text: 'Aavgo Operations • Update Logs' })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('update_log_last_commit', currentCommit);
  } catch (error) {
    console.warn('[UPDATE-LOG] Failed to broadcast deployment update:', error.message);
  }
}

async function closeAllActiveSessionsForAgent(agentId, client) {
  const nowIso = new Date().toISOString();
  
  // 1. Fetch active sessions to know what to refresh later
  const activeSessions = db.prepare("SELECT hotel_id, session_kind FROM sessions WHERE agent_id = ? AND status = 'active'").all(agentId);
  if (activeSessions.length === 0) return [];

  const hotelIds = [...new Set(activeSessions.map(s => s.hotel_id))];
  const hasTrainingSessions = activeSessions.some(s => s.session_kind === 'training');
  const hasTeamShift = activeSessions.some(s => s.hotel_id === 'TEAM_SHIFT');

  // 2. Close in DB
  const result = db.prepare("UPDATE sessions SET status = 'closed', logout_time = ? WHERE agent_id = ? AND status = 'active'").run(nowIso, agentId);
  console.log(`[AUTH-MAINT] Closed ${result.changes} session(s) for agent ${agentId}`);

  // 3. Trigger refreshes
  for (const hId of hotelIds) {
    try {
      if (hId === 'TEAM_SHIFT') {
        const agent = db.prepare("SELECT team FROM agents WHERE id = ?").get(agentId);
        if (agent && agent.team) {
          await updateTeamStatusEmbed(client, agent.team);
          // When a TL logs out, all their team's hotels must refresh to clear "TL on Shift"
          const teamHotels = agent.team === 'Team 1' ? TEAM_1_HOTELS : [];
          for (const teamHotelId of teamHotels) {
            await updateHotelStatusEmbed(client, teamHotelId).catch(e => {});
          }
        }
      } else {
        await updateHotelStatusEmbed(client, hId);
      }
    } catch (e) {
      console.warn(`[AUTH-MAINT] Refresh failed for ${hId}:`, e.message);
    }
  }

  if (hasTrainingSessions) {
    try {
      await updateTrainingStatusEmbed(client);
    } catch (e) {
      console.warn('[AUTH-MAINT] Training status refresh failed:', e.message);
    }
  }

  if (hasTeamShift) {
    try {
      const agent = db.prepare("SELECT team FROM agents WHERE id = ?").get(agentId);
      if (agent && agent.team) {
        await updateTeamStatusEmbed(client, agent.team);
      }
    } catch (e) {
      console.warn('[AUTH-MAINT] Team status refresh failed:', e.message);
    }
  }

  return hotelIds;
}

async function closeOtherActiveHotelSessions(interaction, hotelId, currentAgentId) {
  const priorSessions = db.prepare(
    "SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND agent_id != ? ORDER BY id DESC"
  ).all(hotelId, currentAgentId);

  for (const priorSession of priorSessions) {
    const priorAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(priorSession.agent_id);
    db.prepare("UPDATE sessions SET logout_time = CURRENT_TIMESTAMP, status = 'closed' WHERE id = ?").run(priorSession.id);

    if (!priorAgent) continue;

    try {
      const oldMember = await interaction.guild.members.fetch(priorAgent.discord_id);
      if (!oldMember) continue;

      const onShiftRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
      const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
      const greenRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREEN[hotelId]);
      const greyRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREY[hotelId]);

      if (onShiftRole && loggedOutRole && greenRole) {
        const rolesToRemove = [onShiftRole, greenRole];
        const rolesToAdd = [loggedOutRole];
        if (greyRole) rolesToAdd.push(greyRole);

        await oldMember.roles.remove(rolesToRemove);
        await oldMember.roles.add(rolesToAdd);
      }
    } catch (e) {
      console.warn('Could not revert roles for prior agent:', e.message);
    }
  }

  return priorSessions.length;
}

// ─── PIN Verification Modal ─────────────────────────
async function showPinModal(interaction, hotelId, isTakeover = false, allowMultiHotel = false, sessionMode = 'shift') {
  const hotelName = HOTEL_NAMES[hotelId] || (hotelId === 'TEAM_SHIFT' ? 'Management Shift' : hotelId);
  const modal = new ModalBuilder()
    .setCustomId(`loginmodal_${sessionMode}_${hotelId}${isTakeover ? '_takeover' : ''}${allowMultiHotel ? '_multi' : ''}`)
    .setTitle(`🔑 Verify PIN — ${hotelName}`.substring(0, 45));

  const pinInput = new TextInputBuilder()
    .setCustomId('pin_input')
    .setLabel('Enter your secure PIN')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(6);

  const row = new ActionRowBuilder().addComponents(pinInput);
  modal.addComponents(row);

  if ((typeof interaction.isButton === 'function' && interaction.isButton()) ||
      (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu())) {
    await interaction.showModal(modal);
  } else {
    // If interaction is not show-modal compatible (like a slash command already deferred)
    // In our case, handleStartShiftClick defers reply first, so we might need special handling.
    // Wait, modals CANNOT be shown after a reply is deferred.
    console.error('[AUTH] Cannot show modal: Interaction already deferred or replied.');
  }
}

function normalizeTeamInput(input) {
  const cleaned = (input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (cleaned === 'team 1' || cleaned === '1' || cleaned === 'team1') return 'Team 1';
  if (cleaned === 'team 2' || cleaned === '2' || cleaned === 'team2') return 'Team 2';
  return null;
}

function getOtherTeamName(teamName) {
  return teamName === 'Team 1' ? 'Team 2' : teamName === 'Team 2' ? 'Team 1' : null;
}

function normalizeHotelInput(input) {
  const cleaned = (input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const aliases = {
    BWTO: 'BW_TO',
    THOUSANDOAKS: 'BW_TO',
    BWPLUSTHOUSANDOAKSCA: 'BW_TO',
    INDIANHEAD: 'BW_TO',
    INDIANHEADIRONWOOD: 'BW_TO',
    BRNT: 'BRNT',
    BRENTWOOD: 'BRNT',
    BRENTWOODINNSUITES: 'BRNT',
    MAGNUSON: 'BRNT',
    GICP: 'GICP',
    GARDENINN: 'GICP',
    GARDENINNCAMPSITE: 'GICP',
    THEGARDENINNATCAMPSITE: 'GICP',
    SUP8: 'SUP8',
    SUPER8: 'SUP8',
    RMDA: 'RMDA',
    RAMADA: 'RMDA',
    AD1: 'AD1',
    CALLSONLY: 'AD1'
  };

  return aliases[cleaned] || null;
}

function getAgentShiftAccessState(agent) {
  return 'ready';
}

function normalizeAgentRole(role) {
  const cleaned = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  if (!cleaned) return 'agent';
  if (cleaned === 'subject_matter_expert' || cleaned === 'subjectmatterexpert') return 'sme';
  if (cleaned === 'teamleader') return 'team_leader';
  if (cleaned === 'operation_manager' || cleaned === 'operationsmanager') return 'operations_manager';
  return cleaned;
}

function getRoleLabel(role) {
  return ROLE_LABELS[normalizeAgentRole(role)] || 'Agent';
}

function getRoleRank(role) {
  return ROLE_HIERARCHY[normalizeAgentRole(role)] || 0;
}

function hasAgentRoleAtLeast(role, minimumRole) {
  return getRoleRank(role) >= getRoleRank(minimumRole);
}

function getAgentRoleByDiscordId(discordId) {
  const agent = db.prepare("SELECT role FROM agents WHERE discord_id = ?").get(discordId);
  return normalizeAgentRole(agent?.role);
}

async function removeTraineeRoleFromMember(member, guild, contextLabel = 'ROLE SYNC') {
  try {
    if (!member || !guild) return;
    const traineeRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'trainees');
    if (traineeRole && member.roles.cache.has(traineeRole.id)) {
      await member.roles.remove(traineeRole);
      console.log(`[${contextLabel}] Removed Trainees role from ${member.user.username}`);
    }
  } catch (error) {
    console.warn(`[${contextLabel}] Could not remove Trainees role:`, error.message);
  }
}

async function removeApplicantsRoleFromMember(member, guild, contextLabel = 'ROLE SYNC') {
  try {
    if (!member || !guild) return;
    const applicantsRole = guild.roles.cache.get('1484919969689894912') || guild.roles.cache.find(r => r.name.toLowerCase() === 'applicants');
    if (applicantsRole && member.roles.cache.has(applicantsRole.id)) {
      await member.roles.remove(applicantsRole);
      console.log(`[${contextLabel}] Removed Applicants role from ${member.user.username}`);
    }
  } catch (error) {
    console.warn(`[${contextLabel}] Could not remove Applicants role:`, error.message);
  }
}

async function removeApplicantsRoleIfPromoted(member, guild, contextLabel = 'ROLE SYNC') {
  try {
    if (!member || !guild) return;

    const traineeRole = guild.roles.cache.get('1484705126026449029') || guild.roles.cache.find(r => r.name.toLowerCase() === 'trainees');
    const agentsRole = guild.roles.cache.get('1482227287159078964') || guild.roles.cache.find(r => r.name.toLowerCase() === 'agents');
    const hasPromotionRole =
      (traineeRole && member.roles.cache.has(traineeRole.id)) ||
      (agentsRole && member.roles.cache.has(agentsRole.id));

    if (hasPromotionRole) {
      await removeApplicantsRoleFromMember(member, guild, contextLabel);
    }
  } catch (error) {
    console.warn(`[${contextLabel}] Could not sync Applicants role after promotion:`, error.message);
  }
}

async function sendAgentPinDM(member, pin, roleLabel = 'Agent', includePin = true) {
  const embed = new EmbedBuilder()
    .setTitle(`Welcome to Aavgo, ${member.user.username}`)
    .setDescription(
      `You have been promoted to **${roleLabel}**.\n\n` +
      `Your secure PIN has been set by management.\n` +
      `For security, the PIN is never shown in direct messages.\n\n` +
      `Please keep this private and use it only for your Aavgo login flow.`
    )
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Operations � Promotion' })
    .setTimestamp();

  await member.send({ embeds: [embed] });
}

async function sendNewcomerAgentSetupDM(member) {
  const embed = new EmbedBuilder()
    .setTitle(`Welcome to Aavgo, ${member.user.username}`)
    .setDescription(
      `You have been promoted to **Agent**.\n\n` +
      `Please complete your setup in order:\n` +
      `**1.** Open <#1482255690054762646> (**register-set-pin**).\n` +
      `**2.** Click the **Setup Security** button.\n` +
      `**3.** Create your PIN, re-enter the same PIN, then submit your PH phone number (\`63\` or \`09\`).\n\n` +
      `After this, your account security setup is complete.`
    )
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Operations � Security Setup' })
    .setTimestamp();

  await member.send({ embeds: [embed] });
}
async function applyAgentPromotion(interaction, targetUser, pin, role = 'agent', sourceLabel = 'ADD-AGENT') {
  const member = await interaction.guild.members.fetch(targetUser.id);
  const normalizedRole = normalizeAgentRole(role);
  const isDeveloperLevel = isDeveloper(interaction);

  if (normalizedRole !== 'agent' && !isDeveloperLevel) {
    throw new Error('Access denied');
  }

  const existing = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
  if (existing) {
    db.prepare("UPDATE agents SET username = ?, pin = ?, role = ?, agent_status = 'ready' WHERE discord_id = ?").run(targetUser.username, pin, normalizedRole, targetUser.id);
  } else {
    db.prepare("INSERT INTO agents (discord_id, username, pin, role, agent_status) VALUES (?, ?, ?, ?, 'ready')").run(targetUser.id, targetUser.username, pin, normalizedRole);
  }

  try {
    const agentsRole = interaction.guild.roles.cache.get('1482227287159078964') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase());
    const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
    const traineeRole = interaction.guild.roles.cache.get('1484705126026449029') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'trainees');
    const applicantsRole = interaction.guild.roles.cache.get('1484919969689894912') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'applicants');
    const unverifiedRole = normalizedRole === 'agent'
      ? (interaction.guild.roles.cache.get('1485275671797436620') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'unverified'))
      : null;

    const rolesToAdd = [agentsRole, loggedOutRole, unverifiedRole].filter(Boolean);
    const rolesToRemove = [traineeRole, applicantsRole].filter(roleObj => roleObj && member.roles.cache.has(roleObj.id));

    if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
    if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);
  } catch (roleErr) {
    console.warn(`[${sourceLabel}] Role sync warning:`, roleErr.message);
  }

  if (normalizedRole === 'agent' && (sourceLabel === 'ADD-AGENT' || sourceLabel === 'NEWCOMER')) {
    await sendNewcomerAgentSetupDM(member).catch(error => {
      console.warn(`[${sourceLabel}] Could not DM setup tutorial:`, error.message);
    });
  } else {
    await sendAgentPinDM(member, pin, getRoleLabel(normalizedRole), sourceLabel !== 'ADD-AGENT').catch(error => {
      console.warn(`[${sourceLabel}] Could not DM PIN:`, error.message);
    });
  }

  return member;
}

async function handleNewcomerPromotion(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: 'ERROR: Management or Developer access required.', ephemeral: true });
    }

    const [action, targetUserId, announcementMessageId] = interaction.customId.split(':');
    const member = await interaction.guild.members.fetch(targetUserId);

    const isTraineeAction = action === 'newcomer_promote_trainee';
    const isAgentAction = action === 'newcomer_promote_agent';

    if (!isTraineeAction && !isAgentAction) {
      return interaction.reply({ content: 'ERROR: Unknown newcomer action.', ephemeral: true });
    }

    if (isTraineeAction) {
      const traineeRole = interaction.guild.roles.cache.get('1484705126026449029') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'trainees');
      if (traineeRole && member.roles.cache.has(traineeRole.id)) {
        return interaction.reply({ content: `WARNING: **${member.user.username}** already has the Trainees role.`, ephemeral: true });
      }

      const applicantsRole = interaction.guild.roles.cache.get('1484919969689894912') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'applicants');
      const agentsRole = interaction.guild.roles.cache.get('1482227287159078964') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'agents');
      const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
      const rolesToRemove = [applicantsRole, agentsRole, loggedOutRole].filter(role => role && member.roles.cache.has(role.id));
      if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
      if (traineeRole) await member.roles.add(traineeRole);
      sendAuditLog(interaction.client, {
        title: 'Newcomer Promoted to Trainee',
        description: `**User:** ${member.user.username} (<@${member.id}>)\n**Action:** Trainee\n**Handled By:** {{AGENT_NAME}}`,
        color: 0x3498DB,
        userId: interaction.user.id,
        guild: interaction.guild
      });

      await interaction.message.edit({ components: [] }).catch(() => {});
      return interaction.reply({ content: `SUCCESS: **${member.user.username}** has been promoted to **Trainee**.`, ephemeral: true });
    }

    const agentsRole = interaction.guild.roles.cache.get('1482227287159078964') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'agents');
    const unverifiedRole = interaction.guild.roles.cache.get('1485275671797436620');
    const applicantsRole = interaction.guild.roles.cache.get('1484919969689894912') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'applicants');
    const traineeRole = interaction.guild.roles.cache.get('1484705126026449029') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'trainees');
    const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());

    if (agentsRole && member.roles.cache.has(agentsRole.id) && (!unverifiedRole || member.roles.cache.has(unverifiedRole.id))) {
      return interaction.reply({ content: `WARNING: **${member.user.username}** is already promoted as Agent.`, ephemeral: true });
    }

    const existing = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(member.user.id);
    if (existing) {
      db.prepare("UPDATE agents SET username = ?, role = 'agent', agent_status = 'ready' WHERE discord_id = ?")
        .run(member.user.username, member.user.id);
    } else {
      const tempPin = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare("INSERT INTO agents (discord_id, username, pin, role, agent_status) VALUES (?, ?, ?, 'agent', 'ready')")
        .run(member.user.id, member.user.username, tempPin);
    }

    const rolesToRemove = [applicantsRole, traineeRole, loggedOutRole].filter(roleObj => roleObj && member.roles.cache.has(roleObj.id));
    const rolesToAdd = [agentsRole, unverifiedRole].filter(Boolean);
    if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
    if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);

    await sendNewcomerAgentSetupDM(member).catch(error => {
      console.warn('[NEWCOMER] Could not DM setup tutorial:', error.message);
    });

    sendAuditLog(interaction.client, {
      title: 'Newcomer Promoted to Agent',
      description: `**User:** ${member.user.username} (<@${member.id}>)\n**Action:** Agent + Unverified (no PIN set)\n**Handled By:** {{AGENT_NAME}}`,
      color: 0x57F287,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    if (announcementMessageId) {
      const channel = await interaction.guild.channels.fetch(NEWCOMER_CHANNEL_ID).catch(() => null);
      if (channel && channel.isTextBased()) {
        await channel.messages.fetch(announcementMessageId).then(msg => msg.edit({ components: [] })).catch(() => {});
      }
    }

    return interaction.reply({
      content: `SUCCESS: **${member.user.username}** has been promoted to **Agent** with **Unverified** role. Setup tutorial was sent by DM.`,
      ephemeral: true
    });
  } catch (error) {
    console.error('Error in handleNewcomerPromotion:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'ERROR: Failed to update the newcomer role.', ephemeral: true }).catch(() => {});
    }
  }
}
function buildNewcomerAgentPinModal(targetUserId, announcementMessageId) {
  const modal = new ModalBuilder()
    .setCustomId(`newcomer_agent_pin_modal:${targetUserId}:${announcementMessageId}`)
    .setTitle('Promote Newcomer to Agent');

  const pinInput = new TextInputBuilder()
    .setCustomId('newcomer_agent_pin')
    .setLabel('Set the new agent PIN')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(6)
    .setPlaceholder('Enter a 4-6 digit PIN');

  modal.addComponents(new ActionRowBuilder().addComponents(pinInput));
  return modal;
}

async function handleNewcomerAgentPinSubmit(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const [, targetUserId, announcementMessageId] = interaction.customId.split(':');
    const pin = interaction.fields.getTextInputValue('newcomer_agent_pin').trim();

    if (!/^\d{4,6}$/.test(pin)) {
      return interaction.editReply({ content: '❌ PIN must be 4 to 6 digits long.' });
    }

    const member = await interaction.guild.members.fetch(targetUserId);
    await applyAgentPromotion(interaction, member.user, pin, 'agent', 'NEWCOMER');

    sendAuditLog(interaction.client, {
      title: '👋 Newcomer Promoted to Agent',
      description: `**User:** ${member.user.username} (<@${member.id}>)\n**Action:** Agent\n**Handled By:** {{AGENT_NAME}}`,
      color: 0x57F287,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    if (announcementMessageId) {
      const channel = await interaction.guild.channels.fetch(NEWCOMER_CHANNEL_ID).catch(() => null);
      if (channel && channel.isTextBased()) {
        await channel.messages.fetch(announcementMessageId).then(msg => msg.edit({ components: [] })).catch(() => {});
      }
    }

    await interaction.editReply({ content: `✅ **${member.user.username}** has been promoted to **Agent**.` });
  } catch (error) {
    console.error('Error in handleNewcomerAgentPinSubmit:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to complete the agent promotion.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to complete the agent promotion.', ephemeral: true }).catch(() => {});
    }
  }
}

async function showShiftInitModal(interaction, agent) {
  const modal = new ModalBuilder()
    .setCustomId('shift_init_modal')
    .setTitle('Initialize Shift');

  const hotelInput = new TextInputBuilder()
    .setCustomId('shift_hotel')
    .setLabel('Hotel Assignment')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('Type hotel name (Indianhead/Magnuson, Garden Inn, Super 8, Ramada, AD1)');

  const pinInput = new TextInputBuilder()
    .setCustomId('shift_pin')
    .setLabel('Secure PIN')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(6)
    .setPlaceholder('Enter your 4-6 digit PIN');

  if (agent?.hotel_id && HOTEL_NAMES[agent.hotel_id]) hotelInput.setValue(HOTEL_NAMES[agent.hotel_id]);

  modal.addComponents(
    new ActionRowBuilder().addComponents(hotelInput),
    new ActionRowBuilder().addComponents(pinInput)
  );

  await interaction.showModal(modal);
}

async function finalizeShiftLogin(interaction, agent, hotelId, isTakeover = false, allowMultiHotel = false, sessionMode = 'shift') {
  const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
  const recentSession = db.prepare("SELECT id FROM sessions WHERE agent_id = ? AND hotel_id = ? AND login_time >= ?").get(agent.id, hotelId, fiveSecondsAgo);
  if (recentSession) {
    return interaction.editReply({ content: '⚠️ You just logged in! Please wait a moment for the status to update.' });
  }

  if (!allowMultiHotel) {
    await closeAllActiveSessionsForAgent(agent.id, interaction.client);
  }

  if (hotelId !== 'TEAM_SHIFT') {
    const conflictingSession = db.prepare(
      "SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND agent_id != ? ORDER BY id DESC LIMIT 1"
    ).get(hotelId, agent.id);

    if (conflictingSession && !isTakeover) {
      return interaction.editReply({
        content: `Another agent is already active in **${HOTEL_NAMES[hotelId] || hotelId}**. Please use the takeover flow instead.`,
        embeds: [],
        components: []
      });
    }

    if (conflictingSession && isTakeover) {
      await closeOtherActiveHotelSessions(interaction, hotelId, agent.id);
    }
  }

  const nowIso = new Date().toISOString();
  db.prepare("INSERT INTO sessions (agent_id, hotel_id, session_kind, login_time) VALUES (?, ?, ?, ?)").run(agent.id, hotelId, sessionMode, nowIso);

  let noteAlert = '';

  if (hotelId !== 'TEAM_SHIFT') {
    try {
      const member = interaction.member;
      const guild = interaction.guild;
      const onShift = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
      const loggedOut = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
      const greenRole = guild.roles.cache.get(ROLE_NAMES.GREEN[hotelId]);
      const greyRole = guild.roles.cache.get(ROLE_NAMES.GREY[hotelId]);

      if (onShift && loggedOut && greenRole) {
        const rolesToAdd = [onShift, greenRole];
        const rolesToRemove = [loggedOut];
        if (greyRole) rolesToRemove.push(greyRole);

        await member.roles.add(rolesToAdd);
        await member.roles.remove(rolesToRemove);
        console.log(`[ROLES] Shift roles swapped for ${interaction.user.username}: +Green, -Grey`);
      }
    } catch (roleErr) {
      console.warn('[ROLES] Could not update roles:', roleErr.message);
    }
  }

  if (hotelId === 'TEAM_SHIFT') {
    await updateTeamStatusEmbed(interaction.client, agent.team);
    const teamHotels = agent.team === 'Team 1' ? TEAM_1_HOTELS : [];
    for (const hId of teamHotels) {
      updateHotelStatusEmbed(interaction.client, hId).catch(e => console.error(`[SYNC] Failed to update hotel ${hId}:`, e));
    }
  } else {
    updateHotelStatusEmbed(interaction.client, hotelId).catch(e => console.error('Failed to update hotel status embed:', e));
  }
  if (sessionMode === 'training') {
    updateTrainingStatusEmbed(interaction.client).catch(e => console.error('Failed to update training status embed:', e));
  }

  const unreadNotes = db.prepare(`
    SELECT handover_notes.*, agents.username
    FROM handover_notes
    JOIN agents ON handover_notes.agent_id = agents.id
    WHERE handover_notes.hotel_id = ? AND handover_notes.status = 'unread'
  `).all(hotelId);

  if (unreadNotes.length > 0) {
    try {
      const noteEmbed = new EmbedBuilder()
        .setTitle('📝 Pending Handover Notes')
        .setDescription(`You have **${unreadNotes.length}** new handover note(s) for **${HOTEL_NAMES[hotelId]}**:`)
        .setColor(0xFEE75C)
        .setTimestamp();

      unreadNotes.forEach(n => {
        noteEmbed.addFields({ name: `From ${n.username}`, value: `> ${n.content}` });
      });

      await interaction.user.send({ embeds: [noteEmbed] });
      db.prepare("UPDATE handover_notes SET status = 'read' WHERE hotel_id = ? AND status = 'unread'").run(hotelId);
    } catch (dmErr) {
      console.warn(`[HANDOVER] Could not DM notes to ${interaction.user.username}:`, dmErr.message);
    }
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const schedule = db.prepare(`
    SELECT id FROM schedules
    WHERE agent_id = ? AND hotel_id = ? AND status = 'pending'
    AND date(start_time) = ?
  `).get(agent.id, hotelId, todayStr);

  if (schedule) {
    db.prepare("UPDATE schedules SET status = 'attended' WHERE id = ?").run(schedule.id);
    noteAlert += '\n✅ **Attendance Recorded:** Your shift assignment has been marked as attended.';
  }

  const hotelName = HOTEL_NAMES[hotelId] || hotelId;
  const sessionLabel = sessionMode === 'training' ? 'training session' : 'shift';
  await interaction.editReply({
    content: `✅ **Success!** Your ${sessionLabel} is now live in **${hotelName}**. ${noteAlert}`,
    embeds: [],
    components: []
  });

  if (isTakeover && hotelId !== 'TEAM_SHIFT') {
    const priorSession = db.prepare("SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND agent_id != ? ORDER BY id DESC LIMIT 1").get(hotelId, agent.id);
    if (priorSession) {
      const priorAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(priorSession.agent_id);
      db.prepare("UPDATE sessions SET logout_time = CURRENT_TIMESTAMP, status = 'closed' WHERE id = ?").run(priorSession.id);
      try {
        const oldMember = await interaction.guild.members.fetch(priorAgent.discord_id);
        if (oldMember) {
          const onShiftRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
          const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
          const greenRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREEN[hotelId]);
          const greyRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREY[hotelId]);

          if (onShiftRole && loggedOutRole && greenRole) {
            const rolesToRemove = [onShiftRole, greenRole];
            const rolesToAdd = [loggedOutRole];
            if (greyRole) rolesToAdd.push(greyRole);

            await oldMember.roles.remove(rolesToRemove);
            await oldMember.roles.add(rolesToAdd);
            console.log(`[TAKEOVER] Roles reverted for ${priorAgent.username}: -Green, +Grey`);
          }
        }
      } catch (e) {
        console.warn('Could not revert roles for prior agent:', e.message);
      }
    }
  }

  console.log(`[LOGIN] ${interaction.user.username} → ${hotelName}`);

  const auditUnix = Math.floor(Date.now() / 1000);
  const nickname = await getAgentDisplayName(interaction.guild, interaction.user.id);
  sendAuditLog(interaction.client, {
    title: hotelId === 'TEAM_SHIFT' ? '🟢 Management Logged In' : '🟢 Agent Logged In',
    description: `**User:** ${nickname} (<@${interaction.user.id}>)\n**Location:** ${hotelName}\n**Time:** <t:${auditUnix}:F>`,
    color: 0x57F287,
    userId: interaction.user.id,
    hotelId: hotelId === 'TEAM_SHIFT' ? 'TEAM_SHIFT' : undefined,
    guild: interaction.guild
  });
}

// ─── Single Persistent Hotel Status Embed ────────────
async function updateHotelStatusEmbed(client, hotelId) {
  try {
    const hotelGroup = getHotelStatusGroup(hotelId);
    const hotelChannelId = HOTEL_LOGIN_CHANNELS[hotelGroup.key] || HOTEL_LOGIN_CHANNELS[hotelId];
    if (!hotelChannelId) return;

    const channel = await client.channels.fetch(hotelChannelId);
    if (!channel) return;

    const placeholders = hotelGroup.hotelIds.map(() => '?').join(', ');

    // Fetch all active sessions for this hotel group (Deduplicated by agent ID in the visual layer)
    const activeSessions = db.prepare(`
      SELECT s1.*, agents.discord_id, agents.username 
      FROM sessions s1
      JOIN agents ON s1.agent_id = agents.id 
      WHERE s1.hotel_id IN (${placeholders}) AND s1.status = 'active'
      AND s1.id = (SELECT MAX(s2.id) FROM sessions s2 WHERE s2.agent_id = s1.agent_id AND s2.status = 'active')
      ORDER BY s1.login_time DESC
    `).all(...hotelGroup.hotelIds);

    const hotelName = hotelGroup.label;
    const OVERTIME_HOURS = 8;
    let embedColor, embedTitle, description;
    let components = [];
    const statusKey = hotelGroup.key;

    if (activeSessions.length === 0) {
      // No one on shift
      embedColor = 0x2C2F33;
      embedTitle = `🏨 ${hotelName} Status`;
      const nowUnix = Math.floor(Date.now() / 1000);
      description = `### ⚠️ HOTEL UNSTAFFED\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `> 🔴 **Status:** Offline / No Agent\n` +
        `> ⏳ **Unstaffed since:** <t:${nowUnix}:R>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

      // Add TL Presence Info
      const activeTLs = db.prepare(`
        SELECT agents.username 
        FROM sessions 
        JOIN agents ON sessions.agent_id = agents.id 
        WHERE sessions.hotel_id = 'TEAM_SHIFT' AND sessions.status = 'active'
        AND agents.team IN (SELECT team FROM hotels WHERE id IN (${placeholders}))
      `).all(...hotelGroup.hotelIds);

      const tlNames = activeTLs.length > 0 ? activeTLs.map(t => t.username).join(', ') : 'None';
      description += `> 🛡️ **Team Leader on Shift:** ${tlNames}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Please initialize your shift if you are starting now.*`;
    } else {
      // Logic for color and status: TL Covering = Cyan, Bio Break = Yellow, Normal Break = Violet, Active = Green
      const primarySession = activeSessions[0];
      const isTL = !!primarySession.break_covering_id;
      const isBio = primarySession.break_status === 'Bio Break';
      const isNormal = primarySession.break_status === 'Normal Break';

      // Get active management for this team
      const teamId = db.prepare(`SELECT team FROM hotels WHERE id IN (${placeholders}) ORDER BY CASE id WHEN 'RMDA' THEN 0 WHEN 'SUP8' THEN 1 ELSE 2 END LIMIT 1`).get(...hotelGroup.hotelIds)?.team || 'Team 1';
      const activeTLs = db.prepare(`
        SELECT agents.username 
        FROM sessions 
        JOIN agents ON sessions.agent_id = agents.id 
        WHERE sessions.hotel_id = 'TEAM_SHIFT' AND sessions.status = 'active'
        AND agents.team = ?
      `).all(teamId);

      const tlNames = activeTLs.length > 0 ? activeTLs.map(t => t.username).join(', ') : 'None';

      if (isTL) {
        embedColor = 0x3498DB; // Cyan/Blue
        embedTitle = `🏨 ${hotelName} Status — TL COVERING`;
      } else if (isBio) {
        embedColor = 0xFEE75C; // Yellow
        embedTitle = `🏨 ${hotelName} Status — BIO BREAK`;
      } else if (isNormal) {
        embedColor = 0x9B59B6; // Violet
        embedTitle = `🏨 ${hotelName} Status — ON BREAK`;
      } else {
        embedColor = 0x57F287; // Green
        embedTitle = `🏨 ${hotelName} Status — ACTIVE`;
      }

      let lines = [
        isTL ? `### 🛡️ TL COVERING` : (isBio ? `### 🚽 On-bio break` : (isNormal ? `### ☕ On-Normal break` : `### ✅ SHIFT IN PROGRESS`)),
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `> 🛡️ **Team Leader on Shift:** ${tlNames}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      ];

      for (const session of activeSessions) {
        // Robust timestamp parsing (Support ISO and SQLite strings)
        let cleanTime = session.login_time;
        if (cleanTime && !cleanTime.includes('T') && !cleanTime.includes('Z')) {
           cleanTime = cleanTime.replace(' ', 'T') + 'Z';
        }
        const loginTime = new Date(cleanTime || Date.now()).getTime();
        const loginUnix = Math.floor(loginTime / 1000);
        const durationMs = Date.now() - loginTime;
        const hours = Math.floor(durationMs / (1000 * 60 * 60));
        const isOvertime = hours >= OVERTIME_HOURS;

        lines.push(`> 👤 **Agent:** <@${session.discord_id}>`);
        lines.push(`> ⏱️ **Logged in for:** <t:${loginUnix}:R>`);
        lines.push(`> 📅 **Since:** <t:${loginUnix}:f>`);
        if (session.session_kind === 'training') {
          lines.push(`> 🧭 **Mode:** Training`);
        }
        
        if (isOvertime) {
          lines.push(`> ⚠️ **STATUS: OVERTIME** (${hours}h+)`);
        }

        if (session.break_status) {
          let bTime = session.break_start_time;
          if (bTime) {
            if (!bTime.includes('T') && !bTime.includes('Z')) {
               bTime = bTime.replace(' ', 'T') + 'Z';
            }
            const breakUnix = Math.floor(new Date(bTime).getTime() / 1000);
            lines.push(`> ⏳ **Break Duration:** <t:${breakUnix}:R>`);
          }
          if (session.break_covering_id) {
            lines.push(`> 🛡️ **Covering TL:** <@${session.break_covering_id}>`);
          }
        }
      }

      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      description = lines.join('\n');

      // Create Buttons
      const actionRow = new ActionRowBuilder();
      const actionRow2 = new ActionRowBuilder();
      
      const logoutBtn = new ButtonBuilder()
        .setCustomId(`logout_btn_${primarySession.discord_id}`)
        .setLabel('🔴 End Shift')
        .setStyle(ButtonStyle.Danger);
      
      const checkInBtn = new ButtonBuilder()
        .setCustomId(`activity_checkin_${hotelId}`)
        .setLabel('🛎️ Check-In')
        .setStyle(ButtonStyle.Primary);

      const checkOutBtn = new ButtonBuilder()
        .setCustomId(`activity_checkout_${hotelId}`)
        .setLabel('🗝️ Check-Out')
        .setStyle(ButtonStyle.Primary);

      const callBtn = new ButtonBuilder()
        .setCustomId(`activity_call_${hotelId}`)
        .setLabel('📞 Call Log')
        .setStyle(ButtonStyle.Primary);

      const maintenanceBtn = new ButtonBuilder()
        .setCustomId(`activity_maintenance_${hotelId}`)
        .setLabel('🛠️ Maintenance')
        .setStyle(ButtonStyle.Secondary);

      const handoverBtn = new ButtonBuilder()
        .setCustomId(`activity_handover_${hotelId}`)
        .setLabel('📝 Handover')
        .setStyle(ButtonStyle.Secondary);

      if (hotelId === 'AD1') {
        actionRow.addComponents(logoutBtn, callBtn, handoverBtn);
      } else {
        actionRow.addComponents(logoutBtn, checkInBtn, checkOutBtn);
        actionRow2.addComponents(callBtn, maintenanceBtn, handoverBtn);
      }

      // Add Break ending button if agent is on break
      if (primarySession.break_status) {
        const breakLabel = primarySession.break_status === 'Bio Break' ? '🛑 End Bio-break' : '🛑 End Normal Break';
        const endBreakBtn = new ButtonBuilder()
          .setCustomId(`tools_end_bio_${primarySession.discord_id}`)
          .setLabel(breakLabel)
          .setStyle(ButtonStyle.Secondary);
        if (hotelId === 'AD1') {
          actionRow.addComponents(endBreakBtn);
        } else {
          actionRow2.addComponents(endBreakBtn);
        }
      }
      
      components = hotelId === 'AD1' ? [actionRow] : [actionRow, actionRow2];
    }

    const embed = new EmbedBuilder()
      .setTitle(embedTitle)
      .setDescription(description)
      .setColor(embedColor)
      .setFooter({ text: `Aavgo Operations • Live Status • Ref: ${statusKey}` })
      .addFields({ name: '📡 System Status', value: '🟢 **Bot is Online**', inline: false })
      .setTimestamp();

    let statusRow = db.prepare("SELECT message_id FROM hotel_status WHERE hotel_id = ?").get(statusKey);
    if (!statusRow && statusKey !== hotelId) {
      const legacyRow = db.prepare("SELECT message_id FROM hotel_status WHERE hotel_id = ?").get(hotelId);
      if (legacyRow?.message_id) {
        statusRow = legacyRow;
        db.prepare("INSERT OR REPLACE INTO hotel_status (hotel_id, message_id) VALUES (?, ?)").run(statusKey, legacyRow.message_id);
        db.prepare("DELETE FROM hotel_status WHERE hotel_id = ?").run(hotelId);
      }
    }
    let existingMsg = null;

    // Safety guard: never overwrite the kiosk/login message
    const kioskMsgId = db.prepare("SELECT value FROM config WHERE key = ?").get(`kiosk_msg_${hotelChannelId}`)?.value;

    if (statusRow && statusRow.message_id) {
      // If the stored message_id is the kiosk, clear it so we send a new status message
      if (statusRow.message_id === kioskMsgId) {
        db.prepare("DELETE FROM hotel_status WHERE hotel_id = ?").run(hotelId);
      } else {
        try {
          existingMsg = await channel.messages.fetch(statusRow.message_id);
        } catch (e) {
          existingMsg = null;
        }
      }
    }

    if (!existingMsg) {
      const recentMessages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
      if (recentMessages) {
        existingMsg = recentMessages.find(message =>
          message.author?.id === client.user?.id &&
          message.id !== kioskMsgId &&
          Array.isArray(message.embeds) &&
          message.embeds.some(existingEmbed => existingEmbed.footer?.text?.includes(`Ref: ${statusKey}`))
        ) || null;

        if (existingMsg) {
          db.prepare("INSERT OR REPLACE INTO hotel_status (hotel_id, message_id) VALUES (?, ?)").run(statusKey, existingMsg.id);
        }
      }
    }

    if (existingMsg) {
      await existingMsg.edit({ embeds: [embed], components });
    } else {
      const newMsg = await channel.send({ embeds: [embed], components });
      db.prepare("INSERT OR REPLACE INTO hotel_status (hotel_id, message_id) VALUES (?, ?)").run(statusKey, newMsg.id);
    }

  } catch (e) {
    console.warn('[STATUS] Failed to update hotel status embed:', e.message);
  }
}

// ─── /setup-login ────────────────────────────────────
function buildAgentKioskPayload() {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations · Virtual Kiosk')
    .setDescription(
      '# Welcome to the Agent Portal\n' +
      '### Secure Shift Management System\n\n' +
      'This portal monitors and logs all active sessions in real-time. Please follow the protocol below to initialize your shift.\n\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '### 📋 Protocol\n' +
      '> **1.** Click **Initialize Shift** below\n' +
      '> **2.** Select your **Team** (First time only)\n' +
      '> **3.** Choose your **Hotel Assignment**\n' +
      '> **4.** Verify your **Secure PIN**\n' +
      '> **5.** Use **Training** when you are learning a hotel\n\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '### 🏨 Service Locations\n' +
      '**Team 1:** `Indianhead/Magnuson`, `The Garden Inn At Campsite`, `Super 8`, `Ramada`, `AD1`'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations · Automated Access Control' })
    .setTimestamp();

  const startBtn = new ButtonBuilder()
    .setCustomId('start_shift_btn')
    .setLabel('🚀 Initialize Shift')
    .setStyle(ButtonStyle.Primary);

  const trainingBtn = new ButtonBuilder()
    .setCustomId('training_start_btn')
    .setLabel('🧭 Training')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(startBtn, trainingBtn)
    ]
  };
}

async function ensureAgentKioskMessage(client, channelId) {
  try {
    const kioskKey = `kiosk_msg_${channelId}`;
    const stored = db.prepare("SELECT value FROM config WHERE key = ?").get(kioskKey);
    if (!stored?.value) {
      return null;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return null;
    }

    const message = await channel.messages.fetch(stored.value).catch(() => null);
    if (!message) {
      db.prepare("DELETE FROM config WHERE key = ?").run(kioskKey);
      return null;
    }

    const hasStartButton = message.components.some(row =>
      row.components.some(component => component.customId === 'start_shift_btn')
    );
    const hasTrainingButton = message.components.some(row =>
      row.components.some(component => component.customId === 'training_start_btn')
    );

    if (!hasStartButton || !hasTrainingButton) {
      await message.edit(buildAgentKioskPayload());
      console.log(`[KIOSK] Restored Initialize Shift button in channel ${channelId}: ${message.id}`);
    }

    return message;
  } catch (error) {
    console.warn(`[KIOSK] Failed to restore kiosk for channel ${channelId}:`, error.message);
    return null;
  }
}

async function handleSetupLogin(interaction) {
  try {
    const channelId = interaction.channelId;
    const existingMsg = await ensureAgentKioskMessage(interaction.client, channelId);

    if (existingMsg) {
      await interaction.reply({
        content: `✅ Agent kiosk refreshed in <#${channelId}>.`,
        ephemeral: true
      });
      return;
    }

    const msg = await interaction.reply({ ...buildAgentKioskPayload(), fetchReply: true });
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(`kiosk_msg_${channelId}`, msg.id);
    console.log(`[KIOSK] Kiosk message pinned for channel ${channelId}: ${msg.id}`);
    return;
    if (false) {
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Aavgo Operations · Virtual Kiosk')
      .setDescription(
        '# Welcome to the Agent Portal\n' +
        '### Secure Shift Management System\n\n' +
        'This portal monitors and logs all active sessions in real-time. Please follow the protocol below to initialize your shift.\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '### 📋 Protocol\n' +
        '> **1.** Click **Initialize Shift** below\n' +
        '> **2.** Select your **Team** (First time only)\n' +
        '> **3.** Choose your **Hotel Assignment**\n' +
        '> **4.** Verify your **Secure PIN**\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '### 🏨 Service Locations\n' +
      '**Team 1:** `Indianhead/Magnuson`, `The Garden Inn At Campsite`, `Super 8`, `Ramada`, `AD1`'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Aavgo Operations · Automated Access Control' })
      .setTimestamp();

    const startBtn = new ButtonBuilder()
      .setCustomId('start_shift_btn')
      .setLabel('🚀 Initialize Shift')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(startBtn);
    const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

    // Store kiosk message ID so status embeds never overwrite it
    const channelId = interaction.channelId;
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(`kiosk_msg_${channelId}`, msg.id);
    console.log(`[KIOSK] Kiosk message pinned for channel ${channelId}: ${msg.id}`);
    }
  } catch (error) {
    console.error('Error in handleSetupLogin:', error);
  }
}

// ─── /setup-login-team ───────────────────────────────
async function handleSetupLoginTeam(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Only Developers can setup the Team Leader Portal.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Aavgo Operations · Management Portal')
      .setDescription(
        '# Team Leader & SME Shift Entry\n' +
        '### Secure Management Access\n\n' +
        'This portal is reserved for **Team Leaders** and **Subject Matter Experts** to initialize their oversight sessions.\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '### 📋 Access Protocol\n' +
        '> **1.** Click **Initialize Management Shift** below\n' +
        '> **2.** System will verify your **Role & Team**\n' +
        '> **3.** Enter your **Secure PIN**\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '### 📊 Live Oversight\n' +
        'Your presence will be recorded and displayed in the live management status below.'
      )
      .setColor(0x57F287)
      .setFooter({ text: 'Aavgo Operations · Management Access Control' })
      .setTimestamp();

    const startBtn = new ButtonBuilder()
      .setCustomId('tl_start_shift_btn')
      .setLabel('🔐 Initialize Management Shift')
      .setStyle(ButtonStyle.Success);

    const endBtn = new ButtonBuilder()
      .setCustomId('tl_logout_btn')
      .setLabel('🛑 End Management Shift')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(startBtn, endBtn);
    await interaction.reply({ embeds: [embed], components: [row] });

    // Initial status embed
    await updateTeamStatusEmbed(interaction.client, 'Team 1');
  } catch (error) {
    console.error('Error in handleSetupLoginTeam:', error);
  }
}

function formatLoginTimeLabel(loginTime) {
  let cleanTime = loginTime;
  if (cleanTime && !cleanTime.includes('T') && !cleanTime.includes('Z')) {
    cleanTime = cleanTime.replace(' ', 'T') + 'Z';
  }
  const loginUnix = Math.floor(new Date(cleanTime || Date.now()).getTime() / 1000);
  return `<t:${loginUnix}:R>`;
}

function getTeam1HotelSummary() {
  return ['Indianhead/Magnuson', 'The Garden Inn At Campsite', 'Ramada / Super 8', 'AD1'];
}

function getTrainingGroupLabel(hotelId) {
  const group = TRAINING_HOTEL_GROUPS.find(entry => entry.hotelIds.includes(hotelId));
  return group ? group.label : (HOTEL_NAMES[hotelId] || hotelId);
}

function getHotelStatusGroup(hotelId) {
  if (hotelId === 'RMDA' || hotelId === 'SUP8') {
    return {
      key: 'RMDA',
      label: 'Ramada / Super 8',
      hotelIds: ['RMDA', 'SUP8']
    };
  }

  return {
    key: hotelId,
    label: HOTEL_NAMES[hotelId] || hotelId,
    hotelIds: [hotelId]
  };
}

async function updateTeamStatusEmbed(client, teamName) {
  try {
    const channel = await client.channels.fetch(TL_STATUS_CHANNEL_ID);
    if (!channel) return;

    const activeTLs = db.prepare(`
      SELECT agents.username, agents.discord_id, agents.role, sessions.login_time, agents.team
      FROM sessions
      JOIN agents ON sessions.agent_id = agents.id
      WHERE sessions.hotel_id = 'TEAM_SHIFT' AND sessions.status = 'active'
    `).all();

    const teamRows = TEAM_NAMES.map(name => {
      const loggedIn = activeTLs.filter(row => row.team === name);
      const roster = db.prepare(`
        SELECT username, discord_id, role
        FROM agents
        WHERE team = ? AND role IN ('team_leader', 'sme', 'operations_manager')
        ORDER BY CASE role
          WHEN 'operations_manager' THEN 0
          WHEN 'team_leader' THEN 1
          WHEN 'sme' THEN 2
          ELSE 3
        END, username ASC
      `).all(name);

      const loggedInIds = new Set(loggedIn.map(row => row.discord_id));
      const offline = roster.filter(row => !loggedInIds.has(row.discord_id));

      const teamLabel = name === 'Team 1' ? 'Team 1' : 'Team 2';
      const hotelLabel = name === 'Team 1'
        ? getTeam1HotelSummary().map(h => `\`${h}\``).join(', ')
        : '`Placeholder for future`';

      const liveLines = loggedIn.length > 0
        ? loggedIn
          .map(row => `- <@${row.discord_id}> | ${getRoleLabel(row.role)} | active ${formatLoginTimeLabel(row.login_time)}`)
          .join('\n')
        : '- No one is currently logged in';

      const offlineLines = offline.length > 0
        ? offline.map(row => `- <@${row.discord_id}>`).join('\n')
        : '- Everyone in roster is online';

      return {
        name: `${teamLabel} Oversight`,
        value:
          `**Service Hotels**\n${hotelLabel}\n\n` +
          `**Logged In Now**\n${liveLines}\n\n` +
          `**Logged Out**\n${offlineLines}`,
        inline: false
      };
    });

    const teamOneLoggedIn = activeTLs.filter(row => row.team === 'Team 1').length;
    const teamTwoLoggedIn = activeTLs.filter(row => row.team === 'Team 2').length;

    const embed = new EmbedBuilder()
      .setTitle('Team Leader Login Status')
      .setDescription(
        '**Operations Oversight Board**\n' +
        'Live management coverage and team leader presence.\n\n' +
        `**Team 1 Online:** ${teamOneLoggedIn}\n` +
        `**Team 2 Online:** ${teamTwoLoggedIn}\n` +
        `**Total Active Oversight:** ${activeTLs.length}`
      )
      .setColor(activeTLs.length > 0 ? 0x57F287 : 0x2B2D31)
      .setFooter({ text: 'Aavgo Operations - Team Leader Presence' })
      .addFields(teamRows)
      .setTimestamp();

    const key = 'team_leader_status_msg';
    const stored = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
    if (stored?.value) {
      try {
        const msg = await channel.messages.fetch(stored.value);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (e) {
        db.prepare("DELETE FROM config WHERE key = ?").run(key);
      }
    }

    const newMsg = await channel.send({ embeds: [embed] });
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, newMsg.id);
  } catch (e) {
    console.warn('[TL-STATUS] Failed to update team status embed:', e.message);
  }
}
async function updateTrainingStatusEmbed(client) {
  try {
    const channel = await client.channels.fetch(TRAINING_STATUS_CHANNEL_ID);
    if (!channel) return;

    const trainingSessions = db.prepare(`
      SELECT agents.username, agents.discord_id, sessions.hotel_id, sessions.login_time
      FROM sessions
      JOIN agents ON sessions.agent_id = agents.id
      WHERE sessions.status = 'active' AND sessions.session_kind = 'training'
      ORDER BY sessions.login_time DESC
    `).all();

    const groupRows = TRAINING_HOTEL_GROUPS.map(group => {
      const matching = trainingSessions.filter(session => group.hotelIds.includes(session.hotel_id));
      const value = matching.length > 0
        ? matching
          .map(session => `- <@${session.discord_id}> | active ${formatLoginTimeLabel(session.login_time)}`)
          .join('\n')
        : '- No active trainee';

      return {
        name: group.label,
        value,
        inline: false
      };
    });

    const embed = new EmbedBuilder()
      .setTitle('Training Status')
      .setDescription(
        '**Training Oversight Board**\n' +
        'Live visibility of active trainees by hotel group.\n\n' +
        `**Agents in Training Now:** ${trainingSessions.length}\n` +
        '**Scope:** Team 1 training groups'
      )
      .setColor(trainingSessions.length > 0 ? 0x5865F2 : 0x2B2D31)
      .setFooter({ text: 'Aavgo Operations - Training Presence' })
      .addFields(groupRows)
      .setTimestamp();

    const key = 'training_status_msg';
    const stored = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
    if (stored?.value) {
      try {
        const msg = await channel.messages.fetch(stored.value);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (e) {
        db.prepare("DELETE FROM config WHERE key = ?").run(key);
      }
    }

    const newMsg = await channel.send({ embeds: [embed] });
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, newMsg.id);
  } catch (e) {
    console.warn('[TRAINING-STATUS] Failed to update training status embed:', e.message);
  }
}
async function refreshOperationalBoards(client) {
  try {
    const hotels = db.prepare("SELECT id FROM hotels WHERE id != 'TEAM_SHIFT'").all();
    for (const hotel of hotels) {
      await updateHotelStatusEmbed(client, hotel.id);
    }
    await updateTeamStatusEmbed(client, 'Team 1');
    await updateTrainingStatusEmbed(client);
  } catch (error) {
    console.warn('[STATUS] Boot refresh failed:', error.message);
  }
}

// ─── /setup-register ─────────────────────────────────
async function handleSetupRegister(interaction) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('📝 Aavgo Operations · Recruitment Kiosk')
      .setDescription(
        '# Join the Agent Network\n' +
        '### Official Recruitment Portal\n\n' +
        'We are always looking for dedicated professionals to join our virtual operations team. Please click the button below to start your application.\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '### 🛡️ Requirements\n' +
        '> **1.** Secure Access Code (Provided by HR)\n' +
        '> **2.** Personal Security PIN (4-6 digits)\n' +
        '> **3.** Discord Account Verification\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '*Once submitted, your request will be reviewed by an administrator within 24 hours.*'
      )
      .setColor(0x57F287)
      .setFooter({ text: 'Aavgo Operations • Secure Recruitment Protocol' })
      .setTimestamp();

    const regBtn = new ButtonBuilder()
      .setCustomId('register_start_btn')
      .setLabel('📝 Apply to Join')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(regBtn);
    await interaction.reply({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('Error in handleSetupRegister:', error);
  }
}

// ─── /register ───────────────────────────────────────
async function handleSetupSecurity(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🔐 Aavgo Operations · Security Kiosk')
      .setDescription(
        '# Welcome to Security Setup\n' +
        '### Agent PIN & Contact Verification\n\n' +
        'This portal secures your account credentials and keeps your contact line updated for operations support.\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '### 📋 Protocol\n' +
        '> **1.** Click **Setup Security** below\n' +
        '> **2.** Enter your **New Security PIN**\n' +
        '> **3.** Confirm your **Security PIN**\n' +
        '> **4.** Submit your **PH Phone Number**\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '### 🛡️ Validation Rules\n' +
        '> **PIN:** `4-6 digits`\n' +
        '> **Phone:** starts with `63` or `09`\n\n' +
        '*Only registered agents can submit this form.*'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Aavgo Operations · Automated Security Control' })
      .setTimestamp();

    const setupBtn = new ButtonBuilder()
      .setCustomId('security_setup_btn')
      .setLabel('🛡️ Setup Security')
      .setStyle(ButtonStyle.Primary);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(setupBtn)]
    });
  } catch (error) {
    console.error('Error in handleSetupSecurity:', error);
  }
}

async function handleSecuritySetupStart(interaction) {
  try {
    const agent = db.prepare("SELECT pin, phone FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) {
      return interaction.reply({
        content: '❌ You are not a registered agent. Ask Operations Manager or Developer to run `/add-agent` first.',
        ephemeral: true
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('security_setup_modal')
      .setTitle('Setup Security');

    const pinInput = new TextInputBuilder()
      .setCustomId('security_pin')
      .setLabel('New Security PIN (4-6 digits)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(4)
      .setMaxLength(6)
      .setPlaceholder('e.g. 1234');

    const confirmPinInput = new TextInputBuilder()
      .setCustomId('security_pin_confirm')
      .setLabel('Confirm Security PIN')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(4)
      .setMaxLength(6)
      .setPlaceholder('Re-enter your PIN');

    const phoneInput = new TextInputBuilder()
      .setCustomId('security_phone')
      .setLabel('Phone Number (63 or 09)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('e.g. 639273068312 or 09123456789');

    if (agent.phone) {
      phoneInput.setValue(agent.phone);
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(pinInput),
      new ActionRowBuilder().addComponents(confirmPinInput),
      new ActionRowBuilder().addComponents(phoneInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    console.error('Error in handleSecuritySetupStart:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Could not open security setup form.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleSecuritySetupSubmit(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const pin = interaction.fields.getTextInputValue('security_pin').trim();
    const pinConfirm = interaction.fields.getTextInputValue('security_pin_confirm').trim();
    const phone = interaction.fields.getTextInputValue('security_phone').trim();

    if (!/^\d{4,6}$/.test(pin)) {
      return interaction.editReply({ content: '❌ PIN must be **4 to 6 digits**.' });
    }
    if (pin !== pinConfirm) {
      return interaction.editReply({ content: '❌ PIN and confirm PIN do not match.' });
    }
    const phonePattern = /^(?:63\d{10}|09\d{9})$/;
    if (!phonePattern.test(phone)) {
      return interaction.editReply({ content: '❌ Invalid phone number. Use PH format starting with `63` or `09`.' });
    }

    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) {
      return interaction.editReply({ content: '❌ You are not a registered agent. Ask Operations Manager or Developer to run `/add-agent` first.' });
    }

        db.prepare("UPDATE agents SET pin = ?, phone = ?, username = ? WHERE discord_id = ?")
      .run(pin, phone, interaction.user.username, interaction.user.id);

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const unverifiedRole = interaction.guild.roles.cache.get('1485275671797436620') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'unverified');
      if (member && unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
        await member.roles.remove(unverifiedRole);
      }
    } catch (roleError) {
      console.warn('[SECURITY] Could not remove Unverified role after PIN setup:', roleError.message);
    }

    await interaction.editReply({ content: '✅ Security profile updated. Your PIN and phone number are now saved.' });

    sendAuditLog(interaction.client, {
      title: '🔐 Security Setup Updated',
      description: `**Agent:** ${interaction.user.username} (<@${interaction.user.id}>)\n**Action:** Updated PIN and phone via security kiosk`,
      color: 0xF1C40F,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleSecuritySetupSubmit:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to save security setup.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to save security setup.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleRegister(interaction) {
  console.log(`[AUTH] Register button clicked by ${interaction.user.username} (${interaction.user.id})`);
  try {
    const existing = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    const hasAgentsRole = interaction.member.roles.cache.some(r => 
      r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase()
    );

    // Already in DB AND has the role — truly registered
    if (existing && hasAgentsRole) {
      try {
        await removeTraineeRoleFromMember(interaction.member, interaction.guild, 'REGISTER');
        await removeApplicantsRoleFromMember(interaction.member, interaction.guild, 'REGISTER');
      } catch (roleErr) {
        console.warn('[REGISTER] Could not clear Trainees role:', roleErr.message);
      }
      return interaction.reply({ content: '⚠️ You are already registered as an agent.', ephemeral: true });
    }

    // In DB but missing role — grant it
    if (existing && !hasAgentsRole) {
      try {
        const guild = interaction.guild;
        const agentsRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase());
        const loggedOutRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
        if (agentsRole) await interaction.member.roles.add(agentsRole);
        if (loggedOutRole) await interaction.member.roles.add(loggedOutRole);
        await removeTraineeRoleFromMember(interaction.member, guild, 'REGISTER');
        await removeApplicantsRoleFromMember(interaction.member, guild, 'REGISTER');
      } catch (roleErr) {
        console.warn('[REGISTER] Could not fix missing roles:', roleErr.message);
      }
      return interaction.reply({ content: '✅ You were already in our system — your **Agents** role has been restored!', ephemeral: true });
    }

    // [Safety] Clean up any pending registrations older than 1 hour (orphans)
    db.prepare("DELETE FROM pending_registrations WHERE requested_at < datetime('now', '-1 hour')").run();

    // Check if registration is already pending
    const pending = db.prepare("SELECT * FROM pending_registrations WHERE discord_id = ?").get(interaction.user.id);
    if (pending) {
      return interaction.reply({ content: '⏳ You already have a pending registration request. Please wait for an administrator to review it.', ephemeral: true });
    }


    const modal = new ModalBuilder()
      .setCustomId('register_modal')
      .setTitle('🔐 Aavgo Agent Registration');

    const secretInput = new TextInputBuilder()
      .setCustomId('register_secret')
      .setLabel('Enter the Recruitment Access Code')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('Enter code here...');

    const pinInput = new TextInputBuilder()
      .setCustomId('register_pin')
      .setLabel('Create your secure PIN (4-6 digits)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(4)
      .setMaxLength(6)
      .setPlaceholder('e.g. 1234');

    const emailInput = new TextInputBuilder()
      .setCustomId('register_email')
      .setLabel('Enter your Email Address')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('e.g. agent@aavgo.com');

    const phoneInput = new TextInputBuilder()
      .setCustomId('register_phone')
      .setLabel('Phone Number (Philippines 63+ ONLY)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('e.g. 639273068312');

    const row1 = new ActionRowBuilder().addComponents(secretInput);
    const row2 = new ActionRowBuilder().addComponents(pinInput);
    const row3 = new ActionRowBuilder().addComponents(emailInput);
    const row4 = new ActionRowBuilder().addComponents(phoneInput);
    modal.addComponents(row1, row2, row3, row4);
    await interaction.showModal(modal);
  } catch (error) {
    console.error('Error in handleRegister:', error);
  }
}

// ─── Register Modal Submit ───────────────────────────
async function handleRegisterSubmit(interaction) {
  try {
    const user = interaction.user;
    
    // Check if user is already registered in 'agents' table
    const existingAgent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(user.id);
    if (existingAgent) {
      return interaction.reply({ content: '⚠️ You are already in our records.', ephemeral: true });
    }

    // Attempt to register in 'pending_registrations' table
    try {
      db.prepare("INSERT INTO pending_registrations (discord_id) VALUES (?)").run(user.id);
    } catch (err) {
      // If error is code SQLITE_CONSTRAINT_PRIMARYKEY, it means they are already pending.
      const isDuplicate = err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.message.includes('UNIQUE constraint');
      return interaction.reply({ 
        content: isDuplicate 
          ? '⏳ You already have a pending registration request.' 
          : '❌ A database error occurred. Please try again later.', 
        ephemeral: true 
      });
    }

    // If we've reached this point, the user is now successfully in the pending table.
    const secret = interaction.fields.getTextInputValue('register_secret').trim();
    const pin = interaction.fields.getTextInputValue('register_pin').trim();
    const email = interaction.fields.getTextInputValue('register_email').trim().toLowerCase();
    const phone = interaction.fields.getTextInputValue('register_phone').trim();

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(user.id);
      return interaction.reply({
        content: '❌ **Invalid Email Address.** Please enter a real email in the format `name@example.com`.',
        ephemeral: true
      });
    }

    const phonePattern = /^(?:63\d{10}|09\d{9})$/;
    if (!phonePattern.test(phone)) {
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(user.id);
      return interaction.reply({ 
        content: '❌ **Invalid Phone Number.** Please use a valid Philippines number starting with `63` or `09`.', 
        ephemeral: true 
      });
    }

    // Save details to pending_registrations
    db.prepare("UPDATE pending_registrations SET pin = ?, phone = ?, email = ? WHERE discord_id = ?")
      .run(pin, phone, email, user.id);

    // Security Gate: Check Secret Code (One-time RAC)
    db.prepare("DELETE FROM rac_codes WHERE expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')").run();
    const racRecord = db.prepare("SELECT * FROM rac_codes WHERE code = ? AND datetime(expires_at) > datetime('now')").get(secret);
    
    if (!racRecord) {
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(user.id);
      const alertEmbed = new EmbedBuilder()
        .setTitle('❌ Security Alert')
        .setDescription('The **Recruitment Access Code** you entered is invalid, expired, or has already been used.\n\nPlease contact HR or a Developer for a fresh one-time code.')
        .setColor(0xED4245);
      return interaction.reply({ embeds: [alertEmbed], ephemeral: true });
    }

    // Valid code used - Burn it
    db.prepare("DELETE FROM rac_codes WHERE code = ?").run(secret);

    // Send approval request to approval channel
    const approvalChannel = await interaction.client.channels.fetch(APPROVAL_CHANNEL_ID);
    if (!approvalChannel) {
      return interaction.reply({ content: '❌ Approval channel not found. Contact an administrator.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('📥 NEW AGENT APPLICATION')
      .setDescription(
        `## 👤 ${user.username}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `> 🤵 **Discord:** <@${user.id}> (\`${user.id}\`)\n` +
        `> 📧 **Email:** \`${email}\`\n` +
        `> 📱 **Phone (PH):** \`${phone}\`\n` +
        `> ⏰ **Applied At:** <t:${Math.floor(Date.now()/1000)}:F>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Review the application below.*`
      )
      .setColor(0x5865F2)
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: 'Aavgo Operations · Recruitment System' })
      .setTimestamp();

    const approveBtn = new ButtonBuilder()
      .setCustomId(`approve_reg_${user.id}`)
      .setLabel('✅ Approve Agent')
      .setStyle(ButtonStyle.Success);

    const denyBtn = new ButtonBuilder()
      .setCustomId(`deny_reg_${user.id}`)
      .setLabel('❌ Deny')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);
    await approvalChannel.send({ embeds: [embed], components: [row] });

    await interaction.reply({ 
      content: `✅ **Application Submitted!**\n> Your registration is now under review. You'll receive a **DM** once a decision is made.`, 
      ephemeral: true 
    });
  } catch (error) {
    console.error('Error in handleRegisterSubmit:', error);
    // Silent cleanup if something fails after the DB insert
    try { db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(interaction.user.id); } catch(e){}
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true });
    }
  }
}

// ─── Approve Registration ────────────────────────────
async function handleApproveReg(interaction) {
  try {
    await interaction.deferUpdate();
    interaction.reply = interaction.followUp.bind(interaction);
    interaction.update = interaction.message.edit.bind(interaction.message);

    const parts = interaction.customId.split('_');
    const userId = parts[2];

    // 1. Fetch metadata from pending_registrations
    const pendingData = db.prepare("SELECT * FROM pending_registrations WHERE discord_id = ?").get(userId);
    if (!pendingData) {
      return interaction.reply({ content: '❌ **Database Sync Error:** Application data for this user is missing or expired.', ephemeral: true });
    }
    const { pin, phone, email } = pendingData;

    // Check if already registered
    const existing = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(userId);
    if (existing) {
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(userId);
      return interaction.reply({ content: '⚠️ This agent is already registered.', ephemeral: true });
    }

    // Get the member
    const guild = interaction.guild;
    const member = await guild.members.fetch(userId);

    // Insert into DB
    db.prepare("INSERT INTO agents (discord_id, username, pin, role, agent_status, approval_message_id, phone, email) VALUES (?, ?, ?, 'agent', 'ready', ?, ?, ?)").run(userId, member.user.username, pin, interaction.message.id, phone, email);

    // Grant base roles (non-blocking)
    try {
      const agentsRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase());
      const loggedOutRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
      
      const rolesToAdd = [agentsRole, loggedOutRole].filter(Boolean);
      if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);
      await removeTraineeRoleFromMember(member, guild, 'REGISTER');
      await removeApplicantsRoleFromMember(member, guild, 'REGISTER');
    } catch (roleErr) {
      console.warn('[REGISTER] Could not assign roles:', roleErr.message);
    }

    // 4. Send high-impact approval DM (CLEAN & SECURE)
    try {
      const welcomeEmbed = new EmbedBuilder()
        .setTitle('🏆 THE ELITE AAVGO TEAM')
        .setDescription(`# 🎉 CONGRATULATIONS!\n` +
                        `### YOU HAVE BEEN AWARDED ACCESS\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `> **Official Status:** Approved Operations Agent\n` +
                        `> **Department:** Aavgo Virtual Support\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `### 🔐 SECURITY NOTICE\n` +
                        `> **Registered Email:** \`${email}\`\n` +
                        `> *Your secure PIN is not displayed for your protection. Please use the PIN you created during registration.*\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `*Welcome to the highest tier of operations. Click 'Start Shift' in any hotel channel to begin your journey.*`)
        .setColor(0xF1C40F) // Gold
        .setFooter({ text: 'Aavgo Operations · Excellence in Performance' })
        .setTimestamp();

      await member.send({ embeds: [welcomeEmbed] });
    } catch (dmErr) {
      console.warn(`[APPROVE] Could not DM user ${member.user.username}:`, dmErr.message);
    }

    // Update the approval message
    const originalEmbed = interaction.message.embeds[0];
    const embed = EmbedBuilder.from(originalEmbed)
      .setTitle('✅ Active Agent · Verified')
      .setColor(0x57F287)
      .setDescription(originalEmbed.description + `\n\n**Approved by:** ${interaction.user.username}`)
      .setFooter({ text: `Member ID: ${userId}` });

    const removeBtn = new ButtonBuilder()
      .setCustomId(`remove_agent_${userId}`)
      .setLabel('🗑️ Remove Agent')
      .setStyle(ButtonStyle.Danger);
    
    const row = new ActionRowBuilder().addComponents(removeBtn);

    await interaction.update({ embeds: [embed], components: [row] });

    // Audit log
    await sendAuditLog(interaction.client, {
      title: '📋 Agent Registered',
      description: `**Agent:** ${member.user.username} (Nickname: {{AGENT_NAME}})\n**Approved by:** ${interaction.user.username}`,
      color: 0x57F287,
      userId: userId,
      guild: interaction.guild
    });

    // Clear pending registration
    db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(userId);

  } catch (error) {
    console.error('Error in handleApproveReg:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Something went wrong during approval.', ephemeral: true });
    }
  }
}

// ─── Deny Registration ──────────────────────────────
async function handleDenyReg(interaction) {
  try {
    await interaction.deferUpdate();
    interaction.reply = interaction.followUp.bind(interaction);
    interaction.update = interaction.message.edit.bind(interaction.message);

    const userId = interaction.customId.split('_')[2];

    // Update the denial message
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xED4245)
      .setFooter({ text: `❌ Denied by ${interaction.user.username}` });

    await interaction.update({ embeds: [embed], components: [] });

    // Clear pending registration
    db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(userId);

    try {
      const member = await interaction.guild.members.fetch(userId);
      const denyEmbed = new EmbedBuilder()
        .setTitle('🚫 Application Rejected')
        .setDescription(`### 🚫 ACCESS DENIED\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `> Your application to the Aavgo Operations team has been **DECLINED**.\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `*No further action is required.*`)
        .setColor(0xE74C3C)
        .setTimestamp();
      await member.send({ embeds: [denyEmbed] });
    } catch (dmErr) {
      console.warn('[REGISTER] Could not DM user:', dmErr.message);
    }
  } catch (error) {
    console.error('Error in handleDenyReg:', error);
  }
}

// ─── Start Shift Button Click ────────────────────────
async function handleStartShiftClick(interaction) {
  try {
    const isTLButton = interaction.customId === 'tl_start_shift_btn';
    const allowMultiHotel = interaction.customId === 'start_shift_multi_confirm_btn' || interaction.customId === 'tl_start_shift_multi_confirm_btn';
    const discordId = interaction.user.id;
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(discordId);
    if (!agent) {
      return interaction.reply({ 
        content: '❌ **Access Denied.** You must be a registered agent. Please use the **Register** button to apply.',
        ephemeral: true
      });
    }

    const role = normalizeAgentRole(agent.role);
    const isTLOrSME = interactionHasRoleAtLeast(interaction, 'sme');

    if (isTLButton && !isTLOrSME) {
      return interaction.reply({ 
        content: `❌ **Access Denied.** This portal is reserved for **Team Leaders** and **Subject Matter Experts**. \n\n*Your current role is:* **${role.charAt(0).toUpperCase() + role.slice(1).replace('_', ' ')}**` ,
        ephemeral: true
      });
    }

    // Check if agent is already on shift
    const activeSession = db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND status = 'active'").get(agent.id);
    if (activeSession && !allowMultiHotel) {
      const multiEmbed = new EmbedBuilder()
        .setTitle('🏨 Multiple Hotels Check')
        .setDescription(
          `You are already logged into **${HOTEL_NAMES[activeSession.hotel_id] || activeSession.hotel_id}**.\n\n` +
          'Are you handling **multiple hotels** right now?'
        )
        .setColor(0xFEE75C);

      const continueBtn = new ButtonBuilder()
        .setCustomId(isTLButton ? 'tl_start_shift_multi_confirm_btn' : 'start_shift_multi_confirm_btn')
        .setLabel('Yes, Continue')
        .setStyle(ButtonStyle.Primary);

      const cancelBtn = new ButtonBuilder()
        .setCustomId('start_shift_multi_cancel_btn')
        .setLabel('No, Cancel')
        .setStyle(ButtonStyle.Secondary);

      return interaction.reply({
        embeds: [multiEmbed],
        components: [new ActionRowBuilder().addComponents(continueBtn, cancelBtn)],
        ephemeral: true
      });
    }

    // TL/SME manual TL button click (Management Portal)
    if (isTLButton) {
       if (!agent.team) {
          return interaction.reply({ 
            content: '⚠️ **Team Assignment Missing.** Please contact a developer to assign your team (Team 1 or Team 2) before logging into management.',
            ephemeral: true
          });
       }
       return await showPinModal(interaction, 'TEAM_SHIFT', false, allowMultiHotel);
    }

    // If the agent has multiple assigned grey hotel roles, let them pick the hotel for this shift.
    const assignedHotelIds = Object.entries(ROLE_NAMES.GREY)
      .filter(([hotelId, roleId]) => HOTEL_NAMES[hotelId] && interaction.member.roles.cache.has(roleId))
      .map(([hotelId]) => hotelId);
    const uniqueAssignedHotelIds = [...new Set(assignedHotelIds)];
    if (uniqueAssignedHotelIds.length > 1) {
      return await showAssignedHotelShiftPicker(interaction, uniqueAssignedHotelIds, allowMultiHotel);
    }


    // Standard Agent route:
    if (agent.hotel_id) {
       if (HOTEL_NAMES[agent.hotel_id]) {
          const hotelSession = db.prepare(
            "SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND agent_id != ? ORDER BY id DESC LIMIT 1"
          ).get(agent.hotel_id, agent.id);

          if (hotelSession) {
            const otherAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(hotelSession.agent_id);
            const promptEmbed = new EmbedBuilder()
              .setTitle('âš ï¸ Overlapping Shift Detected')
              .setDescription(`Agent **${otherAgent?.username || 'Unknown Agent'}** is currently logged into **${HOTEL_NAMES[agent.hotel_id]}**.\n\nAre you sure you want to take over this shift?`)
              .setColor(0xFEE75C);

            const takeOverBtn = new ButtonBuilder()
              .setCustomId(`takeover_btn_${agent.hotel_id}`)
              .setLabel('Yes, Take Over Shift')
              .setStyle(ButtonStyle.Success);

            const cancelBtn = new ButtonBuilder()
              .setCustomId('cancel_takeover_btn')
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary);

            const promptRow = new ActionRowBuilder().addComponents(takeOverBtn, cancelBtn);
            return interaction.reply({ embeds: [promptEmbed], components: [promptRow], ephemeral: true });
          }

          console.log(`[LOCK-IN] ${interaction.user.username} bypassing selection for linked hotel ${agent.hotel_id}`);
          return await showPinModal(interaction, agent.hotel_id, false, allowMultiHotel);
       } else {
          db.prepare("UPDATE agents SET hotel_id = NULL WHERE discord_id = ?").run(interaction.user.id);
       }
    }
    
    // Check if they are already in the system (linked to a team)
    if (!agent.team) {
       const embed = new EmbedBuilder()
         .setTitle('👥 Team Selection')
         .setDescription(
           `### 🎮 WHICH TEAM ARE YOU?\n` +
           `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
           `> Select your **assigned team** to see available hotel locations.\n` +
           `> *First-time setup only. This links your account permanently.*\n` +
           `━━━━━━━━━━━━━━━━━━━━━━━━━━━`
         )
         .setColor(0x5865F2);

       const row = new ActionRowBuilder().addComponents(
         new ButtonBuilder().setCustomId('team_btn_Team 1').setLabel('Team 1').setStyle(ButtonStyle.Primary).setEmoji('🧑‍💼'),
         new ButtonBuilder().setCustomId('team_btn_Team 2').setLabel('Team 2').setStyle(ButtonStyle.Primary).setEmoji('🧑‍💻')
       );

       return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    await showHotelSelection(interaction, agent.team, false);

  } catch (error) {
    console.error('Error in handleStartShiftClick:', error);
    if (error?.code === 10062) {
      console.warn('[START-SHIFT] Interaction expired before response (10062).');
      return;
    }
    try {
      const response = { content: '❌ Something went wrong while initializing your shift.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(response);
      } else {
        await interaction.reply(response);
      }
    } catch(e){}
  }
}

async function showAssignedHotelShiftPicker(interaction, hotelIds, allowMultiHotel = false) {
  const pickMenu = new StringSelectMenuBuilder()
    .setCustomId(allowMultiHotel ? 'shift_hotel_pick_menu_multi' : 'shift_hotel_pick_menu')
    .setPlaceholder('Pick your hotel for this shift')
    .addOptions(
      hotelIds.map(hotelId =>
        new StringSelectMenuOptionBuilder()
          .setLabel(HOTEL_NAMES[hotelId] || hotelId)
          .setValue(hotelId)
          .setDescription('Start shift on this assigned hotel')
      )
    );

  const embed = new EmbedBuilder()
    .setTitle('🏨 Select Hotel For This Shift')
    .setDescription(
      'You have multiple assigned hotel roles.\n' +
      'Choose which hotel you are handling right now.'
    )
    .setColor(0xF1C40F);

  const row = new ActionRowBuilder().addComponents(pickMenu);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed], components: [row] });
  }
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleShiftHotelPickMenu(interaction) {
  try {
    const hotelId = interaction.values[0];
    const allowMultiHotel = interaction.customId === 'shift_hotel_pick_menu_multi';
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: '❌ You are not registered as an agent.', ephemeral: true });
    }

    const hotelSession = db.prepare(
      "SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND agent_id != ? ORDER BY id DESC LIMIT 1"
    ).get(hotelId, agent.id);

    if (hotelSession) {
      const otherAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(hotelSession.agent_id);
      const promptEmbed = new EmbedBuilder()
        .setTitle('⚠️ Overlapping Shift Detected')
        .setDescription(
          `Agent **${otherAgent?.username || 'Unknown Agent'}** is currently logged into **${HOTEL_NAMES[hotelId] || hotelId}**.\n\n` +
          'Are you sure you want to take over this shift?'
        )
        .setColor(0xFEE75C);

      const takeoverId = allowMultiHotel ? `takeover_btn_${hotelId}_multi` : `takeover_btn_${hotelId}`;
      const takeOverBtn = new ButtonBuilder()
        .setCustomId(takeoverId)
        .setLabel('Yes, Take Over Shift')
        .setStyle(ButtonStyle.Success);

      const cancelBtn = new ButtonBuilder()
        .setCustomId('cancel_takeover_btn')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

      return interaction.update({
        embeds: [promptEmbed],
        components: [new ActionRowBuilder().addComponents(takeOverBtn, cancelBtn)]
      });
    }

    await showPinModal(interaction, hotelId, false, allowMultiHotel);
  } catch (error) {
    console.error('Error in handleShiftHotelPickMenu:', error);
    if (error?.code === 10062) {
      console.warn('[SHIFT-PICKER] Interaction expired before response (10062).');
      return;
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to select hotel for shift.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to select hotel for shift.', ephemeral: true }).catch(() => {});
    }
  }
}

// ─── Team Selection Logic ─────────────────────────────
async function handleTeamSelect(interaction) {
  try {
    const discordId = interaction.user.id;
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(discordId);
    
    // SECURITY GUARD: HARD LOCK-IN
    if (agent && agent.hotel_id) {
       console.warn(`[SECURITY] ${interaction.user.username} tried to re-select team while locked into ${agent.hotel_id}`);
       return interaction.reply({ content: '❌ **Access Denied.** Your account is permanently linked to another hotel. Contact a developer to reassign.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const teamName = interaction.customId.replace('team_btn_', '');

    db.prepare('UPDATE agents SET team = ? WHERE discord_id = ?').run(teamName, discordId);
    
    // Assign Team Role (non-blocking to prevent timeout)
    try {
      const role = interaction.guild.roles.cache.find(r => r.name === teamName);
      if (role) {
        interaction.member.roles.add(role).catch(err => console.warn(`[ROLES] Async role add failed: ${err.message}`));
        console.log(`[ROLES] Assigning ${teamName} role to ${interaction.user.username}`);
      }
    } catch (e) {
      console.warn(`[ROLES] Failed to find or assign team role: ${e.message}`);
    }

    // Use true to update the existing ephemeral message
    await showHotelSelection(interaction, teamName, true);
  } catch (error) {
    console.error('Error in handleTeamSelect:', error);
  }
}

// ─── Hotel Selection View (Premium Select Menu) ──────────────────────────
async function showHotelSelection(interaction, teamName, isUpdate = false) {
  const hotels = db.prepare('SELECT * FROM hotels WHERE team = ?').all(teamName);

  const HOTEL_EMOJIS = { 'TO': '🏡', 'BW': '🏙️', 'RV': '🌵', 'S8': '✴️', 'RM': '🛖', 'AD1': '📞' };

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('hotel_select_menu')
    .setPlaceholder('🏨 Choose your hotel assignment...')
    .addOptions(
      hotels.map(hotel =>
        new StringSelectMenuOptionBuilder()
          .setLabel(hotel.name)
          .setValue(hotel.id)
          .setDescription(`Select to permanently link your account to ${hotel.name}`)
          .setEmoji(HOTEL_EMOJIS[hotel.id] || '🏨')
      )
    );

  const embed = new EmbedBuilder()
    .setTitle('🏨 Choose Your Hotel Location')
    .setDescription(
      `### 📍 ASSIGNMENT SELECTION — ${teamName}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `> Use the **dropdown** below to select your hotel.\n\n` +
      `> ⚠️ **Permanent choice.** You cannot switch hotels\n` +
      `> without contacting a Developer or Team Leader.\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    )
    .setColor(0x57F287);

  const payload = { content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else if (isUpdate) {
    await interaction.update(payload);
  } else {
    await interaction.reply(payload);
  }
}

// ─── Hotel Select Buttons (Confirmation Step) ────────
async function handleHotelSelect(interaction) {
  try {
    const hotelId = interaction.customId.replace('hotel_btn_', '');
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: '❌ You are not registered as an agent. Use `/register` to apply.', ephemeral: true });
    }

    const hotelName = HOTEL_NAMES[hotelId] || hotelId;

    const confirmEmbed = new EmbedBuilder()
      .setTitle('🏨 Permanent Hotel Selection')
      .setDescription(`### ⚠️ FINAL CONFIRMATION\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                      `Are you sure you want to select **${hotelName}** as your assigned hotel?\n\n` +
                      `> **NOTICE:** Once selected, you **CANNOT** switch hotels later regardless of channel. You will be permanently locked into this location unless a Developer or Team Leader manually reassigns you.\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                      `*Click below to confirm your permanent assignment.*`)
      .setColor(0xFEE75C);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`confirm_hotel_${hotelId}`)
      .setLabel('Confirm & Link Hotel')
      .setStyle(ButtonStyle.Success);

    const cancelBtn = new ButtonBuilder()
      .setCustomId('cancel_hotel_link')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

    await interaction.update({ embeds: [confirmEmbed], components: [row] });
  } catch (error) {
    console.error('Error in handleHotelSelect:', error);
  }
}

async function showTrainingHotelSelection(interaction, isUpdate = false) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('training_hotel_select_menu')
    .setPlaceholder('Choose the hotel you are training for')
    .addOptions(
      TRAINING_HOTEL_GROUPS.map(group =>
        new StringSelectMenuOptionBuilder()
          .setLabel(group.label)
          .setValue(group.hotelIds[0])
          .setDescription('Start a training session for this location')
      )
    );

  const embed = new EmbedBuilder()
    .setTitle('Training Session Setup')
    .setDescription(
      'Choose the hotel you are training for.\n' +
      'Training sessions are tracked separately from live shifts.'
    )
    .setColor(0x5865F2);

  const payload = { content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else if (isUpdate) {
    await interaction.update(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function handleTrainingStartClick(interaction) {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: '❌ You are not registered as an agent.', ephemeral: true });
    }

    return await showTrainingHotelSelection(interaction);
  } catch (error) {
    console.error('Error in handleTrainingStartClick:', error);
    if (error?.code === 10062) return;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to open the training selector.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to open the training selector.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleTrainingHotelSelectMenu(interaction) {
  try {
    const hotelId = interaction.values[0];
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: '❌ You are not registered as an agent.', ephemeral: true });
    }

    await showPinModal(interaction, hotelId, false, false, 'training');
  } catch (error) {
    console.error('Error in handleTrainingHotelSelectMenu:', error);
    if (error?.code === 10062) return;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to open the training PIN modal.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to open the training PIN modal.', ephemeral: true }).catch(() => {});
    }
  }
}

// ─── Hotel Select Menu Handler (Premium Dropdown) ────────────────────────
async function handleHotelSelectMenu(interaction) {
  try {
    const hotelId = interaction.values[0];
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: '❌ You are not registered as an agent.', ephemeral: true });
    }

    if (agent.hotel_id) {
      return interaction.update({
        content: '🔒 **Hotel Already Linked.** Your account is permanently assigned. Contact a Developer to change it.',
        embeds: [], components: []
      });
    }

    const hotelName = HOTEL_NAMES[hotelId] || hotelId;

    const confirmEmbed = new EmbedBuilder()
      .setTitle('🏨 Confirm Your Hotel Assignment')
      .setDescription(
        `### ⚠️ PERMANENT SELECTION\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `You are about to permanently link your account to:\n` +
        `## 🏨 ${hotelName}\n\n` +
        `> **This cannot be undone.** Once confirmed, you will\n` +
        `> need a **Developer or Team Leader** to change this.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Are you 100% sure this is your correct hotel?*`
      )
      .setColor(0xFEE75C);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`confirm_hotel_${hotelId}`)
      .setLabel('✅ Yes, Link This Hotel')
      .setStyle(ButtonStyle.Success);

    const cancelBtn = new ButtonBuilder()
      .setCustomId('cancel_hotel_link')
      .setLabel('❌ Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);
    await interaction.update({ embeds: [confirmEmbed], components: [row] });
  } catch (error) {
    console.error('Error in handleHotelSelectMenu:', error);
  }
}

// ─── Final Hotel Confirmation & Lock-in ──────────────
async function handleConfirmHotelLink(interaction) {
  try {
    await safeDeferComponentUpdate(interaction);

    const hotelId = interaction.customId.replace('confirm_hotel_', '');
    const discordId = interaction.user.id;
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(discordId);

    if (!agent) {
      return sendComponentReply(interaction, { content: 'Account error. Please contact a developer.', ephemeral: true });
    }

    // [Safety] Check if locked during the confirmation delay
    if (agent.hotel_id && agent.hotel_id !== hotelId) {
       return sendComponentUpdate(interaction, { content: 'Access denied. Your account is already linked to another hotel.', embeds: [], components: [] });
    }

    // Check if another agent is already logged into this hotel
    const hotelSession = db.prepare("SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active'").get(hotelId);
    if (hotelSession && hotelSession.agent_id !== agent.id) {
       const otherAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(hotelSession.agent_id);
       
       const promptEmbed = new EmbedBuilder()
         .setTitle('⚠️ Overlapping Shift Detected')
         .setDescription(`Agent **${otherAgent.username}** is currently logged into **${HOTEL_NAMES[hotelId]}**.\n\nAre you sure you want to take over this shift?`)
         .setColor(0xFEE75C);

       const takeOverBtn = new ButtonBuilder()
         .setCustomId(`takeover_btn_${hotelId}`)
         .setLabel('Yes, Take Over Shift')
         .setStyle(ButtonStyle.Success);
         
       const cancelBtn = new ButtonBuilder()
         .setCustomId(`cancel_takeover_btn`)
         .setLabel('Cancel')
         .setStyle(ButtonStyle.Secondary);
         
       const promptRow = new ActionRowBuilder().addComponents(takeOverBtn, cancelBtn);
       return sendComponentUpdate(interaction, { embeds: [promptEmbed], components: [promptRow] });
    }

    // Permanent Linkage: Save selection to agent profile and assign Grey role
    db.prepare('UPDATE agents SET hotel_id = ? WHERE discord_id = ?').run(hotelId, discordId);
    
    // Sync Grey Role (Ghost role) immediately
    try {
      const greyRoleId = ROLE_NAMES.GREY[hotelId];
      const greyRole = interaction.guild.roles.cache.get(greyRoleId);
      if (greyRole) await interaction.member.roles.add(greyRole);
      console.log(`[ROLES] Permanent Grey role ID (${greyRoleId}) assigned to ${interaction.user.username}`);
    } catch (roleErr) {
       console.warn('[ROLES] Failed to assign initial Grey role:', roleErr.message);
    }

    // Proceed to PIN modal
    const linkedEmbed = new EmbedBuilder()
      .setTitle('✅ Hotel Successfully Linked')
      .setDescription(`### 🏨 ASSIGNMENT COMPLETE\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                      `You have been permanently linked to **${HOTEL_NAMES[hotelId]}**.\n\n` +
                      `> **NEXT STEP:** You are NOT in a shift yet. To check-in, please go to the hotel channel and click **Start Shift** to initialize your login.\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      .setColor(0x57F287);

    await sendComponentUpdate(interaction, { embeds: [linkedEmbed], components: [] });

  } catch (error) {
    console.error('Error in handleConfirmHotelLink:', error);
    if (error?.code === 10062) return;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to confirm hotel link.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to confirm hotel link.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleCancelHotelLink(interaction) {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) return interaction.update({ content: '❌ Registration required.', embeds: [], components: [] });

    // Show team selection again
    if (!agent.team) {
       const embed = new EmbedBuilder()
         .setTitle('👥 Team Selection')
         .setDescription('### 👥 SELECT YOUR TEAM\n' +
                         '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                         '> Pick your assigned team to view available hotels.\n' +
                         '━━━━━━━━━━━━━━━━━━━━━━━━━━━')
         .setColor(0xFEE75C);

       const row = new ActionRowBuilder().addComponents(
         new ButtonBuilder().setCustomId('team_btn_Team 1').setLabel('Team 1').setStyle(ButtonStyle.Primary).setEmoji('👥'),
         new ButtonBuilder().setCustomId('team_btn_Team 2').setLabel('Team 2').setStyle(ButtonStyle.Primary).setEmoji('👥')
       );
       return await interaction.update({ embeds: [embed], components: [row] });
    }

    // Show hotel selection for their team
    await showHotelSelection(interaction, agent.team, true);
  } catch (e) {
    console.error('Error in handleCancelHotelLink:', e);
  }
}

// ─── Shift Takeover Functions ────────────────────────
async function handleCancelTakeover(interaction) {
  try {
    await interaction.deferUpdate();
    const embed = new EmbedBuilder()
      .setTitle('❌ Takeover Cancelled')
      .setDescription('You have cancelled the shift takeover.')
      .setColor(0xED4245);
    await interaction.editReply({ embeds: [embed], components: [] });
  } catch (error) {
    console.error('Error in handleCancelTakeover:', error);
  }
}

async function handleCancelMultiHotelStart(interaction) {
  try {
    await interaction.update({
      content: '✅ No problem. Multi-hotel shift start cancelled.',
      embeds: [],
      components: []
    });
  } catch (error) {
    console.error('Error in handleCancelMultiHotelStart:', error);
  }
}

async function handleTakeoverShift(interaction) {
  try {
    const payload = interaction.customId.replace('takeover_btn_', '');
    const allowMultiHotel = payload.endsWith('_multi');
    const hotelId = allowMultiHotel ? payload.replace('_multi', '') : payload;

    await showPinModal(interaction, hotelId, true, allowMultiHotel);
    
    // Attempt to clear the original buttons (Interaction might be deferred or replied)
    try { 
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ components: [] }); 
      }
    } catch(e){}
  } catch (error) {
    console.error('Error in handleTakeoverShift:', error);
  }
}

// ─── Legacy /login handler ───────────────────────────
async function handleLogin(interaction) {
  await handleStartShiftClick(interaction);
}

async function handleShiftInitModalSubmit(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) {
      return interaction.editReply({ content: '❌ You must be a registered agent before initializing a shift.' });
    }

    const hotelInput = interaction.fields.getTextInputValue('shift_hotel');
    const pin = interaction.fields.getTextInputValue('shift_pin');

    if (agent.pin !== pin) {
      return interaction.editReply({ content: '❌ **Incorrect PIN.** Access denied.' });
    }

    const normalizedHotel = normalizeHotelInput(hotelInput);

    if (!normalizedHotel || !HOTEL_NAMES[normalizedHotel]) {
      return interaction.editReply({ content: '❌ Invalid hotel. Please use one of: **Indianhead/Magnuson, The Garden Inn At Campsite, Super 8, Ramada, AD1**.' });
    }

    const hotelRecord = db.prepare("SELECT team FROM hotels WHERE id = ?").get(normalizedHotel);
    if (!hotelRecord || !TEAM_NAMES.includes(hotelRecord.team)) {
      return interaction.editReply({ content: `❌ **${normalizedHotel}** is not available for live shift initialization.` });
    }

    const normalizedTeam = hotelRecord.team;

    if (agent.team && agent.team !== normalizedTeam) {
      return interaction.editReply({ content: `🔒 Your account is already linked to **${agent.team}**. Contact a developer to change teams.` });
    }

    if (agent.hotel_id && agent.hotel_id !== normalizedHotel) {
      return interaction.editReply({ content: `🔒 Your account is already linked to **${HOTEL_NAMES[agent.hotel_id] || agent.hotel_id}**. Contact a developer to reassign your hotel.` });
    }

    db.prepare("UPDATE agents SET team = COALESCE(team, ?), hotel_id = COALESCE(hotel_id, ?) WHERE discord_id = ?").run(normalizedTeam, normalizedHotel, interaction.user.id);
    const refreshedAgent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);

    try {
      const teamRole = interaction.guild.roles.cache.find(r => r.name === normalizedTeam);
      if (teamRole && !interaction.member.roles.cache.has(teamRole.id)) {
        await interaction.member.roles.add(teamRole);
      }

      const greyRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREY[normalizedHotel]);
      if (greyRole && !interaction.member.roles.cache.has(greyRole.id)) {
        await interaction.member.roles.add(greyRole);
      }
    } catch (roleErr) {
      console.warn('[ROLES] Failed to sync team/assignment roles during shift init:', roleErr.message);
    }

    await finalizeShiftLogin(interaction, refreshedAgent, normalizedHotel, false);
  } catch (error) {
    console.error('Error in handleShiftInitModalSubmit:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Something went wrong while initializing your shift.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply({ content: '❌ Something went wrong while initializing your shift.' }).catch(() => {});
    }
  }
}

// ─── PIN Modal Submit ────────────────────────────────
async function handleModalSubmit(interaction) {
  try {
    // 1. Acknowledge immediately (Modals have a 3s timeout)
    await interaction.deferReply({ ephemeral: true });

    // Route to register submit
    if (interaction.customId === 'register_modal') {
      return handleRegisterSubmit(interaction);
    }

    // The provided diff snippet for command routing is likely from an interactionCreate event handler.
    // To make this file syntactically correct, I'm assuming the user intended to add a command definition
    // to an exported list of commands, and the routing logic to a main event handler.
    // Since this file primarily contains handlers, I'll add the command definition to an export,
    // and assume the routing logic is for an external `interactionCreate` handler.
    // The `if (!interaction.customId.startsWith('loginmodal_')) return;` line is already present
    // and correctly handles non-login modals.

    if (!interaction.customId.startsWith('loginmodal_')) return;

    let modalPayload = interaction.customId.replace('loginmodal_', '');
    let sessionMode = 'shift';
    if (modalPayload.startsWith('training_')) {
      sessionMode = 'training';
      modalPayload = modalPayload.slice(9);
    } else if (modalPayload.startsWith('shift_')) {
      modalPayload = modalPayload.slice(6);
    }
    const allowMultiHotel = modalPayload.endsWith('_multi');
    if (allowMultiHotel) modalPayload = modalPayload.slice(0, -6);
    const isTakeover = modalPayload.endsWith('_takeover');
    const hotelId = isTakeover ? modalPayload.slice(0, -9) : modalPayload;
    const pin = interaction.fields.getTextInputValue('pin_input');
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);

    if (!agent || agent.pin !== pin) {
      return interaction.editReply({ content: '❌ **Incorrect PIN.** Access denied.' });
    }

    await finalizeShiftLogin(interaction, agent, hotelId, isTakeover, allowMultiHotel, sessionMode);
    return;

    // Submission Guard: Block double-submissions within 5 seconds for the same hotel/agent
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const recentSession = db.prepare("SELECT id FROM sessions WHERE agent_id = ? AND hotel_id = ? AND login_time >= ?").get(agent.id, hotelId, fiveSecondsAgo);
    if (recentSession) {
      return interaction.editReply({ content: '⚠️ You just logged in! Please wait a moment for the status to update.' });
    }

    // Close any existing active sessions for this agent using centralized helper
    await closeAllActiveSessionsForAgent(agent.id, interaction.client);

    // Insert new session
    const nowIso = new Date().toISOString();
    db.prepare("INSERT INTO sessions (agent_id, hotel_id, login_time) VALUES (?, ?, ?)").run(agent.id, hotelId, nowIso);

    let noteAlert = '';

    // try role management (non-blocking) - Only for real hotels
    if (hotelId !== 'TEAM_SHIFT') {
      try {
        const member = interaction.member;
        const guild = interaction.guild;
        const onShift = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
        const loggedOut = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
        const greenRoleId = ROLE_NAMES.GREEN[hotelId];
        const greenRole = guild.roles.cache.get(greenRoleId);
        const greyRoleId = ROLE_NAMES.GREY[hotelId];
        const greyRole = guild.roles.cache.get(greyRoleId);

        if (onShift && loggedOut && greenRole) {
          const rolesToAdd = [onShift, greenRole];
          const rolesToRemove = [loggedOut];
          if (greyRole) rolesToRemove.push(greyRole);
          
          await member.roles.add(rolesToAdd);
          await member.roles.remove(rolesToRemove);
          console.log(`[ROLES] Shift roles swapped for ${interaction.user.username}: +Green, -Grey`);
        }
      } catch (roleErr) {
        console.warn('[ROLES] Could not update roles:', roleErr.message);
      }
    }

    // Update persistent embeds
    if (hotelId === 'TEAM_SHIFT') {
       await updateTeamStatusEmbed(interaction.client, agent.team);
       // Immediately refresh all hotel embeds for this team to show "Team Leader on Shift"
       const teamHotels = agent.team === 'Team 1' ? TEAM_1_HOTELS : [];
       for (const hId of teamHotels) {
         updateHotelStatusEmbed(interaction.client, hId).catch(e => console.error(`[SYNC] Failed to update hotel ${hId}:`, e));
       }
    } else {
       updateHotelStatusEmbed(interaction.client, hotelId).catch(e => console.error('Failed to update hotel status embed:', e));
    }

    // Check for Handover Notes (Delivered via DM)
    const unreadNotes = db.prepare(`
      SELECT handover_notes.*, agents.username 
      FROM handover_notes 
      JOIN agents ON handover_notes.agent_id = agents.id 
      WHERE handover_notes.hotel_id = ? AND handover_notes.status = 'unread'
    `).all(hotelId);
    
    if (unreadNotes.length > 0) {
      try {
        const noteEmbed = new EmbedBuilder()
          .setTitle('📝 Pending Handover Notes')
          .setDescription(`You have **${unreadNotes.length}** new handover note(s) for **${HOTEL_NAMES[hotelId]}**:`)
          .setColor(0xFEE75C)
          .setTimestamp();

        unreadNotes.forEach(n => {
          noteEmbed.addFields({ name: `From ${n.username}`, value: `> ${n.content}` });
        });

        await interaction.user.send({ embeds: [noteEmbed] });
        
        // Mark as read
        db.prepare("UPDATE handover_notes SET status = 'read' WHERE hotel_id = ? AND status = 'unread'").run(hotelId);
      } catch (dmErr) {
        console.warn(`[HANDOVER] Could not DM notes to ${interaction.user.username}:`, dmErr.message);
      }
    }

    // Attendance Check: Mark matching pending schedule as 'attended'
    const todayStr = new Date().toISOString().split('T')[0];
    const schedule = db.prepare(`
      SELECT id FROM schedules 
      WHERE agent_id = ? AND hotel_id = ? AND status = 'pending'
      AND date(start_time) = ?
    `).get(agent.id, hotelId, todayStr);

    if (schedule) {
      db.prepare("UPDATE schedules SET status = 'attended' WHERE id = ?").run(schedule.id);
      noteAlert += '\n✅ **Attendance Recorded:** Your shift assignment has been marked as attended.';
    }

    // Send to interaction purely as confirmation
    const hotelName = HOTEL_NAMES[hotelId] || hotelId;
    await interaction.editReply({ 
        content: `✅ **Success!** You are now logged into **${hotelName}**. ${noteAlert}`,
        embeds: [], 
        components: [] 
    });

    // Handle takeover if applicable
    if (isTakeover && hotelId !== 'TEAM_SHIFT') {
       const priorSession = db.prepare("SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND agent_id != ? ORDER BY id DESC LIMIT 1").get(hotelId, agent.id);
       if (priorSession) {
          const priorAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(priorSession.agent_id);
          db.prepare("UPDATE sessions SET logout_time = CURRENT_TIMESTAMP, status = 'closed' WHERE id = ?").run(priorSession.id);
          try {
             const oldMember = await interaction.guild.members.fetch(priorAgent.discord_id);
             if (oldMember) {
                const onShiftRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
                const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
                const greenRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREEN[hotelId]);
                const greyRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREY[hotelId]);

                if (onShiftRole && loggedOutRole && greenRole) {
                   const rolesToRemove = [onShiftRole, greenRole];
                   const rolesToAdd = [loggedOutRole];
                   if (greyRole) rolesToAdd.push(greyRole);

                   await oldMember.roles.remove(rolesToRemove);
                   await oldMember.roles.add(rolesToAdd);
                   console.log(`[TAKEOVER] Roles reverted for ${priorAgent.username}: -Green, +Grey`);
                }
             }
          } catch (e) { console.warn('Could not revert roles for prior agent:', e.message); }
       }
    }

    // Update persistent embeds
    if (hotelId === 'TEAM_SHIFT') {
       await updateTeamStatusEmbed(interaction.client, agent.team);
       // Also refresh all hotels for this team
       const teamHotels = agent.team === 'Team 1' ? TEAM_1_HOTELS : []; 
       for (const hId of teamHotels) {
         updateHotelStatusEmbed(interaction.client, hId).catch(e => console.error(`Failed to update hotel status embed for ${hId}:`, e));
       }
    } else {
       updateHotelStatusEmbed(interaction.client, hotelId).catch(e => console.error('Failed to update hotel status embed:', e));
    }

    console.log(`[LOGIN] ${interaction.user.username} → ${hotelName}`);

  const auditUnix = Math.floor(Date.now() / 1000);
  const nickname = await getAgentDisplayName(interaction.guild, interaction.user.id);
  sendAuditLog(interaction.client, {
    title: sessionMode === 'training' ? '🧭 Agent Training Started' : (hotelId === 'TEAM_SHIFT' ? '🟢 Management Logged In' : '🟢 Agent Logged In'),
    description: sessionMode === 'training'
      ? `**User:** ${nickname} (<@${interaction.user.id}>)\n**Training For:** ${hotelName}\n**Time:** <t:${auditUnix}:F>`
      : `**User:** ${nickname} (<@${interaction.user.id}>)\n**Location:** ${hotelName}\n**Time:** <t:${auditUnix}:F>`,
    color: 0x57F287,
    userId: interaction.user.id,
    guild: interaction.guild
  });

      // Simplified notification (Discord only)

  } catch (error) {
    console.error('Error in handleModalSubmit:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true });
      }
    } catch (e) { /* ignore */ }
  }
}

// ─── Logout (button or /logout) ──────────────────────
async function handleLogout(interaction) {
  try {
    // Ownership check for button clicks
    if (interaction.customId && interaction.customId.startsWith('logout_btn_')) {
      const ownerId = interaction.customId.replace('logout_btn_', '');
      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ You can only end your own shift.', ephemeral: true });
      }
    }

    await interaction.deferReply({ ephemeral: true });

    const agent = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.editReply({ content: 'You are not registered.' });
    }

    // Fetch ALL active sessions for this agent
    const activeSessions = db.prepare("SELECT id, hotel_id, login_time FROM sessions WHERE agent_id = ? AND status = 'active'").all(agent.id);
    if (activeSessions.length === 0) {
      return interaction.editReply({ content: 'You are not currently on any shift.' });
    }

    // Save references BEFORE closing
    const primarySession = activeSessions[0];
    
    // Calculate duration for audit log
    let durationStr = 'Unknown';
    let loginTimeDisplay = 'Unknown';
    if (primarySession.login_time) {
      try {
        const loginTimeStr = primarySession.login_time.includes('T') ? primarySession.login_time : primarySession.login_time.replace(' ', 'T') + 'Z';
        const loginTime = new Date(loginTimeStr).getTime();
        loginTimeDisplay = new Date(loginTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const durationMs = Date.now() - loginTime;
        
        if (!isNaN(durationMs)) {
          const hours = Math.floor(durationMs / (1000 * 60 * 60));
          const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
          durationStr = `${hours}h ${minutes}m`;
        }
      } catch (timeErr) {
        console.warn('[LOGOUT] Time calculation failed:', timeErr.message);
      }
    }
    const logoutTimeDisplay = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isOvertime = durationStr.includes('h') && parseInt(durationStr.split('h')[0]) >= 8;

    // Fetch activities for the summary before closing sessions
    const activities = db.prepare("SELECT type, guest_name FROM activities WHERE session_id = ?").all(primarySession.id);
    const checkins = activities.filter(a => a.type === 'checkin');
    const checkouts = activities.filter(a => a.type === 'checkout');
    const calls = activities.filter(a => a.type === 'call');

    // Close ALL active sessions using centralized helper
    const hotelIdsToSync = await closeAllActiveSessionsForAgent(agent.id, interaction.client);
    
    // Reply early to avoid timeout
    await interaction.editReply({ content: '✅ **Shift ended.** You have been logged out successfully.' });

    // Disconnect from VC if present
    try {
      if (interaction.member.voice.channel) {
        await interaction.member.voice.disconnect('Shift ended');
        console.log(`[LOGOUT] Disconnected ${interaction.user.username} from VC.`);
      }
    } catch (vcErr) {
      console.warn('[LOGOUT] Could not disconnect from VC:', vcErr.message);
    }

    // Role management (non-blocking)
    try {
      const member = interaction.member;
      const guild = interaction.guild;
      const onShift = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
      const loggedOutRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());

      const rolesToRemove = [onShift].filter(Boolean);
      const rolesToAdd = [loggedOutRole].filter(Boolean);

      for (const hId of hotelIdsToSync) {
        // Remove Green role
        const greenRoleId = ROLE_NAMES.GREEN[hId];
        const greenRole = guild.roles.cache.get(greenRoleId);
        if (greenRole) rolesToRemove.push(greenRole);

        // Restore Grey role
        const greyRoleId = ROLE_NAMES.GREY[hId];
        const greyRole = guild.roles.cache.get(greyRoleId);
        if (greyRole) rolesToAdd.push(greyRole);
      }

      if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
      if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);
      console.log(`[ROLES] Shift roles swapped for ${interaction.user.username}: -Green, +Grey`);
    } catch (roleErr) {
      console.warn('[ROLES] Could not revert roles:', roleErr.message);
    }

    // Role management (non-blocking) - done
    // Calculate duration for audit log (Already done above)

    // Audit log
    const hotelNames = hotelIdsToSync.map(h => HOTEL_NAMES[h] || h).join(', ');
    const isManagement = hotelIdsToSync.includes('TEAM_SHIFT');
    const nickname = await getAgentDisplayName(interaction.guild, interaction.user.id);
    
    let summaryDesc = `**Agent:** ${nickname}\n` +
                      `**Shift:** \`${loginTimeDisplay}\` - \`${logoutTimeDisplay}\` (**${durationStr}**)\n` +
                      `**Location:** ${hotelNames}\n` +
                      `${isOvertime ? '**⚠️ OVERTIME:** Yes (8h+)\n' : ''}` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    if (checkins.length > 0) summaryDesc += `### 🛎️ Check-Ins (${checkins.length})\n${checkins.map(c => `> • ${c.guest_name}`).join('\n')}\n\n`;
    if (checkouts.length > 0) summaryDesc += `### 🗝️ Check-Outs (${checkouts.length})\n${checkouts.map(c => `> • ${c.guest_name}`).join('\n')}\n\n`;
    if (calls.length > 0) summaryDesc += `### 📞 Call Logs (${calls.length})\n${calls.map(c => `> • ${c.guest_name}`).join('\n')}\n`;

    // 4. Audit Log Routing
    // Detailed Analytics (Manager eyes only)
    await sendAuditLog(interaction.client, {
      title: isManagement ? '🚨 Management Shift Analytics' : '📊 Agent Shift Analytics',
      description: summaryDesc,
      color: isManagement ? 0xED4245 : 0x3498DB,
      forceManagerLog: true,
      hotelId: isManagement ? 'TEAM_SHIFT' : undefined,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    // Simple Notice (Public Team Log)
    if (hotelIdsToSync.some(id => TEAM_1_HOTELS.includes(id))) {
      await sendAuditLog(interaction.client, {
        title: '🛑 Shift Ended',
        description: `**Agent:** ${nickname}\n**Hotel(s):** ${hotelNames}\n**Duration:** ${durationStr}`,
        color: 0xED4245,
        hotelId: hotelIdsToSync[0], // Routine routing
        userId: interaction.user.id,
        guild: interaction.guild
      });
    }

    // Analytics summary completed

  } catch (error) {
    console.error('Error in handleLogout:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true });
      }
    } catch (e) { /* ignore */ }
  }
}

// ─── /status ─────────────────────────────────────────
async function handleStatus(interaction) {
  try {
    const statuses = {};
    const hotelIds = db.prepare("SELECT id FROM hotels").all();
    
    for (const hotel of hotelIds) {
      const activeSessions = db.prepare(`
        SELECT agents.username 
        FROM sessions 
        JOIN agents ON sessions.agent_id = agents.id 
        WHERE sessions.hotel_id = ? AND sessions.status = 'active'
      `).all(hotel.id);
      
      statuses[hotel.id] = activeSessions.length > 0 ? activeSessions.map(s => s.username).join(', ') : '🔴 Offline';
    }

    const embed = new EmbedBuilder()
      .setTitle('🏨 Hotel Shift Status Overview')
      .setDescription('Current active agents across all locations:')
      .setColor(0x3498DB)
      .setTimestamp();

    for (const [hotelId, status] of Object.entries(statuses)) {
      embed.addFields({ name: HOTEL_NAMES[hotelId] || hotelId, value: status, inline: true });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error in handleStatus:', error);
  }
}

async function handleActivityClick(interaction) {
  try {
    const customId = interaction.customId; // activity_checkin_BW_SF
    let type = '';
    if (customId.startsWith('activity_checkin_')) type = 'checkin';
    else if (customId.startsWith('activity_checkout_')) type = 'checkout';
    else if (customId.startsWith('activity_call_')) type = 'call';
    else if (customId.startsWith('activity_maintenance_')) type = 'maintenance';
    else if (customId.startsWith('activity_handover_')) type = 'handover';

    const hotelId = customId.replace(`activity_${type}_`, '');

    if (hotelId === 'AD1' && ['checkin', 'checkout', 'maintenance'].includes(type)) {
      return interaction.reply({
        content: 'This location is calls-only. Use Call Log (or Handover) activities for AD1.',
        ephemeral: true
      });
    }

    if (type === 'checkin') {
      const modal = new ModalBuilder().setCustomId(`activity_modal_checkin_${hotelId}`).setTitle('🛎️ Guest Check-In');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('guest_name_room').setLabel('Guest Name & Room #').setStyle(TextInputStyle.Short).setPlaceholder('John Doe - 101').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prepaid_walkin').setLabel('Prepaid? (Y/N) | Walk-in? (Y/N)').setStyle(TextInputStyle.Short).setPlaceholder('Y | N').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('times').setLabel('Estimated Presence (In - Out)').setStyle(TextInputStyle.Short).setPlaceholder('3PM - 10AM').setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('payment').setLabel('Payment (Cash/Credit)').setStyle(TextInputStyle.Short).setPlaceholder('Credit Card').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('Additional Notes').setStyle(TextInputStyle.Paragraph).setRequired(false))
      );
      await interaction.showModal(modal);
    } else if (type === 'checkout') {
      const modal = new ModalBuilder().setCustomId(`activity_modal_checkout_${hotelId}`).setTitle('🗝️ Guest Check-Out');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('guest_name_room').setLabel('Guest Name & Room #').setStyle(TextInputStyle.Short).setPlaceholder('John Doe - 101').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Check-Out Time').setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('Description/Notes').setStyle(TextInputStyle.Paragraph).setRequired(false))
      );
      await interaction.showModal(modal);
    } else if (type === 'call') {
      const modal = new ModalBuilder().setCustomId(`activity_modal_call_${hotelId}`).setTitle('📞 Call Log');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('guest_info').setLabel('Guest Info / Room #').setStyle(TextInputStyle.Short).setPlaceholder('Jane Doe - 202').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('call_type').setLabel('Inbound or Outbound?').setStyle(TextInputStyle.Short).setPlaceholder('Inbound').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Call Interval (Start - End)').setStyle(TextInputStyle.Short).setPlaceholder('5:00 PM - 5:10 PM').setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Call Description').setStyle(TextInputStyle.Paragraph).setRequired(true))
      );
      await interaction.showModal(modal);
    } else if (type === 'maintenance') {
      const modal = new ModalBuilder().setCustomId(`activity_modal_maintenance_${hotelId}`).setTitle('🛠️ Report Maintenance Issue');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('room_number').setLabel('Room Number').setStyle(TextInputStyle.Short).setPlaceholder('302').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Category (AC, Plumbing, etc.)').setStyle(TextInputStyle.Short).setPlaceholder('AC').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description of Issue').setStyle(TextInputStyle.Paragraph).setRequired(true))
      );
      await interaction.showModal(modal);
    } else if (type === 'handover') {
      const modal = new ModalBuilder().setCustomId(`activity_modal_handover_${hotelId}`).setTitle('📝 Shift Handover Note');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Message for next Agent').setStyle(TextInputStyle.Paragraph).setPlaceholder('Room 201 needs towels, guest in 105 is grumpy.').setRequired(true))
      );
      await interaction.showModal(modal);
    }
  } catch (err) {
    console.error('[ACTIVITY] Error handling click:', err);
  }
}

async function handleActivityModalSubmit(interaction) {
  try {
    const customId = interaction.customId; // activity_modal_checkin_BW_SF
    let type = '';
    if (customId.startsWith('activity_modal_checkin_')) type = 'checkin';
    else if (customId.startsWith('activity_modal_checkout_')) type = 'checkout';
    else if (customId.startsWith('activity_modal_call_')) type = 'call';
    else if (customId.startsWith('activity_modal_maintenance_')) type = 'maintenance';
    else if (customId.startsWith('activity_modal_handover_')) type = 'handover';

    const hotelId = customId.replace(`activity_modal_${type}_`, '');

    await interaction.deferReply({ ephemeral: true });

    const agent = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.editReply({ content: '❌ Error: You are not registered as an agent.' });
    }

    // Lookup session: Try specific hotel first, then fall back to TEAM_SHIFT (Management)
    let session = db.prepare("SELECT id FROM sessions WHERE agent_id = ? AND hotel_id = ? AND status = 'active'").get(agent.id, hotelId);
    if (!session) {
      session = db.prepare("SELECT id FROM sessions WHERE agent_id = ? AND hotel_id = 'TEAM_SHIFT' AND status = 'active'").get(agent.id);
    }

    if (!session) {
      return interaction.editReply({ content: '❌ Error: No active shift found. Please log in before performing operational tasks.' });
    }

    let guest_name = '';
    let details = {};

    if (type === 'checkin') {
      guest_name = interaction.fields.getTextInputValue('guest_name_room');
      details = {
        prepaid_walkin: interaction.fields.getTextInputValue('prepaid_walkin'),
        times: interaction.fields.getTextInputValue('times'),
        payment: interaction.fields.getTextInputValue('payment'),
        notes: interaction.fields.getTextInputValue('notes')
      };
    } else if (type === 'checkout') {
      guest_name = interaction.fields.getTextInputValue('guest_name_room');
      details = {
        time: interaction.fields.getTextInputValue('time'),
        notes: interaction.fields.getTextInputValue('notes')
      };
    } else if (type === 'call') {
      guest_name = interaction.fields.getTextInputValue('guest_info');
      details = {
        call_type: interaction.fields.getTextInputValue('call_type'),
        duration: interaction.fields.getTextInputValue('duration'),
        description: interaction.fields.getTextInputValue('description')
      };
    }

    if (type === 'maintenance') {
      const room = interaction.fields.getTextInputValue('room_number');
      const cat = interaction.fields.getTextInputValue('category');
      const desc = interaction.fields.getTextInputValue('description');
      
      db.prepare("INSERT INTO maintenance_logs (hotel_id, agent_id, room_number, category, description) VALUES (?, ?, ?, ?, ?)").run(
        hotelId, agent.id, room, cat, desc
      );

      const hotelName = HOTEL_NAMES[hotelId] || hotelId;
      const nickname = await getAgentDisplayName(interaction.guild, interaction.user.id);

      await sendShiftActivityLog(interaction.client, {
        title: 'Maintenance Reported',
        description: `**Agent:** ${nickname}\n**Hotel:** ${hotelName}`,
        color: 0xE67E22,
        activityType: 'maintenance',
        agentName: nickname,
        hotelName,
        fields: [
          { name: 'Room', value: room, inline: true },
          { name: 'Category', value: cat, inline: true },
          { name: 'Issue', value: desc.slice(0, 1024), inline: false }
        ]
      });

      return await interaction.editReply({ content: `Success: **Maintenance issue** reported for Room **${room}**.` });
      
      await sendAuditLog(interaction.client, { 
        title: '🛠️ Maintenance Reported', 
        description: `**Agent:** ${nickname}\n**Hotel:** ${hotelName}\n**Room:** ${room}\n**Category:** ${cat}\n**Issue:** ${desc}`, 
        color: 0xE67E22,
        forceManagerLog: true, 
        userId: interaction.user.id,
        guild: interaction.guild
      });

      return await interaction.editReply({ content: `Success: **Maintenance issue** reported for Room **${room}**.` });
    }

    if (type === 'handover') {
      const content = interaction.fields.getTextInputValue('content');
      
      db.prepare("INSERT INTO handover_notes (hotel_id, agent_id, content) VALUES (?, ?, ?)").run(
        hotelId, agent.id, content
      );

      const hotelName = HOTEL_NAMES[hotelId] || hotelId;
      const nickname = await getAgentDisplayName(interaction.guild, interaction.user.id);

      await sendShiftActivityLog(interaction.client, {
        title: 'Handover Note Left',
        description: `**Agent:** ${nickname}\n**Hotel:** ${hotelName}`,
        color: 0x9B59B6,
        activityType: 'handover',
        agentName: nickname,
        hotelName,
        fields: [
          { name: 'Note', value: content.slice(0, 1024), inline: false }
        ]
      });

      return await interaction.editReply({ content: 'Success: **Handover note** saved for the next agent.' });

      await sendAuditLog(interaction.client, { 
        title: '📝 Handover Note Left', 
        description: `**Agent:** ${nickname}\n**Hotel:** ${hotelName}\n**Note:** ${content}`, 
        color: 0x9B59B6,
        userId: interaction.user.id,
        guild: interaction.guild
      });

      return await interaction.editReply({ content: 'Success: **Handover note** saved for the next agent.' });
    }

    db.prepare("INSERT INTO activities (session_id, type, guest_name, details) VALUES (?, ?, ?, ?)").run(
      session.id, type, guest_name, JSON.stringify(details)
    );

    const hotelName = HOTEL_NAMES[hotelId] || hotelId;
    const nickname = await getAgentDisplayName(interaction.guild, interaction.user.id);
    const activityTitleMap = {
      checkin: 'Check-In Logged',
      checkout: 'Check-Out Logged',
      call: 'Call Log Recorded'
    };
    const detailFields = Object.entries(details)
      .filter(([, value]) => String(value || '').trim().length > 0)
      .map(([key, value]) => ({
        name: key.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
        value: String(value).slice(0, 1024),
        inline: false
      }));

    await sendShiftActivityLog(interaction.client, {
      title: activityTitleMap[type] || 'Operation Logged',
      description: `**Agent:** ${nickname}\n**Hotel:** ${hotelName}\n**Guest:** ${guest_name}`,
      color: type === 'checkin' ? 0x57F287 : (type === 'checkout' ? 0xED4245 : 0x3498DB),
      activityType: type,
      agentName: nickname,
      hotelName,
      guestName: guest_name,
      fields: detailFields
    });

    return await interaction.editReply({ content: `Success: **${type.toUpperCase()}** logged successfully for **${guest_name}**.` });

    const auditInfo = `**Agent:** ${nickname}\n**Hotel:** ${hotelName}\n**Type:** ${type.toUpperCase()}\n**Guest:** ${guest_name}`;
    
    await sendAuditLog(interaction.client, { 
      title: '📈 Operation Logged', 
      description: auditInfo, 
      color: type === 'checkin' ? 0x57F287 : (type === 'checkout' ? 0xED4245 : 0x3498DB),
      forceManagerLog: true, 
      userId: interaction.user.id,
      guild: interaction.guild
    });

    await interaction.editReply({ content: `✅ **${type.toUpperCase()}** logged successfully for **${guest_name}**.` });
  } catch (error) {
    console.error('Error in handleActivityModalSubmit:', error);
    if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred while saving your activity.', ephemeral: true });
    } else {
        await interaction.editReply({ content: '❌ An error occurred while saving your activity.' });
    }
  }
}

// ─── Remove Agent ────────────────────────────────────
async function handleRemoveAgent(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.customId.split('_')[2];

    let messageDeleted = false;
    const agent = db.prepare("SELECT id, approval_message_id, team FROM agents WHERE discord_id = ?").get(userId);

    if (agent) {
      db.transaction(() => {
        db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
                db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
        db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
      })();

      if (agent.approval_message_id) {
        try {
          if (interaction.message && interaction.message.id === agent.approval_message_id) {
             await interaction.message.delete();
             messageDeleted = true;
          } else {
             const approvalChannel = await interaction.client.channels.fetch(APPROVAL_CHANNEL_ID);
             if (approvalChannel) {
                const msg = await approvalChannel.messages.fetch(agent.approval_message_id);
                if (msg) await msg.delete();
                messageDeleted = true;
             }
          }
        } catch (e) { console.warn('[REMOVE] Could not delete approval message:', e.message); }
      }
    }

    db.prepare("DELETE FROM agents WHERE discord_id = ?").run(userId);

    try {
      const guild = interaction.guild;
      const member = await guild.members.fetch(userId);
      const agentsRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase());
      const loggedOutRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
      const onShiftRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
      const rolesToRemove = [agentsRole, loggedOutRole, onShiftRole].filter(Boolean);
      
      // Add team role if exists
      if (agent && agent.team) {
        const teamRole = guild.roles.cache.find(r => r.name.toLowerCase() === agent.team.toLowerCase());
        if (teamRole) rolesToRemove.push(teamRole);
      }

      const allHotelRoleIds = [...Object.values(ROLE_NAMES.GREEN), ...Object.values(ROLE_NAMES.GREY)];
      
      allHotelRoleIds.forEach(roleId => {
        const hr = guild.roles.cache.get(roleId);
        if (hr) rolesToRemove.push(hr);
      });
      if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
      console.log(`[REMOVE] Removed agent roles from ${member.user.username}`);
    } catch (roleErr) {
      console.warn('[REMOVE] Could not remove roles:', roleErr.message);
    }

    if (!messageDeleted && interaction.message) {
      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0xED4245)
        .setFooter({ text: `🗑️ Agent removed by ${interaction.user.username}` });

      await interaction.message.edit({ embeds: [embed], components: [] }).catch(() => {});
    }

    await interaction.editReply({ content: '✅ Agent successfully removed and directory card deleted.' });

    sendAuditLog(interaction.client, {
      title: '🗑️ Agent Removed',
      description: `**Agent:** <@${userId}> removed by **{{AGENT_NAME}}**`,
      color: 0xED4245,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleRemoveAgent:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
      }
    } catch (e) { /* ignore */ }
  }
}

// ─── /add-agent (Admin) ───
async function handleAddAgent(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const role = normalizeAgentRole(interaction.options.getString('role') || 'agent');
    const tempPin = String(Math.floor(100000 + Math.random() * 900000));

    const isDev = isDeveloper(interaction);

    if (role !== 'agent' && !isDev) {
      return interaction.editReply({ content: '❌ **Access Denied.** Only Developers can assign **SME**, **Team Leader**, or **Operations Manager** roles.' });
    }

    const existing = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (existing) {
      await applyAgentPromotion(interaction, targetUser, tempPin, role, 'ADD-AGENT');
      return interaction.editReply({ content: `✅ **${targetUser.username}** role updated to **${role}**.` });
    }

    await applyAgentPromotion(interaction, targetUser, tempPin, role, 'ADD-AGENT');

    await interaction.editReply({ content: `✅ **${targetUser.username}** has been added as **${role}**.` });

    sendAuditLog(interaction.client, {
      title: 'Agent Added',
      description: `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n**Role:** ${role}\n**Added by:** {{AGENT_NAME}}`,
      color: 0x57F287,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleAddAgent:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Something went wrong.' }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleRemoveAgentCommand(interaction) {
  try {
    const targetUser = interaction.options.getUser('user');

    const agent = db.prepare("SELECT id, approval_message_id, team FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) {
      return interaction.reply({ content: `**${targetUser.username}** is not a registered agent.`, ephemeral: true });
    }

    db.transaction(() => {
      db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
              db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
        db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM agents WHERE discord_id = ?").run(targetUser.id);
    })();

    if (agent.approval_message_id) {
      try {
        const approvalChannel = await interaction.client.channels.fetch(APPROVAL_CHANNEL_ID);
        if (approvalChannel) {
          const msg = await approvalChannel.messages.fetch(agent.approval_message_id);
          if (msg) await msg.delete();
        }
      } catch (e) { console.warn('[REMOVE-AGENT] Could not delete approval message:', e.message); }
    }

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);
      const rolesToRemove = [];
      const allHotelRoles = [...Object.values(ROLE_NAMES.GREEN), ...Object.values(ROLE_NAMES.GREY)];
      const namesToPurge = [ROLE_NAMES.AGENTS, ROLE_NAMES.LOGGED_OUT, ROLE_NAMES.ON_SHIFT, ...allHotelRoles];
      
      namesToPurge.forEach(name => {
        const r = interaction.guild.roles.cache.find(role => role.name.toLowerCase() === name.toLowerCase());
        if (r) rolesToRemove.push(r);
      });
      
      // Remove team role
      if (agent && agent.team) {
        const teamRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === agent.team.toLowerCase());
        if (teamRole) rolesToRemove.push(teamRole);
      }

      if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
    } catch (roleErr) {
      console.warn('[REMOVE-AGENT] Could not remove roles:', roleErr.message);
    }

    await interaction.reply({ content: `**${targetUser.username}** has been removed as an agent.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: 'Agent Removed',
      description: `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n**Removed by:** {{AGENT_NAME}}`,
      color: 0xED4245,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleRemoveAgentCommand:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
      }
    } catch (e) { /* ignore */ }
  }
}

// ─── /check-hours ────────────────────────────────────
async function handleCheckHours(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const isSelfCheck = targetUser.id === interaction.user.id;
    
    const { PermissionFlagsBits } = require('discord.js');
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isSelfCheck && !isAdmin) {
      return interaction.editReply({ content: '❌ You only have permission to check your own hours. Managers can check others.' });
    }

    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) {
      return interaction.editReply({ content: `**${targetUser.username}** is not a registered agent.` });
    }

    const sessions = db.prepare("SELECT * FROM sessions WHERE agent_id = ?").all(agent.id);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    let msToday = 0;
    let msWeek = 0;
    let msMonth = 0;
    let msTotal = 0;

    for (const session of sessions) {
      let lTime = session.login_time;
      if (lTime && !lTime.includes('T') && !lTime.includes('Z')) {
        lTime = lTime.replace(' ', 'T') + 'Z';
      }
      const loginTime = new Date(lTime || Date.now()).getTime();

      let loTime = session.logout_time;
      if (loTime && !loTime.includes('T') && !loTime.includes('Z')) {
        loTime = loTime.replace(' ', 'T') + 'Z';
      }
      const logoutTime = loTime ? new Date(loTime).getTime() : Date.now();
      
      const duration = logoutTime - loginTime;

      msTotal += duration;
      if (loginTime >= startOfToday) msToday += duration;
      if (loginTime >= startOfWeek) msWeek += duration;
      if (loginTime >= startOfMonth) msMonth += duration;
    }

    const nickname = await getAgentDisplayName(interaction.guild, targetUser.id);
    const embed = new EmbedBuilder()
      .setTitle('⏱️ Agent Hours Tracker')
      .setDescription(`**Agent:** ${nickname} (<@${targetUser.id}>)\n\n**⏱️ Activity Breakdown:**\n> **Today:** \`${fmt(msToday)} hrs\`\n> **This Week:** \`${fmt(msWeek)} hrs\`\n> **This Month:** \`${fmt(msMonth)} hrs\`\n\n**Total All-Time:** \`${fmt(msTotal)} hrs\``)
      .setColor(0x0099FF)
      .setFooter({ text: '🔒 Confidential: Only visible to you.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error in handleCheckHours:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
      }
    } catch (e) { /* ignore */ }
  }
}

// ─── /clear-hours (Admin) ─────────────────────────────
async function handleClearHours(interaction) {
  try {
    const targetUser = interaction.options.getUser('user');
    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(targetUser.id);

    if (!agent) {
      return interaction.reply({ content: `**${targetUser.username}** is not a registered agent.`, ephemeral: true });
    }

    const result =         db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
        db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);

    await interaction.reply({ content: `✅ Successfully cleared all **${result.changes}** sessions for **${targetUser.username}**.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: '🗑️ Hours Cleared',
      description: `**Admin:** {{AGENT_NAME}} (<@${interaction.user.id}>)\n**Target:** ${targetUser.username} (<@${targetUser.id}>)\n**Action:** All sessions deleted from database.`,
      color: 0xED4245,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleClearHours:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Something went wrong while clearing hours.', ephemeral: true });
    }
  }
}

// ─── Purge Messages ──────────────────────────────────────
async function handlePurge(interaction) {
  try {
    const { PermissionFlagsBits } = require('discord.js');
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ You must be an Administrator to use this command.', ephemeral: true });
    }

    const amount = interaction.options.getInteger('amount');
    
    await interaction.deferReply({ ephemeral: true });
    
    const messages = await interaction.channel.bulkDelete(amount, true);
    
    await interaction.editReply({ content: `✅ Successfully deleted **${messages.size}** messages from this channel.` });
    
    sendAuditLog(interaction.client, {
      title: '🧹 Channel Purged',
      description: `**Admin:** {{AGENT_NAME}} (<@${interaction.user.id}>)\n**Channel:** <#${interaction.channel.id}>\n**Messages Deleted:** ${messages.size}`,
      color: 0xED4245,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handlePurge:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to purge messages. Note: Discord cannot bulk delete messages older than 14 days.', ephemeral: true });
      } else {
        await interaction.editReply({ content: '❌ Failed to purge messages. Note: Discord cannot bulk delete messages older than 14 days.' });
      }
    } catch (e) { /* ignore */ }
  }
}

// ─── Reset Team Logic ─────────────────────────────────
async function handleResetTeam(interaction) {
  try {
    const discordId = interaction.user.id;
    const agent = db.prepare('SELECT team FROM agents WHERE discord_id = ?').get(discordId);

    if (!agent) {
      return interaction.reply({ content: '❌ You must be registered to reset your team.', ephemeral: true });
    }

    if (!agent.team) {
      return interaction.reply({ content: '⚠️ You don\'t have a team assigned yet.', ephemeral: true });
    }

    // Remove old team role (if possible)
    try {
      const oldRole = interaction.guild.roles.cache.find(r => r.name === agent.team);
      if (oldRole) await interaction.member.roles.remove(oldRole);
    } catch (e) {}

    // Clear in DB
    db.prepare('UPDATE agents SET team = NULL WHERE discord_id = ?').run(discordId);

    await interaction.reply({ content: '🔄 **Success!** Your team assignment has been cleared. Click **Initialize Shift** again to choose a new team.', ephemeral: true });

  } catch (error) {
    console.error('Error in handleResetTeam:', error);
  }
}

// ─── Developer Check ─────────────────────────────
function isDeveloper(interaction) {
  const discordId = interaction.user.id;
  // Hardcoded backup for initial setup
  const devIds = ['320128931971727360', '1186978205018632242'];
  if (devIds.includes(discordId)) return true;

  // Operations Manager has full developer-equivalent access.
  const opsManager = db.prepare("SELECT discord_id FROM agents WHERE discord_id = ? AND role = 'operations_manager'").get(discordId);
  if (opsManager) return true;

  // Check database
  const dev = db.prepare("SELECT discord_id FROM developers WHERE discord_id = ?").get(discordId);
  return !!dev;
}

function interactionHasRoleAtLeast(interaction, minimumRole, { allowDeveloper = true } = {}) {
  if (allowDeveloper && isDeveloper(interaction)) return true;
  return hasAgentRoleAtLeast(getAgentRoleByDiscordId(interaction.user.id), minimumRole);
}

async function handleDbAddDeveloper(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Only existing Developers can propose new developers.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const existing = db.prepare("SELECT * FROM developers WHERE discord_id = ?").get(targetUser.id);
    if (existing) {
      return interaction.reply({ content: `⚠️ **${targetUser.username}** is already a developer.`, ephemeral: true });
    }

    const currentDevs = db.prepare("SELECT discord_id FROM developers").all();
    const currentDevIds = currentDevs.map(d => d.discord_id);

    // Create unique approval record
    db.prepare("INSERT OR REPLACE INTO dev_approvals (target_id, proposed_by, approvals) VALUES (?, ?, '[]')").run(targetUser.id, interaction.user.id);

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Developer Promotion Request')
      .setDescription(
        `**Candidate:** ${targetUser.username} (<@${targetUser.id}>)\n` +
        `**Proposed By:** ${interaction.user.username} (<@${interaction.user.id}>)\n\n` +
        `**Requirement:** All existing developers must approve this promotion.\n` +
        `**Approvals:** 0 / ${currentDevIds.length}`
      )
      .setColor(0xFFA500)
      .setTimestamp();

    const approveBtn = new ButtonBuilder()
      .setCustomId(`dev_approve_${targetUser.id}`)
      .setLabel('✅ Approve')
      .setStyle(ButtonStyle.Success);

    const denyBtn = new ButtonBuilder()
      .setCustomId(`dev_deny_${targetUser.id}`)
      .setLabel('❌ Deny')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    await interaction.reply({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error('Error in handleDbAddDeveloper:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to create developer approval request.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to create developer approval request.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleDevApprove(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
    }

    const targetId = interaction.customId.replace('dev_approve_', '');
    const entry = db.prepare("SELECT * FROM dev_approvals WHERE target_id = ?").get(targetId);
    if (!entry) return interaction.reply({ content: '❌ This request no longer exists.', ephemeral: true });

    let approvals = JSON.parse(entry.approvals);
    if (approvals.includes(interaction.user.id)) {
      return interaction.reply({ content: '⚠️ You have already approved this request.', ephemeral: true });
    }

    approvals.push(interaction.user.id);
    db.prepare("UPDATE dev_approvals SET approvals = ? WHERE target_id = ?").run(JSON.stringify(approvals), targetId);

    const currentDevs = db.prepare("SELECT discord_id FROM developers").all();
    const isUnanimous = currentDevs.every(d => approvals.includes(d.discord_id));

    if (isUnanimous) {
      db.prepare("INSERT OR IGNORE INTO developers (discord_id, username) VALUES (?, ?)").run(targetId, 'New Developer');
      db.prepare("DELETE FROM dev_approvals WHERE target_id = ?").run(targetId);

      const successEmbed = new EmbedBuilder()
        .setTitle('🛡️ New Developer Confirmed')
        .setDescription(`**Unanimous Approval Reached.** <@${targetId}> has been promoted to the Developer team.`)
        .setColor(0x57F287);
      
      await interaction.update({ embeds: [successEmbed], components: [] });
    } else {
      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setDescription(
          interaction.message.embeds[0].description.split('\n\n')[0] + '\n\n' +
          `**Requirement:** All existing developers must approve this promotion.\n` +
          `**Approvals:** ${approvals.length} / ${currentDevs.length}`
        );
      await interaction.update({ embeds: [embed] });
    }
  } catch (e) { console.error(e); }
}

async function handleDevDeny(interaction) {
  try {
    if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
    const targetId = interaction.customId.replace('dev_deny_', '');
    db.prepare("DELETE FROM dev_approvals WHERE target_id = ?").run(targetId);
    
    const embed = new EmbedBuilder()
      .setTitle('❌ Request Denied')
      .setDescription(`The promotion request for <@${targetId}> was denied by ${interaction.user.username}.`)
      .setColor(0xED4245);
    
    await interaction.update({ embeds: [embed], components: [] });
  } catch (e) { console.error(e); }
}

async function handleDbSetPhone(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const phone = interaction.options.getString('phone');

    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) {
      return interaction.reply({ content: `❌ **${targetUser.username}** is not a registered agent.`, ephemeral: true });
    }

    db.prepare("UPDATE agents SET phone = ? WHERE discord_id = ?").run(phone, targetUser.id);

    await interaction.reply({ content: `✅ Updated phone for **${targetUser.username}** to \`${phone}\`.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: '📱 Phone Number Updated',
      description: `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n**New Phone:** \`${phone}\`\n**Admin:** {{AGENT_NAME}}`,
      color: 0x57F287,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (e) {
    console.error('Error in handleDbSetPhone:', e);
    await interaction.reply({ content: '❌ Error updating phone number.', ephemeral: true });
  }
}

async function handleDbLogCheckin(interaction) {
  try {
    const guestName = interaction.options.getString('guest');
    const agentName = interaction.user.username;
    
    // Discord Portal Notification
    const channel = await interaction.client.channels.fetch(TL_PORTAL_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle('🛎️ Guest Check-in Logged')
        .setDescription(`**Guest:** ${guestName}\n**Handled by:** ${agentName} (<@${interaction.user.id}>)`)
        .setColor(0x3498DB)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }

    await interaction.reply({ 
      content: `✅ Check-in for **${guestName}** logged to portal.`, 
      ephemeral: true 
    });

  } catch (e) {
    console.error('Error in handleDbLogCheckin:', e);
    await interaction.reply({ content: '❌ Error logging check-in.', ephemeral: true });
  }
}

async function handleDbDeleteAgent(interaction) {
  if (!isDeveloper(interaction)) {
    return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  }
  try {
    const targetUser = interaction.options.getUser('user');
    const discordId = targetUser.id;
    await interaction.deferReply({ ephemeral: true });
    
    // Get agent internal ID first for session cleanup
    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(discordId);
    
    db.transaction(() => {
      if (agent) {
                db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
        db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
      }
      db.prepare("DELETE FROM agents WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(discordId);
    })();

    await interaction.reply({ content: `✅ Thoroughly deleted agent record(s) and sessions for **${targetUser.username}** (\`${discordId}\`).`, ephemeral: true });
  } catch (error) {
    console.error('Error in handleDbDeleteAgent:', error);
    await interaction.reply({ content: '❌ Error: ' + error.message, ephemeral: true });
  }
}

async function handleDbClearPending(interaction) {
  if (!isDeveloper(interaction)) {
    return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  }
  try {
    const result = db.prepare("DELETE FROM pending_registrations").run();
    await interaction.reply({ content: `✅ Cleared **${result.changes}** pending registration(s).`, ephemeral: true });
  } catch (error) {
    console.error('Error in handleDbClearPending:', error);
    await interaction.reply({ content: '❌ Error: ' + error.message, ephemeral: true });
  }
}

async function handleDbQuery(interaction) {
  if (!isDeveloper(interaction)) {
    return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  }
  try {
    const sql = interaction.options.getString('sql');
    const statement = db.prepare(sql);
    let result;
    if (sql.toLowerCase().startsWith('select')) {
      result = statement.all();
      const output = JSON.stringify(result, null, 2).substring(0, 1900);
      await interaction.reply({ content: `\`\`\`json\n${output}\n\`\`\``, ephemeral: true });
    } else {
      result = statement.run();
      await interaction.reply({ content: `✅ Success: **${result.changes}** rows changed.`, ephemeral: true });
    }
  } catch (error) {
    console.error('Error in handleDbQuery:', error);
    await interaction.reply({ content: '❌ SQL Error: ' + error.message, ephemeral: true });
  }
}

async function handlePromoteTL(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  try {
    const targetUser = interaction.options.getUser('user');
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) return interaction.reply({ content: `❌ **${targetUser.username}** is not a registered agent.`, ephemeral: true });

    db.prepare("UPDATE agents SET role = 'team_leader' WHERE discord_id = ?").run(targetUser.id);
    
    // Role Sync
    try {
      const member = await interaction.guild.members.fetch(targetUser.id);
      const tlRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'team leader');
      if (tlRole) await member.roles.add(tlRole);
    } catch (e) { console.warn('[PROMOTE] Role sync failed:', e.message); }

    await interaction.reply({ content: `🛡️ **${targetUser.username}** has been promoted to **Team Leader**. Role synced in Discord.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: '🛡️ Management Promotion',
      description: `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n**New Role:** Team Leader\n**Admin:** {{AGENT_NAME}}`,
      color: 0x57F287,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (e) {
    console.error('Error in handlePromoteTL:', e);
    await interaction.reply({ content: '❌ Error during promotion.', ephemeral: true });
  }
}

async function handlePromoteSME(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  try {
    const targetUser = interaction.options.getUser('user');
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) return interaction.reply({ content: `❌ **${targetUser.username}** is not a registered agent.`, ephemeral: true });

    db.prepare("UPDATE agents SET role = 'sme' WHERE discord_id = ?").run(targetUser.id);

    // Role Sync
    try {
      const member = await interaction.guild.members.fetch(targetUser.id);
      const smeRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'subject matter expert');
      if (smeRole) await member.roles.add(smeRole);
    } catch (e) { console.warn('[PROMOTE] Role sync failed:', e.message); }

    await interaction.reply({ content: `🧠 **${targetUser.username}** has been promoted to **Subject Matter Expert (SME)**. Role synced in Discord.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: '🧠 Management Promotion',
      description: `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n**New Role:** SME\n**Admin:** {{AGENT_NAME}}`,
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (e) {
    console.error('Error in handlePromoteSME:', e);
    await interaction.reply({ content: '❌ Error during promotion.', ephemeral: true });
  }
}


async function handleSetOperationManager(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: 'Access Denied: Developer Only.', ephemeral: true });
  try {
    const targetUser = interaction.options.getUser('user');
    const existingAgent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);

    if (!existingAgent) {
      const generatedPin = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare("INSERT INTO agents (discord_id, username, pin, role, agent_status) VALUES (?, ?, ?, 'operations_manager', 'ready')").run(
        targetUser.id,
        targetUser.username,
        generatedPin
      );
    } else {
      db.prepare("UPDATE agents SET role = 'operations_manager' WHERE discord_id = ?").run(targetUser.id);
    }

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);
      const agentsRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase());
      const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
      const managerRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'operations manager');

      const rolesToAdd = [agentsRole, loggedOutRole, managerRole].filter(Boolean);
      if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);
    } catch (e) { console.warn('[PROMOTE] Operations Manager Discord role sync failed:', e.message); }

    await interaction.reply({ content: `Success: **${targetUser.username}** has been set as **Operations Manager**.\nAgent base roles were synced where available.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: 'Management Promotion',
      description: `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n**New Role:** Operations Manager\n**Auto-Created:** ${existingAgent ? 'No' : 'Yes'}\n**Admin:** {{AGENT_NAME}}`,
      color: 0xF1C40F,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (e) {
    console.error('Error in handleSetOperationManager:', e);
    await interaction.reply({ content: 'Error during operations manager promotion.', ephemeral: true });
  }
}

async function handleDemote(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  try {
    const targetUser = interaction.options.getUser('user');
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) return interaction.reply({ content: `❌ **${targetUser.username}** is not a registered agent.`, ephemeral: true });

    db.prepare("UPDATE agents SET role = 'agent' WHERE discord_id = ?").run(targetUser.id);

    // Role Removal
    try {
      const member = await interaction.guild.members.fetch(targetUser.id);
      const rolesToRemove = interaction.guild.roles.cache.filter(r => 
        r.name.toLowerCase() === 'team leader' || r.name.toLowerCase() === 'subject matter expert' || r.name.toLowerCase() === 'operations manager'
      );
      if (rolesToRemove.size > 0) await member.roles.remove(rolesToRemove);
    } catch (e) { console.warn('[DEMOTE] Role cleanup failed:', e.message); }

    await interaction.reply({ content: `📉 **${targetUser.username}** has been demoted back to **Agent**. Management roles removed.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: '📉 Management Demotion',
      description: `**User:** ${targetUser.username} (<@${targetUser.id}>)\n**Action:** Demoted to Agent\n**Admin:** {{AGENT_NAME}}`,
      color: 0xE67E22,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (e) {
    console.error('Error in handleDemote:', e);
    await interaction.reply({ content: '❌ Error during demotion.', ephemeral: true });
  }
}

async function handleDbRemoveUserLegacy(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  try {
    const targetUser = interaction.options.getUser('user');
    const discordId = targetUser.id;
    await interaction.deferReply({ ephemeral: true });
    
    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(discordId);
    
    db.transaction(() => {
      if (agent) {
                db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
        db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
      }
      db.prepare("DELETE FROM agents WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM developers WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM dev_approvals WHERE target_id = ? OR proposed_by = ?").run(discordId, discordId);
    })();

    // Role Purge
    let remainingRoleNames = [];
    try {
      const member = await interaction.guild.members.fetch(discordId);
      const removableRoles = member.roles.cache.filter(role => role.id !== interaction.guild.id && role.editable);
      if (removableRoles.size > 0) {
        await member.roles.remove(removableRoles);
      }

      remainingRoleNames = member.roles.cache
        .filter(role => role.id !== interaction.guild.id)
        .map(role => role.name);
    } catch (e) { console.warn('[REMOVE-USER] Role purge failed:', e.message); }

    const rolePurgeNote = remainingRoleNames.length > 0
      ? ` Remaining uneditable roles: ${remainingRoleNames.join(', ')}.`
      : ' All removable Discord roles were cleared.';

    await interaction.editReply({ content: `🔥 **COMPLETED PURGE:** **${targetUser.username}** has been wiped from the database and Discord role state.${rolePurgeNote}` });

    sendAuditLog(interaction.client, {
      title: '🔥 Total User Purge',
      description: `**User:** ${targetUser.username} (\`${discordId}\`)\n**Action:** COMPLETE DB & ROLE WIPE\n**Admin:** {{AGENT_NAME}}`,
      color: 0x000000,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleDbRemoveUser:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Error during purge: ' + error.message }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Error during purge: ' + error.message, ephemeral: true }).catch(() => {});
    }
  }
}

async function handleDbSetPin(interaction) {
  if (!isDeveloper(interaction)) {
    return interaction.reply({ content: '❌ **Developer Access Required.**', ephemeral: true });
  }

  const targetUser = interaction.options.getUser('user');
  const newPin = interaction.options.getString('pin');

  if (!/^\d{4,6}$/.test(newPin)) {
    return interaction.reply({ content: '❌ PIN must be **4 to 6 digits** long.', ephemeral: true });
  }

  try {
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) {
      return interaction.reply({ content: '❌ That user is not a registered agent.', ephemeral: true });
    }

    db.prepare("UPDATE agents SET pin = ? WHERE discord_id = ?").run(newPin, targetUser.id);
    
    await interaction.reply({ content: `✅ **PIN Updated!** ${targetUser.username}'s PIN was updated successfully.`, ephemeral: true });
    
    // Audit log
    sendAuditLog(interaction.client, {
      title: '🔐 Developer Action: PIN Override',
      description: `**Admin:** ${interaction.user.username}\n**Target:** ${targetUser.username} (<@${targetUser.id}>)\n**Action:** PIN Reset`,
      color: 0x3498DB,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleDbSetPin:', error);
    interaction.reply({ content: '❌ Failed to update PIN.', ephemeral: true });
  }
}

async function handleResetPin(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const currentPin = interaction.options.getString('current_pin');
    const newPin = interaction.options.getString('new_pin');
    const confirmPin = interaction.options.getString('confirm_pin');

    if (!/^\d{4,6}$/.test(newPin)) {
      return interaction.editReply({ content: '❌ New PIN must be **4 to 6 digits** long.' });
    }

    if (newPin !== confirmPin) {
      return interaction.editReply({ content: '❌ New PIN and confirm PIN do not match.' });
    }

    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) {
      return interaction.editReply({ content: '❌ You are not a registered agent. Ask Operations Manager or Developer to run `/add-agent` first.' });
    }

    if (agent.pin !== currentPin) {
      return interaction.editReply({ content: '❌ Current PIN is incorrect.' });
    }

    db.prepare("UPDATE agents SET pin = ? WHERE discord_id = ?").run(newPin, interaction.user.id);

    await interaction.editReply({ content: '✅ Your security PIN has been updated.' });

    sendAuditLog(interaction.client, {
      title: '🔐 Agent PIN Reset',
      description: `**Agent:** ${interaction.user.username} (<@${interaction.user.id}>)\n**Action:** Self PIN reset`,
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleResetPin:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to reset PIN.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to reset PIN.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleMemberLeave(member) {
  try {
    const discordId = member.id;
    const targetUser = member.user;
    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(discordId);

    db.transaction(() => {
      if (agent) {
        db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
        db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
      }

      db.prepare("DELETE FROM agents WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM developers WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM dev_approvals WHERE target_id = ? OR proposed_by = ?").run(discordId, discordId);
    })();

    console.log(`[MEMBER-LEAVE] Purged DB records for ${targetUser.tag} (${discordId}) after leaving the server.`);

    await sendAuditLog(member.client, {
      title: 'Member Left · Auto Cleanup',
      description: `**User:** ${targetUser.username} (\`${discordId}\`)\n**Action:** Automatic DB cleanup after leaving the server.`,
      color: 0xED4245,
      userId: discordId,
      guild: member.guild
    });
  } catch (error) {
    console.warn('[MEMBER-LEAVE] Failed to purge departed member records:', error.message);
  }
}

async function handleDbRemoveAll(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });

  try {
    const existing = db.prepare("SELECT * FROM dev_approvals WHERE target_id = 'GLOBAL_PURGE'").get();
    if (existing) {
      return interaction.reply({ content: '⚠️ A database purge is already pending approval from another developer.', ephemeral: true });
    }

    // Create purge request
    db.prepare("INSERT INTO dev_approvals (target_id, proposed_by) VALUES (?, ?)").run('GLOBAL_PURGE', interaction.user.id);

    const embed = new EmbedBuilder()
      .setTitle('☢️ CRITICAL SECURITY ALERT: DATABASE PURGE')
      .setDescription(`### ☢️ GLOBAL WIPE INITIATED\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                      `**Proposed By:** <@${interaction.user.id}>\n\n` +
                      `> **WARNING:** This will delete **ALL** agents, sessions, activities, and logs. This action is **IRREVERSIBLE**.\n\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                      `*Consensus required. A second developer must approve this action.*`)
      .setColor(0x000000)
      .setTimestamp();

    const approveBtn = new ButtonBuilder()
      .setCustomId('purge_confirm_GLOBAL_PURGE')
      .setLabel('☢️ AUTHORIZE WIPE')
      .setStyle(ButtonStyle.Danger);

    const denyBtn = new ButtonBuilder()
      .setCustomId('purge_deny_GLOBAL_PURGE')
      .setLabel('❌ CANCEL REQUEST')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    await interaction.reply({ embeds: [embed], components: [row] });

  } catch (e) {
    console.error('Error in handleDbRemoveAll:', e);
    await interaction.reply({ content: '❌ Error initiating purge: ' + e.message, ephemeral: true });
  }
}

async function handlePurgeConfirm(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });

  try {
    const request = db.prepare("SELECT * FROM dev_approvals WHERE target_id = 'GLOBAL_PURGE'").get();
    if (!request) return interaction.update({ content: '❌ This purge request has already been processed or expired.', embeds: [], components: [] });

    if (request.proposed_by === interaction.user.id) {
      return interaction.reply({ content: '❌ **Consensus required.** You cannot approve your own purge request. Another developer must sign off.', ephemeral: true });
    }

    // CONSENSUS REACHED -> EXECUTE WIPE
    db.transaction(() => {
      // Keep developers, delete everything else
      db.prepare("DELETE FROM activities").run();
      db.prepare("DELETE FROM sessions").run();
      db.prepare("DELETE FROM maintenance_logs").run();
      db.prepare("DELETE FROM handover_notes").run();
      db.prepare("DELETE FROM schedules").run();
      db.prepare("DELETE FROM pending_registrations").run();
      db.prepare("DELETE FROM rac_codes").run();
      db.prepare("DELETE FROM agents WHERE discord_id NOT IN (SELECT discord_id FROM developers)").run();
      db.prepare("DELETE FROM dev_approvals WHERE target_id = 'GLOBAL_PURGE'").run();
    })();

    const successEmbed = new EmbedBuilder()
      .setTitle('🔥 DATABASE WIPED')
      .setDescription(`### 🏁 PURGE COMPLETED\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                      `**Initiated By:** <@${request.proposed_by}>\n` +
                      `**Authorized By:** <@${interaction.user.id}>\n\n` +
                      `> Total agent and session data has been purged from the system.\n\n` +
                      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      .setColor(0x000000)
      .setTimestamp();

    await interaction.update({ embeds: [successEmbed], components: [] });

    sendAuditLog(interaction.client, {
      title: '☢️ GLOBAL DATABASE PURGE',
      description: `**Proposed By:** <@${request.proposed_by}>\n**Approved By:** <@${interaction.user.id}>\n**Action:** Total system data wipe completed.`,
      color: 0x000000,
      guild: interaction.guild
    });

  } catch (e) {
    console.error('Error in handlePurgeConfirm:', e);
    await interaction.reply({ content: '❌ Fatal error during purge execution: ' + e.message, ephemeral: true });
  }
}

async function handlePurgeDeny(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
  
  db.prepare("DELETE FROM dev_approvals WHERE target_id = 'GLOBAL_PURGE'").run();
  await interaction.update({ content: `✅ **Purge request cancelled** by <@${interaction.user.id}>.`, embeds: [], components: [] });
}

async function handleDbInfo(interaction) {
  if (!isDeveloper(interaction)) {
    return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  }
  try {
    const path = require('path');
    const dbPath = path.resolve(__dirname, '../aavgo.db');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => `\`${t.name}\``).join(', ');
    
    await interaction.reply({ 
      content: `📁 **Database Location:** \`${dbPath}\`\n📊 **Tables:** ${tableNames}`, 
      ephemeral: true 
    });
  } catch (error) {
    console.error('Error in handleDbInfo:', error);
    await interaction.reply({ content: '❌ Error: ' + error.message, ephemeral: true });
  }
}

async function handleFindGuest(interaction) {
  try {
    const query = interaction.options.getString('query');
    
    // Authorization: Developers, SMEs, or Team Leaders
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // Search query: Primary search on guest_name to avoid operational metadata collisions
    const sql = `
      SELECT 
        activities.type, 
        activities.guest_name, 
        activities.details, 
        activities.timestamp,
        agents.discord_id as agent_discord_id,
        hotels.name as hotel_name
      FROM activities
      JOIN sessions ON activities.session_id = sessions.id
      JOIN agents ON sessions.agent_id = agents.id
      JOIN hotels ON sessions.hotel_id = hotels.id
      WHERE activities.guest_name LIKE ? 
      ORDER BY activities.timestamp DESC
      LIMIT 10
    `;

    const searchPattern = `%${query}%`;
    const results = db.prepare(sql).all(searchPattern);

    if (results.length === 0) {
      return interaction.editReply({ content: `🔍 No guest records found containing "**${query}**".` });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔍 Guest Search: ${query}`)
      .setDescription(`Found ${results.length} records matching guest name/room (showing latest 10):`)
      .setColor(0x3498DB)
      .setTimestamp();

    for (const res of results) {
      const details = JSON.parse(res.details || '{}');
      const detailsStr = Object.entries(details)
        .map(([k, v]) => `• **${k}:** ${v}`)
        .join('\n');

      const timeUnix = Math.floor(new Date(res.timestamp + 'Z').getTime() / 1000);
      const agentName = await getAgentDisplayName(interaction.guild, res.agent_discord_id);
      
      embed.addFields({
        name: `${res.type.toUpperCase()} | ${res.guest_name}`,
        value: `📅 **Date:** <t:${timeUnix}:f>\n` +
               `👤 **Agent:** ${agentName}\n` +
               `🏨 **Hotel:** ${res.hotel_name}\n` +
               `${detailsStr}`
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error in handleFindGuest:', error);
    await interaction.editReply({ content: '❌ An error occurred during the search.' });
  }
}

async function handleGuide(interaction) {
  try {
    const topic = interaction.options.getString('topic');
    const agent = db.prepare("SELECT hotel_id FROM sessions WHERE agent_id = (SELECT id FROM agents WHERE discord_id = ?) AND status = 'active'").get(interaction.user.id);
    const hotelId = agent ? agent.hotel_id : null;

    // Search for topic in specific hotel OR global
    const sql = `
      SELECT * FROM sop_guides 
      WHERE topic LIKE ? 
      AND (hotel_id IS NULL OR hotel_id = ?)
      ORDER BY hotel_id DESC -- Specific hotel first
    `;
    const guides = db.prepare(sql).all(`%${topic}%`, hotelId);

    if (guides.length === 0) {
      return interaction.reply({ content: `🔍 No SOP guides found for "**${topic}**".`, ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(`📚 SOP Guide: ${guides[0].topic}`)
      .setDescription(guides[0].content)
      .setColor(0x3498DB)
      .setFooter({ text: `Hotel: ${guides[0].hotel_id || 'Global Policy'}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) {
    console.error('Error in handleGuide:', e);
    await interaction.reply({ content: '❌ Error retrieving guide.', ephemeral: true });
  }
}

async function handleAddGuide(interaction) {
  try {
    const hotel = interaction.options.getString('hotel');
    const topic = interaction.options.getString('topic');
    const content = interaction.options.getString('content');

    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Access Denied: Management only.', ephemeral: true });
    }

    const hotelId = hotel === 'GLOBAL' ? null : hotel;
    db.prepare("INSERT OR REPLACE INTO sop_guides (hotel_id, topic, content) VALUES (?, ?, ?)").run(hotelId, topic, content);

    await interaction.reply({ content: `✅ SOP Guide "**${topic}**" added/updated successfully.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: '📚 SOP Guide Updated',
      description: `**Topic:** ${topic}\n**Hotel:** ${hotel}\n**Admin:** {{AGENT_NAME}}`,
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (e) {
    console.error('Error in handleAddGuide:', e);
    await interaction.reply({ content: '❌ Error saving guide.', ephemeral: true });
  }
}

async function handleMaintenanceList(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Access Denied: Management only.', ephemeral: true });
    }

    const issues = db.prepare(`
      SELECT maintenance_logs.*, hotels.name as hotel_name 
      FROM maintenance_logs 
      JOIN hotels ON maintenance_logs.hotel_id = hotels.id
      WHERE status = 'pending'
      ORDER BY timestamp DESC LIMIT 15
    `).all();

    if (issues.length === 0) {
      return interaction.reply({ content: '✅ No pending maintenance issues found.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Pending Maintenance Issues')
      .setColor(0xE67E22)
      .setTimestamp();

    issues.forEach(issue => {
      const timeUnix = Math.floor(new Date(issue.timestamp + 'Z').getTime() / 1000);
      embed.addFields({
        name: `Room ${issue.room_number} | ${issue.hotel_name}`,
        value: `**Category:** ${issue.category}\n**Issue:** ${issue.description}\n**Reported:** <t:${timeUnix}:R>`
      });
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) {
    console.error('Error in handleMaintenanceList:', e);
    await interaction.reply({ content: '❌ Error listing issues.', ephemeral: true });
  }
}

async function handleHelpStaff(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ **Developer or Operations Manager Access Required.** Unauthorized action logged.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Staff Technical Reference')
      .setDescription(
        '### 🏗️ Core Setup & Portals\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/setup-login`: Rebuild or refresh the persistent agent login kiosk.\n' +
        '> `/setup-login-team`: Deploy the Team Leader / SME login portal.\n' +
        '> `/setup-security`: Deploy the security setup kiosk (PIN + phone form).\n' +
        '> `/setup-profiles`: Deploy the staff profiles dashboard panel.\n' +
        '> `/select-trainee`: Assign the Trainees role to a user.\n' +
        '> `/hotel-status action:refresh_all`: Force-refresh every hotel and team status embed.\n\n' +
        '### 👥 Agent Lifecycle Controls\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/add-agent`: Instant-create an agent, TL, or SME profile.\n' +
        '> `/remove-agent`: Remove an agent through the managed flow.\n' +
        '> `/assign-team`: Move an agent between Team 1 and Team 2.\n' +
        '> `/db-assign-hotel`: Permanently link an agent to a hotel (`sync`: permission/ghost/both).\n' +
        '> `/db-add-developer`: Add a developer record.\n' +
        '> `/db-set-pin`: Reset an agent PIN in real time.\n' +
        '> `/db-set-phone`: Correct an agent phone record.\n' +
        '> `/db-promote-tl`, `/db-promote-sme`, `/db-set-operation-manager`, `/db-demote`: Change leadership roles.\n\n' +
        '### 🧰 Database & Recovery\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/db-info`: Inspect DB path, schema, and table layout.\n' +
        '> `/db-query`: Run raw SQL directly against the live SQLite DB.\n' +
        '> `/db-backup`: Export database and project backup on demand.\n' +
        '> `/db-clear-pending`: Clear stuck registration queue items.\n' +
        '> `/db-delete-agent`: Delete only the DB record.\n' +
        '> `/db-remove-user`: Full identity purge from DB and Discord roles.\n' +
        '> `/db-remove-all`: Consensus-based wipe of non-developer data.\n\n' +
        '### 🔐 Security & Recruitment\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/help-staff`: Open this technical reference.\n' +
        '> `/help-team-leader`: Show the TL / SME operational guide.\n\n' +
        '### 📊 Operations, Search & Scheduling\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/find-guest`: Search guest records by name or room.\n' +
        '> `/db-log-checkin`: Manually log a guest check-in to management tracking.\n' +
        '> `/maintenance-list`: Review pending maintenance issues.\n' +
        '> `/guide` and `/add-guide`: Search or update SOP knowledge.\n' +
        '> `/db-set-schedule`: Assign shifts to agents.\n' +
        '> `/set-hotel-shifts`: Store two hotel shift options and sync matching hotel roles.\n' +
        '> `/schedule-view`, `/schedule-export`, `/schedule-import`: Manage schedule sheets.\n' +
        '> `/attendance-report`: Audit missed shifts and late logins.\n\n' +
        '### 📎 Useful SQL Snippets (`/db-query`)\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '`SELECT * FROM agents;`\n' +
        '`SELECT discord_id, username, role, hotel_id, agent_status FROM agents;`\n' +
        '`SELECT * FROM sessions WHERE status = "active";`\n' +
        '`SELECT * FROM pending_registrations;`\n' +
        '`SELECT * FROM developers;`\n' +
        '`SELECT * FROM schedules ORDER BY shift_date, start_time;`\n\n' +
        '### ⚠️ Permission Model Reminder\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        'Developer authority is database-first. Discord roles mostly control visibility, while sensitive bot actions still check DB tables such as `developers`, `agents`, `sessions`, and schedule data.'
      )
      .setColor(0x2C3E50)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) {
    console.error('Error in handleHelpStaff:', e);
  }
}

async function handleHelpAgent(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'agent')) {
      return interaction.reply({ content: '❌ You must be a registered agent to use this guide.', ephemeral: true });
    }

    const agent = db.prepare("SELECT role, agent_status, hotel_id, team FROM agents WHERE discord_id = ?").get(interaction.user.id);
    const roleLabel = getRoleLabel(agent?.role);
    const shiftAccessLabel = AGENT_STATUS_LABELS[getAgentShiftAccessState(agent)] || 'Ready for Live Shifts';
    const assignmentLabel = agent?.hotel_id ? (HOTEL_NAMES[agent.hotel_id] || agent.hotel_id) : 'Not linked yet';
    const teamLabel = agent?.team || 'Not set yet';

    const embed = new EmbedBuilder()
      .setTitle('💛 Aavgo Agent Guide')
      .setDescription(
        '### 🟡 Daily Agent Flow\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/my-schedule`: Check your next assigned shifts.\n' +
        '> `/login`: Start your shift from the correct hotel flow.\n' +
        '> If you have multiple assigned hotels, the bot will prompt you to pick one before PIN entry.\n' +
        '> `/status`: Review current staffing and shift coverage.\n' +
        '> `/reset-pin`: Change your own security PIN.\n' +
        '> Security kiosk: click **Set Security PIN & Phone** when management posts `/setup-security`.\n' +
        '> `/check-hours`: Review your logged hours.\n' +
        '> `/end-shift` or `/logout`: End your current shift safely.\n\n' +
        '### 🧰 During Shift\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/tools`: Open the agent tools panel for break and emergency actions.\n' +
        '> `/guide`: Search SOPs and hotel process guides by topic.\n\n' +
        '### 👥 Onboarding Support\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/select-trainee`: Mark a user as a trainee during onboarding.\n' +
        '> `/assign-team`: Reassign a user to Team 1 or Team 2.\n\n' +
        '### 📌 Your Current Access\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `> **DB Role:** ${roleLabel}\n` +
        `> **Shift Access:** ${shiftAccessLabel}\n` +
        `> **Team:** ${teamLabel}\n` +
        `> **Hotel Link:** ${assignmentLabel}\n\n` +
        '### 🔐 Permission Reminder\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        'Database permissions are the real authority. Discord roles mostly control visibility and channel access.'
      )
      .setColor(0xF1C40F)
      .setFooter({ text: 'Aavgo Operations • Agent Help' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) {
    console.error('Error in handleHelpAgent:', e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Error opening the agent guide.', ephemeral: true });
    }
  }
}

async function handleSelectTrainee(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('name');
    const traineeRoleId = '1484705126026449029';
    const traineeRole = interaction.guild.roles.cache.get(traineeRoleId);

    if (!traineeRole) {
      return interaction.editReply({ content: '❌ Trainees role not found in this server.' });
    }

    const member = await interaction.guild.members.fetch(targetUser.id);
    if (member.roles.cache.has(traineeRoleId)) {
      return interaction.editReply({ content: `⚠️ **${targetUser.username}** already has the Trainees role.` });
    }

    await member.roles.add(traineeRole);

    await interaction.editReply({
      content: `✅ **${targetUser.username}** has been assigned the **Trainees** role.`,
    });

    try {
      await removeApplicantsRoleFromMember(member, interaction.guild, 'SELECT-TRAINEE');
    } catch (roleErr) {
      console.warn('[SELECT-TRAINEE] Could not clear Applicants role:', roleErr.message);
    }

    sendAuditLog(interaction.client, {
      title: '🎓 Trainee Role Assigned',
      description: `**User:** ${targetUser.username} (<@${targetUser.id}>)\n**Assigned By:** {{AGENT_NAME}}\n**Role:** Trainees`,
      color: 0xF1C40F,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleSelectTrainee:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Failed to assign the Trainees role.', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.editReply({ content: '❌ Failed to assign the Trainees role.' }).catch(() => {});
    }
  }
}

async function handleAssignTeam(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const teamName = normalizeTeamInput(interaction.options.getString('team'));
    const targetUser = interaction.options.getUser('name');

    if (!teamName) {
      return interaction.editReply({ content: '❌ Please choose Team 1 or Team 2.' });
    }

    const member = await interaction.guild.members.fetch(targetUser.id);
    const currentTeam = db.prepare("SELECT team FROM agents WHERE discord_id = ?").get(targetUser.id)?.team || null;
    const targetTeamRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === teamName.toLowerCase());
    const otherTeamName = getOtherTeamName(teamName);
    const otherTeamRole = otherTeamName ? interaction.guild.roles.cache.find(r => r.name.toLowerCase() === otherTeamName.toLowerCase()) : null;

    db.prepare("UPDATE agents SET team = ? WHERE discord_id = ?").run(teamName, targetUser.id);

    if (otherTeamRole && member.roles.cache.has(otherTeamRole.id)) {
      await member.roles.remove(otherTeamRole);
    }

    if (targetTeamRole && !member.roles.cache.has(targetTeamRole.id)) {
      await member.roles.add(targetTeamRole);
    }

    sendAuditLog(interaction.client, {
      title: '👥 Team Assigned',
      description: `**User:** ${targetUser.username} (<@${targetUser.id}>)\n**Team:** ${teamName}\n**Previous Team:** ${currentTeam || 'None'}\n**Assigned By:** {{AGENT_NAME}}`,
      color: 0x57F287,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    await interaction.editReply({ content: `✅ **${targetUser.username}** is now assigned to **${teamName}**.` });
  } catch (error) {
    console.error('Error in handleAssignTeam:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Failed to assign the team.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply({ content: '❌ Failed to assign the team.' }).catch(() => {});
    }
  }
}

async function handleHelpTeamLeader(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Access Denied: Management only.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Aavgo Bot · Team Leader & SME Guide')
      .setDescription(
        '### 📋 Management Shift Tools\n' +
        '- `/setup-login-team`: Deploy the management shift portal.\n' +
        '- `/status`: View real-time staffing status for all hotels.\n' +
        '- `/attendance-report`: Check for missed shifts or late logins.\n\n' +
        '### 📊 Operational Oversight\n' +
        '- `/find-guest`: Search guest activities across all hotels.\n' +
        '- `/maintenance-list`: View pending maintenance reports.\n' +
        '- `/schedule-view`: See upcoming assignments in a spreadsheet view.\n\n' +
        '### 📚 Knowledge Management\n' +
        '- `/add-guide`: Add or update SOP policies for specific hotels.\n' +
        '- `/db-set-schedule`: Assign shifts to agents in your team.'
      )
      .setColor(0x57F287)
      .setFooter({ text: 'Aavgo Operations · Management Support' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) {
    console.error('Error in handleHelpTeamLeader:', e);
  }
}

async function handleHotelStatusRefresh(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }
    const action = interaction.options.getString('action');
    const specificHotel = interaction.options.getString('hotel');

    await interaction.deferReply({ ephemeral: true });

    if (action === 'refresh_all') {
      const hotels = db.prepare("SELECT id FROM hotels WHERE id != 'TEAM_SHIFT'").all();
      for (const h of hotels) {
        await updateHotelStatusEmbed(interaction.client, h.id);
      }
      await updateTeamStatusEmbed(interaction.client, 'Team 1');
      await updateTeamStatusEmbed(interaction.client, 'Team 2');
      await interaction.editReply({ content: '✅ Successfully refreshed all hotel and team status embeds.' });
    } else {
      if (!specificHotel) return interaction.editReply({ content: '❌ Please specify a hotel to refresh.' });
      await updateHotelStatusEmbed(interaction.client, specificHotel);
      await interaction.editReply({ content: `✅ Successfully refreshed status for **${HOTEL_NAMES[specificHotel] || specificHotel}**.` });
    }
  } catch (e) {
    console.error('Error in handleHotelStatusRefresh:', e);
    await interaction.editReply({ content: '❌ Error during refresh.' });
  }
}

async function handleDbAssignHotel(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Developer or management access required.', ephemeral: true });
    }
    const target = interaction.options.getUser('user');
    const hotelId = interaction.options.getString('hotel');
    const syncMode = interaction.options.getString('sync') || 'both';
    const syncPermission = syncMode === 'permission' || syncMode === 'both';
    const syncGhost = syncMode === 'ghost' || syncMode === 'both';

    db.prepare("UPDATE agents SET hotel_id = ? WHERE discord_id = ?").run(hotelId, target.id);
    
    await interaction.reply({ 
      content: `✅ Successfully linked **${target.username}** permanently to **${HOTEL_NAMES[hotelId]}**.\nRole sync mode: **${syncMode}**.`, 
      ephemeral: true 
    });

    sendAuditLog(interaction.client, {
      title: '🔗 Permanent Hotel Linkage',
      description: `**Agent:** ${target.username} (<@${target.id}>)\n**Linked to:** ${HOTEL_NAMES[hotelId]}\n**Role Sync:** ${syncMode}\n**Admin:** {{AGENT_NAME}}`,
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    // Role Synchronization (Grey Roles)
    try {
      const member = await interaction.guild.members.fetch(target.id);
      if (member) {
        const greyRoleIds = syncGhost ? Object.values(ROLE_NAMES.GREY) : [];
        const greenRoleIds = syncPermission ? Object.values(ROLE_NAMES.GREEN) : [];
        
        // Find existing Grey/Green roles to remove
        const rolesToRemove = member.roles.cache.filter(r => 
          greyRoleIds.includes(r.id) || greenRoleIds.includes(r.id)
        );
        
        if (rolesToRemove.size > 0) await member.roles.remove(rolesToRemove);
        
        // Add selected role types for new assignment
        const newGreyRoleId = ROLE_NAMES.GREY[hotelId];
        const newGreenRoleId = ROLE_NAMES.GREEN[hotelId];
        const newGreyRole = syncGhost ? interaction.guild.roles.cache.get(newGreyRoleId) : null;
        const newGreenRole = syncPermission ? interaction.guild.roles.cache.get(newGreenRoleId) : null;
        
        const rolesToAdd = [newGreyRole, newGreenRole].filter(Boolean);
        
        // If they are currently on shift (only if we can detect it easily, but better to just add Grey)
        // Actually, if they are on-shift, the Login flow handles Green roles. 
        // We'll just ensure Grey is added.
        
        if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);
        console.log(`[ASSIGN] Synced permanent roles for ${target.username} to ${hotelId}`);
      }
    } catch (e) {
      console.warn('[ASSIGN] Role sync failed:', e.message);
    }
  } catch (e) {
    console.error('Error in handleDbAssignHotel:', e);
    await interaction.reply({ content: '❌ Error assigning hotel.', ephemeral: true });
  }
}


async function handleSetSchedule(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }
    const target = interaction.options.getUser('user');
    const hotel = interaction.options.getString('hotel');
    const dateInput = interaction.options.getString('date');
    const startInput = interaction.options.getString('start');
    const endInput = interaction.options.getString('end');

    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(target.id);
    if (!agent) return interaction.reply({ content: '❌ User is not a registered agent.', ephemeral: true });

    let dateStr = dateInput.toLowerCase() === 'today' ? new Date().toISOString().split('T')[0] : dateInput;
    const start_time = `${dateStr}T${startInput}:00`;
    const end_time = `${dateStr}T${endInput}:00`;

    db.prepare("INSERT INTO schedules (agent_id, hotel_id, start_time, end_time) VALUES (?, ?, ?, ?)").run(
      agent.id, hotel, start_time, end_time
    );

    await interaction.reply({ content: `✅ Schedule set for **${target.username}** at **${HOTEL_NAMES[hotel]}** on **${dateStr}** (${startInput} - ${endInput}).`, ephemeral: true });
  } catch (e) {
    console.error('Error in handleSetSchedule:', e);
    await interaction.reply({ content: '❌ Error setting schedule.', ephemeral: true });
  }
}

async function handleAddHotelShifts(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    const target = interaction.options.getUser('user');
    const hotelOne = interaction.options.getString('hotel_1');
    const hotelTwo = interaction.options.getString('hotel_2');

    if (hotelOne === hotelTwo) {
      return interaction.reply({ content: '❌ Please choose two different hotels.', ephemeral: true });
    }

    const agent = db.prepare("SELECT id, username FROM agents WHERE discord_id = ?").get(target.id);
    if (!agent) return interaction.reply({ content: '❌ User is not a registered agent.', ephemeral: true });

    db.prepare(`
      INSERT INTO hotel_shift_assignments (agent_id, primary_hotel_id, secondary_hotel_id, created_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        primary_hotel_id = excluded.primary_hotel_id,
        secondary_hotel_id = excluded.secondary_hotel_id,
        created_by = excluded.created_by,
        created_at = CURRENT_TIMESTAMP
    `).run(agent.id, hotelOne, hotelTwo, interaction.user.id);

    let roleSyncNote = '';
    try {
      const member = await interaction.guild.members.fetch(target.id);
      if (member) {
        const allHotelRoleIds = [...Object.values(ROLE_NAMES.GREY), ...Object.values(ROLE_NAMES.GREEN)];
        const selectedRoleIds = [
          ROLE_NAMES.GREY[hotelOne],
          ROLE_NAMES.GREY[hotelTwo]
        ].filter(Boolean);
        const uniqueSelectedRoleIds = [...new Set(selectedRoleIds)];

        const rolesToRemove = member.roles.cache.filter(
          r => allHotelRoleIds.includes(r.id) && !uniqueSelectedRoleIds.includes(r.id)
        );
        if (rolesToRemove.size > 0) await member.roles.remove(rolesToRemove);

        const rolesToAdd = uniqueSelectedRoleIds
          .map(roleId => interaction.guild.roles.cache.get(roleId))
          .filter(role => role && !member.roles.cache.has(role.id));
        if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);
      }
    } catch (roleErr) {
      console.warn('[SET-HOTEL-SHIFTS] Role sync failed:', roleErr.message);
      roleSyncNote = '\n⚠️ Shift pair saved, but role sync failed due to Discord permissions/hierarchy.';
    }

    await interaction.reply({
      content:
        `✅ Saved paired hotel shifts for **${target.username}**.\n` +
        `Primary: **${HOTEL_NAMES[hotelOne] || hotelOne}**\n` +
        `Secondary: **${HOTEL_NAMES[hotelTwo] || hotelTwo}**\n\n` +
        `They still occupy only one hotel at a time; this stores both approved shift options and syncs only the matching grey hotel roles.` +
        roleSyncNote,
      ephemeral: true
    });
  } catch (e) {
    console.error('Error in handleAddHotelShifts:', e);
    await interaction.reply({ content: '❌ Error saving paired hotel shifts.', ephemeral: true });
  }
}

async function handleScheduleView(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    const hotelId = interaction.options.getString('hotel');
    let sql = `
      SELECT schedules.*, agents.username, hotels.name as hotel_name 
      FROM schedules 
      JOIN agents ON schedules.agent_id = agents.id
      JOIN hotels ON schedules.hotel_id = hotels.id
      WHERE schedules.start_time >= date('now', '-1 day')
    `;
    if (hotelId) sql += ` AND schedules.hotel_id = '${hotelId}'`;
    sql += ` ORDER BY schedules.start_time ASC LIMIT 20`;

    const rows = db.prepare(sql).all();
    if (rows.length === 0) return interaction.reply({ content: '📅 No upcoming shifts scheduled.', ephemeral: true });

    let table = '```\n| Agent        | Hotel          | Date       | Staffing Time |\n';
    table += '|--------------|----------------|------------|---------------|\n';
    rows.forEach(r => {
      const date = r.start_time.split('T')[0];
      const time = `${r.start_time.split('T')[1].substring(0,5)} - ${r.end_time.split('T')[1].substring(0,5)}`;
      table += `| ${r.username.padEnd(12)} | ${(r.hotel_name.length > 14 ? r.hotel_id : r.hotel_name).padEnd(14)} | ${date} | ${time} |\n`;
    });
    table += '```';

    const embed = new EmbedBuilder()
      .setTitle('📊 Weekly Shift Schedule')
      .setDescription(table)
      .setColor(0x3498DB)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) {
    console.error('Error in handleScheduleView:', e);
  }
}

async function handleScheduleExport(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    const rows = db.prepare(`
      SELECT agents.username, schedules.hotel_id, schedules.start_time, schedules.end_time, schedules.status
      FROM schedules 
      JOIN agents ON schedules.agent_id = agents.id
    `).all();

    let csv = 'Agent,Hotel,Start_Time,End_Time,Status\n';
    rows.forEach(r => {
      csv += `"${r.username}","${r.hotel_id}","${r.start_time}","${r.end_time}","${r.status}"\n`;
    });

    const buffer = Buffer.from(csv, 'utf-8');
    await interaction.reply({ 
      content: '📊 **Aavgo Schedule Export** (Open this in Excel)', 
      files: [{ attachment: buffer, name: 'aavgo_schedule.csv' }], 
      ephemeral: true 
    });
  } catch (e) { console.error(e); }
}

async function handleScheduleImport(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const file = interaction.options.getAttachment('file');
    if (!file.name.endsWith('.csv')) return interaction.editReply({ content: '❌ Please upload a .csv file.' });

    const response = await fetch(file.url);
    const text = await response.text();
    const lines = text.split('\n').filter(l => l.trim() !== '');
    
    // Skip header
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const [user, hotel, start, end] = lines[i].split(',').map(s => s.replace(/"/g, '').trim());
      const agent = db.prepare("SELECT id FROM agents WHERE username = ?").get(user);
      if (agent && hotel && start && end) {
        db.prepare("INSERT OR REPLACE INTO schedules (agent_id, hotel_id, start_time, end_time) VALUES (?, ?, ?, ?)").run(agent.id, hotel, start, end);
        count++;
      }
    }

    await interaction.editReply({ content: `✅ Successfully imported **${count}** schedule records from CSV.` });
  } catch (e) {
    console.error(e);
    await interaction.editReply({ content: '❌ Error importing CSV. Ensure columns are: Agent, Hotel, Start_Time, End_Time.' });
  }
}

async function handleMySchedule(interaction) {
  try {
    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) return interaction.reply({ content: '❌ Not registered.', ephemeral: true });

    const shifts = db.prepare(`
      SELECT schedules.*, hotels.name as hotel_name 
      FROM schedules 
      JOIN hotels ON schedules.hotel_id = hotels.id
      WHERE agent_id = ? AND start_time >= date('now')
      ORDER BY start_time ASC LIMIT 5
    `).all(agent.id);

    if (shifts.length === 0) return interaction.reply({ content: '📅 You have no upcoming shifts assigned.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle('📅 Your Upcoming Shifts')
      .setColor(0x57F287)
      .setTimestamp();

    shifts.forEach(s => {
      const date = new Date(s.start_time).toLocaleDateString();
      const st = s.start_time.split('T')[1].substring(0,5);
      const et = s.end_time.split('T')[1].substring(0,5);
      embed.addFields({ name: `${date} | ${s.hotel_name}`, value: `⏰ **Time:** ${st} - ${et}\n📌 **Status:** ${s.status.toUpperCase()}` });
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) { console.error(e); }
}

async function handleAttendanceReport(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required.', ephemeral: true });
    }

    const missed = db.prepare(`
      SELECT schedules.*, agents.username, hotels.name as hotel_name 
      FROM schedules 
      JOIN agents ON schedules.agent_id = agents.id
      JOIN hotels ON schedules.hotel_id = hotels.id
      WHERE schedules.status = 'pending' AND schedules.start_time < datetime('now', '-15 minutes')
      ORDER BY start_time DESC LIMIT 10
    `).all();

    if (missed.length === 0) return interaction.reply({ content: '✅ No missed shifts reported in the last 24h.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle('🚨 Attendance Exception Report')
      .setDescription('Agents who did not log in within 15 mins of their start time:')
      .setColor(0xED4245)
      .setTimestamp();

    missed.forEach(m => {
       const date = new Date(m.start_time).toLocaleDateString();
       embed.addFields({ name: `${m.username} | ${m.hotel_name}`, value: `📅 **Date:** ${date}\n⏰ **Scheduled:** ${m.start_time.split('T')[1].substring(0,5)}` });
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (e) { console.error(e); }
}

async function checkSchedules(client) {
  try {
    // Find shifts starting in the next 15-20 minutes that haven't been notified
    const soon = new Date(Date.now() + 20 * 60000).toISOString();
    const now = new Date().toISOString();

    const upcoming = db.prepare(`
      SELECT schedules.*, agents.discord_id, agents.username, hotels.name as hotel_name 
      FROM schedules 
      JOIN agents ON schedules.agent_id = agents.id
      JOIN hotels ON schedules.hotel_id = hotels.id
      WHERE notified = 0 AND start_time <= ? AND start_time > ?
    `).all(soon, now);

    for (const s of upcoming) {
      try {
        const user = await client.users.fetch(s.discord_id);
        const time = s.start_time.split('T')[1].substring(0,5);
        
        const embed = new EmbedBuilder()
          .setTitle('⏰ Shift Reminder')
          .setDescription(`Your shift at **${s.hotel_name}** starts at **${time}**!\nPlease log in on time to maintain your attendance score.`)
          .setColor(0xFEE75C);

        await user.send({ embeds: [embed] });
        
        db.prepare("UPDATE schedules SET notified = 1 WHERE id = ?").run(s.id);
      } catch (e) { console.warn(`[SCHEDULER] Could not notify ${s.username}:`, e.message); }
    }

    // Mark missed shifts: If shift started > 30 mins ago and still pending
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60000).toISOString();
    db.prepare("UPDATE schedules SET status = 'missed' WHERE status = 'pending' AND start_time < ?").run(thirtyMinsAgo);

  } catch (e) { console.error('[SCHEDULER] Error:', e); }
}

// Override: stable db-remove-user flow that always acknowledges quickly.
async function handleDbRemoveUser(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    if (!isDeveloper(interaction)) {
      return interaction.editReply({ content: '❌ Access Denied: Developer Only.' });
    }

    const targetUser = interaction.options.getUser('user');
    const discordId = targetUser.id;
    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(discordId);

    db.transaction(() => {
      if (agent) {
        db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
        db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
        db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
      }
      db.prepare("DELETE FROM agents WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM pending_registrations WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM developers WHERE discord_id = ?").run(discordId);
      db.prepare("DELETE FROM dev_approvals WHERE target_id = ? OR proposed_by = ?").run(discordId, discordId);
    })();

    let remainingRoleNames = [];
    try {
      const member = await interaction.guild.members.fetch(discordId);
      const removableRoles = member.roles.cache.filter(role => role.id !== interaction.guild.id && role.editable);
      if (removableRoles.size > 0) {
        await member.roles.remove(removableRoles);
      }
      remainingRoleNames = member.roles.cache
        .filter(role => role.id !== interaction.guild.id)
        .map(role => role.name);
    } catch (e) {
      console.warn('[REMOVE-USER] Role purge failed:', e.message);
    }

    const rolePurgeNote = remainingRoleNames.length > 0
      ? ` Remaining uneditable roles: ${remainingRoleNames.join(', ')}.`
      : ' All removable Discord roles were cleared.';

    await interaction.editReply({ content: `🔥 **COMPLETED PURGE:** **${targetUser.username}** has been wiped from the database and Discord role state.${rolePurgeNote}` });

    sendAuditLog(interaction.client, {
      title: '🔥 Total User Purge',
      description: `**User:** ${targetUser.username} (\`${discordId}\`)\n**Action:** COMPLETE DB & ROLE WIPE\n**Admin:** {{AGENT_NAME}}`,
      color: 0x000000,
      userId: interaction.user.id,
      guild: interaction.guild
    });
  } catch (error) {
    console.error('Error in handleDbRemoveUser:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Error during purge: ' + error.message }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Error during purge: ' + error.message, ephemeral: true }).catch(() => {});
    }
  }
}


module.exports = { 
  HOTEL_NAMES,
  HOTEL_LOGIN_CHANNELS,
  sendAuditLog,
  broadcastUpdateLog,
  ensureAgentKioskMessage,
  updateHotelStatusEmbed,
  handleSetupLogin, 
  handleSetupRegister,
  handleSetupSecurity,
  handleStartShiftClick, 
  handleHotelSelect, 
  handleLogin, 
  handleRegisterSubmit, 
  handleLogout, 
  handleStatus,
  handleRegister,
  handleApproveReg,
  handleDenyReg,
  handleRemoveAgent,
  handleAddAgent,
  handleRemoveAgentCommand,
  handleCheckHours,
  handleClearHours,
  handlePurge,
  handleModalSubmit,
  handleTakeoverShift,
  handleShiftHotelPickMenu,
  handleCancelTakeover,
  handleCancelMultiHotelStart,
  handleTeamSelect,
  handleResetTeam,
  handleDbDeleteAgent,
  handleDbClearPending,
  handleDbQuery,
  handleDbInfo,
  handleDbSetPin,
  handleResetPin,
  handleSetupLoginTeam,
  updateTeamStatusEmbed,
  handleDbAddDeveloper,
  handleDevApprove,
  handleDevDeny,
  handleDbSetPhone,
  handleDbLogCheckin,
  handlePromoteTL,
  handlePromoteSME,
  handleSetOperationManager,
  handleDemote,
  handleDbRemoveUser,
  handleMemberLeave,
  handleHelpStaff,
  handleHelpAgent,
  handleSelectTrainee,
  handleNewcomerPromotion,
  handleNewcomerAgentPinSubmit,
  handleAssignTeam,
  handleHelpTeamLeader,
  handleHotelStatusRefresh,
  handleSecuritySetupStart,
  handleSecuritySetupSubmit,
  handleDbAssignHotel,
  handleFindGuest,
  handleActivityClick,
  handleActivityModalSubmit,
  handleShiftInitModalSubmit,
  refreshOperationalBoards,
  handleGuide,
  handleAddGuide,
  handleMaintenanceList,
  handleSetSchedule,
  handleAddHotelShifts,
  handleScheduleView,
  handleScheduleExport,
  handleScheduleImport,
  handleMySchedule,
  handleAttendanceReport,
  checkSchedules,
  isDeveloper,
  normalizeAgentRole,
  getRoleLabel,
  getRoleRank,
  hasAgentRoleAtLeast,
  interactionHasRoleAtLeast,
  getAgentDisplayName,
  handleConfirmHotelLink,
  handleCancelHotelLink,
  handleHotelSelectMenu,
  handleDbRemoveAll,
  handlePurgeConfirm,
  handlePurgeDeny
};













