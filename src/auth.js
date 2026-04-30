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
const { calculateAgentHourTotals, buildPeriodHourHistory, formatHoursClock } = require('./hours');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createTestUiHandlers } = require('./testui');

const ATTENDANCE_CHANNEL_ID = '1489840627209470022';
const ATTENDANCE_PROTOTYPE_CHANNEL_ID = '1494866014461104128';
const ATTENDANCE_CLOCK_EMOJI = '⏰';
const ATTENDANCE_CHECK_EMOJI = '✅';
const ATTENDANCE_TADA_EMOJI = '🎉';
const ATTENDANCE_HEART_EMOJI = '❤️';
const attendanceMessageByUserId = new Map();
const attendanceReactionTimersByUserId = new Map();

function isAttendanceMessageChannel(channelId) {
  const normalizedChannelId = String(channelId || '').trim();
  return normalizedChannelId === ATTENDANCE_CHANNEL_ID || normalizedChannelId === ATTENDANCE_PROTOTYPE_CHANNEL_ID;
}

function parseAttendanceAction(content) {
  const text = String(content || '');
  const hasLogin = /\blog\s*in\b/i.test(text) || /\blogin\b/i.test(text);
  const hasLogout = /\blog\s*out\b/i.test(text) || /\blogout\b/i.test(text);
  if (hasLogout) return 'logout';
  if (hasLogin) return 'login';
  return null;
}

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

function rememberAttendanceMessage(message) {
  const userId = String(message?.author?.id || '').trim();
  if (!userId || !message?.id) return;
  attendanceMessageByUserId.set(userId, {
    channelId: String(message.channelId || ''),
    messageId: String(message.id),
    guildId: String(message.guildId || ''),
    createdAt: Date.now()
  });
}

function clearAttendanceReactionTimer(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return false;

  const existing = attendanceReactionTimersByUserId.get(normalizedUserId) || null;
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  attendanceReactionTimersByUserId.delete(normalizedUserId);
  return true;
}

async function fetchAttendanceMessageForUser(client, userId, channelId = ATTENDANCE_CHANNEL_ID) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedChannelId = String(channelId || '').trim();
  if (!client || !normalizedUserId) return null;

  const cachedRef = attendanceMessageByUserId.get(normalizedUserId) || null;
  if (cachedRef?.messageId && cachedRef.channelId === normalizedChannelId) {
    const cachedChannel = await client.channels.fetch(cachedRef.channelId).catch(() => null);
    if (cachedChannel && cachedChannel.messages && typeof cachedChannel.messages.fetch === 'function') {
      const cachedMessage = await cachedChannel.messages.fetch(cachedRef.messageId).catch(() => null);
      if (cachedMessage) {
        return cachedMessage;
      }
    }
  }

  const attendanceChannel = await client.channels.fetch(normalizedChannelId).catch(() => null);
  if (!attendanceChannel || typeof attendanceChannel.messages?.fetch !== 'function') return null;

  const recentMessages = await attendanceChannel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!recentMessages) return null;

  return recentMessages.find(message => String(message?.author?.id || '') === normalizedUserId) || null;
}

function getAttendanceShiftState(discordId) {
  const normalizedDiscordId = String(discordId || '').trim();
  if (!normalizedDiscordId) return null;

  const agent = db.prepare('SELECT id FROM agents WHERE discord_id = ?').get(normalizedDiscordId);
  if (!agent?.id) return null;

  const activeSession = db.prepare(`
    SELECT id, login_time, session_kind, hotel_id
    FROM sessions
    WHERE agent_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(agent.id) || null;

  const nextSchedule = db.prepare(`
    SELECT id, start_time, hotel_id, status
    FROM schedules
    WHERE agent_id = ? AND status = 'pending'
    ORDER BY datetime(start_time) ASC, id ASC
    LIMIT 1
  `).get(agent.id) || null;

  let minutesUntilShift = null;
  if (nextSchedule?.start_time) {
    const startMs = new Date(nextSchedule.start_time).getTime();
    if (Number.isFinite(startMs)) {
      minutesUntilShift = Math.round((startMs - Date.now()) / 60000);
    }
  }

  return {
    activeSession,
    nextSchedule,
    minutesUntilShift
  };
}

async function reactToLatestAttendanceMessage(client, userId, emoji) {
  const message = await fetchAttendanceMessageForUser(client, userId);
  if (!message) return false;

  try {
    await message.react(emoji);
    return true;
  } catch (error) {
    console.warn(`[ATTENDANCE] Failed to react with ${emoji} for ${userId}:`, error.message);
    return false;
  }
}

async function flipAttendanceLoginReaction(client, userId, channelId = ATTENDANCE_CHANNEL_ID) {
  const message = await fetchAttendanceMessageForUser(client, userId, channelId);
  if (!message) return false;

  try {
    const clockReaction = message.reactions?.cache?.find(reaction => reaction?.emoji?.name === ATTENDANCE_CLOCK_EMOJI) || null;
    if (clockReaction?.users?.remove && client?.user?.id) {
      await clockReaction.users.remove(client.user.id).catch(() => {});
    }
    await message.react(ATTENDANCE_CHECK_EMOJI);
    return true;
  } catch (error) {
    console.warn(`[ATTENDANCE] Failed to flip login reaction for ${userId}:`, error.message);
    return false;
  }
}

function scheduleAttendanceReactionFlip(message, targetMs) {
  const userId = String(message?.author?.id || '').trim();
  const channelId = String(message?.channelId || '').trim();
  if (!userId || !channelId) return false;

  clearAttendanceReactionTimer(userId);

  const dueMs = Number(targetMs);
  if (!Number.isFinite(dueMs)) return false;

  const delayMs = Math.max(0, dueMs - Date.now());
  const run = async () => {
    attendanceReactionTimersByUserId.delete(userId);
    await flipAttendanceLoginReaction(message.client, userId, channelId).catch(error => {
      console.warn(`[ATTENDANCE] Scheduled reaction flip failed for ${userId}:`, error.message);
    });
  };

  if (delayMs <= 0) {
    run();
    return true;
  }

  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  attendanceReactionTimersByUserId.set(userId, { timer, channelId, targetMs: dueMs });
  return true;
}

async function processAttendanceMessage(message, options = {}) {
  if (!message?.guild || message?.author?.bot) return null;
  if (!isAttendanceMessageChannel(message.channelId)) return null;

  rememberAttendanceMessage(message);

  const action = parseAttendanceAction(message.content);
  const state = getAttendanceShiftState(message.author.id);
  if (!state) return null;

  const previewOnly = options?.previewOnly === true;
  const hasActiveSession = previewOnly ? false : Boolean(state.activeSession);
  const nowMs = Number.isFinite(Number(options?.nowMs)) ? Number(options.nowMs) : Date.now();
  const targetMs = Number.isFinite(Number(options?.targetMs)) ? Number(options.targetMs) : null;
  const minutesUntilShift = previewOnly && Number.isFinite(targetMs)
    ? Math.round((targetMs - nowMs) / 60000)
    : Number(state.minutesUntilShift);
  const isPreShiftWindow = previewOnly
    ? Number.isFinite(minutesUntilShift) && minutesUntilShift > 0
    : Number.isFinite(minutesUntilShift) && minutesUntilShift > 0 && minutesUntilShift <= 30;
  const isShiftDueOrPast = Number.isFinite(minutesUntilShift) && minutesUntilShift <= 0;

  try {
    if (action === 'logout') {
      clearAttendanceReactionTimer(message.author.id);
      await message.react(ATTENDANCE_TADA_EMOJI);
    } else if (hasActiveSession || isShiftDueOrPast) {
      clearAttendanceReactionTimer(message.author.id);
      await message.react(ATTENDANCE_CHECK_EMOJI);
    } else if (isPreShiftWindow) {
      await message.react(ATTENDANCE_CLOCK_EMOJI);
      if (Number.isFinite(targetMs) && targetMs > nowMs) {
        scheduleAttendanceReactionFlip(message, targetMs);
      }
    }
  } catch (error) {
    console.warn('[ATTENDANCE] Failed to add attendance reaction:', error.message);
  }

  if (Math.random() < 0.01) {
    await message.reply({
      content: ATTENDANCE_HEART_EMOJI,
      allowedMentions: { repliedUser: false }
    }).catch(error => {
      console.warn('[ATTENDANCE] Failed to send heart easter egg:', error.message);
    });
  }

  return state;
}

async function safeDeferComponentUpdate(interaction) {
  if (!interaction || interaction.deferred || interaction.replied) return;
  await interaction.deferUpdate().catch(() => {});
}

function sendComponentUpdate(interaction, payload) {
  const isEphemeralResult = isEphemeralSourceInteraction(interaction) || payload?.ephemeral === true;
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload).then(message => {
      maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralResult);
      return message;
    });
  }
  return interaction.update({ ...payload, fetchReply: true }).then(message => {
    maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralResult);
    return message;
  });
}

function sendComponentReply(interaction, payload) {
  const isEphemeralResult =
    isEphemeralSourceInteraction(interaction) ||
    payload?.ephemeral === true ||
    payload?.flags === MessageFlags.Ephemeral;
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ ...payload, fetchReply: true }).then(message => {
      maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralResult);
      return message;
    });
  }
  return interaction.reply({ ...payload, fetchReply: true }).then(message => {
    maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralResult);
    return message;
  });
}

function isEphemeralSourceInteraction(interaction) {
  try {
    if (interaction?.__aavgoEphemeral === true) return true;
    if (interaction?.ephemeral === true) return true;
    return Boolean(interaction?.message?.flags?.has?.(MessageFlags.Ephemeral));
  } catch (_) {
    return false;
  }
}

async function sendPrivateFlowPayload(interaction, payload) {
  const forcePrivateReply = interaction?.customId === 'start_shift_btn';
  const privatePayload = { ...payload, ephemeral: true };
  try {
    if (forcePrivateReply) {
      if (interaction.deferred || interaction.replied) {
        if (typeof interaction.followUp === 'function') {
          const message = await interaction.followUp({ ...privatePayload, fetchReply: true });
          maybeScheduleEphemeralCleanup(interaction, privatePayload, message, true);
          return message;
        }
        const message = await interaction.editReply(payload);
        maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralSourceInteraction(interaction));
        return message;
      }
      const message = await interaction.reply({ ...privatePayload, fetchReply: true });
      maybeScheduleEphemeralCleanup(interaction, privatePayload, message, true);
      return message;
    }

    if (interaction.deferred || interaction.replied) {
      if (!isEphemeralSourceInteraction(interaction) && typeof interaction.followUp === 'function') {
        const message = await interaction.followUp({ ...privatePayload, fetchReply: true });
        maybeScheduleEphemeralCleanup(interaction, privatePayload, message, true);
        return message;
      }
      const message = await interaction.editReply(payload);
      maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralSourceInteraction(interaction));
      return message;
    }

    if (isEphemeralSourceInteraction(interaction) && typeof interaction.update === 'function') {
      const message = await interaction.update({ ...payload, fetchReply: true });
      maybeScheduleEphemeralCleanup(interaction, payload, message, true);
      return message;
    }

    const message = await interaction.reply({ ...privatePayload, fetchReply: true });
    maybeScheduleEphemeralCleanup(interaction, privatePayload, message, true);
    return message;
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[FLOW] Skipped expired interaction while sending private payload (10062).');
      return null;
    }
    throw error;
  }
}

const EPHEMERAL_IMPORTANT_TTL_MS = 5 * 60 * 1000;
const EPHEMERAL_QUICK_TTL_MS = 30 * 1000;
const loginFlowEphemeralByUser = new Map();

function shouldTrackLoginFlowEphemeral(interaction) {
  const customId = String(interaction?.customId || '').toLowerCase();
  return (
    customId.startsWith('start_shift') ||
    customId.startsWith('shift_') ||
    customId.startsWith('agent_shift_') ||
    customId.startsWith('same_hotel_confirm_') ||
    customId.startsWith('loginmodal_') ||
    customId === 'hotel_link_start_yes_btn' ||
    customId === 'hotel_link_start_no_btn'
  );
}

function trackLoginFlowEphemeral(interaction, message) {
  if (!message?.id || !interaction?.user?.id) return;
  if (!shouldTrackLoginFlowEphemeral(interaction)) return;
  const userId = interaction.user.id;
  const tracked = loginFlowEphemeralByUser.get(userId) || new Set();
  tracked.add(message.id);
  loginFlowEphemeralByUser.set(userId, tracked);
}

function clearTrackedLoginFlowEphemeral(interaction, keepMessageIds = []) {
  if (!interaction?.user?.id || !interaction?.webhook?.deleteMessage) return;
  const tracked = loginFlowEphemeralByUser.get(interaction.user.id);
  if (!tracked || tracked.size === 0) return;

  const keep = new Set((keepMessageIds || []).filter(Boolean));
  for (const messageId of [...tracked]) {
    if (keep.has(messageId)) continue;
    interaction.webhook.deleteMessage(messageId).catch(() => {});
    tracked.delete(messageId);
  }

  if (tracked.size === 0) {
    loginFlowEphemeralByUser.delete(interaction.user.id);
  } else {
    loginFlowEphemeralByUser.set(interaction.user.id, tracked);
  }
}

function payloadHasInteractiveComponents(payload) {
  if (!Array.isArray(payload?.components) || payload.components.length === 0) return false;
  return payload.components.some(row => {
    const components = row?.components || row?.data?.components;
    return Array.isArray(components) && components.length > 0;
  });
}

function collectPayloadText(payload) {
  const parts = [];
  if (typeof payload?.content === 'string') parts.push(payload.content);
  if (Array.isArray(payload?.embeds)) {
    for (const embed of payload.embeds) {
      const source = embed?.data || embed || {};
      if (typeof source.title === 'string') parts.push(source.title);
      if (typeof source.description === 'string') parts.push(source.description);
      if (Array.isArray(source.fields)) {
        for (const field of source.fields) {
          if (typeof field?.name === 'string') parts.push(field.name);
          if (typeof field?.value === 'string') parts.push(field.value);
        }
      }
      if (typeof source?.footer?.text === 'string') parts.push(source.footer.text);
    }
  }
  return parts.join(' ').toLowerCase();
}

function getEphemeralCleanupDelayMs(payload) {
  if (payloadHasInteractiveComponents(payload)) {
    return EPHEMERAL_IMPORTANT_TTL_MS;
  }

  const text = collectPayloadText(payload);
  if (!text) return EPHEMERAL_IMPORTANT_TTL_MS;

  const importantPattern = /(select|choose|confirm|setup|pin|security|team|required|must|warning|access denied|instruction|guide|information|invalid|incorrect|failed|error|not found)/i;
  if (importantPattern.test(text)) {
    return EPHEMERAL_IMPORTANT_TTL_MS;
  }

  const quickPattern = /(success|shift is now live|shift ended|training ended|logout|logged out|cancelled|saved|updated|recorded|completed|done|refreshed|removed|promoted|demoted)/i;
  if (quickPattern.test(text)) {
    return EPHEMERAL_QUICK_TTL_MS;
  }

  return EPHEMERAL_IMPORTANT_TTL_MS;
}

function maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralResult = false) {
  if (!interaction || !isEphemeralResult) return;
  trackLoginFlowEphemeral(interaction, message);
  const delayMs = getEphemeralCleanupDelayMs(payload);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;

  const timer = setTimeout(async () => {
    try {
      if (message?.id && interaction?.webhook?.deleteMessage) {
        await interaction.webhook.deleteMessage(message.id).catch(() => {});
        return;
      }
      if (typeof interaction.deleteReply === 'function') {
        await interaction.deleteReply().catch(() => {});
      }
    } catch (_) {}
  }, delayMs);
  timer.unref?.();
}

function scheduleExplicitReplyCleanup(interaction, delayMs = EPHEMERAL_QUICK_TTL_MS) {
  if (!interaction || typeof interaction.deleteReply !== 'function') return;
  const timer = setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, delayMs);
  timer.unref?.();
}

// ─── Constants ───────────────────────────────────────
const ROLE_NAMES = {
  ON_SHIFT: 'On-Shift',
  LOGGED_OUT: 'Logged Out',
  AGENTS: 'Agents',
  TEAM_1: 'Team 1',
  TEAM_2: 'Team 2',
  TEAM_3: 'Team 3',
  TEAM_4: 'Team 4',
  TEAM_5: 'Team 5',
  // Green (On-Shift / Permission) Roles
  GREEN: {
    'BW_TO': '1482227783232000070',
    'GICP': '1484531060699168778',
    'SUP8': '1482227848440971408',
    'RMDA': '1483418491464843345',
    'AD1': '1483418531180843049',
    'TRVL': '1484858995150684170',
    'DIBS': '1482227230343041115',
    'PROS': '1489855054134640740',
    'GLDL': '1491275580706918460',
    'INFL': '1491280813810126939',
    'VALS': '1491280729982898317',
    'BAYT': '1491280851785355284',
    'ANPI': '1491280889026449589',
    'ECON': '1491280957859434576',
    'BUEN': '1491281133323681792',
    'QI_RV': '1491281264647344268',
    'THOK': '1493532824362418186',
    'BRNT': '1494529686590718072',
    'PARM': '1498675612053798973',
    'MYAL': '1498676610986147940',
    'SAGE': '1498676814699303005',
    'ZICO': '1498676933527863488',
    'WGFR': '1498677107847467058',
    'BWSF': '1498677251510767676',
    'LQST': '1498677256854311003',
    'LQFR': '1498677411686912000',
    'BWVI': '1498677448617885796',
    'LIVE': '1498677720555454545'
  },
  // Grey (Permanent / Assignment) Roles
  GREY: {
    'BW_TO': '1483429969807020032',
    'GICP': '1484531611549831189',
    'SUP8': '1483430096013623427',
    'RMDA': '1483430118016684135',
    'AD1': '1483430144449187923',
    'TRVL': '1484859243671847114',
    'DIBS': '1483430045153362012',
    'PROS': '1489855140767993997',
    'GLDL': '1491275580706918460',
    'INFL': '1491280813810126939',
    'VALS': '1491280729982898317',
    'BAYT': '1491280851785355284',
    'ANPI': '1491280889026449589',
    'ECON': '1491280957859434576',
    'BUEN': '1491281133323681792',
    'QI_RV': '1491281264647344268',
    'THOK': '1493532824362418186',
    'BRNT': '1494529686590718072',
    'PARM': '1498675612053798973',
    'MYAL': '1498676610986147940',
    'SAGE': '1498676814699303005',
    'ZICO': '1498676933527863488',
    'WGFR': '1498677107847467058',
    'BWSF': '1498677251510767676',
    'LQST': '1498677256854311003',
    'LQFR': '1498677411686912000',
    'BWVI': '1498677448617885796',
    'LIVE': '1498677720555454545'
  }
};

// Map hotel IDs to display names
const HOTEL_NAMES = {
  'BW_TO': 'Magnuson / Ironwood',
  'GICP': 'Garden Inn and the Campground',
  'SUP8': 'Super 8 / Ramada',
  'RMDA': 'Ramada',
  'AD1': 'AD1',
  'TRVL': 'Travelodge',
  'DIBS': 'Days Inn Bishop',
  'PROS': 'Flagship',
  'GLDL': 'Glendale / The Leef Hotel',
  'INFL': 'Inn at the Fingerlakes',
  'VALS': 'Value Suites',
  'BAYT': 'Town House / Bayside',
  'ANPI': 'Anchor Beach / Pacific Inn',
  'ECON': 'Econolodge',
  'BUEN': 'Buenavista Inn',
  'QI_RV': 'Quality Russelville',
  'THOK': 'Thousand Oaks',
  'BRNT': 'Brentwood Inn',
  'PARM': 'Parmani',
  'MYAL': 'Mylo / Alpine',
  'SAGE': 'Sage',
  'ZICO': 'Hotel Zico',
  'WGFR': 'Wyndham Garden Fresno',
  'BWSF': 'Brentwood Springfield',
  'LQST': 'La Quinta Stockton',
  'LQFR': 'La Quinta Fresno',
  'BWVI': 'Brentwood Visalia',
  'LIVE': 'The Live Hotel'
};
const HOTEL_SELECT_EMOJIS = {
  BW_TO: '🏙️',
  GICP: '🏨',
  SUP8: '✴️',
  RMDA: '🛖',
  AD1: '📞',
  TRVL: '🏩',
  DIBS: '🏨',
  PROS: '🏁'
};
// Map hotel IDs to log-in channel IDs
const HOTEL_LOGIN_CHANNELS = {
  'BW_TO': '1482303551614095441',
  'GICP': '1484531330308903005',
  'SUP8': '1483417977859870881',
  'RMDA': '1483417977859870881',
  'AD1': '1487252636959772702',
  'TRVL': '1483418055538376735',
  'DIBS': '1487250154099703839',
  'PROS': '1482249025016168448',
  'PARM': '1498685993497268295',
  'MYAL': '1498686882614345799',
  'ZICO': '1498687419640320132',
  'SAGE': '1496542198991163583',
  'WGFR': '1498687516797304983',
  'BWSF': '1498687724373278840',
  'LQST': '1498687667074760835',
  'LQFR': '1498687808334987394',
  'BWVI': '1498687859912081570',
  'LIVE': '1498687904225034402'
};

const APPROVAL_CHANNEL_ID = '1482240202503098398';
const PROMOTION_REVIEW_CHANNEL_ID = '1483405048309354497';
const MANUAL_HOURS_LOG_CHANNEL_ID = PROMOTION_REVIEW_CHANNEL_ID;
const AUDIT_LOG_CHANNEL_ID = '1482239767134339182';
const SHIFT_ACTIVITY_LOG_CHANNEL_ID = '1484192529485140099';
const TEAM_1_LOG_CHANNEL_ID = '1482383356753612991';
const TEAM_2_OPERATIONS_CHANNEL_ID = '1482249025016168448';
const TEAM_2_HOTEL_STATUS_CHANNEL_ID = '1489862372867965141';
const TEAM_3_OPERATIONS_CHANNEL_ID = '1482222166656417843';
const TEAM_3_HOTEL_STATUS_CHANNEL_ID = '1482222166656417843';
const TEAM_3_LOG_CHANNEL_ID = '1491285753978949662';
const TEAM_4_HOTEL_STATUS_CHANNEL_ID = '1482222215184519360';
const TEAM_4_LOG_CHANNEL_ID = '1498683972895637525';
const TEAM_5_HOTEL_STATUS_CHANNEL_ID = '1498685179726921788';
const TEAM_5_LOG_CHANNEL_ID = '1498685207723638915';
const PROSPERO_LOG_CHANNEL_ID = '1482383371320430592';
const TEAM_2_PERMISSION_ROLE_ID = '1489855054134640740';
const TEAM_2_GHOST_ROLE_ID = '1489855140767993997';
const TEAM_3_PERMISSION_ROLE_ID = '1482290586831552534';
const TEAM_3_GHOST_ROLE_ID = '1491291007365414963';
const TL_PORTAL_CHANNEL_ID = '1484878480046031099';
const TL_STATUS_CHANNEL_ID = '1486347360417349682';
const TRAINING_STATUS_CHANNEL_ID = '1486623221225750660';
const TRAINING_LOG_CHANNEL_ID = '1488041967769358369';
const TRAINING_SESSION_ROLE_ID = '1493765270928621648';
const HOTEL_STATUS_CHANNEL_ID = '1487355252398100601';
const LOGIN_CHANNEL_ID = '1482228169485582446';
const QUEUE_ROLE_ID = '1495308576565231637';
const NEWCOMER_CHANNEL_ID = '1482259779991764992';
const APPLICANT_ROLE_ID = '1484919969689894912';
const AGENT_ROLE_ID = '1482227287159078964';
const TRAINEE_ROLE_ID = '1484705126026449029';
const SME_ROLE_ID = '1482382342621233153';
const TEAM_LEADER_ROLE_ID = '1482732583660818636';
const OPERATIONS_MANAGER_DISCORD_ROLE_ID = '1482226842047090809';
const DEVELOPER_DISCORD_ROLE_ID = '1482312134875418737';
const NO_PIN_ROLE_ID = '1485275671797436620';
const SUPPORT_ROLE_ID = '1498249599780126791';
const DEVELOPER_FALLBACK_IDS = ['320128931971727360', '1186978205018632242'];
const PROMOTION_REQUEST_KEY_PREFIX = 'PROMOTE';
const OVERTIME_WARNING_MS = 8 * 60 * 60 * 1000;
const OVERTIME_FINAL_LIMIT_MS = 12 * 60 * 60 * 1000;
const OVERTIME_CONFIRM_GRACE_MS = 15 * 60 * 1000;
const OVERTIME_AUTO_LOGOUT_MS = OVERTIME_WARNING_MS + OVERTIME_CONFIRM_GRACE_MS;
const OVERTIME_TEST_WARNING_MS = 3 * 60 * 1000;
const TEST_ROLE_ID = '1487369607772766208';
const TEAM_ROLE_IDS = {
  'Team 1': '1482290433236402216',
  'Team 2': '1482255399510872105',
  'Team 3': '1482290586831552534',
  'Team 4': '1498676979413553192',
  'Team 5': '1498677499058716785'
};
const TEAM_LOG_CHANNEL_IDS = {
  'Team 1': '1482383356753612991',
  'Team 2': '1482383371320430592',
  'Team 3': '1491285753978949662',
  'Team 4': '1498683972895637525',
  'Team 5': '1498685207723638915'
};
const NOTIFICATION_ROLE_ID = '1491273475086876862';
const OVERTIME_8H_LOG_CHANNEL_ID = '1491058569506717909';
const OVERTIME_12H_LOG_CHANNEL_ID = '1491058367148457984';
const overtimeWarnedSessionIds = new Set();
const overtimeAutoLogoutAgentIds = new Set();
const overtimeConfirmedSessionIds = new Set();
let combinedHotelStatusRefreshTimer = null;
const missingHotelStatusChannelWarnings = new Set();
const EXCLUSIVE_RANK_ROLE_PRIORITY = [
  TEAM_LEADER_ROLE_ID,
  SME_ROLE_ID,
  AGENT_ROLE_ID,
  TRAINEE_ROLE_ID,
  APPLICANT_ROLE_ID
];

const TEAM_1_HOTELS = ['DIBS', 'SUP8', 'RMDA', 'PARM', 'ECON', 'QI_RV', 'BUEN', 'TRVL'];
const TEAM_2_HOTELS = ['VALS', 'INFL', 'ANPI', 'BAYT', 'GLDL'];
const TEAM_3_HOTELS = ['MYAL', 'PROS', 'SAGE', 'AD1', 'ZICO'];
const TEAM_4_HOTELS = ['WGFR', 'THOK', 'BWSF', 'LQST', 'LQFR', 'BWVI'];
const TEAM_5_HOTELS = ['LIVE', 'GICP', 'BRNT', 'BW_TO'];
const TEAM_NAMES = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5'];
const ON_SHIFT_CALL_CHANNEL_IDS = {
  'Team 1': ['1482225371398017044', '1493674598233804842', '1493890379857133628'],
  'Team 2': ['1482249225398915102', '1493674469980377088', '1493890419543638107'],
  'Team 3': ['1482225519977041981', '1493763350448963615', '1493890481363484755']
};
const CROSS_TEAM_ON_SHIFT_CALL_CHANNEL_IDS = [
  '1494450800288596028',
  '1494450820920643605',
  '1494450845264248843',
  '1494450867057725642',
  '1494450888813580521'
];
const TRAINING_CALL_CHANNEL_IDS = [
  '1484706127685091415',
  '1484854340249190422',
  '1484854380254466058',
  '1484854396717236244',
  '1495013995088969798'
];
const TL_SME_CALL_CHANNEL_ID = '1493764447309795368';
const TRAINING_HOTEL_GROUPS = [
  { label: 'Magnuson / Ironwood', hotelIds: ['BW_TO'] },
  { label: 'Garden Inn and the Campground', hotelIds: ['GICP'] },
  { label: 'Ramada / Super 8', hotelIds: ['RMDA', 'SUP8'] },
  { label: 'Days Inn Bishop', hotelIds: ['DIBS'] },
  { label: 'Parmani', hotelIds: ['PARM'] },
  { label: 'Econolodge', hotelIds: ['ECON'] },
  { label: 'Quality Russelville', hotelIds: ['QI_RV'] },
  { label: 'Buenavista Inn', hotelIds: ['BUEN'] },
  { label: 'Travelodge', hotelIds: ['TRVL'] },
  { label: 'Value Suites', hotelIds: ['VALS'] },
  { label: 'Inn at the Fingerlakes', hotelIds: ['INFL'] },
  { label: 'Anchor Beach / Pacific Inn', hotelIds: ['ANPI'] },
  { label: 'Town House / Bayside', hotelIds: ['BAYT'] },
  { label: 'Glendale / The Leef Hotel', hotelIds: ['GLDL'] },
  { label: 'Mylo / Alpine', hotelIds: ['MYAL'] },
  { label: 'Flagship', hotelIds: ['PROS'] },
  { label: 'Sage', hotelIds: ['SAGE'] },
  { label: 'AD1', hotelIds: ['AD1'] },
  { label: 'Hotel Zico', hotelIds: ['ZICO'] },
  { label: 'Wyndham Garden Fresno', hotelIds: ['WGFR'] },
  { label: 'Thousand Oaks', hotelIds: ['THOK'] },
  { label: 'Brentwood Springfield', hotelIds: ['BWSF'] },
  { label: 'La Quinta Stockton', hotelIds: ['LQST'] },
  { label: 'La Quinta Fresno', hotelIds: ['LQFR'] },
  { label: 'Brentwood Visalia', hotelIds: ['BWVI'] },
  { label: 'The Live Hotel', hotelIds: ['LIVE'] },
  { label: 'Brentwood Inn', hotelIds: ['BRNT'] }
];
const AGENT_STATUS_LABELS = {
  standby: 'Standby Agent',
  ready: 'Ready for Live Shifts'
};
const ROLE_LABELS = {
  applicant: 'Applicant',
  trainee: 'Trainee',
  agent: 'Agent',
  sme: 'Subject Matter Expert (SME)',
  team_leader: 'Team Leader',
  operations_manager: 'Operations Manager'
};
const ROLE_HIERARCHY = {
  trainee: 0,
  agent: 1,
  sme: 2,
  team_leader: 3,
  operations_manager: 5
};
const ROLE_DEMOTION_CHAIN = ['operations_manager', 'team_leader', 'sme', 'agent', 'trainee', 'applicant'];

function parseSessionTimestamp(value) {
  if (!value) return Date.now();
  if (String(value).includes('T') || String(value).includes('Z')) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  const ms = new Date(String(value).replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function normalizeManualLoginMode(value) {
  const cleaned = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (cleaned === 'training' || cleaned === 'shadowing') return 'training';
  return 'shift';
}

function parseManualLoginTimeInput(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return new Date(nowMs).toISOString();

  const lowered = raw.toLowerCase();
  if (['now', 'current', 'current time', 'right now'].includes(lowered)) {
    return new Date(nowMs).toISOString();
  }

  const directMs = new Date(raw).getTime();
  if (Number.isFinite(directMs)) {
    return new Date(directMs).toISOString();
  }

  const dateTimeMatch = raw.match(
    /^(?:on\s+)?(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+)?(\d{1,2})(?::([0-5]\d))?\s*(a\.?m?\.?|p\.?m?\.?)$/i
  );
  if (dateTimeMatch) {
    const year = Number(dateTimeMatch[1] || new Date(nowMs).getFullYear());
    const month = Number(dateTimeMatch[2] || (new Date(nowMs).getMonth() + 1));
    const day = Number(dateTimeMatch[3] || new Date(nowMs).getDate());
    const hourRaw = Number(dateTimeMatch[4]);
    const minuteRaw = Number(dateTimeMatch[5] || 0);
    const suffix = String(dateTimeMatch[6] || '').toLowerCase();
    if (hourRaw >= 1 && hourRaw <= 12 && minuteRaw >= 0 && minuteRaw <= 59) {
      let hour24 = hourRaw % 12;
      if (suffix.startsWith('p')) hour24 += 12;
      return new Date(year, month - 1, day, hour24, minuteRaw, 0, 0).toISOString();
    }
  }

  const dateTwentyFourMatch = raw.match(
    /^(?:on\s+)?(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+)?([01]?\d|2[0-3]):([0-5]\d)$/i
  );
  if (dateTwentyFourMatch) {
    const year = Number(dateTwentyFourMatch[1] || new Date(nowMs).getFullYear());
    const month = Number(dateTwentyFourMatch[2] || (new Date(nowMs).getMonth() + 1));
    const day = Number(dateTwentyFourMatch[3] || new Date(nowMs).getDate());
    const hour24 = Number(dateTwentyFourMatch[4]);
    const minuteRaw = Number(dateTwentyFourMatch[5] || 0);
    return new Date(year, month - 1, day, hour24, minuteRaw, 0, 0).toISOString();
  }

  const timeOnlyMatch = raw.match(
    /^(?:on\s+)?([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?m?\.?|p\.?m?\.?)?$/i
  );
  if (timeOnlyMatch) {
    const now = new Date(nowMs);
    const hourRaw = Number(timeOnlyMatch[1]);
    const minuteRaw = Number(timeOnlyMatch[2] || 0);
    const suffix = String(timeOnlyMatch[3] || '').toLowerCase();
    let hour24 = hourRaw;
    if (suffix.startsWith('a') || suffix.startsWith('p')) {
      hour24 = hourRaw % 12;
      if (suffix.startsWith('p')) hour24 += 12;
    }
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour24,
      minuteRaw,
      0,
      0
    ).toISOString();
  }

  const hourOnlyMatch = raw.match(/^(?:on\s+)?([01]?\d|2[0-3])\s*(a\.?m?\.?|p\.?m?\.?)?$/i);
  if (hourOnlyMatch) {
    const now = new Date(nowMs);
    const hourRaw = Number(hourOnlyMatch[1]);
    const suffix = String(hourOnlyMatch[2] || '').toLowerCase();
    let hour24 = hourRaw;
    if (suffix.startsWith('a') || suffix.startsWith('p')) {
      hour24 = hourRaw % 12;
      if (suffix.startsWith('p')) hour24 += 12;
    }
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour24,
      0,
      0,
      0
    ).toISOString();
  }

  return new Date(nowMs).toISOString();
}

function getSessionTimeTravelOffsetMs(session) {
  const raw = Number(session?.time_travel_offset_ms ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Safety cap: 7 days of simulated offset.
  return Math.min(raw, 7 * 24 * 60 * 60 * 1000);
}

function formatDurationHms(totalMs = 0) {
  const safeMs = Math.max(0, Number(totalMs) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function getCappedLogoutIso(loginTimeValue, capMs = OVERTIME_WARNING_MS) {
  const loginMs = parseSessionTimestamp(loginTimeValue);
  return new Date(loginMs + capMs).toISOString();
}

async function setAttendanceQueueRole(member, enabled) {
  try {
    if (!member?.guild) return false;
    const queueRole = member.guild.roles.cache.get(QUEUE_ROLE_ID) ||
      member.guild.roles.cache.find(role => normalizeDiscordRoleName(role?.name) === 'queue');
    if (!queueRole) return false;

    if (enabled) {
      if (!member.roles.cache.has(queueRole.id)) {
        await member.roles.add(queueRole).catch(() => {});
      }
    } else if (member.roles.cache.has(queueRole.id)) {
      await member.roles.remove(queueRole).catch(() => {});
    }
    return true;
  } catch (error) {
    console.warn('[QUEUE] Failed to update attendance queue role:', error.message);
    return false;
  }
}

function getSessionNextWarningDueMs(session, warningThresholdMs = OVERTIME_WARNING_MS) {
  if (session?.overtime_next_warning_at) {
    // This is already a concrete wall-clock schedule.
    return parseSessionTimestamp(session.overtime_next_warning_at);
  }
  const timeTravelOffsetMs = getSessionTimeTravelOffsetMs(session);
  return parseSessionTimestamp(session?.login_time) + warningThresholdMs - timeTravelOffsetMs;
}

function normalizePhoneForStorage(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (/^09\d{9}$/.test(digits)) return `63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `63${digits}`;
  if (/^63\d{10}$/.test(digits)) return digits;
  return digits;
}

async function tryRecoverPhoneLinkedActiveSession(interaction, callerAgent) {
  try {
    const callerPhone = normalizePhoneForStorage(callerAgent?.phone || '');
    if (!callerPhone) return null;

    const candidateAgents = db.prepare(`
      SELECT DISTINCT a.id, a.discord_id, a.username, a.phone
      FROM sessions s
      JOIN agents a ON a.id = s.agent_id
      WHERE s.status = 'active'
        AND a.id != ?
        AND COALESCE(a.phone, '') != ''
    `).all(callerAgent.id);

    const matches = candidateAgents.filter(row => normalizePhoneForStorage(row.phone) === callerPhone);
    if (matches.length !== 1) return null;

    const staleAgent = matches[0];
    const staleActiveSessions = db.prepare(`
      SELECT id, hotel_id, session_kind
      FROM sessions
      WHERE agent_id = ? AND status = 'active'
    `).all(staleAgent.id);

    if (staleActiveSessions.length === 0) return null;

    const closedSessionRefs = await closeAllActiveSessionsForAgent(staleAgent.id, interaction.client);
    const staleMember = await interaction.guild?.members?.fetch(staleAgent.discord_id).catch(() => null);
    if (staleMember) {
      await applyLoggedOutRolesForMember(interaction.guild, staleMember, closedSessionRefs).catch(() => {});
    }

    await updateAllHotelStatusEmbed(interaction.client).catch(() => {});

    sendAuditLog(interaction.client, {
      title: 'Shift Session Recovered',
      description:
        `**Recovered For:** <@${interaction.user.id}>\n` +
        `**Recovered Agent Row:** ${staleAgent.username || 'Unknown'} (\`${staleAgent.discord_id}\`)\n` +
        `**Reason:** Matched phone-linked active session from another account record\n` +
        `**Action:** Closed stale active session and refreshed live boards`,
      color: 0xF1C40F,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    return {
      recovered: true,
      closedSessionRefs,
      recoveredDiscordId: staleAgent.discord_id
    };
  } catch (error) {
    console.warn('[LOGOUT] Phone-linked session recovery failed:', error.message);
    return null;
  }
}

function getSessionFinalLimitDueMs(session, finalLimitMs = OVERTIME_FINAL_LIMIT_MS) {
  const timeTravelOffsetMs = getSessionTimeTravelOffsetMs(session);
  return parseSessionTimestamp(session?.login_time) + finalLimitMs - timeTravelOffsetMs;
}

function getOvertimeThresholdLabel(warningThresholdMs = OVERTIME_WARNING_MS) {
  return warningThresholdMs === OVERTIME_TEST_WARNING_MS ? '3 minutes' : '8 hours';
}

function getOvertimeWarningThresholdMs(session, guild) {
  const roleName = String(session?.role || '').toLowerCase();
  if (roleName === 'test role') return OVERTIME_TEST_WARNING_MS;

  if (guild && session?.discord_id) {
    const member = guild.members.cache.get(session.discord_id);
    const testRole = member?.roles?.cache?.has(TEST_ROLE_ID);
    if (testRole) return OVERTIME_TEST_WARNING_MS;
  }

  return OVERTIME_WARNING_MS;
}

function isTestRoleSession(session, guild) {
  const roleName = String(session?.role || '').toLowerCase();
  if (roleName === 'test role') return true;
  if (guild && session?.discord_id) {
    const member = guild.members.cache.get(session.discord_id);
    return !!member?.roles?.cache?.has(TEST_ROLE_ID);
  }
  return false;
}

function scheduleCombinedHotelStatusRefresh(client) {
  if (combinedHotelStatusRefreshTimer) clearTimeout(combinedHotelStatusRefreshTimer);
  combinedHotelStatusRefreshTimer = setTimeout(() => {
    updateAllHotelStatusEmbed(client).catch(error => {
      console.warn('[STATUS] Combined hotel refresh failed:', error.message);
    });
  }, 750);
  combinedHotelStatusRefreshTimer.unref?.();
}

function normalizeTeamLogLabel(input) {
  const cleaned = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (cleaned === 'team 1' || cleaned === 'team1' || cleaned === '1') return 'Team 1';
  if (cleaned === 'team 2' || cleaned === 'team2' || cleaned === '2') return 'Team 2';
  if (cleaned === 'team 3' || cleaned === 'team3' || cleaned === '3') return 'Team 3';
  if (cleaned === 'team 4' || cleaned === 'team4' || cleaned === '4') return 'Team 4';
  if (cleaned === 'team 5' || cleaned === 'team5' || cleaned === '5') return 'Team 5';
  return null;
}

function getTeamLogChannelIdByTeamName(teamName) {
  const normalized = normalizeTeamLogLabel(teamName);
  return normalized ? TEAM_LOG_CHANNEL_IDS[normalized] || null : null;
}

async function resolveTeamLogChannelIdForUser(client, guild, userId) {
  if (!userId) return null;
  const targetGuild = guild || client.guilds.cache.first();
  if (!targetGuild) return null;

  const resolveFromRoles = member => {
    if (!member?.roles?.cache) return null;
    for (const [teamName, roleId] of Object.entries(TEAM_ROLE_IDS)) {
      if (member.roles.cache.has(roleId)) {
        return TEAM_LOG_CHANNEL_IDS[teamName] || null;
      }
    }
    for (const role of member.roles.cache.values()) {
      const byName = getTeamLogChannelIdByTeamName(role?.name);
      if (byName) return byName;
    }
    return null;
  };

  let member = targetGuild.members.cache.get(userId) || null;
  let teamChannelId = resolveFromRoles(member);
  if (teamChannelId) return teamChannelId;

  if (!member) {
    member = await targetGuild.members.fetch(userId).catch(() => null);
    teamChannelId = resolveFromRoles(member);
    if (teamChannelId) return teamChannelId;
  }

  const dbTeam = db.prepare('SELECT team FROM agents WHERE discord_id = ?').get(userId)?.team;
  return getTeamLogChannelIdByTeamName(dbTeam);
}

async function notifyNotificationRoleMembers(client, { title, description, color = 0x5865F2 }) {
  const targetGuild = client.guilds.cache.first();
  if (!targetGuild) return { attempted: 0, sent: 0, failed: 0 };

  await targetGuild.members.fetch().catch(() => {});
  const notificationRole = targetGuild.roles.cache.get(NOTIFICATION_ROLE_ID);
  if (!notificationRole) {
    console.warn(`[NOTIFY] Notification role not found: ${NOTIFICATION_ROLE_ID}`);
    return { attempted: 0, sent: 0, failed: 0 };
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: 'Aavgo Operations - Notification Watch' })
    .setTimestamp();

  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const member of notificationRole.members.values()) {
    attempted += 1;
    await member.send({ embeds: [embed] })
      .then(() => {
        sent += 1;
      })
      .catch(() => {
        failed += 1;
      });
  }

  return { attempted, sent, failed };
}

async function sendOvertimeWarningNotice(client, session, source = 'AUTO', warningThresholdMs = OVERTIME_WARNING_MS) {
  const modeLabel = session.session_kind === 'training' ? 'training' : 'shift';
  const sessionId = String(session.id);
  const warningThresholdLabel = getOvertimeThresholdLabel(warningThresholdMs);
  const warningEmbed = new EmbedBuilder()
    .setTitle('⚠️ 8-Hour Overtime Warning')
    .setDescription(
      `You have reached **${warningThresholdLabel}** on your current ${modeLabel}.\n\n` +
      `If you need to continue, tap **Confirm Overtime** below to extend your session up to the **12-hour final limit**.\n\n` +
      `If you do not confirm within **15 minutes**, you will be auto-logged out and this record will be capped at **${warningThresholdLabel}**.`
    )
    .addFields(
      { name: 'Mode', value: modeLabel === 'training' ? 'Training' : 'Shift', inline: true },
      { name: 'Time Limit', value: warningThresholdLabel, inline: true },
      { name: 'Final Limit', value: '12 hours', inline: true }
    )
    .setColor(0xFEE75C)
    .setFooter({ text: 'Aavgo Operations - Overtime Control' })
    .setTimestamp();

  let dmSent = false;
  let ttsSent = false;
  let buttonDmSent = false;
  const warningIso = new Date().toISOString();

  db.prepare(`
    UPDATE sessions
    SET overtime_warning_at = ?, overtime_confirmed = 0, overtime_next_warning_at = NULL
    WHERE id = ? AND status = 'active'
  `).run(warningIso, session.id);

  const user = await client.users.fetch(session.discord_id).catch(() => null);
  if (user) {
    const guildId = client.guilds.cache.first()?.id || null;
    const attendanceChannelUrl = guildId ? `https://discord.com/channels/${guildId}/${ATTENDANCE_CHANNEL_ID}` : null;
    const confirmBtn = new ButtonBuilder()
      .setCustomId(`overtime_confirm:${sessionId}:${session.discord_id}`)
      .setLabel('Confirm Overtime')
      .setStyle(ButtonStyle.Success);
    const endShiftBtn = attendanceChannelUrl
      ? new ButtonBuilder()
        .setLabel('End Shift')
        .setEmoji('🛑')
        .setStyle(ButtonStyle.Link)
        .setURL(attendanceChannelUrl)
      : new ButtonBuilder()
        .setCustomId(`overtime_endshift:${sessionId}:${session.discord_id}`)
        .setLabel('End Shift')
        .setStyle(ButtonStyle.Danger);
    const confirmRow = new ActionRowBuilder().addComponents(confirmBtn, endShiftBtn);

    await user.send({
      embeds: [warningEmbed],
      components: [confirmRow]
    }).then(() => {
      dmSent = true;
      buttonDmSent = true;
    }).catch(() => {});

    await user.send({
      content: `⚠️ Attention: You have received an overtime warning for your current ${modeLabel}.`,
      tts: true
    }).then(() => { ttsSent = true; }).catch(() => {});
  }

  await sendAuditLog(client, {
    title: source === 'MANUAL' ? '⚠️ Manual 8-Hour OT Warning' : '⚠️ 8-Hour OT Warning Sent',
    description:
      `**User:** ${session.username} (<@${session.discord_id}>)\n` +
      `**Mode:** ${modeLabel === 'training' ? 'Training' : 'Shift'}\n` +
      `**Delivery:** Warning DM ${dmSent ? 'Sent' : 'Failed'} | Confirm Button DM ${buttonDmSent ? 'Sent' : 'Failed'} | TTS DM ${ttsSent ? 'Sent' : 'Failed'}`,
    color: 0xFEE75C,
    userId: session.discord_id,
    channelIdOverride: OVERTIME_8H_LOG_CHANNEL_ID
  });

  return { dmSent, ttsSent, buttonDmSent };
}

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

  const summaryText = summaryLines.join('\n').trim();
  if (summaryText) {
    return {
      summary: summaryText,
      fields: fields.slice(0, 6)
    };
  }

  if (fields.length > 0) {
    const valueByName = new Map(fields.map(field => [String(field.name || '').trim().toLowerCase(), String(field.value || '').trim()]));
    const orderedSummaryKeys = ['user', 'agent', 'location', 'practice for', 'training for', 'hotel(s)', 'duration', 'time', 'mode'];
    const summaryParts = orderedSummaryKeys
      .map(key => {
        const value = valueByName.get(key);
        return value ? `**${key.replace(/\b\w/g, char => char.toUpperCase())}:** ${value}` : null;
      })
      .filter(Boolean)
      .slice(0, 3);

    const derivedSummary = summaryParts.join(' | ').trim();
    if (derivedSummary) {
      return {
        summary: derivedSummary,
        fields: fields.slice(0, 6)
      };
    }
  }

  return {
    summary: 'Operational event recorded.',
    fields: fields.slice(0, 6)
  };
}

