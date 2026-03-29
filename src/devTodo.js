const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const db = require('./database');

const DEV_TODO_CHANNEL_ID = '1483404968684818483';
const DEV_TODO_MESSAGE_KEY = 'dev_todo_board_message_id';
const DEV_TODO_COMPLETED_SCOPE_KEY = 'dev_todo_completed_scope';

const STATUS_META = {
  backlog: { title: 'Backlog' },
  in_progress: { title: 'In Progress' },
  blocked: { title: 'Blocked' },
  ready_deploy: { title: 'Ready to Deploy' },
  done: { title: 'Done' }
};

const COMPLETED_SCOPE_META = {
  today: {
    label: 'Today',
    description: 'Completed entries since midnight'
  },
  week: {
    label: 'This Week',
    description: 'Completed entries since Monday'
  },
  all: {
    label: 'All Time',
    description: 'All completed entries'
  }
};

const STATUS_CHOICES = Object.keys(STATUS_META);
const COMPLETED_SCOPE_CHOICES = Object.keys(COMPLETED_SCOPE_META);
const DEFAULT_COMPLETED_SCOPE = 'today';
const DEV_ID_FALLBACK = new Set(['320128931971727360', '1186978205018632242']);

db.exec(`
  CREATE TABLE IF NOT EXISTS dev_todo_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'backlog',
    owner_discord_id TEXT,
    owner_name TEXT,
    eta_text TEXT,
    risk_text TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT,
    updated_at DATETIME,
    completed_by TEXT,
    completed_at DATETIME
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS dev_todo_completed_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    task_code TEXT,
    title TEXT NOT NULL,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    actor_discord_id TEXT,
    actor_name TEXT,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_dev_todo_completed_entries_completed_at
  ON dev_todo_completed_entries (completed_at DESC);
`);

function getConfigValue(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row?.value || null;
}

function setConfigValue(key, value) {
  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function getBoardMessageId() {
  return getConfigValue(DEV_TODO_MESSAGE_KEY);
}

function setBoardMessageId(messageId) {
  setConfigValue(DEV_TODO_MESSAGE_KEY, String(messageId));
}

function normalizeCompletedScope(scope) {
  if (!scope || !COMPLETED_SCOPE_META[scope]) return DEFAULT_COMPLETED_SCOPE;
  return scope;
}

function getCompletedScope() {
  return normalizeCompletedScope(getConfigValue(DEV_TODO_COMPLETED_SCOPE_KEY));
}

function setCompletedScope(scope) {
  setConfigValue(DEV_TODO_COMPLETED_SCOPE_KEY, normalizeCompletedScope(scope));
}

function getTaskCode(taskId) {
  return `DEV-${String(taskId).padStart(3, '0')}`;
}

function parseTaskCode(input) {
  const text = String(input || '').trim();
  const match = text.match(/^DEV-(\d+)$/i) || text.match(/^(\d+)$/);
  if (!match) return null;
  return Number(match[1]);
}

function clip(text, max = 90) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function getOwnerLabel(task) {
  if (task.owner_discord_id) return `<@${task.owner_discord_id}>`;
  if (task.owner_name) return task.owner_name;
  return 'Unassigned';
}

function getActorNameFromInteraction(interaction) {
  return interaction.member?.displayName || interaction.user?.username || 'Unknown';
}

function getAllTasks() {
  return db.prepare(`
    SELECT *
    FROM dev_todo_tasks
    ORDER BY
      CASE status
        WHEN 'blocked' THEN 0
        WHEN 'in_progress' THEN 1
        WHEN 'ready_deploy' THEN 2
        WHEN 'backlog' THEN 3
        WHEN 'done' THEN 4
        ELSE 5
      END,
      id ASC
  `).all();
}

function getCompletedScopeWindowStart(scope) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (scope === 'week') {
    const day = start.getDay();
    const diffToMonday = (day + 6) % 7;
    start.setDate(start.getDate() - diffToMonday);
  }

  return start.toISOString();
}

