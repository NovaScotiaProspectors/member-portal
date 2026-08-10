const express = require('express');
const fs = require('fs/promises');
const path = require('path');

function registerPageRoutes(app, {
  publicDir,
  pagesDir,
  modulesDir,
  stylesDir,
  useSupabase,
  dataDriver,
  dataDir,
  supabase,
  requireMemberPage,
  requireAdminPage,
}) {
  app.get('/healthz', async (req, res) => {
    if (useSupabase) {
      return res.json({
        ok: true,
        dataDriver,
        storage: `supabase:${supabase.bucket}`,
        uptime: Math.round(process.uptime()),
      });
    }
    try {
      await fs.access(dataDir);
      res.json({ ok: true, dataDriver, dataDir, uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ ok: false, error: `Data directory not writable: ${dataDir}` });
    }
  });

  app.get('/', (req, res) => res.sendFile(path.join(pagesDir, 'home.html')));
  app.get('/index.html', requireMemberPage, (req, res) => res.sendFile(path.join(pagesDir, 'index.html')));

  for (const page of ['home.html', 'signup.html', 'membership.html', 'prices.html']) {
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(pagesDir, page)));
  }

  app.get('/admin.html', requireAdminPage, (req, res) => res.sendFile(path.join(pagesDir, 'admin.html')));
  app.get('/dashboard.html', requireMemberPage, (req, res) => res.sendFile(path.join(pagesDir, 'dashboard.html')));
  app.get('/network.html', requireMemberPage, (req, res) => res.sendFile(path.join(pagesDir, 'network.html')));
  app.get('/map.html', (req, res) => res.sendFile(path.join(pagesDir, 'map.html')));

  for (const page of [
    'notifications.html', 'saved.html', 'events.html', 'resources.html', 'activity.html',
    'project.html', 'search.html', 'compare.html', 'member.html', 'field.html',
    'claims.html',
  ]) {
    app.get(`/${page}`, requireMemberPage, (req, res) => res.sendFile(path.join(pagesDir, page)));
  }

  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('application/javascript');
    res.sendFile(path.join(publicDir, 'sw.js'));
  });

  app.use(express.static(publicDir, { index: false }));
  app.use('/modules', express.static(modulesDir, { index: false }));
  app.use('/styles', express.static(stylesDir, { index: false }));
}

module.exports = { registerPageRoutes };
