const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveKsRequestsOptions } = require('../lib/ks-request-query');

test('parses updated_since query into a valid Date', () => {
  const result = resolveKsRequestsOptions({ updated_since: '2024-01-02T03:04:05.000Z' });
  assert.equal(result.updatedSinceRaw, '2024-01-02T03:04:05.000Z');
  assert.ok(result.updatedSince instanceof Date);
  assert.equal(result.updatedSince.toISOString(), '2024-01-02T03:04:05.000Z');
});

test('supports updatedSince alias and ignores invalid values', () => {
  assert.deepStrictEqual(resolveKsRequestsOptions({ updatedSince: '2024-10-01T00:00:00.000Z' }), {
    updatedSinceRaw: '2024-10-01T00:00:00.000Z',
    updatedSince: new Date('2024-10-01T00:00:00.000Z')
  });

  assert.deepStrictEqual(resolveKsRequestsOptions({ updated_since: 'not-a-date' }), {
    updatedSinceRaw: 'not-a-date',
    updatedSince: null
  });
});
