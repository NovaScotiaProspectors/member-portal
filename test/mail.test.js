/* Outbound mail tests — run with `npm test`.
 *
 * `fetch` is stubbed throughout, so nothing here talks to Resend, needs an API
 * key, or sends a real message. The point is to pin down the delivery contract:
 * what goes on the wire, what happens when the provider says no, and that no
 * secret ever reaches a log line. For an end-to-end check against the real
 * provider, use POST /api/admin/mail/test (see README).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMailer, createMailerSendTransport, normalizeRecipients, parseAddress, redactSecrets } = require('../server/mail');

const API_KEY = 'mlsn.test_abc123SECRETtoken';

/** Records every request and answers with the queued responses. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    const headers = new Map(Object.entries(next.headers || {}));
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: next.statusText || '',
      headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    };
  };
  return { impl, calls };
}

// A successful send: 202 Accepted, empty body, id in the x-message-id header.
const okResponse = { status: 202, body: '', headers: { 'x-message-id': 'msg_0001' } };

function transport(responses, options = {}) {
  const { impl, calls } = stubFetch(responses);
  return {
    calls,
    mailer: createMailerSendTransport(API_KEY, { fetchImpl: impl, retryDelayMs: 0, ...options }),
  };
}

test('sends over HTTPS to the MailerSend API with the bearer token', async () => {
  const { mailer, calls } = transport([okResponse]);

  const result = await mailer.sendMail({
    from: 'NSPA <no-reply@prospectors.ns.ca>',
    to: 'member@example.com',
    subject: 'Claim expiring',
    text: 'Your claim expires soon.\n',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.mailersend.com/v1/email');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  // Addresses go over the wire as objects, not header strings.
  assert.deepEqual(calls[0].body.from, { email: 'no-reply@prospectors.ns.ca', name: 'NSPA' });
  assert.deepEqual(calls[0].body.to, [{ email: 'member@example.com' }]);
  assert.equal(calls[0].body.subject, 'Claim expiring');
  assert.equal(calls[0].body.text, 'Your claim expires soon.\n');
  // 202 carries no body; the id comes from the header.
  assert.equal(result.id, 'msg_0001');
});

test('parseAddress handles both header form and a bare address', () => {
  assert.deepEqual(parseAddress('NSPA <no-reply@x.ca>'), { email: 'no-reply@x.ca', name: 'NSPA' });
  assert.deepEqual(parseAddress('"NSPA Alerts" <no-reply@x.ca>'), { email: 'no-reply@x.ca', name: 'NSPA Alerts' });
  assert.deepEqual(parseAddress('no-reply@x.ca'), { email: 'no-reply@x.ca' });
  assert.deepEqual(parseAddress('  spaced@x.ca  '), { email: 'spaced@x.ca' });
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress(null), null);
});

test('keeps html bodies alongside the text part', async () => {
  const { mailer, calls } = transport([okResponse]);
  await mailer.sendMail({
    from: 'a@b.ca', to: 'c@d.ca', subject: 'Both parts',
    text: 'plain', html: '<p>rich</p>',
  });
  assert.equal(calls[0].body.text, 'plain');
  assert.equal(calls[0].body.html, '<p>rich</p>');
});

test('splits a comma-joined recipient list into separate addresses', async () => {
  // The nightly backup passes ADMIN_EMAILS.join(','). SMTP accepted that as one
  // header; the API validates each address, so it has to be split back apart.
  const { mailer, calls } = transport([okResponse]);
  await mailer.sendMail({
    from: 'a@b.ca',
    to: 'one@example.com, two@example.com ,, three@example.com',
    subject: 'Backup',
    text: 'archive attached',
  });
  assert.deepEqual(calls[0].body.to, [
    { email: 'one@example.com' },
    { email: 'two@example.com' },
    { email: 'three@example.com' },
  ]);
});

test('normalizeRecipients trims, splits and de-duplicates', () => {
  assert.deepEqual(normalizeRecipients(' a@x.ca '), ['a@x.ca']);
  assert.deepEqual(normalizeRecipients(['a@x.ca', 'a@x.ca']), ['a@x.ca']);
  assert.deepEqual(normalizeRecipients('a@x.ca;b@y.ca'), ['a@x.ca', 'b@y.ca']);
  assert.deepEqual(normalizeRecipients(''), []);
  assert.deepEqual(normalizeRecipients(null), []);
});

test('reads file attachments off disk and base64-encodes them', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nspa-mail-')), 'backup.zip');
  fs.writeFileSync(file, 'archive-bytes');

  const { mailer, calls } = transport([okResponse]);
  await mailer.sendMail({
    from: 'a@b.ca', to: 'admin@example.com', subject: 'Backup', text: 'attached',
    attachments: [{ filename: 'backup.zip', path: file }],
  });

  assert.equal(calls[0].body.attachments.length, 1);
  assert.equal(calls[0].body.attachments[0].filename, 'backup.zip');
  assert.equal(calls[0].body.attachments[0].disposition, 'attachment');
  assert.equal(
    Buffer.from(calls[0].body.attachments[0].content, 'base64').toString(),
    'archive-bytes',
  );
});

test('accepts in-memory attachment content too', async () => {
  const { mailer, calls } = transport([okResponse]);
  await mailer.sendMail({
    from: 'a@b.ca', to: 'admin@example.com', subject: 'Report', text: 'attached',
    attachments: [{ filename: 'report.csv', content: Buffer.from('id,name') }],
  });
  assert.equal(
    Buffer.from(calls[0].body.attachments[0].content, 'base64').toString(),
    'id,name',
  );
});

test('a rejected API token produces an actionable error and is not retried', async () => {
  const { mailer, calls } = transport([{ status: 401, body: { message: 'Unauthenticated.' } }]);

  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's', text: 't' }),
    error => {
      assert.match(error.message, /rejected the API token \(401\)/);
      assert.match(error.message, /MAILERSEND_API_KEY/);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'an auth failure must not be retried');
});

test('an unauthenticated sending domain is explained, not blamed on the token', async () => {
  // MailerSend answers 422 for this, the same status it uses for a malformed
  // payload — so the message decides which advice the log gives.
  const { mailer, calls } = transport([{
    status: 422,
    body: {
      message: 'The given data was invalid.',
      errors: { 'from.email': ['The from.email domain must be verified.'] },
    },
  }]);
  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's', text: 't' }),
    error => {
      assert.match(error.message, /from\.email: The from\.email domain must be verified/);
      assert.match(error.message, /MAIL_FROM domain not being authenticated/);
      assert.ok(!/rejected the API token/.test(error.message), 'must not blame the token');
      return true;
    },
  );
  assert.equal(calls.length, 1, 'a validation failure must not be retried');
});

test('a trial account restricted to its own administrator is named for what it is', async () => {
  const { mailer } = transport([{
    status: 422,
    body: {
      message: 'The given data was invalid.',
      errors: { 'to.0.email': ['Trial accounts can only send to the administrator email.'] },
    },
  }]);
  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'someone-else@example.com', subject: 's', text: 't' }),
    error => {
      assert.match(error.message, /Trial accounts can only send to the administrator email/);
      assert.match(error.message, /restricted to its own administrator address/);
      return true;
    },
  );
});

test('per-field validation errors are surfaced, not the generic wrapper', async () => {
  // "The given data was invalid." on its own tells nobody anything.
  const { mailer } = transport([{
    status: 422,
    body: {
      message: 'The given data was invalid.',
      errors: { 'to.0.email': ['The to.0.email must be a valid email address.'] },
    },
  }]);
  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'nonsense@x', subject: 's', text: 't' }),
    error => {
      assert.match(error.message, /to\.0\.email: The to\.0\.email must be a valid email address/);
      assert.match(error.message, /invalid recipient/);
      return true;
    },
  );
});

test('a token without send permission is reported as a permission problem', async () => {
  const { mailer } = transport([{ status: 403, body: { message: 'This action is unauthorized.' } }]);
  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's', text: 't' }),
    /refused the request \(403\).*Email full access/s,
  );
});

test('retries a rate limit and succeeds on a later attempt', async () => {
  const { mailer, calls } = transport([
    { status: 429, body: { message: 'Too many requests' } },
    okResponse,
  ]);
  const result = await mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's', text: 't' });
  assert.equal(result.id, 'msg_0001');
  assert.equal(calls.length, 2);
});

test('gives up after the attempt limit and reports the provider status', async () => {
  const { mailer, calls } = transport([{ status: 503, body: { message: 'upstream down' } }]);
  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's', text: 't' }),
    /MailerSend is unavailable \(503\)/,
  );
  assert.equal(calls.length, 3);
});

test('a network failure is retried and then surfaced', async () => {
  const { mailer, calls } = transport([new Error('getaddrinfo ENOTFOUND api.mailersend.com')]);
  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's', text: 't' }),
    /Could not reach api\.mailersend\.com/,
  );
  assert.equal(calls.length, 3);
});

test('never leaks the API token into an error message', async () => {
  // A provider that echoes the Authorization header back is the worst case;
  // whatever it says must still be safe to write to the logs.
  const { mailer } = transport([
    { status: 400, body: { message: `rejected Bearer ${API_KEY} (${API_KEY})` } },
  ]);
  await assert.rejects(
    () => mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's', text: 't' }),
    error => {
      assert.ok(!error.message.includes(API_KEY), 'API token must not appear in the error');
      assert.match(error.message, /mlsn\.\*\*\*/);
      return true;
    },
  );
});

