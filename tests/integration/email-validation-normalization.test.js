const test = require('node:test');
const assert = require('node:assert/strict');

const { validateEmailPayload } = require('../../src/validation');

test('validation: null optional html/templateId are normalized and accepted', () => {
  const payload = {
    to: ['user@example.com'],
    subject: 'Welcome',
    text: 'Hello there',
    html: null,
    templateId: null,
  };

  assert.doesNotThrow(() => validateEmailPayload(payload));
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'html'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'templateId'), false);
});

test('validation: still rejects invalid non-string optional field values', () => {
  const payload = {
    to: ['user@example.com'],
    subject: 'Welcome',
    text: 'Hello there',
    templateId: 123,
  };

  assert.throws(
    () => validateEmailPayload(payload),
    /Invalid email payload: \/templateId must be string/i
  );
});