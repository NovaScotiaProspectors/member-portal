const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipExpiryDate } = require('../server/membershipExpiry');

test('NSPA activation expiry stays in the current calendar year', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  assert.equal(
    membershipExpiryDate({ newMember: false, now }),
    '2026-12-31T23:59:59.000Z'
  );
});

test('paid first-time enrolments after July receive the next membership year', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  assert.equal(
    membershipExpiryDate({ newMember: true, now }),
    '2027-12-31T23:59:59.000Z'
  );
});