test('redactSecrets scrubs tokens and bearer headers', () => {
  assert.ok(!redactSecrets(`token ${API_KEY}`, API_KEY).includes(API_KEY));
  assert.equal(redactSecrets('Authorization: Bearer abc.def'), 'Authorization: Bearer ***');
  assert.equal(redactSecrets('mlsn.liveToken123456 failed'), 'mlsn.*** failed');
});

test('refuses obviously undeliverable messages before calling the provider', async () => {
  const { mailer, calls } = transport([okResponse]);
  await assert.rejects(() => mailer.sendMail({ from: 'a@b.ca', to: '', subject: 's', text: 't' }), /No recipient/);
  await assert.rejects(() => mailer.sendMail({ from: '', to: 'c@d.ca', subject: 's', text: 't' }), /MAIL_FROM/);
  await assert.rejects(() => mailer.sendMail({ from: 'a@b.ca', to: 'c@d.ca', subject: 's' }), /no text or html body/);
  assert.equal(calls.length, 0);
});

test('verify passes on a good token and fails loudly on a bad one', async () => {
  const good = transport([{ status: 422, body: { message: 'The given data was invalid.' } }]);
  assert.equal(await good.mailer.verify(), true);
  assert.deepEqual(good.calls[0].body, {}, 'verify must not send a real message');

  const bad = transport([{ status: 401, body: { message: 'Unauthenticated.' } }]);
  await assert.rejects(() => bad.mailer.verify(), /rejected the API token \(401\)/);

  const restricted = transport([{ status: 403, body: { message: 'This action is unauthorized.' } }]);
  await assert.rejects(() => restricted.mailer.verify(), /Email full access/);
});

