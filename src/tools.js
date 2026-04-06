const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./database');
const { sendAuditLog, HOTEL_NAMES, HOTEL_LOGIN_CHANNELS, updateHotelStatusEmbed, isDeveloper, interactionHasRoleAtLeast } = require('./auth');

const TL_ALERT_CHANNEL_ID = '1482222657935118487';
const TL_TOOLS_CHANNEL_ID = '1482222657935118487';
const TEAM_LEADER_ROLE_NAME = 'Team Leader';

// In-memory state for timeouts
const activeBioBreaks = new Map(); // userId -> { timeout, startTime }
const activeCallRequests = new Map(); // messageId -> { timeout, agentId, type }

// Generic function to send a priority alert to Team Leaders
async function sendAlert(interaction, typeLabel, color, hotelId) {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  const tlRole = guild.roles.cache.find(r => r.name.toLowerCase() === TEAM_LEADER_ROLE_NAME.toLowerCase());
  const rolePing = tlRole ? `<@&${tlRole.id}>` : '@Team Leader';

  const channel = await interaction.client.channels.fetch(TL_ALERT_CHANNEL_ID);
  if (!channel) {
    return interaction.editReply({ content: '❌ Alert channel not found.' });
  }

  const hotelName = HOTEL_NAMES[hotelId] || hotelId;

  const nowUnix = Math.floor(Date.now() / 1000);
  const isBreak = typeLabel.includes('Break');

  const embed = new EmbedBuilder()
    .setTitle(`🚨 ${typeLabel} Required`)
    .setDescription(`**Agent:** ${interaction.user.username} (<@${interaction.user.id}>)\n**Hotel:** **${hotelName}**\n**Requested:** <t:${nowUnix}:R>\n**Status:** Waiting for Team Leader...`)
    .setColor(color)
    .setTimestamp();

  const row = new ActionRowBuilder();

  if (isBreak) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`bio_approve_${interaction.user.id}`)
        .setLabel('✅ Approve Break')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bio_deny_${interaction.user.id}`)
        .setLabel('❌ Deny Break')
        .setStyle(ButtonStyle.Danger)
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`tl_accept_${interaction.user.id}`)
        .setLabel('✅ Accept Request')
        .setStyle(ButtonStyle.Success)
    );
  }

  const alertMsg = await channel.send({ content: rolePing, embeds: [embed], components: [row] });

  await interaction.editReply({ content: `📞 **Calling for ${typeLabel}...** Please wait for a response.` });

  // Audit log the request
  sendAuditLog(interaction.client, {
    title: `📡 Tools: ${typeLabel} Requested`,
    description: `**Agent:** ${interaction.user.username} (<@${interaction.user.id}>)\n**Hotel:** ${hotelName}`,
    color: color,
    hotelId: hotelId
  });

  // 60-second timeout
  const timeout = setTimeout(async () => {
    activeCallRequests.delete(alertMsg.id);
        const timeoutEmbed = EmbedBuilder.from(embed)
        .setDescription(embed.data.description.replace(/:R>/g, ':t>').replace('Waiting for Team Leader...', `⚠️ Timed out (No responder)`))
        .setColor(0xFEE75C);
    
    try {
      await alertMsg.edit({ embeds: [timeoutEmbed], components: [] });
    } catch (e) { /* ignore */ }

    try {
      await interaction.followUp({ content: `⚠️ **Responders are currently busy or away.** We will contact them immediately regarding your ${typeLabel}.`, ephemeral: true });
    } catch (e) { /* ignore */ }
  }, 60000);

  activeCallRequests.set(alertMsg.id, { 
    timeout, 
    agentId: interaction.user.id, 
    type: typeLabel, 
    startTime: Date.now(),
    channelId: interaction.channelId,
    hotelId: hotelId
  });
}

async function handleToolsCommand(interaction) {
  try {
    const isTLCommand = interaction.commandName === 'tools-team';
    const isTLChannel = interaction.channelId === TL_TOOLS_CHANNEL_ID;
    
    // Check database role if possible
    const hasTLRole = interactionHasRoleAtLeast(interaction, 'sme') || 
                      interaction.member.roles.cache.some(r => r.name.toLowerCase() === TEAM_LEADER_ROLE_NAME.toLowerCase()) ||
                      isDeveloper(interaction);

    // ─── Team Leader Tools View ───────────────────────
    if (isTLCommand) {
      if (!isTLChannel || !hasTLRole) {
        return interaction.reply({ content: '❌ **Access Denied.** The Team Leader Console can only be used by Team Leaders in the designated Management Channel.', ephemeral: true });
      }
      const activeAgents = db.prepare(`
        SELECT agents.discord_id, agents.username, sessions.hotel_id 
        FROM sessions 
        JOIN agents ON sessions.agent_id = agents.id 
        WHERE sessions.status = 'active'
      `).all();

      const embed = new EmbedBuilder()
        .setTitle('🛡️ Team Leader Management Console')
        .setDescription('High-priority tools for monitoring and agent auditing.')
        .setColor(0x57F287)
        .addFields({ name: '👥 Active Agents', value: activeAgents.length > 0 
          ? activeAgents.map(a => `<@${a.discord_id}> (${HOTEL_NAMES[a.hotel_id] || a.hotel_id})`).join('\n') 
          : 'No agents currently on shift.' 
        });

      const callBtn = new ButtonBuilder()
        .setCustomId('tl_call_agent_menu')
        .setLabel('📞 Call Agent')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(activeAgents.length === 0);

      const row = new ActionRowBuilder().addComponents(callBtn);
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    // ─── Normal Agent Tools View ─────────────────────
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    if (!agent) {
      return interaction.reply({ content: '❌ You must be a registered agent to use tools.', ephemeral: true });
    }

    const activeSession = db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND status = 'active'").get(agent.id);
    if (!activeSession) {
      return interaction.reply({ content: '❌ You must be on-shift to use tools.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🎯 Aavgo Agent Control Center')
      .setDescription('Please select an option below to request assistance or manage your shift breaks.')
      .setColor(0x2B2D31)
      .setFooter({ text: `Logged in as ${interaction.user.username}` });

    const normalBreakBtn = new ButtonBuilder()
      .setCustomId('tools_normal_break')
      .setLabel('☕ Normal Break')
      .setStyle(ButtonStyle.Secondary);

    const bioBreakBtn = new ButtonBuilder()
      .setCustomId('tools_bio_break')
      .setLabel('🚽 Bio Break')
      .setStyle(ButtonStyle.Secondary);

    const emergencyBtn = new ButtonBuilder()
      .setCustomId('tools_emergency')
      .setLabel('🆘 Emergency')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(normalBreakBtn, bioBreakBtn, emergencyBtn);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (error) {
    console.error('Error in handleToolsCommand:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
}

async function handleNormalBreak(interaction) {
  try {
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    const session = db.prepare("SELECT hotel_id FROM sessions WHERE agent_id = ? AND status = 'active'").get(agent.id);
    await sendAlert(interaction, 'Normal Break', 0x9B59B6, session.hotel_id); // Violet
  } catch (e) { console.error(e); }
}

async function handleEmergency(interaction) {
  try {
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(interaction.user.id);
    const session = db.prepare("SELECT hotel_id FROM sessions WHERE agent_id = ? AND status = 'active'").get(agent.id);
    await sendAlert(interaction, 'Emergency Escalation', 0x992D22, session.hotel_id); // Dark Red
  } catch (e) { console.error(e); }
}

async function handleTLAccept(interaction) {
  try {
    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id);
    const tlRole = guild.roles.cache.find(r => r.name.toLowerCase() === TEAM_LEADER_ROLE_NAME.toLowerCase());
    if (tlRole && !member.roles.cache.has(tlRole.id) && !interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Only management staff can accept assistance requests.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const agentId = interaction.customId.replace('tl_accept_', '');
    const messageId = interaction.message.id;

    const request = activeCallRequests.get(messageId);
    if (request) {
      clearTimeout(request.timeout);
      request.acceptTime = Date.now();
      request.tlId = interaction.user.id;
      
      try {
        if (request.channelId) {
          const channel = await interaction.client.channels.fetch(request.channelId);
          if (channel) {
            await channel.send(`✅ <@${agentId}>, **<@${interaction.user.id}>** has accepted your **${request.type}** request and is looking into it!`);
          }
        }
      } catch (e) { console.warn('Could not send in-channel accept ping:', e.message); }
    }

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setDescription(interaction.message.embeds[0].description.replace(/:R>/g, ':t>').replace('Waiting for Team Leader...', `✅ Assisting by ${interaction.user.username} (Busy)`))
      .setColor(0xFEE75C);

    const doneBtn = new ButtonBuilder()
      .setCustomId(`tl_done_${agentId}_${interaction.user.id}`)
      .setLabel('🏁 Assistance Done')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(doneBtn);

    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('Error in handleTLAccept:', error);
  }
}

async function handleTLDone(interaction) {
  try {
    const parts = interaction.customId.split('_');
    const agentId = parts[2];
    const tlId = parts[3];

    if (tlId && interaction.user.id !== tlId) {
      return interaction.reply({ content: '❌ Only the Team Leader who accepted this request can mark it as done.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const messageId = interaction.message.id;
    const request = activeCallRequests.get(messageId);

    let durationStr = '';
    if (request && request.acceptTime) {
      const durationMs = Date.now() - request.acceptTime;
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      durationStr = `\n**Assisting Duration:** \`${minutes}m ${seconds}s\``;
    }
    activeCallRequests.delete(messageId);

    let newDesc = interaction.message.embeds[0].description.replace(/:R>/g, ':t>');
    newDesc = newDesc.replace(/\n\*\*Status:\*\*.*$/, `\n**Status:** 🏁 Resolved by ${interaction.user.username}${durationStr}`);

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setTitle('✅ Assistance Completed')
      .setDescription(newDesc)
      .setColor(0x57F287);

    await interaction.editReply({ embeds: [embed], components: [] });

    sendAuditLog(interaction.client, {
      title: '✅ Tools: Assistance Completed',
      description: `**Agent:** <@${agentId}>\n**Resolved By:** ${interaction.user.username} (<@${interaction.user.id}>)${durationStr}`,
      color: 0x57F287,
      hotelId: request ? request.hotelId : null
    });
  } catch (error) {
    console.error('Error in handleTLDone:', error);
  }
}

