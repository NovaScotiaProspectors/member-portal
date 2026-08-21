const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAuthRoutes } = require('../server/routes/auth');

function responseDouble() {
  return {
    statusCode: 200,
    cookies: {},
    cleared: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    redirect(url) { this.statusCode = 302; this.redirectTo = url; return this; },
    cookie(name, value) { this.cookies[name] = value; return this; },
    clearCookie(name) { this.cleared.push(name); return this; },
    setHeader() {},
  };
}

function harness({ existingUser = null, linkedUser = null, identity = {} } = {}) {
  const users = new Map();
  if (existingUser) users.set(existingUser.email.toLowerCase(), { ...existingUser });
  const calls = { append: 0, finish: 0 };
  let beginCount = 0;
  const wixAuth = {
    configured: true,
    begin: async () => {
      beginCount += 1;
      return {
        url: 'https://users.wix.com/signin',
        state: `state-value-${String(beginCount).padStart(20, '0')}`,
        verifier: `verifier-${beginCount}`,
      };
    },
    finish: async () => {
      calls.finish += 1;
      return {
        wixMemberId: 'wix-1', email: 'member@example.com', firstName: 'Wix',
        lastName: 'Member', phone: '', status: 'APPROVED', ...identity,
      };
    },
  };
  const handlers = { get: {}, post: {} };
  const app = {
    get(path, ...callbacks) { handlers.get[path] = callbacks.at(-1); },
    post(path, ...callbacks) { handlers.post[path] = callbacks.at(-1); },
  };
  registerAuthRoutes(app, {
    findUserByEmail: async email => users.get(String(email).toLowerCase()) || null,
    findUserByWixMemberId: async () => linkedUser,
    updateMembership: async (email, updates) => Object.assign(users.get(email.toLowerCase()), updates),
    appendUser: async user => {
      calls.append += 1;
      users.set(user.email, {
        ...user, memberId: '00001', membershipStatus: 'pending_payment', accountStatus: 'active',
      });
      return '00001';
    },
    invalidateSessionUser() {},
    setSession: (res, email) => res.cookie('nspa_session', email, { httpOnly: true }),
    clearSession: res => res.clearCookie('nspa_session'),
    isActiveMember: user => user && user.membershipStatus === 'active',
    publicMember: async user => user,
    isAdmin: () => false,
    requireAuth: (req, res, next) => next(),
    serializeNetworkVisibility: JSON.stringify,
    DEFAULT_NETWORK_VISIBILITY: {},
    ZEFFY_STUDENT_URL: '', ZEFFY_REGULAR_URL: '', WIX_SITE_URL: '', WIX_MEMBER_LOGIN_URL: '',
    APP_BASE_URL: 'http://portal.test', wixAuth, secureCookies: false,
    zeffy: { configured: false },
  });
  return { handlers, calls, users, close() {} };
}

async function begin(h) {
  const response = responseDouble();
  await h.handlers.get['/api/auth/wix']({ query: { next: '/claims.html' } }, response);
  assert.equal(response.statusCode, 302);
  assert.equal(response.redirectTo, 'https://users.wix.com/signin');
  return response.cookies;
}

test('Wix sign-in creates a blank pending-payment profile for portal confirmation', async () => {
  const h = harness();
  try {
    const cookies = await begin(h);
    const response = responseDouble();
    const state = Object.keys(cookies).find(name => name.startsWith('nspa_wix_flow_')).slice('nspa_wix_flow_'.length);
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state, code: 'code-1' }, signedCookies: cookies,
    }, response);
    assert.equal(response.statusCode, 302);
    assert.equal(response.redirectTo, '/complete-profile.html?next=%2Fclaims.html');
    assert.equal(h.calls.append, 1);
    assert.equal(h.users.get('member@example.com').wixMemberId, 'wix-1');
    assert.equal(h.users.get('member@example.com').firstName, '');
    assert.equal(h.users.get('member@example.com').lastName, '');
    assert.equal(h.users.get('member@example.com').phone, '');
    assert.equal(response.cookies.nspa_session, 'member@example.com');
  } finally { h.close(); }
});