function buildCompletedScopeQuery(scope) {
  const normalizedScope = normalizeCompletedScope(scope);
  if (normalizedScope === 'all') {
    return {
      whereSql: '1 = 1',
      params: []
    };
  }

  return {
    whereSql: 'datetime(completed_at) >= datetime(?)',
    params: [getCompletedScopeWindowStart(normalizedScope)]
  };
}

function getCompletedEntries(scope, limit = 8) {
  const { whereSql, params } = buildCompletedScopeQuery(scope);
  return db.prepare(`
    SELECT
      id,
      task_id,
      task_code,
      title,
      note,
      source,
      actor_discord_id,
      actor_name,
      completed_at
    FROM dev_todo_completed_entries
    WHERE ${whereSql}
    ORDER BY datetime(completed_at) DESC, id DESC
    LIMIT ?
  `).all(...params, Number(limit));
}

function getCompletedCount(scope) {
  const { whereSql, params } = buildCompletedScopeQuery(scope);
  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM dev_todo_completed_entries
    WHERE ${whereSql}
  `).get(...params);
  return Number(row?.total || 0);
}

function toDiscordRelativeTimestamp(timestampValue) {
  if (!timestampValue) return null;
  const raw = String(timestampValue).trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

function formatTaskLine(task) {
  const code = getTaskCode(task.id);
  const eta = task.eta_text ? ` | ETA: ${clip(task.eta_text, 24)}` : '';
  return `- \`${code}\` ${clip(task.title, 56)} | ${getOwnerLabel(task)}${eta}`;
}

function formatCompletedLine(entry) {
  const sourceLabel = entry.source === 'task' ? 'Task' : 'Manual';
  const codePrefix = entry.task_code ? `\`${entry.task_code}\` ` : '';
  const actor = entry.actor_discord_id ? `<@${entry.actor_discord_id}>` : clip(entry.actor_name || 'Unknown', 28);
  const unix = toDiscordRelativeTimestamp(entry.completed_at);
  const when = unix ? `<t:${unix}:R>` : 'Unknown time';
  const note = entry.note ? ` | ${clip(entry.note, 48)}` : '';
  return `- [${sourceLabel}] ${codePrefix}${clip(entry.title, 52)} | ${actor} | ${when}${note}`;
}

function buildBoardEmbeds(tasks, completedScope = getCompletedScope()) {
  const normalizedScope = normalizeCompletedScope(completedScope);
  const scopeMeta = COMPLETED_SCOPE_META[normalizedScope];
  const grouped = {
    backlog: tasks.filter(task => task.status === 'backlog'),
    in_progress: tasks.filter(task => task.status === 'in_progress'),
    blocked: tasks.filter(task => task.status === 'blocked'),
    ready_deploy: tasks.filter(task => task.status === 'ready_deploy'),
    done: tasks.filter(task => task.status === 'done')
  };

  const completedCount = getCompletedCount(normalizedScope);
  const completedEntries = getCompletedEntries(normalizedScope, 8);

  const summaryEmbed = new EmbedBuilder()
    .setTitle('Aavgo Developer Launch Board')
    .setDescription(
      'Shared team board. Any approved developer can add, move, and check off tasks.\n' +
      '--------------------------------\n' +
      `Backlog: **${grouped.backlog.length}**\n` +
      `In Progress: **${grouped.in_progress.length}**\n` +
      `Blocked: **${grouped.blocked.length}**\n` +
      `Ready to Deploy: **${grouped.ready_deploy.length}**\n` +
      `Done (To-Do Status): **${grouped.done.length}**\n` +
      `Completed Log (${scopeMeta.label}): **${completedCount}**`
    )
    .setColor(0x5865F2)
    .setFooter({ text: `Aavgo DevOps | Shared Board | Completed View: ${scopeMeta.label}` })
    .setTimestamp();

  const boardEmbed = new EmbedBuilder()
    .setTitle('Active Developer Tasks')
    .setColor(0x2B2D31)
    .addFields(
      {
        name: STATUS_META.in_progress.title,
        value: grouped.in_progress.length > 0
          ? grouped.in_progress.slice(0, 8).map(formatTaskLine).join('\n')
          : '- No tasks currently in progress.'
      },
      {
        name: STATUS_META.blocked.title,
        value: grouped.blocked.length > 0
          ? grouped.blocked.slice(0, 8).map(formatTaskLine).join('\n')
          : '- No blocked tasks.'
      },
      {
        name: STATUS_META.ready_deploy.title,
        value: grouped.ready_deploy.length > 0
          ? grouped.ready_deploy.slice(0, 8).map(formatTaskLine).join('\n')
          : '- No tasks ready to deploy.'
      },
      {
        name: STATUS_META.backlog.title,
        value: grouped.backlog.length > 0
          ? grouped.backlog.slice(0, 8).map(formatTaskLine).join('\n')
          : '- Backlog is clear.'
      },
      {
        name: `Completed (${scopeMeta.label})`,
        value: completedEntries.length > 0
          ? completedEntries.map(formatCompletedLine).join('\n')
          : '- No completed entries in this range.'
      }
    )
    .setFooter({ text: 'Aavgo DevOps | One Board, Shared Ownership' })
    .setTimestamp();

  return [summaryEmbed, boardEmbed];
}