async function handleBioBreak(interaction) {
  try {
    const userId = interaction.user.id;
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(userId);
    const session = db.prepare("SELECT id, hotel_id FROM sessions WHERE agent_id = ? AND status = 'active'").get(agent.id);
    const hotelName = HOTEL_NAMES[session.hotel_id] || session.hotel_id;

    if (activeBioBreaks.has(userId)) {
      return interaction.reply({ content: '⚠️ You are already on a Bio break.', ephemeral: true });
    }

    const nowIso = new Date().toISOString();
    // Bio breaks are automatic - update DB immediately
    db.prepare("UPDATE sessions SET break_status = 'Bio Break', break_start_time = ? WHERE id = ?").run(nowIso, session.id);
    activeBioBreaks.set(userId, { startTime: Date.now(), type: 'Bio Break' });

    // Update persistent embed immediately
    await updateHotelStatusEmbed(interaction.client, session.hotel_id);

    // Notify agent with "Return" button
    const pingEmbed = new EmbedBuilder()
      .setTitle(`🚽 Bio Break Started`)
      .setDescription(`✅ Your Bio Break has started.\n**Started at:** <t:${Math.floor(Date.now() / 1000)}:T>\n\nPlease click the button below when you return!`)
      .setColor(0xFEE75C);

    const doneBtn = new ButtonBuilder()
      .setCustomId(`tools_end_bio_${userId}`)
      .setLabel(`🛑 Done Bio Break`)
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(doneBtn);
    await interaction.reply({ embeds: [pingEmbed], components: [row], ephemeral: true });

    // Inform Team Leaders (Notification Only)
    const channel = await interaction.client.channels.fetch(TL_ALERT_CHANNEL_ID);
    if (channel) {
      const tlEmbed = new EmbedBuilder()
        .setTitle('📢 Bio Break Notification')
        .setDescription(`**Agent:** <@${userId}>\n**Hotel:** **${hotelName}**\n**Started:** <t:${Math.floor(Date.now() / 1000)}:R>\n*Note: Bio breaks are automatic and do not require approval.*`)
        .setColor(0xFEE75C)
        .setTimestamp();
      await channel.send({ embeds: [tlEmbed] });
    }

    // Audit log
    sendAuditLog(interaction.client, {
      title: '🚽 Tools: Bio Break Started (Auto)',
      description: `**Agent:** <@${userId}>\n**Hotel:** ${hotelName}\n**Time:** <t:${Math.floor(Date.now() / 1000)}:T>`,
      color: 0xFEE75C,
      hotelId: session.hotel_id
    });
    
  } catch (error) {
    console.error('Error in handleBioBreak:', error);
  }
}

