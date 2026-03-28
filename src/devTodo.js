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

const STATUS_META = {
  backlog: { title: '🧠 Backlog', emoji: '🧠' },
  in_progress: { title: '⚙️ In Progress', emoji: '⚙️' },
  blocked: { title: '⛔ Blocked', emoji: '⛔' },
  ready_deploy: { title: '🚢 Ready to Deploy', emoji: '🚢' },
  done: { title: '✅ Done Today', emoji: '✅' }
};

const STATUS_CHOICES = Object.keys(STATUS_META);
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

function formatTaskLine(task) {
  const code = getTaskCode(task.id);
  const eta = task.eta_text ? ` • ETA: ${clip(task.eta_text, 24)}` : '';
  return `• \`${code}\` ${clip(task.title, 56)} • ${getOwnerLabel(task)}${eta}`;
}

function buildBoardEmbeds(tasks) {
  const grouped = {
    backlog: tasks.filter(task => task.status === 'backlog'),
    in_progress: tasks.filter(task => task.status === 'in_progress'),
    blocked: tasks.filter(task => task.status === 'blocked'),
    ready_deploy: tasks.filter(task => task.status === 'ready_deploy'),
    done: tasks.filter(task => task.status === 'done')
  };

  const summaryEmbed = new EmbedBuilder()
    .setTitle('🚀 Aavgo Developer Launch Board')
    .setDescription(
      '✅ Shared team board. Any approved developer can add, move, and check off tasks.\n' +
      '───────────────────\n' +
      `🧠 Backlog: **${grouped.backlog.length}**\n` +
      `⚙️ In Progress: **${grouped.in_progress.length}**\n` +
      `⛔ Blocked: **${grouped.blocked.length}**\n` +
      `🚢 Ready to Deploy: **${grouped.ready_deploy.length}**\n` +
      `✅ Done Today: **${grouped.done.length}**`
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Aavgo DevOps • Shared To-Do • Live Board' })
    .setTimestamp();

  const boardEmbed = new EmbedBuilder()
    .setTitle('📋 Active Developer Tasks')
    .setColor(0x2B2D31)
    .addFields(
      {
        name: STATUS_META.in_progress.title,
        value: grouped.in_progress.length > 0
          ? grouped.in_progress.slice(0, 8).map(formatTaskLine).join('\n')
          : '• No tasks currently in progress.'
      },
      {
        name: STATUS_META.blocked.title,
        value: grouped.blocked.length > 0
          ? grouped.blocked.slice(0, 8).map(formatTaskLine).join('\n')
          : '• No blocked tasks.'
      },
      {
        name: STATUS_META.ready_deploy.title,
        value: grouped.ready_deploy.length > 0
          ? grouped.ready_deploy.slice(0, 8).map(formatTaskLine).join('\n')
          : '• No tasks ready to deploy.'
      },
      {
        name: STATUS_META.backlog.title,
        value: grouped.backlog.length > 0
          ? grouped.backlog.slice(0, 8).map(formatTaskLine).join('\n')
          : '• Backlog is clear.'
      },
      {
        name: STATUS_META.done.title,
        value: grouped.done.length > 0
          ? grouped.done.slice(-8).map(formatTaskLine).join('\n')
          : '• No completed tasks yet.'
      }
    )
    .setFooter({ text: 'Aavgo DevOps • One Board, Shared Ownership' })
    .setTimestamp();

  return [summaryEmbed, boardEmbed];
}

function buildBoardComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('devtodo_add_btn')
      .setLabel('➕ New Task')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_in_progress')
      .setLabel('⚙️ In Progress')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_blocked')
      .setLabel('⛔ Block')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_done')
      .setLabel('✅ Check Off')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('devtodo_pick_backlog')
      .setLabel('🔁 Reopen')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('devtodo_pick_ready_deploy')
      .setLabel('🚢 Ready Deploy')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('devtodo_refresh_btn')
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

function getBoardMessageId() {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(DEV_TODO_MESSAGE_KEY);
  return row?.value || null;
}

function setBoardMessageId(messageId) {
  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(DEV_TODO_MESSAGE_KEY, String(messageId));
}

async function resolveBoardChannel(client) {
  const channel = await client.channels.fetch(DEV_TODO_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function upsertBoard(client) {
  const channel = await resolveBoardChannel(client);
  if (!channel) return { ok: false, reason: 'Board channel not found or not text based.' };

  const tasks = getAllTasks();
  const payload = {
    embeds: buildBoardEmbeds(tasks),
    components: buildBoardComponents()
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
      .setDescription(clip(`From ${STATUS_META[task.status]?.title || task.status} • Owner ${task.owner_name || 'Unassigned'}`, 90))
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

async function resolveOwnerInput(input, interaction) {
  const raw = String(input || '').trim();
  if (!raw) {
    return {
      ownerDiscordId: interaction.user.id,
      ownerName: interaction.member?.displayName || interaction.user.username
    };
  }

  const mentionMatch = raw.match(/^<@!?(\d+)>$/);
  const idMatch = raw.match(/^(\d{15,22})$/);
  const id = mentionMatch?.[1] || idMatch?.[1] || null;
  if (!id) return { ownerDiscordId: null, ownerName: raw };

  const member = await interaction.guild.members.fetch(id).catch(() => null);
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

async function moveTaskStatus(taskId, status, actorId) {
  if (!STATUS_CHOICES.includes(status)) return false;

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

async function handleSetupDevTodo(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await upsertBoard(interaction.client);
  if (!result.ok) {
    return interaction.editReply(`❌ Failed to build dev board: ${result.reason}`);
  }

  return interaction.editReply(`✅ Developer to-do board is live in <#${DEV_TODO_CHANNEL_ID}>.`);
}

async function handleTodoAddCommand(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const title = interaction.options.getString('title', true);
  const ownerUser = interaction.options.getUser('owner');
  const etaText = interaction.options.getString('eta') || null;
  const riskText = interaction.options.getString('risk') || null;

  const ownerDiscordId = ownerUser?.id || interaction.user.id;
  const ownerName = ownerUser?.username || interaction.member?.displayName || interaction.user.username;
  const taskId = await createTask({
    title,
    ownerDiscordId,
    ownerName,
    etaText,
    riskText,
    actorId: interaction.user.id
  });

  await upsertBoard(interaction.client);
  return interaction.editReply(`✅ Added \`${getTaskCode(taskId)}\` to shared board.`);
}

async function handleTodoMoveCommand(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const taskInput = interaction.options.getString('task', true);
  const status = interaction.options.getString('status', true);
  const taskId = parseTaskCode(taskInput);
  if (!taskId) {
    return interaction.editReply('❌ Invalid task code. Use format like `DEV-012`.');
  }

  const existing = db.prepare('SELECT id FROM dev_todo_tasks WHERE id = ?').get(taskId);
  if (!existing) {
    return interaction.editReply('❌ Task not found.');
  }

  await moveTaskStatus(taskId, status, interaction.user.id);
  await upsertBoard(interaction.client);
  return interaction.editReply(`✅ Updated \`${getTaskCode(taskId)}\` to **${STATUS_META[status]?.title || status}**.`);
}

async function handleTodoRefreshCommand(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await upsertBoard(interaction.client);
  if (!result.ok) return interaction.editReply(`❌ Refresh failed: ${result.reason}`);
  return interaction.editReply('✅ Developer board refreshed.');
}

async function handleButton(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  if (interaction.customId === 'devtodo_refresh_btn') {
    await upsertBoard(interaction.client);
    return interaction.reply({ content: '✅ Board refreshed.', ephemeral: true });
  }

  if (interaction.customId === 'devtodo_add_btn') {
    return interaction.showModal(buildAddTaskModal());
  }

  if (interaction.customId.startsWith('devtodo_pick_')) {
    const targetStatus = interaction.customId.replace('devtodo_pick_', '');
    if (!STATUS_CHOICES.includes(targetStatus)) {
      return interaction.reply({ content: '❌ Unknown status picker.', ephemeral: true });
    }

    const options = buildMovePicker(targetStatus);
    if (options.length === 0) {
      return interaction.reply({
        content: `ℹ️ No tasks available to move into **${STATUS_META[targetStatus]?.title || targetStatus}**.`,
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

  return interaction.reply({ content: '❌ Unknown dev to-do button.', ephemeral: true });
}

async function handleSelectMenu(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  if (!interaction.customId.startsWith('devtodo_move_select:')) return;
  const status = interaction.customId.replace('devtodo_move_select:', '');
  if (!STATUS_CHOICES.includes(status)) {
    return interaction.update({ content: '❌ Unknown status target.', components: [] });
  }

  const taskId = Number(interaction.values?.[0]);
  if (!Number.isInteger(taskId)) {
    return interaction.update({ content: '❌ Invalid task selection.', components: [] });
  }

  const task = db.prepare('SELECT id FROM dev_todo_tasks WHERE id = ?').get(taskId);
  if (!task) {
    return interaction.update({ content: '❌ Task not found.', components: [] });
  }

  await moveTaskStatus(taskId, status, interaction.user.id);
  await upsertBoard(interaction.client);
  return interaction.update({
    content: `✅ ${getTaskCode(taskId)} moved to **${STATUS_META[status]?.title || status}**.`,
    components: []
  });
}

async function handleModalSubmit(interaction) {
  if (!hasDevTodoAccess(interaction)) {
    return interaction.reply({ content: '❌ Developer access required.', ephemeral: true });
  }

  if (interaction.customId !== 'devtodo_add_modal') return;

  await interaction.deferReply({ ephemeral: true });
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
  return interaction.editReply(`✅ Added \`${getTaskCode(taskId)}\` to the board.`);
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

