const BOT_STATUS_CHANNEL_ID = '1483667047660388484';
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const STATUS_FOOTER = 'Aavgo Operations - Bot Health';
const STATUS_STALE_NOTE = 'If the last update is older than 90 seconds, treat the bot as offline or stale.';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const BASE_RETRY_MS = 800;
const WARN_THROTTLE_MS = 90000;

let cachedStatusMessageId = null;
let lastWarnAt = 0;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 250);
}

function parseRetryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.floor(seconds * 1000);
  }
  return null;
}

async function discordRequest(path, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN missing');
  }

  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await fetch(`${DISCORD_API_BASE}${path}`, {
        ...options,
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });

      if (response.ok) {
        if (response.status === 204) return null;
        return response.json();
      }

      const body = await response.text().catch(() => '');
      const error = new Error(`Discord API ${response.status}: ${body}`);
      error.status = response.status;

      const retryAfterMs = parseRetryAfterMs(response);
      const canRetry = RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES - 1;
      if (!canRetry) {
        throw error;
      }

      const backoff = retryAfterMs || jitter(BASE_RETRY_MS * (2 ** attempt));
      await sleep(backoff);
      attempt += 1;
      lastError = error;
    } catch (error) {
      const canRetry = attempt < MAX_RETRIES - 1;
      if (!canRetry) {
        throw error;
      }

      lastError = error;
      const backoff = jitter(BASE_RETRY_MS * (2 ** attempt));
      await sleep(backoff);
      attempt += 1;
    }
  }

  if (lastError) throw lastError;
  throw new Error('Unknown Discord request failure');
}

async function findExistingStatusMessage() {
  const messages = await discordRequest(`/channels/${BOT_STATUS_CHANNEL_ID}/messages?limit=20`);
  return messages.find(message =>
    message.author?.bot &&
    Array.isArray(message.embeds) &&
    message.embeds.some(embed => embed.footer?.text === STATUS_FOOTER)
  ) || null;
}

async function patchStatusMessage(messageId, payload) {
  await discordRequest(`/channels/${BOT_STATUS_CHANNEL_ID}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

function shouldThrottleWarn() {
  const now = Date.now();
  if (now - lastWarnAt < WARN_THROTTLE_MS) return true;
  lastWarnAt = now;
  return false;
}

async function upsertBotStatusCard({ title, description, color, stateLabel }) {
  const payload = {
    embeds: [buildEmbed({ title, description, color, stateLabel })]
  };

  try {
    if (cachedStatusMessageId) {
      try {
        await patchStatusMessage(cachedStatusMessageId, payload);
        return cachedStatusMessageId;
      } catch (error) {
        if (error?.status !== 404) {
          throw error;
        }
        cachedStatusMessageId = null;
      }
    }

    const existing = await findExistingStatusMessage();
    if (existing) {
      cachedStatusMessageId = existing.id;
      await patchStatusMessage(existing.id, payload);
      return existing.id;
    }

    const created = await discordRequest(`/channels/${BOT_STATUS_CHANNEL_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    cachedStatusMessageId = created.id;
    return created.id;
  } catch (error) {
    if (!shouldThrottleWarn()) {
      console.warn('[BOT-STATUS] Failed to upsert status card:', error.message);
    }
    return null;
  }
}

module.exports = {
  BOT_STATUS_CHANNEL_ID,
  upsertBotStatusCard
};