function buildCompletedScopeMenu(completedScope) {
  const normalizedScope = normalizeCompletedScope(completedScope);
  const options = COMPLETED_SCOPE_CHOICES.map(scope => {
    const meta = COMPLETED_SCOPE_META[scope];
    return new StringSelectMenuOptionBuilder()
      .setLabel(meta.label)
      .setValue(scope)
      .setDescription(meta.description)
      .setDefault(scope === normalizedScope);
  });

  return new StringSelectMenuBuilder()
    .setCustomId('devtodo_completed_scope_select')
    .setPlaceholder(`Completed View: ${COMPLETED_SCOPE_META[normalizedScope].label}`)
    .addOptions(options);
}

function buildBoardComponents(completedScope = getCompletedScope()) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('devtodo_add_btn')
      .setLabel('New Task')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_in_progress')
      .setLabel('In Progress')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_blocked')
      .setLabel('Block')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_done')
      .setLabel('Check Off')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_backlog')
      .setLabel('Reopen')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('devtodo_pick_ready_deploy')
      .setLabel('Ready Deploy')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('devtodo_log_done_btn')
      .setLabel('Log Completed')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('devtodo_clear_done_btn')
      .setLabel('Clear Completed')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('devtodo_refresh_btn')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(buildCompletedScopeMenu(completedScope));
  return [row1, row2, row3];
}

