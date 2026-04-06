const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');

const EPHEMERAL_FLAGS = MessageFlags.Ephemeral;
const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

const TEST_UI_VARIANTS = {
  idle: 'idle',
  active: 'active'
};

const TEST_UI_THEMES = {
  aavgo: { label: 'Aavgo Ops Amber', color: 0xF1C40F },
  vercel: { label: 'Vercel Mono', color: 0x9CA3AF },
  stripe: { label: 'Stripe Gradient', color: 0x635BFF },
  notion: { label: 'Notion Warm', color: 0x2F3437 }
};

const TEST_UI_DENSITIES = {
  cozy: { label: 'Cozy' },
  compact: { label: 'Compact' }
};

const TEST_UI_SCREENS = {
  shift_route: {
    label: 'Shift Route Card'
  },
  hotel_status: {
    label: 'Hotel Status Card'
  },
  training_status: {
    label: 'Training Status Card'
  },
  training_started: {
    label: 'Training Started Log'
  },
  newcomer: {
    label: 'Newcomer Joined Card'
  }
};

const DEMO_HOTELS = {
  bw_to: { id: 'BW_TO', label: 'Indianhead/Magnuson', team: 'Team 1', emoji: '🏨' },
  rmda_sup8: { id: 'RMDA', label: 'Ramada / Super 8', team: 'Team 1', emoji: '🏠' },
  gicp: { id: 'GICP', label: 'The Garden Inn At Campsite', team: 'Team 1', emoji: '🏨' },
  ad1: { id: 'AD1', label: 'AD1', team: 'Team 1', emoji: '📞' },
  trvl: { id: 'TRVL', label: 'Travelodge', team: 'Team 1', emoji: '🏩' },
  dibs: { id: 'DIBS', label: 'Day Inns Bishop', team: 'Team 1', emoji: '🏨' },
  qi_rv: { id: 'QI_RV', label: 'Quality-Inn-Russelville', team: 'Team 1', emoji: '🏨' },
  pros: { id: 'PROS', label: 'Prospero Flagship', team: 'Team 2', emoji: '🏨' }
};

const TEAM_1_HOTEL_KEYS = ['bw_to', 'rmda_sup8', 'gicp', 'ad1', 'trvl', 'dibs', 'qi_rv'];
const TEAM_2_HOTEL_KEYS = ['pros'];

function normalizeTheme(themeKey) {
  const normalized = String(themeKey || '').trim().toLowerCase();
  return TEST_UI_THEMES[normalized] ? normalized : 'aavgo';
}

function normalizeDensity(densityKey) {
  const normalized = String(densityKey || '').trim().toLowerCase();
  return TEST_UI_DENSITIES[normalized] ? normalized : 'cozy';
}

function normalizeVariant(variantKey) {
  const normalized = String(variantKey || '').trim().toLowerCase();
  return normalized === TEST_UI_VARIANTS.active ? TEST_UI_VARIANTS.active : TEST_UI_VARIANTS.idle;
}

function normalizeHotel(hotelKey) {
  const normalized = String(hotelKey || '').trim().toLowerCase();
  return DEMO_HOTELS[normalized] ? normalized : 'bw_to';
}

function normalizeScreen(screenKey) {
  const normalized = String(screenKey || '').trim().toLowerCase();
  if (normalized === 'route') return 'shift_route';
  if (normalized === 'assignment') return 'shift_route';
  if (normalized === 'destination') return 'shift_route';
  if (normalized === 'overview') return 'hotel_status';
  if (normalized === 'status') return 'training_status';
  if (normalized === 'login') return 'training_started';
  if (normalized === 'approval') return 'newcomer';
  if (normalized === 'alert') return 'hotel_status';
  return TEST_UI_SCREENS[normalized] ? normalized : 'hotel_status';
}