// ─── Audit Logger ────────────────────────────────────
async function sendAuditLog(
  client,
  {
    title,
    description,
    color,
    hotelId,
    userId,
    forceManagerLog,
    forceTrainingLog,
    guild,
    channelIdOverride,
    teamLogRouting
  }
) {
  try {
    let targetChannelId = AUDIT_LOG_CHANNEL_ID;
    const resolveOpsLogChannelByHotel = rawHotelId => {
      const normalizedHotelId = normalizeCombinedHotelId(rawHotelId);
      if (!normalizedHotelId) return null;

      // Route by explicit hotel-team groups first so attendance/login logs always
      // land in the expected team log channels.
      if (TEAM_1_HOTELS.includes(normalizedHotelId)) return TEAM_LOG_CHANNEL_IDS['Team 1'] || null;
      if (TEAM_2_HOTELS.includes(normalizedHotelId)) return TEAM_LOG_CHANNEL_IDS['Team 2'] || null;
      if (TEAM_3_HOTELS.includes(normalizedHotelId)) return TEAM_LOG_CHANNEL_IDS['Team 3'] || null;
      if (TEAM_4_HOTELS.includes(normalizedHotelId)) return TEAM_LOG_CHANNEL_IDS['Team 4'] || null;
      if (TEAM_5_HOTELS.includes(normalizedHotelId)) return TEAM_LOG_CHANNEL_IDS['Team 5'] || null;

      const hotelTeam = normalizeTeamInput(
        db.prepare("SELECT team FROM hotels WHERE id = ?").get(normalizedHotelId)?.team
      );
      if (hotelTeam === 'Team 1') return TEAM_LOG_CHANNEL_IDS['Team 1'] || null;
      if (hotelTeam === 'Team 2') return TEAM_LOG_CHANNEL_IDS['Team 2'] || null;
      if (hotelTeam === 'Team 3') return TEAM_LOG_CHANNEL_IDS['Team 3'] || null;
      if (hotelTeam === 'Team 4') return TEAM_LOG_CHANNEL_IDS['Team 4'] || null;
      if (hotelTeam === 'Team 5') return TEAM_LOG_CHANNEL_IDS['Team 5'] || null;
      return null;
    };

    // Resolve Nickname if userId is provided
    let agentName = 'Aavgo System';
    if (userId && guild) {
      agentName = await getAgentDisplayName(guild, userId);
    }

    // Categorized Logging
    if (channelIdOverride) {
      targetChannelId = channelIdOverride;
    } else if (forceTrainingLog) {
      targetChannelId = TRAINING_LOG_CHANNEL_ID;
    } else if (hotelId === 'TEAM_SHIFT') {
      // Management logins/logouts must stay in TL logs only (no team status/ops channel rerouting).
      targetChannelId = TL_PORTAL_CHANNEL_ID;
    } else if (forceManagerLog) {
      targetChannelId = AUDIT_LOG_CHANNEL_ID; // Ensure manager audit
    } else if (teamLogRouting && userId) {
      if (hotelId) {
        const mappedChannelId = resolveOpsLogChannelByHotel(hotelId);
        if (mappedChannelId) {
          targetChannelId = mappedChannelId;
        } else {
          const routedTeamChannelId = await resolveTeamLogChannelIdForUser(client, guild, userId);
          if (routedTeamChannelId) targetChannelId = routedTeamChannelId;
        }
      } else {
        const routedTeamChannelId = await resolveTeamLogChannelIdForUser(client, guild, userId);
        if (routedTeamChannelId) {
          targetChannelId = routedTeamChannelId;
        }
      }
    } else if (hotelId) {
      const mappedChannelId = resolveOpsLogChannelByHotel(hotelId);
      if (mappedChannelId) targetChannelId = mappedChannelId;
    } else if (userId) {
      // Check if user is on an active team hotel shift
      const agentSession = db.prepare(`
        SELECT hotel_id FROM sessions 
        WHERE agent_id = (SELECT id FROM agents WHERE discord_id = ?) 
        AND status = 'active'
      `).get(userId);
      const mappedChannelId = resolveOpsLogChannelByHotel(agentSession?.hotel_id);
      if (mappedChannelId) targetChannelId = mappedChannelId;
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
async function broadcastUpdateLogLegacy(client) {
  const UPDATE_LOG_CHANNEL_ID = '1485584578927132863';
  try {
    const channel = await client.channels.fetch(UPDATE_LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const currentCommit = runGitForUpdateLog(['rev-parse', '--short', 'HEAD']);
    if (!currentCommit) return;

    const lastPosted = db.prepare("SELECT value FROM config WHERE key = ?").get('update_log_last_commit')?.value || null;
    if (lastPosted === currentCommit) return;

    let commitLines = [];
    try {
      if (lastPosted) {
        const raw = runGitForUpdateLog(['log', '--pretty=format:%h%x09%s', `${lastPosted}..HEAD`]);
        commitLines = raw ? raw.split('\n').filter(Boolean) : [];
      } else {
        const raw = runGitForUpdateLog(['log', '-1', '--pretty=format:%h%x09%s']);
        commitLines = raw ? [raw] : [];
      }
    } catch (rangeErr) {
      console.warn('[UPDATE-LOG] Commit range lookup failed:', rangeErr.message);
      const fallback = runGitForUpdateLog(['log', '-1', '--pretty=format:%h%x09%s']);
      commitLines = fallback ? [fallback] : [];
    }

    const lines = commitLines.slice(0, 10).map(line => {
      const [hash, ...subjectParts] = line.split('\t');
      const subject = subjectParts.join('\t').trim() || 'Updated bot behavior';
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

async function closeAllActiveSessionsForAgent(agentId, client, options = {}) {
  const fallbackNowIso = new Date().toISOString();
  const requestedLogoutIso = typeof options?.logoutTimeIso === 'string' ? options.logoutTimeIso : '';
  const parsedLogoutMs = requestedLogoutIso ? parseSessionTimestamp(requestedLogoutIso) : NaN;
  const nowIso = Number.isFinite(parsedLogoutMs) ? new Date(parsedLogoutMs).toISOString() : fallbackNowIso;
  
  // 1. Fetch active sessions to know what to refresh later
  const activeSessions = db.prepare("SELECT hotel_id, session_kind FROM sessions WHERE agent_id = ? AND status = 'active'").all(agentId);
  if (activeSessions.length === 0) return [];

  const sessionRefs = [...new Map(
    activeSessions.map(s => {
      const hotelId = s.hotel_id;
      const sessionKind = String(s.session_kind || 'shift').toLowerCase();
      return [`${hotelId}:${sessionKind}`, { hotel_id: hotelId, session_kind: sessionKind }];
    })
  ).values()];

  const hotelIds = [...new Set(activeSessions.map(s => s.hotel_id))];
  const hasTrainingSessions = activeSessions.some(s => s.session_kind === 'training');
  const hasTeamShift = activeSessions.some(s => s.hotel_id === 'TEAM_SHIFT');

  // 2. Close in DB
  const result = db.prepare("UPDATE sessions SET status = 'closed', logout_time = ?, overtime_warning_at = NULL, overtime_confirmed = 0, overtime_next_warning_at = NULL WHERE agent_id = ? AND status = 'active'").run(nowIso, agentId);
  console.log(`[AUTH-MAINT] Closed ${result.changes} session(s) for agent ${agentId}`);

  // 3. Trigger refreshes
  for (const hId of hotelIds) {
    try {
      if (hId === 'TEAM_SHIFT') {
        const agent = db.prepare("SELECT team FROM agents WHERE id = ?").get(agentId);
        if (agent && agent.team) {
          await updateTeamStatusEmbed(client, agent.team);
          // When a TL logs out, all their team's hotels must refresh to clear "TL on Shift"
          const teamHotels = getOperationalHotelIdsForTeam(agent.team);
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

  return sessionRefs;
}

async function applyLoggedOutRolesForMember(guild, member, hotelRefs = []) {
  try {
    if (!guild || !member) return;

    const onShiftRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
    const loggedOutRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
    const supportRole = guild.roles.cache.get(SUPPORT_ROLE_ID);
    const trainingSessionRole = guild.roles.cache.get(TRAINING_SESSION_ROLE_ID);
    const rolesToRemove = [onShiftRole, supportRole, trainingSessionRole].filter(Boolean);
    const rolesToAdd = [loggedOutRole].filter(Boolean);
    const memberTeamFromDb = normalizeTeamInput(
      db.prepare("SELECT team FROM agents WHERE discord_id = ?").get(member.id)?.team
    );
    const memberTeamFromRoles = normalizeTeamInput(resolveTeamFromMemberRoles(member));
    const effectiveMemberTeam = memberTeamFromDb || memberTeamFromRoles || null;

    for (const ref of hotelRefs) {
      const hId = typeof ref === 'string' ? ref : (ref?.hotel_id || ref?.hotelId || null);
      if (!hId) continue;
      const sessionKind = String(
        typeof ref === 'string' ? 'shift' : (ref?.session_kind || ref?.sessionKind || 'shift')
      ).toLowerCase();

      if (hId === 'TEAM_SHIFT' && sessionKind !== 'training' && effectiveMemberTeam === 'Team 2') {
        const team2PermissionRole = guild.roles.cache.get(TEAM_2_PERMISSION_ROLE_ID);
        const team2GhostRole = guild.roles.cache.get(TEAM_2_GHOST_ROLE_ID);
        if (team2PermissionRole) rolesToRemove.push(team2PermissionRole);
        if (team2GhostRole) rolesToAdd.push(team2GhostRole);
      } else if (hId === 'TEAM_SHIFT' && sessionKind !== 'training' && effectiveMemberTeam === 'Team 3') {
        const team3PermissionRole = guild.roles.cache.get(TEAM_3_PERMISSION_ROLE_ID);
        const team3GhostRole = guild.roles.cache.get(TEAM_3_GHOST_ROLE_ID);
        if (team3PermissionRole) rolesToRemove.push(team3PermissionRole);
        if (team3GhostRole) rolesToAdd.push(team3GhostRole);
      }

      const greenRole = guild.roles.cache.get(ROLE_NAMES.GREEN[hId]);
      const greyRole = guild.roles.cache.get(ROLE_NAMES.GREY[hId]);
      if (greenRole) rolesToRemove.push(greenRole);
      if (greyRole) rolesToRemove.push(greyRole);
    }

    for (const hotelRoleId of new Set([...Object.values(ROLE_NAMES.GREEN), ...Object.values(ROLE_NAMES.GREY)])) {
      const hotelRole = guild.roles.cache.get(hotelRoleId);
      if (hotelRole) rolesToRemove.push(hotelRole);
    }

    const uniqueRemove = [...new Map(rolesToRemove.filter(Boolean).map(role => [role.id, role])).values()];
    const uniqueAdd = [...new Map(rolesToAdd.filter(Boolean).map(role => [role.id, role])).values()];

    if (uniqueRemove.length > 0) await member.roles.remove(uniqueRemove).catch(() => {});
    if (uniqueAdd.length > 0) await member.roles.add(uniqueAdd).catch(() => {});
  } catch (error) {
    console.warn('[ROLES] Could not apply logged-out role state:', error.message);
  }
}

async function closeOtherActiveHotelSessions(interaction, hotelId, currentAgentId) {
  const priorSessions = db.prepare(
    "SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND COALESCE(session_kind, 'shift') != 'training' AND agent_id != ? ORDER BY id DESC"
  ).all(hotelId, currentAgentId);

  for (const priorSession of priorSessions) {
    const priorAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(priorSession.agent_id);
    db.prepare("UPDATE sessions SET logout_time = CURRENT_TIMESTAMP, status = 'closed', overtime_warning_at = NULL, overtime_confirmed = 0, overtime_next_warning_at = NULL WHERE id = ?").run(priorSession.id);

    if (!priorAgent) continue;

    try {
      const oldMember = await interaction.guild.members.fetch(priorAgent.discord_id);
      if (!oldMember) continue;

      const onShiftRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
      const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
      const greenRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREEN[hotelId]);
      const greyRole = interaction.guild.roles.cache.get(ROLE_NAMES.GREY[hotelId]);
      const trainingSessionRole = interaction.guild.roles.cache.get(TRAINING_SESSION_ROLE_ID);

      if (loggedOutRole) {
        const allHotelRoles = [...new Set([...Object.values(ROLE_NAMES.GREEN), ...Object.values(ROLE_NAMES.GREY)])]
          .map(roleId => interaction.guild.roles.cache.get(roleId))
          .filter(Boolean);
        const rolesToRemove = [onShiftRole, greenRole, greyRole, trainingSessionRole, ...allHotelRoles].filter(Boolean);
        const rolesToAdd = [loggedOutRole];

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
async function showPinModal(interaction, hotelId, isTakeover = false, allowMultiHotel = false, sessionMode = 'shift', autoStartAfterPin = false) {
  const isTeamShiftOverride = typeof hotelId === 'string' && hotelId.startsWith('TEAM_SHIFT_team_');
  const hotelName = (hotelId === 'TEAM_SHIFT' || isTeamShiftOverride) ? 'Management Shift' : getCombinedHotelLabel(hotelId);
  const agent = db.prepare('SELECT pin_is_set FROM agents WHERE discord_id = ?').get(interaction.user.id);

  if (agent && !hasConfiguredPin(agent)) {
    return promptForPinSetup(interaction, hotelName, sessionMode);
  }

  const modal = new ModalBuilder()
    .setCustomId(`loginmodal_${sessionMode}_${hotelId}${isTakeover ? '_takeover' : ''}${allowMultiHotel ? '_multi' : ''}${autoStartAfterPin ? '_autostart' : ''}`)
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

function resolveShiftRouteKind(interaction, agent) {
  const normalizedRole = normalizeAgentRole(agent?.role);

  if (isTraineeMember(interaction) || normalizedRole === 'trainee') {
    return 'training';
  }

  if (interactionHasRoleAtLeast(interaction, 'sme') || hasAgentRoleAtLeast(normalizedRole, 'sme')) {
    return 'management';
  }

  if (normalizedRole === 'agent' || interactionHasRoleAtLeast(interaction, 'agent')) {
    return 'agent';
  }

  return 'unknown';
}

function buildInitializeShiftFallbackPayload() {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations · Initialize Shift')
    .setDescription(
      '### ✅ ACCESS ROUTE READY\n' +
      '────────────────────────\n' +
      '🤖 Board: Pick the shift lane that matches your role.\n' +
      '👤 Agent: Hotel Shift or Training.\n' +
      '🧑‍💼 Team Leader / SME: Team shift login.\n' +
      '────────────────────────'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations • Role Routing' })
    .setTimestamp();

  const agentBtn = new ButtonBuilder()
    .setCustomId('shift_role_agent_btn')
    .setLabel('👤 Agent')
    .setStyle(ButtonStyle.Primary);

  const tlBtn = new ButtonBuilder()
    .setCustomId('shift_role_team_leader_btn')
    .setLabel('🧑‍💼 Team Leader')
    .setStyle(ButtonStyle.Secondary);

  const smeBtn = new ButtonBuilder()
    .setCustomId('shift_role_sme_btn')
    .setLabel('🧠 SME')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(agentBtn, tlBtn, smeBtn)]
  };
}

async function guardShiftPinFirst(interaction, agent, sessionMode = 'shift') {
  if (agent && !hasConfiguredPin(agent)) {
    const canShowModal =
      (typeof interaction.isButton === 'function' && interaction.isButton()) ||
      (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu());

    // Keep the flow clean: open setup modal directly instead of posting another temporary card.
    if (canShowModal) {
      await handleSecuritySetupStart(interaction);
    } else {
      await promptForPinSetup(interaction, 'Shift', sessionMode);
    }
    return true;
  }
  return false;
}

function buildAgentTeamRequiredEmbed() {
  return new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations · Team Required')
    .setDescription(
      '### ⚠️ TEAM ASSIGNMENT REQUIRED\n' +
      '────────────────────────\n' +
      '🤖 Board: You cannot start a hotel shift yet.\n' +
      '👤 Requirement: Your team must be assigned first.\n' +
      '🧑‍💼 Ask: Team Leader or Operations Manager must set your team.\n' +
      '────────────────────────'
    )
    .setColor(0xFEE75C)
    .setFooter({ text: 'Aavgo Operations • Team Routing' })
    .setTimestamp();
}

function buildReadyToStartShiftPayload(hotelId, isTakeover = false, allowMultiHotel = false) {
  const confirmEmbed = new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations · Agent Route')
    .setDescription(
      '### ✅ READY TO START SHIFT\n' +
      '────────────────────────\n' +
      `🏨 Hotel: **${getCombinedHotelLabel(hotelId)}**\n` +
      '🤖 Board: Do you want to start your shift?\n' +
      '────────────────────────'
    )
    .setColor(0x57F287)
    .setFooter({ text: 'Aavgo Operations • Shift Confirmation' })
    .setTimestamp();

  const yesButton = new ButtonBuilder()
    .setCustomId(`agent_shift_confirm_yes:${hotelId}:${isTakeover ? '1' : '0'}:${allowMultiHotel ? '1' : '0'}`)
    .setLabel('✅ Yes')
    .setStyle(ButtonStyle.Primary);

  const noButton = new ButtonBuilder()
    .setCustomId('agent_shift_confirm_no')
    .setLabel('❌ No')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [confirmEmbed],
    components: [new ActionRowBuilder().addComponents(yesButton, noButton)]
  };
}

function buildPostLoginVoiceRows({ sessionMode, hotelId, teamName, normalizedRole }) {
  const buttons = [];

  if (sessionMode === 'training') {
    TRAINING_CALL_CHANNEL_IDS.forEach((channelId, index) => {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`shift_call_join:${channelId}`)
          .setLabel(`Training VC ${index + 1}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
  }

  if (sessionMode !== 'training') {
    const canUseTlCall =
      hotelId === 'TEAM_SHIFT' ||
      normalizedRole === 'sme' ||
      normalizedRole === 'team_leader' ||
      normalizedRole === 'operations_manager';

    if (canUseTlCall) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`shift_call_join:${TL_SME_CALL_CHANNEL_ID}`)
          .setLabel('Join TL/SME Call')
          .setStyle(ButtonStyle.Primary)
      );
    }

    const teamCallIds = getTeamOnShiftCallIds(teamName);
    teamCallIds.forEach((channelId, index) => {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`shift_call_join:${channelId}`)
          .setLabel(`On-Shift Call ${index + 1}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });

    CROSS_TEAM_ON_SHIFT_CALL_CHANNEL_IDS.forEach((channelId, index) => {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`shift_call_join:${channelId}`)
          .setLabel(`Cross-Team ${index + 1}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
  }

  if (buttons.length === 0) return [];

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

function normalizeTeamInput(input) {
  const cleaned = (input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (cleaned === 'team 1' || cleaned === '1' || cleaned === 'team1') return 'Team 1';
  if (cleaned === 'team 2' || cleaned === '2' || cleaned === 'team2') return 'Team 2';
  if (cleaned === 'team 3' || cleaned === '3' || cleaned === 'team3') return 'Team 3';
  if (cleaned === 'team 4' || cleaned === '4' || cleaned === 'team4') return 'Team 4';
  if (cleaned === 'team 5' || cleaned === '5' || cleaned === 'team5') return 'Team 5';
  return null;
}

function getOtherTeamNames(teamName) {
  return TEAM_NAMES.filter(name => name !== teamName);
}

function normalizeHotelInput(input) {
  const cleaned = (input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const aliases = {
    BWTO: 'BW_TO',
    THOUSANDOAKS: 'THOK',
    THOUSANDOAKSCA: 'THOK',
    BWPLUSTHOUSANDOAKSCA: 'THOK',
    INDIANHEAD: 'BW_TO',
    INDIANHEADIRONWOOD: 'BW_TO',
    MAGNUSON: 'BW_TO',
    MAGNUSONIRONWOOD: 'BW_TO',
    IRONWOOD: 'BW_TO',
    BRNT: 'BRNT',
    BRENTWOOD: 'BRNT',
    BRENTWOODINNSUITES: 'BRNT',
    BRENTWOODINN: 'BRNT',
    GICP: 'GICP',
    GARDENINN: 'GICP',
    GARDENINNCAMPSITE: 'GICP',
    THEGARDENINNATCAMPSITE: 'GICP',
    GARDENINNANDTHECAMPGROUND: 'GICP',
    SUP8: 'SUP8',
    SUPER8: 'SUP8',
    SUPER8RAMADA: 'SUP8',
    RMDA: 'RMDA',
    RAMADA: 'RMDA',
    AD1: 'AD1',
    PARM: 'PARM',
    PARMANI: 'PARM',
    TRAVELODGE: 'TRVL',
    TRAVELLODGE: 'TRVL',
    DAYINNSBISHOP: 'DIBS',
    DAYINNS: 'DIBS',
    BISHOP: 'DIBS',
    QIRV: 'QI_RV',
    QUALITYINN: 'QI_RV',
    QUALITYINNRUSSELVILLE: 'QI_RV',
    QUALITYINNRUSSELLVILLE: 'QI_RV',
    RUSSELVILLE: 'QI_RV',
    RUSSELLVILLE: 'QI_RV',
    MYLO: 'MYAL',
    ALPINE: 'MYAL',
    MYLOALPINE: 'MYAL',
    PROS: 'PROS',
    PROSPERO: 'PROS',
    PROSPEROFLAGSHIP: 'PROS',
    FLAGSHIP: 'PROS',
    GLDL: 'GLDL',
    GLENDALE: 'GLDL',
    THELEEFHOTEL: 'GLDL',
    LEEF: 'GLDL',
    INFL: 'INFL',
    INNATTHEFINGERLAKES: 'INFL',
    FINGERLAKES: 'INFL',
    VALS: 'VALS',
    VALUESUITES: 'VALS',
    BAYT: 'BAYT',
    BAYSIDE: 'BAYT',
    TOWNHOUSE: 'BAYT',
    TOWNHOUSEBAYSIDE: 'BAYT',
    ANPI: 'ANPI',
    ANCHORBEACH: 'ANPI',
    PACIFICINN: 'ANPI',
    ECON: 'ECON',
    ECONOLODGE: 'ECON',
    BUEN: 'BUEN',
    BUENAVISTA: 'BUEN',
    BUENAVISTAINN: 'BUEN',
    THOK: 'THOK',
    QUALITYRUSSELVILLE: 'QI_RV',
    QUALITYRUSSELLVILLE: 'QI_RV',
    SAGE: 'SAGE',
    WYNDHAMGARDEN: 'WGFR',
    WYNDHAMGARDENFRESNO: 'WGFR',
    WINDHAMGARDEN: 'WGFR',
    WINDHAMGARDENFRESNO: 'WGFR',
    GARDENFRESNO: 'WGFR',
    WGFRESNO: 'WGFR',
    BWFRESNO: 'BWSF',
    BRENTWOODSPRINGFIELD: 'BWSF',
    BWSPRINGFIELD: 'BWSF',
    LQSTOCKTON: 'LQST',
    LAQUINTASTOCKTON: 'LQST',
    LQFRESNO: 'LQFR',
    LAQUINTAFRESNO: 'LQFR',
    BWVISALIA: 'BWVI',
    BRENTWOODVISALIA: 'BWVI',
    THELIVEHOTEL: 'LIVE',
    LIVEHOTEL: 'LIVE',
    LIVE: 'LIVE',
    HOTELZICO: 'ZICO',
    ZICO: 'ZICO'
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

function getNextDemotedRole(role) {
  const normalized = normalizeAgentRole(role);
  const idx = ROLE_DEMOTION_CHAIN.indexOf(normalized);
  if (idx === -1 || idx >= ROLE_DEMOTION_CHAIN.length - 1) return null;
  return ROLE_DEMOTION_CHAIN[idx + 1];
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
    db.prepare("UPDATE agents SET username = ?, pin = ?, pin_is_set = 0, role = ?, agent_status = 'ready' WHERE discord_id = ?").run(targetUser.username, pin, normalizedRole, targetUser.id);
  } else {
    db.prepare("INSERT INTO agents (discord_id, username, pin, pin_is_set, role, agent_status) VALUES (?, ?, ?, 0, ?, 'ready')").run(targetUser.id, targetUser.username, pin, normalizedRole);
  }

  try {
    const agentsRole = interaction.guild.roles.cache.get('1482227287159078964') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase());
    const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
    const traineeRole = interaction.guild.roles.cache.get('1484705126026449029') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'trainees');
    const applicantsRole = interaction.guild.roles.cache.get('1484919969689894912') || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'applicants');
    const unverifiedRole = (normalizedRole === 'agent' || normalizedRole === 'trainee')
      ? (interaction.guild.roles.cache.get(NO_PIN_ROLE_ID) || interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'unverified'))
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
    .setPlaceholder('Type hotel name (e.g., Indianhead, Prospero, Econolodge, Thousand Oaks)');

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

async function finalizeShiftLogin(interaction, agent, hotelId, isTakeover = false, allowMultiHotel = false, sessionMode = 'shift', options = {}) {
  const normalizedRole = normalizeAgentRole(agent?.role);
  const effectiveAllowMultiHotel = (
    sessionMode === 'shift' &&
    normalizedRole !== 'agent'
  ) ? allowMultiHotel : false;
  const loginTimeIsoInput = typeof options?.loginTimeIso === 'string' ? options.loginTimeIso : '';
  const parsedLoginMs = loginTimeIsoInput ? parseSessionTimestamp(loginTimeIsoInput) : NaN;
  const effectiveLoginTimeIso = Number.isFinite(parsedLoginMs)
    ? new Date(parsedLoginMs).toISOString()
    : new Date().toISOString();
  const skipRecentSubmissionGuard = options?.skipRecentSubmissionGuard === true;

  const respond = async (payload) => {
    if (interaction.deferred || interaction.replied) {
      const message = await interaction.editReply(payload);
      maybeScheduleEphemeralCleanup(interaction, payload, message, isEphemeralSourceInteraction(interaction));
      return message;
    }
    const replyPayload = { ...payload, ephemeral: true, fetchReply: true };
    const message = await interaction.reply(replyPayload);
    maybeScheduleEphemeralCleanup(interaction, replyPayload, message, true);
    return message;
  };

  if (!skipRecentSubmissionGuard) {
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const recentSession = db.prepare("SELECT id FROM sessions WHERE agent_id = ? AND hotel_id = ? AND login_time >= ?").get(agent.id, hotelId, fiveSecondsAgo);
    if (recentSession) {
      return respond({ content: 'Warning: You just logged in. Please wait a moment for the status to update.' });
    }
  }

  let closedHotelIds = [];
  if (!effectiveAllowMultiHotel) {
    closedHotelIds = await closeAllActiveSessionsForAgent(agent.id, interaction.client);
    if (closedHotelIds.length > 0) {
      const member = interaction.member || await interaction.guild?.members?.fetch(interaction.user.id).catch(() => null);
      if (member) {
        await applyLoggedOutRolesForMember(interaction.guild, member, closedHotelIds);
      }
    }
  }

  db.prepare("INSERT INTO sessions (agent_id, hotel_id, session_kind, login_time) VALUES (?, ?, ?, ?)").run(
    agent.id,
    hotelId,
    sessionMode,
    effectiveLoginTimeIso
  );

  let noteAlert = '';
  const isTrainingSession = sessionMode === 'training';
  let effectiveLoginTeam =
    normalizeTeamInput(agent?.team) ||
    normalizeTeamInput(resolveTeamFromMemberRoles(interaction.member)) ||
    null;

  try {
    const member = interaction.member;
    const guild = interaction.guild;
    const onShift = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
    const loggedOut = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
    const supportRole = guild.roles.cache.get(SUPPORT_ROLE_ID);
    const trainingSessionRole = guild.roles.cache.get(TRAINING_SESSION_ROLE_ID);
    const loginTeamFromAgent = normalizeTeamInput(agent?.team);
    const loginTeamFromRoles = normalizeTeamInput(resolveTeamFromMemberRoles(member));
    effectiveLoginTeam = loginTeamFromAgent || loginTeamFromRoles || effectiveLoginTeam;
    const team2PermissionRole = guild.roles.cache.get(TEAM_2_PERMISSION_ROLE_ID);
    const team2GhostRole = guild.roles.cache.get(TEAM_2_GHOST_ROLE_ID);
    const team3PermissionRole = guild.roles.cache.get(TEAM_3_PERMISSION_ROLE_ID);
    const team3GhostRole = guild.roles.cache.get(TEAM_3_GHOST_ROLE_ID);
    const allHotelRoles = [...new Set([...Object.values(ROLE_NAMES.GREEN), ...Object.values(ROLE_NAMES.GREY)])]
      .map(roleId => guild.roles.cache.get(roleId))
      .filter(Boolean);

    const isSupportSession = normalizedRole === 'sme' && sessionMode !== 'training';

    if (isTrainingSession) {
      const sessionHotelRole = guild.roles.cache.get(ROLE_NAMES.GREY[hotelId]) || guild.roles.cache.get(ROLE_NAMES.GREEN[hotelId]);
      const otherHotelRoles = allHotelRoles.filter(role => role.id !== sessionHotelRole?.id);
      const rolesToAdd = [sessionHotelRole, trainingSessionRole].filter(Boolean);
      const rolesToRemove = [
        onShift,
        loggedOut,
        supportRole,
        ...otherHotelRoles,
        team2GhostRole,
        team3GhostRole,
        team2PermissionRole,
        team3PermissionRole
      ].filter(Boolean);
      if (rolesToAdd.length > 0) {
        await member.roles.add([...new Map(rolesToAdd.map(role => [role.id, role])).values()]);
      }
      if (rolesToRemove.length > 0) {
        await member.roles.remove([...new Map(rolesToRemove.map(role => [role.id, role])).values()]);
      }
      console.log(`[ROLES] Training roles swapped for ${interaction.user.username}: +Hotel/+Training, -On-Shift/-Logged Out/-Ghost`);
    } else if (isSupportSession) {
      const rolesToAdd = [onShift, supportRole].filter(Boolean);
      const rolesToRemove = [
        loggedOut,
        trainingSessionRole,
        ...allHotelRoles,
        team2GhostRole,
        team3GhostRole,
        team2PermissionRole,
        team3PermissionRole
      ].filter(Boolean);
      if (rolesToAdd.length > 0) {
        await member.roles.add([...new Map(rolesToAdd.map(role => [role.id, role])).values()]);
      }
      if (rolesToRemove.length > 0) {
        await member.roles.remove([...new Map(rolesToRemove.map(role => [role.id, role])).values()]);
      }
      console.log(`[ROLES] Support roles swapped for ${interaction.user.username}: +On-Shift/+Support, -Logged Out/-Hotel Stack`);
    } else if (hotelId === 'TEAM_SHIFT') {
      if (
        (normalizedRole === 'sme' || normalizedRole === 'team_leader') &&
        onShift &&
        loggedOut
      ) {
        const rolesToAdd = [onShift];
        const rolesToRemove = [loggedOut, supportRole, trainingSessionRole, ...allHotelRoles].filter(Boolean);
        await member.roles.add(rolesToAdd);
        if (rolesToRemove.length > 0) {
          await member.roles.remove(rolesToRemove);
        }
        console.log(`[ROLES] Management shift roles swapped for ${interaction.user.username}: +On-Shift, -Logged Out`);
      }

      if (effectiveLoginTeam === 'Team 2' && team2PermissionRole) {
        await member.roles.add([team2PermissionRole]);
        if (team2GhostRole) {
          await member.roles.remove([team2GhostRole]);
        }
        console.log(`[ROLES] Team 2 operations roles swapped for ${interaction.user.username}: +Permission, -Ghost`);
      } else if (effectiveLoginTeam === 'Team 3' && team3PermissionRole) {
        await member.roles.add([team3PermissionRole]);
        if (team3GhostRole) {
          await member.roles.remove([team3GhostRole]);
        }
        console.log(`[ROLES] Team 3 operations roles swapped for ${interaction.user.username}: +Permission, -Ghost`);
      }
    } else if (hotelId !== 'TEAM_SHIFT') {
      const sessionHotelRole = guild.roles.cache.get(ROLE_NAMES.GREY[hotelId]) || guild.roles.cache.get(ROLE_NAMES.GREEN[hotelId]);
      const otherHotelRoles = allHotelRoles.filter(role => role.id !== sessionHotelRole?.id);
      const rolesToAdd = [onShift, sessionHotelRole].filter(Boolean);
      const rolesToRemove = [loggedOut, supportRole, trainingSessionRole, ...otherHotelRoles].filter(Boolean);
      if (rolesToAdd.length > 0) {
        await member.roles.add([...new Map(rolesToAdd.map(role => [role.id, role])).values()]);
      }
      if (rolesToRemove.length > 0) {
        await member.roles.remove([...new Map(rolesToRemove.map(role => [role.id, role])).values()]);
      }
      console.log(`[ROLES] Shift roles swapped for ${interaction.user.username}: +On-Shift/+Hotel, -Logged Out/-Hotel Stack`);
    }
  } catch (roleErr) {
    console.warn('[ROLES] Could not update roles:', roleErr.message);
  }

  await setAttendanceQueueRole(
    interaction.member || await interaction.guild?.members?.fetch(interaction.user.id).catch(() => null),
    false
  );

  if (hotelId === 'TEAM_SHIFT') {
    await updateTeamStatusEmbed(interaction.client, agent.team);
    const teamHotels = getOperationalHotelIdsForTeam(agent.team);
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
        .setDescription(`You have **${unreadNotes.length}** new handover note(s) for **${getCombinedHotelLabel(hotelId)}**:`)
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

  const todayStr = effectiveLoginTimeIso.split('T')[0];
  const schedule = db.prepare(`
    SELECT id FROM schedules
    WHERE agent_id = ? AND hotel_id = ? AND status = 'pending'
    AND date(start_time) = ?
  `).get(agent.id, hotelId, todayStr);

  if (schedule) {
    db.prepare("UPDATE schedules SET status = 'attended' WHERE id = ?").run(schedule.id);
    noteAlert += '\n✅ **Attendance Recorded:** Your shift assignment has been marked as attended.';
  }

  const hotelName = getCombinedHotelLabel(hotelId);
  const sessionLabel = sessionMode === 'training' ? 'training session' : 'shift';
  const voiceTeam = effectiveLoginTeam || normalizeTeamInput(
    db.prepare("SELECT team FROM hotels WHERE id = ?").get(normalizeCombinedHotelId(hotelId))?.team
  );
  const voiceRows = buildPostLoginVoiceRows({
    sessionMode,
    hotelId,
    teamName: voiceTeam,
    normalizedRole
  });
  const voicePromptLine = voiceRows.length > 0
    ? (sessionMode === 'training'
      ? '\n\nPlease join one of the training voice channels below.'
      : '\n\nPlease join one of the on-shift calls below.\nIf you want to go to cross-team on-shift, please join one of these cross-team channels below.')
    : '';
  const successMessage = await respond({
    content: `✅ **Success!** Your ${sessionLabel} is now live in **${hotelName}**. ${noteAlert}${voicePromptLine}`,
    embeds: [],
    components: voiceRows
  });
  clearTrackedLoginFlowEphemeral(interaction, [successMessage?.id]);

  if (isTakeover && hotelId !== 'TEAM_SHIFT') {
    const priorSession = db.prepare("SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND COALESCE(session_kind, 'shift') != 'training' AND agent_id != ? ORDER BY id DESC LIMIT 1").get(hotelId, agent.id);
    if (priorSession) {
      const priorAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(priorSession.agent_id);
      db.prepare("UPDATE sessions SET logout_time = CURRENT_TIMESTAMP, status = 'closed', overtime_warning_at = NULL, overtime_confirmed = 0, overtime_next_warning_at = NULL WHERE id = ?").run(priorSession.id);
      try {
        const oldMember = await interaction.guild.members.fetch(priorAgent.discord_id);
        if (oldMember) {
          const onShiftRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
          const loggedOutRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
          const trainingSessionRole = interaction.guild.roles.cache.get(TRAINING_SESSION_ROLE_ID);
          const allHotelRoles = [...new Set([...Object.values(ROLE_NAMES.GREEN), ...Object.values(ROLE_NAMES.GREY)])]
            .map(roleId => interaction.guild.roles.cache.get(roleId))
            .filter(Boolean);

          if (loggedOutRole) {
            const rolesToRemove = [onShiftRole, trainingSessionRole, ...allHotelRoles].filter(Boolean);
            const rolesToAdd = [loggedOutRole];
            await oldMember.roles.remove(rolesToRemove);
            await oldMember.roles.add(rolesToAdd);
            console.log(`[TAKEOVER] Roles reverted for ${priorAgent.username}: -On-Shift/-Hotel, +Logged Out`);
          }
        }
      } catch (e) {
        console.warn('Could not revert roles for prior agent:', e.message);
      }
    }
  }

  console.log(`[LOGIN] ${interaction.user.username} → ${hotelName}`);

  const auditUnix = Math.floor(parseSessionTimestamp(effectiveLoginTimeIso) / 1000);
  const nickname = await getAgentDisplayName(interaction.guild, interaction.user.id);
  const isPracticeMode = sessionMode === 'training';
  sendAuditLog(interaction.client, {
    title: isPracticeMode ? '🧭 Training Started' : (hotelId === 'TEAM_SHIFT' ? '🟢 Management Logged In' : '🟢 Agent Logged In'),
    description: isPracticeMode
      ? `**User:** ${nickname} (<@${interaction.user.id}>)\n**Practice For:** ${hotelName}\n**Time:** <t:${auditUnix}:F>`
      : `**User:** ${nickname} (<@${interaction.user.id}>)\n**Location:** ${hotelName}\n**Time:** <t:${auditUnix}:F>`,
    color: 0x57F287,
    userId: interaction.user.id,
    hotelId: !isPracticeMode ? hotelId : undefined,
    teamLogRouting: !isPracticeMode && hotelId !== 'TEAM_SHIFT',
    forceTrainingLog: isPracticeMode,
    guild: interaction.guild
  });
}

// ─── Single Persistent Hotel Status Embed ────────────
async function updateHotelStatusEmbed(client, hotelId) {
  let statusKey = hotelId;
  let hotelChannelId = null;

  try {
    const hotelGroup = getHotelStatusGroup(hotelId);
    statusKey = hotelGroup.key;
    hotelChannelId = HOTEL_LOGIN_CHANNELS[hotelGroup.key] || HOTEL_LOGIN_CHANNELS[hotelId];
    if (!hotelChannelId) {
      scheduleCombinedHotelStatusRefresh(client);
      return;
    }

    const suppressedChannelId = getSuppressedHotelStatusChannelId(statusKey);
    if (suppressedChannelId && suppressedChannelId === hotelChannelId) {
      scheduleCombinedHotelStatusRefresh(client);
      return;
    }
    if (suppressedChannelId && suppressedChannelId !== hotelChannelId) {
      clearSuppressedHotelStatusChannel(statusKey);
      missingHotelStatusChannelWarnings.delete(`${statusKey}:${suppressedChannelId}`);
    }

    const channel = await client.channels.fetch(hotelChannelId).catch(error => {
      if (!isUnknownChannelError(error)) {
        throw error;
      }
      handleMissingHotelStatusChannel(client, {
        statusKey,
        hotelId,
        hotelChannelId
      });
      return null;
    });
    if (!channel) return;
    clearSuppressedHotelStatusChannel(statusKey, hotelChannelId);
    missingHotelStatusChannelWarnings.delete(`${statusKey}:${hotelChannelId}`);

    const placeholders = hotelGroup.hotelIds.map(() => '?').join(', ');

    // Fetch all active sessions for this hotel group (Deduplicated by agent ID in the visual layer)
    const activeSessions = db.prepare(`
      SELECT s1.*, agents.discord_id, agents.username 
      FROM sessions s1
      JOIN agents ON s1.agent_id = agents.id 
      WHERE s1.hotel_id IN (${placeholders}) AND s1.status = 'active'
      AND COALESCE(s1.session_kind, 'shift') != 'training'
      AND s1.id = (SELECT MAX(s2.id) FROM sessions s2 WHERE s2.agent_id = s1.agent_id AND s2.status = 'active')
      ORDER BY s1.login_time DESC
    `).all(...hotelGroup.hotelIds);

    const hotelName = hotelGroup.label;
    const OVERTIME_HOURS = 8;
    let embedColor, embedTitle, description;
    let components = [];
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

      actionRow.addComponents(checkInBtn, checkOutBtn);
      actionRow2.addComponents(callBtn, maintenanceBtn, handoverBtn);

      // Add Break ending button if agent is on break
      if (primarySession.break_status) {
        const breakLabel = primarySession.break_status === 'Bio Break' ? '🛑 End Bio-break' : '🛑 End Normal Break';
        const endBreakBtn = new ButtonBuilder()
          .setCustomId(`tools_end_bio_${primarySession.discord_id}`)
          .setLabel(breakLabel)
          .setStyle(ButtonStyle.Secondary);
        actionRow2.addComponents(endBreakBtn);
      }
      
      components = [actionRow, actionRow2];
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
    scheduleCombinedHotelStatusRefresh(client);

  } catch (e) {
    if (isUnknownChannelError(e)) {
      handleMissingHotelStatusChannel(client, {
        statusKey,
        hotelId,
        hotelChannelId
      });
      return;
    }
    console.warn('[STATUS] Failed to update hotel status embed:', e.message);
  }
}

function isUnknownChannelError(error) {
  if (!error) return false;
  if (Number(error.code) === 10003) return true;
  return /Unknown Channel/i.test(String(error.message || ''));
}

function getMissingHotelStatusChannelConfigKey(statusKey) {
  const normalizedKey = String(statusKey || '').trim().toUpperCase();
  if (!normalizedKey) return null;
  return `hotel_status_missing_channel:${normalizedKey}`;
}

function getSuppressedHotelStatusChannelId(statusKey) {
  const configKey = getMissingHotelStatusChannelConfigKey(statusKey);
  if (!configKey) return null;
  return db.prepare("SELECT value FROM config WHERE key = ?").get(configKey)?.value || null;
}

function suppressMissingHotelStatusChannel(statusKey, hotelChannelId) {
  const configKey = getMissingHotelStatusChannelConfigKey(statusKey);
  if (!configKey || !hotelChannelId) return;
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(configKey, String(hotelChannelId));
}

function clearSuppressedHotelStatusChannel(statusKey, hotelChannelId = null) {
  const configKey = getMissingHotelStatusChannelConfigKey(statusKey);
  if (!configKey) return;

  if (hotelChannelId) {
    const currentValue = db.prepare("SELECT value FROM config WHERE key = ?").get(configKey)?.value || null;
    if (currentValue && currentValue !== String(hotelChannelId)) return;
  }

  db.prepare("DELETE FROM config WHERE key = ?").run(configKey);
}

function clearSuppressedHotelStatusChannelForHotel(hotelId) {
  const hotelGroup = getHotelStatusGroup(hotelId);
  const statusKey = hotelGroup?.key || String(hotelId || '').trim().toUpperCase();
  clearSuppressedHotelStatusChannel(statusKey);
}

function handleMissingHotelStatusChannel(client, {
  statusKey,
  hotelId,
  hotelChannelId
} = {}) {
  const normalizedStatusKey = String(statusKey || hotelId || '').trim().toUpperCase();
  const normalizedHotelId = String(hotelId || '').trim().toUpperCase();
  if (normalizedStatusKey) {
    db.prepare("DELETE FROM hotel_status WHERE hotel_id = ?").run(normalizedStatusKey);
  }
  if (normalizedHotelId && normalizedHotelId !== normalizedStatusKey) {
    db.prepare("DELETE FROM hotel_status WHERE hotel_id = ?").run(normalizedHotelId);
  }

  suppressMissingHotelStatusChannel(normalizedStatusKey || normalizedHotelId, hotelChannelId);

  const warningKey = `${normalizedStatusKey || normalizedHotelId || 'unknown'}:${hotelChannelId || 'missing'}`;
  if (!missingHotelStatusChannelWarnings.has(warningKey)) {
    missingHotelStatusChannelWarnings.add(warningKey);
    console.warn(
      `[STATUS] Skipping hotel status embed for ${normalizedStatusKey || normalizedHotelId || 'unknown'}: channel ${hotelChannelId || 'missing'} not found.`
    );
  }

  scheduleCombinedHotelStatusRefresh(client);
}

function getHotelStatusGroupsForTeam(teamName) {
  const teamHotels = db.prepare("SELECT id FROM hotels WHERE id != 'TEAM_SHIFT' AND team = ?").all(teamName);
  const normalizedIds = [...new Set(teamHotels.map(row => normalizeCombinedHotelId(row.id)).filter(Boolean))];
  const order = ['DIBS', 'RMDA', 'PARM', 'ECON', 'QI_RV', 'BUEN', 'TRVL', 'VALS', 'INFL', 'ANPI', 'BAYT', 'GLDL', 'MYAL', 'PROS', 'SAGE', 'AD1', 'ZICO', 'WGFR', 'THOK', 'BWSF', 'LQST', 'LQFR', 'BWVI', 'LIVE', 'GICP', 'BRNT', 'BW_TO'];

  const groups = normalizedIds
    .map(hotelId => getHotelStatusGroup(hotelId))
    .filter(Boolean)
    .filter((group, index, arr) => arr.findIndex(entry => entry.key === group.key) === index);

  groups.sort((a, b) => {
    const aIdx = order.indexOf(a.key);
    const bIdx = order.indexOf(b.key);
    const aRank = aIdx === -1 ? 999 : aIdx;
    const bRank = bIdx === -1 ? 999 : bIdx;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.label || a.key).localeCompare(String(b.label || b.key));
  });

  return groups;
}

async function upsertCombinedHotelStatusBoard(client, {
  teamName,
  channelId,
  configKey,
  legacyConfigKey = null,
  scopeLabel
}) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const hotelGroups = getHotelStatusGroupsForTeam(teamName);
  const groupedSessions = new Map(hotelGroups.map(group => [group.key, []]));

  const allActiveSessions = db.prepare(`
    SELECT s1.*, agents.discord_id, agents.username
    FROM sessions s1
    JOIN agents ON s1.agent_id = agents.id
    JOIN hotels ON hotels.id = s1.hotel_id
    WHERE s1.status = 'active'
      AND COALESCE(s1.session_kind, 'shift') != 'training'
      AND hotels.team = ?
      AND s1.id = (
        SELECT MAX(s2.id)
        FROM sessions s2
        WHERE s2.agent_id = s1.agent_id AND s2.status = 'active'
      )
    ORDER BY s1.login_time DESC
  `).all(teamName);

  for (const session of allActiveSessions) {
    const group = getHotelStatusGroup(session.hotel_id);
    if (!groupedSessions.has(group.key)) continue;
    groupedSessions.get(group.key).push(session);
  }

  const activeCount = allActiveSessions.length;
  const hotelCount = hotelGroups.length;
  const teamScopeLabel = scopeLabel || `All ${teamName} hotel boards in one view`;

  const embed = new EmbedBuilder()
    .setTitle('🏨 Aavgo Operations · Hotel Status')
    .setDescription(
      `### ${activeCount > 0 ? '✅ LIVE HOTEL PRESENCE' : '⚠️ NO ACTIVE HOTEL LOGINS'}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `> 🏨 **Hotels Tracked:** ${hotelCount}\n` +
      `> 👤 **Active Hotel Sessions:** ${activeCount}\n` +
      `> 📍 **Scope:** ${teamScopeLabel}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    )
    .setColor(activeCount > 0 ? 0x57F287 : 0x2C2F33)
    .setFooter({ text: `Aavgo Operations • Consolidated Hotel Status • ${teamName}` })
    .setTimestamp();

  if (hotelGroups.length === 0) {
    embed.addFields({
      name: `🏨 ${teamName}`,
      value: '• No hotels are configured for this team yet.',
      inline: false
    });
  } else {
    for (const group of hotelGroups) {
      const sessions = groupedSessions.get(group.key) || [];
      if (sessions.length === 0) {
        embed.addFields({
          name: `🏨 ${group.label}`,
          value: '• No active agent',
          inline: false
        });
        continue;
      }

      const lines = [];
      for (const session of sessions) {
        let cleanTime = session.login_time;
        if (cleanTime && !cleanTime.includes('T') && !cleanTime.includes('Z')) {
          cleanTime = cleanTime.replace(' ', 'T') + 'Z';
        }
        const loginTime = new Date(cleanTime || Date.now()).getTime();
        const loginUnix = Math.floor(loginTime / 1000);
        const agentLabel = `<@${session.discord_id}>`;
        const statusParts = [agentLabel, `Since: <t:${loginUnix}:R>`];

        if (session.break_status) {
          statusParts.push(`Break: ${session.break_status}`);
        }
        if (session.break_covering_id) {
          statusParts.push(`Covering TL: <@${session.break_covering_id}>`);
        }
        lines.push(`• ${statusParts.join(' | ')}`);
      }

      embed.addFields({
        name: `🏨 ${group.label}`,
        value: lines.join('\n'),
        inline: false
      });
    }
  }

  let stored = db.prepare("SELECT value FROM config WHERE key = ?").get(configKey);
  const usingLegacyKey = !stored?.value && legacyConfigKey;
  if (!stored?.value && legacyConfigKey) {
    stored = db.prepare("SELECT value FROM config WHERE key = ?").get(legacyConfigKey);
  }

  let existingMsg = null;
  if (stored?.value) {
    try {
      existingMsg = await channel.messages.fetch(stored.value);
    } catch (e) {
      existingMsg = null;
      db.prepare("DELETE FROM config WHERE key = ?").run(configKey);
      if (legacyConfigKey) {
        db.prepare("DELETE FROM config WHERE key = ?").run(legacyConfigKey);
      }
    }
  }

  if (existingMsg) {
    await existingMsg.edit({ embeds: [embed] });
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(configKey, existingMsg.id);
    if (usingLegacyKey && legacyConfigKey) {
      db.prepare("DELETE FROM config WHERE key = ?").run(legacyConfigKey);
    }
    return;
  }

  const newMsg = await channel.send({ embeds: [embed] });
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(configKey, newMsg.id);
  if (usingLegacyKey && legacyConfigKey) {
    db.prepare("DELETE FROM config WHERE key = ?").run(legacyConfigKey);
  }
}

async function updateAllHotelStatusEmbed(client) {
  try {
    if (combinedHotelStatusRefreshTimer) {
      clearTimeout(combinedHotelStatusRefreshTimer);
      combinedHotelStatusRefreshTimer = null;
    }

    await upsertCombinedHotelStatusBoard(client, {
      teamName: 'Team 1',
      channelId: HOTEL_STATUS_CHANNEL_ID,
      configKey: 'hotel_status_board_msg_team_1',
      legacyConfigKey: 'hotel_status_board_msg',
      scopeLabel: 'All Team 1 hotel boards in one view'
    });
    await upsertCombinedHotelStatusBoard(client, {
      teamName: 'Team 2',
      channelId: TEAM_2_HOTEL_STATUS_CHANNEL_ID,
      configKey: 'hotel_status_board_msg_team_2',
      scopeLabel: 'All Team 2 hotel boards in one view'
    });
    await upsertCombinedHotelStatusBoard(client, {
      teamName: 'Team 3',
      channelId: TEAM_3_HOTEL_STATUS_CHANNEL_ID,
      configKey: 'hotel_status_board_msg_team_3',
      scopeLabel: 'All Team 3 hotel boards in one view'
    });
    await upsertCombinedHotelStatusBoard(client, {
      teamName: 'Team 4',
      channelId: TEAM_4_HOTEL_STATUS_CHANNEL_ID,
      configKey: 'hotel_status_board_msg_team_4',
      scopeLabel: 'All Team 4 hotel boards in one view'
    });
    await upsertCombinedHotelStatusBoard(client, {
      teamName: 'Team 5',
      channelId: TEAM_5_HOTEL_STATUS_CHANNEL_ID,
      configKey: 'hotel_status_board_msg_team_5',
      scopeLabel: 'All Team 5 hotel boards in one view'
    });
  } catch (error) {
    console.warn('[STATUS] Failed to update combined hotel status embed:', error.message);
  } finally {
    combinedHotelStatusRefreshTimer = null;
  }
}

// ─── /setup-login ────────────────────────────────────
async function clearTeamHotelLiveStatusEmbeds(client, teamName) {
  const groups = getHotelStatusGroupsForTeam(teamName);
  let deletedTracked = 0;
  let deletedRecovered = 0;
  const issues = [];

  for (const group of groups) {
    const statusKey = group.key;
    const hotelChannelId = HOTEL_LOGIN_CHANNELS[statusKey];
    if (!hotelChannelId) continue;

    const channel = await client.channels.fetch(hotelChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      issues.push(`${statusKey}: channel unavailable`);
      db.prepare("DELETE FROM hotel_status WHERE hotel_id = ?").run(statusKey);
      continue;
    }

    const row = db.prepare("SELECT message_id FROM hotel_status WHERE hotel_id = ?").get(statusKey);
    const knownMsgId = String(row?.message_id || '').trim();
    if (knownMsgId) {
      const trackedMsg = await channel.messages.fetch(knownMsgId).catch(() => null);
      if (
        trackedMsg &&
        trackedMsg.author?.id === client.user?.id &&
        Array.isArray(trackedMsg.embeds) &&
        trackedMsg.embeds.some(embed => String(embed.footer?.text || '').includes('Live Status • Ref:'))
      ) {
        await trackedMsg.delete().catch(() => null);
        deletedTracked += 1;
      }
      db.prepare("DELETE FROM hotel_status WHERE hotel_id = ?").run(statusKey);
    }

    const recentMessages = await channel.messages.fetch({ limit: 40 }).catch(() => null);
    if (!recentMessages) continue;
    for (const message of recentMessages.values()) {
      const isLiveStatus = (
        message.author?.id === client.user?.id &&
        Array.isArray(message.embeds) &&
        message.embeds.some(embed => String(embed.footer?.text || '').includes(`Live Status • Ref: ${statusKey}`))
      );
      if (!isLiveStatus) continue;
      await message.delete().catch(() => null);
      deletedRecovered += 1;
    }
  }

  return {
    groupCount: groups.length,
    deletedTracked,
    deletedRecovered,
    issues
  };
}

function buildAgentKioskPayload() {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations · Virtual Kiosk')
    .setDescription(
      '# Welcome to the Agent Portal\n' +
      '### Secure Shift Management System\n\n' +
      'This portal monitors and logs all active sessions in real-time. Please follow the protocol below to initialize your shift.\n\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '### 📋 Protocol\n' +
      '> **1.** Make sure your **PIN** is already set\n' +
      '> **2.** Click **Initialize Shift** below\n' +
      '> **3.** The bot will detect your role automatically\n' +
      '> **4.** Agent route: choose **Live -> Hotel Shift** or **Practice -> Training**\n' +
      '> **5.** Team Leader / SME route: choose your assigned Team 1 / Team 2 / Team 3 shift\n\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '### 🏨 Service Locations\n' +
      '**Team 1:** `Indianhead/Magnuson`, `The Garden Inn At Campsite`, `Ramada / Super 8`, `Travelodge`, `Day Inns Bishop`\n' +
      '**Team 2:** `Prospero Flagship`, `Glendale / The Leef Hotel`, `Inn at the Fingerlakes`, `Value Suites`, `Bayside / Townhouse`, `Anchor Beach / Pacific Inn`\n' +
      '**Team 3:** `Econolodge`, `Buenavista`, `Quality Russelville`, `Thousand Oaks`'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations · Automated Access Control' })
    .setTimestamp();

  const startBtn = new ButtonBuilder()
    .setCustomId('start_shift_btn')
    .setLabel('🚀 Initialize Shift')
    .setStyle(ButtonStyle.Primary);

  const endShiftBtn = new ButtonBuilder()
    .setCustomId('kiosk_end_shift_btn')
    .setLabel('🔴 End Shift')
    .setStyle(ButtonStyle.Danger);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(startBtn, endShiftBtn)
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

    await message.edit(buildAgentKioskPayload());
    console.log(`[KIOSK] Refreshed kiosk layout in channel ${channelId}: ${message.id}`);

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
        '**Team 1:** `Indianhead/Magnuson`, `The Garden Inn At Campsite`, `Ramada / Super 8`, `Travelodge`, `Day Inns Bishop`\n' +
        '**Team 2:** `Prospero Flagship`, `Glendale / The Leef Hotel`, `Inn at the Fingerlakes`, `Value Suites`, `Bayside / Townhouse`, `Anchor Beach / Pacific Inn`\n' +
        '**Team 3:** `Econolodge`, `Buenavista`, `Quality Russelville`, `Thousand Oaks`'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Aavgo Operations · Automated Access Control' })
      .setTimestamp();

    const startBtn = new ButtonBuilder()
      .setCustomId('start_shift_btn')
      .setLabel('🚀 Initialize Shift')
      .setStyle(ButtonStyle.Primary);

    const endShiftBtn = new ButtonBuilder()
      .setCustomId('kiosk_end_shift_btn')
      .setLabel('🔴 End Shift')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(startBtn, endShiftBtn);
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
    await updateTeamStatusEmbed(interaction.client, 'Team 2');
    await updateTeamStatusEmbed(interaction.client, 'Team 3');
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

function getTeamBoardChannelLabel(teamName) {
  if (teamName === 'Team 1') return `<#${HOTEL_STATUS_CHANNEL_ID}>`;
  if (teamName === 'Team 2') return `<#${TEAM_2_HOTEL_STATUS_CHANNEL_ID}>`;
  if (teamName === 'Team 3') return `<#${TEAM_3_HOTEL_STATUS_CHANNEL_ID}>`;
  return 'Not configured';
}

function getTeamHotelSummary(teamName) {
  const hotels = db.prepare(`
    SELECT name
    FROM hotels
    WHERE id != 'TEAM_SHIFT' AND team = ?
    ORDER BY name COLLATE NOCASE ASC
  `).all(teamName);
  if (hotels.length === 0) return 'No hotels configured';
  return hotels.map(row => `\`${row.name}\``).join(', ');
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

      const teamLabel = name;
      const hotelLabel = `${getTeamHotelSummary(name)}\nBoard: ${getTeamBoardChannelLabel(name)}`;

      const liveLines = loggedIn.length > 0
        ? loggedIn
          .map(row => `- <@${row.discord_id}> | ${getRoleLabel(row.role)} | active ${formatLoginTimeLabel(row.login_time)}`)
          .join('\n')
        : '- No one is currently logged in';

      const offlineLines = offline.length > 0
        ? offline.map(row => `- <@${row.discord_id}>`).join('\n')
        : '- Everyone in roster is online';

      return {
        name: `${teamLabel} Status`,
        value:
          `**Hotels**\n${hotelLabel}\n` +
          `────────────────────────\n` +
          `**Online Now**\n${liveLines}\n\n` +
          `**Offline**\n${offlineLines}`,
        inline: false
      };
    });

    const teamOnlineLines = TEAM_NAMES.map(name => {
      const count = activeTLs.filter(row => row.team === name).length;
      return `**${name} Online:** ${count}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Team Leader Login Status')
      .setDescription(
        '**Live Management Board**\n' +
        '────────────────────────\n' +
        `${teamOnlineLines.join('\n')}\n` +
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

    const groupedSessions = new Map();
    for (const session of trainingSessions) {
      const hotelId = normalizeCombinedHotelId(session.hotel_id);
      const groupLabel = getTrainingGroupLabel(hotelId);
      if (!groupedSessions.has(groupLabel)) groupedSessions.set(groupLabel, []);
      groupedSessions.get(groupLabel).push(session);
    }

    const buildFieldValue = sessions => {
      const rows = sessions.map(session => `� <@${session.discord_id}> | Since: ${formatLoginTimeLabel(session.login_time)}`);
      const chunks = [];
      let current = '';
      for (const row of rows) {
        const next = current ? `${current}\n${row}` : row;
        if (next.length > 950) {
          if (current) chunks.push(current);
          current = row;
        } else {
          current = next;
        }
      }
      if (current) chunks.push(current);
      return chunks;
    };

    const trainingFields = [];
    const orderedLabels = TRAINING_HOTEL_GROUPS.map(group => group.label);
    const seenLabels = new Set();

    for (const label of orderedLabels) {
      const sessions = groupedSessions.get(label);
      if (!sessions || sessions.length === 0) continue;
      seenLabels.add(label);
      const chunks = buildFieldValue(sessions);
      for (let i = 0; i < chunks.length; i += 1) {
        trainingFields.push({
          name: i === 0 ? label : `${label} (cont.)`,
          value: chunks[i],
          inline: false
        });
      }
    }

    for (const [label, sessions] of groupedSessions.entries()) {
      if (seenLabels.has(label)) continue;
      const chunks = buildFieldValue(sessions);
      for (let i = 0; i < chunks.length; i += 1) {
        trainingFields.push({
          name: i === 0 ? label : `${label} (cont.)`,
          value: chunks[i],
          inline: false
        });
      }
    }

    if (trainingFields.length === 0) {
      trainingFields.push({
        name: 'All members in training',
        value: '� No active trainee',
        inline: false
      });
    }

    const activeLabel = trainingSessions.length > 0 ? '?? TRAINING IN PROGRESS' : '? TRAINING BOARD IDLE';
    const embed = new EmbedBuilder()
      .setTitle('?? Aavgo Operations � Training Status')
      .setDescription(
        `### ${activeLabel}\n` +
        '--------------\n' +
        `**?? Board:** Live training presence tracker\n` +
        `**?? Active Trainees:** ${trainingSessions.length}\n` +
        `**?? Scope:** All members in training\n` +
        '--------------'
      )
      .setColor(trainingSessions.length > 0 ? 0x5865F2 : 0x2B2D31)
      .setFields(trainingFields)
      .setFooter({ text: 'Aavgo Operations � Training Presence' })
      .setTimestamp();

    const components = [];
    if (trainingSessions.length > 0) {
      const endTrainingBtn = new ButtonBuilder()
        .setCustomId('training_end_btn')
        .setLabel('?? End-training')
        .setStyle(ButtonStyle.Danger);
      components.push(new ActionRowBuilder().addComponents(endTrainingBtn));
    }

    const key = 'training_status_msg';
    const stored = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
    if (stored?.value) {
      try {
        const msg = await channel.messages.fetch(stored.value);
        await msg.edit({ embeds: [embed], components });
        return;
      } catch (e) {
        db.prepare("DELETE FROM config WHERE key = ?").run(key);
      }
    }

    const newMsg = await channel.send({ embeds: [embed], components });
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
    await updateAllHotelStatusEmbed(client);
    await updateTeamStatusEmbed(client, 'Team 1');
    await updateTeamStatusEmbed(client, 'Team 2');
    await updateTeamStatusEmbed(client, 'Team 3');
    await updateTrainingStatusEmbed(client);
  } catch (error) {
    console.warn('[STATUS] Boot refresh failed:', error.message);
  }
}

async function monitorOvertimeSessionsLegacy(client) {
  try {
    const activeSessions = db.prepare(`
      SELECT
        sessions.id,
        sessions.agent_id,
        sessions.login_time,
        COALESCE(sessions.time_travel_offset_ms, 0) AS time_travel_offset_ms,
        sessions.overtime_warning_at,
        sessions.overtime_next_warning_at,
        COALESCE(sessions.overtime_confirmed, 0) AS overtime_confirmed,
        COALESCE(sessions.session_kind, 'shift') AS session_kind,
        agents.discord_id,
        agents.username,
        agents.role
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE sessions.status = 'active'
    `).all();

    const activeSessionIdSet = new Set(activeSessions.map(session => String(session.id)));
    for (const warnedId of [...overtimeWarnedSessionIds]) {
      if (!activeSessionIdSet.has(warnedId)) {
        overtimeWarnedSessionIds.delete(warnedId);
      }
    }

    const nowMs = Date.now();
    const guild = client.guilds.cache.first();
    for (const session of activeSessions) {
      const warningThresholdMs = getOvertimeWarningThresholdMs(session, client.guilds.cache.first());
      const nextWarningDueMs = getSessionNextWarningDueMs(session, warningThresholdMs);
      const sessionIdKey = String(session.id);
      const warningMs = session.overtime_warning_at ? parseSessionTimestamp(session.overtime_warning_at) : null;
      const warningElapsedMs = warningMs ? nowMs - warningMs : null;
      const warningExpired = warningElapsedMs !== null && warningElapsedMs >= OVERTIME_CONFIRM_GRACE_MS;
      const reachedWarningThreshold = nowMs >= nextWarningDueMs;

      if (!warningMs && reachedWarningThreshold && !overtimeWarnedSessionIds.has(sessionIdKey)) {
        overtimeWarnedSessionIds.add(sessionIdKey);
        try {
          await sendOvertimeWarningNotice(client, session, 'AUTO', warningThresholdMs);
        } catch (warnErr) {
          console.warn('[OVERTIME] Failed to send warning notice:', warnErr.message);
        }
      }

      if (warningMs && warningExpired) {
        const agentKey = String(session.agent_id);
        if (overtimeAutoLogoutAgentIds.has(agentKey)) continue;
        overtimeAutoLogoutAgentIds.add(agentKey);

        try {
          const agentSessions = db.prepare(`
            SELECT
              sessions.id,
              sessions.hotel_id,
              sessions.login_time,
              COALESCE(sessions.time_travel_offset_ms, 0) AS time_travel_offset_ms,
              COALESCE(sessions.session_kind, 'shift') AS session_kind,
              agents.discord_id,
              agents.role
            FROM sessions
            JOIN agents ON agents.id = sessions.agent_id
            WHERE sessions.agent_id = ? AND sessions.status = 'active'
          `).all(session.agent_id);

          if (agentSessions.length === 0) {
            overtimeAutoLogoutAgentIds.delete(agentKey);
            continue;
          }

          await closeAllActiveSessionsForAgent(session.agent_id, client);
          const overtimeMember = guild?.members?.cache?.get(session.discord_id) || null;
          if (overtimeMember) {
            await applyLoggedOutRolesForMember(guild, overtimeMember, agentSessions);
          }

          const primarySessionOverLimit = nowMs >= nextWarningDueMs;
          for (const active of agentSessions) {
            const activeThresholdMs = getOvertimeWarningThresholdMs(active, client.guilds.cache.first());
            const activeDueMs = getSessionNextWarningDueMs(active, activeThresholdMs);
            const wasOverLimit = nowMs >= activeDueMs;
            const usingSimulatedOffset = getSessionTimeTravelOffsetMs(active) > 0;
            const cappedIso = (wasOverLimit && !usingSimulatedOffset)
              ? new Date(activeDueMs).toISOString()
              : new Date(nowMs).toISOString();
            db.prepare("UPDATE sessions SET logout_time = ?, overtime_warning_at = NULL, overtime_confirmed = 0, overtime_next_warning_at = NULL WHERE id = ?").run(cappedIso, active.id);
            overtimeWarnedSessionIds.delete(String(active.id));
            overtimeConfirmedSessionIds.delete(String(active.id));
          }

          const user = await client.users.fetch(session.discord_id).catch(() => null);
          if (user) {
            const reasonText = primarySessionOverLimit
              ? `You reached the **${warningThresholdMs === OVERTIME_TEST_WARNING_MS ? '3 minute test' : '8 hour'}** limit and did not confirm overtime in time.`
              : 'You did not click **Confirm Overtime** before the 15-minute grace window ended.';
            const capText = primarySessionOverLimit
              ? `This record is capped at **${warningThresholdMs === OVERTIME_TEST_WARNING_MS ? '3 minutes' : '8 hours'}**.`
              : 'This record was closed at the end of the grace window.';
            const autoLogoutEmbed = new EmbedBuilder()
              .setTitle('🛑 Overtime Auto Logout')
              .setDescription(
                `${reasonText}\n\n${capText}`
              )
              .addFields(
                { name: 'Mode', value: session.session_kind === 'training' ? 'Training' : 'Shift', inline: true },
                { name: 'Reason', value: 'No Confirm Overtime click', inline: true }
              )
              .setColor(0xED4245)
              .setFooter({ text: 'Aavgo Operations - Overtime Control' })
              .setTimestamp();
            await user.send({ embeds: [autoLogoutEmbed] }).catch(() => {});
          }

            sendAuditLog(client, {
              title: '⛔ Overtime Auto Logout',
              description:
                `**User:** ${session.username} (<@${session.discord_id}>)\n` +
                `**Mode:** ${session.session_kind === 'training' ? 'Training' : 'Shift'}\n` +
              `**Rule:** Auto-logout after warning + ${Math.floor(OVERTIME_CONFIRM_GRACE_MS / 60000)} minute grace window${primarySessionOverLimit ? `, capped to ${warningThresholdMs === OVERTIME_TEST_WARNING_MS ? '3 minutes' : '8h'} logged time` : ''}`,
              color: 0xED4245,
              userId: session.discord_id
            });
        } catch (autoErr) {
          console.error('[OVERTIME] Auto logout failed:', autoErr);
        } finally {
          overtimeAutoLogoutAgentIds.delete(agentKey);
        }
      }
    }
  } catch (error) {
    console.warn('[OVERTIME] Monitor tick failed:', error.message);
  }
}

async function monitorOvertimeSessions(client) {
  try {
    const activeSessions = db.prepare(`
      SELECT
        sessions.id,
        sessions.agent_id,
        sessions.login_time,
        COALESCE(sessions.time_travel_offset_ms, 0) AS time_travel_offset_ms,
        sessions.overtime_warning_at,
        sessions.overtime_next_warning_at,
        COALESCE(sessions.overtime_confirmed, 0) AS overtime_confirmed,
        COALESCE(sessions.session_kind, 'shift') AS session_kind,
        agents.discord_id,
        agents.username,
        agents.role
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE sessions.status = 'active'
    `).all();

    const activeSessionIdSet = new Set(activeSessions.map(session => String(session.id)));
    for (const warnedId of [...overtimeWarnedSessionIds]) {
      if (!activeSessionIdSet.has(warnedId)) {
        overtimeWarnedSessionIds.delete(warnedId);
      }
    }

    const nowMs = Date.now();
    const guild = client.guilds.cache.first();
    for (const session of activeSessions) {
      const warningThresholdMs = getOvertimeWarningThresholdMs(session, guild);
      const warningDueMs = getSessionNextWarningDueMs(session, warningThresholdMs);
      const finalLimitDueMs = getSessionFinalLimitDueMs(session, OVERTIME_FINAL_LIMIT_MS);
      const sessionIdKey = String(session.id);
      const warningMs = session.overtime_warning_at ? parseSessionTimestamp(session.overtime_warning_at) : null;
      const hasConfirmedOvertime = Number(session.overtime_confirmed || 0) === 1;
      const warningElapsedMs = warningMs ? nowMs - warningMs : null;
      const warningExpired = warningElapsedMs !== null && warningElapsedMs >= OVERTIME_CONFIRM_GRACE_MS;
      const reachedWarningThreshold = nowMs >= warningDueMs;
      const reachedFinalLimit = nowMs >= finalLimitDueMs;

      if (reachedFinalLimit) {
        const agentKey = String(session.agent_id);
        if (overtimeAutoLogoutAgentIds.has(agentKey)) continue;
        overtimeAutoLogoutAgentIds.add(agentKey);

        try {
          const agentSessions = db.prepare(`
            SELECT
              sessions.id,
              sessions.hotel_id,
              sessions.login_time,
              COALESCE(sessions.time_travel_offset_ms, 0) AS time_travel_offset_ms,
              COALESCE(sessions.session_kind, 'shift') AS session_kind,
              agents.discord_id,
              agents.role
            FROM sessions
            JOIN agents ON agents.id = sessions.agent_id
            WHERE sessions.agent_id = ? AND sessions.status = 'active'
          `).all(session.agent_id);

          if (agentSessions.length === 0) {
            overtimeAutoLogoutAgentIds.delete(agentKey);
            continue;
          }

          await closeAllActiveSessionsForAgent(session.agent_id, client);
          const overtimeMember = guild?.members?.cache?.get(session.discord_id) || null;
          if (overtimeMember) {
            await applyLoggedOutRolesForMember(guild, overtimeMember, agentSessions);
          }

          for (const active of agentSessions) {
            const activeFinalDueMs = getSessionFinalLimitDueMs(active, OVERTIME_FINAL_LIMIT_MS);
            const usingSimulatedOffset = getSessionTimeTravelOffsetMs(active) > 0;
            const cappedIso = (nowMs >= activeFinalDueMs && !usingSimulatedOffset)
              ? new Date(activeFinalDueMs).toISOString()
              : new Date(nowMs).toISOString();
            db.prepare('UPDATE sessions SET logout_time = ?, overtime_warning_at = NULL, overtime_confirmed = 0, overtime_next_warning_at = NULL WHERE id = ?').run(cappedIso, active.id);
            overtimeWarnedSessionIds.delete(String(active.id));
            overtimeConfirmedSessionIds.delete(String(active.id));
          }

          const user = await client.users.fetch(session.discord_id).catch(() => null);
          if (user) {
            const finalLimitEmbed = new EmbedBuilder()
              .setTitle('⛔ 12-Hour Shift Limit Reached')
              .setDescription(
                'You reached the final **12-hour overtime limit** for this session.\n\n' +
                'Your shift was ended automatically. You may start a new shift when needed.'
              )
              .addFields(
                { name: 'Mode', value: session.session_kind === 'training' ? 'Training' : 'Shift', inline: true },
                { name: 'Limit', value: '12 hours (final)', inline: true }
              )
              .setColor(0xED4245)
              .setFooter({ text: 'Aavgo Operations - Overtime Control' })
              .setTimestamp();
            await user.send({ embeds: [finalLimitEmbed] }).catch(() => {});
          }

          const limitNotifyStats = await notifyNotificationRoleMembers(client, {
            title: '⛔ 12-Hour Limit Reached',
            description:
              `**Agent:** ${session.username} (<@${session.discord_id}>)\n` +
              `**Mode:** ${session.session_kind === 'training' ? 'Training' : 'Shift'}\n` +
              '**Event:** Auto-logout at final overtime limit.'
          });

          await sendAuditLog(client, {
            title: '⛔ 12-Hour Limit Auto Logout',
            description:
              `**User:** ${session.username} (<@${session.discord_id}>)\n` +
              `**Mode:** ${session.session_kind === 'training' ? 'Training' : 'Shift'}\n` +
              '**Rule:** Final overtime cap reached at 12 hours.\n' +
              `**Notification Role DM:** ${limitNotifyStats.sent}/${limitNotifyStats.attempted} sent (${limitNotifyStats.failed} failed)`,
            color: 0xED4245,
            userId: session.discord_id,
            channelIdOverride: OVERTIME_12H_LOG_CHANNEL_ID
          });
        } catch (limitErr) {
          console.error('[OVERTIME] 12-hour auto logout failed:', limitErr);
        } finally {
          overtimeAutoLogoutAgentIds.delete(agentKey);
        }
        continue;
      }

      if (!warningMs && !hasConfirmedOvertime && reachedWarningThreshold && !overtimeWarnedSessionIds.has(sessionIdKey)) {
        overtimeWarnedSessionIds.add(sessionIdKey);
        try {
          await sendOvertimeWarningNotice(client, session, 'AUTO', warningThresholdMs);
        } catch (warnErr) {
          console.warn('[OVERTIME] Failed to send warning notice:', warnErr.message);
        }
      }

      if (warningMs && !hasConfirmedOvertime && warningExpired) {
        const agentKey = String(session.agent_id);
        if (overtimeAutoLogoutAgentIds.has(agentKey)) continue;
        overtimeAutoLogoutAgentIds.add(agentKey);

        try {
          const agentSessions = db.prepare(`
            SELECT
              sessions.id,
              sessions.hotel_id,
              sessions.login_time,
              COALESCE(sessions.time_travel_offset_ms, 0) AS time_travel_offset_ms,
              COALESCE(sessions.session_kind, 'shift') AS session_kind,
              agents.discord_id,
              agents.role
            FROM sessions
            JOIN agents ON agents.id = sessions.agent_id
            WHERE sessions.agent_id = ? AND sessions.status = 'active'
          `).all(session.agent_id);

          if (agentSessions.length === 0) {
            overtimeAutoLogoutAgentIds.delete(agentKey);
            continue;
          }

          await closeAllActiveSessionsForAgent(session.agent_id, client);
          const overtimeMember = guild?.members?.cache?.get(session.discord_id) || null;
          if (overtimeMember) {
            await applyLoggedOutRolesForMember(guild, overtimeMember, agentSessions);
          }

          for (const active of agentSessions) {
            const activeThresholdMs = getOvertimeWarningThresholdMs(active, guild);
            const activeDueMs = getSessionNextWarningDueMs(active, activeThresholdMs);
            const usingSimulatedOffset = getSessionTimeTravelOffsetMs(active) > 0;
            const cappedIso = (nowMs >= activeDueMs && !usingSimulatedOffset)
              ? new Date(activeDueMs).toISOString()
              : new Date(nowMs).toISOString();
            db.prepare('UPDATE sessions SET logout_time = ?, overtime_warning_at = NULL, overtime_confirmed = 0, overtime_next_warning_at = NULL WHERE id = ?').run(cappedIso, active.id);
            overtimeWarnedSessionIds.delete(String(active.id));
            overtimeConfirmedSessionIds.delete(String(active.id));
          }

          const user = await client.users.fetch(session.discord_id).catch(() => null);
          if (user) {
            const thresholdLabel = getOvertimeThresholdLabel(warningThresholdMs);
            const autoLogoutEmbed = new EmbedBuilder()
              .setTitle('🛑 Overtime Auto Logout')
              .setDescription(
                'You did not click **Confirm Overtime** within the 15-minute grace window.\n\n' +
                `This record is capped at **${thresholdLabel}**.`
              )
              .addFields(
                { name: 'Mode', value: session.session_kind === 'training' ? 'Training' : 'Shift', inline: true },
                { name: 'Reason', value: 'No Confirm Overtime click', inline: true }
              )
              .setColor(0xED4245)
              .setFooter({ text: 'Aavgo Operations - Overtime Control' })
              .setTimestamp();
            await user.send({ embeds: [autoLogoutEmbed] }).catch(() => {});
          }

          await sendAuditLog(client, {
            title: '⛔ 8-Hour OT Auto Logout (No Confirm)',
            description:
              `**User:** ${session.username} (<@${session.discord_id}>)\n` +
              `**Mode:** ${session.session_kind === 'training' ? 'Training' : 'Shift'}\n` +
              `**Rule:** No Confirm Overtime action within ${Math.floor(OVERTIME_CONFIRM_GRACE_MS / 60000)} minutes after warning.\n` +
              `**Cap Applied:** ${getOvertimeThresholdLabel(warningThresholdMs)}`,
            color: 0xED4245,
            userId: session.discord_id,
            channelIdOverride: OVERTIME_8H_LOG_CHANNEL_ID
          });
        } catch (autoErr) {
          console.error('[OVERTIME] Auto logout failed:', autoErr);
        } finally {
          overtimeAutoLogoutAgentIds.delete(agentKey);
        }
      }
    }
  } catch (error) {
    console.warn('[OVERTIME] Monitor tick failed:', error.message);
  }
}

function hasConfiguredPin(agent) {
  return Number(agent?.pin_is_set ?? 1) === 1;
}

async function promptForPinSetup(interaction, hotelName = 'Shift', sessionMode = 'shift') {
  const setupEmbed = new EmbedBuilder()
    .setTitle('🔐 PIN Needed')
    .setDescription(
      `Oh no, you have not set your PIN yet.\n\n` +
      `To continue with **${hotelName}**, please set your security PIN first.\n\n` +
      `This is always checked first, so the bot can send you to the right route automatically once your PIN is saved.`
    )
    .setColor(0xFEE75C)
    .setFooter({ text: sessionMode === 'training' ? 'Training access requires a security PIN' : 'Shift access requires a security PIN' })
    .setTimestamp();

  const setupBtn = new ButtonBuilder()
    .setCustomId('security_setup_btn')
    .setLabel('Set Security PIN')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(setupBtn);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [setupEmbed], components: [row] });
  }
  return interaction.reply({ embeds: [setupEmbed], components: [row], ephemeral: true });
}

function buildShiftConflictEmbed(hotelId, otherAgent, loginTime = null) {
  const hotelName = getCombinedHotelLabel(hotelId);
  const sinceLabel = loginTime ? formatLoginTimeLabel(loginTime) : 'Unknown';

  return new EmbedBuilder()
    .setTitle(`⚠️ Aavgo Operations · ${hotelName} Conflict`)
    .setDescription(
      `### ⚠️ SHIFT ALREADY ACTIVE\n` +
      '────────────────────────\n' +
      `**🤖 Board:** Another live session is already running for this hotel.\n` +
      `**📍 Hotel:** ${hotelName}\n` +
      '────────────────────────'
    )
    .addFields(
      { name: '👤 Active Agent', value: otherAgent?.username ? `**${otherAgent.username}**` : 'Unknown Agent', inline: true },
      { name: '📅 Since', value: sinceLabel, inline: true },
      { name: '🛡️ Next Step', value: 'Use the takeover flow below if you are authorized to replace this live session.', inline: false }
    )
    .setColor(0xFEE75C)
    .setFooter({ text: 'Aavgo Operations • Shift Control' })
    .setTimestamp();
}

function isTraineeMember(interaction) {
  return interaction?.member?.roles?.cache?.some(role => {
    const roleName = normalizeDiscordRoleName(role?.name);
    return roleName === 'trainee' || roleName === 'trainees';
  });
}

function normalizeDiscordRoleName(roleName) {
  return String(roleName || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function hasDiscordRoleName(roleNames, candidates) {
  return candidates.some(candidate => roleNames.includes(normalizeDiscordRoleName(candidate)));
}

async function enforceExclusiveRankRoles(member, guild, contextLabel = 'ROLE SYNC', preferredRankRoleId = null) {
  try {
    if (!member || !guild) return null;

    const presentRankRoleIds = EXCLUSIVE_RANK_ROLE_PRIORITY.filter(roleId => member.roles.cache.has(roleId));
    if (presentRankRoleIds.length <= 1) return presentRankRoleIds[0] || null;

    const rankRoleIdByDbRole = {
      applicant: APPLICANT_ROLE_ID,
      trainee: TRAINEE_ROLE_ID,
      agent: AGENT_ROLE_ID,
      sme: SME_ROLE_ID,
      team_leader: TEAM_LEADER_ROLE_ID
    };
    const dbRole = normalizeAgentRole(
      db.prepare("SELECT role FROM agents WHERE discord_id = ?").get(member.id)?.role || ''
    );
    const dbPreferredRoleId = rankRoleIdByDbRole[dbRole];

    const keepRoleId = (
      (preferredRankRoleId && presentRankRoleIds.includes(preferredRankRoleId) && preferredRankRoleId) ||
      (dbPreferredRoleId && presentRankRoleIds.includes(dbPreferredRoleId) && dbPreferredRoleId) ||
      EXCLUSIVE_RANK_ROLE_PRIORITY.find(roleId => member.roles.cache.has(roleId)) ||
      presentRankRoleIds[0]
    );
    const removeRoleIds = presentRankRoleIds.filter(roleId => roleId !== keepRoleId);
    const removableRoles = removeRoleIds
      .map(roleId => guild.roles.cache.get(roleId))
      .filter(role => role && role.editable);

    if (removableRoles.length > 0) {
      await member.roles.remove(removableRoles);
      const keptRoleName = guild.roles.cache.get(keepRoleId)?.name || keepRoleId;
      const removedRoleNames = removableRoles.map(role => role.name).join(', ');
      const dbRoleLabel = dbRole ? getRoleLabel(dbRole) : 'none';
      const keepReason = preferredRankRoleId && keepRoleId === preferredRankRoleId
        ? 'preferred assignment'
        : (dbPreferredRoleId && keepRoleId === dbPreferredRoleId ? 'db-aligned' : 'priority fallback');
      console.log(`[${contextLabel}] Enforced rank-role exclusivity for ${member.displayName || member.user?.username || member.id}: kept ${keptRoleName} (${keepReason}), removed ${removedRoleNames}, dbRole=${dbRoleLabel}`);
    }

    return keepRoleId;
  } catch (error) {
    console.warn(`[${contextLabel}] Could not enforce rank-role exclusivity for ${member?.displayName || member?.user?.username || member?.id || 'unknown'}:`, error.message);
    return null;
  }
}

function getDiscordRoleSyncSnapshot(member) {
  const roleIds = new Set([...(member?.roles?.cache?.keys?.() || [])]);
  const roleNames = [...(member?.roles?.cache?.values?.() || [])]
    .map(role => normalizeDiscordRoleName(role?.name))
    .filter(Boolean);

  const teamName = normalizeTeamInput(roleNames.find(name => (
    name === 'team 1' ||
    name === 'team 2' ||
    name === 'team 3' ||
    name === 'team 4' ||
    name === 'team 5'
  ))) || null;

  if (hasDiscordRoleName(roleNames, ['subject matter expert', 'subject_matter_expert', 'sme'])) {
    return { role: 'sme', team: teamName };
  }
  if (hasDiscordRoleName(roleNames, ['team leader', 'team_leader'])) {
    return { role: 'team_leader', team: teamName };
  }
  if (hasDiscordRoleName(roleNames, ['agent', 'agents'])) {
    return { role: 'agent', team: teamName };
  }
  if (hasDiscordRoleName(roleNames, ['trainee', 'trainees'])) {
    return { role: 'trainee', team: teamName };
  }
  if (roleIds.has(APPLICANT_ROLE_ID) || hasDiscordRoleName(roleNames, ['applicant', 'applicants'])) {
    return { role: 'applicant', team: teamName };
  }

  return { role: null, team: teamName };
}

function getDiscordHotelCompatibilitySnapshot(member) {
  return getAssignedHotelIdsFromMemberRoles(member);
}

function getAssignedHotelIdsFromMemberRoles(member) {
  const hotelRoleEntries = [
    ...Object.entries(ROLE_NAMES.GREY),
    ...Object.entries(ROLE_NAMES.GREEN)
  ];
  const hotelIds = hotelRoleEntries
    .filter(([hotelId, roleId]) => HOTEL_NAMES[hotelId] && member?.roles?.cache?.has(roleId))
    .map(([hotelId]) => normalizeCombinedHotelId(hotelId));
  return [...new Set(hotelIds)];
}

function getLiveHotelIdsFromMemberRoles(member) {
  const hotelIds = Object.entries(ROLE_NAMES.GREEN)
    .filter(([hotelId, roleId]) => HOTEL_NAMES[hotelId] && member?.roles?.cache?.has(roleId))
    .map(([hotelId]) => normalizeCombinedHotelId(hotelId));
  return [...new Set(hotelIds)];
}

function resolveLiveHotelIdFromMemberRoles(member, activeSessions = []) {
  const liveRoleHotelIds = [...new Set(
    getLiveHotelIdsFromMemberRoles(member)
      .map(normalizeCombinedHotelId)
      .filter(Boolean)
      .filter(hotelId => HOTEL_NAMES[hotelId])
  )];

  if (liveRoleHotelIds.length === 1) {
    return liveRoleHotelIds[0];
  }

  if (liveRoleHotelIds.length > 1) {
    return liveRoleHotelIds[0];
  }

  const activeHotelIds = [...new Set(
    (Array.isArray(activeSessions) ? activeSessions : [])
      .map(session => normalizeCombinedHotelId(session?.hotel_id || session?.hotelId))
      .filter(Boolean)
      .filter(hotelId => hotelId !== 'TEAM_SHIFT' && HOTEL_NAMES[hotelId])
  )];

  if (activeHotelIds.length === 1) {
    return activeHotelIds[0];
  }

  const assignedHotelIds = [...new Set(
    getAssignedHotelIdsFromMemberRoles(member)
      .map(normalizeCombinedHotelId)
      .filter(Boolean)
      .filter(hotelId => HOTEL_NAMES[hotelId])
  )];
  const overlap = activeHotelIds.find(hotelId => assignedHotelIds.includes(hotelId));
  return overlap || null;
}

function getAssignedGreyHotelIdsFromMemberRoles(member) {
  const hotelIds = Object.entries(ROLE_NAMES.GREY)
    .filter(([hotelId, roleId]) => HOTEL_NAMES[hotelId] && member?.roles?.cache?.has(roleId))
    .map(([hotelId]) => normalizeCombinedHotelId(hotelId));
  return [...new Set(hotelIds)];
}

function serializeHotelCompatibility(hotelIds) {
  return JSON.stringify([...new Set((hotelIds || []).filter(Boolean))]);
}

function formatHotelCompatibilityLabel(hotelIds) {
  const labels = [...new Set((hotelIds || []).filter(Boolean))].map(getCombinedHotelLabel);
  return labels.length > 0 ? labels.join(', ') : 'none';
}

function resolveTeamFromMemberRoles(member) {
  if (!member?.roles?.cache) return null;
  const hasTeam1 = member.roles.cache.some(role => normalizeDiscordRoleName(role?.name) === 'team 1');
  if (hasTeam1) return 'Team 1';
  const hasTeam2 = member.roles.cache.some(role => normalizeDiscordRoleName(role?.name) === 'team 2');
  if (hasTeam2) return 'Team 2';
  const hasTeam3 = member.roles.cache.some(role => normalizeDiscordRoleName(role?.name) === 'team 3');
  if (hasTeam3) return 'Team 3';
  const hasTeam4 = member.roles.cache.some(role => normalizeDiscordRoleName(role?.name) === 'team 4');
  if (hasTeam4) return 'Team 4';
  const hasTeam5 = member.roles.cache.some(role => normalizeDiscordRoleName(role?.name) === 'team 5');
  if (hasTeam5) return 'Team 5';
  return null;
}

function hasEffectiveTeamAssignment(agent, member) {
  const dbTeam = normalizeTeamInput(agent?.team);
  const roleTeam = normalizeTeamInput(resolveTeamFromMemberRoles(member));
  // Require active Discord team-role assignment as the gate source of truth.
  if (!roleTeam) return false;
  // If DB team exists too, it must align with the live Discord team role.
  if (dbTeam && dbTeam !== roleTeam) return false;
  return true;
}

async function syncNoPinRoleForMember(member, guild, agentRecord, contextLabel = 'ROLE SYNC') {
  try {
    if (!member || !guild) return;

    const noPinRole =
      guild.roles.cache.get(NO_PIN_ROLE_ID) ||
      guild.roles.cache.find(role => {
        const normalized = normalizeDiscordRoleName(role?.name);
        return normalized === 'unverified' || normalized === 'no pin';
      });
    if (!noPinRole) return;

    const roleNames = [...(member.roles?.cache?.values?.() || [])]
      .map(role => normalizeDiscordRoleName(role?.name))
      .filter(Boolean);
    const hasAgentOrTraineeRole =
      member.roles.cache.has(AGENT_ROLE_ID) ||
      member.roles.cache.has(TRAINEE_ROLE_ID) ||
      hasDiscordRoleName(roleNames, ['agent', 'agents', 'trainee', 'trainees']);
    const pinConfigured = hasConfiguredPin(agentRecord);
    const hasNoPinRole = member.roles.cache.has(noPinRole.id);

    if (hasAgentOrTraineeRole && !pinConfigured && !hasNoPinRole) {
      await member.roles.add(noPinRole);
      console.log(`[${contextLabel}] Added ${noPinRole.name} to ${member.displayName || member.user?.username || member.id} (PIN missing).`);
      return;
    }

    if ((!hasAgentOrTraineeRole || pinConfigured) && hasNoPinRole) {
      await member.roles.remove(noPinRole);
      console.log(`[${contextLabel}] Removed ${noPinRole.name} from ${member.displayName || member.user?.username || member.id} (PIN set or role no longer eligible).`);
    }
  } catch (error) {
    console.warn(`[${contextLabel}] No-PIN role sync warning for ${member?.displayName || member?.user?.username || member?.id || 'unknown'}:`, error.message);
  }
}

async function syncAgentRecordFromDiscordMember(member, guild = member?.guild, contextLabel = 'ROLE SYNC', options = {}) {
  try {
    if (!member || !guild) return null;
    const preferredRankRoleId = options?.preferredRankRoleId || null;
    const skipRankExclusivity = options?.skipRankExclusivity === true;
    const rankRoleValueById = {
      [APPLICANT_ROLE_ID]: 'applicant',
      [TRAINEE_ROLE_ID]: 'trainee',
      [AGENT_ROLE_ID]: 'agent',
      [SME_ROLE_ID]: 'sme',
      [TEAM_LEADER_ROLE_ID]: 'team_leader'
    };
    let enforcedRankRoleId = null;
    if (!skipRankExclusivity) {
      enforcedRankRoleId = await enforceExclusiveRankRoles(member, guild, contextLabel, preferredRankRoleId);
    }

    const displayName = member.displayName || member.user?.username || member.user?.tag || 'Unknown';
    const existing = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(member.id);
    let snapshot = getDiscordRoleSyncSnapshot(member);
    const activeSessions = existing
      ? db.prepare(`
        SELECT id, hotel_id, session_kind
        FROM sessions
        WHERE agent_id = ? AND status = 'active'
      `).all(existing.id)
      : [];
    const liveHotelId = resolveLiveHotelIdFromMemberRoles(member, activeSessions);

    const preferredSnapshotRole = rankRoleValueById[preferredRankRoleId] || null;
    if (preferredSnapshotRole && enforcedRankRoleId === preferredRankRoleId && snapshot.role !== preferredSnapshotRole) {
      snapshot = { ...snapshot, role: preferredSnapshotRole };
      console.log(`[${contextLabel}] Preserved preferred rank for ${displayName}: ${getRoleLabel(preferredSnapshotRole)}.`);
    }

    const presentRankRoleCount = EXCLUSIVE_RANK_ROLE_PRIORITY.filter(roleId => member.roles.cache.has(roleId)).length;
    if (skipRankExclusivity && presentRankRoleCount > 1 && existing) {
      const stableDbRole = normalizeAgentRole(existing.role);
      if (stableDbRole && snapshot.role !== stableDbRole) {
        snapshot = { ...snapshot, role: stableDbRole };
        console.log(`[${contextLabel}] Multiple rank roles detected for ${displayName}; keeping DB role ${getRoleLabel(stableDbRole)} until event sync resolves exclusivity.`);
      }
    }

    const hotelCompatibility = getDiscordHotelCompatibilitySnapshot(member);
    const hotelCompatibilityValue = serializeHotelCompatibility(hotelCompatibility);

    if (existing) {
      const updates = [];
      const params = [];

      if (existing.username !== displayName) {
        updates.push('username = ?');
        params.push(displayName);
      }

      const existingRole = normalizeAgentRole(existing.role);
      const snapshotRole = normalizeAgentRole(snapshot.role);
      const allowDiscordRoleSync = !(existingRole === 'operations_manager' && snapshotRole !== 'operations_manager');
      if (snapshotRole && allowDiscordRoleSync && existingRole !== snapshotRole) {
        updates.push('role = ?');
        params.push(snapshotRole);
      } else if (snapshotRole && !allowDiscordRoleSync && existingRole !== snapshotRole) {
        console.log(`[${contextLabel}] Ignored Discord role downgrade for ${displayName}: kept Operations Manager despite snapshot=${snapshotRole}.`);
      }

      if (snapshot.team && existing.team !== snapshot.team) {
        updates.push('team = ?');
        params.push(snapshot.team);
      }

      if ((existing.hotel_compatibility || '[]') !== hotelCompatibilityValue) {
        updates.push('hotel_compatibility = ?');
        params.push(hotelCompatibilityValue);
      }

      if (liveHotelId && normalizeCombinedHotelId(existing.hotel_id) !== liveHotelId) {
        updates.push('hotel_id = ?');
        params.push(liveHotelId);
      }

      if (updates.length > 0) {
        params.push(member.id);
        db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE discord_id = ?`).run(...params);
        const resolvedRole = allowDiscordRoleSync ? (snapshotRole || existingRole) : existingRole;
        const resolvedTeam = snapshot.team || existing.team || 'none';
        console.log(`[${contextLabel}] Updated ${displayName}: role=${resolvedRole} team=${resolvedTeam} hotels=${formatHotelCompatibilityLabel(hotelCompatibility)}`);
      }

      if (liveHotelId) {
        const activeShiftSessions = activeSessions.filter(session => String(session?.session_kind || 'shift').toLowerCase() !== 'training');
        const activeHotelIdsBefore = [...new Set(activeShiftSessions
          .map(session => normalizeCombinedHotelId(session?.hotel_id))
          .filter(Boolean))];

        if (activeShiftSessions.some(session => normalizeCombinedHotelId(session?.hotel_id) !== liveHotelId)) {
          db.prepare(`
            UPDATE sessions
            SET hotel_id = ?
            WHERE agent_id = ?
              AND status = 'active'
              AND COALESCE(session_kind, 'shift') != 'training'
          `).run(liveHotelId, existing.id);

          const impactedHotelIds = [...new Set([...activeHotelIdsBefore, liveHotelId].filter(Boolean))];
          const client = guild?.client || member?.client || null;
          if (client) {
            for (const hotelId of impactedHotelIds) {
              updateHotelStatusEmbed(client, hotelId).catch(error => {
                console.warn(`[${contextLabel}] Failed to refresh hotel ${hotelId}:`, error.message);
              });
            }
          }
          console.log(`[${contextLabel}] Reconciled live hotel for ${displayName}: ${liveHotelId}`);
        }
      }

      const syncedExisting = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(member.id);
      await syncNoPinRoleForMember(member, guild, syncedExisting || existing, contextLabel);
      return { action: 'updated', role: allowDiscordRoleSync ? (snapshotRole || existingRole) : existingRole, team: snapshot.team || existing.team || null };
    }

    if (!snapshot.role) {
      return null;
    }

    const bootstrapRole = snapshot.role || 'trainee';
    const bootstrapStatus = bootstrapRole === 'trainee' ? 'standby' : 'ready';
    const bootstrapPin = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare(
      "INSERT INTO agents (discord_id, username, pin, pin_is_set, role, agent_status, team, hotel_compatibility) VALUES (?, ?, ?, 0, ?, ?, ?, ?)"
    ).run(member.id, displayName, bootstrapPin, bootstrapRole, bootstrapStatus, snapshot.team || null, hotelCompatibilityValue);

    const created = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(member.id);
    await syncNoPinRoleForMember(member, guild, created, contextLabel);

    console.log(`[${contextLabel}] Created ${displayName}: role=${bootstrapRole} team=${snapshot.team || 'none'} hotels=${formatHotelCompatibilityLabel(hotelCompatibility)}`);
    return { action: 'created', role: bootstrapRole, team: snapshot.team || null };
  } catch (error) {
    console.warn(`[${contextLabel}] Role sync failed for ${member?.displayName || member?.user?.username || member?.id || 'unknown'}:`, error.message);
    return null;
  }
}

async function syncGuildAgentRecordsFromRoles(guild, contextLabel = 'ROLE SYNC') {
  try {
    if (!guild) return;
    const members = await guild.members.fetch().catch(() => null);
    if (!members) return;

    for (const member of members.values()) {
      await syncAgentRecordFromDiscordMember(member, guild, contextLabel);
    }
  } catch (error) {
    console.warn(`[${contextLabel}] Failed to backfill Discord roles into DB:`, error.message);
  }
}

function normalizeCombinedHotelId(hotelId) {
  return hotelId === 'SUP8' ? 'RMDA' : hotelId;
}

function getCombinedHotelLabel(hotelId) {
  const normalizedHotelId = normalizeCombinedHotelId(hotelId);
  if (normalizedHotelId === 'RMDA') {
    return 'Ramada / Super 8';
  }
  return HOTEL_NAMES[normalizedHotelId] || normalizedHotelId;
}

function resolveEffectiveTeamForAgent(agent, member) {
  const roleTeam = normalizeTeamInput(resolveTeamFromMemberRoles(member));
  const dbTeam = normalizeTeamInput(agent?.team);
  return roleTeam || dbTeam || null;
}

function getOperationalHotelIdsForTeam(teamName) {
  const normalizedTeam = normalizeTeamInput(teamName);
  if (!normalizedTeam) return [];

  const rows = db.prepare("SELECT id FROM hotels WHERE team = ? AND id != 'TEAM_SHIFT'").all(normalizedTeam);
  const normalizedIds = rows
    .map(row => normalizeCombinedHotelId(row.id))
    .filter(Boolean);
  return [...new Set(normalizedIds)];
}

function getTeamOnShiftCallIds(teamName) {
  const normalizedTeam = normalizeTeamInput(teamName);
  if (!normalizedTeam) return [];
  return [...new Set((ON_SHIFT_CALL_CHANNEL_IDS[normalizedTeam] || []).filter(Boolean))];
}

function getTrainingVoiceChannelIds(guild) {
  const configuredIds = [...new Set(TRAINING_CALL_CHANNEL_IDS.filter(Boolean))];
  if (!guild?.channels?.cache) return configuredIds;
  const detectedIds = [...guild.channels.cache.values()]
    .filter(channel => typeof channel.isVoiceBased === 'function' && channel.isVoiceBased())
    .filter(channel => /\b(training|practice|trainee)\b/i.test(String(channel.name || '')))
    .map(channel => channel.id);
  return [...new Set([...configuredIds, ...detectedIds])];
}

function getAllowedShiftVoiceChannelIds(guild, member, activeSessions = [], agentRecord = null) {
  const allowed = new Set();
  const liveSession = (activeSessions || []).find(session => {
    const hotelId = normalizeCombinedHotelId(session?.hotel_id || session?.hotelId);
    return session?.status !== 'closed' && hotelId && hotelId !== 'TEAM_SHIFT';
  });
  const teamFromHotel = normalizeTeamInput(
    liveSession
      ? db.prepare("SELECT team FROM hotels WHERE id = ?").get(normalizeCombinedHotelId(liveSession.hotel_id))?.team
      : null
  );
  const roleTeam = normalizeTeamInput(resolveTeamFromMemberRoles(member));
  const dbTeam = normalizeTeamInput(agentRecord?.team);
  const effectiveTeam = roleTeam || dbTeam || teamFromHotel || null;

  for (const channelId of getTeamOnShiftCallIds(effectiveTeam)) {
    allowed.add(channelId);
  }
  for (const channelId of CROSS_TEAM_ON_SHIFT_CALL_CHANNEL_IDS) {
    allowed.add(channelId);
  }

  const hasManagementSession = (activeSessions || []).some(session => {
    const hotelId = normalizeCombinedHotelId(session?.hotel_id || session?.hotelId);
    return hotelId === 'TEAM_SHIFT';
  });
  const normalizedRole = normalizeAgentRole(agentRecord?.role);
  if (
    hasManagementSession ||
    normalizedRole === 'sme' ||
    normalizedRole === 'team_leader' ||
    normalizedRole === 'operations_manager'
  ) {
    allowed.add(TL_SME_CALL_CHANNEL_ID);
  }

  // Allow switching to training/practice voice channels while an active session is running.
  for (const trainingChannelId of getTrainingVoiceChannelIds(guild)) {
    allowed.add(trainingChannelId);
  }

  return [...allowed].filter(Boolean);
}

function filterHotelIdsByTeam(hotelIds, teamName) {
  const uniqueHotelIds = [...new Set((hotelIds || [])
    .map(normalizeCombinedHotelId)
    .filter(id => !!id && id !== 'TEAM_SHIFT'))];
  const normalizedTeam = normalizeTeamInput(teamName);
  if (!normalizedTeam) return uniqueHotelIds;

  return uniqueHotelIds.filter(hotelId => {
    const row = db.prepare("SELECT team FROM hotels WHERE id = ?").get(hotelId);
    return normalizeTeamInput(row?.team) === normalizedTeam;
  });
}

function buildHotelSelectionOptions(teamName) {
  const hotels = db.prepare('SELECT * FROM hotels WHERE team = ?').all(teamName);
  const options = [];
  let combinedHotelAdded = false;

  for (const hotel of hotels) {
    const hotelId = normalizeCombinedHotelId(hotel.id);

    if (teamName === 'Team 1' && hotelId === 'RMDA') {
      if (combinedHotelAdded) continue;
      combinedHotelAdded = true;
      options.push({
        id: 'RMDA',
        name: 'Ramada / Super 8',
        emoji: HOTEL_SELECT_EMOJIS.RMDA,
        description: 'Select to permanently link your account to Ramada / Super 8'
      });
      continue;
    }

    if (options.some(option => option.id === hotelId)) continue;

    options.push({
      id: hotelId,
      name: HOTEL_NAMES[hotelId] || hotel.name || hotelId,
      emoji: HOTEL_SELECT_EMOJIS[hotelId] || '🏨',
      description: `Select to permanently link your account to ${HOTEL_NAMES[hotelId] || hotel.name || hotelId}`
    });
  }

  return options;
}

function buildAssignedHotelSelectionOptions(hotelIds) {
  const options = [];
  let combinedHotelAdded = false;

  for (const rawHotelId of hotelIds) {
    const hotelId = normalizeCombinedHotelId(rawHotelId);

    if (hotelId === 'RMDA') {
      if (combinedHotelAdded) continue;
      combinedHotelAdded = true;
      options.push({
        id: 'RMDA',
        label: 'Ramada / Super 8',
        description: 'Start shift on this assigned hotel'
      });
      continue;
    }

    if (options.some(option => option.id === hotelId)) continue;

    options.push({
      id: hotelId,
      label: HOTEL_NAMES[hotelId] || hotelId,
      description: 'Start shift on this assigned hotel'
    });
  }

  return options;
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
    const agent = db.prepare("SELECT pin, phone, pin_is_set FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) {
      return interaction.reply({
        content: '❌ You are not a registered agent. Ask Operations Manager or Developer to run `/add-agent` first.',
        ephemeral: true
      });
    }

    if (hasConfiguredPin(agent)) {
      return interaction.reply({
        content: '✅ Your security PIN is already set. You do not need to open this again.',
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
    const canUpdateSourceMessage = Boolean(interaction.message) && typeof interaction.deferUpdate === 'function';
    if (canUpdateSourceMessage) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ ephemeral: true });
    }

    const pin = interaction.fields.getTextInputValue('security_pin').trim();
    const pinConfirm = interaction.fields.getTextInputValue('security_pin_confirm').trim();
    const phoneInput = interaction.fields.getTextInputValue('security_phone').trim();
    const phone = normalizePhoneForStorage(phoneInput) || phoneInput;

    if (!/^\d{4,6}$/.test(pin)) {
      return interaction.editReply({ content: '❌ PIN must be **4 to 6 digits**.' });
    }
    if (pin !== pinConfirm) {
      return interaction.editReply({ content: '❌ PIN and confirm PIN do not match.' });
    }
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) {
      return interaction.editReply({ content: '❌ You are not a registered agent. Ask Operations Manager or Developer to run `/add-agent` first.' });
    }

        db.prepare("UPDATE agents SET pin = ?, phone = ?, username = ?, pin_is_set = 1 WHERE discord_id = ?")
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

    sendAuditLog(interaction.client, {
      title: '🔐 Security Setup Updated',
      description: `**Agent:** ${interaction.user.username} (<@${interaction.user.id}>)\n**Action:** Updated PIN and phone via security kiosk`,
      color: 0xF1C40F,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    // Replace the setup flow with the next route card instead of adding a separate confirmation message.
    try {
      await handleShiftRolePrompt(interaction);
      return;
    } catch (routeErr) {
      console.warn('[SECURITY] Could not open next route after PIN setup:', routeErr.message);
    }

    await interaction.editReply({ content: '✅ Security profile updated. Your PIN and phone number are now saved.' });
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
        content: '❌ **Invalid registration details.** Please review your inputs and try again.',
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
    db.prepare("INSERT INTO agents (discord_id, username, pin, pin_is_set, role, agent_status, approval_message_id, phone, email) VALUES (?, ?, ?, 0, 'agent', 'ready', ?, ?, ?)").run(userId, member.user.username, pin, interaction.message.id, phone, email);

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
    if (isTraineeMember(interaction) && interaction.customId !== 'tl_start_shift_btn') {
      return await showTrainingHotelSelection(interaction, isEphemeralSourceInteraction(interaction));
    }

    const isTLButton = interaction.customId === 'tl_start_shift_btn';
    const forceSingleHotel =
      interaction.customId === 'start_shift_single_confirm_btn' ||
      interaction.customId === 'tl_start_shift_single_confirm_btn' ||
      interaction.customId === 'start_shift_multi_confirm_btn' ||
      interaction.customId === 'tl_start_shift_multi_confirm_btn';
    const allowMultiHotel = false;
    const discordId = interaction.user.id;
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(discordId);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'SHIFT START FALLBACK');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(discordId);
    }
    if (!agent) {
      return sendPrivateFlowPayload(interaction, {
        content: '❌ **Access Denied.** You must be a registered agent. Please use the **Register** button to apply.',
      });
    }

    // Always refresh DB snapshot from current Discord roles so TL/OM role changes
    // are honored immediately during Initialize Shift.
    await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'SHIFT START SYNC');
    agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(discordId) || agent;

    const role = normalizeAgentRole(agent.role);
    const isTLOrSME = interactionHasRoleAtLeast(interaction, 'sme');

    if (isTLButton && !isTLOrSME) {
      return sendPrivateFlowPayload(interaction, {
        content: `❌ **Access Denied.** This portal is reserved for **Team Leaders** and **Subject Matter Experts**. \n\n*Your current role is:* **${role.charAt(0).toUpperCase() + role.slice(1).replace('_', ' ')}**` ,
      });
    }

    const activeShiftSession = db.prepare(
      "SELECT hotel_id FROM sessions WHERE agent_id = ? AND status = 'active' AND COALESCE(session_kind, 'shift') = 'shift' ORDER BY id DESC LIMIT 1"
    ).get(agent.id);

    // TL/SME manual TL button click (Management Portal)
    if (isTLButton) {
       const assignedTeam =
         normalizeTeamInput(resolveTeamFromMemberRoles(interaction.member)) ||
         normalizeTeamInput(agent.team) ||
         null;
       const managementTarget = assignedTeam
         ? `TEAM_SHIFT_team_${assignedTeam.replace(' ', '_')}`
         : 'TEAM_SHIFT';
       return await showPinModal(interaction, managementTarget, false, allowMultiHotel);
    }

    if (await guardShiftPinFirst(interaction, agent, 'shift')) {
      return;
    }

    // Live hotel shifts now support selecting from every operational hotel
    // without requiring team or permanent hotel assignment.
    const operationalHotelRows = db.prepare("SELECT id FROM hotels WHERE id != 'TEAM_SHIFT'").all();
    const operationalHotelIdsRaw = operationalHotelRows
      .map(row => normalizeCombinedHotelId(row.id))
      .filter(Boolean);
    const operationalHotelSet = new Set(operationalHotelIdsRaw);
    const preferredHotelOrder = [...TEAM_1_HOTELS, ...TEAM_2_HOTELS, ...TEAM_3_HOTELS, ...TEAM_4_HOTELS, ...TEAM_5_HOTELS]
      .map(normalizeCombinedHotelId);
    const orderedOperationalHotelIds = [
      ...preferredHotelOrder.filter((hotelId, index, arr) => (
        hotelId &&
        operationalHotelSet.has(hotelId) &&
        arr.indexOf(hotelId) === index
      )),
      ...operationalHotelIdsRaw.filter((hotelId, index, arr) => (
        hotelId &&
        arr.indexOf(hotelId) === index &&
        !preferredHotelOrder.includes(hotelId)
      ))
    ];
    const effectiveTeam = null;

    if (activeShiftSession && !forceSingleHotel) {
      const activeHotelLabel = getCombinedHotelLabel(normalizeCombinedHotelId(activeShiftSession.hotel_id));
      const singleModeEmbed = new EmbedBuilder()
        .setTitle('🏨 Active Shift Detected')
        .setDescription(
          `You are logged into **${activeHotelLabel}**.\n\n` +
          'Are you sure you want to start another shift?\n' +
          'If yes, we will log out your current shift first.'
        )
        .setColor(0xFEE75C);

      const continueBtn = new ButtonBuilder()
        .setCustomId('start_shift_single_confirm_btn')
        .setLabel('Yes, Continue')
        .setStyle(ButtonStyle.Primary);

      const cancelBtn = new ButtonBuilder()
        .setCustomId('start_shift_multi_cancel_btn')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

      return sendPrivateFlowPayload(interaction, {
        embeds: [singleModeEmbed],
        components: [new ActionRowBuilder().addComponents(continueBtn, cancelBtn)]
      });
    }

    if (activeShiftSession && forceSingleHotel) {
      const closedHotelIds = await closeAllActiveSessionsForAgent(agent.id, interaction.client);
      const member = interaction.member || await interaction.guild?.members?.fetch(interaction.user.id).catch(() => null);
      if (member && closedHotelIds.length > 0) {
        await applyLoggedOutRolesForMember(interaction.guild, member, closedHotelIds);
      }
    }

    if (false && agent.hotel_id) {
       const normalizedHotelId = normalizeCombinedHotelId(agent.hotel_id);
       if (normalizedHotelId !== agent.hotel_id) {
          db.prepare("UPDATE agents SET hotel_id = ? WHERE discord_id = ?").run(normalizedHotelId, interaction.user.id);
          agent.hotel_id = normalizedHotelId;
       }

       const linkedHotelTeam = normalizeTeamInput(
        db.prepare("SELECT team FROM hotels WHERE id = ?").get(agent.hotel_id)?.team
       );
       if (linkedHotelTeam && linkedHotelTeam !== effectiveTeam) {
          db.prepare("UPDATE agents SET hotel_id = NULL WHERE discord_id = ?").run(interaction.user.id);
          agent.hotel_id = null;
       }

       const linkedHotelExists = !!db.prepare("SELECT 1 AS ok FROM hotels WHERE id = ?").get(agent.hotel_id)?.ok;
       if (linkedHotelExists) {
         const hotelSession = db.prepare(
            "SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND COALESCE(session_kind, 'shift') != 'training' AND agent_id != ? ORDER BY id DESC LIMIT 1"
          ).get(agent.hotel_id, agent.id);

          if (hotelSession) {
            const otherAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(hotelSession.agent_id);
            const promptEmbed = new EmbedBuilder()
              .setTitle('âš ï¸ Overlapping Shift Detected')
              .setDescription(`Agent **${otherAgent?.username || 'Unknown Agent'}** is currently logged into **${getCombinedHotelLabel(agent.hotel_id)}**.\n\nAre you sure you want to take over this shift?`)
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
            return sendPrivateFlowPayload(interaction, {
              embeds: [promptEmbed],
              components: [promptRow]
            });
          }

          console.log(`[LOCK-IN] ${interaction.user.username} bypassing selection for linked hotel ${agent.hotel_id}`);
          return sendPrivateFlowPayload(
            interaction,
            buildReadyToStartShiftPayload(agent.hotel_id, false, allowMultiHotel)
          );
       } else {
          db.prepare("UPDATE agents SET hotel_id = NULL WHERE discord_id = ?").run(interaction.user.id);
       }
    }
    
    if (orderedOperationalHotelIds.length === 0) {
      return sendPrivateFlowPayload(interaction, {
        content: '⚠️ No live hotels are configured yet. Please contact a developer.',
        embeds: [],
        components: []
      });
    }

    return await showAssignedHotelShiftPicker(interaction, orderedOperationalHotelIds, false);

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
  const hotelOptions = buildAssignedHotelSelectionOptions(hotelIds);
  const pickMenu = new StringSelectMenuBuilder()
    .setCustomId(allowMultiHotel ? 'shift_hotel_pick_menu_multi' : 'shift_hotel_pick_menu')
    .setPlaceholder('Pick your hotel for this shift')
    .addOptions(
      hotelOptions.map(hotel =>
        new StringSelectMenuOptionBuilder()
          .setLabel(hotel.label)
          .setValue(hotel.id)
          .setDescription(hotel.description)
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
  return sendPrivateFlowPayload(interaction, { embeds: [embed], components: [row] });
}

async function handleShiftHotelPickMenu(interaction) {
  try {
    await safeDeferComponentUpdate(interaction);

    const hotelId = normalizeCombinedHotelId(interaction.values[0]);
    const allowMultiHotel = false;
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return sendComponentReply(interaction, { content: 'You are not registered as an agent.', ephemeral: true });
    }

    const hotelExists = !!db.prepare(
      "SELECT 1 AS ok FROM hotels WHERE id = ? AND id != 'TEAM_SHIFT'"
    ).get(hotelId)?.ok;
    if (!hotelExists) {
      return sendComponentReply(interaction, {
        content: '❌ Selected hotel is no longer available.',
        ephemeral: true
      });
    }

    const effectiveTeam = null;
    if (false && !effectiveTeam) {
      return sendComponentReply(interaction, { content: '⚠️ Team assignment missing. Please contact management.', ephemeral: true });
    }
    const selectedHotelTeam = normalizeTeamInput(
      db.prepare("SELECT team FROM hotels WHERE id = ?").get(hotelId)?.team
    );
    if (false && selectedHotelTeam && selectedHotelTeam !== effectiveTeam) {
      return sendComponentReply(interaction, {
        content: `❌ ${getCombinedHotelLabel(hotelId)} is not in your assigned team (${effectiveTeam}).`,
        ephemeral: true
      });
    }

    const hotelSession = db.prepare(
      "SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND COALESCE(session_kind, 'shift') != 'training' AND agent_id != ? ORDER BY id DESC LIMIT 1"
    ).get(hotelId, agent.id);

    if (hotelSession) {
      const otherAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(hotelSession.agent_id);
      const promptEmbed = buildShiftConflictEmbed(hotelId, otherAgent, hotelSession.login_time);

      const takeoverId = `takeover_btn_${hotelId}`;
      const takeOverBtn = new ButtonBuilder()
        .setCustomId(takeoverId)
        .setLabel('Take Over Shift')
        .setStyle(ButtonStyle.Success);

      const cancelBtn = new ButtonBuilder()
        .setCustomId('cancel_takeover_btn')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

      return sendPrivateFlowPayload(interaction, {
        embeds: [promptEmbed],
        components: [new ActionRowBuilder().addComponents(takeOverBtn, cancelBtn)]
      });
    }

    return sendComponentUpdate(interaction, buildReadyToStartShiftPayload(hotelId, false, allowMultiHotel));

  } catch (error) {
    console.error('Error in handleShiftHotelPickMenu:', error);
    if (error?.code === 10062) {
      console.warn('[SHIFT-PICKER] Interaction expired before response (10062).');
      return;
    }
    await sendComponentReply(interaction, { content: 'Failed to select hotel for shift.', ephemeral: true }).catch(() => {});
  }
}

async function handleShiftCallJoin(interaction) {
  try {
    await safeDeferComponentUpdate(interaction);

    const channelId = String(interaction.customId || '').split(':')[1] || '';
    if (!channelId) {
      return sendComponentReply(interaction, {
        content: '❌ Call channel is missing from this button.',
        ephemeral: true
      });
    }

    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return sendComponentReply(interaction, {
        content: '❌ You are not registered as an agent.',
        ephemeral: true
      });
    }

    const activeSessions = db.prepare(
      "SELECT id, hotel_id, session_kind, status FROM sessions WHERE agent_id = ? AND status = 'active'"
    ).all(agent.id);
    if (activeSessions.length === 0) {
      return sendComponentReply(interaction, {
        content: '⚠️ You are not currently on an active shift.',
        ephemeral: true
      });
    }

    const targetGuild =
      interaction.guild ||
      interaction.client.guilds.cache.get('1482220918355922974') ||
      interaction.client.guilds.cache.first() ||
      null;
    if (!targetGuild) {
      return sendComponentReply(interaction, {
        content: '❌ Could not resolve the server for this call action.',
        ephemeral: true
      });
    }

    const targetMember = interaction.member || await targetGuild.members.fetch(interaction.user.id).catch(() => null);
    if (!targetMember) {
      return sendComponentReply(interaction, {
        content: '❌ Could not resolve your member profile in the server.',
        ephemeral: true
      });
    }

    const channel = await targetGuild.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.isVoiceBased !== 'function' || !channel.isVoiceBased()) {
      return sendComponentReply(interaction, {
        content: '❌ The selected call channel is not available right now.',
        ephemeral: true
      });
    }

    const member = targetMember;
    if (!member.voice) {
      return sendComponentReply(interaction, {
        content: '❌ Could not access your voice state.',
        ephemeral: true
      });
    }

    let moveError = null;
    try {
      await member.voice.setChannel(channel, 'Active shift call join');
    } catch (error) {
      moveError = error;
      try {
        await targetGuild.members.edit(member.id, { channel: channel.id }, { reason: 'Active shift call join' });
        moveError = null;
      } catch (fallbackError) {
        moveError = fallbackError;
      }
    }

    if (moveError) {
      const errorText = String(moveError?.message || '').toLowerCase();
      const jumpLink = `https://discord.com/channels/${targetGuild.id}/${channel.id}`;
      if (errorText.includes('not connected')) {
        return sendComponentReply(interaction, {
          content: `⚠️ Discord only allows bot-move if you are already in voice.\nJoin <#${channel.id}> directly: ${jumpLink}`,
          ephemeral: true
        });
      }
      if (errorText.includes('missing permissions') || errorText.includes('missing access')) {
        return sendComponentReply(interaction, {
          content: `❌ I don't have permission to move members into <#${channel.id}>.`,
          ephemeral: true
        });
      }

      throw moveError;
    }

    return sendComponentReply(interaction, {
      content: `✅ You were moved to **${channel.name}**.`,
      ephemeral: true
    });
  } catch (error) {
    console.error('Error in handleShiftCallJoin:', error);
    return sendComponentReply(interaction, {
      content: '❌ Failed to move you to the selected call.',
      ephemeral: true
    }).catch(() => {});
  }
}

async function handleSameHotelConfirm(interaction) {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return sendPrivateFlowPayload(interaction, {
        content: '❌ You are not registered as an agent.',
        embeds: [],
        components: []
      });
    }

    const assignedHotelIds = getAssignedHotelIdsFromMemberRoles(interaction.member);
    const compatibilityHotelIds = (() => {
      try {
        return JSON.parse(agent.hotel_compatibility || '[]').map(normalizeCombinedHotelId).filter(Boolean);
      } catch {
        return [];
      }
    })();
    const uniqueAssignedHotelIds = [...new Set(assignedHotelIds.length > 0 ? assignedHotelIds : compatibilityHotelIds)];

    if (interaction.customId.startsWith('same_hotel_confirm_no')) {
      if (uniqueAssignedHotelIds.length === 0) {
        return sendPrivateFlowPayload(interaction, {
          content: '❌ No assigned hotels were found for your account.',
          embeds: [],
          components: []
        });
      }

      const hotelOptions = buildAssignedHotelSelectionOptions(uniqueAssignedHotelIds);
      const pickMenu = new StringSelectMenuBuilder()
        .setCustomId('shift_hotel_pick_menu')
        .setPlaceholder('Pick your hotel for this shift')
        .addOptions(
          hotelOptions.map(hotel =>
            new StringSelectMenuOptionBuilder()
              .setLabel(hotel.label)
              .setValue(hotel.id)
              .setDescription(hotel.description)
          )
        );

      const embed = new EmbedBuilder()
        .setTitle('🏨 Select Hotel For This Shift')
        .setDescription(
          'You have multiple assigned hotel roles.\n' +
          'Choose which hotel you are handling right now.'
        )
        .setColor(0xF1C40F);

      return sendPrivateFlowPayload(interaction, {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(pickMenu)]
      });
    }

    const payload = String(interaction.customId || '').replace('same_hotel_confirm_yes:', '');
    const [hotelIdRaw] = payload.split(':');
    const hotelId = normalizeCombinedHotelId(hotelIdRaw);
    const allowMultiHotel = false;

    return interaction.update(buildReadyToStartShiftPayload(hotelId, false, allowMultiHotel));
  } catch (error) {
    console.error('Error in handleSameHotelConfirm:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to continue with this hotel.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to continue with this hotel.', ephemeral: true }).catch(() => {});
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
  const hotels = buildHotelSelectionOptions(teamName);
  const sendPayload = async (payload) => {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else if (isUpdate) {
      await interaction.update(payload);
    } else {
      await interaction.reply(payload);
    }
  };

  if (hotels.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setTitle('🏨 Team Hotels Not Ready')
      .setDescription(
        `### ${teamName} has no mapped hotels yet\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `> We auto-detected your team as **${teamName}**.\n` +
        `> No hotel assignments are currently configured for this team.\n` +
        `> Please contact an Operations Manager or Developer.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      )
      .setColor(0xFEE75C);

    return sendPayload({ content: null, embeds: [emptyEmbed], components: [], ephemeral: true });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('hotel_select_menu')
    .setPlaceholder('🏨 Choose your hotel assignment...')
    .addOptions(
      hotels.map(hotel =>
        new StringSelectMenuOptionBuilder()
          .setLabel(hotel.name)
          .setValue(hotel.id)
          .setDescription(hotel.description)
          .setEmoji(hotel.emoji || '🏨')
      )
    );

  const embed = new EmbedBuilder()
    .setTitle('🏨 Choose Your Hotel Location')
    .setDescription(
      `### 📍 ASSIGNMENT SELECTION\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `> Use the **dropdown** below to select your hotel.\n\n` +
      `> ⚠️ **Permanent choice.** You cannot switch hotels\n` +
      `> without contacting a Developer or Team Leader.\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    )
    .setColor(0x57F287);

  const payload = { content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true };
  await sendPayload(payload);
}

// ─── Hotel Select Buttons (Confirmation Step) ────────
async function handleHotelSelect(interaction) {
  try {
    const hotelId = interaction.customId.replace('hotel_btn_', '');
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: '❌ You are not registered as an agent. Use `/register` to apply.', ephemeral: true });
    }

    const hotelName = getCombinedHotelLabel(hotelId);

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
    .setTitle('🛡️ Aavgo Operations · Training Route')
    .setDescription(
      '### 🟪 PRACTICE MODE READY\n' +
      '────────────────────────\n' +
      '🤖 Board: Choose the hotel you are training for.\n' +
      '🟪 Practice sessions are tracked separately from live shifts.\n' +
      '────────────────────────'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations • Training Routing' })
    .setTimestamp();

  const payload = { content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)] };

  // When we are already in an ephemeral step, keep replacing that same step.
  if (
    isUpdate &&
    !interaction.deferred &&
    !interaction.replied &&
    typeof interaction.update === 'function'
  ) {
    return interaction.update(payload);
  }

  // For public source messages (like /setup-login kiosk), always route private.
  return sendPrivateFlowPayload(interaction, payload);
}

async function handleShiftModePrompt(interaction) {
  try {
    if (isTraineeMember(interaction)) {
      return await showTrainingHotelSelection(interaction);
    }

    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: 'âŒ You are not registered as an agent.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Aavgo Operations · Agent Route')
      .setDescription(
        '### ✅ SESSION TYPE SELECTED\n' +
        '────────────────────────\n' +
        '🤖 Board: Choose how this session should run.\n' +
        '🟦 Live: Hotel Shift for normal operations.\n' +
        '🟪 Practice: Training for trainee sessions.\n' +
        '────────────────────────'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Aavgo Operations • Session Routing' })
      .setTimestamp();

    const hotelBtn = new ButtonBuilder()
      .setCustomId('shift_mode_hotel_btn')
      .setLabel('🟦 Live -> Hotel Shift')
      .setStyle(ButtonStyle.Primary);

    const trainingBtn = new ButtonBuilder()
      .setCustomId('training_start_btn')
      .setLabel('🟪 Practice -> Training')
      .setStyle(ButtonStyle.Secondary);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(hotelBtn, trainingBtn)],
      ephemeral: true
    });
  } catch (error) {
    console.error('Error in handleShiftModePrompt:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'âŒ Failed to open shift mode picker.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'âŒ Failed to open shift mode picker.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleShiftRolePrompt(interaction) {
  try {
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'SHIFT ROUTE PROMPT');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }
    if (!agent) {
      return interaction.reply({ content: 'You are not registered as an agent.', ephemeral: true });
    }

    if (await guardShiftPinFirst(interaction, agent, 'shift')) {
      return;
    }

    const routeKind = resolveShiftRouteKind(interaction, agent);
    if (routeKind === 'training') {
      return await showTrainingHotelSelection(interaction, isEphemeralSourceInteraction(interaction));
    }

    if (routeKind === 'agent') {
      return await handleAgentRoutePick(interaction);
    }

    if (routeKind === 'management') {
      const role = normalizeAgentRole(agent.role);
      const managementLabel = role === 'operations_manager'
        ? 'Operations Manager'
        : role === 'team_leader'
          ? 'Team Leader'
          : 'SME';
      return await handleManagementRoutePick(interaction, managementLabel);
    }

    const fallbackPayload = { ...buildInitializeShiftFallbackPayload(), ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(fallbackPayload);
    } else {
      await interaction.reply(fallbackPayload);
    }
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[SHIFT-ROUTE] Interaction expired before route response (10062).');
      return;
    }
    console.error('Error in handleShiftRolePrompt:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to open shift role picker.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to open shift role picker.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleAgentRoutePick(interaction) {
  try {
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'AGENT ROUTE');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }
    if (!agent) {
      return interaction.reply({ content: 'You are not registered as an agent.', ephemeral: true });
    }

    if (await guardShiftPinFirst(interaction, agent, 'shift')) {
      return;
    }

    if (isTraineeMember(interaction)) {
      return await showTrainingHotelSelection(interaction, isEphemeralSourceInteraction(interaction));
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Aavgo Operations · Agent Route')
      .setDescription(
        '### ✅ SESSION TYPE SELECTED\n' +
        '────────────────────────\n' +
        '🤖 Board: Choose how this session should run.\n' +
        '🟦 Live: Hotel Shift for normal operations.\n' +
        '🟪 Practice: Training for trainee sessions.\n' +
        '────────────────────────'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Aavgo Operations • Session Routing' })
      .setTimestamp();

    const hotelBtn = new ButtonBuilder()
      .setCustomId('shift_mode_hotel_btn')
      .setLabel('🟦 Live -> Hotel Shift')
      .setStyle(ButtonStyle.Primary);

    const trainingBtn = new ButtonBuilder()
      .setCustomId('training_start_btn')
      .setLabel('🟪 Practice -> Training')
      .setStyle(ButtonStyle.Secondary);

    return sendPrivateFlowPayload(interaction, {
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(hotelBtn, trainingBtn)]
    });
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[AGENT-ROUTE] Interaction expired before response (10062).');
      return;
    }
    console.error('Error in handleAgentRoutePick:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to open agent route picker.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to open agent route picker.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleManagementRoutePick(interaction, roleLabel) {
  try {
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'MANAGEMENT ROUTE');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }
    if (!agent) {
      return interaction.reply({ content: 'You are not registered as an agent.', ephemeral: true });
    }
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return sendPrivateFlowPayload(interaction, {
        content: 'Access denied. Team Leader or SME role required.',
        embeds: [],
        components: []
      });
    }

    if (await guardShiftPinFirst(interaction, agent, 'shift')) {
      return;
    }

    const resolvedRoleLabel = String(roleLabel || '').trim() || 'Management';
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Aavgo Operations · Management Route')
      .setDescription(
        '### SESSION TYPE SELECTION\n' +
        '────────────────────────\n' +
        `**Role:** ${resolvedRoleLabel}\n` +
        'Choose how this session should run.\n\n' +
        '• **Live:** Shift coverage and management status.\n' +
        '• **Training:** Monitor trainees/agents in practice.\n' +
        '────────────────────────'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Aavgo Operations • Session Routing' })
      .setTimestamp();

    const liveBtn = new ButtonBuilder()
      .setCustomId('shift_mgmt_mode_live_btn')
      .setLabel('🟦 Live • Shift')
      .setStyle(ButtonStyle.Primary);

    const trainingBtn = new ButtonBuilder()
      .setCustomId('training_start_btn')
      .setLabel('🟪 Training')
      .setStyle(ButtonStyle.Secondary);

    return sendPrivateFlowPayload(interaction, {
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(liveBtn, trainingBtn)]
    });
  } catch (error) {
    console.error('Error in handleManagementRoutePick:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to open management route picker.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to open management route picker.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleManagementLiveStart(interaction) {
  try {
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'MANAGEMENT LIVE START');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }
    if (!agent) {
      return interaction.reply({ content: 'You are not registered as an agent.', ephemeral: true });
    }
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return sendPrivateFlowPayload(interaction, {
        content: 'Access denied. Team Leader or SME role required.',
        embeds: [],
        components: []
      });
    }

    if (await guardShiftPinFirst(interaction, agent, 'shift')) {
      return;
    }

    const assignedTeam =
      normalizeTeamInput(resolveTeamFromMemberRoles(interaction.member)) ||
      normalizeTeamInput(agent.team) ||
      null;
    const managementTarget = assignedTeam
      ? `TEAM_SHIFT_team_${assignedTeam.replace(' ', '_')}`
      : 'TEAM_SHIFT';

    return await showPinModal(
      interaction,
      managementTarget,
      false,
      false,
      'shift'
    );
  } catch (error) {
    console.error('Error in handleManagementLiveStart:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to start management live shift.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to start management live shift.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleManagementTeamStart(interaction, teamName) {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: 'You are not registered as an agent.', ephemeral: true });
    }
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return sendPrivateFlowPayload(interaction, {
        content: 'Access denied. Team Leader or SME role required.',
        embeds: [],
        components: []
      });
    }

    return await showPinModal(
      interaction,
      `TEAM_SHIFT_team_${teamName.replace(' ', '_')}`,
      false,
      false,
      'shift'
    );
  } catch (error) {
    console.error('Error in handleManagementTeamStart:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to start management shift.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to start management shift.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleTrainingStartClick(interaction) {
  try {
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'TRAINING ROUTE');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }
    if (!agent) {
      return interaction.reply({ content: 'You are not registered as an agent.', ephemeral: true });
    }

    if (await guardShiftPinFirst(interaction, agent, 'training')) {
      return;
    }

    return await showTrainingHotelSelection(interaction, isEphemeralSourceInteraction(interaction));
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

async function handleAgentShiftStartConfirm(interaction) {
  try {
    if (interaction.customId === 'agent_shift_confirm_no') {
      return sendPrivateFlowPayload(interaction, {
        content: '✅ No problem. Shift start cancelled.',
        embeds: [],
        components: []
      });
    }

    const payload = String(interaction.customId || '').replace('agent_shift_confirm_yes:', '');
    const [hotelIdRaw, takeoverRaw = '0'] = payload.split(':');
    const hotelId = normalizeCombinedHotelId(hotelIdRaw);
    const isTakeover = takeoverRaw === '1';
    const allowMultiHotel = false;

    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return sendPrivateFlowPayload(interaction, {
        content: '❌ You are not registered as an agent.',
        embeds: [],
        components: []
      });
    }

    // Security hardening: every agent shift start must pass PIN verification,
    // even when PIN is already configured.
    return await showPinModal(interaction, hotelId, isTakeover, allowMultiHotel, 'shift', true);
  } catch (error) {
    console.error('Error in handleAgentShiftStartConfirm:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to start your shift.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to start your shift.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleTrainingHotelSelectMenu(interaction) {
  try {
    const hotelId = normalizeCombinedHotelId(interaction.values[0]);
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

    const hotelName = getCombinedHotelLabel(hotelId);

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

    const hotelId = normalizeCombinedHotelId(interaction.customId.replace('confirm_hotel_', ''));
    const discordId = interaction.user.id;
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(discordId);

    if (!agent) {
      return sendComponentReply(interaction, { content: 'Account error. Please contact a developer.', ephemeral: true });
    }

    const effectiveTeam = resolveEffectiveTeamForAgent(agent, interaction.member);
    if (!effectiveTeam) {
      return sendComponentUpdate(interaction, { content: '⚠️ Team assignment missing. Please contact management.', embeds: [], components: [] });
    }
    const selectedHotelTeam = normalizeTeamInput(
      db.prepare("SELECT team FROM hotels WHERE id = ?").get(hotelId)?.team
    );
    if (selectedHotelTeam && selectedHotelTeam !== effectiveTeam) {
      return sendComponentUpdate(interaction, {
        content: `❌ ${getCombinedHotelLabel(hotelId)} is not in your assigned team (${effectiveTeam}).`,
        embeds: [],
        components: []
      });
    }

    // [Safety] Check if locked during the confirmation delay
    if (agent.hotel_id && agent.hotel_id !== hotelId) {
       return sendComponentUpdate(interaction, { content: 'Access denied. Your account is already linked to another hotel.', embeds: [], components: [] });
    }

    // Check if another agent is already logged into this hotel
    const hotelSession = db.prepare("SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND COALESCE(session_kind, 'shift') != 'training'").get(hotelId);
    if (hotelSession && hotelSession.agent_id !== agent.id) {
       const otherAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(hotelSession.agent_id);
       
       const promptEmbed = new EmbedBuilder()
         .setTitle('⚠️ Overlapping Shift Detected')
         .setDescription(`Agent **${otherAgent.username}** is currently logged into **${getCombinedHotelLabel(hotelId)}**.\n\nAre you sure you want to take over this shift?`)
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
    db.prepare('UPDATE agents SET hotel_id = ?, hotel_compatibility = ? WHERE discord_id = ?')
      .run(hotelId, serializeHotelCompatibility([hotelId]), discordId);
    
    // Sync Grey Role (Ghost role) immediately
    try {
      const greyRoleId = ROLE_NAMES.GREY[hotelId];
      const greyRole = interaction.guild.roles.cache.get(greyRoleId);
      if (greyRole) await interaction.member.roles.add(greyRole);
      console.log(`[ROLES] Permanent Grey role ID (${greyRoleId}) assigned to ${interaction.user.username}`);
    } catch (roleErr) {
       console.warn('[ROLES] Failed to assign initial Grey role:', roleErr.message);
    }

    // Hotel linked confirmation + optional start-now prompt
    const linkedEmbed = new EmbedBuilder()
      .setTitle('Hotel Successfully Linked')
      .setDescription(
        '### ASSIGNMENT COMPLETE\n' +
        '---------------------------\n' +
        `You have been permanently linked to **${getCombinedHotelLabel(hotelId)}**.\n\n` +
        '> Your shift is not live yet.\n' +
        '> Press **Start Shift** below to continue now,\n' +
        '> or choose **Later** and start from your hotel channel.\n' +
        '---------------------------'
      )
      .setColor(0x57F287);

    const startNowBtn = new ButtonBuilder()
      .setCustomId('hotel_link_start_yes_btn')
      .setLabel('Start Shift')
      .setStyle(ButtonStyle.Primary);

    const startLaterBtn = new ButtonBuilder()
      .setCustomId('hotel_link_start_no_btn')
      .setLabel('Later')
      .setStyle(ButtonStyle.Secondary);

    await sendComponentUpdate(interaction, {
      embeds: [linkedEmbed],
      components: [new ActionRowBuilder().addComponents(startNowBtn, startLaterBtn)]
    });

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
         new ButtonBuilder().setCustomId('team_btn_Team 2').setLabel('Team 2').setStyle(ButtonStyle.Primary).setEmoji('👥'),
         new ButtonBuilder().setCustomId('team_btn_Team 3').setLabel('Team 3').setStyle(ButtonStyle.Primary).setEmoji('👥')
       );
       return await interaction.update({ embeds: [embed], components: [row] });
    }

    // Show hotel selection for their team
    await showHotelSelection(interaction, agent.team, true);
  } catch (e) {
    console.error('Error in handleCancelHotelLink:', e);
  }
}

async function handleHotelLinkStartChoice(interaction) {
  try {
    if (interaction.customId === 'hotel_link_start_no_btn') {
      return sendPrivateFlowPayload(interaction, {
        content: '✅ No problem. You can start later from your hotel channel.',
        embeds: [],
        components: []
      });
    }

    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'HOTEL LINK START CHOICE');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }
    if (!agent) {
      return sendPrivateFlowPayload(interaction, {
        content: '❌ You are not registered as an agent.',
        embeds: [],
        components: []
      });
    }

    if (await guardShiftPinFirst(interaction, agent, 'shift')) {
      return;
    }

    if (!agent.team) {
      return sendPrivateFlowPayload(interaction, {
        embeds: [buildAgentTeamRequiredEmbed()],
        components: []
      });
    }

    const linkedHotelId = normalizeCombinedHotelId(agent.hotel_id);
    if (!linkedHotelId || !HOTEL_NAMES[linkedHotelId]) {
      return await handleStartShiftClick(interaction);
    }

    return await showPinModal(interaction, linkedHotelId, false, false, 'shift', true);
  } catch (error) {
    console.error('Error in handleHotelLinkStartChoice:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to open shift start flow.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to open shift start flow.', ephemeral: true }).catch(() => {});
    }
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
    const allowMultiHotel = false;
    const hotelId = payload.endsWith('_multi') ? payload.replace('_multi', '') : payload;

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

function createManualLoginInteractionProxy(interaction, member) {
  return {
    client: interaction.client,
    guild: interaction.guild,
    member,
    user: member.user,
    customId: 'manual_login_cmd',
    commandName: 'login',
    deferred: true,
    replied: false,
    __aavgoEphemeral: true,
    __skipAttendanceReaction: false,
    __logoutTimeIso: null,
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    options: interaction.options,
    reply: payload => interaction.editReply(payload),
    editReply: payload => interaction.editReply(payload),
    followUp: payload => interaction.followUp(payload),
    fetchReply: () => interaction.fetchReply?.(),
    deleteReply: () => interaction.deleteReply?.()
  };
}

async function handleManualLogin(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Management or Developer access required for manual logins.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    interaction.__aavgoEphemeral = true;

    const targetUser = interaction.options.getUser('member') || interaction.user;
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      return interaction.editReply({ content: '❌ Could not find that member in this server.' });
    }

    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(targetUser.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(targetMember, interaction.guild, 'MANUAL LOGIN');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(targetUser.id);
    } else {
      await syncAgentRecordFromDiscordMember(targetMember, interaction.guild, 'MANUAL LOGIN SYNC');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(targetUser.id) || agent;
    }

    if (!agent) {
      return interaction.editReply({ content: '❌ The selected member is not registered as an agent yet.' });
    }

    const mode = normalizeManualLoginMode(interaction.options.getString('mode'));
    const hotelInput = interaction.options.getString('hotel');
    const linkedHotelId = normalizeCombinedHotelId(agent.hotel_id);
    const activeSessionHotelId = db.prepare(
      "SELECT hotel_id FROM sessions WHERE agent_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(agent.id)?.hotel_id || null;
    const hotelId = normalizeCombinedHotelId(hotelInput) || linkedHotelId || normalizeCombinedHotelId(activeSessionHotelId);

    if (!hotelId) {
      return interaction.editReply({ content: '❌ Please choose a hotel for this manual login, or link the agent to a hotel first.' });
    }

    const loginTimeIso = parseManualLoginTimeInput(interaction.options.getString('time'));
    const proxy = createManualLoginInteractionProxy(interaction, targetMember);

    await finalizeShiftLogin(proxy, agent, hotelId, false, false, mode, {
      loginTimeIso,
      skipRecentSubmissionGuard: true
    });

    await sendAuditLog(interaction.client, {
      title: '🛠️ Manual Login Recorded',
      description:
        `**Target:** ${targetMember.user.username} (<@${targetMember.id}>)\n` +
        `**Hotel:** ${getCombinedHotelLabel(hotelId)}\n` +
        `**Mode:** ${mode === 'training' ? 'Training' : 'Live Shift'}\n` +
        `**Time:** <t:${Math.floor(parseSessionTimestamp(loginTimeIso) / 1000)}:F>\n` +
        `**Issued By:** {{AGENT_NAME}}`,
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild,
      forceManagerLog: true
    });

    return true;
  } catch (error) {
    console.error('Error in handleManualLogin:', error);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: '❌ Failed to apply the manual login.' }).catch(() => {});
    }
    return interaction.reply({ content: '❌ Failed to apply the manual login.', ephemeral: true }).catch(() => {});
  }
}

