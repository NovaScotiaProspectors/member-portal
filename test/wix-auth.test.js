const test = require('node:test');
const assert = require('node:assert/strict');
const { createWixAuth, memberIdentity } = require('../server/services/wixAuth');

test('normalizes a Wix member identity', () => {
  assert.deepEqual(memberIdentity({ member: {
    id: 'wix-1', loginEmail: 'MEMBER@EXAMPLE.COM', status: 'APPROVED',
    contact: { firstName: 'Ada', lastName: 'Lovelace', phone: '9025550100' },
  } }), {
    wixMemberId: 'wix-1', email: 'member@example.com', firstName: 'Ada',
    lastName: 'Lovelace', phone: '9025550100', status: 'APPROVED',
  });
});

test('uses PKCE and returns the authenticated Wix member', async () => {
  const requests = [];
  const replies = [
    { access_token: 'visitor-token' },
    { redirectSession: { fullUrl: 'https://users.wix.com/signin' } },
    { access_token: 'member-token' },
    { member: { id: 'wix-1', loginEmail: 'member@example.com', status: 'APPROVED', contact: {} } },
  ];
  const auth = createWixAuth({
    clientId: 'client-id', redirectUri: 'https://portal.example/api/auth/wix/callback',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    },
  });

  const flow = await auth.begin();
  assert.equal(flow.url, 'https://users.wix.com/signin');
  const redirectBody = JSON.parse(requests[1].options.body).auth.authRequest;
  assert.equal(redirectBody.codeChallengeMethod, 'S256');
  assert.equal(redirectBody.responseMode, 'fragment');
  assert.ok(redirectBody.codeChallenge);

  const member = await auth.finish({ code: 'code', verifier: flow.verifier });
  assert.equal(member.wixMemberId, 'wix-1');
  assert.equal(requests[3].options.headers.Authorization, 'member-token');
});

test('rejects a Wix member that is not approved', async () => {
  const replies = [
    { access_token: 'member-token' },
    { member: { id: 'wix-1', loginEmail: 'member@example.com', status: 'PENDING', contact: {} } },
  ];
  const auth = createWixAuth({
    clientId: 'client-id', redirectUri: 'https://portal.example/api/auth/wix/callback',
    fetchImpl: async () => new Response(JSON.stringify(replies.shift()), { status: 200 }),
  });
  await assert.rejects(() => auth.finish({ code: 'code', verifier: 'verifier' }), /not approved/);
});
