const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schema = require('./emailSchema.json');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const NULLABLE_OPTIONAL_FIELDS = [
  'id',
  'schemaVersion',
  'correlationId',
  'idempotencyKey',
  'eventType',
  'text',
  'html',
  'templateId',
  'templateVersion',
  'templateVars',
  'attachments',
  'priority',
  'scheduledFor',
  'retries',
  'createdAt',
  'cc',
  'bcc',
];

function normalizeOptionalNulls(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return;
  }

  for (const field of NULLABLE_OPTIONAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] === null) {
      delete payload[field];
    }
  }
}

function validateEmailPayload(payload) {
  normalizeOptionalNulls(payload);
  const valid = validate(payload);
  if (!valid) {
    const errors = validate.errors.map(e => `${e.instancePath} ${e.message}`).join(', ');
    const error = new Error(`Invalid email payload: ${errors}`);
    error.status = 400;
    throw error;
  }
}

module.exports = { validateEmailPayload };
