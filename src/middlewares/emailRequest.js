const { validateEmailPayload } = require('../validation');
const { checkAndSet } = require('../utils/idempotencyStore');

function validateEmailRequest(req, res, next) {
  try {
    validateEmailPayload(req.body);
    return next();
  } catch (err) {
    return next(err);
  }
}

function ensureUniqueEmailRequest(req, res, next) {
  try {
    if (!checkAndSet(req.body)) {
      return res.status(202).json({ status: 'duplicate_ignored' });
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { validateEmailRequest, ensureUniqueEmailRequest };