async function resolveBoardChannel(client) {
  const channel = await client.channels.fetch(DEV_TODO_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function upsertBoard(client) {
  const channel = await resolveBoardChannel(client);
  if (!channel) return { ok: false, reason: 'Board channel not found or not text based.' };

  const completedScope = getCompletedScope();
  const tasks = getAllTasks();
  const payload = {
    embeds: buildBoardEmbeds(tasks, completedScope),
    components: buildBoardComponents(completedScope)
  };

  const boardMessageId = getBoardMessageId();
  if (boardMessageId) {
    const existing = await channel.messages.fetch(boardMessageId).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return { ok: true, messageId: existing.id };
    }
  }

  const created = await channel.send(payload);
  setBoardMessageId(created.id);
  return { ok: true, messageId: created.id };
}

function buildMovePicker(status) {
  const tasks = getAllTasks().filter(task => {
    if (status === 'done') return task.status !== 'done';
    if (status === 'backlog') return task.status !== 'backlog';
    return task.status !== status && task.status !== 'done';
  });

  return tasks.slice(0, 25).map(task => ({
    task,
    option: new StringSelectMenuOptionBuilder()
      .setLabel(clip(`${getTaskCode(task.id)} ${task.title}`, 95))
      .setValue(String(task.id))
      .setDescription(clip(`From ${STATUS_META[task.status]?.title || task.status} | Owner ${task.owner_name || 'Unassigned'}`, 90))
  }));
}

function buildAddTaskModal() {
  return new ModalBuilder()
    .setCustomId('devtodo_add_modal')
    .setTitle('Add Developer Task')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('task_title')
          .setLabel('Task title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120)
          .setPlaceholder('Fix interaction timeout in profile flow')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('task_owner')
          .setLabel('Owner (optional mention/id/name)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(60)
          .setPlaceholder('@Cedric or 123456789012345678')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('task_eta')
          .setLabel('ETA (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(40)
          .setPlaceholder('45m or Today 8 PM')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('task_risk')
          .setLabel('Risk / note (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(120)
          .setPlaceholder('Possible conflict with auth modal flow')
      )
    );
}

function buildCompletedLogModal() {
  return new ModalBuilder()
    .setCustomId('devtodo_log_done_modal')
    .setTitle('Log Completed Work')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('completed_title')
          .setLabel('What was completed?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120)
          .setPlaceholder('Updated onboarding copy for hotel link flow')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('completed_note')
          .setLabel('Optional details')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(300)
          .setPlaceholder('No todo was needed; small hotfix completed directly.')
      )
    );
}

function buildClearCompletedPicker() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('devtodo_clear_completed_select')
    .setPlaceholder('Select completed range to clear')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Today')
        .setValue('today')
        .setDescription('Clear completed entries logged today'),
      new StringSelectMenuOptionBuilder()
        .setLabel('This Week')
        .setValue('week')
        .setDescription('Clear completed entries logged this week'),
      new StringSelectMenuOptionBuilder()
        .setLabel('All Time')
        .setValue('all')
        .setDescription('Clear the entire completed log')
    );

  return new ActionRowBuilder().addComponents(menu);
}

async function resolveOwnerInput(input, interaction) {
  const raw = String(input || '').trim();
  if (!raw) {
    return {
      ownerDiscordId: interaction.user.id,
      ownerName: getActorNameFromInteraction(interaction)
    };
  }

  const mentionMatch = raw.match(/^<@!?(\d+)>$/);
  const idMatch = raw.match(/^(\d{15,22})$/);
  const id = mentionMatch?.[1] || idMatch?.[1] || null;
  if (!id) return { ownerDiscordId: null, ownerName: raw };

  const member = interaction.guild ? await interaction.guild.members.fetch(id).catch(() => null) : null;
  return {
    ownerDiscordId: id,
    ownerName: member?.displayName || member?.user?.username || raw
  };
}