function buildState({
  screenKey = 'hotel_status',
  themeKey = 'aavgo',
  densityKey = 'cozy',
  hotelKey = 'bw_to',
  variantKey = TEST_UI_VARIANTS.idle
} = {}) {
  return {
    screenKey: normalizeScreen(screenKey),
    themeKey: normalizeTheme(themeKey),
    densityKey: normalizeDensity(densityKey),
    hotelKey: normalizeHotel(hotelKey),
    variantKey: normalizeVariant(variantKey)
  };
}

function getNextTheme(themeKey) {
  const keys = Object.keys(TEST_UI_THEMES);
  const currentIndex = Math.max(0, keys.indexOf(normalizeTheme(themeKey)));
  const nextIndex = (currentIndex + 1) % keys.length;
  return keys[nextIndex] || 'aavgo';
}

function randomState() {
  const screenKeys = Object.keys(TEST_UI_SCREENS);
  const themeKeys = Object.keys(TEST_UI_THEMES);
  const densityKeys = Object.keys(TEST_UI_DENSITIES);
  const hotelKeys = Object.keys(DEMO_HOTELS);
  return buildState({
    screenKey: screenKeys[Math.floor(Math.random() * screenKeys.length)],
    themeKey: themeKeys[Math.floor(Math.random() * themeKeys.length)],
    densityKey: densityKeys[Math.floor(Math.random() * densityKeys.length)],
    hotelKey: hotelKeys[Math.floor(Math.random() * hotelKeys.length)],
    variantKey: Math.random() >= 0.5 ? TEST_UI_VARIANTS.active : TEST_UI_VARIANTS.idle
  });
}

function getHotelKeysForScope(hotelKey) {
  const selectedHotel = DEMO_HOTELS[normalizeHotel(hotelKey)] || DEMO_HOTELS.bw_to;
  if (selectedHotel.team === 'Team 2') return TEAM_2_HOTEL_KEYS;
  return TEAM_1_HOTEL_KEYS;
}

function getScopedTeamLabel(hotelKey) {
  const selectedHotel = DEMO_HOTELS[normalizeHotel(hotelKey)] || DEMO_HOTELS.bw_to;
  return selectedHotel.team;
}

function getDisplayTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function compactLine(prefix, value, densityKey) {
  if (densityKey === 'compact') return `${prefix}:${value}`;
  return `${prefix}: ${value}`;
}

function railBlock(lines) {
  return lines.map(line => `> ${line}`).join('\n');
}

function buildHotelStatusEmbed(state, interaction) {
  const scopeHotelKeys = getHotelKeysForScope(state.hotelKey);
  const teamLabel = getScopedTeamLabel(state.hotelKey);
  const isActive = state.variantKey === TEST_UI_VARIANTS.active;
  const activeHotelKey = scopeHotelKeys.includes(state.hotelKey) ? state.hotelKey : scopeHotelKeys[0];
  const activeCount = isActive ? 1 : 0;

  const hotelLines = scopeHotelKeys.map(hotelKey => {
    const hotel = DEMO_HOTELS[hotelKey];
    const activityLine = isActive && hotelKey === activeHotelKey
      ? `• <@${interaction.user.id}> | on shift now`
      : '• No active agent';
    return `${hotel.emoji} **${hotel.label}**\n${activityLine}`;
  }).join('\n\n');

  const heading = isActive ? '🟢 ACTIVE HOTEL LOGINS' : '⚠️ NO ACTIVE HOTEL LOGINS';
  const statsBlock = railBlock([
    compactLine('🏨 Hotels Tracked', String(scopeHotelKeys.length), state.densityKey),
    compactLine('👥 Active Hotel Sessions', String(activeCount), state.densityKey),
    compactLine('📍 Scope', `All ${teamLabel} hotel boards in one view`, state.densityKey)
  ]);

  const body = [
    `### ${heading}`,
    DIVIDER,
    statsBlock,
    DIVIDER,
    hotelLines
  ].join('\n');

  return new EmbedBuilder()
    .setTitle('🏨 Aavgo Operations · Hotel Status')
    .setDescription(body)
    .setColor(isActive ? 0x57F287 : 0xF1C40F)
    .setFooter({ text: `Aavgo Operations • Consolidated Hotel Status • ${teamLabel}` })
    .setTimestamp();
}

