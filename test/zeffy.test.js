const test = require('node:test');
const assert = require('node:assert/strict');
const { createZeffyService } = require('../server/services/zeffy');

test('verifies a completed membership payment through the Zeffy API', async () => {
  const calls = [];
  const service = createZeffyService({
    apiKey: 'private-key',
    campaigns: { regular: 'regular-campaign' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        id: 'payment-1', status: 'succeeded', campaign: { id: 'regular-campaign' },
        contact: { id: 'contact-1', email: 'MEMBER@example.com' },
      }), { status: 200 });
    },
  });

  const result = await service.verifyCompletedWebhook({ type: 'payment.completed', data: { id: 'payment-1' } });
  assert.equal(result.ok, true);
  assert.equal(result.email, 'member@example.com');
  assert.equal(result.plan, 'regular');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-key');
});

test('does not trust a succeeded status supplied only by the webhook', async () => {
  const service = createZeffyService({
    apiKey: 'private-key',
    campaigns: { regular: 'regular-campaign' },
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'payment-2', status: 'failed', campaign: { id: 'regular-campaign' },
      contact: { email: 'member@example.com' },
    }), { status: 200 }),
  });
  const result = await service.verifyCompletedWebhook({
    type: 'payment.completed',
    data: { id: 'payment-2', status: 'succeeded' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'payment_not_succeeded');
});

test('ignores successful payments from unrelated campaigns', async () => {
  const service = createZeffyService({
    apiKey: 'private-key',
    campaigns: { regular: 'regular-campaign' },
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'payment-3', status: 'succeeded', campaign: { id: 'donation-campaign' },
      contact: { email: 'member@example.com' },
    }), { status: 200 }),
  });
  const result = await service.verifyCompletedWebhook({ type: 'payment.completed', data: { id: 'payment-3' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_membership_campaign');
});

test('is not configured without an approved membership campaign', () => {
  assert.equal(createZeffyService({ apiKey: 'private-key' }).configured, false);
});
