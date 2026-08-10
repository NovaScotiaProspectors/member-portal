const crypto = require('crypto');

function registerMembershipRoutes(app, ctx) {
  const {
    requireAuth,
    portal,
    mailer,
    mailFrom,
    normalizeEmail,
    emailDomain,
    studentDomainAllowed,
    hashStudentCode,
    publicStudentVerification,
    clampText,
    studentVerificationOk,
    zeffyStudentUrl,
    zeffyRegularUrl,
    studentEmailDomains,
  } = ctx;

  app.get('/api/student-verification', requireAuth, async (req, res) => {
    res.json({
      verification: publicStudentVerification(await portal.getStudentVerification(req.user.memberId)),
      allowedDomainsConfigured: studentEmailDomains.length > 0,
    });
  });

  app.post('/api/student-verification/send', requireAuth, async (req, res) => {
    try {
      if (!mailer) {
        return res.status(503).json({ error: 'Student email verification needs SMTP configured first.' });
      }

      const schoolEmail = normalizeEmail(req.body.schoolEmail);
      const institution = clampText(req.body.institution, 120);
      const domain = emailDomain(schoolEmail);
      if (!institution) return res.status(400).json({ error: 'School or institution name is required.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(schoolEmail)) {
        return res.status(400).json({ error: 'A valid school email is required.' });
      }
      if (!studentDomainAllowed(domain)) {
        return res.status(400).json({ error: 'That school email domain is not enabled for student verification.' });
      }

      const existing = await portal.getStudentVerification(req.user.memberId);
      if (existing && existing.requestedAt && Date.now() - new Date(existing.requestedAt).getTime() < 60 * 1000) {
        return res.status(429).json({ error: 'Wait a minute before requesting another code.' });
      }

      const code = String(crypto.randomInt(100000, 1000000));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const record = await portal.saveStudentVerification({
        memberId: req.user.memberId,
        institution,
        schoolEmail,
        emailDomain: domain,
        codeHash: hashStudentCode(req.user.memberId, schoolEmail, code),
        status: 'pending',
        requestedAt: new Date().toISOString(),
        expiresAt,
        verifiedAt: null,
      });

      await mailer.sendMail({
        from: mailFrom,
        to: schoolEmail,
        subject: 'NSPA student membership verification code',
        text:
          `Your NSPA student membership verification code is ${code}.\n\n` +
          `It expires in 15 minutes. If you did not request this, ignore this email.\n`,
      });

      res.json({ ok: true, verification: publicStudentVerification(record), expiresAt });
    } catch (error) {
      console.error('student verification send:', error.message);
      res.status(502).json({ error: 'Could not send the verification code.' });
    }
  });

  app.post('/api/student-verification/confirm', requireAuth, async (req, res) => {
    try {
      const code = String(req.body.code || '').trim();
      const record = await portal.getStudentVerification(req.user.memberId);
      if (!record || record.status !== 'pending') {
        return res.status(400).json({ error: 'Request a verification code first.' });
      }
      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Enter the 6-digit code.' });
      }
      if (!record.expiresAt || Date.now() > new Date(record.expiresAt).getTime()) {
        return res.status(400).json({ error: 'That code has expired. Request a new one.' });
      }
      if (hashStudentCode(req.user.memberId, record.schoolEmail, code) !== record.codeHash) {
        return res.status(400).json({ error: 'Incorrect verification code.' });
      }

      const verified = await portal.confirmStudentVerification(req.user.memberId);
      res.json({ ok: true, verification: publicStudentVerification(verified) });
    } catch (error) {
      console.error('student verification confirm:', error.message);
      res.status(500).json({ error: 'Could not verify student email.' });
    }
  });

  app.post('/api/checkout', requireAuth, async (req, res) => {
    try {
      const plan = String(req.body.plan || '').toLowerCase();
      const plans = {
        student: { url: zeffyStudentUrl, label: 'Student Member', price: 'CA$15' },
        regular: { url: zeffyRegularUrl, label: 'Regular Member', price: 'CA$35' },
      };
      const selected = plans[plan];
      if (!selected) {
        return res.status(400).json({ error: 'Choose Student Member or Regular Member.' });
      }
      if (!selected.url) {
        return res.status(503).json({ error: `Zeffy ${selected.label} checkout is not configured yet.` });
      }
      if (plan === 'student' && !(await studentVerificationOk(req.user.memberId))) {
        return res.status(403).json({ error: 'Verify your school email before choosing Student Member.' });
      }

      res.json({ url: selected.url, plan, label: selected.label, price: selected.price });
    } catch (error) {
      console.error('checkout:', error.message);
      res.status(500).json({ error: 'Could not start checkout.' });
    }
  });
}

module.exports = { registerMembershipRoutes };
