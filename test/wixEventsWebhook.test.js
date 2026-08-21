const test = require('node:test');
const assert = require('node:assert/strict');

const { registerIntegrationRoutes } = require('../server/routes/integrations');

function harness() {
  const handlers = {};
  const settings = new Map();
  const events = new Map();
  const calls = { create: 0, link: 0, activity: 0 };
  const app = { post(path, handler) { handlers[path] = handler; } };
  const syncedEvent = {
    wixEventId: 'wix-event-1',
    title: 'NSPA Field Trip',
    category: 'field_trip',
    description: 'A short description.',
    location: 'Cape Breton',
    startsAt: '2026-09-15T12:00:00.000Z',
    endsAt: null,
    capacity: 20,
    registrationOpen: true,
    createdBy: 'wix:wix-event-1',
    files: [],
  };
  registerIntegrationRoutes(app, {
    zeffy: { configured: false },
    wixEvents: {
      configured: true,
      registrationLinkConfigured: true,
      process: () => ({
        event: syncedEvent,
        instanceId: 'instance-1',
        deliveryId: 'delivery-1',
      }),
      linkRegistration: async input => {
        calls.link += 1;
        calls.linkInput = input;
      },
    },
    appBaseUrl: 'https://portal.example',
    portal: {
      getSetting: async (key, fallback = null) => settings.has(key) ? settings.get(key) : fallback,
      setSetting: async (key, value) => settings.set(key, value),
      findEventByWixEventId: async id => events.get(id) || null,
      createEvent: async event => {
        calls.create += 1;
        calls.createdEvent = event;
        events.set(event.wixEventId, 42);
        return 42;
      },
      recordActivity: async () => { calls.activity += 1; },
    },
  });

  async function post() {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handlers['/api/webhooks/wix-events']({ body: 'signed-jwt', headers: {} }, response);
    return response;
  }

  return { post, calls, settings };
}

test('a Wix event is stored once, without files, and linked back to portal registration', async () => {
  const h = harness();
  const first = await h.post();
  const duplicate = await h.post();

  assert.equal(first.statusCode, 201);
  assert.equal(first.body.eventId, 42);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.link, 1);
  assert.equal(h.calls.activity, 1);
  assert.deepEqual(h.calls.createdEvent.files, []);
  assert.equal(
    h.calls.linkInput.registrationUrl,
    'https://portal.example/events.html?wixEventId=wix-event-1'
  );
});
