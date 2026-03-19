const BOT_STATUS_CHANNEL_ID = '1483667047660388484';
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const STATUS_FOOTER = 'Aavgo Operations • Bot Health';
const STATUS_STALE_NOTE = 'If the last update is older than 90 seconds, treat the bot as offline or stale.';

function buildEmbed({ title, description, color, stateLabel }) {
  return {
    title,
    description,
    color,
    timestamp: new Date().toISOString(),
    footer: { text: STATUS_FOOTER },
    fields: [
      {
        name: 'Bot Status',
        value: stateLabel,
        inline: true
      },
      {
        name: 'Last Heartbeat',
        value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
        inline: true
      },
      {
        name: 'Deploy Rule',
        value: 'Restart the host to pull the latest GitHub commit.',
        inline: false
      },
      {
        name: 'Freshness Check',
        value: STATUS_STALE_NOTE,
        inline: false
      }
    ]
  };
}

async function discordRequest(path, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN missing');
  }

  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function findExistingStatusMessage() {
  const messages = await discordRequest(`/channels/${BOT_STATUS_CHANNEL_ID}/messages?limit=20`);
  return messages.find(message =>
    message.author?.bot &&
    Array.isArray(message.embeds) &&
    message.embeds.some(embed => embed.footer?.text === STATUS_FOOTER)
  ) || null;
}

async function upsertBotStatusCard({ title, description, color, stateLabel }) {
  const payload = {
    embeds: [buildEmbed({ title, description, color, stateLabel })]
  };

  try {
    const existing = await findExistingStatusMessage();
    if (existing) {
      await discordRequest(`/channels/${BOT_STATUS_CHANNEL_ID}/messages/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      return existing.id;
    }

    const created = await discordRequest(`/channels/${BOT_STATUS_CHANNEL_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return created.id;
  } catch (error) {
    console.warn('[BOT-STATUS] Failed to upsert status card:', error.message);
    return null;
  }
}

module.exports = {
  BOT_STATUS_CHANNEL_ID,
  upsertBotStatusCard
};
