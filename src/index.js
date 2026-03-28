require('dotenv').config();
const path = require('path');
const { Client, GatewayIntentBits, Collection, REST, Routes, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { registerCommands } = require('./commands');
const db = require('./database');
const auth = require('./auth');
const tools = require('./tools');
const profilePanel = require('./profilePanel');
const { upsertBotStatusCard } = require('./botStatus');
const REAL_NAME_TUTORIAL_DIR = path.join(__dirname, 'assets', 'real-name-tutorial');
const NEWCOMER_CHANNEL_ID = '1482259779991764992';
const OPERATIONS_MANAGER_ROLE_ID = '1482226842047090809';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
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
        await auth.syncAgentRecordFromDiscordMember(member, guild, 'ROLE SYNC WATCH');
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
    content: `<@&${OPERATIONS_MANAGER_ROLE_ID}>`,
    embeds: [embed],
    allowedMentions: { roles: [OPERATIONS_MANAGER_ROLE_ID] }
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

// Initialized inside ready event to avoid blocking startup
client.once('ready', async () => {
    console.log(`[DISCORD] Ready! Logged in as ${client.user.tag}`);
    
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
    
    // Start Scheduler Loop (Every 5 minutes)
    setInterval(() => {
      auth.checkSchedules(client);
    }, 5 * 60000);

    // Overtime enforcement loop (every 1 minute):
    // warn at 8h, auto-logout after 5 minutes, cap recorded time to 8h.
    setInterval(() => {
      auth.monitorOvertimeSessions(client);
    }, 60 * 1000);
    
    // Initial check on boot
    auth.checkSchedules(client);
    auth.monitorOvertimeSessions(client).catch(error => {
      console.warn('[OVERTIME] Initial monitor pass failed:', error.message);
    });
    auth.broadcastUpdateLog(client).catch(error => {
      console.warn('[UPDATE-LOG] Startup broadcast failed:', error.message);
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
    const commands = require('./commands').commandData;
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const guildId = '1482220918355922974'; // Aavgo Server ID
    
    console.log('Started refreshing application (/) commands.');
    
    // Clear global commands
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    
    // Register guild commands
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands for Guild:', guildId);
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

  await sendRealNameTutorial(member);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const traineeRoleId = '1484705126026449029';
    const agentRoleId = '1482227287159078964';
    const applicantsRoleId = '1484919969689894912';

    const gainedTrainee = !oldMember.roles.cache.has(traineeRoleId) && newMember.roles.cache.has(traineeRoleId);
    const gainedAgent = !oldMember.roles.cache.has(agentRoleId) && newMember.roles.cache.has(agentRoleId);

    const applicantsRole = newMember.guild.roles.cache.get(applicantsRoleId) || newMember.guild.roles.cache.find(r => r.name.toLowerCase() === 'applicants');
    if ((gainedTrainee || gainedAgent) && applicantsRole && newMember.roles.cache.has(applicantsRole.id)) {
      await newMember.roles.remove(applicantsRole);
      console.log(`[ROLE SYNC] Removed Applicants role from ${newMember.user.username} after promotion`);
    }

    await auth.syncAgentRecordFromDiscordMember(newMember, newMember.guild, 'ROLE SYNC UPDATE');
  } catch (error) {
    console.warn('[ROLE SYNC] Failed to process member role update:', error.message);
  }
});

client.on('guildMemberRemove', async member => {
  await auth.handleMemberLeave(member);
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
  let autoAckTimer = null;
  try {
  if (interaction.isChatInputCommand()) {
    autoAckTimer = setTimeout(async () => {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ ephemeral: true });
        }
      } catch (ackErr) {
        console.warn('[INTERACTION] Auto-defer failed:', ackErr.message);
      }
    }, 1500);
  }
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'login') {
      await auth.handleLogin(interaction);
    } else if (commandName === 'logout') {
      await auth.handleLogout(interaction);
    } else if (commandName === 'status') {
      await auth.handleStatus(interaction);
    } else if (commandName === 'setup-login') {
      await auth.handleSetupLogin(interaction);
    } else if (commandName === 'setup-login-team') {
      await auth.handleSetupLoginTeam(interaction);
    } else if (commandName === 'setup-register') {
      await interaction.reply({ content: '⛔ Registration is disabled. Use `/add-agent` for onboarding.', ephemeral: true });
    } else if (commandName === 'register') {
      await interaction.reply({ content: '⛔ Self-registration is disabled. Please ask Operations Manager or Developer to run `/add-agent`.', ephemeral: true });
    } else if (commandName === 'add-agent') {
      await auth.handleAddAgent(interaction);
    } else if (commandName === 'reset-pin') {
      await auth.handleResetPin(interaction);
    } else if (commandName === 'setup-security') {
      await auth.handleSetupSecurity(interaction);
    } else if (commandName === 'setup-profiles') {
      await profilePanel.handleSetupProfiles(interaction);
    } else if (commandName === 'remove-agent') {
      await auth.handleRemoveAgentCommand(interaction);
    } else if (commandName === 'check-hours') {
      await auth.handleCheckHours(interaction);
    } else if (commandName === 'add-hours') {
      await auth.handleAddHours(interaction);
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
    } else if (commandName === 'help-agent') {
      await auth.handleHelpAgent(interaction);
    } else if (commandName === 'limit-warning') {
      await auth.handleLimitWarning(interaction);
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
    } else if (interaction.customId.startsWith('bio_deny_modal_')) {
      await tools.handleBioDenySubmit(interaction);
    } else if (interaction.customId.startsWith('loginmodal_')) {
      await auth.handleModalSubmit(interaction);
    } else if (interaction.customId.startsWith('newcomer_agent_pin_modal:')) {
      await auth.handleNewcomerAgentPinSubmit(interaction);
    }
  } else if (interaction.isButton()) {
    if (interaction.customId.startsWith('profiles_')) {
      await profilePanel.handleButton(interaction);
    } else if (interaction.customId === 'start_shift_btn') {
      await auth.handleShiftRolePrompt(interaction);
    } else if (interaction.customId === 'shift_role_agent_btn') {
      await auth.handleAgentRoutePick(interaction);
    } else if (interaction.customId === 'shift_role_team_leader_btn') {
      await auth.handleManagementRoutePick(interaction, 'Team Leader');
    } else if (interaction.customId === 'shift_role_sme_btn') {
      await auth.handleManagementRoutePick(interaction, 'SME');
    } else if (interaction.customId === 'shift_mgmt_team_1_btn') {
      await auth.handleManagementTeamStart(interaction, 'Team 1');
    } else if (interaction.customId === 'shift_mgmt_team_2_btn') {
      await auth.handleManagementTeamStart(interaction, 'Team 2');
    } else if (interaction.customId === 'shift_mode_hotel_btn' || interaction.customId === 'start_shift_multi_confirm_btn') {
      await auth.handleStartShiftClick(interaction);
    } else if (interaction.customId === 'training_start_btn') {
      await auth.handleTrainingStartClick(interaction);
    } else if (interaction.customId.startsWith('agent_shift_confirm_yes:') || interaction.customId === 'agent_shift_confirm_no') {
      await auth.handleAgentShiftStartConfirm(interaction);
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
    } else if (interaction.customId.startsWith('dev_approve_')) {
      await auth.handleDevApprove(interaction);
    } else if (interaction.customId.startsWith('dev_deny_')) {
      await auth.handleDevDeny(interaction);
    } else if (interaction.customId === 'tl_start_shift_btn' || interaction.customId === 'tl_start_shift_multi_confirm_btn') {
      await auth.handleStartShiftClick(interaction);
    } else if (interaction.customId === 'tl_logout_btn') {
      await auth.handleLogout(interaction);
    } else if (interaction.customId.startsWith('activity_')) {
      await auth.handleActivityClick(interaction);
    }
  } else if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('profiles_')) {
      await profilePanel.handleSelectMenu(interaction);
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
    if (autoAckTimer) clearTimeout(autoAckTimer);
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