async function createTask({
  title,
  ownerDiscordId,
  ownerName,
  etaText,
  riskText,
  actorId
}) {
  const result = db.prepare(`
    INSERT INTO dev_todo_tasks (
      title,
      status,
      owner_discord_id,
      owner_name,
      eta_text,
      risk_text,
      created_by,
      updated_by,
      updated_at
    ) VALUES (?, 'backlog', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    title.trim(),
    ownerDiscordId || null,
    ownerName || null,
    etaText || null,
    riskText || null,
    actorId,
    actorId
  );

  return Number(result.lastInsertRowid);
}

function addCompletionLog({
  taskId = null,
  taskCode = null,
  title,
  note = null,
  source = 'manual',
  actorId = null,
  actorName = null,
  completedAt = null
}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return false;

  if (completedAt) {
    db.prepare(`
      INSERT INTO dev_todo_completed_entries (
        task_id,
        task_code,
        title,
        note,
        source,
        actor_discord_id,
        actor_name,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId || null,
      taskCode || null,
      cleanTitle,
      note || null,
      source || 'manual',
      actorId || null,
      actorName || null,
      completedAt
    );
  } else {
    db.prepare(`
      INSERT INTO dev_todo_completed_entries (
        task_id,
        task_code,
        title,
        note,
        source,
        actor_discord_id,
        actor_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId || null,
      taskCode || null,
      cleanTitle,
      note || null,
      source || 'manual',
      actorId || null,
      actorName || null
    );
  }
  return true;
}

function seedCompletionLogFromDoneTasks() {
  const doneTasks = db.prepare(`
    SELECT
      id,
      title,
      risk_text,
      completed_by,
      owner_name,
      completed_at
    FROM dev_todo_tasks
    WHERE status = 'done'
      AND completed_at IS NOT NULL
    ORDER BY id ASC
  `).all();

  const existsStmt = db.prepare(`
    SELECT id
    FROM dev_todo_completed_entries
    WHERE source = 'task'
      AND task_id = ?
      AND completed_at = ?
    LIMIT 1
  `);

  for (const task of doneTasks) {
    const alreadyLogged = existsStmt.get(task.id, task.completed_at);
    if (alreadyLogged) continue;

    addCompletionLog({
      taskId: task.id,
      taskCode: getTaskCode(task.id),
      title: task.title,
      note: task.risk_text || null,
      source: 'task',
      actorId: task.completed_by || null,
      actorName: task.owner_name || null,
      completedAt: task.completed_at
    });
  }
}

seedCompletionLogFromDoneTasks();

async function moveTaskStatus(taskId, status, actorId, actorName) {
  if (!STATUS_CHOICES.includes(status)) return false;
  const task = db.prepare('SELECT id, title, risk_text FROM dev_todo_tasks WHERE id = ?').get(taskId);
  if (!task) return false;

  if (status === 'done') {
    db.prepare(`
      UPDATE dev_todo_tasks
      SET
        status = ?,
        updated_by = ?,
        updated_at = CURRENT_TIMESTAMP,
        completed_by = ?,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, actorId, actorId, taskId);

    addCompletionLog({
      taskId: task.id,
      taskCode: getTaskCode(task.id),
      title: task.title,
      note: task.risk_text || null,
      source: 'task',
      actorId,
      actorName
    });
  } else {
    db.prepare(`
      UPDATE dev_todo_tasks
      SET
        status = ?,
        updated_by = ?,
        updated_at = CURRENT_TIMESTAMP,
        completed_by = NULL,
        completed_at = NULL
      WHERE id = ?
    `).run(status, actorId, taskId);
  }
  return true;
}

function clearCompletionLog(scope) {
  const normalizedScope = normalizeCompletedScope(scope);
  if (normalizedScope === 'all') {
    const result = db.prepare('DELETE FROM dev_todo_completed_entries').run();
    return Number(result.changes || 0);
  }

  const startIso = getCompletedScopeWindowStart(normalizedScope);
  const result = db.prepare(`
    DELETE FROM dev_todo_completed_entries
    WHERE datetime(completed_at) >= datetime(?)
  `).run(startIso);
  return Number(result.changes || 0);
}

function hasDevTodoAccess(interaction) {
  const discordId = interaction.user.id;
  if (DEV_ID_FALLBACK.has(discordId)) return true;

  const dev = db.prepare('SELECT discord_id FROM developers WHERE discord_id = ?').get(discordId);
  if (dev) return true;

  const staff = db.prepare(
    "SELECT role FROM agents WHERE discord_id = ? AND role IN ('developer', 'operations_manager', 'team_leader')"
  ).get(discordId);
  return !!staff;
}

async function handleSetupDevTodo(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: 'Error: Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await upsertBoard(interaction.client);
  if (!result.ok) {
    return interaction.editReply(`Error: Failed to build dev board: ${result.reason}`);
  }

  return interaction.editReply(`Success: Developer to-do board is live in <#${DEV_TODO_CHANNEL_ID}>.`);
}