// ─── Legacy /login handler ───────────────────────────
async function handleLogin(interaction) {
  const hasManualInputs =
    Boolean(interaction.options?.getUser('member')) ||
    Boolean(interaction.options?.getString('hotel')) ||
    Boolean(interaction.options?.getString('mode')) ||
    Boolean(interaction.options?.getString('time'));

  if (hasManualInputs) {
    return handleManualLogin(interaction);
  }

  return handleStartShiftClick(interaction);
}

async function handleShiftInitModalSubmit(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    interaction.__aavgoEphemeral = true;

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
      const hotelList = Object.values(HOTEL_NAMES).join(', ');
      return interaction.editReply({ content: `❌ Invalid hotel. Please use one of: **${hotelList}**.` });
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
    interaction.__aavgoEphemeral = true;

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
    const autoStartAfterPin = modalPayload.endsWith('_autostart');
    if (autoStartAfterPin) modalPayload = modalPayload.slice(0, -10);
    let allowMultiHotel = modalPayload.endsWith('_multi');
    if (allowMultiHotel) modalPayload = modalPayload.slice(0, -6);
    const isTakeover = modalPayload.endsWith('_takeover');
    let hotelId = isTakeover ? modalPayload.slice(0, -9) : modalPayload;
    let managementTeamOverride = null;
    if (hotelId.startsWith('TEAM_SHIFT_team_')) {
      const parsedTeam = hotelId.slice('TEAM_SHIFT_team_'.length).replace(/_/g, ' ');
      managementTeamOverride = normalizeTeamInput(parsedTeam);
      hotelId = 'TEAM_SHIFT';
    }
    const pin = interaction.fields.getTextInputValue('pin_input');
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);

    if (!agent && sessionMode === 'training') {
      const username = interaction.member?.displayName || interaction.user.username;
      db.prepare(`
        INSERT INTO agents (discord_id, username, pin, pin_is_set, role, agent_status, team, hotel_id)
        VALUES (?, ?, ?, 1, ?, ?, NULL, NULL)
      `).run(interaction.user.id, username, pin, 'agent', 'standby');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }

    if (!agent || agent.pin !== pin) {
      return interaction.editReply({ content: '❌ **Incorrect PIN.** Access denied.' });
    }

    if (hotelId === 'TEAM_SHIFT' && managementTeamOverride) {
      db.prepare('UPDATE agents SET team = ? WHERE id = ?').run(managementTeamOverride, agent.id);
      agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id);
    }

    const normalizedRole = normalizeAgentRole(agent.role);
    if (normalizedRole === 'agent' && sessionMode === 'shift') {
      allowMultiHotel = false;
    }
    if (sessionMode === 'shift' && hotelId !== 'TEAM_SHIFT' && !autoStartAfterPin) {
      return interaction.editReply(buildReadyToStartShiftPayload(hotelId, isTakeover, allowMultiHotel));
    }

    if (false && sessionMode === 'shift' && hotelId !== 'TEAM_SHIFT' && !autoStartAfterPin) {
      const confirmEmbed = new EmbedBuilder()
        .setTitle('🛡️ Aavgo Operations · Agent Route')
        .setDescription(
          '### ✅ READY TO START SHIFT\n' +
          '────────────────────────\n' +
          `🏨 Hotel: **${getCombinedHotelLabel(hotelId)}**\n` +
          '🤖 Board: Do you want to start your shift?\n' +
          '────────────────────────'
        )
        .setColor(0x57F287)
        .setFooter({ text: 'Aavgo Operations • Shift Confirmation' })
        .setTimestamp();

      const yesButton = new ButtonBuilder()
        .setCustomId(`agent_shift_confirm_yes:${hotelId}:${isTakeover ? '1' : '0'}:${allowMultiHotel ? '1' : '0'}`)
        .setLabel('✅ Yes')
        .setStyle(ButtonStyle.Primary);

      const noButton = new ButtonBuilder()
        .setCustomId('agent_shift_confirm_no')
        .setLabel('❌ No')
        .setStyle(ButtonStyle.Secondary);

      return interaction.editReply({
        embeds: [confirmEmbed],
        components: [new ActionRowBuilder().addComponents(yesButton, noButton)]
      });
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
       const teamHotels = getOperationalHotelIdsForTeam(agent.team);
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
  const hotelName = getCombinedHotelLabel(hotelId);
    await interaction.editReply({ 
        content: `✅ **Success!** You are now logged into **${hotelName}**. ${noteAlert}`,
        embeds: [], 
        components: [] 
    });

    // Handle takeover if applicable
    if (isTakeover && hotelId !== 'TEAM_SHIFT') {
       const priorSession = db.prepare("SELECT * FROM sessions WHERE hotel_id = ? AND status = 'active' AND COALESCE(session_kind, 'shift') != 'training' AND agent_id != ? ORDER BY id DESC LIMIT 1").get(hotelId, agent.id);
       if (priorSession) {
          const priorAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(priorSession.agent_id);
          db.prepare("UPDATE sessions SET logout_time = CURRENT_TIMESTAMP, status = 'closed', overtime_warning_at = NULL, overtime_confirmed = 0, overtime_next_warning_at = NULL WHERE id = ?").run(priorSession.id);
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
       const teamHotels = getOperationalHotelIdsForTeam(agent.team); 
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
    title: sessionMode === 'training' ? '🧭 Training Started' : (hotelId === 'TEAM_SHIFT' ? '🟢 Management Logged In' : '🟢 Agent Logged In'),
    description: sessionMode === 'training'
      ? `**User:** ${nickname} (<@${interaction.user.id}>)\n**Training For:** ${hotelName}\n**Time:** <t:${auditUnix}:F>`
      : `**User:** ${nickname} (<@${interaction.user.id}>)\n**Location:** ${hotelName}\n**Time:** <t:${auditUnix}:F>`,
    color: 0x57F287,
    forceTrainingLog: sessionMode === 'training',
    hotelId: sessionMode === 'training' ? undefined : hotelId,
    userId: interaction.user.id,
    guild: interaction.guild
  });

  await reactToLatestAttendanceMessage(interaction.client, interaction.user.id, ATTENDANCE_CHECK_EMOJI).catch(() => {});

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

    const isChatCommand = typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand();
    const callerDiscordId = interaction.user.id;
    let targetDiscordId = callerDiscordId;
    let forceEndedByManager = false;

    if (isChatCommand && interaction.commandName === 'end-shift') {
      const targetUser = interaction.options?.getUser?.('user') || null;
      if (targetUser && targetUser.id !== callerDiscordId) {
        if (!isDeveloper(interaction)) {
          const denyMessage = '❌ Only Operations Manager or Developer can end another user\'s shift.';
          if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ content: denyMessage });
          }
          return interaction.reply({ content: denyMessage, ephemeral: true });
        }
        targetDiscordId = targetUser.id;
        forceEndedByManager = true;
      }
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
      interaction.__aavgoEphemeral = true;
    }

    const agent = db.prepare('SELECT id, phone FROM agents WHERE discord_id = ?').get(targetDiscordId);
    if (!agent) {
      return interaction.editReply({
        content: forceEndedByManager ? 'That user is not registered.' : 'You are not registered.'
      });
    }

    // Fetch ALL active sessions for this agent
    const activeSessions = db.prepare("SELECT id, hotel_id, login_time, session_kind FROM sessions WHERE agent_id = ? AND status = 'active'").all(agent.id);
    if (activeSessions.length === 0) {
      let recovered = null;
      if (!forceEndedByManager && targetDiscordId === callerDiscordId) {
        recovered = await tryRecoverPhoneLinkedActiveSession(interaction, agent);
      }

      if (recovered?.recovered) {
        await interaction.editReply({
          content: '✅ Recovered your live shift from another account record and ended it. Live Hotel Presence is refreshing now.'
        });
        scheduleExplicitReplyCleanup(interaction, EPHEMERAL_QUICK_TTL_MS);
        return;
      }

      await updateAllHotelStatusEmbed(interaction.client).catch(() => {});
      return interaction.editReply({
        content: forceEndedByManager
          ? 'That user is not currently on any shift. Live Hotel Presence has been refreshed.'
          : 'You are not currently on any shift. Live Hotel Presence has been refreshed.'
      });
    }

    // Save references BEFORE closing
    const primarySession = activeSessions[0];

    const requestedLogoutMs = interaction?.__logoutTimeIso
      ? parseSessionTimestamp(interaction.__logoutTimeIso)
      : Date.now();
    const effectiveLogoutMs = Number.isFinite(requestedLogoutMs) ? requestedLogoutMs : Date.now();
    const effectiveLogoutIso = new Date(effectiveLogoutMs).toISOString();

    // Calculate duration for audit log
    let durationStr = 'Unknown';
    let loginTimeDisplay = 'Unknown';
    if (primarySession.login_time) {
      try {
        const loginTimeStr = primarySession.login_time.includes('T') ? primarySession.login_time : primarySession.login_time.replace(' ', 'T') + 'Z';
        const loginTime = new Date(loginTimeStr).getTime();
        loginTimeDisplay = new Date(loginTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const durationMs = Math.max(0, effectiveLogoutMs - loginTime);

        if (!isNaN(durationMs)) {
          const hours = Math.floor(durationMs / (1000 * 60 * 60));
          const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
          durationStr = `${hours}h ${minutes}m`;
        }
      } catch (timeErr) {
        console.warn('[LOGOUT] Time calculation failed:', timeErr.message);
      }
    }
    const logoutTimeDisplay = new Date(effectiveLogoutMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isOvertime = durationStr.includes('h') && parseInt(durationStr.split('h')[0], 10) >= 8;
    const hasTrainingSession = activeSessions.some(session => session.session_kind === 'training');

    // Fetch activities for the summary before closing sessions
    const activities = db.prepare("SELECT type, guest_name FROM activities WHERE session_id = ?").all(primarySession.id);
    const checkins = activities.filter(a => a.type === 'checkin');
    const checkouts = activities.filter(a => a.type === 'checkout');
    const calls = activities.filter(a => a.type === 'call');

    // Close ALL active sessions using centralized helper
    const closedSessionRefs = await closeAllActiveSessionsForAgent(agent.id, interaction.client, {
      logoutTimeIso: effectiveLogoutIso
    });
    const closedHotelIds = [...new Set(
      (closedSessionRefs || [])
        .map(ref => (typeof ref === 'string' ? ref : (ref?.hotel_id || ref?.hotelId || null)))
        .filter(Boolean)
    )];
    const closedSessionKinds = (closedSessionRefs || [])
      .map(ref => String(
        typeof ref === 'string' ? 'shift' : (ref?.session_kind || ref?.sessionKind || 'shift')
      ).toLowerCase());
    const hasPracticeSession = closedSessionKinds.includes('training');
    const practiceOnlyLogout = closedSessionKinds.length > 0 && closedSessionKinds.every(kind => kind === 'training');

    // Reply early to avoid timeout
    await interaction.editReply({
      content: forceEndedByManager
        ? (hasTrainingSession ? `✅ Training ended for <@${targetDiscordId}>.` : `✅ Shift ended for <@${targetDiscordId}>.`)
        : (hasTrainingSession
          ? '✅ **Training ended.** You have been logged out successfully.'
          : '✅ **Shift ended.** You have been logged out successfully.')
    });
    scheduleExplicitReplyCleanup(interaction, EPHEMERAL_QUICK_TTL_MS);

    const targetMember = (interaction.member && interaction.member.id === targetDiscordId)
      ? interaction.member
      : await interaction.guild?.members?.fetch(targetDiscordId).catch(() => null);

    // Disconnect from VC if present
    try {
      if (targetMember?.voice?.channel) {
        const disconnectReason = forceEndedByManager ? `Shift ended by ${interaction.user.username}` : 'Shift ended';
        await targetMember.voice.disconnect(disconnectReason);
        console.log(`[LOGOUT] Disconnected ${targetDiscordId} from VC.`);
      }
    } catch (vcErr) {
      console.warn('[LOGOUT] Could not disconnect from VC:', vcErr.message);
    }

    // Role management (non-blocking)
    try {
      if (targetMember) {
        await applyLoggedOutRolesForMember(interaction.guild, targetMember, closedSessionRefs);
        console.log(`[ROLES] Shift roles swapped for ${targetDiscordId}: -Green, +Grey`);
      } else {
        console.warn(`[ROLES] Member not found for role cleanup (${targetDiscordId}).`);
      }
    } catch (roleErr) {
      console.warn('[ROLES] Could not revert roles:', roleErr.message);
    }

    // Audit log
    const hotelNames = closedHotelIds.length > 0
      ? closedHotelIds.map(h => HOTEL_NAMES[h] || h).join(', ')
      : 'Unknown';
    const isManagement = closedHotelIds.includes('TEAM_SHIFT');
    const nickname = await getAgentDisplayName(interaction.guild, targetDiscordId);
    const endedByName = forceEndedByManager ? await getAgentDisplayName(interaction.guild, callerDiscordId) : null;

    let summaryDesc = `**Agent:** ${nickname}\n` +
                      `${forceEndedByManager ? `**Ended By:** ${endedByName} (<@${callerDiscordId}>)\n` : ''}` +
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
      userId: targetDiscordId,
      guild: interaction.guild
    });

    if (hasPracticeSession) {
      await sendAuditLog(interaction.client, {
        title: '🧭 Training Ended',
        description: `**Agent:** ${nickname}\n${forceEndedByManager ? `**Ended By:** ${endedByName}\n` : ''}**Practice For:** ${hotelNames}\n**Duration:** ${durationStr}`,
        color: 0xED4245,
        forceTrainingLog: true,
        userId: targetDiscordId,
        guild: interaction.guild
      });
    }

    // Simple Notice (Public Team Log)
    const closedLiveHotelIds = closedHotelIds.filter(hotelId => {
      const hotelTeam = normalizeTeamInput(
        db.prepare("SELECT team FROM hotels WHERE id = ?").get(normalizeCombinedHotelId(hotelId))?.team
      );
      return hotelTeam === 'Team 1' || hotelTeam === 'Team 2' || hotelTeam === 'Team 3' || hotelTeam === 'Team 4' || hotelTeam === 'Team 5';
    });

    if (!practiceOnlyLogout && closedLiveHotelIds.length > 0) {
      await sendAuditLog(interaction.client, {
        title: '🛑 Shift Ended',
        description: `**Agent:** ${nickname}\n${forceEndedByManager ? `**Ended By:** ${endedByName}\n` : ''}**Hotel(s):** ${hotelNames}\n**Duration:** ${durationStr}`,
        color: 0xED4245,
        hotelId: closedLiveHotelIds[0], // Routine routing
        userId: targetDiscordId,
        teamLogRouting: true,
        guild: interaction.guild
      });
    }

    clearAttendanceReactionTimer(targetDiscordId);

    if (!interaction.__skipAttendanceReaction) {
      await reactToLatestAttendanceMessage(interaction.client, targetDiscordId, ATTENDANCE_TADA_EMOJI).catch(() => {});
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

function sanitizeAutomationPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const sanitized = {};
  if (typeof source.content === 'string') sanitized.content = source.content;
  if (Array.isArray(source.embeds)) sanitized.embeds = source.embeds;
  if (Array.isArray(source.components)) sanitized.components = source.components;
  if (Array.isArray(source.files)) sanitized.files = source.files;
  if (source.allowedMentions) sanitized.allowedMentions = source.allowedMentions;
  return sanitized;
}