test('an existing active Wix-linked member returns to the requested portal page', async () => {
  const user = {
    memberId: '00002', email: 'member@example.com', wixMemberId: 'wix-1',
    firstName: 'Existing', lastName: 'Member', phone: '902-555-0100',
    membershipStatus: 'active', accountStatus: 'active',
  };
  const h = harness({ existingUser: user, linkedUser: user });
  try {
    const cookies = await begin(h);
    const response = responseDouble();
    const state = Object.keys(cookies).find(name => name.startsWith('nspa_wix_flow_')).slice('nspa_wix_flow_'.length);
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state, code: 'code-1' }, signedCookies: cookies,
    }, response);
    assert.equal(response.statusCode, 302);
    assert.equal(response.redirectTo, '/claims.html');
    assert.equal(h.calls.append, 0);
  } finally { h.close(); }
});

test('Wix profile completion stores missing details and sends a pending member to payment', async () => {
  const h = harness();
  try {
    const cookies = await begin(h);
    const callback = responseDouble();
    const state = Object.keys(cookies).find(name => name.startsWith('nspa_wix_flow_')).slice('nspa_wix_flow_'.length);
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state, code: 'code-1' }, signedCookies: cookies,
    }, callback);

    const user = h.users.get('member@example.com');
    const response = responseDouble();
    await h.handlers.post['/api/auth/wix/profile']({
      user,
      body: {
        firstName: 'Wix', lastName: 'Member', phone: '902-555-0100',
        next: '/claims.html',
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.next, '/membership.html');
    assert.equal(h.users.get('member@example.com').firstName, 'Wix');
    assert.equal(h.users.get('member@example.com').lastName, 'Member');
    assert.equal(h.users.get('member@example.com').phone, '902-555-0100');
  } finally { h.close(); }
});

test('an authenticated existing account can complete its profile before the Wix ID column is migrated', async () => {
  const user = {
    memberId: '00006', email: 'member@example.com', wixMemberId: '',
    firstName: 'Test', lastName: 'Account', phone: '9025550100',
    membershipStatus: 'pending_payment', accountStatus: 'active',
  };
  const h = harness({ existingUser: user });
  try {
    const response = responseDouble();
    await h.handlers.post['/api/auth/wix/profile']({
      user,
      body: {
        firstName: 'Real', lastName: 'Member', phone: '902-555-0101',
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(h.users.get('member@example.com').firstName, 'Real');
    assert.equal(h.users.get('member@example.com').lastName, 'Member');
  } finally { h.close(); }
});

test('a new Wix user confirms portal details even when the provider supplies them', async () => {
  const h = harness({ identity: { phone: '902-555-0100' } });
  try {
    const cookies = await begin(h);
    const response = responseDouble();
    const state = Object.keys(cookies).find(name => name.startsWith('nspa_wix_flow_')).slice('nspa_wix_flow_'.length);
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state, code: 'code-1' }, signedCookies: cookies,
    }, response);
    assert.equal(response.redirectTo, '/complete-profile.html?next=%2Fclaims.html');
    assert.equal(h.users.get('member@example.com').firstName, '');
    assert.equal(h.users.get('member@example.com').phone, '');
  } finally { h.close(); }
});

test('an incomplete linked account confirms its details in the portal', async () => {
  const user = {
    memberId: '00003', email: 'member@example.com', wixMemberId: 'wix-1',
    firstName: '', lastName: '', phone: '', membershipStatus: 'active', accountStatus: 'active',
  };
  const h = harness({
    existingUser: user,
    linkedUser: user,
    identity: { firstName: 'Google', lastName: 'Member', phone: '902-555-0100' },
  });
  try {
    const cookies = await begin(h);
    const response = responseDouble();
    const state = Object.keys(cookies).find(name => name.startsWith('nspa_wix_flow_')).slice('nspa_wix_flow_'.length);
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state, code: 'code-1' }, signedCookies: cookies,
    }, response);
    assert.equal(response.redirectTo, '/complete-profile.html?next=%2Fclaims.html');
    assert.equal(h.users.get('member@example.com').firstName, '');
  } finally { h.close(); }
});