function buildShiftRouteEmbed(state, interaction) {
  const hotel = DEMO_HOTELS[state.hotelKey] || DEMO_HOTELS.bw_to;
  const teamLabel = hotel.team;
  const isActive = state.variantKey === TEST_UI_VARIANTS.active;
  const theme = TEST_UI_THEMES[state.themeKey] || TEST_UI_THEMES.aavgo;
  const agentLabel = interaction.member?.displayName || interaction.user?.username || 'Unknown Agent';
  const routeHeading = isActive ? '🟢 LIVE ROUTE READY' : '🧭 ROUTE PREVIEW MODE';
  const routeState = isActive
    ? 'Status: Live route is armed for launch.'
    : 'Status: Sandbox preview only (no session changes).';

  const body = [
    `### ${routeHeading}`,
    DIVIDER,
    compactLine('🧩 Team Context', `${teamLabel} Operations`, state.densityKey),
    compactLine('🏨 Selected Destination', hotel.label, state.densityKey),
    compactLine('👤 Preview User', agentLabel, state.densityKey),
    DIVIDER,
    '• Confirm your assigned destination in the dropdown below.',
    '• Live route is treated as permanent until reassigned by leadership.',
    '• Use training route when practicing, not covering live traffic.',
    DIVIDER,
    routeState
  ].join('\n');

  return new EmbedBuilder()
    .setTitle('🗺️ Aavgo Operations · Shift Launch Pad')
    .setDescription(body)
    .addFields(
      { name: 'Route Type', value: isActive ? 'Live · Hotel Shift' : 'Preview · No Login', inline: true },
      { name: 'Team Scope', value: teamLabel, inline: true },
      { name: 'Style Preset', value: theme.label, inline: true }
    )
    .setColor(isActive ? 0x57F287 : theme.color)
    .setFooter({ text: `Aavgo Operations • Shift Route Sandbox • ${hotel.id}` })
    .setTimestamp();
}

function buildTrainingGroups(state) {
  const base = {
    bw_to: [
      { agent: '@Charlyn Quilos', since: '2 hours ago' },
      { agent: '@Rodjon Eamiguel', since: '2 hours ago' }
    ],
    rmda_sup8: [{ agent: '@Testing Bot', since: '6 hours ago' }],
    gicp: [
      { agent: '@Ariane', since: '4 hours ago' },
      { agent: '@Kenzo Bernabe', since: '4 hours ago' }
    ],
    ad1: [{ agent: '@Portia Ebol', since: '21 minutes ago' }],
    trvl: [],
    dibs: [],
    qi_rv: [],
    pros: []
  };

  if (state.variantKey !== TEST_UI_VARIANTS.active) {
    return Object.fromEntries(Object.keys(base).map(key => [key, []]));
  }

  if (state.hotelKey === 'pros') {
    base.pros = [{ agent: '@Portia Ebol', since: '12 minutes ago' }];
  }

  return base;
}

function buildTrainingStatusEmbed(state) {
  const groups = buildTrainingGroups(state);
  const hotelOrder = [...TEAM_1_HOTEL_KEYS, ...TEAM_2_HOTEL_KEYS];
  let activeCount = 0;

  const groupLines = hotelOrder.map(hotelKey => {
    const hotel = DEMO_HOTELS[hotelKey];
    const trainees = groups[hotelKey] || [];
    activeCount += trainees.length;

    const traineeLines = trainees.length > 0
      ? trainees.map(entry => `• ${entry.agent} | Since: ${entry.since}`).join('\n')
      : '• No active trainee';

    return `${hotel.emoji} **${hotel.label}**\n${traineeLines}`;
  }).join('\n\n');

  const statusHeading = activeCount > 0 ? '🟦 TRAINING IN PROGRESS' : '⚫ TRAINING BOARD IDLE';
  const body = [
    `### ${statusHeading}`,
    DIVIDER,
    compactLine('🤖 Board', 'Live training presence tracker', state.densityKey),
    compactLine('👥 Active Trainees', String(activeCount), state.densityKey),
    compactLine('📍 Scope', 'Team 1 and Team 2 training groups', state.densityKey),
    DIVIDER,
    groupLines
  ].join('\n');

  return new EmbedBuilder()
    .setTitle('🧪 Aavgo Operations · Training Status')
    .setDescription(body)
    .setColor(activeCount > 0 ? 0x5865F2 : 0x2B2D31)
    .setFooter({ text: 'Aavgo Operations • Training Presence' })
    .setTimestamp();
}

