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
const TEAM_KEYS = ['Team 1', 'Team 2'];
const ROLE_STEPS = ['agent', 'sme', 'team_leader', 'operations_manager'];
const ROLE_LABELS = {
  agent: 'Agent',
  sme: 'SME',
  team_leader: 'Team Leader',
  operations_manager: 'Operations Manager'
};
const STATUS_LABELS = {
  standby: 'Standby',
  ready: 'Ready'
};

function trimToTwoWords(value) {
  const words = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'Unknown';
  return words.slice(0, 2).join(' ');
}

function trimForOptionLabel(value, maxLength = 100) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function roleLabel(role) {
  return ROLE_LABELS[String(role || '').toLowerCase()] || 'Agent';
}

function statusLabel(status) {
  return STATUS_LABELS[String(status || '').toLowerCase()] || 'Ready';
}

function toDiscordDate(value) {
  if (!value) return 'Not recorded';
  const timestamp = Math.floor(new Date(value).getTime() / 1000);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Not recorded';
  return `<t:${timestamp}:D>`;
}

function getProfilePanelKey(channelId) {
  return `${PROFILE_PANEL_KEY_PREFIX}${channelId}`;
}

function buildDashboardEmbed() {
  return new EmbedBuilder()
    .setTitle('Aavgo Profiles Dashboard')
    .setDescription(
      'Pick a team below to view members, open a profile card, and run management actions without typing slash commands.'
    )
    .addFields(
      {
        name: 'Quick Flow',
        value: '1. Pick team\n2. Pick member\n3. Use profile actions',
        inline: true
      },
      {
        name: 'Permission',
        value: 'Developer / Operations Manager only',
        inline: true
      }
    )
    .setColor(0x3498DB)
    .setFooter({ text: 'Aavgo Operations • Profiles' })
    .setTimestamp();
}

function buildTeamPickerRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('profiles_team_pick')
    .setPlaceholder('Select a team')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Team 1').setDescription('Open Team 1 members').setValue('Team 1'),
      new StringSelectMenuOptionBuilder().setLabel('Team 2').setDescription('Open Team 2 members').setValue('Team 2')
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildTeamMembersEmbed(teamName, members) {
  const lines = members.map((member, index) => {
    const titleName = trimToTwoWords(member.display_name || member.username);
    return `**${index + 1}. ${titleName}** • ${roleLabel(member.role)} • ${statusLabel(member.agent_status)}`;
  });

  return new EmbedBuilder()
    .setTitle(`${teamName} • Member Profiles`)
    .setDescription(lines.length > 0 ? lines.join('\n') : 'No members found for this team yet.')
    .setColor(teamName === 'Team 1' ? 0x57F287 : 0x5865F2)
    .setFooter({ text: 'Aavgo Operations • Team Picker' })
    .setTimestamp();
}

