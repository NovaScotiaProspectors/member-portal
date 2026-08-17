/* ── Outbound mail — MailerSend HTTPS API ───────────────────────────────────
 * Mail leaves the building over plain HTTPS to api.mailersend.com. No SMTP:
 * the hosts this runs on (Render) block outbound ports 25/465/587, so an SMTP
 * transport connects to nothing and times out silently — which is exactly how
 * outbound mail came to be broken here.
 *
 * MailerSend rather than Resend because prospectors.ns.ca has its DNS on Wix,
 * and Wix cannot create MX records on a subdomain. Resend's domain
 * verification requires one (an SES MX on `send.`), so it can never verify
 * while DNS stays where it is. MailerSend authenticates with a TXT record at
 * the root plus three CNAMEs, all of which Wix supports.
 *
 * The transport exposes `sendMail` and `verify`. `sendMail` takes the same
 * shape the call sites already use — `{ from, to, subject, text, html,
 * attachments }` with `attachments` as `{ filename, path }` or
 * `{ filename, content }` — so existing templates and call sites are unchanged.
 * The provider's own JSON shape (addresses as objects, not strings) is this
 * module's problem, not theirs.
 *
 * Errors are turned into one-line, actionable messages and never carry the API
 * token: `redactSecrets` scrubs anything token-shaped before a message escapes.
 * ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs/promises');
const path = require('path');

const MAILERSEND_ENDPOINT = 'https://api.mailersend.com/v1/email';

// Transient failures (rate limit, provider hiccup) are worth one or two more
// tries; a rejected token or a bad payload never is.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 15000;

/** Anything token-shaped is scrubbed before an error message leaves this module. */
function redactSecrets(text, apiKey) {
  let out = String(text == null ? '' : text);
  if (apiKey) out = out.split(apiKey).join('mlsn.***');
  return out
    .replace(/mlsn\.[A-Za-z0-9._-]{6,}/g, 'mlsn.***')
    .replace(/(Bearer\s+)\S+/gi, '$1***');
}

/**
 * `MAIL_FROM` is written the way a mail header is — `NSPA <no-reply@x.ca>` —
 * but MailerSend wants `{ email, name }`. Accepts a bare address too.
 */
function parseAddress(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;

  const angled = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, '$1');
    const email = angled[2].trim();
    return email ? { email, ...(name ? { name } : {}) } : null;
  }
  return { email: raw };
}

/**
 * Callers pass recipients as an array, a single address, or — for the admin
 * broadcasts — a comma-joined list. SMTP accepted the joined string; the API
 * validates each entry, so split it back apart rather than handing over one
 * address that contains commas.
 */
function normalizeRecipients(value) {
  const list = Array.isArray(value) ? value : [value];
  const seen = new Set();
  for (const entry of list) {
    for (const address of String(entry == null ? '' : entry).split(/[,;]/)) {
      const trimmed = address.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen];
}

/** Recipient lists go over the wire as `[{ email, name? }]`. */
function toRecipientObjects(value) {
  return normalizeRecipients(value).map(parseAddress).filter(Boolean);
}

/**
 * MailerSend takes attachment bytes as base64 in the JSON body, while the call
 * sites pass `{ filename, path }` for files already on disk. Read those so the
 * backup job's archive keeps working unchanged.
 */
async function toApiAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined;
  return Promise.all(attachments.map(async item => {
    if (item.content != null) {
      const buffer = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content);
      return { filename: item.filename, content: buffer.toString('base64'), disposition: 'attachment' };
    }
    const buffer = await fs.readFile(item.path);
    return {
      filename: item.filename || path.basename(item.path),
      content: buffer.toString('base64'),
      disposition: 'attachment',
    };
  }));
}

/**
 * A 422 carries `{ message, errors: { 'from.email': ['...'], ... } }`. The
 * per-field entries are the part that says what to fix, so flatten them in
 * rather than logging the generic "The given data was invalid."
 */
function flattenValidationErrors(parsed) {
  const fields = parsed && parsed.errors;
  if (!fields || typeof fields !== 'object') return parsed && parsed.message ? String(parsed.message) : '';
  const parts = Object.entries(fields).map(([field, messages]) => {
    const text = Array.isArray(messages) ? messages.join(' ') : String(messages);
    return `${field}: ${text}`;
  });
  return parts.length ? parts.join('; ') : String(parsed.message || '');
}

/**
 * MailerSend answers 422 both for a domain that is not authenticated and for
 * the recipient restrictions that apply while an account is still in trial.
 * Those need different advice from a plain malformed-payload 422.
 */
function looksLikeSendingRestriction(detail) {
  return /domain|verif|authenticat|trial|approv|administrator/i.test(String(detail || ''));
}