async function handleBioApprove(interaction) {
  try {
    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id);
    const tlRole = guild.roles.cache.find(r => r.name.toLowerCase() === TEAM_LEADER_ROLE_NAME.toLowerCase());
    if (tlRole && !member.roles.cache.has(tlRole.id) && !interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Only management staff can approve breaks.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const agentId = interaction.customId.replace('bio_approve_', '');
    const messageId = interaction.message.id;

    const request = activeCallRequests.get(messageId);
    let channelId = null;

    if (request) {
      clearTimeout(request.timeout);
      channelId = request.channelId;
      activeCallRequests.delete(messageId);
    }

    const requestType = request ? request.type : 'Bio Break';
    const breakEmoji = requestType === 'Normal Break' ? '☕' : '🚽';

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setDescription(interaction.message.embeds[0].description.replace(/:R>/g, ':t>').replace('Waiting for Team Leader...', `✅ Approved by ${interaction.user.username}`))
      .setColor(0x57F287);

    await interaction.editReply({ embeds: [embed], components: [] });

    // Grant On-break role
    const agentMember = await guild.members.fetch(agentId);
    const breakRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'on-break' || r.name.toLowerCase() === 'on-bio');
    if (breakRole) {
      await agentMember.roles.add(breakRole).catch(console.error);
    }

    // Ping agent in their channel
    if (channelId) {
      try {
        const channel = await interaction.client.channels.fetch(channelId);
        if (channel) {
          const pingEmbed = new EmbedBuilder()
            .setTitle(`${breakEmoji} ${requestType} Approved`)
            .setDescription(`✅ <@${agentId}>, your ${requestType} was approved by **<@${interaction.user.id}>**.\n**Started at:** <t:${Math.floor(Date.now() / 1000)}:T>\n\nClick the button below when you return!`)
            .setColor(requestType === 'Normal Break' ? 0xE67E22 : 0x5865F2);

          const doneBtn = new ButtonBuilder()
            .setCustomId(`tools_end_bio_${agentId}`)
            .setLabel(`🛑 Done ${requestType.split(' ')[0]}`)
            .setStyle(ButtonStyle.Danger);

          const row = new ActionRowBuilder().addComponents(doneBtn);
          await channel.send({ content: `<@${agentId}>`, embeds: [pingEmbed], components: [row] });
        }
      } catch (e) { console.warn('Could not send break approved ping:', e.message); }
    }

    // Audit log
    const agentDb = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(agentId);
    if (agentDb) {
      const session = db.prepare("SELECT id, hotel_id FROM sessions WHERE agent_id = ? AND status = 'active'").get(agentDb.id);
      const hotelName = HOTEL_NAMES[session.hotel_id] || session.hotel_id;

      const nowIso = new Date().toISOString();
      // Update DB with break info
      db.prepare("UPDATE sessions SET break_status = ?, break_covering_id = ?, break_start_time = ? WHERE id = ?").run(requestType, interaction.user.id, nowIso, session.id);

      // Update persistent embed
      await updateHotelStatusEmbed(interaction.client, session.hotel_id);

      sendAuditLog(interaction.client, {
        title: `${breakEmoji} Tools: ${requestType} Started`,
        description: `**Agent:** <@${agentId}>\n**Hotel:** ${hotelName}\n**Approved By:** ${interaction.user.username}\n**Time:** <t:${Math.floor(Date.now() / 1000)}:T>`,
        color: requestType === 'Normal Break' ? 0xE67E22 : 0x5865F2,
        hotelId: session.hotel_id
      });
      
    }

    activeBioBreaks.set(agentId, { startTime: Date.now(), type: requestType });

  } catch (error) {
    console.error('Error in handleBioApprove:', error);
  }
}