async function handleTodoAddCommand(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: 'Error: Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const title = interaction.options.getString('title', true);
  const ownerUser = interaction.options.getUser('owner');
  const etaText = interaction.options.getString('eta') || null;
  const riskText = interaction.options.getString('risk') || null;

  const ownerDiscordId = ownerUser?.id || interaction.user.id;
  const ownerName = ownerUser?.username || getActorNameFromInteraction(interaction);
  const taskId = await createTask({
    title,
    ownerDiscordId,
    ownerName,
    etaText,
    riskText,
    actorId: interaction.user.id
  });

  await upsertBoard(interaction.client);
  return interaction.editReply(`Success: Added \`${getTaskCode(taskId)}\` to shared board.`);
}

async function handleTodoMoveCommand(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: 'Error: Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const taskInput = interaction.options.getString('task', true);
  const status = interaction.options.getString('status', true);
  const taskId = parseTaskCode(taskInput);
  if (!taskId) {
    return interaction.editReply('Error: Invalid task code. Use format like `DEV-012`.');
  }

  const existing = db.prepare('SELECT id FROM dev_todo_tasks WHERE id = ?').get(taskId);
  if (!existing) {
    return interaction.editReply('Error: Task not found.');
  }

  const moved = await moveTaskStatus(taskId, status, interaction.user.id, getActorNameFromInteraction(interaction));
  if (!moved) {
    return interaction.editReply('Error: Task move failed.');
  }

  await upsertBoard(interaction.client);
  return interaction.editReply(`Success: Updated \`${getTaskCode(taskId)}\` to **${STATUS_META[status]?.title || status}**.`);
}

async function handleTodoRefreshCommand(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: 'Error: Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await upsertBoard(interaction.client);
  if (!result.ok) return interaction.editReply(`Error: Refresh failed: ${result.reason}`);
  return interaction.editReply('Success: Developer board refreshed.');
}

async function handleButton(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: 'Error: Developer access required.', ephemeral: true });
  }

  if (interaction.customId === 'devtodo_refresh_btn') {
    await interaction.deferReply({ ephemeral: true });
    await upsertBoard(interaction.client);
    return interaction.editReply({ content: 'Success: Board refreshed.' });
  }

  if (interaction.customId === 'devtodo_add_btn') {
    return interaction.showModal(buildAddTaskModal());
  }

  if (interaction.customId === 'devtodo_log_done_btn') {
    return interaction.showModal(buildCompletedLogModal());
  }

  if (interaction.customId === 'devtodo_clear_done_btn') {
    return interaction.reply({
      content: 'Choose which completed range you want to clear:',
      components: [buildClearCompletedPicker()],
      ephemeral: true
    });
  }

  if (interaction.customId.startsWith('devtodo_pick_')) {
    const targetStatus = interaction.customId.replace('devtodo_pick_', '');
    if (!STATUS_CHOICES.includes(targetStatus)) {
      return interaction.reply({ content: 'Error: Unknown status picker.', ephemeral: true });
    }

    const options = buildMovePicker(targetStatus);
    if (options.length === 0) {
      return interaction.reply({
        content: `Info: No tasks available to move into **${STATUS_META[targetStatus]?.title || targetStatus}**.`,
        ephemeral: true
      });
    }

    const picker = new StringSelectMenuBuilder()
      .setCustomId(`devtodo_move_select:${targetStatus}`)
      .setPlaceholder(`Select task to move -> ${STATUS_META[targetStatus]?.title || targetStatus}`)
      .addOptions(options.map(entry => entry.option));

    return interaction.reply({
      content: 'Pick one task:',
      components: [new ActionRowBuilder().addComponents(picker)],
      ephemeral: true
    });
  }

  return interaction.reply({ content: 'Error: Unknown dev to-do button.', ephemeral: true });
}

