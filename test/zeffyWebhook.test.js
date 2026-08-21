/* The webhook route: what it does with a verified payment, and — the part that
 * matters most — what it does when the same payment arrives twice.
 *
 * Senders retry. A redelivery that reaches activateMembership again would
 * extend an expiry the member never paid for, and a redelivery arriving after
 * a membership lapsed would silently reinstate it. Both are tested here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerIntegrationRoutes } = require('../server/routes/integrations');

const PAYMENT_ID = 'pay_12345';
const EMAIL = 'member@test.local';

/** A route wired to spies, so each test can see exactly what was touched. */
function harness({ user = { memberId: '00001', email: EMAIL }, verify, studentOk = true, setFailures = 0 } = {}) {
  const settings = new Map();
  const calls = { activate: [], invalidate: [] };

  const handlers = {};
  const app = { post(path, handler) { handlers[path] = handler; } };
  registerIntegrationRoutes(app, {
    zeffy: {
      configured: true,
      verifyCompletedWebhook: verify || (async () => ({
        ok: true, id: PAYMENT_ID, email: EMAIL, plan: 'regular', customerId: 'cus_1',
      })),
    },
    findUserByEmail: async () => user,
    activateMembership: async (...args) => {
      calls.activate.push(args);
      if (user) user.subscriptionId = args[2];
      return true;
    },
    invalidateSessionUser: email => calls.invalidate.push(email),
    studentVerificationOk: async () => studentOk,
    portal: {
      getSetting: async (key, fallback = null) => (settings.has(key) ? settings.get(key) : fallback),
      setSetting: async (key, value) => {
        if (setFailures > 0) {
          setFailures -= 1;
          throw new Error('temporary settings failure');
        }
        settings.set(key, value);
      },
    },
    safely: async (label, fn) => { await fn(); },
  });

  const post = async body => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await handlers['/api/webhooks/zeffy']({ body }, response);
    return { status: response.statusCode, body: response.body };
  };
  return { post, calls, settings, close() {} };
}

test('a verified payment activates the membership', async () => {
  const h = harness();
  try {
    const res = await h.post({ type: 'payment.completed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.activated, true);
    assert.equal(h.calls.activate.length, 1);
    assert.deepEqual(h.calls.activate[0], [EMAIL, 'cus_1', PAYMENT_ID]);
    // The cached session must be dropped or the member stays "pending" until
    // the cache expires.
    assert.deepEqual(h.calls.invalidate, [EMAIL]);
  } finally { h.close(); }
});

test('the payment is recorded once it has been acted on', async () => {
  const h = harness();
  try {
    await h.post({ type: 'payment.completed' });
    const recorded = [...h.settings.entries()];
    assert.equal(recorded.length, 1);
    assert.match(recorded[0][0], new RegExp(PAYMENT_ID));
    assert.equal(recorded[0][1].activated, true);
    assert.equal(recorded[0][1].memberId, '00001');
  } finally { h.close(); }
});

test('a duplicate delivery does not activate again', async () => {
  const h = harness();
  try {
    await h.post({ type: 'payment.completed' });
    const second = await h.post({ type: 'payment.completed' });

    assert.equal(second.status, 200, 'must be 200 so the sender stops retrying');
    assert.equal(second.body.duplicate, true);
    assert.equal(h.calls.activate.length, 1, 'membership must be touched exactly once');
  } finally { h.close(); }
});

test('a retry repairs an event-recording failure without activating twice', async () => {
  const h = harness({ setFailures: 1 });
  try {
    const first = await h.post({ type: 'payment.completed' });
    assert.equal(first.status, 502);
    const retry = await h.post({ type: 'payment.completed' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(h.calls.activate.length, 1);
    assert.equal(h.settings.size, 1);
  } finally { h.close(); }
});

test('ten redeliveries still activate exactly once', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 10; i += 1) await h.post({ type: 'payment.completed' });
    assert.equal(h.calls.activate.length, 1);
  } finally { h.close(); }
});

test('a redelivery after the membership lapsed does not reinstate it', async () => {
  // The dangerous case: activateMembership's own guard only catches a repeat
  // while the member is still active, so an old event replayed later would
  // otherwise hand out a fresh year.
  const h = harness();
  try {
    await h.post({ type: 'payment.completed' });
    h.calls.activate.length = 0;

    const replay = await h.post({ type: 'payment.completed' });
    assert.equal(replay.body.duplicate, true);
    assert.equal(h.calls.activate.length, 0, 'a lapsed membership must not be reinstated by a replay');
  } finally { h.close(); }
});

test('two different payments are both processed', async () => {
  // Idempotency is per payment, not a blanket "only once" — a renewal next
  // year is a different payment and must still work.
  let id = 'pay_first';
  const h = harness({
    verify: async () => ({ ok: true, id, email: EMAIL, plan: 'regular', customerId: 'cus_1' }),
  });
  try {
    await h.post({ type: 'payment.completed' });
    id = 'pay_second';
    await h.post({ type: 'payment.completed' });
    assert.equal(h.calls.activate.length, 2);
  } finally { h.close(); }
});

test('an unverified payment never reaches the membership', async () => {
  const h = harness({ verify: async () => ({ ok: false, status: 400, reason: 'payment_id_mismatch' }) });
  try {
    const res = await h.post({ type: 'payment.completed' });
    assert.equal(res.status, 400);
    assert.equal(h.calls.activate.length, 0);
    assert.equal(h.settings.size, 0, 'a rejected payment must not be recorded as processed');
  } finally { h.close(); }
});

test('an event Zeffy sends that is not a completed payment is acknowledged and ignored', async () => {
  const h = harness({ verify: async () => ({ ok: false, ignored: true, reason: 'unsupported_event' }) });
  try {
    const res = await h.post({ type: 'payment.refunded' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, 'unsupported_event');
    assert.equal(h.calls.activate.length, 0);
  } finally { h.close(); }
});

test('a payer with no portal account remains retryable and is not recorded as done', async () => {
  // They may sign up minutes later; recording it processed would mean the
  // retry that would have caught them is answered as a duplicate.
  const h = harness({ user: null });
  try {
    const res = await h.post({ type: 'payment.completed' });
    assert.equal(res.status, 409);
    assert.equal(res.body.pendingAccountMatch, true);
    assert.equal(h.settings.size, 0);
  } finally { h.close(); }
});

test('a student payment without a verified student account does not activate', async () => {
  const h = harness({
    studentOk: false,
    verify: async () => ({ ok: true, id: PAYMENT_ID, email: EMAIL, plan: 'student', customerId: 'cus_1' }),
  });
  try {
    const res = await h.post({ type: 'payment.completed' });
    assert.equal(res.body.activated, false);
    assert.equal(res.body.reason, 'student_not_verified');
    assert.equal(h.calls.activate.length, 0);
  } finally { h.close(); }
});