async function handleBioDeny(interaction) {
  try {
    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id);
    const tlRole = guild.roles.cache.find(r => r.name.toLowerCase() === TEAM_LEADER_ROLE_NAME.toLowerCase());
    if (tlRole && !member.roles.cache.has(tlRole.id) && !interactionHasRoleAtLeast(interaction, 'sme')) {
      return interaction.reply({ content: '❌ Only management staff can deny breaks.', ephemeral: true });
    }

    const agentId = interaction.customId.replace('bio_deny_', '');
    const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
    const sourceChannelId = interaction.channelId || interaction.message?.channelId;
    const sourceMessageId = interaction.message?.id;

    const modal = new ModalBuilder()
      .setCustomId(`bio_deny_modal:${agentId}:${sourceChannelId}:${sourceMessageId}`)
      .setTitle('Deny Bio Break');

    const reasonInput = new TextInputBuilder()
      .setCustomId('deny_reason')
      .setLabel('Reason for denial:')
      .setPlaceholder('e.g. Currently On-Break, Covering Break')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  } catch (error) {
    console.error('Error in handleBioDeny:', error);
  }
}

async function handleBioDenySubmit(interaction) {
  try {
    const parseModalContext = customId => {
      const value = String(customId || '');
      if (value.startsWith('bio_deny_modal:')) {
        const [, agentId, channelId, messageId] = value.split(':');
        return { agentId, channelId, messageId };
      }
      const parts = value.split('_');
      return { agentId: parts[3], channelId: null, messageId: parts[4] };
    };

    const { agentId, channelId: customIdChannelId, messageId } = parseModalContext(interaction.customId);
    const reason = interaction.fields.getTextInputValue('deny_reason');

    const request = activeCallRequests.get(messageId);
    let channelId = customIdChannelId || null;

    if (request) {
      clearTimeout(request.timeout);
      channelId = channelId || request.channelId;
      activeCallRequests.delete(messageId);
    }

    const requestType = request ? request.type : 'Bio Break';

    try {
      let originalMsg = null;
      if (channelId && messageId) {
        const sourceChannel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (sourceChannel?.isTextBased?.()) {
          originalMsg = await sourceChannel.messages.fetch(messageId).catch(() => null);
        }
      }
      if (!originalMsg && interaction.channel?.isTextBased?.() && messageId) {
        originalMsg = await interaction.channel.messages.fetch(messageId).catch(() => null);
      }

      if (originalMsg && originalMsg.embeds?.[0]) {
        const embed = EmbedBuilder.from(originalMsg.embeds[0])
          .setDescription(originalMsg.embeds[0].description.replace(/:R>/g, ':t>').replace('Waiting for Team Leader...', `Denied by ${interaction.user.username}\n**Reason:** ${reason}`))
          .setColor(0xED4245);
        await originalMsg.edit({ embeds: [embed], components: [] });
      }
    } catch (e) {
      console.error('Could not edit denied alert:', e.message);
    }

    await interaction.reply({ content: `Request denied: ${requestType}.`, ephemeral: true });

    if (channelId) {
      try {
        const channel = await interaction.client.channels.fetch(channelId);
        if (channel) {
          const pingEmbed = new EmbedBuilder()
            .setTitle(`${requestType} Denied`)
            .setDescription(`**<@${interaction.user.id}>** denied your ${requestType} request.\n**Reason:** ${reason}`)
            .setColor(0xED4245);
          await channel.send({ content: `<@${agentId}>`, embeds: [pingEmbed] });
        }
      } catch (e) {
        console.warn('Could not send break denied ping:', e.message);
      }
    }
  } catch (error) {
    console.error('Error in handleBioDenySubmit:', error);
  }
}

