const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  WIX_EVENT_CREATED,
  WIX_EVENT_PUBLISHED,
  createWixEventsService,
  verifyWixJwt,
} = require('../server/services/wixEvents');

function signedWebhook(payload, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

function wixEnvelope(event, deliveryId = 'delivery-1') {
  return {
    data: JSON.stringify({
      instanceId: 'instance-1',
      eventType: WIX_EVENT_CREATED,
      data: JSON.stringify({
        id: deliveryId,
        entityId: event.id,
        createdEvent: { currentEntityAsJson: JSON.stringify(event) },
      }),
    }),
  };
}

test('verifies and normalizes a Wix event without copying media', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const token = signedWebhook(wixEnvelope({
    id: 'wix-event-1',
    title: 'Field Trip to Cape Breton',
    status: 'UPCOMING',
    shortDescription: 'Meet at the trailhead.',
    description: { nodes: [{ type: 'IMAGE', id: 'large-image' }] },
    mainImage: { id: 'large-image', url: 'https://static.wixstatic.com/media/image.jpg' },
    dateAndTimeSettings: {
      startDate: '2026-09-15T12:00:00.000Z',
      endDate: '2026-09-15T16:00:00.000Z',
    },
    location: { name: 'Cape Breton' },
    registration: { status: 'OPEN_RSVP', rsvp: { limit: 25 } },
  }), privateKey);

  const result = createWixEventsService({ publicKey: publicPem }).process(token);
  assert.equal(result.deliveryId, 'delivery-1');
  assert.equal(result.instanceId, 'instance-1');
  assert.equal(result.event.wixEventId, 'wix-event-1');
  assert.equal(result.event.category, 'field_trip');
  assert.equal(result.event.description, 'Meet at the trailhead.');
  assert.equal(result.event.capacity, 25);
  assert.equal(result.event.registrationOpen, true);
  assert.deepEqual(result.event.files, []);
  assert.equal('mainImage' in result.event, false);
});

test('sets the Wix event registration action to the portal URL', async () => {
  const calls = [];
  const service = createWixEventsService({
    appId: 'app-1',
    appSecret: 'secret-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify(
        calls.length === 1 ? { access_token: 'app-token' } : { event: { id: 'wix-event-1' } }
      ), { status: 200 });
    },
  });

  const result = await service.linkRegistration({
    instanceId: 'instance-1',
    wixEventId: 'wix-event-1',
    registrationUrl: 'https://portal.example/events.html?wixEventId=wix-event-1',
  });

  assert.equal(result.linked, true);
  assert.equal(calls[0].body.instance_id, 'instance-1');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(calls[1].options.headers.Authorization, 'app-token');
  assert.deepEqual(calls[1].body.fields, ['REGISTRATION']);
  assert.equal(
    calls[1].body.event.registration.external.url,
    'https://portal.example/events.html?wixEventId=wix-event-1'
  );
});

test('fetches and normalizes an event when Wix publishes a draft', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const published = {
    data: JSON.stringify({
      instanceId: 'instance-1',
      eventType: WIX_EVENT_PUBLISHED,
      data: JSON.stringify({ id: 'delivery-2', entityId: 'wix-event-2', actionEvent: {} }),
    }),
  };
  const calls = [];
  const service = createWixEventsService({
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    appId: 'app-1',
    appSecret: 'secret-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 });
      return new Response(JSON.stringify({
        event: {
          id: 'wix-event-2',
          title: 'Published Workshop',
          status: 'UPCOMING',
          shortDescription: 'No image data is copied.',
          mainImage: { url: 'https://static.wixstatic.com/image.jpg' },
          dateAndTimeSettings: { startDate: '2026-10-01T12:00:00.000Z' },
          registration: { status: 'OPEN_RSVP' },
        },
      }), { status: 200 });
    },
  });

  const result = service.process(signedWebhook(published, privateKey));
  assert.equal(result.needsFetch, true);
  assert.equal(result.wixEventId, 'wix-event-2');

  const normalized = await service.getEvent(result);
  assert.equal(normalized.event.title, 'Published Workshop');
  assert.deepEqual(normalized.event.files, []);
  assert.match(calls[1].url, /events\/v3\/events\/wix-event-2/);
  assert.match(calls[1].url, /fieldset=DETAILS/);
  assert.match(calls[1].url, /fieldset=REGISTRATION/);
  assert.equal(calls[1].options.headers.Authorization, 'app-token');
});

test('rejects a Wix webhook signed by a different key', () => {
  const trusted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const untrusted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = signedWebhook(wixEnvelope({ id: 'event-1' }), untrusted.privateKey);
  assert.throws(
    () => verifyWixJwt(token, trusted.publicKey.export({ type: 'spki', format: 'pem' })),
    /signature is invalid/
  );
});

test('ignores Wix draft events', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = signedWebhook(wixEnvelope({
    id: 'draft-1',
    title: 'Draft',
    status: 'DRAFT',
    dateAndTimeSettings: { startDate: '2026-09-15T12:00:00.000Z' },
  }), privateKey);
  const result = createWixEventsService({
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }).process(token);
  assert.equal(result.ignored, true);
  assert.equal(result.reason, 'draft_event');
});