function buildTrainingStartedEmbed(state, interaction) {
  const hotel = DEMO_HOTELS[state.hotelKey] || DEMO_HOTELS.bw_to;
  const agentLabel = interaction.member?.displayName || interaction.user?.username || 'Unknown Agent';
  const timeLabel = getDisplayTimestamp();

  return new EmbedBuilder()
    .setTitle('🧭 Training Started')
    .setDescription(`User: ${agentLabel} (<@${interaction.user.id}>) | Practice For: ${hotel.id === 'RMDA' ? 'Ramada / Super 8' : hotel.id} | Time: ${timeLabel}`)
    .addFields(
      { name: 'User', value: `${agentLabel} (<@${interaction.user.id}>)`, inline: true },
      { name: 'Practice For', value: hotel.id === 'RMDA' ? 'Ramada / Super 8' : hotel.id, inline: true },
      { name: 'Time', value: timeLabel, inline: true }
    )
    .setColor(0x57F287)
    .setFooter({ text: `🛡️ Aavgo Audit System • ${agentLabel}` })
    .setTimestamp();
}

function buildNewcomerEmbed(interaction) {
  const username = `newcomer_${interaction.user.username.slice(0, 10)}`;
  const displayName = interaction.member?.displayName || interaction.user?.username || 'Unknown';
  const userId = interaction.user.id;
  const createdAt = getDisplayTimestamp(interaction.user.createdAt || new Date());
  const joinedAt = getDisplayTimestamp(interaction.member?.joinedAt || new Date());
  const avatarUrl = interaction.user?.displayAvatarURL?.({ size: 512, extension: 'png' });

  const embed = new EmbedBuilder()
    .setTitle('👋 Newcomer Joined Aavgo')
    .setDescription(
      `Welcome, ${username}\n\n` +
      'A new member has joined the server and is ready for review.'
    )
    .addFields(
      { name: 'Username', value: username, inline: true },
      { name: 'Display Name', value: displayName, inline: true },
      { name: 'User ID', value: userId, inline: true },
      { name: 'Account Created', value: createdAt, inline: true },
      { name: 'Joined Server', value: joinedAt, inline: true },
      { name: 'Profile Link', value: `[Open Discord Profile](https://discord.com/users/${userId})`, inline: true }
    )
    .setColor(0xF1C40F)
    .setFooter({ text: 'Aavgo Newcomers Channel' })
    .setTimestamp();

  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}

function buildPreviewEmbed(state, interaction) {
  if (state.screenKey === 'shift_route') return buildShiftRouteEmbed(state, interaction);
  if (state.screenKey === 'training_status') return buildTrainingStatusEmbed(state);
  if (state.screenKey === 'training_started') return buildTrainingStartedEmbed(state, interaction);
  if (state.screenKey === 'newcomer') return buildNewcomerEmbed(interaction);
  return buildHotelStatusEmbed(state, interaction);
}

