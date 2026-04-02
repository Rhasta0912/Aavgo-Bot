const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder
} = require('discord.js');

const COMPONENTS_V2_FLAGS = MessageFlags.IsComponentsV2;
const EPHEMERAL_COMPONENTS_V2_FLAGS = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;

const TEST_UI_THEMES = {
  aavgo: {
    label: 'Aavgo Ops Amber',
    shortDescription: 'Warm operations dashboard look',
    mood: 'Reliable and grounded',
    color: 0xF1C40F,
    surface: '#1F2937',
    accent: '#F1C40F',
    text: '#F9FAFB',
    muted: '#9CA3AF',
    radius: '10px',
    iconUrl: 'https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f7e1.png'
  },
  vercel: {
    label: 'Vercel Mono',
    shortDescription: 'Minimal black and white',
    mood: 'Calm and technical',
    color: 0x111111,
    surface: '#0A0A0A',
    accent: '#FFFFFF',
    text: '#FAFAFA',
    muted: '#A3A3A3',
    radius: '8px',
    iconUrl: 'https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/26ab.png'
  },
  stripe: {
    label: 'Stripe Gradient',
    shortDescription: 'Bright and polished fintech',
    mood: 'Confident and modern',
    color: 0x635BFF,
    surface: '#1B1642',
    accent: '#635BFF',
    text: '#E7E9FF',
    muted: '#B8BEEA',
    radius: '12px',
    iconUrl: 'https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f535.png'
  },
  notion: {
    label: 'Notion Warm',
    shortDescription: 'Soft paper-like neutral',
    mood: 'Readable and gentle',
    color: 0x2F3437,
    surface: '#F7F6F3',
    accent: '#2F3437',
    text: '#191919',
    muted: '#6B6F76',
    radius: '6px',
    iconUrl: 'https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/26aa.png'
  }
};

const TEST_UI_PROFILE = {
  audience: 'Beginner-first staff flow',
  styleBlend: 'Ops Warm + Clean Minimal',
  spacing: 'Cozy default spacing',
  language: 'Plain + short labels',
  states: 'Strong color-coded status cues',
  icons: 'Moderate icon usage',
  flow: 'Single-card interaction (replace, do not stack)',
  confirms: 'Confirm important + destructive actions',
  errors: 'Short cause + clear retry'
};

const TEST_UI_VIEWS = {
  overview: {
    label: 'Overview',
    pickerHint: 'Command hub and first impression',
    summary: 'High-level test of spacing, copy clarity, and action hierarchy.',
    goal: 'Help a new user identify the right entry point in under 5 seconds.',
    primaryAction: 'Initialize Shift',
    secondaryAction: 'Open Profiles',
    beginnerCopy: 'Choose Live -> Hotel Shift for real work, or Practice -> Training if you are still learning.',
    previewLines: [
      'Header: Shift Control Center',
      'Card: Active Agents, Pending Alerts, Coverage',
      'Actions: Initialize Shift | Check Hours | End Shift'
    ]
  },
  login: {
    label: 'Login Portal',
    pickerHint: 'PIN-first setup and route picker',
    summary: 'Tests the PIN-first flow card and role-aware routing language.',
    goal: 'Prevent wrong-route clicks while keeping language beginner-friendly.',
    primaryAction: 'Continue with PIN',
    secondaryAction: 'Need Help',
    beginnerCopy: 'Start by confirming your PIN, then choose the path that matches your current role.',
    previewLines: [
      'Step 1: Verify PIN',
      'Step 2: Pick Route (Agent / Team Leader / SME)',
      'Step 3: Choose Live -> Hotel Shift or Practice -> Training'
    ]
  },
  status: {
    label: 'Live Status',
    pickerHint: 'On-shift board and health signals',
    summary: 'Tests readability for active coverage boards and activity strips.',
    goal: 'Let management scan who is online/offline without opening profiles.',
    primaryAction: 'Refresh Status',
    secondaryAction: 'Open Shift Card',
    beginnerCopy: 'Green means active, yellow means caution, red means needs attention now.',
    previewLines: [
      'Board: Team 1 / Team 2 / Training',
      'Rows: Agent Name, Hotel, Last Activity, State',
      'Controls: Refresh | Filter Team | View Details'
    ]
  },
  approval: {
    label: 'Approval Flow',
    pickerHint: 'Promotion and admin confirmation cards',
    summary: 'Tests action clarity for approve/deny requests with audit context.',
    goal: 'Make approval decisions obvious and reduce accidental clicks.',
    primaryAction: 'Approve Request',
    secondaryAction: 'Deny Request',
    beginnerCopy: 'Review who requested it, what role is requested, and why, then approve or deny.',
    previewLines: [
      'Request: Promote User -> Operations Manager',
      'Required: 1 Developer + 1 Operations Manager',
      'Actions: Approve | Deny | View Reason'
    ]
  },
  alert: {
    label: 'Alert States',
    pickerHint: 'Warnings, failures, and recovery cues',
    summary: 'Tests how warning/error cards feel during incidents and timeouts.',
    goal: 'Show what happened, what to do next, and who to contact.',
    primaryAction: 'Retry Step',
    secondaryAction: 'Escalate',
    beginnerCopy: 'If this keeps happening, contact a Developer or Operations Manager with the timestamp.',
    previewLines: [
      'Warning: Slow response detected',
      'Error: Interaction expired (safe retry offered)',
      'Recovery: Retry | Open Status | Contact Staff'
    ]
  }
};