function buildMemberPickerRow(teamName, members) {
  const options = members.slice(0, 25).map(member => {
    const shortName = trimToTwoWords(member.display_name || member.username);
    return new StringSelectMenuOptionBuilder()
      .setLabel(trimForOptionLabel(shortName))
      .setDescription(trimForOptionLabel(`${roleLabel(member.role)} • ${statusLabel(member.agent_status)}`))
      .setValue(member.discord_id);
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`profiles_agent_pick:${teamName}`)
    .setPlaceholder('Select a member profile')
    .setOptions(options);

  return new ActionRowBuilder().addComponents(menu);
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

  const roleNames = ['team leader', 'subject matter expert', 'sme', 'operations manager'];
  const rolesToRemove = member.guild.roles.cache.filter(guildRole => roleNames.includes(guildRole.name.toLowerCase()));
  if (rolesToRemove.size > 0) {
    await member.roles.remove(rolesToRemove).catch(() => {});
  }

  const byRole = {
    sme: ['subject matter expert', 'sme'],
    team_leader: ['team leader'],
    operations_manager: ['operations manager']
  };

  const targetNames = byRole[role] || [];
  for (const name of targetNames) {
    const targetRole = member.guild.roles.cache.find(guildRole => guildRole.name.toLowerCase() === name);
    if (targetRole) {
      await member.roles.add(targetRole).catch(() => {});
      break;
    }
  }
}

function canUsePanel(interaction) {
  return auth.isDeveloper(interaction);
}

async function resolveDisplayName(guild, discordId, fallback) {
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (member) return member.displayName;
  return fallback || 'Unknown';
}

async function fetchTeamMembers(guild, teamName) {
  const rows = db.prepare(`
    SELECT id, discord_id, username, role, agent_status, team
    FROM agents
    WHERE lower(ifnull(team, '')) = lower(?)
    ORDER BY username COLLATE NOCASE ASC
  `).all(teamName);

  const members = [];
  for (const row of rows) {
    const displayName = await resolveDisplayName(guild, row.discord_id, row.username);
    members.push({ ...row, display_name: displayName });
  }
  return members;
}

function getHotelNameById(hotelId) {
  if (!hotelId) return 'Not linked';
  const hotel = db.prepare('SELECT name FROM hotels WHERE id = ?').get(hotelId);
  return hotel?.name || hotelId;
}

async function getProfileContext(guild, discordId) {
  const agent = db.prepare(`
    SELECT id, discord_id, username, role, team, hotel_id, phone, email, agent_status
    FROM agents
    WHERE discord_id = ?
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

  const appliedAt = pending?.requested_at || firstSession?.first_login || null;
  const email = agent.email || pending?.email || 'Not set';
  const phone = agent.phone || pending?.phone || 'Not set';

  return {
    agent,
    member,
    shortName,
    displayName,
    email,
    phone,
    appliedAt,
    pair,
    activeSession
  };
}

function buildProfileEmbed(profile) {
  const { agent, shortName, email, phone, appliedAt, pair, activeSession } = profile;
  const pairSummary = pair
    ? `${getHotelNameById(pair.primary_hotel_id)} + ${getHotelNameById(pair.secondary_hotel_id)}`
    : 'Not set';
  const activeSummary = activeSession
    ? `${getHotelNameById(activeSession.hotel_id)} since ${toDiscordDate(activeSession.login_time)}`
    : 'Not on an active shift';

  return new EmbedBuilder()
    .setTitle(`Profile • ${shortName}`)
    .setDescription('Approval-style agent profile card with direct management actions.')
    .addFields(
      { name: 'Agent Verified', value: 'Yes', inline: true },
      { name: 'Role', value: roleLabel(agent.role), inline: true },
      { name: 'Status', value: statusLabel(agent.agent_status), inline: true },
      { name: 'Discord', value: `<@${agent.discord_id}>\n\`${agent.discord_id}\``, inline: true },
      { name: 'Team', value: agent.team || 'Unassigned', inline: true },
      { name: 'Primary Hotel', value: getHotelNameById(agent.hotel_id), inline: true },
      { name: 'Email', value: email, inline: true },
      { name: 'Phone', value: phone, inline: true },
      { name: 'Applied', value: toDiscordDate(appliedAt), inline: true },
      { name: 'Shift Pair', value: pairSummary, inline: false },
      { name: 'Live Session', value: activeSummary, inline: false }
    )
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Operations • Agent Profile' })
    .setTimestamp();
}

function buildActionRows(profile) {
  const role = String(profile.agent.role || 'agent').toLowerCase();
  const roleIndex = ROLE_STEPS.indexOf(role);
  const promoteDisabled = roleIndex >= ROLE_STEPS.length - 1;
  const demoteDisabled = roleIndex <= 0;
  const targetDiscordId = profile.agent.discord_id;

  const buttonRow = new ActionRowBuilder().addComponents(
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
      .setCustomId(`profiles_kick:${targetDiscordId}`)
      .setLabel('Kick')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`profiles_ban:${targetDiscordId}`)
      .setLabel('Ban')
      .setStyle(ButtonStyle.Danger)
  );

  const miscMenu = new StringSelectMenuBuilder()
    .setCustomId(`profiles_misc:${targetDiscordId}`)
    .setPlaceholder('Misc actions')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Refresh Profile').setDescription('Reload current profile data').setValue('refresh'),
      new StringSelectMenuOptionBuilder().setLabel('Set Ready').setDescription('Mark agent as ready for live shifts').setValue('set_ready'),
      new StringSelectMenuOptionBuilder().setLabel('Set Standby').setDescription('Mark agent as standby').setValue('set_standby'),
      new StringSelectMenuOptionBuilder().setLabel('Reset PIN').setDescription('Generate a new PIN and DM the user').setValue('reset_pin')
    );

  const miscRow = new ActionRowBuilder().addComponents(miscMenu);
  return [buttonRow, miscRow];
}

