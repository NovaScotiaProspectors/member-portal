const { clampInt } = require('../utils/numbers');

function registerPortalRoutes(app, ctx) {
  const { portal, visibleProjectsFor, readSubmissions, splitListValue } = ctx;

  /* ── Activity feed ──────────────────────────────────────────────────────── */
  
  app.get('/api/activity', async (req, res) => {
    try {
      const limit = clampInt(req.query.limit, 20, 1, 50);
      const offset = clampInt(req.query.offset, 0, 0, 100000);
      res.json(await portal.listActivity({ limit, offset }));
    } catch (error) {
      console.error('activity:', error.message);
      res.status(500).json({ error: 'Could not load the activity feed.' });
    }
  });
  
  /* ── Notifications ──────────────────────────────────────────────────────── */
  
  app.get('/api/notifications', async (req, res) => {
    try {
      const limit = clampInt(req.query.limit, 30, 1, 100);
      const offset = clampInt(req.query.offset, 0, 0, 100000);
      res.json(await portal.listNotifications(req.user.memberId, { limit, offset }));
    } catch (error) {
      console.error('notifications:', error.message);
      res.status(500).json({ error: 'Could not load your notifications.' });
    }
  });
  
  // Lightweight unread count for the nav badge on every page.
  app.get('/api/notifications/unread-count', async (req, res) => {
    try {
      res.json({ unread: await portal.unreadCount(req.user.memberId) });
    } catch (error) {
      console.error('unread count:', error.message);
      res.status(500).json({ error: 'Could not load your notifications.' });
    }
  });
  
  app.post('/api/notifications/read-all', async (req, res) => {
    try {
      res.json({ ok: true, updated: await portal.markAllNotificationsRead(req.user.memberId) });
    } catch (error) {
      console.error('read all:', error.message);
      res.status(500).json({ error: 'Could not update your notifications.' });
    }
  });
  
  app.post('/api/notifications/:id/read', async (req, res) => {
    try {
      const ok = await portal.markNotificationRead(req.user.memberId, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Notification not found.' });
      res.json({ ok: true });
    } catch (error) {
      console.error('read notification:', error.message);
      res.status(500).json({ error: 'Could not update the notification.' });
    }
  });
  
  app.delete('/api/notifications/:id', async (req, res) => {
    try {
      const ok = await portal.removeNotification(req.user.memberId, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Notification not found.' });
      res.json({ ok: true });
    } catch (error) {
      console.error('delete notification:', error.message);
      res.status(500).json({ error: 'Could not remove the notification.' });
    }
  });
  
  /* ── Favourites ─────────────────────────────────────────────────────────── */
  
  // Saved projects are resolved against the live project list so a favourite
  // never leaks a project that has since been removed.
  app.get('/api/favorites', async (req, res) => {
    try {
      const favorites = await portal.listFavorites(req.user.memberId);
      // Only projects the viewer is still allowed to see — a bookmark must not
      // keep a project visible after its owner's membership lapses.
      const byId = new Map((await visibleProjectsFor(req.user)).map(p => [p.id, p]));
      const submissions = await readSubmissions();
      const docCounts = new Map(
        submissions.map(s => [s.id, Array.isArray(s.documents) ? s.documents.length : 0])
      );
  
      const projects = favorites
        .map(f => {
          const project = byId.get(f.projectId);
          if (!project) return null;
          return {
            id: project.id,
            title: project.title,
            operator: project.operator,
            status: project.status,
            commodities: splitListValue(project.commodities),
            tenures: splitListValue(project.tenures),
            projectStage: project.projectStage,
            documentCount: docCounts.get(project.id) || 0,
            savedAt: f.createdAt,
          };
        })
        .filter(Boolean);
  
      res.json({ projects });
    } catch (error) {
      console.error('favorites:', error.message);
      res.status(500).json({ error: 'Could not load your saved projects.' });
    }
  });
  
  // Just the IDs — used to paint the bookmark buttons on list views.
  app.get('/api/favorites/ids', async (req, res) => {
    try {
      res.json({ ids: (await portal.listFavorites(req.user.memberId)).map(f => f.projectId) });
    } catch (error) {
      console.error('favorite ids:', error.message);
      res.status(500).json({ error: 'Could not load your saved projects.' });
    }
  });
  
  app.post('/api/favorites/:projectId', async (req, res) => {
    try {
      const projectId = String(req.params.projectId);
      const exists = (await visibleProjectsFor(req.user)).some(p => p.id === projectId);
      if (!exists) return res.status(404).json({ error: 'Project not found.' });
  
      await portal.addFavorite(req.user.memberId, projectId);
      res.json({ ok: true, saved: true });
    } catch (error) {
      console.error('add favorite:', error.message);
      res.status(500).json({ error: 'Could not save the project.' });
    }
  });
  
  app.delete('/api/favorites/:projectId', async (req, res) => {
    try {
      await portal.removeFavorite(req.user.memberId, String(req.params.projectId));
      res.json({ ok: true, saved: false });
    } catch (error) {
      console.error('remove favorite:', error.message);
      res.status(500).json({ error: 'Could not remove the saved project.' });
    }
  });
}

module.exports = { registerPortalRoutes };
