function registerAuthRoutes(app, ctx) {
  const {
    findUserByEmail, updateMembership, hashPassword, appendUser, invalidateSessionUser,
    setSession, clearSession, verifyPassword, isActiveMember, publicMember, isAdmin, requireAuth,
    serializeNetworkVisibility, DEFAULT_NETWORK_VISIBILITY, ZEFFY_STUDENT_URL, ZEFFY_REGULAR_URL,
    WIX_SITE_URL, WIX_MEMBER_LOGIN_URL, APP_BASE_URL,
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
          membershipStatus: 'none',
          memberSince: '',
          networkStatus: 'out',
          networkVisibility: serializeNetworkVisibility(DEFAULT_NETWORK_VISIBILITY),
        });
        invalidateSessionUser(email);
        setSession(res, email);
        return res.status(200).json({
          ok: true,
          restored: true,
          member: { memberId: existing.memberId, firstName, lastName, email, phone, membershipStatus: 'none', isMember: false },
        });
      }
  
      const memberId = await appendUser({ firstName, lastName, email, phone, password });
      invalidateSessionUser(email);
      setSession(res, email);
      res.status(201).json({
        ok: true,
        member: { memberId, firstName, lastName, email, phone, membershipStatus: 'none', isMember: false },
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
      wixMemberLoginUrl: WIX_MEMBER_LOGIN_URL,
      appBaseUrl: APP_BASE_URL,
      publicMapUrl: `${APP_BASE_URL}/map.html`,
      eventsUrl: `${APP_BASE_URL}/events.html`,
      memberPortalUrl: `${APP_BASE_URL}/dashboard.html`,
      membershipPlans: [
        { id: 'student', label: 'Student Member', price: 'CA$15', url: ZEFFY_STUDENT_URL },
        { id: 'regular', label: 'Regular Member', price: 'CA$35', url: ZEFFY_REGULAR_URL },
      ],
      paymentsEnabled: !!(ZEFFY_STUDENT_URL && ZEFFY_REGULAR_URL),
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
      memberLoginUrl: WIX_MEMBER_LOGIN_URL || `${APP_BASE_URL}/signup.html`,
      wixSiteUrl: WIX_SITE_URL,
    });
  });
  
  app.post('/api/signout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });
  
  // Cancel membership but keep the account (and its member ID + project history).
  // The member becomes a registered non-member and can re-join later.
  app.post('/api/membership/cancel', requireAuth, async (req, res) => {
    try {
      const user = req.user;
      await updateMembership(user.email, {
        membershipStatus: 'inactive',
        membershipExpiry: '',
        subscriptionId: '',
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
        subscriptionId: '',
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
