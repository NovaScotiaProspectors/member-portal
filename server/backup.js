/* ────────────────────────────────────────────────────────────────────────────
 * Backups.
 *
 * Core backups include structured application data. Full backups also include
 * uploaded documents. Files are written atomically before being archived.
 * ────────────────────────────────────────────────────────────────────────── */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');

// Core application data included in every backup.
const CORE_ITEMS = ['users.xlsx', 'projects.xlsx', 'submissions.json'];
const UPLOAD_DIRS = ['uploads', 'resources', 'event-files'];

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Writes a zip. `entries` is a list of {source, name} for files and
 * {directory, name} for whole trees; missing paths are skipped rather than
 * failing the whole backup.
 */
function writeArchive(targetPath, entries) {
  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(targetPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve({ path: targetPath, bytes: archive.pointer() }));
    output.on('error', reject);
    archive.on('warning', err => {
      // Missing optional paths should not prevent archive creation.
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);

    archive.pipe(output);
    for (const entry of entries) {
      if (entry.contents !== undefined) {
        archive.append(entry.contents, { name: entry.name });
      } else if (entry.directory) {
        if (fsSync.existsSync(entry.directory)) archive.directory(entry.directory, entry.name);
      } else if (fsSync.existsSync(entry.source)) {
        archive.file(entry.source, { name: entry.name });
      }
    }
    archive.finalize();
  });
}

/**
 * SQLite needs its own backup call rather than a file copy — in WAL mode the
 * database is spread across .db/.db-wal and copying mid-write yields an
 * inconsistent snapshot.
 */
async function snapshotDatabase(db, targetPath) {
  try {
    await db.backup(targetPath);
    return true;
  } catch (error) {
    console.warn('backup: database snapshot failed —', error.message);
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir     where the live data lives
 * @param {object} opts.db          better-sqlite3 handle, for a consistent snapshot
 * @param {'core'|'full'} opts.kind
 */
async function createBackup({ dataDir, db, kind = 'core' }) {
  const backupsDir = path.join(dataDir, 'backups');
  await fs.mkdir(backupsDir, { recursive: true });

  const name = `nspa-${kind}-${stamp()}.zip`;
  const target = path.join(backupsDir, name);

  // Snapshot the database before adding it to the archive.
  const dbSnapshot = path.join(backupsDir, `.portal-${process.pid}.db`);
  const haveDb = db ? await snapshotDatabase(db, dbSnapshot) : false;

  const entries = CORE_ITEMS.map(f => ({ source: path.join(dataDir, f), name: f }));
  if (haveDb) entries.push({ source: dbSnapshot, name: 'portal.db' });

  if (kind === 'full') {
    for (const dir of UPLOAD_DIRS) {
      entries.push({ directory: path.join(dataDir, dir), name: dir });
    }
  }

  // Include a manifest describing the archive contents.
  const readme = path.join(backupsDir, `.readme-${process.pid}.txt`);
  await fs.writeFile(readme, [
    'NSPA members\' portal backup',
    `Taken: ${new Date().toISOString()}`,
    `Type:  ${kind}`,
    '',
    'users.xlsx       — the member registry. Opens in Excel.',
    'projects.xlsx    — every submitted project. Opens in Excel.',
    'submissions.json — full project records including claim boundaries.',
    'portal.db        — notifications, events, alerts (SQLite).',
    kind === 'full' ? 'uploads/         — member-uploaded documents, in folders by project.' : '',
    '',
    'The two spreadsheets are the important ones: they are the association\'s',
    'record of members and projects, and they can be read without this app.',
  ].filter(Boolean).join('\n'));
  entries.push({ source: readme, name: 'README.txt' });

  try {
    const result = await writeArchive(target, entries);
    return { ...result, name, kind, takenAt: new Date().toISOString() };
  } finally {
    await fs.unlink(dbSnapshot).catch(() => {});
    await fs.unlink(readme).catch(() => {});
  }
}

const SUPABASE_TABLES = [
  'members',
  'projects',
  'project_submissions',
  'project_documents',
  'portal_settings',
  'activity',
  'notifications',
  'favorites',
  'events',
  'event_registrations',
  'event_files',
  'resources',
  'student_verifications',
  'tenure_watch',
  'tenure_alerts',
  'claim_neighbours',
  'claim_alerts',
  'alert_areas',
  'alert_matches',
  'watchlist_items',
];

async function createSupabaseBackup({ dataDir, supabase, kind = 'core' }) {
  const backupsDir = path.join(dataDir, 'backups');
  await fs.mkdir(backupsDir, { recursive: true });

  const name = `nspa-${kind}-${stamp()}.zip`;
  const target = path.join(backupsDir, name);
  const entries = [];

  for (const table of SUPABASE_TABLES) {
    const rows = await supabase.select(table, 'select=*');
    entries.push({ name: `supabase/${table}.json`, contents: JSON.stringify(rows, null, 2) });
  }

  entries.push({
    name: 'README.txt',
    contents: [
      'NSPA members\' portal Supabase backup',
      `Taken: ${new Date().toISOString()}`,
      `Type:  ${kind}`,
      '',
      'This archive contains JSON exports of the Supabase database tables.',
      'Uploaded files remain in Supabase Storage; export them from the Supabase dashboard if needed.',
    ].join('\n'),
  });

  return { ...(await writeArchive(target, entries)), name, kind, takenAt: new Date().toISOString() };
}

/** Keeps the newest `keep` backups of each kind, deleting older ones. */
async function pruneBackups(dataDir, keep = 7) {
  const backupsDir = path.join(dataDir, 'backups');
  let files;
  try {
    files = await fs.readdir(backupsDir);
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  for (const kind of ['core', 'full']) {
    const matching = files
      .filter(f => f.startsWith(`nspa-${kind}-`) && f.endsWith('.zip'))
      .sort()
      .reverse();                       // timestamped names sort chronologically
    for (const stale of matching.slice(keep)) {
      await fs.unlink(path.join(backupsDir, stale)).catch(() => {});
      removed++;
    }
  }
  return { removed };
}

async function listBackups(dataDir) {
  const backupsDir = path.join(dataDir, 'backups');
  try {
    const files = await fs.readdir(backupsDir);
    const zips = files.filter(f => f.endsWith('.zip'));
    const stats = await Promise.all(zips.map(async f => {
      const s = await fs.stat(path.join(backupsDir, f));
      return { name: f, bytes: s.size, takenAt: s.mtime.toISOString() };
    }));
    return stats.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  } catch {
    return [];
  }
}

module.exports = { createBackup, createSupabaseBackup, pruneBackups, listBackups, CORE_ITEMS, UPLOAD_DIRS };
