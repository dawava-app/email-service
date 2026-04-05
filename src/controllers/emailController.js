const { renderTemplate, renderRowTemplate } = require('../services/templateService');
const { sendViaMailjet, buildMessage } = require('../services/sendProvider');
const { checkAndSet } = require('../utils/idempotencyStore');
const { parseSheetFromFile, parseSheetFromUrl } = require('../utils/sheetParser');
const config = require('../config');

async function sendEmailDirect(req, res, next) {
  try {
    const payload = req.body;
    if (payload.templateId && !payload.text && !payload.html) {
      const rendered = renderTemplate(payload.templateId, payload.templateVersion, payload.templateVars || {});
      payload.text = rendered; // simple text fallback
    }
    const msg = buildMessage(payload);
    const result = await sendViaMailjet(msg);
    if (result.success) {
      return res.status(202).json({ status: 'sent' });
    }
    return res.status(500).json({ status: 'failed', error: result.error });
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
}

// Bulk templated send using ad-hoc row data and a template string.
// Request body shape:
// {
//   headers: ["email", "name", "age", ...], // headers must include 'email' (any position)
//   rows: [["a@x.com", "Alice", 23], ...],
//   template: "Hello {{name}} your email {{1}} age {{3}}",
//   subjectTemplate: "Welcome {{name}}", // optional
//   dryRun: true // optional
// }
async function bulkTemplatedSend(req, res, next) {
  try {
    const { headers, rows, template, subjectTemplate, dryRun } = req.body || {};
    const emailIdx = headers.findIndex(h => String(h).toLowerCase() === 'email');
    const subjTpl = typeof subjectTemplate === 'string' && subjectTemplate.trim() ? subjectTemplate : 'Notification';
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

    const rendered = [];
    const failures = [];
    let successCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length !== headers.length) {
        failures.push({ index: i, error: 'row length mismatch' });
        continue;
      }
      const email = row[emailIdx];
      if (typeof email !== 'string' || !emailRegex.test(email)) {
        failures.push({ index: i, error: 'invalid email' });
        continue;
      }
      const body = renderRowTemplate(template, headers, row);
      const subject = renderRowTemplate(subjTpl, headers, row);
      rendered.push({ email, subject, body });
    }

    if (dryRun) {
      return res.status(200).json({ status: 'ok', dryRun: true, total: rows.length, successCount: rendered.length, failureCount: failures.length, rendered, failures });
    }

    // Send emails one by one (could be optimized later)
    for (const item of rendered) {
      try {
        const payload = { to: [item.email], subject: item.subject, text: item.body };
        // idempotency per email+subject
        payload.idempotencyKey = `${item.email}|${item.subject}`;
        if (!checkAndSet(payload)) {
          failures.push({ email: item.email, error: 'duplicate_skipped' });
          continue;
        }
        const msg = buildMessage(payload);
        const result = await sendViaMailjet(msg);
        if (result.success) successCount++; else failures.push({ email: item.email, error: result.error || 'send_failed' });
      } catch (e) {
        failures.push({ email: item.email, error: e.message });
      }
    }

    return res.status(202).json({ status: 'sent', dryRun: false, total: rows.length, successCount, failureCount: failures.length, failures });
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
}

// Bulk templated send using uploaded sheet file or sheet URL.
// Accepts same template fields as bulkTemplatedSend but instead of rows+headers directly:
//  - Provide multipart form with field `sheet` (file) OR JSON body with { sheetUrl }
//  - Supports CSV, TSV, XLSX
// Request body (JSON if using sheetUrl):
// {
//   sheetUrl: "https://.../file.csv",
//   template: "Hello {{name}}",
//   subjectTemplate: "Welcome {{name}}",
//   dryRun: true
// }
async function bulkTemplatedSendSheet(req, res, next) {
  try {
    const { template, subjectTemplate, dryRun, sheetUrl } = req.body || {};
    const subjTpl = typeof subjectTemplate === 'string' && subjectTemplate.trim() ? subjectTemplate : 'Notification';
    let headers, rows;

    if (req.file) {
      ({ headers, rows } = await parseSheetFromFile(req.file));
    } else if (sheetUrl) {
      ({ headers, rows } = await parseSheetFromUrl(sheetUrl, { allowlist: config.sheetUrlAllowlist }));
    }

    if (!Array.isArray(headers) || !headers.length) { const err = new Error('parsed headers empty'); err.status = 400; throw err; }
    const emailIdx = headers.findIndex(h => String(h).toLowerCase() === 'email');
    if (emailIdx === -1) { const err = new Error("sheet must include 'email' column"); err.status = 400; throw err; }
    if (!Array.isArray(rows) || !rows.length) { const err = new Error('no data rows parsed'); err.status = 400; throw err; }

    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const rendered = [];
    const failures = [];
    let successCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length < headers.length) { // allow shorter rows (missing trailing values)
        // pad row
        while (row.length < headers.length) row.push('');
      }
      const email = row[emailIdx];
      if (typeof email !== 'string' || !emailRegex.test(email)) { failures.push({ index: i, error: 'invalid email' }); continue; }
      const body = renderRowTemplate(template, headers, row);
      const subject = renderRowTemplate(subjTpl, headers, row);
      rendered.push({ email, subject, body });
    }

    if (dryRun) {
      return res.status(200).json({ status: 'ok', dryRun: true, total: rows.length, successCount: rendered.length, failureCount: failures.length, headers, rendered, failures });
    }

    for (const item of rendered) {
      try {
        const payload = { to: [item.email], subject: item.subject, text: item.body };
        payload.idempotencyKey = `${item.email}|${item.subject}`;
        if (!checkAndSet(payload)) { failures.push({ email: item.email, error: 'duplicate_skipped' }); continue; }
        const msg = buildMessage(payload);
        const result = await sendViaMailjet(msg);
        if (result.success) successCount++; else failures.push({ email: item.email, error: result.error || 'send_failed' });
      } catch (e) {
        failures.push({ email: item.email, error: e.message });
      }
    }

    return res.status(202).json({ status: 'sent', dryRun: false, total: rows.length, successCount, failureCount: failures.length, headers, failures });
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
}

module.exports = { sendEmailDirect, bulkTemplatedSend, bulkTemplatedSendSheet };