function createAutomationInteractionProxy({
  client,
  guild,
  member,
  user,
  label = 'AUTO_PROXY',
  logoutTimeIso = null,
  deliverDm = false,
  skipAttendanceReaction = false
}) {
  const proxy = {
    client,
    guild,
    member,
    user,
    customId: `${label.toLowerCase()}_btn`,
    commandName: '',
    deferred: false,
    replied: false,
    __aavgoEphemeral: true,
    __logoutTimeIso: logoutTimeIso || null,
    __skipAttendanceReaction: skipAttendanceReaction === true,
    __lastReplyMessage: null,
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    options: null
  };

  const buildFallbackMessage = () => {
    const fallback = {
      id: `${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      edit: async () => fallback,
      delete: async () => {}
    };
    return fallback;
  };

  const sendProxyMessage = async payload => {
    const safePayload = sanitizeAutomationPayload(payload);
    if (!safePayload.content && !safePayload.embeds && !safePayload.components && !safePayload.files) {
      safePayload.content = 'Action completed.';
    }

    if (!deliverDm) {
      return buildFallbackMessage();
    }

    try {
      const sent = await user.send(safePayload);
      proxy.__lastReplyMessage = sent;
      return sent;
    } catch (_) {
      return buildFallbackMessage();
    }
  };

  proxy.deferReply = async () => {
    proxy.deferred = true;
  };

  proxy.reply = async payload => {
    proxy.replied = true;
    return sendProxyMessage(payload);
  };

  proxy.editReply = async payload => {
    const safePayload = sanitizeAutomationPayload(payload);
    if (proxy.__lastReplyMessage && typeof proxy.__lastReplyMessage.edit === 'function') {
      try {
        const edited = await proxy.__lastReplyMessage.edit(safePayload);
        proxy.__lastReplyMessage = edited;
        return edited;
      } catch (_) {}
    }
    return sendProxyMessage(payload);
  };

  proxy.followUp = async payload => sendProxyMessage(payload);
  proxy.fetchReply = async () => proxy.__lastReplyMessage;
  proxy.deleteReply = async () => {
    if (proxy.__lastReplyMessage && typeof proxy.__lastReplyMessage.delete === 'function') {
      await proxy.__lastReplyMessage.delete().catch(() => {});
    }
  };

  return proxy;
}

async function handleAttendanceTextLogin({
  client,
  guild,
  member,
  hotelId,
  sessionMode = 'shift',
  loginTimeIso,
  previewOnly = false
}) {
  try {
    if (!client || !guild || !member || !hotelId) {
      return { ok: false, reason: 'missing_context' };
    }

    if (previewOnly) {
      return { ok: true, previewOnly: true };
    }

    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(member.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(member, guild, 'ATTENDANCE TEXT LOGIN');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(member.id);
    }
    if (!agent) {
      return { ok: false, reason: 'not_registered' };
    }

    const proxy = createAutomationInteractionProxy({
      client,
      guild,
      member,
      user: member.user,
      label: 'ATTENDANCE_LOGIN',
      deliverDm: false
    });

    await finalizeShiftLogin(proxy, agent, hotelId, false, false, sessionMode, {
      loginTimeIso,
      skipRecentSubmissionGuard: true
    });
    return { ok: true };
  } catch (error) {
    console.error('[ATTENDANCE] Failed to complete text login:', error);
    return { ok: false, reason: 'exception', error: error.message };
  }
}

async function handleAttendanceTextLogout({
  client,
  guild,
  member,
  logoutTimeIso,
  previewOnly = false
}) {
  try {
    if (!client || !guild || !member) {
      return { ok: false, reason: 'missing_context' };
    }

    if (previewOnly) {
      return { ok: true, previewOnly: true };
    }

    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(member.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(member, guild, 'ATTENDANCE TEXT LOGOUT');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(member.id);
    }
    if (!agent) {
      return { ok: false, reason: 'not_registered' };
    }

      const proxy = createAutomationInteractionProxy({
        client,
        guild,
        member,
        user: member.user,
        label: 'ATTENDANCE_LOGOUT',
        logoutTimeIso,
        deliverDm: false,
        skipAttendanceReaction: true
      });

    try {
      await handleLogout(proxy);
    } finally {
      await setAttendanceQueueRole(member, false);
    }
    return { ok: true };
  } catch (error) {
    console.error('[ATTENDANCE] Failed to complete text logout:', error);
    return { ok: false, reason: 'exception', error: error.message };
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

      const hotelName = getCombinedHotelLabel(hotelId);
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

      const hotelName = getCombinedHotelLabel(hotelId);
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

    const hotelName = getCombinedHotelLabel(hotelId);
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
function purgeAgentDataByAgentId(agentId) {
  if (!agentId) return;
  db.transaction(() => {
    db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agentId);
    db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM hour_adjustments WHERE agent_id = ?").run(agentId);
  })();
}

function collectAgentRolesToRemove(guild, teamName) {
  if (!guild) return [];
  const rolesToRemove = [];

  const agentsRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.AGENTS.toLowerCase());
  const loggedOutRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.LOGGED_OUT.toLowerCase());
  const onShiftRole = guild.roles.cache.find(r => r.name.toLowerCase() === ROLE_NAMES.ON_SHIFT.toLowerCase());
  const supportRole = guild.roles.cache.get(SUPPORT_ROLE_ID);
  rolesToRemove.push(agentsRole, loggedOutRole, onShiftRole, supportRole);

  if (teamName) {
    const teamRole = guild.roles.cache.find(r => r.name.toLowerCase() === String(teamName).toLowerCase());
    rolesToRemove.push(teamRole);
  }

  for (const roleId of [...Object.values(ROLE_NAMES.GREEN), ...Object.values(ROLE_NAMES.GREY)]) {
    rolesToRemove.push(guild.roles.cache.get(roleId));
  }

  const deduped = new Map();
  for (const role of rolesToRemove.filter(Boolean)) {
    deduped.set(role.id, role);
  }
  return [...deduped.values()];
}

async function handleRemoveAgent(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.customId.split('_')[2];

    let messageDeleted = false;
    const agent = db.prepare("SELECT id, approval_message_id, team FROM agents WHERE discord_id = ?").get(userId);

    if (agent) {
      purgeAgentDataByAgentId(agent.id);

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
      const rolesToRemove = collectAgentRolesToRemove(guild, agent?.team);
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

    purgeAgentDataByAgentId(agent.id);
    db.prepare("DELETE FROM agents WHERE discord_id = ?").run(targetUser.id);

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
      const rolesToRemove = collectAgentRolesToRemove(interaction.guild, agent?.team);
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

    const totals = calculateAgentHourTotals(db, agent.id);

    const nickname = await getAgentDisplayName(interaction.guild, targetUser.id);
    const embed = new EmbedBuilder()
      .setTitle('⏱️ Agent Hours Tracker')
      .setDescription(
        `**Agent:** ${nickname} (<@${targetUser.id}>)\n\n` +
        `**⏱️ Activity Breakdown:**\n` +
        `> **Live Shift:** Weekly \`${formatHoursClock(totals.shift?.weeklyHours || 0)}\` | Monthly \`${formatHoursClock(totals.shift?.monthlyHours || 0)}\` | All-Time \`${formatHoursClock(totals.shift?.allHours || 0)}\`\n` +
        `> **Training:** Weekly \`${formatHoursClock(totals.training?.weeklyHours || 0)}\` | Monthly \`${formatHoursClock(totals.training?.monthlyHours || 0)}\` | All-Time \`${formatHoursClock(totals.training?.allHours || 0)}\`\n\n` +
        `**Reset Windows:**\n` +
        `> Weekly: Monday 1:00 AM Philippine Time\n` +
        `> Monthly: 1st of each month at 1:00 AM Philippine Time`
      )
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

function normalizeManualShiftDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return getRelativePhilippineIsoDate(0);

  const lowered = raw.toLowerCase();
  if (lowered === 'today') return getRelativePhilippineIsoDate(0);
  if (lowered === 'yesterday') return getRelativePhilippineIsoDate(-1);

  const normalized = raw.replace(/[./:]/g, '-').replace(/\s+/g, '');
  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return buildValidatedManualShiftDate(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10)
    );
  }

  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) {
    return buildValidatedManualShiftDate(
      Number.parseInt(match[3], 10),
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10)
    );
  }

  return null;
}