async function handleSelectMenu(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: 'Error: Developer access required.', ephemeral: true });
  }

  if (interaction.customId.startsWith('devtodo_move_select:')) {
    const status = interaction.customId.replace('devtodo_move_select:', '');
    if (!STATUS_CHOICES.includes(status)) {
      return interaction.update({ content: 'Error: Unknown status target.', components: [] });
    }

    const taskId = Number(interaction.values?.[0]);
    if (!Number.isInteger(taskId)) {
      return interaction.update({ content: 'Error: Invalid task selection.', components: [] });
    }

    const task = db.prepare('SELECT id FROM dev_todo_tasks WHERE id = ?').get(taskId);
    if (!task) {
      return interaction.update({ content: 'Error: Task not found.', components: [] });
    }

    const moved = await moveTaskStatus(taskId, status, interaction.user.id, getActorNameFromInteraction(interaction));
    if (!moved) {
      return interaction.update({ content: 'Error: Failed to move task.', components: [] });
    }

    await upsertBoard(interaction.client);
    return interaction.update({
      content: `Success: ${getTaskCode(taskId)} moved to **${STATUS_META[status]?.title || status}**.`,
      components: []
    });
  }

  if (interaction.customId === 'devtodo_completed_scope_select') {
    const nextScope = normalizeCompletedScope(interaction.values?.[0]);
    setCompletedScope(nextScope);

    await interaction.deferUpdate();
    await upsertBoard(interaction.client);
    return interaction.followUp({
      content: `Success: Completed view set to **${COMPLETED_SCOPE_META[nextScope].label}**.`,
      ephemeral: true
    });
  }

  if (interaction.customId === 'devtodo_clear_completed_select') {
    const scope = normalizeCompletedScope(interaction.values?.[0]);
    const removed = clearCompletionLog(scope);
    await upsertBoard(interaction.client);
    const suffix = removed === 1 ? 'entry' : 'entries';
    return interaction.update({
      content: removed > 0
        ? `Success: Cleared ${removed} completed ${suffix} from **${COMPLETED_SCOPE_META[scope].label}**.`
        : `Info: Nothing to clear for **${COMPLETED_SCOPE_META[scope].label}**.`,
      components: []
    });
  }
}

async function handleModalSubmit(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: 'Error: Developer access required.', ephemeral: true });
  }

  if (interaction.customId !== 'devtodo_add_modal' && interaction.customId !== 'devtodo_log_done_modal') return;
  await interaction.deferReply({ ephemeral: true });

  if (interaction.customId === 'devtodo_add_modal') {
    const title = interaction.fields.getTextInputValue('task_title');
    const ownerInput = interaction.fields.getTextInputValue('task_owner');
    const etaText = interaction.fields.getTextInputValue('task_eta') || null;
    const riskText = interaction.fields.getTextInputValue('task_risk') || null;
    const owner = await resolveOwnerInput(ownerInput, interaction);

    const taskId = await createTask({
      title,
      ownerDiscordId: owner.ownerDiscordId,
      ownerName: owner.ownerName,
      etaText,
      riskText,
      actorId: interaction.user.id
    });

    await upsertBoard(interaction.client);
    return interaction.editReply(`Success: Added \`${getTaskCode(taskId)}\` to the board.`);
  }

  const completedTitle = interaction.fields.getTextInputValue('completed_title');
  const completedNote = interaction.fields.getTextInputValue('completed_note') || null;
  addCompletionLog({
    title: completedTitle,
    note: completedNote,
    source: 'manual',
    actorId: interaction.user.id,
    actorName: getActorNameFromInteraction(interaction)
  });

  await upsertBoard(interaction.client);
  return interaction.editReply('Success: Completed entry logged.');
}

async function ensureDevTodoBoard(client) {
  return upsertBoard(client);
}

module.exports = {
  DEV_TODO_CHANNEL_ID,
  ensureDevTodoBoard,
  handleSetupDevTodo,
  handleTodoAddCommand,
  handleTodoMoveCommand,
  handleTodoRefreshCommand,
  handleButton,
  handleSelectMenu,
  handleModalSubmit
};
