const { streamName, redis, maxRetries } = require('../config');
const logger = require('../utils/logger');
const { validateEmailPayload } = require('../validation');
const { renderTemplate } = require('../services/templateService');
const { checkAndSet } = require('../utils/idempotencyStore');
const { randomUUID } = require('crypto');

const GROUP = 'email_service_group';
const SUPPORTED_SCHEMA_VERSION = '1.0';

let sendProvider;
function getSendProvider() {
  if (!sendProvider) {
    sendProvider = require('../services/sendProvider');
  }
  return sendProvider;
}

function getRedisClient() {
  return require('ioredis');
}

function parseEntry(entry) {
  const obj = {};
  for (let i = 0; i < entry[1].length; i += 2) {
    obj[entry[1][i]] = entry[1][i + 1];
  }
  try { return JSON.parse(obj.payload); } catch { return null; }
}

function logSchemaVersionCompatibility(payload, loggerRef = logger) {
  const version = typeof payload?.schemaVersion === 'string'
    ? payload.schemaVersion.trim()
    : '';

  if (!version) {
    loggerRef.warn(
      { id: payload?.id || null, eventType: payload?.eventType || null },
      'Email payload missing schemaVersion; continuing with compatibility mode'
    );
    return;
  }

  if (version !== SUPPORTED_SCHEMA_VERSION) {
    loggerRef.warn(
      {
        id: payload?.id || null,
        schemaVersion: version,
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      },
      'Email payload schemaVersion is unknown; continuing with compatibility mode'
    );
  }
}

async function processPayloadEntry({
  payload,
  entryId,
  client,
  stream = streamName,
  group = GROUP,
  maxRetryAttempts = maxRetries,
  deps = {},
}) {
  const validatePayload = deps.validateEmailPayload || validateEmailPayload;
  const renderTemplateImpl = deps.renderTemplate || renderTemplate;
  const provider = (deps.buildMessage && deps.sendViaMailjet) ? null : getSendProvider();
  const buildMessageImpl = deps.buildMessage || provider.buildMessage;
  const sendViaMailjetImpl = deps.sendViaMailjet || provider.sendViaMailjet;
  const checkAndSetImpl = deps.checkAndSet || checkAndSet;
  const loggerRef = deps.logger || logger;

  try {
    validatePayload(payload);
    logSchemaVersionCompatibility(payload, loggerRef);

    if (!checkAndSetImpl(payload)) {
      loggerRef.info({ id: payload.id }, 'Duplicate ignored');
      await client.xack(stream, group, entryId);
      await client.xdel(stream, entryId);
      return { status: 'duplicate' };
    }

    if (payload.templateId && !payload.text && !payload.html) {
      payload.text = renderTemplateImpl(payload.templateId, payload.templateVersion, payload.templateVars || {});
    }

    const msg = buildMessageImpl(payload);
    const result = await sendViaMailjetImpl(msg);

    if (!result.success) {
      payload.retries = (payload.retries || 0) + 1;
      if (payload.retries <= maxRetryAttempts) {
        await client.xadd(stream, '*', 'payload', JSON.stringify({ ...payload, id: randomUUID() }));
        loggerRef.warn({ retries: payload.retries }, 'Retry enqueued');
      } else {
        loggerRef.error({ id: payload.id }, 'Max retries exceeded');
      }
    }

    await client.xack(stream, group, entryId);
    await client.xdel(stream, entryId);

    if (result.success) return { status: 'sent' };
    return payload.retries <= maxRetryAttempts ? { status: 'retried' } : { status: 'max-retries-exceeded' };
  } catch (err) {
    loggerRef.error({ err }, 'Processing failed');
    await client.xack(stream, group, entryId);
    await client.xdel(stream, entryId);
    return { status: 'failed', error: err.message };
  }
}

async function startConsumer() {
  const Redis = getRedisClient();
  const client = redis.url
    ? new Redis(redis.url)
    : new Redis({ host: redis.host, port: redis.port, password: redis.password });
  await client.ping();
  try {
    await client.xgroup('CREATE', streamName, GROUP, '$', 'MKSTREAM');
  } catch (e) {
    if (!/BUSYGROUP/.test(e.message)) throw e;
  }
  logger.info({ stream: streamName }, 'Email stream consumer started');

  async function loop() {
    try {
      const entries = await client.xreadgroup('GROUP', GROUP, 'consumer-1', 'BLOCK', 5000, 'COUNT', 10, 'STREAMS', streamName, '>');
      if (entries) {
        for (const [, arr] of entries) {
          for (const entry of arr) {
            const payload = parseEntry(entry);
            if (!payload) {
              logger.warn('Invalid payload in stream');
              continue;
            }
            await processPayloadEntry({ payload, entryId: entry[0], client });
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Consumer loop error');
    } finally {
      setImmediate(loop);
    }
  }
  loop();
}

module.exports = {
  GROUP,
  SUPPORTED_SCHEMA_VERSION,
  parseEntry,
  processPayloadEntry,
  startConsumer,
};