function normalizeManualShiftClock(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const compact = raw.toLowerCase().replace(/\s+/g, '');
  let match = compact.match(/^(\d{1,2})(?::(\d{1,2}))?(am|pm)$/);
  if (match) {
    let hours = Number.parseInt(match[1], 10);
    const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
      return null;
    }
    if (match[3] === 'pm' && hours !== 12) hours += 12;
    if (match[3] === 'am' && hours === 12) hours = 0;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  match = compact.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function buildValidatedManualShiftDate(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - (8 * 60 * 60 * 1000);
  const check = new Date(utcMs + (8 * 60 * 60 * 1000));
  if (check.getUTCFullYear() !== year || (check.getUTCMonth() + 1) !== month || check.getUTCDate() !== day) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getRelativePhilippineIsoDate(dayOffset = 0, nowInput = new Date()) {
  const baseDate = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput);
  if (!Number.isFinite(baseDate.getTime())) return null;

  const philippineDate = new Date(baseDate.getTime() + (8 * 60 * 60 * 1000));
  philippineDate.setUTCDate(philippineDate.getUTCDate() + dayOffset);
  return buildValidatedManualShiftDate(
    philippineDate.getUTCFullYear(),
    philippineDate.getUTCMonth() + 1,
    philippineDate.getUTCDate()
  );
}

function roundManualHours(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return Math.round(numeric * 100) / 100;
}

function resolveManualCorrectionHotel(agent, explicitHotelInput) {
  const explicitHotelId = normalizeCombinedHotelId(normalizeHotelInput(explicitHotelInput));
  if (explicitHotelId && HOTEL_NAMES[explicitHotelId]) {
    return { hotelId: explicitHotelId, source: 'explicit' };
  }

  const linkedHotelId = normalizeCombinedHotelId(agent?.hotel_id);
  if (linkedHotelId && HOTEL_NAMES[linkedHotelId]) {
    return { hotelId: linkedHotelId, source: 'agent_link' };
  }

  const latestSession = db.prepare(`
    SELECT hotel_id
    FROM sessions
    WHERE agent_id = ?
      AND COALESCE(hotel_id, '') != ''
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, COALESCE(logout_time, login_time) DESC, id DESC
    LIMIT 1
  `).get(agent?.id || 0);

  const lastHotelId = normalizeCombinedHotelId(latestSession?.hotel_id);
  if (lastHotelId && HOTEL_NAMES[lastHotelId]) {
    return { hotelId: lastHotelId, source: 'last_session' };
  }

  return { hotelId: null, source: null };
}

function buildManualShiftTiming(dateValue, loginValue, logoutValue) {
  const shiftDate = normalizeManualShiftDate(dateValue);
  const loginTime = normalizeManualShiftClock(loginValue);
  const logoutTime = normalizeManualShiftClock(logoutValue);
  if (!shiftDate || !loginTime || !logoutTime) return null;

  const [year, month, day] = shiftDate.split('-').map(part => Number.parseInt(part, 10));
  const [loginHour, loginMinute] = loginTime.split(':').map(part => Number.parseInt(part, 10));
  const [logoutHour, logoutMinute] = logoutTime.split(':').map(part => Number.parseInt(part, 10));
  const dayStartMs = Date.UTC(year, month - 1, day, 0, 0, 0) - (8 * 60 * 60 * 1000);
  const loginMs = dayStartMs + (((loginHour * 60) + loginMinute) * 60 * 1000);
  let logoutMs = dayStartMs + (((logoutHour * 60) + logoutMinute) * 60 * 1000);
  if (logoutMs <= loginMs) {
    logoutMs += 24 * 60 * 60 * 1000;
  }

  return {
    shiftDate,
    loginTime,
    logoutTime,
    loginMs,
    logoutMs,
    durationHours: (logoutMs - loginMs) / (60 * 60 * 1000)
  };
}

function normalizeHoursAdjustmentMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'training') return 'training';
  if (normalized === 'live' || normalized === 'shift') return 'shift';
  return null;
}