function buildConfirmEmbed(action, discordId) {
  const label = action === 'ban' ? 'BAN' : 'KICK';
  return new EmbedBuilder()
    .setTitle(`Confirm ${label}`)
    .setDescription(`Are you sure you want to **${action}** <@${discordId}>?\n\nThis needs a second confirmation.`)
    .setColor(0xED4245)
    .setFooter({ text: 'Aavgo Operations • Safety Check' })
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

async function showProfileCard(interaction, discordId, notice = null) {
  const profile = await getProfileContext(interaction.guild, discordId);
  if (!profile) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Profile Not Found')
          .setDescription('That user is not registered as an agent in the database.')
          .setColor(0xED4245)
      ],
      components: []
    });
  }

  const embed = buildProfileEmbed(profile);
  if (notice) {
    embed.addFields({ name: 'Update', value: notice, inline: false });
  }

  return interaction.update({
    embeds: [embed],
    components: buildActionRows(profile)
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
    components: [buildTeamPickerRow()]
  };

  if (existingId) {
    const existing = await channel.messages.fetch(existingId).catch(() => null);
    if (existing) {
      await existing.edit(payload).catch(() => {});
      return existing;
    }
  }

  const message = await channel.send(payload);
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, message.id);
  return message;
}

async function handleSetupProfiles(interaction) {
  if (!canUsePanel(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  await ensureProfilesDashboard(interaction.client, PROFILES_CHANNEL_ID);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content: `✅ Profiles dashboard refreshed in <#${PROFILES_CHANNEL_ID}>.` });
  }

  return interaction.reply({ content: `✅ Profiles dashboard refreshed in <#${PROFILES_CHANNEL_ID}>.`, ephemeral: true });
}

async function handleTeamPick(interaction) {
  if (!canUsePanel(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  const teamName = interaction.values?.[0];
  if (!TEAM_KEYS.includes(teamName)) {
    return interaction.reply({ content: '❌ Invalid team selection.', ephemeral: true });
  }

  const members = await fetchTeamMembers(interaction.guild, teamName);
  const embed = buildTeamMembersEmbed(teamName, members);

  if (members.length === 0) {
    return interaction.reply({ embeds: [embed], components: [], ephemeral: true });
  }

  const row = buildMemberPickerRow(teamName, members);
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleAgentPick(interaction) {
  if (!canUsePanel(interaction)) {
    return interaction.update({ content: '❌ Developer access required.', embeds: [], components: [] });
  }

  const discordId = interaction.values?.[0];
  return showProfileCard(interaction, discordId);
}

async function handlePromote(interaction, discordId) {
  const agent = db.prepare('SELECT role FROM agents WHERE discord_id = ?').get(discordId);
  if (!agent) {
    return interaction.update({ content: '❌ Agent not found in database.', embeds: [], components: [] });
  }

  const newRole = nextRole(agent.role);
  db.prepare('UPDATE agents SET role = ? WHERE discord_id = ?').run(newRole, discordId);

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  await syncLeadershipDiscordRoles(member, newRole);

  return showProfileCard(interaction, discordId, `Role updated to **${roleLabel(newRole)}**.`);
}

async function handleDemote(interaction, discordId) {
  const agent = db.prepare('SELECT role FROM agents WHERE discord_id = ?').get(discordId);
  if (!agent) {
    return interaction.update({ content: '❌ Agent not found in database.', embeds: [], components: [] });
  }

  const newRole = previousRole(agent.role);
  db.prepare('UPDATE agents SET role = ? WHERE discord_id = ?').run(newRole, discordId);

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  await syncLeadershipDiscordRoles(member, newRole);

  return showProfileCard(interaction, discordId, `Role updated to **${roleLabel(newRole)}**.`);
}

async function handleKickOrBanConfirm(interaction, action, discordId) {
  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Action Failed')
          .setDescription('Member is no longer in this server.')
          .setColor(0xED4245)
      ],
      components: []
    });
  }

  const reason = `Profiles panel action by ${interaction.user.tag}`;
  if (action === 'ban') {
    await member.ban({ reason }).catch(() => {});
  } else {
    await member.kick(reason).catch(() => {});
  }

  return interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle(`✅ ${action === 'ban' ? 'Ban' : 'Kick'} Completed`)
        .setDescription(`<@${discordId}> was ${action === 'ban' ? 'banned' : 'kicked'} from the server.`)
        .setColor(0x57F287)
        .setTimestamp()
    ],
    components: []
  });
}

