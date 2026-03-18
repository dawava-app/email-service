require('dotenv').config();

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseAllowlist(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.EMAIL_SERVICE_PORT || '5060', 10),
  runApi: parseBoolean(process.env.RUN_API, true),
  runConsumer: parseBoolean(process.env.RUN_CONSUMER, true),
  streamName: process.env.REDIS_STREAM_EMAIL || 'email_events',
  maxRetries: parseInt(process.env.EMAIL_MAX_RETRIES || '5', 10),
  serviceAuthToken: process.env.EMAIL_SERVICE_AUTH_TOKEN || '',
  allowRemoteSheetUrl: parseBoolean(process.env.ENABLE_REMOTE_SHEET_URL, false),
  sheetUrlAllowlist: parseAllowlist(process.env.SHEET_URL_ALLOWLIST),
  mailjet: {
    apiKey: process.env.MAILJET_API_KEY,
    apiSecret: process.env.MAILJET_API_SECRET
  },
  defaultFrom: process.env.EMAIL_DEFAULT_FROM,
  redis: {
    url: process.env.REDIS_URL,
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined
  }
};