function getHoursAdjustmentModeLabel(mode) {
  return mode === 'training' ? 'Training' : 'Live Shift';
}

async function handleAddHours(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: 'Developer or Operations Manager access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const rawHotel = interaction.options.getString('hotel');
    const rawDate = interaction.options.getString('date');
    const rawLogin = interaction.options.getString('login');
    const rawLogout = interaction.options.getString('logout');
    const selectedMode = interaction.options.getString('mode') || 'live';
    const providedHours = interaction.options.getNumber('hours');
    const reason = String(interaction.options.getString('reason') || '').trim();
    const adjustmentMode = normalizeHoursAdjustmentMode(selectedMode);

    if (!reason) {
      return interaction.editReply({ content: 'Please provide the reason for this manual hours correction.' });
    }
    if (!adjustmentMode) {
      return interaction.editReply({ content: 'Invalid mode. Please select Live Shift or Training.' });
    }

    const timing = buildManualShiftTiming(rawDate, rawLogin, rawLogout);
    if (!timing) {
      return interaction.editReply({
        content: 'Use `date` like `YYYY-MM-DD`, `YYYY/M/D`, `YYYY:M:D`, `Today`, or `Yesterday`, and `login` / `logout` like `03`, `03:00`, or `3pm`.'
      });
    }

    const hours = Number.isFinite(providedHours) ? providedHours : roundManualHours(timing.durationHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return interaction.editReply({ content: 'Please provide a valid hour amount.' });
    }
    if (hours > timing.durationHours + 0.01) {
      return interaction.editReply({
        content: `Manual hours cannot exceed the login/logout span of **${formatHoursClock(timing.durationHours)}**.`
      });
    }

    const agent = db.prepare('SELECT id, username, hotel_id FROM agents WHERE discord_id = ?').get(targetUser.id);
    if (!agent) {
      return interaction.editReply({ content: `**${targetUser.username}** is not a registered agent.` });
    }

    const modeLabel = getHoursAdjustmentModeLabel(adjustmentMode);
    let resolvedHotel = { hotelId: null, source: null };
    let hotel = null;

    if (adjustmentMode === 'shift') {
      resolvedHotel = resolveManualCorrectionHotel(agent, rawHotel);
      if (!resolvedHotel.hotelId) {
        return interaction.editReply({ content: 'Please choose a hotel, or link the agent to a hotel first so /add-hours can auto-fill it.' });
      }

      hotel = db.prepare('SELECT id, name FROM hotels WHERE id = ?').get(resolvedHotel.hotelId);
      if (!hotel) {
        return interaction.editReply({ content: `Hotel \`${resolvedHotel.hotelId}\` is not configured in the database.` });
      }
    }

    const note = [
      `Manual correction (${modeLabel})`,
      `Hotel: ${hotel ? `${hotel.name} (${hotel.id})` : 'N/A (Training mode)'}`,
      `Date: ${timing.shiftDate}`,
      `Login: ${timing.loginTime}`,
      `Logout: ${timing.logoutTime}`,
      `Hours: ${formatHoursClock(hours)}`,
      `Reason: ${reason}`
    ].join(' | ');

    const effectiveAt = `${timing.shiftDate} 00:00:00`;
    db.prepare(`
      INSERT INTO hour_adjustments (
        agent_id, hotel_id, shift_date, login_time, logout_time, hours, mode, reason, note, effective_at, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      hotel ? hotel.id : null,
      timing.shiftDate,
      timing.loginTime,
      timing.logoutTime,
      hours,
      adjustmentMode,
      reason,
      note,
      effectiveAt,
      interaction.user.id
    );

    const signedHours = hours > 0 ? `+${formatHoursClock(hours)}` : formatHoursClock(hours);
    const autofillNotes = [];
    if (!String(rawDate || '').trim()) {
      autofillNotes.push(`Date defaulted to **${timing.shiftDate}** (Philippine today).`);
    }
    if (!Number.isFinite(providedHours)) {
      autofillNotes.push(`Hours auto-calculated from the login/logout span to **${formatHoursClock(hours)}**.`);
    }
    if (adjustmentMode === 'shift') {
      if (resolvedHotel.source === 'agent_link') {
        autofillNotes.push('Hotel auto-filled from the agent linked hotel.');
      } else if (resolvedHotel.source === 'last_session') {
        autofillNotes.push('Hotel auto-filled from the agent last used hotel.');
      }
    }

    await interaction.editReply({
      content:
        `Manual hours correction saved for **${targetUser.username}**.\n` +
        `Mode: **${modeLabel}**\n` +
        `Hotel: **${hotel ? `${hotel.name} (\`${hotel.id}\`)` : 'N/A (Training mode)'}**\n` +
        `Date: **${timing.shiftDate}**\n` +
        `Login / Logout: **${timing.loginTime} - ${timing.logoutTime}**\n` +
        `Hours: **${signedHours}**\n` +
        `Reason: ${reason}` +
        (autofillNotes.length > 0 ? `\n\nAuto-filled:\n- ${autofillNotes.join('\n- ')}` : '')
    });

    const manualHoursAuditPayload = {
      title: 'Manual Hours Added',
      description:
        `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n` +
        `**Mode:** ${modeLabel}\n` +
        `**Hotel:** ${hotel ? `${hotel.name} (\`${hotel.id}\`)` : 'N/A (Training mode)'}\n` +
        `**Date:** ${timing.shiftDate}\n` +
        `**Login:** ${timing.loginTime}\n` +
        `**Logout:** ${timing.logoutTime}\n` +
        `**Hours:** ${signedHours}\n` +
        `**Reason:** ${reason}\n` +
        '**Added By:** {{AGENT_NAME}}',
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild
    };

    sendAuditLog(interaction.client, manualHoursAuditPayload);
    sendAuditLog(interaction.client, {
      ...manualHoursAuditPayload,
      channelIdOverride: MANUAL_HOURS_LOG_CHANNEL_ID
    });
  } catch (error) {
    console.error('Error in handleAddHours:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong while adding hours.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply({ content: 'Something went wrong while adding hours.' }).catch(() => {});
    }
  }
}

async function handleRemoveHours(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: 'Developer or Operations Manager access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const hours = interaction.options.getNumber('hours');
    const selectedMode = interaction.options.getString('mode');
    const dateInput = interaction.options.getString('date');
    const reason = String(interaction.options.getString('reason') || '').trim();

    if (!Number.isFinite(hours) || hours <= 0) {
      return interaction.editReply({ content: 'Please provide a valid positive hour amount.' });
    }

    const adjustmentMode = normalizeHoursAdjustmentMode(selectedMode);
    if (!adjustmentMode) {
      return interaction.editReply({ content: 'Invalid mode. Please select Live Shift or Training.' });
    }

    const shiftDate = normalizeManualShiftDate(dateInput);
    if (!shiftDate) {
      return interaction.editReply({ content: 'Invalid date. Use YYYY-MM-DD, YYYY/M/D, Today, or Yesterday.' });
    }

    if (!reason) {
      return interaction.editReply({ content: 'Please provide the reason for this removal.' });
    }

    const agent = db.prepare('SELECT id, username FROM agents WHERE discord_id = ?').get(targetUser.id);
    if (!agent) {
      return interaction.editReply({ content: `**${targetUser.username}** is not a registered agent.` });
    }

    const modeLabel = getHoursAdjustmentModeLabel(adjustmentMode);
    const removeValue = -Math.abs(hours);
    const note = [
      `Manual removal (${modeLabel})`,
      `Date: ${shiftDate}`,
      `Hours: -${formatHoursClock(hours)}`,
      `Reason: ${reason}`
    ].join(' | ');

    const effectiveAt = `${shiftDate} 00:00:00`;
    db.prepare(`
      INSERT INTO hour_adjustments (
        agent_id, hotel_id, shift_date, login_time, logout_time, hours, mode, reason, note, effective_at, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      null,
      shiftDate,
      null,
      null,
      removeValue,
      adjustmentMode,
      reason,
      note,
      effectiveAt,
      interaction.user.id
    );

    await interaction.editReply({
      content:
        `Manual hours removal saved for **${targetUser.username}**.\n` +
        `Mode: **${modeLabel}**\n` +
        `Date: **${shiftDate}**\n` +
        `Removed: **${formatHoursClock(hours)}**\n` +
        `Reason: ${reason}`
    });

    const removeAuditPayload = {
      title: 'Manual Hours Removed',
      description:
        `**Agent:** ${targetUser.username} (<@${targetUser.id}>)\n` +
        `**Mode:** ${modeLabel}\n` +
        `**Date:** ${shiftDate}\n` +
        `**Hours:** -${formatHoursClock(hours)}\n` +
        `**Reason:** ${reason}\n` +
        '**Removed By:** {{AGENT_NAME}}',
      color: 0xE67E22,
      userId: interaction.user.id,
      guild: interaction.guild
    };

    sendAuditLog(interaction.client, removeAuditPayload);
    sendAuditLog(interaction.client, {
      ...removeAuditPayload,
      channelIdOverride: MANUAL_HOURS_LOG_CHANNEL_ID
    });
  } catch (error) {
    console.error('Error in handleRemoveHours:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong while removing hours.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply({ content: 'Something went wrong while removing hours.' }).catch(() => {});
    }
  }
}

function escapeCsvValue(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function formatExportClockTime(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '';
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Manila'
  });
}

function buildHoursExportCsvRows(agentRows) {
  const header = [
    'Name',
    'Date',
    'In',
    'Out',
    'Shift Hours',
    'Training Hours',
    'Total Hours'
  ];

  const lines = [header.join(',')];

  for (const row of agentRows) {
    lines.push([
      row.displayName,
      row.date,
      row.inTime,
      row.outTime,
      row.shiftHours,
      row.trainingHours,
      row.totalHours
    ].map(escapeCsvValue).join(','));
  }

  return lines.join('\n');
}

