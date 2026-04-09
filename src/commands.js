const { SlashCommandBuilder } = require('discord.js');

const HOTEL_CHOICES = [
  { name: 'Indianhead/Magnuson', value: 'BW_TO' },
  { name: 'The Garden Inn At Campsite', value: 'GICP' },
  { name: 'Super 8', value: 'SUP8' },
  { name: 'Ramada', value: 'RMDA' },
  { name: 'AD1', value: 'AD1' },
  { name: 'Travelodge', value: 'TRVL' },
  { name: 'Day Inns Bishop', value: 'DIBS' },
  { name: 'Prospero Flagship', value: 'PROS' },
  { name: 'Glendale / The Leef Hotel', value: 'GLDL' },
  { name: 'Inn at the Fingerlakes', value: 'INFL' },
  { name: 'Value Suites', value: 'VALS' },
  { name: 'Bayside / Townhouse', value: 'BAYT' },
  { name: 'Anchor Beach / Pacific Inn', value: 'ANPI' },
  { name: 'Econolodge', value: 'ECON' },
  { name: 'Buenavista', value: 'BUEN' },
  { name: 'Quality Russelville', value: 'QI_RV' }
];

const commandData = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('Log in to a hotel shift'),
  new SlashCommandBuilder()
    .setName('logout')
    .setDescription('Log out from your current shift'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check current shift statuses'),
  new SlashCommandBuilder()
    .setName('setup-login')
    .setDescription('Setup the unified login portal (Admin only)'),
  new SlashCommandBuilder()
    .setName('add-agent')
    .setDescription('(Admin) Add a user as an agent instantly')
    .addUserOption(option => option.setName('user').setDescription('The user to add').setRequired(true))
    .addStringOption(option => option.setName('role').setDescription('Role (agent, sme, team_leader, operations_manager)').setRequired(false)
      .addChoices(
        { name: 'Agent', value: 'agent' },
        { name: 'SME', value: 'sme' },
        { name: 'Team Leader', value: 'team_leader' },
        { name: 'Operations Manager', value: 'operations_manager' }
      )),
  new SlashCommandBuilder()
    .setName('reset-pin')
    .setDescription('Reset your own security PIN')
    .addStringOption(option => option.setName('current_pin').setDescription('Your current PIN').setRequired(true))
    .addStringOption(option => option.setName('new_pin').setDescription('New PIN (4-6 digits)').setRequired(true))
    .addStringOption(option => option.setName('confirm_pin').setDescription('Confirm new PIN').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setup-profiles')
    .setDescription('Post the profiles dashboard (Developer only)'),
  new SlashCommandBuilder()
    .setName('setup-dev-todo')
    .setDescription('(Developer) Deploy or refresh the shared developer to-do board'),
  new SlashCommandBuilder()
    .setName('todo-add')
    .setDescription('(Developer) Add a task to the shared developer board')
    .addStringOption(option => option.setName('title').setDescription('Task summary').setRequired(true))
    .addUserOption(option => option.setName('owner').setDescription('Task owner').setRequired(false))
    .addStringOption(option => option.setName('eta').setDescription('ETA text, e.g. 45m or today 9 PM').setRequired(false))
    .addStringOption(option => option.setName('risk').setDescription('Risk or note').setRequired(false)),
  new SlashCommandBuilder()
    .setName('todo-move')
    .setDescription('(Developer) Move a task to a different status')
    .addStringOption(option => option.setName('task').setDescription('Task code, e.g. DEV-012').setRequired(true))
    .addStringOption(option => option.setName('status').setDescription('New status').setRequired(true)
      .addChoices(
        { name: 'Backlog', value: 'backlog' },
        { name: 'In Progress', value: 'in_progress' },
        { name: 'Blocked', value: 'blocked' },
        { name: 'Ready to Deploy', value: 'ready_deploy' },
        { name: 'Done Today', value: 'done' }
      )),
  new SlashCommandBuilder()
    .setName('todo-refresh')
    .setDescription('(Developer) Refresh the shared developer to-do board'),
  new SlashCommandBuilder()
    .setName('remove-agent')
    .setDescription('(Admin) Remove a user as an agent')
    .addUserOption(option => option.setName('user').setDescription('The user to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName('check-hours')
    .setDescription('Check shift hours logged by an agent (Managers can check others)')
    .addUserOption(option => option.setName('user').setDescription('The user to check (Managers only)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('add-hours')
    .setDescription('(Developer/Operations Manager) Add manual hours to an agent')
    .addUserOption(option => option.setName('user').setDescription('The agent to update').setRequired(true))
    .addNumberOption(option => option.setName('hours').setDescription('Hours to add (supports decimals)').setRequired(true).setMinValue(0.01))
    .addStringOption(option => option.setName('note').setDescription('Reason or note').setRequired(false)),
  new SlashCommandBuilder()
    .setName('hours-export')
    .setDescription('(Developer/Operations Manager) Export hours logs as a horizontal Excel-style timesheet')
    .addStringOption(option => option
      .setName('period')
      .setDescription('Which period to export')
      .setRequired(true)
      .addChoices(
        { name: 'Day', value: 'day' },
        { name: 'Week', value: 'week' },
        { name: 'Month', value: 'month' }
      )),
  new SlashCommandBuilder()
    .setName('end-shift')
    .setDescription('End your shift (OM/Developer can target another user)')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Target user to force end (Operations Manager / Developer only)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('tools')
    .setDescription('Agent Tools (Normal Break, Bio Break, Emergency)'),
  new SlashCommandBuilder()
    .setName('tools-team')
    .setDescription('Team Leader Management Console (Audit Agents, Call Agent)'),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Deletes up to 100 recent messages in the current channel (Admin only)')
    .addIntegerOption(option => 
      option.setName('amount')
            .setDescription('Number of messages to delete (1-100)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100)
    )
    .setDefaultMemberPermissions(8), // Administrator bit
  new SlashCommandBuilder()
    .setName('clear-hours')
    .setDescription('(Admin) Reset shift hours for a specific agent')
    .addUserOption(option => option.setName('user').setDescription('The user whose hours to clear').setRequired(true))
    .setDefaultMemberPermissions(8),
  new SlashCommandBuilder()
    .setName('db-delete-agent')
    .setDescription('(Developer Only) Delete an agent directly from the database')
    .addUserOption(option => option.setName('user').setDescription('The user to delete').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-clear-pending')
    .setDescription('(Developer Only) Clear all pending registration requests'),
  new SlashCommandBuilder()
    .setName('db-query')
    .setDescription('(Developer Only) Execute a raw SQL query')
    .addStringOption(option => option.setName('sql').setDescription('The SQL query to execute').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-info')
    .setDescription('(Developer Only) Show database path and table information'),
  new SlashCommandBuilder()
    .setName('see-all-pins')
    .setDescription('(Developer/OM) View stored agent PINs (optional user filter)')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Optional: filter PIN audit to one agent')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('setup-login-team')
    .setDescription('Refresh unified login portal (legacy alias, Admin only)'),
  new SlashCommandBuilder()
    .setName('db-add-developer')
    .setDescription('(Developer Only) Propose adding a new developer')
    .addUserOption(option => option.setName('user').setDescription('The user to add as developer').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-set-phone')
    .setDescription('(Developer Only) Set or update an agent\'s phone number')
    .addUserOption(option => option.setName('user').setDescription('The agent to update').setRequired(true))
    .addStringOption(option => option.setName('phone').setDescription('The phone number (e.g., 639273068312)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-log-checkin')
    .setDescription('Log a guest check-in to the management portal')
    .addStringOption(option => option.setName('guest').setDescription('The name of the guest').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-backup')
    .setDescription('(Developer Only) Manually trigger a database export and source file backup'),
  new SlashCommandBuilder()
    .setName('db-promote-tl')
    .setDescription('(Developer Only) Promote an agent to Team Leader')
    .addUserOption(option => option.setName('user').setDescription('The user to promote').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-promote-sme')
    .setDescription('(Developer Only) Promote an agent to Subject Matter Expert (SME)')
    .addUserOption(option => option.setName('user').setDescription('The user to promote').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-set-operation-manager')
    .setDescription('(Developer Only) Promote an agent to Operations Manager')
    .addUserOption(option => option.setName('user').setDescription('The user to promote').setRequired(true)),
  new SlashCommandBuilder()
    .setName('promote')
    .setDescription('(Developer/OM) Request promotion to Developer or Operations Manager')
    .addUserOption(option => option.setName('user').setDescription('The user to promote').setRequired(true))
    .addStringOption(option => option
      .setName('role')
      .setDescription('Target promotion role')
      .setRequired(true)
      .addChoices(
        { name: 'Developer', value: 'developer' },
        { name: 'Operations Manager', value: 'operations_manager' }
      )),
  new SlashCommandBuilder()
    .setName('db-demote')
    .setDescription('(Developer Only) Demote a user by one rank step')
    .addUserOption(option => option.setName('user').setDescription('The user to demote').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-remove-user')
    .setDescription('(Developer Only) COMPLETELY remove a user from DB and roles')
    .addUserOption(option => option.setName('user').setDescription('The user to purge').setRequired(true)),
  new SlashCommandBuilder()
    .setName('help-staff')
    .setDescription('(Developer/Operations Manager) Show a comprehensive guide of staff tools'),
  new SlashCommandBuilder()
    .setName('test-ui')
    .setDescription('(Developer/Operations Manager) Open the Discord UI test lab (legacy alias)')
    .addStringOption(option => option
      .setName('theme')
      .setDescription('Start with a specific style preset')
      .setRequired(false)
      .addChoices(
        { name: 'Aavgo Ops Amber', value: 'aavgo' },
        { name: 'Vercel Mono', value: 'vercel' },
        { name: 'Stripe Gradient', value: 'stripe' },
        { name: 'Notion Warm', value: 'notion' }
      ))
    .addStringOption(option => option
      .setName('screen')
      .setDescription('Start on a specific preview screen')
      .setRequired(false)
      .addChoices(
        { name: 'Shift Route Card', value: 'shift_route' },
        { name: 'Hotel Status Card', value: 'hotel_status' },
        { name: 'Training Status Card', value: 'training_status' },
        { name: 'Training Started Log', value: 'training_started' },
        { name: 'Newcomer Joined Card', value: 'newcomer' }
      ))
    .addStringOption(option => option
      .setName('density')
      .setDescription('Choose spacing style for the mockup')
      .setRequired(false)
      .addChoices(
        { name: 'Cozy', value: 'cozy' },
        { name: 'Compact', value: 'compact' }
      )),
  new SlashCommandBuilder()
    .setName('test-gui')
    .setDescription('(Developer/Operations Manager) Open the Discord UI test lab')
    .addStringOption(option => option
      .setName('theme')
      .setDescription('Start with a specific style preset')
      .setRequired(false)
      .addChoices(
        { name: 'Aavgo Ops Amber', value: 'aavgo' },
        { name: 'Vercel Mono', value: 'vercel' },
        { name: 'Stripe Gradient', value: 'stripe' },
        { name: 'Notion Warm', value: 'notion' }
      ))
    .addStringOption(option => option
      .setName('screen')
      .setDescription('Start on a specific preview screen')
      .setRequired(false)
      .addChoices(
        { name: 'Shift Route Card', value: 'shift_route' },
        { name: 'Hotel Status Card', value: 'hotel_status' },
        { name: 'Training Status Card', value: 'training_status' },
        { name: 'Training Started Log', value: 'training_started' },
        { name: 'Newcomer Joined Card', value: 'newcomer' }
      ))
    .addStringOption(option => option
      .setName('density')
      .setDescription('Choose spacing style for the mockup')
      .setRequired(false)
      .addChoices(
        { name: 'Cozy', value: 'cozy' },
        { name: 'Compact', value: 'compact' }
      )),
  new SlashCommandBuilder()
    .setName('help-agent')
    .setDescription('Show a quick guide for core agent commands and daily workflow'),
  new SlashCommandBuilder()
    .setName('limit-warning')
    .setDescription('(Developer/Operations Manager) Manually send an overtime warning to an active agent/trainee')
    .addUserOption(option => option.setName('user').setDescription('The active agent/trainee to warn').setRequired(true)),
  new SlashCommandBuilder()
    .setName('time-travel')
    .setDescription('(Developer/Operations Manager) Simulate elapsed session time for overtime testing')
    .addUserOption(option => option.setName('name').setDescription('The active user to simulate').setRequired(true))
    .addIntegerOption(option => option.setName('hours').setDescription('Simulated elapsed hours').setRequired(true).setMinValue(0).setMaxValue(48))
    .addIntegerOption(option => option.setName('minutes').setDescription('Simulated elapsed minutes').setRequired(true).setMinValue(0).setMaxValue(59))
    .addIntegerOption(option => option.setName('seconds').setDescription('Simulated elapsed seconds').setRequired(true).setMinValue(0).setMaxValue(59)),
  new SlashCommandBuilder()
    .setName('select-trainee')
    .setDescription('(Management/Developer) Assign the Trainees role to a user')
    .addUserOption(option => option.setName('name').setDescription('The user to mark as trainee').setRequired(true)),
  new SlashCommandBuilder()
    .setName('assign-team')
    .setDescription('(Management/Developer) Assign an agent to Team 1, Team 2, or Team 3')
    .addUserOption(option => option.setName('name').setDescription('The user to reassign').setRequired(true))
    .addStringOption(option => option.setName('team').setDescription('The team to assign').setRequired(true)
      .addChoices(
        { name: 'Team 1', value: 'Team 1' },
        { name: 'Team 2', value: 'Team 2' },
        { name: 'Team 3', value: 'Team 3' }
      )),
  new SlashCommandBuilder()
    .setName('find-guest')
    .setDescription('(Manager/Dev) Search for guest records by name or room number')
    .addStringOption(option => option.setName('query').setDescription('Guest name or room number').setRequired(true)),
  new SlashCommandBuilder()
    .setName('guide')
    .setDescription('Search for hotel-specific SOP guides and policies')
    .addStringOption(option => option.setName('topic').setDescription('The topic to search for (e.g., tax-exempt, wifi)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('add-guide')
    .setDescription('(Manager/SME) Add or update a hotel SOP guide')
    .addStringOption(option => option.setName('hotel').setDescription('The hotel ID (or "GLOBAL")').setRequired(true)
      .addChoices(
        { name: 'Global (All Hotels)', value: 'GLOBAL' },
        ...HOTEL_CHOICES
      ))
    .addStringOption(option => option.setName('topic').setDescription('The topic title').setRequired(true))
    .addStringOption(option => option.setName('content').setDescription('The policy details').setRequired(true)),
  new SlashCommandBuilder()
    .setName('maintenance-list')
    .setDescription('(Manager) View all pending maintenance issues'),
  new SlashCommandBuilder()
    .setName('db-set-schedule')
    .setDescription('(Manager) Assign an agent to a hotel shift')
    .addUserOption(option => option.setName('user').setDescription('The agent to schedule').setRequired(true))
    .addStringOption(option => option.setName('hotel').setDescription('The hotel ID').setRequired(true)
      .addChoices(...HOTEL_CHOICES))
    .addStringOption(option => option.setName('date').setDescription('Date (YYYY-MM-DD or "Today")').setRequired(true))
    .addStringOption(option => option.setName('start').setDescription('Start Time (e.g., 09:00)').setRequired(true))
    .addStringOption(option => option.setName('end').setDescription('End Time (e.g., 17:00)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('set-hotel-shifts')
    .setDescription('(Manager) Assign an agent to two hotel shift options')
    .addUserOption(option => option.setName('user').setDescription('The agent to update').setRequired(true))
    .addStringOption(option => option.setName('hotel_1').setDescription('Primary hotel').setRequired(true)
      .addChoices(...HOTEL_CHOICES))
    .addStringOption(option => option.setName('hotel_2').setDescription('Secondary hotel').setRequired(true)
      .addChoices(...HOTEL_CHOICES)),
  new SlashCommandBuilder()
    .setName('schedule-view')
    .setDescription('(Manager) View the weekly shift schedule in spreadsheet format')
    .addStringOption(option => option.setName('hotel').setDescription('Filter by hotel').setRequired(false)
      .addChoices(...HOTEL_CHOICES)),
  new SlashCommandBuilder()
    .setName('schedule-export')
    .setDescription('(Manager) Download the schedule as a CSV spreadsheet'),
  new SlashCommandBuilder()
    .setName('schedule-import')
    .setDescription('(Manager) Upload a CSV file to bulk update schedules')
    .addAttachmentOption(option => option.setName('file').setDescription('The CSV file to upload').setRequired(true)),
  new SlashCommandBuilder()
    .setName('my-schedule')
    .setDescription('View your upcoming assigned shifts'),
  new SlashCommandBuilder()
    .setName('attendance-report')
    .setDescription('(Manager) View agents who missed their scheduled shifts'),
  new SlashCommandBuilder()
    .setName('db-remove-all')
    .setDescription('(Developer Only) Wipe all agents and sessions (Requires Consensus)'),
  new SlashCommandBuilder()
    .setName('db-set-pin')
    .setDescription('(Developer Only) Manually set or update an agent\'s PIN')
    .addUserOption(option => option.setName('user').setDescription('The agent to update').setRequired(true))
    .addStringOption(option => option.setName('pin').setDescription('New PIN (4-6 digits)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('hotel-status')
    .setDescription('(Manager) Refresh hotel status embeds')
    .addStringOption(option => option.setName('action').setDescription('Refresh action').setRequired(true)
      .addChoices(
        { name: 'Refresh All', value: 'refresh_all' },
        { name: 'Refresh Specific', value: 'refresh_one' },
        { name: 'Clear Team 1 Live Embeds (Test)', value: 'clear_team1_live_embeds' }
      ))
    .addStringOption(option => option.setName('hotel').setDescription('Specific hotel to refresh').setRequired(false)
      .addChoices(...HOTEL_CHOICES)),
  new SlashCommandBuilder()
    .setName('db-assign-hotel')
    .setDescription('(Developer/Operations Manager) Manually set an agent\'s permanent hotel linking')
    .addUserOption(option => option.setName('user').setDescription('The agent to link').setRequired(true))
    .addStringOption(option => option.setName('hotel').setDescription('The hotel ID').setRequired(true)
      .addChoices(...HOTEL_CHOICES))
    .addStringOption(option => option.setName('sync').setDescription('Which role type to sync').setRequired(false)
      .addChoices(
        { name: 'Both', value: 'both' },
        { name: 'Permission Role', value: 'permission' },
        { name: 'Ghost Role', value: 'ghost' }
      )),
  new SlashCommandBuilder()
    .setName('help-team-leader')
    .setDescription('Show a comprehensive guide for Team Leaders and SMEs'),
].map(command => command.toJSON());

module.exports = { commandData };

