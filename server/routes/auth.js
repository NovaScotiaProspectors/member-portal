const crypto = require('crypto');
const { safeNextPath } = require('../utils/nextPath');

function registerAuthRoutes(app, ctx) {
  const {
    findUserByEmail, updateMembership, hashPassword, appendUser, invalidateSessionUser,
    setSession, clearSession, verifyPassword, isActiveMember, publicMember, isAdmin, requireAuth,
    serializeNetworkVisibility, DEFAULT_NETWORK_VISIBILITY, ZEFFY_STUDENT_URL, ZEFFY_REGULAR_URL,
    WIX_SITE_URL, WIX_MEMBER_LOGIN_URL, APP_BASE_URL, wixAuth, secureCookies,
    findUserByWixMemberId, zeffy,
  } = ctx;

  app.post('/api/signup', async (req, res) => {
    try {
      const firstName = String(req.body.firstName || '').trim();
      const lastName  = String(req.body.lastName || '').trim();
      const email     = String(req.body.email || '').trim();
      const phone     = String(req.body.phone || '').trim();
      const password  = String(req.body.password || '');
  
      if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First and last name are required.' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }
  
      const existing = await findUserByEmail(email);
      if (existing) {
        if ((existing.accountStatus || 'active') !== 'deactivated') {
          return res.status(409).json({ error: 'An account with that email already exists.' });
        }
  
        // Restore a previously deactivated account: reuse its original member ID
        // and keep its project history, just refresh the credentials/details.
        await updateMembership(email, {
          firstName,
          lastName,
          phone,
          passwordHash: hashPassword(password),
          accountStatus: 'active',
          membershipStatus: 'pending_payment',
          memberSince: '',
          networkStatus: 'out',
          networkVisibility: serializeNetworkVisibility(DEFAULT_NETWORK_VISIBILITY),
        });
        invalidateSessionUser(email);
        setSession(res, email);
        return res.status(200).json({
          ok: true,
          restored: true,
          member: { memberId: existing.memberId, firstName, lastName, email, phone, membershipStatus: 'pending_payment', isMember: false },
        });
      }
  
      const memberId = await appendUser({ firstName, lastName, email, phone, password });
      invalidateSessionUser(email);
      setSession(res, email);
      res.status(201).json({
        ok: true,
        member: { memberId, firstName, lastName, email, phone, membershipStatus: 'pending_payment', isMember: false },
      });
    } catch (error) {
      if (error.code === 'DUP') return res.status(409).json({ error: error.message });
      console.error('signup:', error);
      res.status(500).json({ error: 'Could not save your sign-up. Please try again.' });
    }
  });
  
  app.post('/api/signin', async (req, res) => {
    try {
      const email = String(req.body.email || '').trim();
      const password = String(req.body.password || '');
  
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }
  
      const user = await findUserByEmail(email);
      if (user && (user.accountStatus || 'active') === 'deactivated') {
        return res.status(403).json({
          error: 'This account was deactivated. Sign up again with the same email to restore it.',
          deactivated: true,
        });
      }
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
  
      setSession(res, user.email);
      res.json({
        ok: true,
        member: {
          memberId: user.memberId,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          membershipStatus: user.membershipStatus,
          isMember: isActiveMember(user),
          membershipExpiry: user.membershipExpiry || null,
        },
      });
    } catch (error) {
      console.error('signin:', error);
      res.status(500).json({ error: 'Could not sign in. Please try again.' });
    }
  });
  
  app.get('/api/me', async (req, res) => {
    res.json({
      authenticated: !!req.user,
      member: await publicMember(req.user),
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
    maxAge: 10 * 60 * 1000,
  };

  app.get('/api/auth/wix', async (req, res) => {
    if (!wixAuth.configured) return res.status(503).send('Wix sign-in is not configured.');
    try {
      const flow = await wixAuth.begin();
      res.cookie('nspa_wix_state', flow.state, wixCookieOptions);
      res.cookie('nspa_wix_verifier', flow.verifier, wixCookieOptions);
      res.cookie('nspa_wix_next', safeNextPath(req.query.next), wixCookieOptions);
      return res.redirect(flow.url);
    } catch (error) {
      console.error('wix sign-in:', error);
      return res.status(502).send('Could not start Wix sign-in.');
    }
  });

  app.get('/api/auth/wix/callback', async (req, res) => {
    // Read the one-time cookies, then clear them immediately — before any
    // response is sent. Clearing afterwards (in a `finally`, say) sets headers
    // on a request that has already been answered, which throws
    // ERR_HTTP_HEADERS_SENT and takes the process down with it.
    const signedCookies = req.signedCookies || {};
    const next = safeNextPath(signedCookies.nspa_wix_next);
    const expectedState = String(signedCookies.nspa_wix_state || '');
    const verifier = String(signedCookies.nspa_wix_verifier || '');
    for (const name of ['nspa_wix_state', 'nspa_wix_verifier', 'nspa_wix_next']) {
      res.clearCookie(name, { sameSite: 'lax', secure: secureCookies });
    }

    try {
      if (req.query.error) throw new Error(`Wix rejected sign-in: ${req.query.error}`);
      const state = String(req.query.state || '');
      const code = String(req.query.code || '');
      if (!state || !expectedState || state !== expectedState || !verifier || !code) {
        return res.status(400).send('Invalid or expired Wix sign-in.');
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
          firstName: identity.firstName || identity.email.split('@')[0],
          lastName: identity.lastName || 'Member',
          email: identity.email,
          phone: identity.phone,
          password: crypto.randomBytes(48).toString('base64url'),
          wixMemberId: identity.wixMemberId,
        });
        user = await findUserByEmail(identity.email);
      } else if (!user.wixMemberId || (user.accountStatus || 'active') === 'deactivated') {
        await updateMembership(user.email, { wixMemberId: identity.wixMemberId, accountStatus: 'active' });
        invalidateSessionUser(user.email);
        user = await findUserByEmail(user.email);
      }

      setSession(res, user.email);
      return res.redirect(isActiveMember(user) ? (next || '/dashboard.html') : '/membership.html');
    } catch (error) {
      console.error('wix callback:', error);
      return res.status(502).send('Could not complete Wix sign-in.');
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