async function handleEndBioBreak(interaction) {
  try {
    const parts = interaction.customId.split('_');
    const agentId = parts[3];

    if (agentId && interaction.user.id !== agentId) {
       return interaction.reply({ content: '❌ Only the agent who started this break can end it.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const userId = interaction.user.id;
    const breakData = activeBioBreaks.get(userId);

    if (!breakData) {
      return interaction.followUp({ content: '❌ You are not currently on an active Bio break within this session or the server restarted.', ephemeral: true });
    }

    activeBioBreaks.delete(userId);

    // Remove On-break role
    const guild = interaction.guild;
    const agentMember = await guild.members.fetch(userId);
    const breakRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'on-break' || r.name.toLowerCase() === 'on-bio');
    if (breakRole) {
      await agentMember.roles.remove(breakRole).catch(console.error);
    }

    const durationMs = Date.now() - breakData.startTime;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);

    const requestType = breakData.type || 'Bio Break';
    const breakEmoji = requestType === 'Normal Break' ? '☕' : '🚽';

    const isStatusEmbed = interaction.message.embeds[0]?.title?.includes('Status');

    if (isStatusEmbed) {
      // Just update DB and let updateHotelStatusEmbed handle the refresh
      const agentDb = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(userId);
      if (agentDb) {
        const session = db.prepare("SELECT hotel_id FROM sessions WHERE agent_id = ? AND status = 'active'").get(agentDb.id);
        if (session) {
          db.prepare("UPDATE sessions SET break_status = NULL, break_covering_id = NULL, break_start_time = NULL WHERE id = (SELECT id FROM sessions WHERE agent_id = ? AND status = 'active')").run(agentDb.id);
          await updateHotelStatusEmbed(interaction.client, session.hotel_id);
        }
      }
      
      // Send a small ephemeral confirmation
      return interaction.followUp({ content: `✅ ${requestType} ended. Status updated.`, ephemeral: true });
    }

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setTitle(`✅ ${requestType} Ended`)
      .setDescription(`Welcome back! Your ${requestType} has ended.\n**Duration:** \`${minutes}m ${seconds}s\``)
      .setColor(0x57F287);

    await interaction.editReply({ embeds: [embed], components: [] });

    const agentDb = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(userId);
    if (agentDb) {
      const session = db.prepare("SELECT id, hotel_id FROM sessions WHERE agent_id = ? AND status = 'active'").get(agentDb.id);
      if (session) {
        // Clear DB break info
        db.prepare("UPDATE sessions SET break_status = NULL, break_covering_id = NULL, break_start_time = NULL WHERE id = ?").run(session.id);

        // Update persistent embed
        await updateHotelStatusEmbed(interaction.client, session.hotel_id);
      }
    }

    sendAuditLog(interaction.client, {
      title: `✅ Tools: ${requestType} Ended`,
      description: `**Agent:** ${interaction.user.username} (<@${userId}>)\n**Duration:** \`${minutes}m ${seconds}s\``,
      color: 0x57F287,
      userId: userId,
      hotelId: (db.prepare("SELECT hotel_id FROM sessions WHERE agent_id = (SELECT id FROM agents WHERE discord_id = ?) AND status = 'active'").get(userId))?.hotel_id
    });
    
  } catch (error) {
    console.error('Error in handleEndBioBreak:', error);
  }
}

// ─── Call Agent Flow ────────────────────────────────
async function handleCallAgentMenu(interaction) {
  try {
    const activeAgents = db.prepare(`
      SELECT agents.discord_id, agents.username, sessions.hotel_id 
      FROM sessions 
      JOIN agents ON sessions.agent_id = agents.id 
      WHERE sessions.status = 'active'
    `).all();

    if (activeAgents.length === 0) {
      return interaction.reply({ content: '❌ No agents are currently on shift.', ephemeral: true });
    }

    const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
    const select = new StringSelectMenuBuilder()
      .setCustomId('tl_call_select_agent')
      .setPlaceholder('Select an agent to call...')
      .addOptions(
        activeAgents.map(a => 
          new StringSelectMenuOptionBuilder()
            .setLabel(a.username)
            .setDescription(`At ${HOTEL_NAMES[a.hotel_id] || a.hotel_id}`)
            .setValue(a.discord_id)
        )
      );

    const row = new ActionRowBuilder().addComponents(select);
    await interaction.reply({ content: '☎️ **Select the agent you wish to call:**', components: [row], ephemeral: true });
  } catch (e) { console.error(e); }
}

async function handleAgentCallStart(interaction) {
  try {
    const targetId = interaction.values[0];
    const agent = db.prepare("SELECT * FROM agents WHERE discord_id = ?").get(targetId);
    
    if (!agent || !agent.phone) {
      return interaction.reply({ content: `❌ Agent <@${targetId}> does not have a phone number registered.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // 2. Discord Audit Check
    const guild = interaction.guild;
    const member = await guild.members.fetch(targetId);
    
    // Check if in VC
    const voiceState = member.voice;
    let attentive = false;
    if (voiceState.channel) {
       attentive = true; // Simple heuristic: Being in a VC is "attentive"
    }

    // 3. Result UI
    const resultEmbed = new EmbedBuilder()
      .setTitle(attentive ? '✅ Agent is Attentive and Active!' : '⚠️ Agent Audit: Potential Inactivity')
      .setDescription(`**Audited agent:** <@${targetId}>\n**Status:** ${attentive ? 'Connected to Voice Channel' : 'NOT in Voice Channel'}\n**Portal Notice:** Logged in Discord only.`)
      .setColor(attentive ? 0x57F287 : 0xED4245)
      .setTimestamp();

    await interaction.editReply({ embeds: [resultEmbed] });

    if (!attentive) {
      // Send "Give a reason" DM to agent
      try {
        const reasonEmbed = new EmbedBuilder()
          .setTitle('🚨 Manager Audit Notification')
          .setDescription(`Your Team Leader, **${interaction.user.username}**, just attempted to call you for an activity check, but you were not detected in a voice channel or active window.\n\n**Action Required:** Please provide a reason why you were unavailable.`)
          .setColor(0xED4245)
          .setFooter({ text: 'Aavgo Operations Security' });
        
        await member.send({ embeds: [reasonEmbed] });
      } catch (e) { console.warn('[CALL] Could not DM agent:', e.message); }
    } else {
       // If attentive, the user said "just leave instantly"
       // If the bot joins the VC to check, it should leave.
       // For now, we are just checking voiceState.channel which doesn't require joining.
    }

    // Audit log
    sendAuditLog(interaction.client, {
      title: '📞 Agent Call Audit',
      description: `**TL:** ${interaction.user.username}\n**Agent:** <@${targetId}>\n**Result:** ${attentive ? 'Attentive' : 'Inactive/Missing'}`,
      color: attentive ? 0x57F287 : 0xED4245,
      userId: targetId
    });

  } catch (error) {
    console.error('Error in handleAgentCallStart:', error);
  }
}

module.exports = {
  handleToolsCommand,
  handleNormalBreak,
  handleEmergency,
  handleTLAccept,
  handleTLDone,
  handleBioBreak,
  handleBioApprove,
  handleBioDeny,
  handleBioDenySubmit,
  handleEndBioBreak,
  handleCallAgentMenu,
  handleAgentCallStart
};