async function handleHoursExport(interaction) {
  try {
    if (!interactionHasRoleAtLeast(interaction, 'team_leader')) {
      return interaction.reply({ content: '❌ Developer or Operations Manager access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const period = interaction.options.getString('period') || 'month';
    const agents = db.prepare(`
      SELECT id, username
      FROM agents
      ORDER BY username COLLATE NOCASE ASC
    `).all();

    const rows = [];
    for (const agent of agents) {
      const history = buildPeriodHourHistory(db, agent.id, period);
      for (const day of history.rows) {
        const totalHours = Number(day.totalHours || 0);
        if (!Number.isFinite(totalHours) || totalHours <= 0) continue;
        rows.push({
          sortDateMs: day.dayStartMs || 0,
          displayName: agent.username || '',
          date: day.dateLabel,
          inTime: formatExportClockTime(day.firstLoginMs),
          outTime: formatExportClockTime(day.lastLogoutMs),
          shiftHours: formatHoursClock(day.shiftHours || 0),
          trainingHours: formatHoursClock(day.trainingHours || 0),
          totalHours: formatHoursClock(totalHours)
        });
      }
    }

    rows.sort((a, b) => {
      if (a.sortDateMs !== b.sortDateMs) return a.sortDateMs - b.sortDateMs;
      return String(a.displayName || '').localeCompare(String(b.displayName || ''));
    });

    const csv = buildHoursExportCsvRows(rows);
    const buffer = Buffer.from(csv, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    await interaction.editReply({
      content: `📊 **Hours timesheet ready.** Open the attached CSV in Excel for a clean horizontal ${period} view.`,
      files: [{ attachment: buffer, name: `aavgo-hours-timesheet-${stamp}.csv` }]
    });
  } catch (error) {
    console.error('Error in handleHoursExport:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Failed to export hours.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply({ content: '❌ Failed to export hours.' }).catch(() => {});
    }
  }
}

async function handleClearHours(interaction) {
  try {
    const targetUser = interaction.options.getUser('user');
    const agent = db.prepare("SELECT id FROM agents WHERE discord_id = ?").get(targetUser.id);

    if (!agent) {
      return interaction.reply({ content: `**${targetUser.username}** is not a registered agent.`, ephemeral: true });
    }

    db.transaction(() => {
      db.prepare("DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = ?)").run(agent.id);
      db.prepare("DELETE FROM hour_adjustments WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM maintenance_logs WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM handover_notes WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM hotel_shift_assignments WHERE agent_id = ?").run(agent.id);
    })();

    await interaction.reply({ content: `✅ Successfully cleared all sessions and hour adjustments for **${targetUser.username}**.`, ephemeral: true });

    sendAuditLog(interaction.client, {
      title: '🗑️ Hours Cleared',
      description: `**Admin:** {{AGENT_NAME}} (<@${interaction.user.id}>)\n**Target:** ${targetUser.username} (<@${targetUser.id}>)\n**Action:** All sessions and manual hour adjustments deleted from database.`,
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
    scheduleExplicitReplyCleanup(interaction, 60 * 1000);
    
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
function isDeveloperId(discordId) {
  if (!discordId) return false;
  if (DEVELOPER_FALLBACK_IDS.includes(discordId)) return true;
  const dev = db.prepare("SELECT discord_id FROM developers WHERE discord_id = ?").get(discordId);
  return !!dev;
}

function isOperationsManagerId(discordId) {
  if (!discordId) return false;
  const opsManager = db.prepare("SELECT discord_id FROM agents WHERE discord_id = ? AND role = 'operations_manager'").get(discordId);
  return !!opsManager;
}

function isDeveloper(interaction) {
  const discordId = interaction.user.id;
  if (isDeveloperId(discordId)) return true;
  // Operations Manager has full developer-equivalent access.
  return isOperationsManagerId(discordId);
}

function interactionHasRoleAtLeast(interaction, minimumRole, { allowDeveloper = true } = {}) {
  if (allowDeveloper && isDeveloper(interaction)) return true;
  return hasAgentRoleAtLeast(getAgentRoleByDiscordId(interaction.user.id), minimumRole);
}

function normalizePromotionTargetRole(roleValue) {
  const normalized = normalizeAgentRole(roleValue);
  if (normalized === 'operations_manager') return 'operations_manager';
  if (normalized === 'developer') return 'developer';
  return null;
}

function getPromotionTargetRoleLabel(targetRole) {
  if (targetRole === 'operations_manager') return 'Operations Manager';
  if (targetRole === 'developer') return 'Developer';
  return 'Unknown Role';
}

function getPromotionRequestKey(targetRole, targetId) {
  return `${PROMOTION_REQUEST_KEY_PREFIX}:${targetRole}:${targetId}`;
}

function hasPromotionRequestMetApprovalRequirement(request) {
  const normalizedRole = normalizePromotionTargetRole(request?.targetRole);
  if (normalizedRole === 'operations_manager') {
    return Boolean(request?.developerApprovedBy || request?.operationsManagerApprovedBy);
  }
  return Boolean(request?.developerApprovedBy && request?.operationsManagerApprovedBy);
}

function getPromotionApprovalRequirementText(targetRole) {
  const normalizedRole = normalizePromotionTargetRole(targetRole);
  if (normalizedRole === 'operations_manager') {
    return '1 approval required: Developer or Operations Manager.';
  }
  return '2 approvals required: 1 Developer and 1 Operations Manager.';
}

function parsePromotionRequestFromRow(row) {
  if (!row?.target_id || !String(row.target_id).startsWith(`${PROMOTION_REQUEST_KEY_PREFIX}:`)) return null;
  const [, targetRole, targetId] = String(row.target_id).split(':');
  if (!targetRole || !targetId) return null;

  let payload = {};
  try {
    payload = JSON.parse(row.approvals || '{}');
  } catch {
    payload = {};
  }

  return {
    requestKey: row.target_id,
    targetRole,
    targetId,
    status: payload.status || 'pending',
    requestedBy: payload.requestedBy || row.proposed_by || null,
    source: payload.source || 'manual',
    developerApprovedBy: payload.developerApprovedBy || null,
    operationsManagerApprovedBy: payload.operationsManagerApprovedBy || null,
    deniedBy: payload.deniedBy || null,
    messageId: payload.messageId || null,
    channelId: payload.channelId || null,
    createdAt: payload.createdAt || row.requested_at || new Date().toISOString(),
    updatedAt: payload.updatedAt || new Date().toISOString()
  };
}

function serializePromotionRequest(request) {
  return JSON.stringify({
    kind: 'promotion_request',
    status: request.status || 'pending',
    targetRole: request.targetRole,
    targetId: request.targetId,
    requestedBy: request.requestedBy || null,
    source: request.source || 'manual',
    developerApprovedBy: request.developerApprovedBy || null,
    operationsManagerApprovedBy: request.operationsManagerApprovedBy || null,
    deniedBy: request.deniedBy || null,
    messageId: request.messageId || null,
    channelId: request.channelId || PROMOTION_REVIEW_CHANNEL_ID,
    createdAt: request.createdAt || new Date().toISOString(),
    updatedAt: request.updatedAt || new Date().toISOString()
  });
}

function upsertPromotionRequestRow(request) {
  db.prepare(
    "INSERT OR REPLACE INTO dev_approvals (target_id, proposed_by, approvals) VALUES (?, ?, ?)"
  ).run(request.requestKey, request.requestedBy || 'SYSTEM', serializePromotionRequest(request));
}

async function fetchPromotionReviewChannel(client, guild = null) {
  let channel =
    client?.channels?.cache?.get(PROMOTION_REVIEW_CHANNEL_ID) ||
    guild?.channels?.cache?.get(PROMOTION_REVIEW_CHANNEL_ID) ||
    null;
  if (!channel && client?.channels?.fetch) {
    channel = await client.channels.fetch(PROMOTION_REVIEW_CHANNEL_ID).catch(() => null);
  }
  if (!channel || !channel.isTextBased?.()) return null;
  return channel;
}

function buildPromotionRequestButtons(requestKey, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`promote_req_approve:${requestKey}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`promote_req_deny:${requestKey}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    )
  ];
}

function buildPromotionRequestEmbed(request, { requesterName = null } = {}) {
  const requestedByLabel = request.requestedBy ? `<@${request.requestedBy}>` : (requesterName || 'System');
  const devApproval = request.developerApprovedBy ? `<@${request.developerApprovedBy}>` : 'Pending';
  const omApproval = request.operationsManagerApprovedBy ? `<@${request.operationsManagerApprovedBy}>` : 'Pending';
  const requirementText = getPromotionApprovalRequirementText(request.targetRole);
  const statusLabel = request.status === 'approved'
    ? 'Approved'
    : (request.status === 'denied' ? 'Denied' : 'Pending');
  const denialLine = request.deniedBy ? `\n**Denied By:** <@${request.deniedBy}>` : '';

  return new EmbedBuilder()
    .setTitle(`🧭 Promotion Request - ${getPromotionTargetRoleLabel(request.targetRole)}`)
    .setDescription(
      `**Candidate:** <@${request.targetId}>\n` +
      `**Requested By:** ${requestedByLabel}\n` +
      `**Source:** ${request.source}\n` +
      `**Status:** ${statusLabel}${denialLine}\n\n` +
      `**Developer Approval:** ${devApproval}\n` +
      `**Operations Manager Approval:** ${omApproval}\n\n` +
      `${requirementText}`
    )
    .setColor(request.status === 'approved' ? 0x57F287 : (request.status === 'denied' ? 0xED4245 : 0xF1C40F))
    .setFooter({ text: 'Aavgo Promotion Control' })
    .setTimestamp();
}

async function publishPromotionRequestMessage(client, guild, request) {
  const channel = await fetchPromotionReviewChannel(client, guild);
  if (!channel) {
    return { ok: false, error: `Promotion review channel not found: ${PROMOTION_REVIEW_CHANNEL_ID}` };
  }

  const embed = buildPromotionRequestEmbed(request);
  const components = request.status === 'pending' ? buildPromotionRequestButtons(request.requestKey) : [];
  let message = null;

  if (request.messageId) {
    message = await channel.messages.fetch(request.messageId).catch(() => null);
    if (message) {
      await message.edit({ embeds: [embed], components });
    }
  }

  if (!message) {
    message = await channel.send({ embeds: [embed], components });
    request.messageId = message.id;
    request.channelId = channel.id;
    request.updatedAt = new Date().toISOString();
    upsertPromotionRequestRow(request);
  }

  return { ok: true, message, channel };
}

async function createPromotionRequest({
  client,
  guild,
  targetUser,
  targetRole,
  requestedBy = null,
  source = 'manual request'
}) {
  const normalizedRole = normalizePromotionTargetRole(targetRole);
  if (!normalizedRole) {
    return { ok: false, error: 'Unsupported promotion target role.' };
  }

  const targetId = targetUser?.id || null;
  if (!targetId) {
    return { ok: false, error: 'Invalid promotion target user.' };
  }

  const requestKey = getPromotionRequestKey(normalizedRole, targetId);
  const existingRow = db.prepare("SELECT * FROM dev_approvals WHERE target_id = ?").get(requestKey);
  const existing = parsePromotionRequestFromRow(existingRow);
  const request = existing && existing.status === 'pending'
    ? existing
    : {
      requestKey,
      targetRole: normalizedRole,
      targetId,
      status: 'pending',
      requestedBy,
      source,
      developerApprovedBy: null,
      operationsManagerApprovedBy: null,
      deniedBy: null,
      messageId: null,
      channelId: PROMOTION_REVIEW_CHANNEL_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

  request.targetRole = normalizedRole;
  request.targetId = targetId;
  request.requestedBy = requestedBy || request.requestedBy || null;
  request.source = source;
  request.status = 'pending';
  request.updatedAt = new Date().toISOString();

  upsertPromotionRequestRow(request);
  const publishResult = await publishPromotionRequestMessage(client, guild, request);
  if (!publishResult.ok) {
    return publishResult;
  }
  return { ok: true, request, message: publishResult.message, channel: publishResult.channel };
}

async function applyApprovedPromotion(guild, targetId, targetRole, approvedById = null) {
  const member = guild ? await guild.members.fetch(targetId).catch(() => null) : null;
  const username = member?.user?.username || member?.displayName || `User-${targetId}`;

  if (targetRole === 'developer') {
    db.prepare("INSERT OR REPLACE INTO developers (discord_id, username) VALUES (?, ?)").run(targetId, username);

    if (member && guild) {
      const developerRole =
        guild.roles.cache.get(DEVELOPER_DISCORD_ROLE_ID) ||
        guild.roles.cache.find(role => {
          const normalized = normalizeDiscordRoleName(role?.name);
          return normalized === 'developer' || normalized === 'developers';
        });
      if (developerRole && !member.roles.cache.has(developerRole.id)) {
        await member.roles.add(developerRole).catch(() => {});
      }
    }

    sendAuditLog(guild?.client || null, {
      title: '🛡️ Developer Promotion Approved',
      description: `**Candidate:** ${username} (<@${targetId}>)\n**New Role:** Developer\n**Approved By:** ${approvedById ? `<@${approvedById}>` : 'System'}`,
      color: 0x57F287,
      userId: approvedById || targetId,
      guild
    });
    return { ok: true, label: 'Developer' };
  }

  if (targetRole === 'operations_manager') {
    const existingAgent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetId);
    if (!existingAgent) {
      const generatedPin = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare(
        "INSERT INTO agents (discord_id, username, pin, pin_is_set, role, agent_status) VALUES (?, ?, ?, 0, 'operations_manager', 'ready')"
      ).run(targetId, username, generatedPin);
    } else {
      db.prepare("UPDATE agents SET role = 'operations_manager', username = ? WHERE discord_id = ?").run(username, targetId);
    }

    if (member && guild) {
      const operationsManagerRole =
        guild.roles.cache.get(OPERATIONS_MANAGER_DISCORD_ROLE_ID) ||
        guild.roles.cache.find(role => normalizeDiscordRoleName(role?.name) === 'operations manager');
      const agentsRole =
        guild.roles.cache.get(AGENT_ROLE_ID) ||
        guild.roles.cache.find(role => normalizeDiscordRoleName(role?.name) === normalizeDiscordRoleName(ROLE_NAMES.AGENTS));
      const loggedOutRole = guild.roles.cache.find(role => normalizeDiscordRoleName(role?.name) === normalizeDiscordRoleName(ROLE_NAMES.LOGGED_OUT));
      const rankRolesToRemove = [APPLICANT_ROLE_ID, TRAINEE_ROLE_ID, AGENT_ROLE_ID, SME_ROLE_ID, TEAM_LEADER_ROLE_ID]
        .map(roleId => guild.roles.cache.get(roleId))
        .filter(role => role && member.roles.cache.has(role.id));

      if (rankRolesToRemove.length > 0) {
        await member.roles.remove(rankRolesToRemove).catch(() => {});
      }

      const rolesToAdd = [operationsManagerRole, agentsRole, loggedOutRole].filter(Boolean);
      if (rolesToAdd.length > 0) {
        await member.roles.add(rolesToAdd).catch(() => {});
      }
    }

    sendAuditLog(guild?.client || null, {
      title: '🛡️ Operations Manager Promotion Approved',
      description: `**Candidate:** ${username} (<@${targetId}>)\n**New Role:** Operations Manager\n**Approved By:** ${approvedById ? `<@${approvedById}>` : 'System'}`,
      color: 0xF1C40F,
      userId: approvedById || targetId,
      guild
    });
    return { ok: true, label: 'Operations Manager' };
  }

  return { ok: false, error: 'Unsupported promotion target role.' };
}

async function handlePromote(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Developer or Operations Manager access required.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const targetRole = normalizePromotionTargetRole(interaction.options.getString('role'));
    if (!targetRole) {
      return interaction.reply({ content: '❌ Invalid target role. Choose Developer or Operations Manager.', ephemeral: true });
    }

    if (targetRole === 'developer' && isDeveloperId(targetUser.id)) {
      return interaction.reply({ content: `⚠️ <@${targetUser.id}> is already in Developer authority scope.`, ephemeral: true });
    }
    if (targetRole === 'operations_manager') {
      const existingAgent = db.prepare("SELECT role FROM agents WHERE discord_id = ?").get(targetUser.id);
      if (normalizeAgentRole(existingAgent?.role) === 'operations_manager') {
        return interaction.reply({ content: `⚠️ <@${targetUser.id}> is already an Operations Manager in DB.`, ephemeral: true });
      }
    }

    await interaction.deferReply({ ephemeral: true });
    const result = await createPromotionRequest({
      client: interaction.client,
      guild: interaction.guild,
      targetUser,
      targetRole,
      requestedBy: interaction.user.id,
      source: '/promote command'
    });

    if (!result.ok) {
      return interaction.editReply({ content: `❌ Failed to create promotion request: ${result.error}` });
    }

    const roleLabel = getPromotionTargetRoleLabel(targetRole);
    const requirementLine = targetRole === 'operations_manager'
      ? 'Required: **1 approval (Developer or Operations Manager)**.'
      : 'Required: **1 Developer approval + 1 Operations Manager approval**.';
    await interaction.editReply({
      content:
        `✅ Promotion request created for <@${targetUser.id}> -> **${roleLabel}**.\n` +
        `Review channel: <#${PROMOTION_REVIEW_CHANNEL_ID}>.\n` +
        requirementLine
    });
  } catch (error) {
    console.error('Error in handlePromote:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to create promotion request.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to create promotion request.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handlePromotionRequestApprove(interaction) {
  try {
    await safeDeferComponentUpdate(interaction);

    const requestKey = String(interaction.customId || '').replace('promote_req_approve:', '');
    const row = db.prepare("SELECT * FROM dev_approvals WHERE target_id = ?").get(requestKey);
    const request = parsePromotionRequestFromRow(row);
    if (!request) {
      return sendComponentReply(interaction, { content: 'Promotion request not found.', ephemeral: true });
    }
    if (request.status !== 'pending') {
      return sendComponentReply(interaction, { content: 'This promotion request is no longer pending.', ephemeral: true });
    }

    const approverId = interaction.user.id;
    const canApproveAsDeveloper = isDeveloperId(approverId);
    const canApproveAsOperationsManager = isOperationsManagerId(approverId);
    if (!canApproveAsDeveloper && !canApproveAsOperationsManager) {
      return sendComponentReply(interaction, { content: 'Only Developer or Operations Manager can approve this request.', ephemeral: true });
    }

    if (hasPromotionRequestMetApprovalRequirement(request)) {
      const approvedById = request.developerApprovedBy || request.operationsManagerApprovedBy || approverId;
      const applyResult = await applyApprovedPromotion(interaction.guild, request.targetId, request.targetRole, approvedById);
      if (!applyResult.ok) {
        return sendComponentReply(interaction, { content: `Could not apply promotion: ${applyResult.error}`, ephemeral: true });
      }
      request.status = 'approved';
      request.updatedAt = new Date().toISOString();
      upsertPromotionRequestRow(request);
      await sendComponentUpdate(interaction, {
        embeds: [buildPromotionRequestEmbed(request)],
        components: []
      });
      return sendComponentReply(interaction, {
        content: 'Required approval was already present. Promotion has now been finalized.',
        ephemeral: true
      });
    }

    if (request.developerApprovedBy === approverId || request.operationsManagerApprovedBy === approverId) {
      return sendComponentReply(interaction, { content: 'You have already approved this request.', ephemeral: true });
    }

    let approvalType = null;
    if (canApproveAsDeveloper && !request.developerApprovedBy) {
      request.developerApprovedBy = approverId;
      approvalType = 'Developer';
    } else if (canApproveAsOperationsManager && !request.operationsManagerApprovedBy) {
      request.operationsManagerApprovedBy = approverId;
      approvalType = 'Operations Manager';
    } else if (!hasPromotionRequestMetApprovalRequirement(request)) {
      return sendComponentReply(interaction, { content: 'Your role is already filled for this request. A different approver role is still required.', ephemeral: true });
    }

    request.updatedAt = new Date().toISOString();
    const isFullyApproved = hasPromotionRequestMetApprovalRequirement(request);
    if (isFullyApproved) {
      const approvedById = approvalType
        ? approverId
        : (request.developerApprovedBy || request.operationsManagerApprovedBy || approverId);
      const applyResult = await applyApprovedPromotion(interaction.guild, request.targetId, request.targetRole, approvedById);
      if (!applyResult.ok) {
        return sendComponentReply(interaction, { content: `Could not apply promotion: ${applyResult.error}`, ephemeral: true });
      }
      request.status = 'approved';
    }

    upsertPromotionRequestRow(request);
    const embed = buildPromotionRequestEmbed(request);
    await sendComponentUpdate(interaction, {
      embeds: [embed],
      components: request.status === 'pending' ? buildPromotionRequestButtons(request.requestKey) : []
    });

    if (request.status === 'pending') {
      const pendingApprovalMessage = request.targetRole === 'operations_manager'
        ? `${approvalType || 'Eligible'} approval captured. Waiting for one eligible approval.`
        : `${approvalType} approval captured. Waiting for the second required approval.`;
      await sendComponentReply(interaction, {
        content: pendingApprovalMessage,
        ephemeral: true
      }).catch(() => {});
    }
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[PROMOTION] Approve interaction expired before response (10062).');
      return;
    }
    console.error('Error in handlePromotionRequestApprove:', error);
    await sendComponentReply(interaction, { content: 'Failed to process approval.', ephemeral: true }).catch(() => {});
  }
}

async function handlePromotionRequestDeny(interaction) {
  try {
    await safeDeferComponentUpdate(interaction);

    const approverId = interaction.user.id;
    if (!isDeveloperId(approverId) && !isOperationsManagerId(approverId)) {
      return sendComponentReply(interaction, { content: 'Only Developer or Operations Manager can deny this request.', ephemeral: true });
    }

    const requestKey = String(interaction.customId || '').replace('promote_req_deny:', '');
    const row = db.prepare("SELECT * FROM dev_approvals WHERE target_id = ?").get(requestKey);
    const request = parsePromotionRequestFromRow(row);
    if (!request) {
      return sendComponentReply(interaction, { content: 'Promotion request not found.', ephemeral: true });
    }

    request.status = 'denied';
    request.deniedBy = approverId;
    request.updatedAt = new Date().toISOString();
    upsertPromotionRequestRow(request);

    await sendComponentUpdate(interaction, {
      embeds: [buildPromotionRequestEmbed(request)],
      components: []
    });
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[PROMOTION] Deny interaction expired before response (10062).');
      return;
    }
    console.error('Error in handlePromotionRequestDeny:', error);
    await sendComponentReply(interaction, { content: 'Failed to deny promotion request.', ephemeral: true }).catch(() => {});
  }
}
async function handleSensitivePromotionRoleAddAttempt(oldMember, newMember) {
  try {
    if (!oldMember || !newMember?.guild || !newMember?.client) return;
    const sensitiveRoles = [
      { roleId: OPERATIONS_MANAGER_DISCORD_ROLE_ID, targetRole: 'operations_manager' },
      { roleId: DEVELOPER_DISCORD_ROLE_ID, targetRole: 'developer' }
    ];

    for (const entry of sensitiveRoles) {
      const gainedRole = !oldMember.roles.cache.has(entry.roleId) && newMember.roles.cache.has(entry.roleId);
      if (!gainedRole) continue;

      const isAuthorized = entry.targetRole === 'operations_manager'
        ? normalizeAgentRole(db.prepare("SELECT role FROM agents WHERE discord_id = ?").get(newMember.id)?.role) === 'operations_manager'
        : isDeveloperId(newMember.id);
      if (isAuthorized) continue;

      const sensitiveRole = newMember.guild.roles.cache.get(entry.roleId);
      if (sensitiveRole && sensitiveRole.editable && newMember.roles.cache.has(sensitiveRole.id)) {
        await newMember.roles.remove(sensitiveRole).catch(() => {});
      }

      await createPromotionRequest({
        client: newMember.client,
        guild: newMember.guild,
        targetUser: newMember.user,
        targetRole: entry.targetRole,
        requestedBy: null,
        source: 'Discord role-add attempt detected'
      });
    }
  } catch (error) {
    console.warn('[ROLE GUARD] Sensitive promotion role detection warning:', error.message);
  }
}

async function handleDbAddDeveloper(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: 'Access denied: Developer or Operations Manager required.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    if (isDeveloperId(targetUser.id)) {
      return interaction.reply({ content: `Target <@${targetUser.id}> is already in Developer authority scope.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const result = await createPromotionRequest({
      client: interaction.client,
      guild: interaction.guild,
      targetUser,
      targetRole: 'developer',
      requestedBy: interaction.user.id,
      source: '/db-add-developer legacy alias'
    });
    if (!result.ok) {
      return interaction.editReply({ content: `Failed to create promotion request: ${result.error}` });
    }

    await interaction.editReply({
      content:
        `Developer promotion request created for <@${targetUser.id}>.\n` +
        `Use /promote going forward.\n` +
        `Review channel: <#${PROMOTION_REVIEW_CHANNEL_ID}> (requires 1 Developer + 1 Operations Manager approval).`
    });
  } catch (e) {
    console.error('Error in handleDbAddDeveloper:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to create promotion request.' }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to create promotion request.', ephemeral: true }).catch(() => {});
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
      const smeRole = interaction.guild.roles.cache.get('1482382342621233153') ||
        interaction.guild.roles.cache.find(r => {
          const name = r.name.toLowerCase();
          return name === 'subject matter expert' || name === 'sme';
        });
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
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: 'Access denied: Developer or Operations Manager required.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const existingAgent = db.prepare("SELECT role FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (normalizeAgentRole(existingAgent?.role) === 'operations_manager') {
      return interaction.reply({ content: `Target <@${targetUser.id}> is already an Operations Manager in DB.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const result = await createPromotionRequest({
      client: interaction.client,
      guild: interaction.guild,
      targetUser,
      targetRole: 'operations_manager',
      requestedBy: interaction.user.id,
      source: '/db-set-operation-manager legacy alias'
    });
    if (!result.ok) {
      return interaction.editReply({ content: `Failed to create promotion request: ${result.error}` });
    }

    await interaction.editReply({
      content:
        `Operations Manager promotion request created for <@${targetUser.id}>.\n` +
        `Use /promote going forward.\n` +
        `Review channel: <#${PROMOTION_REVIEW_CHANNEL_ID}> (requires 1 approval from Developer or Operations Manager).`
    });
  } catch (e) {
    console.error('Error in handleSetOperationManager:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to create promotion request.' }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to create promotion request.', ephemeral: true }).catch(() => {});
    }
  }
}
async function handleDemote(interaction) {
  if (!isDeveloper(interaction)) return interaction.reply({ content: '❌ Access Denied: Developer Only.', ephemeral: true });
  try {
    const targetUser = interaction.options.getUser('user');
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
    if (!agent) return interaction.reply({ content: `❌ **${targetUser.username}** is not a registered agent.`, ephemeral: true });

    const currentRole = normalizeAgentRole(agent.role);
    const nextRole = getNextDemotedRole(currentRole);
    if (!nextRole) {
      return interaction.reply({ content: `⚠️ **${targetUser.username}** is already at the lowest rank (**Applicant**).`, ephemeral: true });
    }

    db.prepare("UPDATE agents SET role = ? WHERE discord_id = ?").run(nextRole, targetUser.id);

    // Role sync
    try {
      const member = await interaction.guild.members.fetch(targetUser.id);
      const targetRoleIdByRank = {
        applicant: APPLICANT_ROLE_ID,
        trainee: TRAINEE_ROLE_ID,
        agent: AGENT_ROLE_ID,
        sme: SME_ROLE_ID,
        team_leader: TEAM_LEADER_ROLE_ID
      };
      const targetRoleId = targetRoleIdByRank[nextRole] || null;
      const rankRoleIds = [APPLICANT_ROLE_ID, TRAINEE_ROLE_ID, AGENT_ROLE_ID, SME_ROLE_ID, TEAM_LEADER_ROLE_ID];

      const rolesToRemove = rankRoleIds
        .filter(roleId => roleId !== targetRoleId)
        .map(roleId => interaction.guild.roles.cache.get(roleId))
        .filter(role => role && member.roles.cache.has(role.id));
      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove);
      }

      const operationsManagerRole =
        interaction.guild.roles.cache.get(OPERATIONS_MANAGER_DISCORD_ROLE_ID) ||
        interaction.guild.roles.cache.find(role => normalizeDiscordRoleName(role?.name) === 'operations manager');
      if (operationsManagerRole && member.roles.cache.has(operationsManagerRole.id)) {
        await member.roles.remove(operationsManagerRole).catch(() => {});
      }

      if (targetRoleId) {
        const targetRole = interaction.guild.roles.cache.get(targetRoleId);
        if (targetRole && !member.roles.cache.has(targetRole.id)) {
          await member.roles.add(targetRole);
        }
      }

      const updatedAgent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetUser.id);
      await syncNoPinRoleForMember(member, interaction.guild, updatedAgent, 'DEMOTE');
    } catch (e) { console.warn('[DEMOTE] Role cleanup failed:', e.message); }

    await interaction.reply({
      content: `📉 **${targetUser.username}** demoted: **${getRoleLabel(currentRole)} → ${getRoleLabel(nextRole)}**.`,
      ephemeral: true
    });

    sendAuditLog(interaction.client, {
      title: '📉 Management Demotion',
      description: `**User:** ${targetUser.username} (<@${targetUser.id}>)\n**Action:** ${getRoleLabel(currentRole)} → ${getRoleLabel(nextRole)}\n**Admin:** {{AGENT_NAME}}`,
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

    db.prepare("UPDATE agents SET pin = ?, pin_is_set = 1 WHERE discord_id = ?").run(newPin, targetUser.id);
    
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

    db.prepare("UPDATE agents SET pin = ?, pin_is_set = 1 WHERE discord_id = ?").run(newPin, interaction.user.id);

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

function chunkPinAuditLines(lines, maxLength = 900) {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const lineLength = line.length + 1;
    if (current.length > 0 && currentLength + lineLength > maxLength) {
      chunks.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }

    current.push(line);
    currentLength += lineLength;
  }

  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }

  return chunks;
}

function formatPinAuditLine(agent, { revealPinValue = true } = {}) {
  const pinStatus = hasConfiguredPin(agent) ? '✅ PIN set' : '⚪ PIN missing';
  const roleLabel = getRoleLabel(agent.role);
  const teamLabel = agent.team || 'No team';
  const hotelLabel = agent.hotel_id ? getCombinedHotelLabel(agent.hotel_id) : 'Unlinked';
  const pinLabel = hasConfiguredPin(agent)
    ? (revealPinValue && agent.pin ? `PIN: \`${agent.pin}\`` : 'PIN: hidden')
    : 'PIN: not set';
  const agentLabel = agent.discord_id ? `<@${agent.discord_id}>` : agent.username;
  let compatibilityIds = [];
  try {
    compatibilityIds = JSON.parse(agent.hotel_compatibility || '[]');
  } catch {
    compatibilityIds = [];
  }
  const compatibilityLabel = formatHotelCompatibilityLabel(compatibilityIds);

  return `• ${agentLabel} | ${roleLabel} | ${teamLabel} | ${hotelLabel} | ${pinStatus} | ${pinLabel}${compatibilityLabel !== 'none' ? ` | Access: ${compatibilityLabel}` : ''}`;
}

async function handleSeeAllPins(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Access Denied: Operations Manager or Developer only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const query = `
      SELECT discord_id, username, role, team, hotel_id, pin, pin_is_set, hotel_compatibility
      FROM agents
      ${targetUser ? 'WHERE discord_id = ?' : ''}
      ORDER BY pin_is_set DESC, username COLLATE NOCASE ASC
    `;
    const agents = targetUser
      ? db.prepare(query).all(targetUser.id)
      : db.prepare(query).all();

    if (agents.length === 0) {
      if (targetUser) {
        return interaction.editReply({ content: `🔐 No agent record found for <@${targetUser.id}>.` });
      }
      return interaction.editReply({ content: '🔐 No agents were found in the database.' });
    }

    const withPins = agents.filter(agent => hasConfiguredPin(agent));
    const missingPins = agents.filter(agent => !hasConfiguredPin(agent));
    const revealPinValues = true;

    const setLines = withPins.map(agent => formatPinAuditLine(agent, { revealPinValue: revealPinValues }));
    const missingLines = missingPins.map(agent => formatPinAuditLine(agent, { revealPinValue: revealPinValues }));
    const setChunks = chunkPinAuditLines(setLines);
    const missingChunks = chunkPinAuditLines(missingLines);

    const embed = new EmbedBuilder()
      .setTitle(targetUser ? `🔐 Aavgo PIN Audit - ${targetUser.username}` : '🔐 Aavgo PIN Audit')
      .setDescription(
        `### PIN Inventory\n` +
        '───────────────────\n' +
        `**🎯 Scope Filter:** ${targetUser ? `<@${targetUser.id}>` : 'All agents'}\n` +
        `**🔎 PIN Display:** Raw PIN values\n` +
        `**📊 Total Agents:** ${agents.length}\n` +
        `**✅ PIN Set:** ${withPins.length}\n` +
        `**⚪ PIN Missing:** ${missingPins.length}\n` +
        `**🛡️ Scope:** Developer/OM audit with access coverage details.\n` +
        '───────────────────'
      )
      .setColor(withPins.length > 0 ? 0x57F287 : 0xFEE75C)
      .setFooter({ text: 'Aavgo Operations - PIN Audit' })
      .setTimestamp();

    for (const [index, chunk] of setChunks.entries()) {
      embed.addFields({
        name: index === 0 ? `✅ PIN Set (${withPins.length})` : `✅ PIN Set (cont.)`,
        value: chunk,
        inline: false
      });
    }

    if (missingPins.length > 0) {
      for (const [index, chunk] of missingChunks.entries()) {
        embed.addFields({
          name: index === 0 ? `⚪ PIN Missing (${missingPins.length})` : `⚪ PIN Missing (cont.)`,
          value: chunk,
          inline: false
        });
      }
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error in handleSeeAllPins:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to build the PIN audit.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to build the PIN audit.', ephemeral: true }).catch(() => {});
    }
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

const {
  handleTestUiCommand,
  handleTestUiButton,
  handleTestUiSelect,
  handleTestUiThemeSelect
} = createTestUiHandlers({
  isDeveloper,
  safeDeferComponentUpdate,
  sendComponentUpdate,
  sendComponentReply
});

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
        '> `/login [member] [hotel] [mode] [time]`: Start your own shift or backfill a missed login for an agent.\n' +
        '> `/setup-login-team`: Deploy the Team Leader / SME login portal.\n' +
        '> `/setup-profiles`: Deploy the staff profiles dashboard panel.\n' +
        '> `/setup-dev-todo`: Deploy or refresh the shared developer launch board.\n' +
        '> `/test-gui` (`/test-ui` legacy alias): Open the screenshot-style UI preview lab (shift route, hotel status, training status, training log, newcomer card).\n' +
        '> `/todo-add`, `/todo-move`, `/todo-refresh`: Manage centralized developer tasks.\n' +
        '> `/select-trainee`: Assign the Trainees role to a user.\n' +
        '> `/hotel-status action:refresh_all|clear_team1_live_embeds`: Refresh all boards or clear Team 1 live per-hotel embeds (test).\n\n' +
        '### 👥 Agent Lifecycle Controls\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/add-agent`: Instant-create an agent, TL, or SME profile.\n' +
        '> `/remove-agent`: Remove an agent through the managed flow.\n' +
        '> `/assign-team`: Move an agent between Team 1, Team 2, and Team 3.\n' +
        '> `/db-assign-hotel`: Permanently link an agent to a hotel (`sync`: permission/ghost/both).\n' +
        '> `/promote user:@name role:Developer|Operations Manager`: Create a promotion request (Developer: dual approval, Operations Manager: single approval).\n' +
        '> `/db-add-developer`: Legacy alias that now routes to approval request flow.\n' +
        '> `/db-set-pin`: Reset an agent PIN in real time.\n' +
        '> `/db-set-phone`: Correct an agent phone record.\n' +
        '> `/db-promote-tl`, `/db-promote-sme`, `/db-demote`: Change leadership roles (`/db-demote` steps down one rank).\n' +
        '> `/db-set-operation-manager`: Legacy alias that now routes to approval request flow.\n\n' +
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
        '> `/add-hours`: Add a dated manual hours correction with mode (live/training). Hotel can fall back, date accepts friendly formats, and hours can auto-calculate.\n' +
        '> `/remove-hours`: Remove manual hours by mode and date (supports Today/Yesterday).\n' +
        '> `/end-shift user:@name`: End your own shift or force-end another active shift (OM/Developer).\n' +
        '> `/limit-warning user:@name`: Manually trigger overtime warning (DM + ping).\n' +
        '> `/time-travel name:@name hours:# minutes:# seconds:#`: Simulate elapsed time for overtime testing without changing real worked hours.\n' +
        '> `/guide` and `/add-guide`: Search or update SOP knowledge.\n' +
        '> `/db-set-schedule`: Assign shifts to agents.\n' +
        '> `/set-hotel-shifts`: Store two hotel shift options and sync matching hotel roles.\n' +
        '> `/hours-export period:day|week|month`: Export a horizontal Excel-style timesheet.\n' +
        '> `/see-all-pins` or `/see-all-pins user:@name`: View stored PIN values (Developer/OM only).\n' +
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
        '> If your PIN is missing, the shift flow opens **Set Security PIN & Phone** automatically.\n' +
        '> `/check-hours`: Review your logged hours.\n' +
        '> `/end-shift` or `/logout`: End your current shift safely.\n\n' +
        '### 🧰 During Shift\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/tools`: Open the agent tools panel for break and emergency actions.\n' +
        '> `/guide`: Search SOPs and hotel process guides by topic.\n\n' +
        '### 👥 Onboarding Support\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '> `/select-trainee`: Mark a user as a trainee during onboarding.\n' +
        '> `/assign-team`: Reassign a user to Team 1, Team 2, or Team 3.\n\n' +
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

async function handleOvertimeConfirm(interaction) {
  try {
    const [, sessionIdRaw, targetDiscordId] = String(interaction.customId || '').split(':');
    const sessionId = String(sessionIdRaw || '');

    if (!sessionId || !targetDiscordId) {
      return interaction.reply({ content: '❌ Invalid overtime confirmation payload.', ephemeral: true });
    }

    if (interaction.user.id !== targetDiscordId) {
      return interaction.reply({ content: '❌ This overtime confirmation is not for your account.', ephemeral: true });
    }

    const session = db.prepare(`
      SELECT
        sessions.id,
        sessions.agent_id,
        sessions.login_time,
        COALESCE(sessions.overtime_confirmed, 0) AS overtime_confirmed,
        COALESCE(sessions.time_travel_offset_ms, 0) AS time_travel_offset_ms,
        sessions.overtime_next_warning_at,
        COALESCE(sessions.session_kind, 'shift') AS session_kind,
        agents.discord_id,
        agents.username,
        agents.role
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE sessions.id = ? AND sessions.status = 'active'
      LIMIT 1
    `).get(sessionId);

    if (!session || String(session.discord_id) !== interaction.user.id) {
      return interaction.reply({ content: '⚠️ This session is no longer active.', ephemeral: true });
    }

    if (Number(session.overtime_confirmed || 0) === 1) {
      return interaction.reply({ content: '✅ Overtime is already confirmed for this session.', ephemeral: true });
    }

    const warningThresholdMs = getOvertimeWarningThresholdMs(session, interaction.guild);
    const warningThresholdLabel = getOvertimeThresholdLabel(warningThresholdMs);
    const finalLimitDueMs = getSessionFinalLimitDueMs(session, OVERTIME_FINAL_LIMIT_MS);
    const finalLimitUnix = Math.floor(finalLimitDueMs / 1000);
    overtimeConfirmedSessionIds.add(String(session.id));
    overtimeWarnedSessionIds.delete(String(session.id));
    db.prepare(`
      UPDATE sessions
      SET overtime_confirmed = 1,
          overtime_warning_at = NULL,
          overtime_next_warning_at = NULL
      WHERE id = ? AND status = 'active'
    `).run(session.id);

    const confirmedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`overtime_confirmed:${session.id}`)
        .setLabel('Overtime Confirmed')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    await interaction.update({
      content:
        `✅ Overtime confirmed for your current ${session.session_kind === 'training' ? 'training' : 'shift'}.\n` +
        `You may continue until the **12-hour final limit**.\n` +
        `Final auto-logout: <t:${finalLimitUnix}:F> (<t:${finalLimitUnix}:R>).`,
      components: [confirmedRow]
    });

    const confirmNotifyStats = await notifyNotificationRoleMembers(interaction.client, {
      title: '📢 8-Hour Overtime Confirmed',
      description:
        `**Agent:** ${session.username} (<@${session.discord_id}>)\n` +
        `**Mode:** ${session.session_kind === 'training' ? 'Training' : 'Shift'}\n` +
        '**Event:** User confirmed overtime after the 8-hour warning.'
    });

    await sendAuditLog(interaction.client, {
      title: '✅ 8-Hour Overtime Confirmed',
      description:
        `**User:** ${session.username} (<@${session.discord_id}>)\n` +
        `**Mode:** ${session.session_kind === 'training' ? 'Training' : 'Shift'}\n` +
        `**8-Hour Threshold:** ${warningThresholdLabel}\n` +
        `**Final Limit:** 12 hours (auto-logout at <t:${finalLimitUnix}:F>)\n` +
        `**Notification Role DM:** ${confirmNotifyStats.sent}/${confirmNotifyStats.attempted} sent (${confirmNotifyStats.failed} failed)`,
      color: 0x57F287,
      userId: interaction.user.id,
      guild: interaction.guild,
      channelIdOverride: OVERTIME_8H_LOG_CHANNEL_ID
    });
  } catch (error) {
    console.error('Error in handleOvertimeConfirm:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: '❌ Failed to confirm overtime.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to confirm overtime.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleOvertimeEndShift(interaction) {
  try {
    const [, sessionIdRaw, targetDiscordId] = String(interaction.customId || '').split(':');
    const sessionId = String(sessionIdRaw || '');

    if (!sessionId || !targetDiscordId) {
      return interaction.reply({ content: '❌ Invalid overtime end-shift payload.', ephemeral: true });
    }

    if (interaction.user.id !== targetDiscordId) {
      return interaction.reply({ content: '❌ This overtime action is not for your account.', ephemeral: true });
    }

    const session = db.prepare(`
      SELECT
        sessions.id,
        COALESCE(sessions.session_kind, 'shift') AS session_kind,
        agents.discord_id
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE sessions.id = ? AND sessions.status = 'active'
      LIMIT 1
    `).get(sessionId);

    if (!session || String(session.discord_id) !== interaction.user.id) {
      return interaction.reply({ content: '⚠️ This session is no longer active.', ephemeral: true });
    }

    const guildId = interaction.client.guilds.cache.first()?.id || '1482220918355922974';
    const attendanceChannelUrl = `https://discord.com/channels/${guildId}/${ATTENDANCE_CHANNEL_ID}`;
    const redirectRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Open Attendance')
        .setURL(attendanceChannelUrl)
    );

    return interaction.update({
      content: '📍 Please continue in the attendance channel.',
      embeds: [],
      components: [redirectRow]
    });
  } catch (error) {
    console.error('Error in handleOvertimeEndShift:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: '❌ Failed to redirect to the attendance channel.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to redirect to the attendance channel.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleTimeTravel(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Developer or Operations Manager access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('name');
    const hours = interaction.options.getInteger('hours') ?? 0;
    const minutes = interaction.options.getInteger('minutes') ?? 0;
    const seconds = interaction.options.getInteger('seconds') ?? 0;
    const totalOffsetMs = ((hours * 60 * 60) + (minutes * 60) + seconds) * 1000;

    const activeSessions = db.prepare(`
      SELECT
        sessions.id,
        sessions.login_time,
        COALESCE(sessions.time_travel_offset_ms, 0) AS time_travel_offset_ms,
        COALESCE(sessions.session_kind, 'shift') AS session_kind,
        agents.discord_id,
        agents.username
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE sessions.status = 'active'
        AND agents.discord_id = ?
      ORDER BY sessions.login_time DESC
    `).all(targetUser.id);

    if (activeSessions.length === 0) {
      return interaction.editReply({
        content: `❌ **${targetUser.username}** has no active shift/training session right now.`
      });
    }

    const applyOffsetTx = db.transaction((sessionIds, offsetMs) => {
      const stmt = db.prepare(`
        UPDATE sessions
        SET
          time_travel_offset_ms = ?,
          overtime_warning_at = NULL,
          overtime_confirmed = 0,
          overtime_next_warning_at = NULL
        WHERE id = ? AND status = 'active'
      `);
      for (const sessionId of sessionIds) {
        stmt.run(offsetMs, sessionId);
      }
    });
    applyOffsetTx(activeSessions.map(row => row.id), totalOffsetMs);

    for (const session of activeSessions) {
      const sessionKey = String(session.id);
      overtimeWarnedSessionIds.delete(sessionKey);
      overtimeConfirmedSessionIds.delete(sessionKey);
    }

    // Trigger checks immediately so warning tests do not require waiting for the next minute tick.
    await monitorOvertimeSessions(interaction.client);

    const previewLines = activeSessions.slice(0, 3).map(session => {
      const elapsedMs = Math.max(0, Date.now() - parseSessionTimestamp(session.login_time) + totalOffsetMs);
      return `- Session #${session.id} (${session.session_kind === 'training' ? 'Training' : 'Shift'}): simulated elapsed **${formatDurationHms(elapsedMs)}**`;
    });
    if (activeSessions.length > 3) {
      previewLines.push(`- ...and ${activeSessions.length - 3} more active session(s).`);
    }

    const offsetLabel = formatDurationHms(totalOffsetMs);
    const modeLabel = totalOffsetMs === 0 ? 'cleared' : 'applied';
    const overtimeHint = totalOffsetMs >= OVERTIME_WARNING_MS
      ? '\n⚠️ This offset is above the 8-hour warning threshold and can trigger overtime alerts immediately.'
      : '';

    sendAuditLog(interaction.client, {
      title: totalOffsetMs === 0 ? '🧪 Time Travel Cleared' : '🧪 Time Travel Applied',
      description:
        `**Target:** ${targetUser.username} (<@${targetUser.id}>)\n` +
        `**Offset:** ${offsetLabel}\n` +
        `**Active Sessions Updated:** ${activeSessions.length}\n` +
        `**Triggered By:** {{AGENT_NAME}}`,
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    await interaction.editReply({
      content:
        `✅ Time travel ${modeLabel} for **${targetUser.username}**.\n` +
        `Simulated offset: **${offsetLabel}**\n` +
        `Updated sessions: **${activeSessions.length}**\n` +
        `\n${previewLines.join('\n')}` +
        `${overtimeHint}\n\n` +
        `This does **not** edit real login timestamps or add permanent worked hours.`
    });
  } catch (error) {
    console.error('Error in handleTimeTravel:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to apply time travel offset.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to apply time travel offset.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleLimitWarning(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Developer or Operations Manager access required.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const session = db.prepare(`
      SELECT
        sessions.id,
        sessions.agent_id,
        sessions.login_time,
        COALESCE(sessions.session_kind, 'shift') AS session_kind,
        agents.discord_id,
        agents.username,
        agents.role
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE sessions.status = 'active'
        AND agents.discord_id = ?
      ORDER BY sessions.login_time DESC
      LIMIT 1
    `).get(targetUser.id);

    if (!session) {
      return interaction.editReply({ content: `❌ **${targetUser.username}** has no active shift/training session right now.` });
    }

    const warningThresholdMs = getOvertimeWarningThresholdMs(session, interaction.guild);
    overtimeWarnedSessionIds.add(String(session.id));
    const result = await sendOvertimeWarningNotice(interaction.client, session, 'MANUAL', warningThresholdMs);

    sendAuditLog(interaction.client, {
      title: '📢 Manual Limit Warning Triggered',
      description:
        `**Target:** ${session.username} (<@${session.discord_id}>)\n` +
        `**Mode:** ${session.session_kind === 'training' ? 'Training' : 'Shift'}\n` +
        `**Triggered By:** ${interaction.user.username} (<@${interaction.user.id}>)`,
      color: 0xF1C40F,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    await interaction.editReply({
      content:
        `✅ Overtime warning sent to **${session.username}**.\n` +
        `Warning DM: **${result.dmSent ? 'Sent' : 'Failed'}** | Confirm Button DM: **${result.buttonDmSent ? 'Sent' : 'Failed'}** | ` +
        `TTS DM: **${result.ttsSent ? 'Sent' : 'Failed'}** | Limit: **${warningThresholdMs === OVERTIME_TEST_WARNING_MS ? '3 minutes' : '8 hours'}**`
    });
  } catch (error) {
    console.error('Error in handleLimitWarning:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to send manual overtime warning.' }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to send manual overtime warning.', ephemeral: true }).catch(() => {});
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
    await syncAgentRecordFromDiscordMember(member, interaction.guild, 'SELECT-TRAINEE');

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
      return interaction.editReply({ content: '❌ Please choose Team 1, Team 2, or Team 3.' });
    }

    const member = await interaction.guild.members.fetch(targetUser.id);
    const currentTeam = db.prepare("SELECT team FROM agents WHERE discord_id = ?").get(targetUser.id)?.team || null;
    const targetTeamRole = interaction.guild.roles.cache.find(
      role => normalizeDiscordRoleName(role?.name) === normalizeDiscordRoleName(teamName)
    );
    const otherTeamRoles = getOtherTeamNames(teamName)
      .map(otherTeam =>
        interaction.guild.roles.cache.find(
          role => normalizeDiscordRoleName(role?.name) === normalizeDiscordRoleName(otherTeam)
        )
      )
      .filter(Boolean);

    db.prepare("UPDATE agents SET team = ? WHERE discord_id = ?").run(teamName, targetUser.id);

    const removableTeamRoles = otherTeamRoles.filter(role => member.roles.cache.has(role.id));
    if (removableTeamRoles.length > 0) {
      await member.roles.remove(removableTeamRoles);
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
        '- `/login`: Start your own shift or backfill a missed login with `member`, `hotel`, `mode`, and `time`.\n' +
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
        clearSuppressedHotelStatusChannelForHotel(h.id);
        await updateHotelStatusEmbed(interaction.client, h.id);
      }
      await updateAllHotelStatusEmbed(interaction.client);
      await updateTeamStatusEmbed(interaction.client, 'Team 1');
      await updateTeamStatusEmbed(interaction.client, 'Team 2');
      await updateTeamStatusEmbed(interaction.client, 'Team 3');
      await interaction.editReply({ content: '✅ Successfully refreshed all hotel and team status embeds.' });
    } else if (action === 'clear_team1_live_embeds') {
      const result = await clearTeamHotelLiveStatusEmbeds(interaction.client, 'Team 1');
      await interaction.editReply({
        content:
          '🧪 Team 1 live status embed cleanup complete.\n' +
          `- Boards scanned: ${result.groupCount}\n` +
          `- Deleted tracked messages: ${result.deletedTracked}\n` +
          `- Deleted recovered messages: ${result.deletedRecovered}\n` +
          (result.issues.length > 0 ? `- Notes: ${result.issues.join('; ')}` : '- Notes: none')
      });
    } else {
      if (!specificHotel) return interaction.editReply({ content: '❌ Please specify a hotel to refresh.' });
      clearSuppressedHotelStatusChannelForHotel(specificHotel);
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
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: '❌ Developer or Operations Manager access required.', ephemeral: true });
    }
    const target = interaction.options.getUser('user');
    const hotelId = interaction.options.getString('hotel');
    const syncMode = interaction.options.getString('sync') || 'both';
    const syncPermission = syncMode === 'permission' || syncMode === 'both';
    const syncGhost = syncMode === 'ghost' || syncMode === 'both';

    const targetAgent = db.prepare("SELECT id, team FROM agents WHERE discord_id = ?").get(target.id);
    if (!targetAgent) {
      return interaction.reply({ content: `❌ **${target.username}** is not a registered agent.`, ephemeral: true });
    }

    const hotelRecord = db.prepare("SELECT id, team FROM hotels WHERE id = ? AND id != 'TEAM_SHIFT'").get(hotelId);
    if (!hotelRecord) {
      return interaction.reply({ content: `❌ Hotel \`${hotelId}\` was not found in the database.`, ephemeral: true });
    }

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const effectiveTeam = resolveEffectiveTeamForAgent(targetAgent, targetMember);
    const hotelTeam = normalizeTeamInput(hotelRecord.team);

    if (effectiveTeam && hotelTeam && effectiveTeam !== hotelTeam) {
      return interaction.reply({
        content:
          `❌ Team mismatch for **${target.username}**.\n` +
          `Current Team: **${effectiveTeam}**\n` +
          `Hotel Team: **${hotelTeam}**\n` +
          `Use \`/assign-team\` first, then run \`/db-assign-hotel\` again.`,
        ephemeral: true
      });
    }

    let autoTeamNote = '';
    if (!effectiveTeam && hotelTeam) {
      db.prepare("UPDATE agents SET team = ? WHERE id = ?").run(hotelTeam, targetAgent.id);
      autoTeamNote = `\nTeam auto-set to **${hotelTeam}** to match the selected hotel.`;
    }

    db.prepare("UPDATE agents SET hotel_id = ?, hotel_compatibility = ? WHERE id = ?")
      .run(hotelId, serializeHotelCompatibility([hotelId]), targetAgent.id);

    await interaction.reply({
      content:
        `✅ Successfully linked **${target.username}** permanently to **${getCombinedHotelLabel(hotelId)}**.\n` +
        `Role sync mode: **${syncMode}**.${autoTeamNote}`,
      ephemeral: true
    });

    sendAuditLog(interaction.client, {
      title: '🔗 Permanent Hotel Linkage',
      description: `**Agent:** ${target.username} (<@${target.id}>)\n**Linked to:** ${getCombinedHotelLabel(hotelId)}\n**Role Sync:** ${syncMode}\n**Admin:** {{AGENT_NAME}}`,
      color: 0x3498DB,
      userId: interaction.user.id,
      guild: interaction.guild
    });

    // Role Synchronization (Grey Roles)
    try {
      if (targetMember) {
        const greyRoleIds = syncGhost ? Object.values(ROLE_NAMES.GREY) : [];
        const greenRoleIds = syncPermission ? Object.values(ROLE_NAMES.GREEN) : [];
        
        // Find existing Grey/Green roles to remove
        const rolesToRemove = targetMember.roles.cache.filter(r =>
          greyRoleIds.includes(r.id) || greenRoleIds.includes(r.id)
        );
        
        if (rolesToRemove.size > 0) await targetMember.roles.remove(rolesToRemove);
        
        // Add selected role types for new assignment
        const newGreyRoleId = ROLE_NAMES.GREY[hotelId];
        const newGreenRoleId = ROLE_NAMES.GREEN[hotelId];
        const newGreyRole = syncGhost ? interaction.guild.roles.cache.get(newGreyRoleId) : null;
        const newGreenRole = syncPermission ? interaction.guild.roles.cache.get(newGreenRoleId) : null;
        
        const rolesToAdd = [newGreyRole, newGreenRole].filter(Boolean);

        if (rolesToAdd.length > 0) await targetMember.roles.add(rolesToAdd);
        console.log(`[ASSIGN] Synced permanent roles for ${target.username} to ${hotelId}`);
      }
    } catch (e) {
      console.warn('[ASSIGN] Role sync failed:', e.message);
    }
  } catch (e) {
    console.error('Error in handleDbAssignHotel:', e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Error assigning hotel.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply({ content: '❌ Error assigning hotel.' }).catch(() => {});
    }
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
    db.prepare("UPDATE agents SET hotel_compatibility = ? WHERE id = ?")
      .run(serializeHotelCompatibility([hotelOne, hotelTwo]), agent.id);

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
      const applicantsRole = interaction.guild.roles.cache.get('1484919969689894912') || interaction.guild.roles.cache.find(role => String(role.name || '').toLowerCase() === 'applicants');
      if (applicantsRole && !member.roles.cache.has(applicantsRole.id)) {
        await member.roles.add(applicantsRole).catch(() => {});
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


function trimUpdateLogLine(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function uniqueNonEmptyLines(values) {
  const seen = new Set();
  const output = [];
  for (const raw of values || []) {
    const text = trimUpdateLogLine(raw, 320);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function toUpdateLogField(lines, fallback = 'Not specified', limit = 1024) {
  const normalized = uniqueNonEmptyLines(lines).map(line => `- ${line}`);
  let text = normalized.length > 0 ? normalized.join('\n') : `- ${fallback}`;
  if (text.length <= limit) return text;
  text = text.slice(0, limit - 12).trimEnd();
  return `${text}\n- ...trimmed`;
}

function extractUniqueMatches(text, pattern) {
  const source = String(text || '');
  if (!source) return [];

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const seen = new Set();
  const output = [];
  let match;
  while ((match = regex.exec(source)) !== null) {
    const value = String(match[0] || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function extractIdsByContext(text, keywords = []) {
  const source = String(text || '');
  if (!source) return [];
  const keys = keywords.map(key => String(key || '').toLowerCase()).filter(Boolean);
  if (keys.length === 0) return [];

  const ids = new Set();
  const regex = /\b\d{17,20}\b/g;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const id = match[0];
    const start = Math.max(0, match.index - 48);
    const end = Math.min(source.length, match.index + id.length + 48);
    const context = source.slice(start, end).toLowerCase();
    if (keys.some(key => context.includes(key))) {
      ids.add(id);
    }
  }

  return [...ids];
}

function extractImpactLines(lines, keywords = [], limit = 8) {
  const keys = keywords.map(key => String(key || '').toLowerCase()).filter(Boolean);
  if (keys.length === 0) return [];

  const candidates = uniqueNonEmptyLines(lines);
  return candidates
    .filter(line => keys.some(key => line.toLowerCase().includes(key)))
    .slice(0, limit);
}

function readLatestHistoryEntryForUpdateLog() {
  try {
    const historyPath = path.resolve(__dirname, '..', 'HISTORY.md');
    if (!fs.existsSync(historyPath)) return null;

    const lines = fs.readFileSync(historyPath, 'utf8').split(/\r?\n/);
    const latestHeaderIndex = lines
      .map((line, index) => (line.trim().toLowerCase() === '## latest changes' ? index : -1))
      .filter(index => index >= 0)
      .pop();
    if (latestHeaderIndex === -1) return null;

    const sectionEndIndex = lines
      .map((line, index) => (index > latestHeaderIndex && line.trim().startsWith('## ') ? index : -1))
      .find(index => index >= 0);
    const safeSectionEndIndex = sectionEndIndex >= 0 ? sectionEndIndex : lines.length;

    let targetIndex = -1;
    for (let i = safeSectionEndIndex - 1; i > latestHeaderIndex; i -= 1) {
      if (String(lines[i] || '').startsWith('- ')) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex === -1) return null;

    const raw = lines[targetIndex] || '';
    const title = raw.slice(2).trim();
    const detailLines = [];
    const files = [];
    const notes = [];
    let summary = '';
    let section = '';

    for (let j = targetIndex + 1; j < safeSectionEndIndex; j += 1) {
      const innerRaw = lines[j] || '';
      const innerTrimmed = innerRaw.trim();
      if (!innerTrimmed) continue;
      if (innerTrimmed.startsWith('## ')) break;
      if (innerRaw.startsWith('- ')) break;

      const withoutBullet = innerTrimmed.replace(/^-+\s*/, '').trim();
      if (!withoutBullet) continue;

      const lower = withoutBullet.toLowerCase();
      if (lower.startsWith('summary:')) {
        summary = withoutBullet.slice('summary:'.length).trim();
        section = '';
        detailLines.push(summary);
        continue;
      }
      if (lower.startsWith('files touched:')) {
        section = 'files';
        continue;
      }
      if (lower.startsWith('notes:')) {
        section = 'notes';
        continue;
      }

      if (section === 'files') {
        files.push(withoutBullet);
      } else if (section === 'notes') {
        notes.push(withoutBullet);
      } else {
        detailLines.push(withoutBullet);
      }
    }

    const resolvedSummary = summary || detailLines[0] || title;
    return {
      title,
      summary: resolvedSummary,
      files: uniqueNonEmptyLines(files),
      notes: uniqueNonEmptyLines(notes),
      detailLines: uniqueNonEmptyLines(detailLines)
    };
  } catch (error) {
    console.warn('[UPDATE-LOG] Could not parse HISTORY.md entry:', error.message);
  }
  return null;
}

function buildDetailedHistoryUpdateData(entry) {
  if (!entry) return null;

  const detailPool = uniqueNonEmptyLines([
    entry.title,
    entry.summary,
    ...(entry.detailLines || []),
    ...(entry.notes || [])
  ]);
  const combined = detailPool.join('\n');

  const featureKeywords = [
    'added', 'updated', 'fixed', 'removed', 'renamed', 'expanded',
    'refined', 'implemented', 'moved', 'hardened', 'restored',
    'merged', 'reworked', 'improved'
  ];
  const permissionLogicKeywords = [
    'permission', 'access', 'authority', 'developer', 'operations manager',
    'team leader', 'role-only', 'gate', 'blocked', 'allow', 'deny',
    'logic', 'flow', 'route', 'handler', 'sync', 'filter', 'function'
  ];

  const features = extractImpactLines([entry.title, entry.summary, ...(entry.detailLines || []), ...(entry.notes || [])], featureKeywords, 8);
  const permissionLogic = extractImpactLines([entry.summary, ...(entry.detailLines || []), ...(entry.notes || [])], permissionLogicKeywords, 8);
  const commands = extractUniqueMatches(combined, /\/[a-z0-9-]+/gi)
    .slice(0, 12)
    .map(command => `\`${command}\``);

  const channelIds = extractIdsByContext(combined, ['channel', 'channels', 'kiosk', 'portal', 'board', 'log']);
  const roleIds = extractIdsByContext(combined, ['role', 'roles', 'agent', 'sme', 'team leader', 'operations manager', 'developer', 'trainee', 'applicant', 'unverified']);

  const channelSet = new Set(channelIds);
  const channelLines = channelIds.map(id => `<#${id}> (\`${id}\`)`);
  const roleLines = roleIds.filter(id => !channelSet.has(id)).map(id => `\`${id}\``);

  return {
    title: entry.title,
    summary: entry.summary,
    features: features.length > 0 ? features : [entry.summary],
    commands,
    channels: channelLines,
    roles: roleLines,
    permissionLogic,
    files: entry.files || [],
    notes: entry.notes || []
  };
}

function simplifyCommitSubjectForUpdateLog(subject) {
  const clean = String(subject || '')
    .replace(/`/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\b\d{5}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return 'General reliability and quality improvements were deployed.';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function runGitForUpdateLog(args = []) {
  const repoRoot = path.resolve(__dirname, '..');
  return execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot }).trim();
}

async function broadcastUpdateLog(client) {
  const UPDATE_LOG_CHANNEL_ID = '1485584578927132863';
  try {
    const channel = await client.channels.fetch(UPDATE_LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const currentCommitFull = runGitForUpdateLog(['rev-parse', 'HEAD']);
    const currentCommitShort = runGitForUpdateLog(['rev-parse', '--short', 'HEAD']);
    if (!currentCommitFull) return;

    const lastPosted = db.prepare("SELECT value FROM config WHERE key = ?").get('update_log_last_commit')?.value || null;
    if (lastPosted === currentCommitFull) return;

    let commitEntries = [];
    try {
      if (lastPosted) {
        const raw = runGitForUpdateLog(['log', '--pretty=format:%h%x09%s', `${lastPosted}..HEAD`]);
        commitEntries = raw ? raw.split('\n').filter(Boolean) : [];
      } else {
        const raw = runGitForUpdateLog(['log', '-1', '--pretty=format:%h%x09%s']);
        commitEntries = raw ? [raw] : [];
      }
    } catch (rangeErr) {
      console.warn('[UPDATE-LOG] Commit range lookup failed:', rangeErr.message);
      const fallback = runGitForUpdateLog(['log', '-1', '--pretty=format:%h%x09%s']);
      commitEntries = fallback ? [fallback] : [];
    }

    const parsedCommits = commitEntries.map(entry => {
      const separatorIndex = entry.indexOf('\t');
      if (separatorIndex === -1) {
        return { shortHash: currentCommitShort, subject: entry };
      }
      return {
        shortHash: entry.slice(0, separatorIndex).trim(),
        subject: entry.slice(separatorIndex + 1).trim()
      };
    });

    const plainEnglishLines = parsedCommits
      .slice(0, 5)
      .map(item => `- \`${item.shortHash || currentCommitShort}\` ${simplifyCommitSubjectForUpdateLog(item.subject)}`);
    const commitCount = parsedCommits.length > 0 ? parsedCommits.length : 1;

    const embed = new EmbedBuilder()
      .setTitle('Aavgo Bot Update Log')
      .setDescription(
        'A new update is now live.\n\n' +
        'What changed:\n' +
        (plainEnglishLines.length ? plainEnglishLines.join('\n') : '- General stability updates were applied.')
      )
      .addFields(
        { name: 'Build', value: `\`${currentCommitShort || 'unknown'}\``, inline: true },
        { name: 'Commits', value: String(commitCount), inline: true }
      )
      .setColor(0xF1C40F)
      .setFooter({ text: 'Aavgo Operations - Update Log' })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('update_log_last_commit', currentCommitFull);
  } catch (error) {
    console.warn('[UPDATE-LOG] Failed to broadcast deployment update:', error.message);
  }
}

// Unified portal override: keep command for compatibility, but route to the merged login flow.
async function handleSetupLoginTeam(interaction) {
  try {
    if (!isDeveloper(interaction)) {
      return interaction.reply({ content: 'Only Developers can refresh the login portal.', ephemeral: true });
    }

    await ensureAgentKioskMessage(interaction.client, interaction.channelId);
    await updateTeamStatusEmbed(interaction.client, 'Team 1');
    await updateTeamStatusEmbed(interaction.client, 'Team 2');
    await updateTeamStatusEmbed(interaction.client, 'Team 3');
    await updateTrainingStatusEmbed(interaction.client);

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: 'Unified login portal refreshed. Use /setup-login for all roles.' });
    }
    return interaction.reply({
      content: 'Unified login portal refreshed. Use /setup-login for all roles.',
      ephemeral: true
    });
  } catch (error) {
    console.error('Error in handleSetupLoginTeam (unified override):', error);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: 'Failed to refresh unified login portal.' }).catch(() => {});
    }
    return interaction.reply({ content: 'Failed to refresh unified login portal.', ephemeral: true }).catch(() => {});
  }
}

function buildAssignedHotelShiftPickerPayload(hotelIds, allowMultiHotel = false) {
  const hotelOptions = buildAssignedHotelSelectionOptions(hotelIds);
  const pickMenu = new StringSelectMenuBuilder()
    .setCustomId(allowMultiHotel ? 'shift_hotel_pick_menu_multi' : 'shift_hotel_pick_menu')
    .setPlaceholder('Choose your hotel assignment...')
    .addOptions(
      hotelOptions.map(hotel =>
        new StringSelectMenuOptionBuilder()
          .setLabel(hotel.label)
          .setValue(hotel.id)
          .setDescription(hotel.description)
      )
    );

  const embed = new EmbedBuilder()
    .setTitle('🏨 Choose Your Hotel Location')
    .setDescription(
      '### 📍 ASSIGNMENT SELECTION\n' +
      '────────────────────────\n' +
      '> Use the dropdown below to select your hotel.\n\n' +
      '> ⚠ **Permanent choice.** You cannot switch hotels\n' +
      '> without contacting a Developer or Team Leader.\n' +
      '────────────────────────'
    )
    .setColor(0x57F287)
    .setFooter({ text: 'Aavgo Operations • Hotel Assignment' })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(pickMenu)]
  };
}

function buildAgentRouteSelectionPayload() {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations · Agent Route')
    .setDescription(
      'SESSION TYPE SELECTION\n' +
      '────────────────────────\n' +
      'Choose how this session should run.\n\n' +
      '• **Live:** Hotel Shift for normal operations.\n' +
      '• **Practice:** Training for trainee sessions.\n' +
      '────────────────────────'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo Operations • Session Routing' })
    .setTimestamp();

  const hotelBtn = new ButtonBuilder()
    .setCustomId('shift_mode_hotel_btn')
    .setLabel('Live • Hotel Shift')
    .setStyle(ButtonStyle.Primary);

  const trainingBtn = new ButtonBuilder()
    .setCustomId('training_start_btn')
    .setLabel('Practice • Training')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(hotelBtn, trainingBtn)]
  };
}

function buildReadyToStartShiftPayload(hotelId, isTakeover = false, allowMultiHotel = false) {
  const confirmEmbed = new EmbedBuilder()
    .setTitle('🛡️ Aavgo Operations · Agent Route')
    .setDescription(
      '### READY TO START SHIFT\n' +
      '────────────────────────\n' +
      `**Hotel:** ${getCombinedHotelLabel(hotelId)}\n` +
      '**Action:** Start this shift now?\n' +
      '────────────────────────'
    )
    .setColor(0x57F287)
    .setFooter({ text: 'Aavgo Operations • Shift Confirmation' })
    .setTimestamp();

  const yesButton = new ButtonBuilder()
    .setCustomId(`agent_shift_confirm_yes:${hotelId}:${isTakeover ? '1' : '0'}:${allowMultiHotel ? '1' : '0'}`)
    .setLabel('Start Shift')
    .setStyle(ButtonStyle.Primary);

  const noButton = new ButtonBuilder()
    .setCustomId('agent_shift_confirm_no')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [confirmEmbed],
    components: [new ActionRowBuilder().addComponents(yesButton, noButton)]
  };
}

async function showAssignedHotelShiftPicker(interaction, hotelIds, allowMultiHotel = false) {
  return sendPrivateFlowPayload(
    interaction,
    buildAssignedHotelShiftPickerPayload(hotelIds, allowMultiHotel)
  );
}

async function handleAgentRoutePick(interaction) {
  try {
    let agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      await syncAgentRecordFromDiscordMember(interaction.member, interaction.guild, 'AGENT ROUTE');
      agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    }
    if (!agent) {
      return interaction.reply({ content: 'You are not registered as an agent.', ephemeral: true });
    }

    if (await guardShiftPinFirst(interaction, agent, 'shift')) {
      return;
    }

    if (isTraineeMember(interaction)) {
      return await showTrainingHotelSelection(interaction, isEphemeralSourceInteraction(interaction));
    }

    return sendPrivateFlowPayload(interaction, buildAgentRouteSelectionPayload());
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[AGENT-ROUTE] Interaction expired before response (10062).');
      return;
    }
    console.error('Error in handleAgentRoutePick:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to open agent route picker.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Failed to open agent route picker.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleSameHotelConfirm(interaction) {
  try {
    await safeDeferComponentUpdate(interaction);

    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return sendPrivateFlowPayload(interaction, {
        content: 'You are not registered as an agent.',
        embeds: [],
        components: []
      });
    }

    const effectiveTeam = resolveEffectiveTeamForAgent(agent, interaction.member);
    if (!effectiveTeam) {
      return sendPrivateFlowPayload(interaction, {
        content: 'Team assignment missing. Please contact management.',
        embeds: [],
        components: []
      });
    }

    const assignedHotelIds = filterHotelIdsByTeam(
      getAssignedHotelIdsFromMemberRoles(interaction.member),
      effectiveTeam
    );
    const compatibilityHotelIds = (() => {
      try {
        const compatibility = JSON.parse(agent.hotel_compatibility || '[]')
          .map(normalizeCombinedHotelId)
          .filter(Boolean);
        return filterHotelIdsByTeam(compatibility, effectiveTeam);
      } catch {
        return [];
      }
    })();
    const uniqueAssignedHotelIds = [...new Set(assignedHotelIds.length > 0 ? assignedHotelIds : compatibilityHotelIds)];

    if (interaction.customId.startsWith('same_hotel_confirm_no')) {
      if (uniqueAssignedHotelIds.length === 0) {
        return sendPrivateFlowPayload(interaction, {
          content: 'No assigned hotels were found for your account.',
          embeds: [],
          components: []
        });
      }

      return sendPrivateFlowPayload(
        interaction,
        buildAssignedHotelShiftPickerPayload(uniqueAssignedHotelIds, false)
      );
    }

    const payload = String(interaction.customId || '').replace('same_hotel_confirm_yes:', '');
    const [hotelIdRaw] = payload.split(':');
    const hotelId = normalizeCombinedHotelId(hotelIdRaw);
    const allowMultiHotel = false;

    const selectedHotelTeam = normalizeTeamInput(
      db.prepare("SELECT team FROM hotels WHERE id = ?").get(hotelId)?.team
    );
    if (selectedHotelTeam && selectedHotelTeam !== effectiveTeam) {
      return sendPrivateFlowPayload(interaction, {
        content: `${getCombinedHotelLabel(hotelId)} is not in your assigned team (${effectiveTeam}).`,
        embeds: [],
        components: []
      });
    }

    return sendComponentUpdate(interaction, buildReadyToStartShiftPayload(hotelId, false, allowMultiHotel));
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[SAME-HOTEL] Interaction expired before response (10062).');
      return;
    }
    console.error('Error in handleSameHotelConfirm:', error);
    await sendComponentReply(interaction, { content: 'Failed to continue with this hotel.', ephemeral: true }).catch(() => {});
  }
}
async function handleHotelSelectMenu(interaction) {
  try {
    await safeDeferComponentUpdate(interaction);

    const hotelId = normalizeCombinedHotelId(interaction.values[0]);
    const agent = db.prepare('SELECT * FROM agents WHERE discord_id = ?').get(interaction.user.id);
    if (!agent) {
      return sendComponentReply(interaction, { content: '❌ You are not registered as an agent.', ephemeral: true });
    }

    const effectiveTeam = resolveEffectiveTeamForAgent(agent, interaction.member);
    if (!effectiveTeam) {
      return sendComponentReply(interaction, { content: '⚠️ Team assignment missing. Please contact management.', ephemeral: true });
    }
    const selectedHotelTeam = normalizeTeamInput(
      db.prepare("SELECT team FROM hotels WHERE id = ?").get(hotelId)?.team
    );
    if (selectedHotelTeam && selectedHotelTeam !== effectiveTeam) {
      return sendComponentReply(interaction, {
        content: `❌ ${getCombinedHotelLabel(hotelId)} is not in your assigned team (${effectiveTeam}).`,
        ephemeral: true
      });
    }

    if (agent.hotel_id) {
      return sendComponentUpdate(interaction, {
        content: '🔒 **Hotel Already Linked.** Your account is permanently assigned. Contact a Developer to change it.',
        embeds: [],
        components: []
      });
    }

    const hotelName = getCombinedHotelLabel(hotelId);
    const confirmEmbed = new EmbedBuilder()
      .setTitle('🏨 Confirm Hotel Assignment')
      .setDescription(
        '### ASSIGNMENT CONFIRMATION\n' +
        '────────────────────────\n' +
        `You are about to link your account to **${hotelName}**.\n\n` +
        '> ⚠ This is a permanent choice unless changed by\n' +
        '> a Developer or Team Leader.\n' +
        '────────────────────────'
      )
      .setColor(0xFEE75C)
      .setFooter({ text: 'Aavgo Operations • Assignment Lock-In' })
      .setTimestamp();

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`confirm_hotel_${hotelId}`)
      .setLabel('Link This Hotel')
      .setStyle(ButtonStyle.Success);

    const cancelBtn = new ButtonBuilder()
      .setCustomId('cancel_hotel_link')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    return sendComponentUpdate(interaction, {
      embeds: [confirmEmbed],
      components: [new ActionRowBuilder().addComponents(confirmBtn, cancelBtn)]
    });
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('[HOTEL-SELECT] Interaction expired before response (10062).');
      return;
    }
    console.error('Error in handleHotelSelectMenu:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Failed to open hotel assignment confirmation.', embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: '❌ Failed to open hotel assignment confirmation.', ephemeral: true }).catch(() => {});
    }
  }
}

