const crypto = require('crypto');
const { safeNextPath } = require('../utils/nextPath');

function missingProfileFields(user) {
  if (!user) return ['firstName', 'lastName', 'phone'];
  return ['firstName', 'lastName', 'phone'].filter(field => !String(user[field] || '').trim());
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
          firstName: identity.firstName,
          lastName: identity.lastName,
          email: identity.email,
          phone: identity.phone,
          password: crypto.randomBytes(48).toString('base64url'),
          wixMemberId: identity.wixMemberId,
        });
        user = await findUserByEmail(identity.email);
      } else {
        const updates = {};
        if (!user.wixMemberId) updates.wixMemberId = identity.wixMemberId;
        if ((user.accountStatus || 'active') === 'deactivated') updates.accountStatus = 'active';
        // Social login often supplies a name. Fill only blank registry fields;
        // never overwrite details the member has already confirmed.
        if (!String(user.firstName || '').trim() && identity.firstName) updates.firstName = identity.firstName;
        if (!String(user.lastName || '').trim() && identity.lastName) updates.lastName = identity.lastName;
        if (!String(user.phone || '').trim() && identity.phone) updates.phone = identity.phone;
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
  });

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
