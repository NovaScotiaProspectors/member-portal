function registerClaimRoutes(app, ctx) {
  const {
    requireMemberApi, requireAdminApi, claimsForMember, listUsers, portal, claimwatch,
    cleanClaimAlertInput, readSubmissions, runClaimWatchNow,
  } = ctx;

  app.get('/api/claims', requireMemberApi, async (req, res) => {
    try {
      const [claims, users] = await Promise.all([claimsForMember(req.user), listUsers()]);
      const nameById = new Map(users.map(u => [u.memberId, [u.firstName, u.lastName].filter(Boolean).join(' ')]));
  
      // Group neighbours under the claim they abut, naming fellow members.
      const neighboursByClaim = new Map();
      for (const row of await portal.listNeighbours(req.user.memberId)) {
        if (!neighboursByClaim.has(row.tenureNumber)) neighboursByClaim.set(row.tenureNumber, []);
        neighboursByClaim.get(row.tenureNumber).push({
          tenureNumber: row.neighbourTenure,
          status: row.status || '',
          titleType: row.titleType || '',
          expiry: row.expiry || '',
          expiryDays: claimwatch.daysUntil(row.expiry),
          memberId: row.neighbourMember || null,
          memberName: row.neighbourMember ? (nameById.get(row.neighbourMember) || 'NSPA member') : null,
        });
      }
  
      res.json({
        claims: claims.map(c => ({ ...c, neighbours: neighboursByClaim.get(c.tenureNumber) || [] })),
        alerts: await portal.listTenureAlerts(req.user.memberId, 25),
        opportunityAlerts: await portal.listClaimAlerts(req.user.memberId),
        opportunityMatches: await portal.listAlertMatches(req.user.memberId, 25),
        lastChecked: ((await portal.getSetting('lastClaimWatch', null)) || {}).finishedAt || null,
        openGroundWindowDays: claimwatch.OPEN_GROUND_WINDOW_DAYS,
      });
    } catch (error) {
      console.error('claims:', error.message);
      res.status(500).json({ error: 'Could not load your claims.' });
    }
  });
  
  app.post('/api/claim-alerts', requireMemberApi, async (req, res) => {
    try {
      const alert = await portal.createClaimAlert(cleanClaimAlertInput(req.body || {}, req.user.memberId));
      res.status(201).json({ ok: true, alert });
    } catch (error) {
      console.error('create claim alert:', error.message);
      res.status(500).json({ error: 'Could not save the alert.' });
    }
  });
  
  app.put('/api/claim-alerts/:id', requireMemberApi, async (req, res) => {
    try {
      const alert = await portal.updateClaimAlert({
        ...cleanClaimAlertInput(req.body || {}, req.user.memberId),
        id: req.params.id,
      });
      if (!alert) return res.status(404).json({ error: 'Alert not found.' });
      res.json({ ok: true, alert });
    } catch (error) {
      console.error('update claim alert:', error.message);
      res.status(500).json({ error: 'Could not update the alert.' });
    }
  });
  
  app.delete('/api/claim-alerts/:id', requireMemberApi, async (req, res) => {
    try {
      if (!(await portal.removeClaimAlert(req.user.memberId, req.params.id))) {
        return res.status(404).json({ error: 'Alert not found.' });
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('delete claim alert:', error.message);
      res.status(500).json({ error: 'Could not delete the alert.' });
    }
  });
  
  /**
   * Member claim polygons for Field Mode. Kept small because this payload is
   * cached by the service worker for offline boundary checks.
   */
  app.get('/api/claims/geometry', requireMemberApi, async (req, res) => {
    try {
      const submissions = await readSubmissions();
      const claims = submissions
        .filter(s => s.memberId === req.user.memberId)
        .map(s => ({
          projectId: s.id,
          projectTitle: s.project || s.id,
          tenures: (s.tenures || [])
            .filter(t => t && t.geojson)
            .map(t => ({ tenureNumber: t.tenureNumber, geojson: t.geojson })),
        }))
        .filter(c => c.tenures.length);
  
      res.json({ claims });
    } catch (error) {
      console.error('claims geometry:', error.message);
      res.status(500).json({ error: 'Could not load your claim boundaries.' });
    }
  });
  
  // Manual sweep, for admins and for testing without waiting for the timer.
  app.post('/api/admin/claims/run-watch', requireAdminApi, async (req, res) => {
    const result = await runClaimWatchNow();
    if (result.error) return res.status(502).json(result);
    res.json({ ok: true, ...result });
  });
}

module.exports = { registerClaimRoutes };