function buildScreenSelect(state) {
  return new StringSelectMenuBuilder()
    .setCustomId(`test_ui_screen_select:${state.themeKey}:${state.densityKey}:${state.hotelKey}:${state.variantKey}`)
    .setPlaceholder('Choose UI preview card')
    .addOptions(
      Object.entries(TEST_UI_SCREENS).map(([key, value]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(value.label)
          .setValue(key)
          .setDefault(key === state.screenKey)
      )
    );
}

function buildHotelSelect(state) {
  return new StringSelectMenuBuilder()
    .setCustomId(`test_ui_hotel_select:${state.screenKey}:${state.themeKey}:${state.densityKey}:${state.variantKey}`)
    .setPlaceholder('Choose reference hotel')
    .addOptions(
      Object.entries(DEMO_HOTELS).map(([key, hotel]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(hotel.label)
          .setValue(key)
          .setDescription(`${hotel.team} • ${hotel.id}`)
          .setDefault(key === state.hotelKey)
      )
    );
}

function buildControlButtons(state) {
  const nextTheme = getNextTheme(state.themeKey);
  const nextDensity = state.densityKey === 'compact' ? 'cozy' : 'compact';
  const nextVariant = state.variantKey === TEST_UI_VARIANTS.active ? TEST_UI_VARIANTS.idle : TEST_UI_VARIANTS.active;
  const variantLabel = state.variantKey === TEST_UI_VARIANTS.active ? 'Show Idle Example' : 'Show Active Example';

  return [
    new ButtonBuilder()
      .setCustomId(`test_ui_theme_cycle:${state.screenKey}:${state.themeKey}:${state.densityKey}:${state.hotelKey}:${state.variantKey}`)
      .setLabel(`Style: ${TEST_UI_THEMES[nextTheme].label}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`test_ui_density_toggle:${state.screenKey}:${state.themeKey}:${state.densityKey}:${state.hotelKey}:${state.variantKey}`)
      .setLabel(`Spacing: ${TEST_UI_DENSITIES[nextDensity].label}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`test_ui_variant_toggle:${state.screenKey}:${state.themeKey}:${state.densityKey}:${state.hotelKey}:${state.variantKey}`)
      .setLabel(variantLabel)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('test_ui_shuffle')
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('test_ui_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
  ];
}

function buildPayload(state, interaction) {
  const normalized = buildState(state);
  const embed = buildPreviewEmbed(normalized, interaction);
  const rows = [
    new ActionRowBuilder().addComponents(buildScreenSelect(normalized)),
    new ActionRowBuilder().addComponents(buildHotelSelect(normalized))
  ];

  if (normalized.screenKey === 'training_status') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`test_ui_noop_end_training:${normalized.screenKey}:${normalized.themeKey}:${normalized.densityKey}:${normalized.hotelKey}:${normalized.variantKey}`)
          .setLabel('🔴 End-training')
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  if (normalized.screenKey === 'shift_route') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`test_ui_noop_initialize_shift:${normalized.screenKey}:${normalized.themeKey}:${normalized.densityKey}:${normalized.hotelKey}:${normalized.variantKey}`)
          .setLabel('Initialize Shift')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`test_ui_noop_open_training:${normalized.screenKey}:${normalized.themeKey}:${normalized.densityKey}:${normalized.hotelKey}:${normalized.variantKey}`)
          .setLabel('Open Training Route')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  rows.push(new ActionRowBuilder().addComponents(...buildControlButtons(normalized)));

  const content = normalized.screenKey === 'newcomer' ? '@Operations Manager (preview)' : null;
  return {
    content,
    embeds: [embed],
    components: rows,
    allowedMentions: { parse: [] }
  };
}

function buildClosedPayload() {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('✅ Test GUI Closed')
        .setDescription('Run `/test-gui` to open the preview again.')
        .setColor(0x6B7280)
    ],
    components: []
  };
}

function buildFailurePayload(message) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('⚠️ Test GUI Error')
        .setDescription(`${message}\n\nRun \`/test-gui\` to retry.`)
        .setColor(0xEF4444)
    ],
    components: []
  };
}