test('a legacy email-prefix placeholder must be replaced in the portal', async () => {
  const user = {
    memberId: '00004', email: 'testemail@example.com', wixMemberId: 'wix-1',
    firstName: 'testemail', lastName: 'Member', phone: '902-555-0100',
    membershipStatus: 'active', accountStatus: 'active',
  };
  const h = harness({
    existingUser: user,
    linkedUser: user,
    identity: {
      email: 'testemail@example.com', firstName: 'Actual', lastName: 'Name',
      phone: '902-555-0100',
    },
  });
  try {
    const cookies = await begin(h);
    const state = Object.keys(cookies).find(name => name.startsWith('nspa_wix_flow_')).slice('nspa_wix_flow_'.length);
    const response = responseDouble();
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state, code: 'code-1' }, signedCookies: cookies,
    }, response);
    assert.equal(response.redirectTo, '/complete-profile.html?next=%2Fclaims.html');

    const responseProfile = responseDouble();
    await h.handlers.post['/api/auth/wix/profile']({
      user: h.users.get('testemail@example.com'),
      body: {
        firstName: 'Actual', lastName: 'Name', phone: '902-555-0100',
        next: '/claims.html',
      },
    }, responseProfile);
    assert.equal(responseProfile.statusCode, 200);
    assert.equal(h.users.get('testemail@example.com').firstName, 'Actual');
    assert.equal(h.users.get('testemail@example.com').lastName, 'Name');
  } finally { h.close(); }
});

test('a legacy placeholder name is requested when Wix supplies no real name', async () => {
  const user = {
    memberId: '00005', email: 'testemail@example.com', wixMemberId: 'wix-1',
    firstName: 'testemail', lastName: 'Member', phone: '902-555-0100',
    membershipStatus: 'active', accountStatus: 'active',
  };
  const h = harness({
    existingUser: user,
    linkedUser: user,
    identity: { email: 'testemail@example.com', firstName: '', lastName: '' },
  });
  try {
    const cookies = await begin(h);
    const state = Object.keys(cookies).find(name => name.startsWith('nspa_wix_flow_')).slice('nspa_wix_flow_'.length);
    const response = responseDouble();
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state, code: 'code-1' }, signedCookies: cookies,
    }, response);
    assert.equal(response.redirectTo, '/complete-profile.html?next=%2Fclaims.html');
  } finally { h.close(); }
});

test('legacy password signup and login endpoints are disabled', async () => {
  const h = harness();
  try {
    for (const endpoint of ['/api/signup', '/api/signin']) {
      const response = responseDouble();
      await h.handlers.post[endpoint]({ body: {} }, response);
      assert.equal(response.statusCode, 410);
      assert.match(response.body.error, /handled through Wix/i);
    }
  } finally { h.close(); }
});

test('Wix callback rejects a missing or mismatched state before exchanging the code', async () => {
  const h = harness();
  try {
    const cookies = await begin(h);
    const response = responseDouble();
    await h.handlers.get['/api/auth/wix/callback']({
      query: { state: 'wrong', code: 'code-1' }, signedCookies: cookies,
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(h.calls.finish, 0);
  } finally { h.close(); }
});

test('Wix callback relays fragment results to the server without consuming the flow cookie', async () => {
  const h = harness();
  try {
    const response = responseDouble();
    await h.handlers.get['/api/auth/wix/callback']({ query: {}, signedCookies: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /window\.location\.hash/);
    assert.match(response.body, /\/api\/auth\/wix\/complete/);
    assert.deepEqual(response.cleared, []);
  } finally { h.close(); }
});

test('parallel Wix sign-in attempts keep separate PKCE verifier cookies', async () => {
  const h = harness();
  try {
    const first = await begin(h);
    h.handlers.get['/api/auth/wix'];
    const secondResponse = responseDouble();
    await h.handlers.get['/api/auth/wix']({ query: { next: '/events.html' } }, secondResponse);
    const firstFlowCookie = Object.keys(first).find(name => name.startsWith('nspa_wix_flow_'));
    const secondFlowCookie = Object.keys(secondResponse.cookies).find(name => name.startsWith('nspa_wix_flow_'));
    assert.ok(firstFlowCookie);
    assert.ok(secondFlowCookie);
    assert.notEqual(firstFlowCookie, secondFlowCookie);
  } finally { h.close(); }
});
