function createBackupService({
  backup,
  portal,
  supabase,
  useSupabase,
  dataDir,
  keep,
  adminEmails,
  appBaseUrl,
  emailMaxBytes,
  sendMailIfConfigured,
  sendMailAwaited,
  safely,
}) {
  async function runBackup({ kind = 'core', email = true } = {}) {
    const startedAt = new Date().toISOString();
    try {
      const made = useSupabase
        ? await backup.createSupabaseBackup({ dataDir, supabase, kind })
        : await backup.createBackup({ dataDir, db: portal.db, kind });
      const pruned = await backup.pruneBackups(dataDir, keep);

      let delivery = { sent: false, reason: 'not attempted' };
      if (email && adminEmails.length) {
        if (made.bytes > emailMaxBytes) {
          delivery = { sent: false, reason: `archive too large to email (${(made.bytes / 1048576).toFixed(1)} MB)` };
          sendMailIfConfigured({
            to: adminEmails.join(','),
            subject: 'NSPA backup ready to download (too large to attach)',
            text: `Tonight's backup ${made.name} is ${(made.bytes / 1048576).toFixed(1)} MB, which is too large to email.\n\n` +
                  `Download it from the admin page: ${appBaseUrl}/admin.html\n`,
          });
        } else {
          delivery = await sendMailAwaited({
            to: adminEmails.join(','),
            subject: `NSPA backup — ${made.name}`,
            text: [
              'Attached is the latest backup of the NSPA members\' portal.',
              '',
              'It contains the member registry and project records.',
              '',
              'The included spreadsheets can be opened independently for review or recovery.',
            ].join('\n'),
            attachments: [{ filename: made.name, path: made.path }],
          });
        }
      }

      const lastBackup = {
        ...made,
        startedAt,
        finishedAt: new Date().toISOString(),
        pruned: pruned.removed,
        emailed: delivery.sent,
        emailNote: delivery.sent ? null : delivery.reason,
      };
      safely('record backup', () => portal.setSetting('lastBackup', lastBackup));

      console.log(
        `backup: ${made.name} (${(made.bytes / 1024).toFixed(0)} KB)` +
        `${delivery.sent ? ', emailed' : `, not emailed — ${delivery.reason}`}` +
        `${pruned.removed ? `, ${pruned.removed} old removed` : ''}`
      );
      return lastBackup;
    } catch (error) {
      console.error('backup failed:', error.message);
      return { error: error.message, startedAt };
    }
  }

  async function listBackups() {
    return {
      backups: await backup.listBackups(dataDir),
      last: await portal.getSetting('lastBackup', null),
      emailTo: adminEmails,
    };
  }

  return { runBackup, listBackups };
}

module.exports = { createBackupService };
