const crypto = require('crypto');
const { safeNextPath } = require('../utils/nextPath');

const WIX_FLOW_COOKIE_PREFIX = 'nspa_wix_flow_';

function wixFlowCookieName(state) {
  const value = String(state || '');
  return /^[A-Za-z0-9_-]{20,128}$/.test(value) ? `${WIX_FLOW_COOKIE_PREFIX}${value}` : '';
}

function wixCallbackRelayPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Completing sign-in</title>
</head>
<body>
  <p>Completing Wix sign-in…</p>
  <script>
    (() => {
      const source = new URLSearchParams(window.location.hash.slice(1));
      const result = new URLSearchParams();
      for (const name of ['code', 'state', 'error', 'error_description']) {
        if (source.has(name)) result.set(name, source.get(name));
      }
      const destination = result.size
        ? '/api/auth/wix/complete?' + result.toString()
        : '/api/auth/wix';
      window.location.replace(destination);
    })();
  </script>
  <noscript>JavaScript is required to complete Wix sign-in.</noscript>
</body>
</html>`;
}

function missingProfileFields(user) {
  if (!user) return ['firstName', 'lastName', 'phone'];
  const missing = ['firstName', 'lastName', 'phone'].filter(field => !String(user[field] || '').trim());
  for (const field of legacyGeneratedNameFields(user)) {
    if (!missing.includes(field)) missing.push(field);
  }
  return missing;
}

function legacyGeneratedNameFields(user) {
  if (!user) return [];
  const emailPrefix = String(user.email || '').trim().toLowerCase().split('@')[0];
  const firstName = String(user.firstName || '').trim().toLowerCase();
  const lastName = String(user.lastName || '').trim().toLowerCase();
  return emailPrefix && firstName === emailPrefix && (!lastName || lastName === 'member')
    ? ['firstName', 'lastName']
    : [];
}

function completeProfileUrl(next) {
  const safe = safeNextPath(next);
  return `/complete-profile.html${safe ? `?next=${encodeURIComponent(safe)}` : ''}`;
}

function registerAuthRoutes(app, ctx) {
  const {
    findUserByEmail, updateMembership, appendUser, invalidateSessionUser,
    setSession, clearSession, isActiveMember, publicMember, isAdmin, requireAuth,
    ZEFFY_STUDENT_URL, ZEFFY_REGULAR_URL,
    WIX_SITE_URL, WIX_MEMBER_LOGIN_URL, APP_BASE_URL, wixAuth, secureCookies,
    findUserByWixMemberId, zeffy,
  } = ctx;

  // Authentication is owned by Wix. Keeping these old endpoints closed prevents
  // a second password/account system from drifting out of sync with Wix members.
  const wixOnly = (req, res) => res.status(410).json({
    error: 'Sign up and login are handled through Wix.',
    loginUrl: `${APP_BASE_URL}/api/auth/wix`,
  });
  app.post('/api/signup', wixOnly);
  app.post('/api/signin', wixOnly);
  
  app.get('/api/me', async (req, res) => {
    res.json({
      authenticated: !!req.user,
      member: await publicMember(req.user),
      profileComplete: !!req.user && missingProfileFields(req.user).length === 0,
      missingProfileFields: missingProfileFields(req.user),
      isAdmin: isAdmin(req.user),
      wixSiteUrl: WIX_SITE_URL,
      wixMemberLoginUrl: req.user ? '' : (wixAuth.configured ? `${APP_BASE_URL}/api/auth/wix` : WIX_MEMBER_LOGIN_URL),
      wixSsoEnabled: wixAuth.configured,
      appBaseUrl: APP_BASE_URL,
      publicMapUrl: `${APP_BASE_URL}/map.html`,
      eventsUrl: `${APP_BASE_URL}/events.html`,
      memberPortalUrl: `${APP_BASE_URL}/dashboard.html`,
      membershipPlans: [
        { id: 'student', label: 'Student Member', price: 'CA$15', url: ZEFFY_STUDENT_URL },
        { id: 'regular', label: 'Regular Member', price: 'CA$35', url: ZEFFY_REGULAR_URL },
      ],
      paymentsEnabled: !!(ZEFFY_STUDENT_URL && ZEFFY_REGULAR_URL && zeffy.configured),
      automaticPaymentActivation: zeffy.configured,
    });
  });
  
  app.get('/api/wix/links', (req, res) => {
    if (WIX_SITE_URL) {
      try {
        res.setHeader('Access-Control-Allow-Origin', new URL(WIX_SITE_URL).origin);
      } catch {}
    }
    res.json({
      appBaseUrl: APP_BASE_URL,
      publicMapUrl: `${APP_BASE_URL}/map.html`,
      eventsUrl: `${APP_BASE_URL}/events.html`,
      memberPortalUrl: `${APP_BASE_URL}/dashboard.html`,
      projectFormUrl: `${APP_BASE_URL}/index.html`,
      memberLoginUrl: wixAuth.configured ? `${APP_BASE_URL}/api/auth/wix` : (WIX_MEMBER_LOGIN_URL || `${APP_BASE_URL}/signup.html`),
      wixSiteUrl: WIX_SITE_URL,
    });
  });
  
  app.post('/api/signout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  const wixCookieOptions = {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
    maxAge: 30 * 60 * 1000,
  };

  const wixClearCookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
  };

  app.get('/api/auth/wix', async (req, res) => {
    if (!wixAuth.configured) return res.status(503).send('Wix sign-in is not configured.');
    try {
      const flow = await wixAuth.begin();
      const cookieName = wixFlowCookieName(flow.state);
      if (!cookieName) throw new Error('Wix returned an invalid OAuth state.');
      res.cookie(cookieName, JSON.stringify({
        verifier: flow.verifier,
        next: safeNextPath(req.query.next),
      }), wixCookieOptions);
      return res.redirect(flow.url);
    } catch (error) {
      console.error('wix sign-in:', error);
      return res.status(502).send('Could not start Wix sign-in.');
    }
  });

  async function completeWixSignIn(req, res) {
    const signedCookies = req.signedCookies || {};
    const state = String(req.query.state || '');
    const cookieName = wixFlowCookieName(state);
    let next = '';
    let verifier = '';

    if (cookieName && signedCookies[cookieName]) {
      try {
        const flow = JSON.parse(String(signedCookies[cookieName]));
        next = safeNextPath(flow.next);
        verifier = String(flow.verifier || '');
      } catch {}
      res.clearCookie(cookieName, wixClearCookieOptions);
    } else {
      // Accept an OAuth attempt started by the previous deployment so users
      // already on Wix's login screen are not broken during rollout.
      const expectedState = String(signedCookies.nspa_wix_state || '');
      if (expectedState && state === expectedState) {
        next = safeNextPath(signedCookies.nspa_wix_next);
        verifier = String(signedCookies.nspa_wix_verifier || '');
      }
    }

    for (const name of ['nspa_wix_state', 'nspa_wix_verifier', 'nspa_wix_next']) {
      res.clearCookie(name, wixClearCookieOptions);
    }

    try {
      if (req.query.error) throw new Error(`Wix rejected sign-in: ${req.query.error}`);
      const code = String(req.query.code || '');
      if (!state || !verifier || !code) {
        const retry = `/api/auth/wix${next ? `?next=${encodeURIComponent(next)}` : ''}`;
        return res.status(400).send(`Invalid or expired Wix sign-in. <a href="${retry}">Try again</a>.`);
      }

      const identity = await wixAuth.finish({ code, verifier });
      const linked = await findUserByWixMemberId(identity.wixMemberId);
      if (linked && linked.email.toLowerCase() !== identity.email) {
        return res.status(409).send('This Wix account is already linked to another portal account.');
      }

      let user = await findUserByEmail(identity.email);
      if (user && user.wixMemberId && user.wixMemberId !== identity.wixMemberId) {
        return res.status(409).send('This portal account is already linked to another Wix account.');
      }
      if (!user) {
        await appendUser({
          // Wix owns authentication and supplies the verified email/member ID.
          // NSPA profile details are confirmed explicitly in the portal once,
          // so provider guesses never become member names.
          firstName: '',
          lastName: '',
          email: identity.email,
          phone: '',
          password: crypto.randomBytes(48).toString('base64url'),
          wixMemberId: identity.wixMemberId,
        });
        user = await findUserByEmail(identity.email);
      } else {
        const updates = {};
        if (!user.wixMemberId) updates.wixMemberId = identity.wixMemberId;
        if ((user.accountStatus || 'active') === 'deactivated') updates.accountStatus = 'active';
        if (Object.keys(updates).length) {
          await updateMembership(user.email, updates);
          invalidateSessionUser(user.email);
          user = await findUserByEmail(user.email);
        }
      }

      setSession(res, user.email);
      if (missingProfileFields(user).length) return res.redirect(completeProfileUrl(next));
      return res.redirect(isActiveMember(user) ? (next || '/dashboard.html') : '/membership.html');
    } catch (error) {
      console.error('wix callback:', error);
      return res.status(502).send('Could not complete Wix sign-in.');
    }
  }

  app.get('/api/auth/wix/callback', async (req, res) => {
    // Wix's current managed-login flow returns code/state in the fragment.
    // Fragments never reach a server, so this same-origin relay moves only the
    // expected OAuth fields into a request the server can validate.
    if (!req.query.code && !req.query.state && !req.query.error) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(wixCallbackRelayPage());
    }
    return completeWixSignIn(req, res);
  });

  app.get('/api/auth/wix/complete', completeWixSignIn);

  app.post('/api/auth/wix/profile', requireAuth, async (req, res) => {
    try {
      if (!req.user.wixMemberId) {
        return res.status(403).json({ error: 'Complete Wix sign-in before updating your account.' });
      }

      const body = req.body || {};
      const firstName = String(body.firstName || req.user.firstName || '').trim();
      const lastName = String(body.lastName || req.user.lastName || '').trim();
      const phone = String(body.phone || req.user.phone || '').trim();
      if (!firstName || !lastName || !phone) {
        return res.status(400).json({ error: 'First name, last name, and phone number are required.' });
      }
      if (firstName.length > 80 || lastName.length > 80) {
        return res.status(400).json({ error: 'First and last names must be 80 characters or fewer.' });
      }
      const phoneDigits = phone.replace(/\D/g, '');
      if (phone.length > 30 || phoneDigits.length < 7 || phoneDigits.length > 15) {
        return res.status(400).json({ error: 'Enter a valid phone number.' });
      }

      await updateMembership(req.user.email, { firstName, lastName, phone });
      invalidateSessionUser(req.user.email);
      const user = await findUserByEmail(req.user.email);
      const next = safeNextPath(body.next);
      res.json({
        ok: true,
        member: await publicMember(user),
        next: isActiveMember(user) ? (next || '/dashboard.html') : '/membership.html',
      });
    } catch (error) {
      console.error('wix profile:', error);
      res.status(500).json({ error: 'Could not save your details. Please try again.' });
    }
  });
  
  // Cancel membership but keep the account (and its member ID + project history).
  // The account and history remain available for a later renewal.
  app.post('/api/membership/cancel', requireAuth, async (req, res) => {
    try {
      const user = req.user;
      await updateMembership(user.email, {
        membershipStatus: 'inactive',
        membershipExpiry: '',
      });
      invalidateSessionUser(user.email);
      res.json({ ok: true });
    } catch (error) {
      console.error('cancel membership:', error);
      res.status(500).json({ error: 'Could not cancel your membership.' });
    }
  });
  
  // Deactivate the account. The row (and its member ID + project history) is kept
  // so the ID stays permanently reserved and can be restored on re-registration.
  app.post('/api/account/deactivate', requireAuth, async (req, res) => {
    try {
      const user = req.user;
  
      await updateMembership(user.email, {
        accountStatus: 'deactivated',
        membershipStatus: 'inactive',
      });
  
      invalidateSessionUser(user.email);
      clearSession(res);
      res.json({ ok: true });
    } catch (error) {
      console.error('deactivate:', error);
      res.status(500).json({ error: 'Could not deactivate your account.' });
    }
  });
}

module.exports = { registerAuthRoutes };