function createTestUiHandlers(deps) {
  const {
    isDeveloper,
    safeDeferComponentUpdate,
    sendComponentUpdate,
    sendComponentReply
  } = deps || {};

  if (typeof isDeveloper !== 'function') throw new Error('createTestUiHandlers requires isDeveloper');
  if (typeof safeDeferComponentUpdate !== 'function') throw new Error('createTestUiHandlers requires safeDeferComponentUpdate');
  if (typeof sendComponentUpdate !== 'function') throw new Error('createTestUiHandlers requires sendComponentUpdate');
  if (typeof sendComponentReply !== 'function') throw new Error('createTestUiHandlers requires sendComponentReply');

  async function handleTestUiCommand(interaction) {
    try {
      if (!isDeveloper(interaction)) {
        return interaction.reply({ content: 'Access denied: Developer or Operations Manager required.', ephemeral: true });
      }

      const state = buildState({
        themeKey: interaction.options?.getString('theme'),
        screenKey: interaction.options?.getString('screen'),
        densityKey: interaction.options?.getString('density'),
        hotelKey: 'pros',
        variantKey: TEST_UI_VARIANTS.idle
      });

      interaction.__aavgoEphemeral = true;
      return interaction.reply({
        ...buildPayload(state, interaction),
        flags: EPHEMERAL_FLAGS
      });
    } catch (error) {
      console.error('Error in handleTestUiCommand:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(buildFailurePayload('Failed to open /test-gui preview.')).catch(() => {});
      } else {
        await interaction.reply({ content: 'Failed to open /test-gui preview.', ephemeral: true }).catch(() => {});
      }
    }
  }

  async function handleTestUiButton(interaction) {
    try {
      if (!isDeveloper(interaction)) {
        return interaction.reply({ content: 'Access denied: Developer or Operations Manager required.', ephemeral: true });
      }

      await safeDeferComponentUpdate(interaction);
      const customId = String(interaction.customId || '');

      if (customId === 'test_ui_close') {
        return sendComponentUpdate(interaction, buildClosedPayload());
      }

      if (customId === 'test_ui_shuffle' || customId.startsWith('test_ui_shuffle:')) {
        return sendComponentUpdate(interaction, buildPayload(randomState(), interaction));
      }

      if (customId.startsWith('test_ui_theme_cycle:')) {
        const [, screenKey, themeKey, densityKey, hotelKey, variantKey] = customId.split(':');
        const nextTheme = getNextTheme(themeKey);
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey,
          themeKey: nextTheme,
          densityKey,
          hotelKey,
          variantKey
        }), interaction));
      }

      if (customId.startsWith('test_ui_density_toggle:')) {
        const [, screenKey, themeKey, densityKey, hotelKey, variantKey] = customId.split(':');
        const nextDensity = normalizeDensity(densityKey) === 'compact' ? 'cozy' : 'compact';
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey,
          themeKey,
          densityKey: nextDensity,
          hotelKey,
          variantKey
        }), interaction));
      }

      if (customId.startsWith('test_ui_variant_toggle:')) {
        const [, screenKey, themeKey, densityKey, hotelKey, variantKey] = customId.split(':');
        const nextVariant = normalizeVariant(variantKey) === TEST_UI_VARIANTS.active
          ? TEST_UI_VARIANTS.idle
          : TEST_UI_VARIANTS.active;
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey,
          themeKey,
          densityKey,
          hotelKey,
          variantKey: nextVariant
        }), interaction));
      }

      if (customId.startsWith('test_ui_noop_') || customId === 'test_ui_noop') {
        let previewMessage = 'Preview only: This action is disabled in /test-gui.';
        if (customId.startsWith('test_ui_noop_end_training:')) previewMessage = 'Preview only: End-training is disabled in /test-gui.';
        if (customId.startsWith('test_ui_noop_initialize_shift:')) previewMessage = 'Preview only: Initialize Shift is disabled in /test-gui.';
        if (customId.startsWith('test_ui_noop_open_training:')) previewMessage = 'Preview only: Training route launch is disabled in /test-gui.';
        return sendComponentReply(interaction, {
          content: previewMessage,
          ephemeral: true
        });
      }

      // Legacy compatibility from earlier test-ui labs.
      if (customId.startsWith('test_ui_mode_toggle:') || customId.startsWith('test_ui_refresh:')) {
        const parts = customId.split(':');
        const legacyView = parts[1];
        const legacyTheme = parts[2];
        const legacyDensity = parts[3];
        const legacyHotel = parts[4];
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey: legacyView,
          themeKey: legacyTheme,
          densityKey: legacyDensity,
          hotelKey: legacyHotel || 'pros'
        }), interaction));
      }

      if (customId.startsWith('test_ui_tab_overview:')) {
        const legacyTheme = customId.split(':')[1];
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey: 'hotel_status',
          themeKey: legacyTheme,
          densityKey: 'cozy',
          hotelKey: 'pros'
        }), interaction));
      }

      if (customId.startsWith('test_ui_tab_components:')) {
        const legacyTheme = customId.split(':')[1];
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey: 'training_status',
          themeKey: legacyTheme,
          densityKey: 'compact',
          hotelKey: 'pros',
          variantKey: TEST_UI_VARIANTS.active
        }), interaction));
      }

      return sendComponentReply(interaction, {
        content: 'Action unavailable (old preview message). Run /test-gui again.',
        ephemeral: true
      });
    } catch (error) {
      if (error?.code === 10062) {
        console.warn('[TEST-UI] Button interaction expired before response (10062).');
        return;
      }
      console.error('Error in handleTestUiButton:', error);
      await sendComponentReply(interaction, {
        content: 'Preview action failed. Run /test-gui again.',
        ephemeral: true
      }).catch(() => {});
    }
  }

  async function handleTestUiSelect(interaction) {
    try {
      if (!isDeveloper(interaction)) {
        return interaction.reply({ content: 'Access denied: Developer or Operations Manager required.', ephemeral: true });
      }

      await safeDeferComponentUpdate(interaction);
      const customId = String(interaction.customId || '');

      if (customId.startsWith('test_ui_screen_select:')) {
        const [, themeKey, densityKey, hotelKey, variantKey] = customId.split(':');
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey: interaction.values?.[0],
          themeKey,
          densityKey,
          hotelKey,
          variantKey
        }), interaction));
      }

      if (customId.startsWith('test_ui_hotel_select:')) {
        const [, screenKey, themeKey, densityKey, variantKey] = customId.split(':');
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey,
          themeKey,
          densityKey,
          hotelKey: interaction.values?.[0],
          variantKey
        }), interaction));
      }

      // Legacy compatibility from earlier test-ui labs.
      if (customId.startsWith('test_ui_theme_select:')) {
        const [, legacyView, legacyDensity, legacyHotel] = customId.split(':');
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey: legacyView,
          themeKey: interaction.values?.[0],
          densityKey: legacyDensity,
          hotelKey: legacyHotel || 'pros'
        }), interaction));
      }

      if (customId.startsWith('test_ui_view_select:')) {
        const [, legacyTheme, legacyDensity, legacyHotel] = customId.split(':');
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey: interaction.values?.[0],
          themeKey: legacyTheme,
          densityKey: legacyDensity,
          hotelKey: legacyHotel || 'pros'
        }), interaction));
      }

      if (customId.startsWith('test_ui_demo_hotel_select:')) {
        const [, legacyView, legacyTheme, legacyDensity] = customId.split(':');
        return sendComponentUpdate(interaction, buildPayload(buildState({
          screenKey: legacyView,
          themeKey: legacyTheme,
          densityKey: legacyDensity,
          hotelKey: interaction.values?.[0]
        }), interaction));
      }

      return sendComponentReply(interaction, {
        content: 'Selection unavailable (old preview message). Run /test-gui again.',
        ephemeral: true
      });
    } catch (error) {
      if (error?.code === 10062) {
        console.warn('[TEST-UI] Select interaction expired before response (10062).');
        return;
      }
      console.error('Error in handleTestUiSelect:', error);
      await sendComponentReply(interaction, {
        content: 'Selection failed. Run /test-gui again.',
        ephemeral: true
      }).catch(() => {});
    }
  }

  async function handleTestUiThemeSelect(interaction) {
    return handleTestUiSelect(interaction);
  }

  return {
    handleTestUiCommand,
    handleTestUiButton,
    handleTestUiSelect,
    handleTestUiThemeSelect
  };
}

module.exports = {
  createTestUiHandlers
};