const TEST_UI_DENSITIES = {
  cozy: {
    label: 'Cozy',
    summary: 'More breathing room for newer users.',
    spacing: '16-20px blocks, larger labels'
  },
  compact: {
    label: 'Compact',
    summary: 'Denser layout for experienced staff.',
    spacing: '8-12px blocks, shorter labels'
  }
};

function normalizeTestUiTheme(themeKey) {
  const key = String(themeKey || '').trim().toLowerCase();
  if (TEST_UI_THEMES[key]) return key;
  return 'aavgo';
}

function normalizeTestUiView(view) {
  const normalized = String(view || '').trim().toLowerCase();
  if (normalized === 'components') return 'status'; // legacy mapping
  if (TEST_UI_VIEWS[normalized]) return normalized;
  return 'overview';
}

function normalizeTestUiDensity(density) {
  const normalized = String(density || '').trim().toLowerCase();
  if (TEST_UI_DENSITIES[normalized]) return normalized;
  return 'cozy';
}

function pickRandomTestUiState() {
  const themes = Object.keys(TEST_UI_THEMES);
  const views = Object.keys(TEST_UI_VIEWS);
  const densities = Object.keys(TEST_UI_DENSITIES);
  return {
    themeKey: themes[Math.floor(Math.random() * themes.length)] || 'aavgo',
    viewKey: views[Math.floor(Math.random() * views.length)] || 'overview',
    densityKey: densities[Math.floor(Math.random() * densities.length)] || 'cozy'
  };
}

function buildTestUiPreviewText(viewKey, densityKey) {
  const view = TEST_UI_VIEWS[viewKey] || TEST_UI_VIEWS.overview;
  const density = TEST_UI_DENSITIES[densityKey] || TEST_UI_DENSITIES.cozy;
  const lines = Array.isArray(view.previewLines) ? view.previewLines : [];
  const formattedLines = lines.length ? lines.map(line => `- ${line}`).join('\n') : '- Preview unavailable';
  return `${formattedLines}\n- Density Profile: ${density.label} (${density.spacing})`;
}

function buildStateLegend(viewKey) {
  if (viewKey === 'alert') {
    return [
      '🟢 Recovery Ready: Safe retry is available',
      '🟡 Watch: Slow response or missing step',
      '🔴 Action Needed: Interaction expired, restart flow'
    ].join('\n');
  }

  if (viewKey === 'approval') {
    return [
      '🟢 Approved: Request passed required checks',
      '🟡 Pending: Waiting for dual approval',
      '🔴 Blocked: Requirement or policy failed'
    ].join('\n');
  }

  return [
    '🟢 Good: User can move forward now',
    '🟡 Caution: Review before continuing',
    '🔴 Action Needed: Retry or escalate'
  ].join('\n');
}

function buildTextDisplay(content) {
  return new TextDisplayBuilder().setContent(content);
}

function buildSoftSeparator(spacing = SeparatorSpacingSize.Large) {
  return new SeparatorBuilder()
    .setDivider(false)
    .setSpacing(spacing);
}