async function handleMisc(interaction, discordId) {
  const action = interaction.values?.[0];
  const agent = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get(discordId);
  if (!agent) {
    return interaction.update({ content: '❌ Agent not found in database.', embeds: [], components: [] });
  }

  if (action === 'refresh') {
    return showProfileCard(interaction, discordId, 'Profile refreshed.');
  }

  if (action === 'set_ready') {
    db.prepare("UPDATE agents SET agent_status = 'ready' WHERE discord_id = ?").run(discordId);
    return showProfileCard(interaction, discordId, 'Agent status set to **Ready**.');
  }

  if (action === 'set_standby') {
    db.prepare("UPDATE agents SET agent_status = 'standby' WHERE discord_id = ?").run(discordId);
    return showProfileCard(interaction, discordId, 'Agent status set to **Standby**.');
  }

  if (action === 'reset_pin') {
    const newPin = String(Math.floor(1000 + Math.random() * 9000));
    db.prepare('UPDATE agents SET pin = ? WHERE discord_id = ?').run(newPin, discordId);

    const member = await interaction.guild.members.fetch(discordId).catch(() => null);
    if (member) {
      await member.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Aavgo PIN Reset')
            .setDescription(`Your security PIN was reset by management.\n\nNew PIN: \`${newPin}\``)
            .setColor(0xF1C40F)
            .setTimestamp()
        ]
      }).catch(() => {});
    }

    return showProfileCard(interaction, discordId, 'PIN reset completed. The user has been notified by DM if possible.');
  }

  return showProfileCard(interaction, discordId);
}

async function handleButton(interaction) {
  if (!canUsePanel(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  const customId = interaction.customId || '';
  if (customId.startsWith('profiles_promote:')) {
    const discordId = customId.split(':')[1];
    return handlePromote(interaction, discordId);
  }

  if (customId.startsWith('profiles_demote:')) {
    const discordId = customId.split(':')[1];
    return handleDemote(interaction, discordId);
  }

  if (customId.startsWith('profiles_kick:')) {
    const discordId = customId.split(':')[1];
    return interaction.update({
      embeds: [buildConfirmEmbed('kick', discordId)],
      components: [buildConfirmRow('kick', discordId)]
    });
  }

  if (customId.startsWith('profiles_ban:')) {
    const discordId = customId.split(':')[1];
    return interaction.update({
      embeds: [buildConfirmEmbed('ban', discordId)],
      components: [buildConfirmRow('ban', discordId)]
    });
  }

  if (customId.startsWith('profiles_confirm:')) {
    const [, , action, discordId] = customId.split(':');
    if (!['kick', 'ban'].includes(action)) {
      return interaction.update({ content: '❌ Invalid confirmation action.', embeds: [], components: [] });
    }
    return handleKickOrBanConfirm(interaction, action, discordId);
  }

  if (customId.startsWith('profiles_cancel:')) {
    const discordId = customId.split(':')[1];
    return showProfileCard(interaction, discordId, 'Action canceled.');
  }

  return null;
}

async function handleSelectMenu(interaction) {
  if (interaction.customId === 'profiles_team_pick') {
    return handleTeamPick(interaction);
  }

  if (interaction.customId.startsWith('profiles_agent_pick:')) {
    return handleAgentPick(interaction);
  }

  if (interaction.customId.startsWith('profiles_misc:')) {
    const discordId = interaction.customId.split(':')[1];
    if (!canUsePanel(interaction)) {
      return interaction.update({ content: '❌ Developer access required.', embeds: [], components: [] });
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
