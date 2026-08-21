const crypto = require('crypto');

const WIX_TOKEN_URL = 'https://www.wixapis.com/oauth2/token';
const WIX_REDIRECT_URL = 'https://www.wixapis.com/_api/redirects-api/v1/redirect-session';
const WIX_CURRENT_MEMBER_URL = 'https://www.wixapis.com/members/v1/members/my?fieldsets=FULL';

const base64url = buffer => Buffer.from(buffer).toString('base64url');

function requireToken(body, label) {
  const token = body && body.access_token;
  if (!token) throw new Error(`Wix did not return a ${label} access token.`);
  return token;
}

async function jsonRequest(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const raw = await response.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) {
    const message = body.message || body.error_description || body.error || `HTTP ${response.status}`;
    throw new Error(`Wix authentication failed: ${message}`);
  }
  return body;
}

function memberIdentity(body) {
  const member = body && (body.member || body.data || body);
  const contact = member && member.contact || {};
  const email = String(member && (member.loginEmail || member.login_email) || contact.email || '').trim().toLowerCase();
  return {
    wixMemberId: String(member && member.id || '').trim(),
    email,
    firstName: String(contact.firstName || contact.first_name || '').trim(),
    lastName: String(contact.lastName || contact.last_name || '').trim(),
    phone: String(
      contact.phone ||
      ((contact.phones || contact.phonesV2 || [])[0] || {}).phone ||
      ''
    ).trim(),
    status: String(member && member.status || '').trim().toUpperCase(),
  };
}

function createWixAuth({ clientId, redirectUri, fetchImpl = fetch } = {}) {
  const id = String(clientId || '').trim();
  const callback = String(redirectUri || '').trim();

  async function visitorToken() {
    return jsonRequest(fetchImpl, WIX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id, grantType: 'anonymous' }),
      signal: AbortSignal.timeout(15000),
    });
  }

  async function begin() {
    if (!id || !callback) throw new Error('WIX_CLIENT_ID and WIX_OAUTH_REDIRECT_URI are required.');
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(32));
    const visitor = await visitorToken();
    const visitorAccessToken = requireToken(visitor, 'visitor');
    const result = await jsonRequest(fetchImpl, WIX_REDIRECT_URL, {
      method: 'POST',
      headers: {
        Authorization: visitorAccessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth: {
          authRequest: {
            redirectUri: callback,
            clientId: id,
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
            // Wix-managed login returns the authorization result in a URL
            // fragment. The callback page relays it to the server after Wix
            // finishes rendering the login flow.
            responseMode: 'fragment',
            responseType: 'code',
            scope: 'offline_access',
            state,
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const url = result.redirectSession && (result.redirectSession.fullUrl || result.redirectSession.fullURL);
    if (!url) throw new Error('Wix did not return a login URL.');
    return { url, verifier, state };
  }

  async function finish({ code, verifier }) {
    const tokens = await jsonRequest(fetchImpl, WIX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: id,
        grantType: 'authorization_code',
        redirectUri: callback,
        code,
        codeVerifier: verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const memberAccessToken = requireToken(tokens, 'member');
    const body = await jsonRequest(fetchImpl, WIX_CURRENT_MEMBER_URL, {
      headers: { Authorization: memberAccessToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const identity = memberIdentity(body);
    if (!identity.wixMemberId || !identity.email) {
      throw new Error('Wix did not return a member ID and login email.');
    }
    if (identity.status !== 'APPROVED') throw new Error('This Wix member account is not approved.');
    return identity;
  }

  return { configured: !!(id && callback), begin, finish };
}

module.exports = { createWixAuth, memberIdentity };
