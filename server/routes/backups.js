const path = require('path');

function registerBackupRoutes(app, {
  dataDir,
  backupService,
  requireAdminApi,
  emailConfigured,
}) {
  app.get('/api/admin/backups', requireAdminApi, async (req, res) => {
    try {
      res.json({
        ...(await backupService.listBackups()),
        emailConfigured,
      });
    } catch (error) {
      console.error('list backups:', error.message);
      res.status(500).json({ error: 'Could not list backups.' });
    }
  });

  app.post('/api/admin/backups/run', requireAdminApi, async (req, res) => {
    const kind = req.body.kind === 'full' ? 'full' : 'core';
    const result = await backupService.runBackup({ kind, email: req.body.email !== false });
    if (result.error) return res.status(500).json(result);
    res.json({ ok: true, ...result });
  });

  app.get('/api/admin/backups/:name', requireAdminApi, (req, res) => {
    const name = path.basename(String(req.params.name));
    if (!/^nspa-(core|full)-[\w-]+\.zip$/.test(name)) {
      return res.status(400).json({ error: 'Not a backup file name.' });
    }
    const file = path.join(dataDir, 'backups', name);
    res.download(file, name, err => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Backup not found.' });
    });
  });
}

module.exports = { registerBackupRoutes };
