const { SlashCommandBuilder } = require('discord.js');

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
    .setDescription('Setup the persistent login message (Admin only)'),
  new SlashCommandBuilder()
    .setName('setup-register')
    .setDescription('Setup the recruitment kiosk message (Admin only)'),
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register as an Aavgo agent (requires admin approval)'),
  new SlashCommandBuilder()
    .setName('add-agent')
    .setDescription('(Admin) Add a user as an agent instantly')
    .addUserOption(option => option.setName('user').setDescription('The user to add').setRequired(true))
    .addStringOption(option => option.setName('pin').setDescription('Set their PIN (4-6 digits)').setRequired(true))
    .addStringOption(option => option.setName('role').setDescription('Role (agent, team_leader, SME)').setRequired(false)
      .addChoices(
        { name: 'Agent', value: 'agent' },
        { name: 'Team Leader', value: 'team_leader' },
        { name: 'SME', value: 'SME' }
      )),
  new SlashCommandBuilder()
    .setName('remove-agent')
    .setDescription('(Admin) Remove a user as an agent')
    .addUserOption(option => option.setName('user').setDescription('The user to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName('check-hours')
    .setDescription('Check shift hours logged by an agent (Managers can check others)')
    .addUserOption(option => option.setName('user').setDescription('The user to check (Managers only)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('end-shift')
    .setDescription('End your current shift'),
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
    .setName('setup-login-team')
    .setDescription('Setup the TL/SME login portal (Admin only)'),
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
    .setName('db-demote')
    .setDescription('(Developer Only) Demote a manager back to an agent')
    .addUserOption(option => option.setName('user').setDescription('The user to demote').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-remove-user')
    .setDescription('(Developer Only) COMPLETELY remove a user from DB and roles')
    .addUserOption(option => option.setName('user').setDescription('The user to purge').setRequired(true)),
  new SlashCommandBuilder()
    .setName('help-dev')
    .setDescription('(Developer Only) Show a comprehensive guide of all developer and administrative tools'),
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
        { name: 'Thousand Oaks', value: 'BW_TO' },
        { name: 'Brentwood', value: 'BRNT' },
        { name: 'Russellville', value: 'QI_RV' },
        { name: 'Super 8', value: 'SUP8' },
        { name: 'Ramada', value: 'RMDA' },
        { name: 'Ad1 (Calls Only)', value: 'AD1' }
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
      .addChoices(
        { name: 'Thousand Oaks', value: 'BW_TO' },
        { name: 'Brentwood', value: 'BRNT' },
        { name: 'Russellville', value: 'QI_RV' },
        { name: 'Super 8', value: 'SUP8' },
        { name: 'Ramada', value: 'RMDA' },
        { name: 'Ad1 (Calls Only)', value: 'AD1' }
      ))
    .addStringOption(option => option.setName('date').setDescription('Date (YYYY-MM-DD or "Today")').setRequired(true))
    .addStringOption(option => option.setName('start').setDescription('Start Time (e.g., 09:00)').setRequired(true))
    .addStringOption(option => option.setName('end').setDescription('End Time (e.g., 17:00)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('schedule-view')
    .setDescription('(Manager) View the weekly shift schedule in spreadsheet format')
    .addStringOption(option => option.setName('hotel').setDescription('Filter by hotel').setRequired(false)
      .addChoices(
        { name: 'Thousand Oaks', value: 'BW_TO' },
        { name: 'Brentwood', value: 'BRNT' },
        { name: 'Russellville', value: 'QI_RV' },
        { name: 'Super 8', value: 'SUP8' },
        { name: 'Ramada', value: 'RMDA' },
        { name: 'Ad1 (Calls Only)', value: 'AD1' }
      )),
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
    .setName('generate-rac')
    .setDescription('(Developer Only) Generate a one-time Recruitment Access Code'),
  new SlashCommandBuilder()
    .setName('hotel-status')
    .setDescription('(Manager) Refresh hotel status embeds')
    .addStringOption(option => option.setName('action').setDescription('Refresh action').setRequired(true)
      .addChoices(
        { name: 'Refresh All', value: 'refresh_all' },
        { name: 'Refresh Specific', value: 'refresh_one' }
      ))
    .addStringOption(option => option.setName('hotel').setDescription('Specific hotel to refresh').setRequired(false)
      .addChoices(
        { name: 'Thousand Oaks', value: 'BW_TO' },
        { name: 'Brentwood', value: 'BRNT' },
        { name: 'Russellville', value: 'QI_RV' },
        { name: 'Super 8', value: 'SUP8' },
        { name: 'Ramada', value: 'RMDA' },
        { name: 'Ad1 (Calls Only)', value: 'AD1' }
      )),
  new SlashCommandBuilder()
    .setName('db-assign-hotel')
    .setDescription('(Developer Only) Manually set an agent\'s permanent hotel linking')
    .addUserOption(option => option.setName('user').setDescription('The agent to link').setRequired(true))
    .addStringOption(option => option.setName('hotel').setDescription('The hotel ID').setRequired(true)
      .addChoices(
        { name: 'Thousand Oaks', value: 'BW_TO' },
        { name: 'Brentwood', value: 'BRNT' },
        { name: 'Russellville', value: 'QI_RV' },
        { name: 'Super 8', value: 'SUP8' },
        { name: 'Ramada', value: 'RMDA' },
        { name: 'Ad1 (Calls Only)', value: 'AD1' }
      )),
  new SlashCommandBuilder()
    .setName('db-agent-ready')
    .setDescription('(Developer Only) Allow a standby agent to start shifts')
    .addUserOption(option => option.setName('user').setDescription('The agent to mark ready').setRequired(true)),
  new SlashCommandBuilder()
    .setName('db-agent-standby')
    .setDescription('(Developer Only) Put an agent back into standby training mode')
    .addUserOption(option => option.setName('user').setDescription('The agent to put on standby').setRequired(true)),
  new SlashCommandBuilder()
    .setName('help-team-leader')
    .setDescription('Show a comprehensive guide for Team Leaders and SMEs'),
].map(command => command.toJSON());

module.exports = { commandData };