/** The provider's own words, plus what to actually do about them. */
function describeFailure(status, detail) {
  if (status === 401) {
    return 'MailerSend rejected the API token (401). Check MAILERSEND_API_KEY.';
  }
  if (status === 403) {
    return `MailerSend refused the request (403): ${detail}. ` +
           'Check that the API token has Email full access.';
  }
  if (status === 422 && looksLikeSendingRestriction(detail)) {
    return `MailerSend refused the message (422): ${detail}. ` +
           'This is normally the MAIL_FROM domain not being authenticated yet, or a new account still ' +
           'restricted to its own administrator address.';
  }
  if (status === 422 || status === 400) {
    return `MailerSend rejected the message (${status}): ${detail}. ` +
           'This is usually an invalid recipient or a malformed MAIL_FROM.';
  }
  if (status === 429) {
    return `MailerSend rate limit hit (429): ${detail}.`;
  }
  if (status >= 500) {
    return `MailerSend is unavailable (${status}): ${detail}.`;
  }
  return `MailerSend ${status}: ${detail}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Reads the message id header without assuming a particular fetch shape. */
function messageIdOf(response) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return null;
  return response.headers.get('x-message-id') || null;
}

/**
 * @param {string} apiKey
 * @param {object} [options] injection seams for the tests: `fetchImpl`,
 *   `maxAttempts`, `retryDelayMs`.
 */
function createMailerSendTransport(apiKey, options = {}) {
  const doFetch = options.fetchImpl || ((...args) => fetch(...args));
  const maxAttempts = options.maxAttempts || MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs == null ? RETRY_BASE_DELAY_MS : options.retryDelayMs;

  async function request(payload) {
    return doFetch(MAILERSEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** `{ status, detail }` for a failed response, with secrets already scrubbed. */
  async function readFailure(response) {
    const body = redactSecrets(await response.text(), apiKey);
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = flattenValidationErrors(parsed) || parsed.message || body;
    } catch { /* not JSON — keep the raw body */ }
    return detail || response.statusText || '';
  }

  async function post(payload) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await request(payload);
      } catch (error) {
        // Network-level failure (DNS, TLS, timeout). Worth retrying.
        lastError = new Error(`Could not reach api.mailersend.com: ${redactSecrets(error.message, apiKey)}`);
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        // A successful send is 202 Accepted with an empty body; the id is in
        // the x-message-id header.
        return { id: messageIdOf(response) };
      }

      const detail = await readFailure(response);
      lastError = Object.assign(new Error(describeFailure(response.status, detail)), { status: response.status });

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw lastError;
    }

    throw lastError;
  }

  return {
    kind: 'mailersend',

    async sendMail({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
      const sender = parseAddress(from);
      const recipients = toRecipientObjects(to);
      if (!recipients.length) throw new Error('No recipient address');
      if (!sender) throw new Error('No sender address — set MAIL_FROM');
      if (!text && !html) throw new Error('Refusing to send an email with no text or html body');

      const files = await toApiAttachments(attachments);
      const ccList = cc ? toRecipientObjects(cc) : [];
      const bccList = bcc ? toRecipientObjects(bcc) : [];
      const replyToAddress = replyTo ? parseAddress(normalizeRecipients(replyTo)[0]) : null;

      return post({
        from: sender,
        to: recipients,
        subject,
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(ccList.length ? { cc: ccList } : {}),
        ...(bccList.length ? { bcc: bccList } : {}),
        ...(replyToAddress ? { reply_to: replyToAddress } : {}),
        ...(files ? { attachments: files } : {}),
      });
    },

    /**
     * MailerSend has no ping endpoint, so post an empty body and read the
     * answer: a bad token answers 401, while a good one gets far enough to
     * complain about the missing fields. Nothing is sent either way.
     */
    async verify() {
      let response;
      try {
        response = await request({});
      } catch (error) {
        throw new Error(`Could not reach api.mailersend.com: ${redactSecrets(error.message, apiKey)}`);
      }

      if (response.status === 401) {
        throw new Error('MailerSend rejected the API token (401). Check MAILERSEND_API_KEY.');
      }
      if (response.status === 403) {
        const detail = await readFailure(response);
        throw new Error(`MailerSend rejected the API token (403): ${detail}. Check that it has Email full access.`);
      }
      if (response.status >= 500) {
        throw new Error(`MailerSend is unavailable (${response.status}). Try again shortly.`);
      }
      // 422 here is the expected answer to an empty payload — the token works.
      return true;
    },
  };
}

/**
 * Builds the transport from the environment. Returns `{ mailer, status,
 * describe }`; `mailer` is null when MAILERSEND_API_KEY is missing, and every
 * caller already treats that as "email off" and falls back to the in-app
 * notification.
 */
function createMailer(env = process.env, options = {}) {
  const apiKey = String(env.MAILERSEND_API_KEY || '').trim();
  const from = String(env.MAIL_FROM || '').trim();
  const legacySmtp = String(env.SMTP_HOST || '').trim();

  if (!apiKey) {
    // Someone carrying old settings forward would otherwise sit waiting for
    // mail that no transport is configured to send.
    const error = legacySmtp
      ? 'MAILERSEND_API_KEY is not set. SMTP_HOST is set but SMTP is no longer supported — use a MailerSend token'
      : 'MAILERSEND_API_KEY is not set';
    return {
      mailer: null,
      status: { configured: false, verified: false, error },
      describe: 'not configured',
    };
  }

  return {
    mailer: createMailerSendTransport(apiKey, options),
    status: { configured: true, verified: false, error: null },
    describe: `MailerSend HTTPS API${from ? ` as ${from}` : ''}`,
  };
}

module.exports = {
  createMailer,
  createMailerSendTransport,
  normalizeRecipients,
  parseAddress,
  redactSecrets,
};
