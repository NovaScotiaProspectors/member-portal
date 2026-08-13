function csvValue(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(res, fileName, headers, rows) {
  const csv = [
    headers.map(csvValue).join(','),
    ...rows.map(row => headers.map(header => csvValue(row[header])).join(',')),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(csv);
}

function registerAdminRoutes(app, ctx) {
  const {
    requireAdminApi,
    verifyMailer,
    mailer,
    mailFrom,
    listUsers,
    listProjects,
    isActiveMember,
    projectStatuses,
    zeffyStudentUrl,
    zeffyRegularUrl,
    getMailStatus,
    portal,
    activateMembership,
    updateMembership,
  } = ctx;

  app.post('/api/admin/mail/test', requireAdminApi, async (req, res) => {
    const status = await verifyMailer();
    if (!status.configured) {
      return res.status(503).json({
        error: 'Email is not configured. Set RESEND_API_KEY (or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) in the environment, then restart.',
        ...status,
      });
    }
    if (!status.verified) {
      return res.status(502).json({ error: `The mail provider rejected the connection: ${status.error}`, ...status });
    }

    const to = String(req.body.to || req.user.email || '').trim();
    try {
      await mailer.sendMail({
        from: mailFrom,
        to,
        subject: 'NSPA test email',
        text: 'This is a test from the NSPA member portal. If you received it, claim alerts will be emailed.\n',
      });
      res.json({ ok: true, sentTo: to, ...status });
    } catch (error) {
      res.status(502).json({ error: `Could not send: ${error.message}`, ...status });
    }
  });

  app.get('/api/admin/members', requireAdminApi, async (req, res) => {
    try {
      const users = await listUsers();
      const activeMembers = users.filter(u => isActiveMember(u) && (u.accountStatus || 'active') !== 'deactivated').length;
      res.json({ total: users.length, activeMembers, users });
    } catch (error) {
      console.error('admin members:', error.message);
      res.status(500).json({ error: 'Could not load members.' });
    }
  });

  app.get('/api/admin/overview', requireAdminApi, async (req, res) => {
    try {
      const [users, projects] = await Promise.all([listUsers(), listProjects()]);
      const activeMembers = users.filter(u => isActiveMember(u) && (u.accountStatus || 'active') !== 'deactivated').length;
      const networkMembers = users.filter(u => (u.networkStatus || 'out') === 'joined').length;
      const archivedProjects = projects.filter(p => p.archived).length;
      const statusCounts = Object.fromEntries(projectStatuses.map(s => [s, 0]));
      for (const project of projects) {
        statusCounts[project.status || 'Pending'] = (statusCounts[project.status || 'Pending'] || 0) + 1;
      }

      res.json({
        members: { total: users.length, active: activeMembers, network: networkMembers },
        projects: { total: projects.length, archived: archivedProjects, statuses: statusCounts },
        paymentsEnabled: !!(zeffyStudentUrl && zeffyRegularUrl),
        mail: getMailStatus(),
        claimWatch: await portal.getSetting('lastClaimWatch', null),
        eventsArchiveEnabled: !!(await portal.getSetting('eventsArchiveEnabled', false)),
      });
    } catch (error) {
      console.error('admin overview:', error.message);
      res.status(500).json({ error: 'Could not load admin overview.' });
    }
  });

  app.post('/api/admin/members/:memberId/status', requireAdminApi, async (req, res) => {
    try {
      const memberId = String(req.params.memberId);
      const action = String(req.body.action || '');
      const users = await listUsers();
      const user = users.find(u => u.memberId === memberId);
      if (!user) return res.status(404).json({ error: 'Member not found.' });

      if (action === 'activate') {
        await activateMembership(user.email, '', '');
      } else if (action === 'lapse') {
        await updateMembership(user.email, { membershipStatus: 'inactive', membershipExpiry: '', subscriptionId: '' });
      } else if (action === 'deactivate') {
        await updateMembership(user.email, { accountStatus: 'deactivated', membershipStatus: 'inactive', subscriptionId: '', networkStatus: 'out' });
      } else if (action === 'restore') {
        await updateMembership(user.email, { accountStatus: 'active' });
      } else {
        return res.status(400).json({ error: 'Unknown member action.' });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error('admin member status:', error.message);
      res.status(500).json({ error: 'Could not update member.' });
    }
  });

  app.get('/api/admin/export/members.csv', requireAdminApi, async (req, res) => {
    try {
      const users = await listUsers();
      const headers = ['memberId', 'firstName', 'lastName', 'email', 'phone', 'membershipStatus', 'memberSince', 'membershipExpiry', 'accountStatus', 'networkStatus', 'studentStatus', 'studentEmail', 'studentInstitution'];
      sendCsv(res, 'nspa-members.csv', headers, users.map(u => ({
        ...u,
        studentStatus: (u.studentVerification || {}).status || 'none',
        studentEmail: (u.studentVerification || {}).schoolEmail || '',
        studentInstitution: (u.studentVerification || {}).institution || '',
      })));
    } catch (error) {
      console.error('export members:', error.message);
      res.status(500).json({ error: 'Could not export members.' });
    }
  });

  app.get('/api/admin/export/projects.csv', requireAdminApi, async (req, res) => {
    try {
      const projects = await listProjects();
      const headers = ['id', 'createdAt', 'memberId', 'firstName', 'lastName', 'email', 'title', 'operator', 'tenures', 'commodities', 'depositTypes', 'projectStage', 'status', 'archived'];
      sendCsv(res, 'nspa-projects.csv', headers, projects);
    } catch (error) {
      console.error('export projects:', error.message);
      res.status(500).json({ error: 'Could not export projects.' });
    }
  });
}

module.exports = { registerAdminRoutes };