function buildThemeSelect(themeKey, viewKey, densityKey) {
  return new StringSelectMenuBuilder()
    .setCustomId(`test_ui_theme_select:${viewKey}:${densityKey}`)
    .setPlaceholder('Choose style preset')
    .addOptions(
      Object.entries(TEST_UI_THEMES).map(([key, theme]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(theme.label)
          .setValue(key)
          .setDescription(theme.shortDescription)
          .setDefault(key === themeKey)
      )
    );
}

function buildViewSelect(themeKey, viewKey, densityKey) {
  return new StringSelectMenuBuilder()
    .setCustomId(`test_ui_view_select:${themeKey}:${densityKey}`)
    .setPlaceholder('Choose screen preview')
    .addOptions(
      Object.entries(TEST_UI_VIEWS).map(([key, view]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(view.label)
          .setValue(key)
          .setDescription(view.pickerHint)
          .setDefault(key === viewKey)
      )
    );
}

function buildControlButtons(viewKey, themeKey, densityKey) {
  const densityLabel = TEST_UI_DENSITIES[densityKey]?.label || 'Cozy';
  return [
    new ButtonBuilder()
      .setCustomId(`test_ui_density_toggle:${viewKey}:${themeKey}:${densityKey}`)
      .setLabel(`Spacing: ${densityLabel}`)
      .setStyle(densityKey === 'compact' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('test_ui_shuffle')
      .setLabel('Try Another')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`test_ui_refresh:${viewKey}:${themeKey}:${densityKey}`)
      .setLabel('Retry Render')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('test_ui_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
  ];
}

function buildTestUiContainer(themeKey, viewKey, densityKey) {
  const theme = TEST_UI_THEMES[themeKey] || TEST_UI_THEMES.aavgo;
  const view = TEST_UI_VIEWS[viewKey] || TEST_UI_VIEWS.overview;
  const density = TEST_UI_DENSITIES[densityKey] || TEST_UI_DENSITIES.cozy;

  const profileSection = new SectionBuilder()
    .addTextDisplayComponents(
      buildTextDisplay(
        `### 🧭 UI Profile\n` +
        `- Audience: ${TEST_UI_PROFILE.audience}\n` +
        `- Style: ${TEST_UI_PROFILE.styleBlend}\n` +
        `- Flow: ${TEST_UI_PROFILE.flow}\n` +
        `- Errors: ${TEST_UI_PROFILE.errors}`
      )
    );

  if (theme.iconUrl) {
    profileSection.setThumbnailAccessory(
      new ThumbnailBuilder().setURL(theme.iconUrl)
    );
  }

  const container = new ContainerBuilder()
    .setAccentColor(theme.color)
    .addTextDisplayComponents(
      buildTextDisplay(
        `## 🎛️ Test GUI • ${view.label}\n` +
        `${view.summary}\n` +
        `Using Components V2 containers + transparent separators.`
      )
    )
    .addSeparatorComponents(buildSoftSeparator())
    .addSectionComponents(profileSection)
    .addSeparatorComponents(buildSoftSeparator())
    .addTextDisplayComponents(
      buildTextDisplay(
        `### 🎨 Style Preset\n` +
        `- Preset: ${theme.label}\n` +
        `- Mood: ${theme.mood}\n` +
        `- Feel: ${theme.shortDescription}\n` +
        `- Surface: ${theme.surface}\n` +
        `- Accent: ${theme.accent}\n` +
        `- Text: ${theme.text}\n` +
        `- Muted: ${theme.muted}`
      )
    )
    .addSeparatorComponents(buildSoftSeparator())
    .addTextDisplayComponents(
      buildTextDisplay(
        `### 📐 Layout Rules\n` +
        `- Spacing: ${density.label} (${density.spacing})\n` +
        `- Language: ${TEST_UI_PROFILE.language}\n` +
        `- Icons: ${TEST_UI_PROFILE.icons}\n` +
        `- Radius: ${theme.radius}\n` +
        `- Confirm Style: ${TEST_UI_PROFILE.confirms}`
      )
    )
    .addSeparatorComponents(buildSoftSeparator())
    .addTextDisplayComponents(
      buildTextDisplay(
        `### 🗂 Screen Goal\n` +
        `${view.goal}\n\n` +
        `Primary: ${view.primaryAction}\n` +
        `Secondary: ${view.secondaryAction}\n\n` +
        `### 🧪 Preview\n` +
        `${buildTestUiPreviewText(viewKey, densityKey)}`
      )
    )
    .addSeparatorComponents(buildSoftSeparator())
    .addTextDisplayComponents(
      buildTextDisplay(
        `### 🗣 Copy Check\n` +
        `"${view.beginnerCopy}"\n\n` +
        `### 🚦 State Colors\n` +
        `${buildStateLegend(viewKey)}`
      )
    )
    .addSeparatorComponents(buildSoftSeparator())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(buildThemeSelect(themeKey, viewKey, densityKey))
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(buildViewSelect(themeKey, viewKey, densityKey))
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(...buildControlButtons(viewKey, themeKey, densityKey))
    );

  return container;
}

function buildTestUiPayload(themeKey = 'aavgo', viewKey = 'overview', densityKey = 'cozy') {
  const normalizedTheme = normalizeTestUiTheme(themeKey);
  const normalizedView = normalizeTestUiView(viewKey);
  const normalizedDensity = normalizeTestUiDensity(densityKey);

  return {
    flags: COMPONENTS_V2_FLAGS,
    components: [buildTestUiContainer(normalizedTheme, normalizedView, normalizedDensity)]
  };
}

function buildClosedPayload() {
  const container = new ContainerBuilder()
    .setAccentColor(0x6B7280)
    .addTextDisplayComponents(
      buildTextDisplay(
        '## ✅ Test GUI Closed\n' +
        'Panel closed successfully.\n\n' +
        'Run `/test-gui` again to reopen.'
      )
    );

  return {
    flags: COMPONENTS_V2_FLAGS,
    components: [container]
  };
}

function buildFailurePayload(message) {
  const container = new ContainerBuilder()
    .setAccentColor(0xEF4444)
    .addTextDisplayComponents(
      buildTextDisplay(
        `## ⚠️ Test GUI Error\n` +
        `${message}\n\n` +
        'Retry `/test-gui`.'
      )
    );

  return {
    flags: COMPONENTS_V2_FLAGS,
    components: [container]
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

      const themeOption = normalizeTestUiTheme(interaction.options?.getString('theme'));
      const viewOption = normalizeTestUiView(interaction.options?.getString('screen'));
      const densityOption = normalizeTestUiDensity(interaction.options?.getString('density'));

      interaction.__aavgoEphemeral = true;
      return interaction.reply({
        ...buildTestUiPayload(themeOption, viewOption, densityOption),
        flags: EPHEMERAL_COMPONENTS_V2_FLAGS
      });
    } catch (error) {
      console.error('Error in handleTestUiCommand:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(buildFailurePayload('Failed to open UI test lab.')).catch(() => {});
      } else {
        await interaction.reply({ content: 'Failed to open UI test lab. Retry /test-gui.', ephemeral: true }).catch(() => {});
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

      if (customId === 'test_ui_shuffle') {
        const randomState = pickRandomTestUiState();
        return sendComponentUpdate(interaction, buildTestUiPayload(randomState.themeKey, randomState.viewKey, randomState.densityKey));
      }

      if (customId.startsWith('test_ui_density_toggle:')) {
        const [, viewRaw, themeRaw, densityRaw] = customId.split(':');
        const nextDensity = normalizeTestUiDensity(densityRaw) === 'compact' ? 'cozy' : 'compact';
        return sendComponentUpdate(
          interaction,
          buildTestUiPayload(normalizeTestUiTheme(themeRaw), normalizeTestUiView(viewRaw), nextDensity)
        );
      }

      if (customId.startsWith('test_ui_refresh:')) {
        const [, viewRaw, themeRaw, densityRaw] = customId.split(':');
        return sendComponentUpdate(
          interaction,
          buildTestUiPayload(normalizeTestUiTheme(themeRaw), normalizeTestUiView(viewRaw), normalizeTestUiDensity(densityRaw))
        );
      }

      if (customId.startsWith('test_ui_tab_overview:')) {
        const themeKey = normalizeTestUiTheme(customId.split(':')[1]);
        return sendComponentUpdate(interaction, buildTestUiPayload(themeKey, 'overview', 'cozy'));
      }

      if (customId.startsWith('test_ui_tab_components:')) {
        const themeKey = normalizeTestUiTheme(customId.split(':')[1]);
        return sendComponentUpdate(interaction, buildTestUiPayload(themeKey, 'status', 'compact'));
      }

      return sendComponentReply(interaction, {
        content: 'Action unavailable (old panel). Retry: run /test-gui.',
        ephemeral: true
      });
    } catch (error) {
      if (error?.code === 10062) {
        console.warn('[TEST-UI] Button interaction expired before response (10062).');
        return;
      }
      console.error('Error in handleTestUiButton:', error);
      await sendComponentReply(interaction, {
        content: 'Action failed: panel changed or timed out. Retry /test-gui.',
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

      if (customId.startsWith('test_ui_theme_select:')) {
        const [, viewRaw, densityRaw] = customId.split(':');
        const selectedTheme = normalizeTestUiTheme(interaction.values?.[0]);
        return sendComponentUpdate(
          interaction,
          buildTestUiPayload(selectedTheme, normalizeTestUiView(viewRaw), normalizeTestUiDensity(densityRaw))
        );
      }

      if (customId.startsWith('test_ui_view_select:')) {
        const [, themeRaw, densityRaw] = customId.split(':');
        const selectedView = normalizeTestUiView(interaction.values?.[0]);
        return sendComponentUpdate(
          interaction,
          buildTestUiPayload(normalizeTestUiTheme(themeRaw), selectedView, normalizeTestUiDensity(densityRaw))
        );
      }

      return sendComponentReply(interaction, {
        content: 'Selection unavailable (old panel). Retry: run /test-gui.',
        ephemeral: true
      });
    } catch (error) {
      if (error?.code === 10062) {
        console.warn('[TEST-UI] Select interaction expired before response (10062).');
        return;
      }
      console.error('Error in handleTestUiSelect:', error);
      await sendComponentReply(interaction, {
        content: 'Selection failed: panel changed or timed out. Retry /test-gui.',
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