module.exports = {
  HOTEL_NAMES,
  HOTEL_LOGIN_CHANNELS,
  sendAuditLog,
  broadcastUpdateLog,
  processAttendanceMessage,
  reactToLatestAttendanceMessage,
  scheduleAttendanceReactionFlip,
  clearAttendanceReactionTimer,
  ensureAgentKioskMessage,
  updateHotelStatusEmbed,
  updateAllHotelStatusEmbed,
  handleSetupLogin, 
  handleSetupRegister,
  handleSetupSecurity,
  handleShiftRolePrompt,
  handleAgentRoutePick,
  handleManagementRoutePick,
  handleManagementLiveStart,
  handleManagementTeamStart,
  handleShiftModePrompt,
  handleStartShiftClick, 
  syncAgentRecordFromDiscordMember,
  syncGuildAgentRecordsFromRoles,
  resolveLiveHotelIdFromMemberRoles,
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
  handleAddHours,
  handleRemoveHours,
  handleHoursExport,
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
  handleSeeAllPins,
  handleDbSetPin,
  handleResetPin,
  handleSetupLoginTeam,
  updateTeamStatusEmbed,
  handlePromote,
  handleDbAddDeveloper,
  handleDevApprove,
  handleDevDeny,
  handlePromotionRequestApprove,
  handlePromotionRequestDeny,
  handleSensitivePromotionRoleAddAttempt,
  handleDbSetPhone,
  handleDbLogCheckin,
  handlePromoteTL,
  handlePromoteSME,
  handleSetOperationManager,
  handleDemote,
  handleDbRemoveUser,
  handleMemberLeave,
  handleHelpStaff,
  handleTestUiCommand,
  handleTestUiButton,
  handleTestUiSelect,
  handleTestUiThemeSelect,
  handleHelpAgent,
  handleOvertimeConfirm,
  handleOvertimeEndShift,
  handleLimitWarning,
  handleTimeTravel,
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
  monitorOvertimeSessions,
  checkSchedules,
  isDeveloper,
  normalizeAgentRole,
  getRoleLabel,
  getRoleRank,
  hasAgentRoleAtLeast,
  interactionHasRoleAtLeast,
  getAgentDisplayName,
  handleConfirmHotelLink,
  handleHotelLinkStartChoice,
  handleCancelHotelLink,
  handleHotelSelectMenu,
  handleAgentShiftStartConfirm,
  handleTrainingStartClick,
  handleTrainingHotelSelectMenu,
  handleSameHotelConfirm,
  handleShiftCallJoin,
  handleDbRemoveAll,
  handlePurgeConfirm,
  handlePurgeDeny,
  closeAllActiveSessionsForAgent,
  handleAttendanceTextLogin,
  handleAttendanceTextLogout,
  setAttendanceQueueRole,
  applyLoggedOutRolesForMember,
  getAllowedShiftVoiceChannelIds,
  normalizeTeamInput,
  normalizeHotelInput,
  getCombinedHotelLabel,
  getOperationalHotelIdsForTeam,
  syncGuildAgentRecordsFromRoles
};

