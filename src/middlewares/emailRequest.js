const { validateEmailPayload } = require('../validation');
const { checkAndSet } = require('../utils/idempotencyStore');
const config = require('../config');

function createHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function validateEmailRequest(req, res, next) {
  try {
    validateEmailPayload(req.body);
    return next();
  } catch (err) {
    return next(err);
  }
}

function ensureEmailIdempotency(req, res, next) {
  try {
    if (!checkAndSet(req.body)) {
      return res.status(202).json({ status: 'duplicate_ignored' });
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

function validateBulkTemplateRequest(req, res, next) {
  const { headers, rows, template } = req.body || {};

  if (!Array.isArray(headers) || !headers.length) {
    return next(createHttpError('headers array required'));
  }

  const emailIdx = headers.findIndex(h => String(h).toLowerCase() === 'email');
  if (emailIdx === -1) {
    return next(createHttpError("headers must include 'email' column"));
  }

  if (!Array.isArray(rows) || !rows.length) {
    return next(createHttpError('rows array required'));
  }

  if (typeof template !== 'string' || !template.trim()) {
    return next(createHttpError('template string required'));
  }

  return next();
}

function validateBulkTemplateSheetRequest(req, res, next) {
  const { template, sheetUrl } = req.body || {};

  if (typeof template !== 'string' || !template.trim()) {
    return next(createHttpError('template string required'));
  }

  if (req.file) {
    return next();
  }

  if (sheetUrl) {
    if (!config.allowRemoteSheetUrl) {
      return next(createHttpError('sheetUrl is disabled by configuration', 403));
    }

    if (!Array.isArray(config.sheetUrlAllowlist) || config.sheetUrlAllowlist.length === 0) {
      return next(createHttpError('sheetUrl allowlist is required when remote URL mode is enabled', 503));
    }

    return next();
  }

  return next(createHttpError('sheet file (field name sheet) or sheetUrl required'));
}

module.exports = {
  validateEmailRequest,
  ensureEmailIdempotency,
  validateBulkTemplateRequest,
  validateBulkTemplateSheetRequest,
};