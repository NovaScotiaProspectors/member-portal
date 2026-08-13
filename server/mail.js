/* ── Outbound mail transports ───────────────────────────────────────────────
 * Two ways out of the building:
 *
 *   Resend — plain HTTPS to api.resend.com. Works everywhere, including hosts
 *   that block outbound SMTP (Render's free instances block ports 25/465/587),
 *   which is why it is preferred whenever RESEND_API_KEY is set.
 *
 *   SMTP — nodemailer, kept for local development and for deployments that can
 *   reach a mail server directly.
 *
 * Both expose the same two methods, `sendMail` and `verify`, so callers never
 * need to know which one they got.
 * ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs/promises');
const path = require('path');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend takes attachment bytes as base64 in the JSON body, while nodemailer
 * callers pass `{ filename, path }`. Read those off disk so the same call site
 * works against either transport.
 */
async function toResendAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined;
  return Promise.all(attachments.map(async item => {
    if (item.content) {
      const buffer = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content);
      return { filename: item.filename, content: buffer.toString('base64') };
    }
    const buffer = await fs.readFile(item.path);
    return { filename: item.filename || path.basename(item.path), content: buffer.toString('base64') };
  }));
}

function createResendTransport(apiKey) {
  async function post(payload) {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (!response.ok) {
      let detail = body;
      try {
        const parsed = JSON.parse(body);
        detail = parsed.message || parsed.error || body;
      } catch { /* keep the raw body */ }
      throw new Error(`Resend ${response.status}: ${detail || response.statusText}`);
    }
    return body ? JSON.parse(body) : null;
  }

  return {
    kind: 'resend',
    async sendMail({ from, to, subject, text, html, attachments }) {
      return post({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(await toResendAttachments(attachments).then(a => (a ? { attachments: a } : {}))),
      });
    },
    /**
     * Resend has no ping endpoint, so send nothing and read the auth error
     * instead: a bad key answers 401, while a valid key gets far enough to
     * complain about the missing recipient. Either way the key is answered for.
     */
    async verify() {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error('Resend rejected the API key (401/403). Check RESEND_API_KEY.');
      }
      return true;
    },
  };
}

function createSmtpTransport({ host, port, user, pass }) {
  const transport = require('nodemailer').createTransport({
    host,
    port,
    secure: port === 465, // 587 uses STARTTLS, which nodemailer negotiates
    auth: user ? { user, pass } : undefined,
  });
  transport.kind = 'smtp';
  return transport;
}

/**
 * Picks a transport from the environment. Resend wins when its key is present,
 * because the hosts that need it are exactly the hosts where SMTP silently
 * times out. Returns `{ mailer, status, describe }`; `mailer` is null when
 * nothing is configured, and every caller already treats that as "email off".
 */
function createMailer(env = process.env) {
  const resendKey = String(env.RESEND_API_KEY || '').trim();
  const smtpHost = String(env.SMTP_HOST || '').trim();
  const smtpPort = Number(env.SMTP_PORT || 587);
  const smtpUser = String(env.SMTP_USER || '').trim();

  if (resendKey) {
    return {
      mailer: createResendTransport(resendKey),
      status: { configured: true, verified: false, error: null },
      describe: 'Resend HTTPS API',
    };
  }

  if (smtpHost) {
    try {
      return {
        mailer: createSmtpTransport({ host: smtpHost, port: smtpPort, user: smtpUser, pass: env.SMTP_PASS || '' }),
        status: { configured: true, verified: false, error: null },
        describe: `SMTP ${smtpHost}:${smtpPort} as ${smtpUser || '(no auth)'}`,
      };
    } catch (error) {
      return {
        mailer: null,
        status: { configured: false, verified: false, error: error.message },
        describe: 'SMTP transport unavailable',
      };
    }
  }

  return {
    mailer: null,
    status: { configured: false, verified: false, error: 'Neither RESEND_API_KEY nor SMTP_HOST is set' },
    describe: 'not configured',
  };
}

module.exports = { createMailer, createResendTransport, createSmtpTransport };