test('verify does not fail a good token over an unauthenticated domain', async () => {
  // The token works; the restriction belongs to the real send, which reports it
  // against the actual from/to. Failing verification here would report the
  // wrong problem at startup. An empty payload always 422s, which is the pass.
  const { mailer } = transport([{
    status: 422,
    body: { message: 'The given data was invalid.', errors: { 'from.email': ['domain must be verified'] } },
  }]);
  assert.equal(await mailer.verify(), true);
});

test('createMailer wires up MailerSend when the token is present', () => {
  const setup = createMailer({ MAILERSEND_API_KEY: API_KEY, MAIL_FROM: 'NSPA <no-reply@example.ca>' });
  assert.ok(setup.mailer);
  assert.equal(setup.mailer.kind, 'mailersend');
  assert.equal(setup.status.configured, true);
  assert.match(setup.describe, /MailerSend HTTPS API as NSPA <no-reply@example\.ca>/);
});

test('createMailer reports email as off — the failure this fixes — when unconfigured', () => {
  const setup = createMailer({});
  assert.equal(setup.mailer, null);
  assert.equal(setup.status.configured, false);
  assert.match(setup.status.error, /MAILERSEND_API_KEY is not set/);
});

test('leftover SMTP settings are called out instead of silently ignored', () => {
  const setup = createMailer({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'website@prospectors.ns.ca' });
  assert.equal(setup.mailer, null);
  assert.match(setup.status.error, /SMTP is no longer supported/);
});
