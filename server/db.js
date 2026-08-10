if (require('./supabase').dataDriver() === 'supabase') {
  module.exports = require('./portal-supabase');
  return;
}

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Keep SQLite beside the rest of the writable application data.
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const DB_PATH = path.join(DATA_DIR, 'portal.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // concurrent reads while writing
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS activity (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    actor_member_id TEXT,
    actor_name      TEXT,
    project_id      TEXT,
    project_title   TEXT,
    summary         TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity (created_at DESC);

  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id   TEXT NOT NULL,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    link        TEXT,
    dedupe_key  TEXT,
    read_at     TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications (member_id, created_at DESC);
  -- One notification per member per dedupe key, so repeated membership-expiry
  -- sweeps don't pile up duplicates.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications (member_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS favorites (
    member_id  TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (member_id, project_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT NOT NULL,
    category          TEXT NOT NULL,
    description       TEXT,
    location          TEXT,
    starts_at         TEXT NOT NULL,
    ends_at           TEXT,
    capacity          INTEGER,
    registration_open INTEGER NOT NULL DEFAULT 1,
    created_by        TEXT,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_start ON events (starts_at);

  CREATE TABLE IF NOT EXISTS event_registrations (
    event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    member_id    TEXT NOT NULL,
    member_name  TEXT,
    member_email TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (event_id, member_id)
  );

  CREATE TABLE IF NOT EXISTS event_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    file_name   TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size        INTEGER,
    mime_type   TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_event_files_event ON event_files (event_id);

  CREATE TABLE IF NOT EXISTS resources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    category     TEXT NOT NULL,
    description  TEXT,
    file_name    TEXT,
    stored_name  TEXT,
    size         INTEGER,
    mime_type    TEXT,
    external_url TEXT,
    uploaded_by  TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_resources_category ON resources (category, created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS student_verifications (
    member_id         TEXT PRIMARY KEY,
    institution       TEXT,
    school_email      TEXT NOT NULL,
    email_domain      TEXT NOT NULL,
    code_hash         TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    requested_at      TEXT NOT NULL,
    expires_at        TEXT,
    verified_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_student_verifications_status ON student_verifications (status, requested_at DESC);

  /* Latest NovaROC attributes for every tenure a member has registered.
     Refreshed on a schedule so expiry dates never go stale — the copy captured
     at submission time drifts as claims are renewed or lapse. */
  CREATE TABLE IF NOT EXISTS tenure_watch (
    tenure_number TEXT PRIMARY KEY,
    status        TEXT,
    title_type    TEXT,
    issue_date    TEXT,
    anniversary   TEXT,
    expiry        TEXT,
    area_ha       REAL,
    holder        TEXT,
    checked_at    TEXT NOT NULL,
    missing       INTEGER NOT NULL DEFAULT 0
  );

  /* One row per alert actually sent, so a reminder fires once per threshold
     rather than every time the sweep runs. */
  CREATE TABLE IF NOT EXISTS tenure_alerts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id     TEXT NOT NULL,
    tenure_number TEXT NOT NULL,
    kind          TEXT NOT NULL,   -- expiry | anniversary | status | open_ground
    milestone     TEXT NOT NULL,   -- threshold in days, or a status value
    due_date      TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (member_id, tenure_number, kind, milestone, due_date)
  );
  CREATE INDEX IF NOT EXISTS idx_tenure_alerts_member ON tenure_alerts (member_id, created_at DESC);

  /* Who holds the ground next to each member claim. Rebuilt on every sweep,
     so it always reflects the current NovaROC picture. */
  CREATE TABLE IF NOT EXISTS claim_neighbours (
    member_id         TEXT NOT NULL,
    tenure_number     TEXT NOT NULL,   -- the member's own claim
    neighbour_tenure  TEXT NOT NULL,
    neighbour_member  TEXT,            -- set when another NSPA member holds it
    status            TEXT,
    title_type        TEXT,
    expiry            TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (member_id, tenure_number, neighbour_tenure)
  );
  CREATE INDEX IF NOT EXISTS idx_claim_neighbours_member ON claim_neighbours (member_id);

  /* ── Smart claim alerts ────────────────────────────────────────────────
     A saved set of criteria a member wants the registry watched against.
     Criteria are stored as JSON because the shape varies by alert type;
     everything is re-validated server-side before it is saved. */
  CREATE TABLE IF NOT EXISTS claim_alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id    TEXT NOT NULL,
    name         TEXT NOT NULL,
    criteria     TEXT NOT NULL,          -- JSON
    frequency    TEXT NOT NULL DEFAULT 'instant',  -- instant | daily | weekly
    channel      TEXT NOT NULL DEFAULT 'both',     -- email | inapp | both
    paused       INTEGER NOT NULL DEFAULT 0,
    last_run_at  TEXT,
    match_count  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_claim_alerts_member ON claim_alerts (member_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_claim_alerts_active ON claim_alerts (paused);

  /* Named exploration areas, drawn on the map and reusable across alerts. */
  CREATE TABLE IF NOT EXISTS alert_areas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    geojson    TEXT NOT NULL,
    bbox       TEXT NOT NULL,            -- JSON [minX,minY,maxX,maxY] for fast rejection
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alert_areas_member ON alert_areas (member_id);

  /* Every match found, which doubles as the notification history and the
     de-duplication ledger. */
  CREATE TABLE IF NOT EXISTS alert_matches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id      INTEGER NOT NULL REFERENCES claim_alerts(id) ON DELETE CASCADE,
    member_id     TEXT NOT NULL,
    tenure_number TEXT NOT NULL,
    reason        TEXT NOT NULL,         -- new | released | expiring | status | adjacent
    detail        TEXT,                  -- JSON snapshot of the claim at match time
    notified_at   TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (alert_id, tenure_number, reason)
  );
  CREATE INDEX IF NOT EXISTS idx_alert_matches_member ON alert_matches (member_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_matches_pending ON alert_matches (notified_at);

  /* Watchlists: individual claims, companies, commodities, counties. */
  CREATE TABLE IF NOT EXISTS watchlist_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,            -- claim | company | commodity | county
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (member_id, kind, value)
  );
  CREATE INDEX IF NOT EXISTS idx_watchlist_member ON watchlist_items (member_id);
`);

const now = () => new Date().toISOString();

/* ── Site settings (small key/value pairs, e.g. the events archive) ─────── */

const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getSetting(key, fallback = null) {
  const row = selectSetting.get(String(key));
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function setSetting(key, value) {
  upsertSetting.run(String(key), JSON.stringify(value));
}

/* ── Student membership email verification ─────────────────────────────── */

const selectStudentVerification = db.prepare(`
  SELECT member_id AS memberId, institution, school_email AS schoolEmail,
         email_domain AS emailDomain, code_hash AS codeHash, status,
         requested_at AS requestedAt, expires_at AS expiresAt, verified_at AS verifiedAt
  FROM student_verifications WHERE member_id = ?
`);

const upsertStudentVerification = db.prepare(`
  INSERT INTO student_verifications
    (member_id, institution, school_email, email_domain, code_hash, status, requested_at, expires_at, verified_at)
  VALUES
    (@memberId, @institution, @schoolEmail, @emailDomain, @codeHash, @status, @requestedAt, @expiresAt, @verifiedAt)
  ON CONFLICT(member_id) DO UPDATE SET
    institution = excluded.institution,
    school_email = excluded.school_email,
    email_domain = excluded.email_domain,
    code_hash = excluded.code_hash,
    status = excluded.status,
    requested_at = excluded.requested_at,
    expires_at = excluded.expires_at,
    verified_at = excluded.verified_at
`);

const markStudentVerified = db.prepare(`
  UPDATE student_verifications
  SET status = 'verified', code_hash = NULL, expires_at = NULL, verified_at = ?
  WHERE member_id = ?
`);

function getStudentVerification(memberId) {
  return selectStudentVerification.get(String(memberId)) || null;
}

function saveStudentVerification(record) {
  upsertStudentVerification.run({
    memberId: String(record.memberId),
    institution: record.institution || '',
    schoolEmail: String(record.schoolEmail || '').toLowerCase(),
    emailDomain: String(record.emailDomain || '').toLowerCase(),
    codeHash: record.codeHash || null,
    status: record.status || 'pending',
    requestedAt: record.requestedAt || now(),
    expiresAt: record.expiresAt || null,
    verifiedAt: record.verifiedAt || null,
  });
  return getStudentVerification(record.memberId);
}

function confirmStudentVerification(memberId) {
  markStudentVerified.run(now(), String(memberId));
  return getStudentVerification(memberId);
}

/* ── Claim watch: cached tenure state + alert de-duplication ────────────── */

const upsertTenureWatch = db.prepare(`
  INSERT INTO tenure_watch
    (tenure_number, status, title_type, issue_date, anniversary, expiry, area_ha, holder, checked_at, missing)
  VALUES
    (@tenureNumber, @status, @titleType, @issueDate, @anniversary, @expiry, @areaHa, @holder, @checkedAt, @missing)
  ON CONFLICT(tenure_number) DO UPDATE SET
    status = excluded.status, title_type = excluded.title_type,
    issue_date = excluded.issue_date, anniversary = excluded.anniversary,
    expiry = excluded.expiry, area_ha = excluded.area_ha, holder = excluded.holder,
    checked_at = excluded.checked_at, missing = excluded.missing
`);

const selectTenureWatch = db.prepare(`
  SELECT tenure_number AS tenureNumber, status, title_type AS titleType,
         issue_date AS issueDate, anniversary, expiry, area_ha AS areaHa,
         holder, checked_at AS checkedAt, missing
  FROM tenure_watch WHERE tenure_number = ?
`);

function saveTenureWatch(record) {
  upsertTenureWatch.run({
    tenureNumber: String(record.tenureNumber),
    status: record.status || null,
    titleType: record.titleType || null,
    issueDate: record.issueDate || null,
    anniversary: record.anniversary || null,
    expiry: record.expiry || null,
    areaHa: record.areaHa == null ? null : Number(record.areaHa),
    holder: record.holder || null,
    checkedAt: record.checkedAt || now(),
    missing: record.missing ? 1 : 0,
  });
}

function getTenureWatch(tenureNumber) {
  const row = selectTenureWatch.get(String(tenureNumber));
  return row ? { ...row, missing: !!row.missing } : null;
}

const insertTenureAlert = db.prepare(`
  INSERT OR IGNORE INTO tenure_alerts
    (member_id, tenure_number, kind, milestone, due_date, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/** Records an alert; returns false when this exact one has already been sent. */
function recordTenureAlert({ memberId, tenureNumber, kind, milestone, dueDate }) {
  const info = insertTenureAlert.run(
    String(memberId), String(tenureNumber), String(kind),
    String(milestone), dueDate || null, now()
  );
  return info.changes > 0;
}

const selectRecentTenureAlerts = db.prepare(`
  SELECT tenure_number AS tenureNumber, kind, milestone, due_date AS dueDate, created_at AS createdAt
  FROM tenure_alerts WHERE member_id = ? ORDER BY created_at DESC LIMIT ?
`);

function listTenureAlerts(memberId, limit = 25) {
  return selectRecentTenureAlerts.all(String(memberId), limit);
}

/* ── Saved claim opportunity alerts ────────────────────────────────────── */

const selectClaimAlert = db.prepare(`
  SELECT id, member_id AS memberId, name, criteria, frequency, channel, paused,
         last_run_at AS lastRunAt, match_count AS matchCount, created_at AS createdAt,
         updated_at AS updatedAt
  FROM claim_alerts WHERE id = ? AND member_id = ?
`);

const selectClaimAlertsForMember = db.prepare(`
  SELECT id, member_id AS memberId, name, criteria, frequency, channel, paused,
         last_run_at AS lastRunAt, match_count AS matchCount, created_at AS createdAt,
         updated_at AS updatedAt
  FROM claim_alerts WHERE member_id = ? ORDER BY paused ASC, created_at DESC
`);

const selectActiveClaimAlerts = db.prepare(`
  SELECT id, member_id AS memberId, name, criteria, frequency, channel, paused,
         last_run_at AS lastRunAt, match_count AS matchCount, created_at AS createdAt,
         updated_at AS updatedAt
  FROM claim_alerts WHERE paused = 0 ORDER BY created_at ASC
`);

const insertClaimAlert = db.prepare(`
  INSERT INTO claim_alerts
    (member_id, name, criteria, frequency, channel, paused, last_run_at, match_count, created_at, updated_at)
  VALUES
    (@memberId, @name, @criteria, @frequency, @channel, @paused, NULL, 0, @createdAt, @updatedAt)
`);

const updateClaimAlertStmt = db.prepare(`
  UPDATE claim_alerts SET
    name = @name,
    criteria = @criteria,
    frequency = @frequency,
    channel = @channel,
    paused = @paused,
    updated_at = @updatedAt
  WHERE id = @id AND member_id = @memberId
`);

const touchClaimAlertRun = db.prepare(`
  UPDATE claim_alerts
  SET last_run_at = ?, match_count = match_count + ?
  WHERE id = ?
`);

const deleteClaimAlertStmt = db.prepare('DELETE FROM claim_alerts WHERE id = ? AND member_id = ?');

function parseClaimAlert(row) {
  if (!row) return null;
  let criteria = {};
  try { criteria = row.criteria ? JSON.parse(row.criteria) : {}; } catch {}
  return { ...row, paused: !!row.paused, criteria };
}

function listClaimAlerts(memberId) {
  return selectClaimAlertsForMember.all(String(memberId)).map(parseClaimAlert);
}

function listActiveClaimAlerts() {
  return selectActiveClaimAlerts.all().map(parseClaimAlert);
}

function createClaimAlert(record) {
  const createdAt = now();
  const info = insertClaimAlert.run({
    memberId: String(record.memberId),
    name: record.name,
    criteria: JSON.stringify(record.criteria || {}),
    frequency: record.frequency || 'daily',
    channel: record.channel || 'both',
    paused: record.paused ? 1 : 0,
    createdAt,
    updatedAt: createdAt,
  });
  return parseClaimAlert(selectClaimAlert.get(info.lastInsertRowid, String(record.memberId)));
}

function updateClaimAlert(record) {
  const info = updateClaimAlertStmt.run({
    id: Number(record.id),
    memberId: String(record.memberId),
    name: record.name,
    criteria: JSON.stringify(record.criteria || {}),
    frequency: record.frequency || 'daily',
    channel: record.channel || 'both',
    paused: record.paused ? 1 : 0,
    updatedAt: now(),
  });
  return info.changes ? parseClaimAlert(selectClaimAlert.get(Number(record.id), String(record.memberId))) : null;
}

function removeClaimAlert(memberId, id) {
  return deleteClaimAlertStmt.run(Number(id), String(memberId)).changes > 0;
}

const insertAlertMatch = db.prepare(`
  INSERT OR IGNORE INTO alert_matches
    (alert_id, member_id, tenure_number, reason, detail, notified_at, created_at)
  VALUES
    (@alertId, @memberId, @tenureNumber, @reason, @detail, @notifiedAt, @createdAt)
`);

const selectAlertMatches = db.prepare(`
  SELECT id, alert_id AS alertId, member_id AS memberId, tenure_number AS tenureNumber,
         reason, detail, notified_at AS notifiedAt, created_at AS createdAt
  FROM alert_matches WHERE member_id = ?
  ORDER BY created_at DESC LIMIT ?
`);

function recordAlertMatch(match) {
  const createdAt = now();
  const info = insertAlertMatch.run({
    alertId: Number(match.alertId),
    memberId: String(match.memberId),
    tenureNumber: String(match.tenureNumber),
    reason: match.reason,
    detail: JSON.stringify(match.detail || {}),
    notifiedAt: match.notifiedAt || createdAt,
    createdAt,
  });
  if (info.changes) touchClaimAlertRun.run(createdAt, 1, Number(match.alertId));
  return info.changes > 0;
}

function listAlertMatches(memberId, limit = 25) {
  return selectAlertMatches.all(String(memberId), limit).map(row => {
    let detail = {};
    try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch {}
    return { ...row, detail };
  });
}

/* ── Adjacency: who holds the ground next door ───────────────────────────── */

const deleteNeighbours = db.prepare(
  'DELETE FROM claim_neighbours WHERE member_id = ? AND tenure_number = ?'
);
const insertNeighbour = db.prepare(`
  INSERT OR REPLACE INTO claim_neighbours
    (member_id, tenure_number, neighbour_tenure, neighbour_member, status, title_type, expiry, updated_at)
  VALUES (@memberId, @tenureNumber, @neighbourTenure, @neighbourMember, @status, @titleType, @expiry, @updatedAt)
`);

/** Replaces the neighbour set for one claim, so stale entries can't linger. */
const replaceNeighbours = db.transaction((memberId, tenureNumber, neighbours) => {
  deleteNeighbours.run(String(memberId), String(tenureNumber));
  const updatedAt = now();
  for (const n of neighbours) {
    insertNeighbour.run({
      memberId: String(memberId),
      tenureNumber: String(tenureNumber),
      neighbourTenure: String(n.tenureNumber),
      neighbourMember: n.neighbourMember || null,
      status: n.status || null,
      titleType: n.titleType || null,
      expiry: n.expiry || null,
      updatedAt,
    });
  }
});

const selectNeighbours = db.prepare(`
  SELECT tenure_number AS tenureNumber, neighbour_tenure AS neighbourTenure,
         neighbour_member AS neighbourMember, status, title_type AS titleType,
         expiry, updated_at AS updatedAt
  FROM claim_neighbours WHERE member_id = ?
  ORDER BY tenure_number, neighbour_tenure
`);

function listNeighbours(memberId) {
  return selectNeighbours.all(String(memberId));
}

/* ── Activity feed ──────────────────────────────────────────────────────── */

const insertActivity = db.prepare(`
  INSERT INTO activity (type, actor_member_id, actor_name, project_id, project_title, summary, created_at)
  VALUES (@type, @actorMemberId, @actorName, @projectId, @projectTitle, @summary, @createdAt)
`);

function recordActivity(entry) {
  return insertActivity.run({
    type: entry.type,
    actorMemberId: entry.actorMemberId || null,
    actorName: entry.actorName || null,
    projectId: entry.projectId || null,
    projectTitle: entry.projectTitle || null,
    summary: entry.summary,
    createdAt: entry.createdAt || now(),
  });
}

// Routine per-project status changes belong on the project timeline, not in
// the association-wide feed, so they're excluded here.
const FEED_EXCLUDED_TYPES = "('project_status_changed')";

const selectActivity = db.prepare(`
  SELECT id, type, actor_name AS actorName, project_id AS projectId,
         project_title AS projectTitle, summary, created_at AS createdAt
  FROM activity WHERE type NOT IN ${FEED_EXCLUDED_TYPES}
  ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
`);
const countActivity = db.prepare(
  `SELECT COUNT(*) AS n FROM activity WHERE type NOT IN ${FEED_EXCLUDED_TYPES}`
);

function listActivity({ limit = 20, offset = 0 } = {}) {
  return { items: selectActivity.all(limit, offset), total: countActivity.get().n };
}

// A project's own history, oldest first — submission, document uploads,
// status changes and approvals. Drives the timeline on the project page.
const selectProjectTimeline = db.prepare(`
  SELECT id, type, actor_name AS actorName, summary, created_at AS createdAt
  FROM activity WHERE project_id = ? ORDER BY created_at ASC, id ASC
`);

function listProjectTimeline(projectId) {
  return selectProjectTimeline.all(String(projectId));
}

/* ── Notifications ──────────────────────────────────────────────────────── */

// dedupe_key collisions are ignored so repeat sweeps are idempotent.
const insertNotification = db.prepare(`
  INSERT OR IGNORE INTO notifications (member_id, type, title, body, link, dedupe_key, created_at)
  VALUES (@memberId, @type, @title, @body, @link, @dedupeKey, @createdAt)
`);

function addNotification(n) {
  return insertNotification.run({
    memberId: String(n.memberId),
    type: n.type,
    title: n.title,
    body: n.body || null,
    link: n.link || null,
    dedupeKey: n.dedupeKey || null,
    createdAt: n.createdAt || now(),
  });
}

const selectNotifications = db.prepare(`
  SELECT id, type, title, body, link, read_at AS readAt, created_at AS createdAt
  FROM notifications WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
`);
const countUnread = db.prepare(
  'SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read_at IS NULL'
);
const countNotifications = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ?');

function listNotifications(memberId, { limit = 30, offset = 0 } = {}) {
  return {
    items: selectNotifications.all(String(memberId), limit, offset),
    total: countNotifications.get(String(memberId)).n,
    unread: countUnread.get(String(memberId)).n,
  };
}

function unreadCount(memberId) {
  return countUnread.get(String(memberId)).n;
}

const markRead = db.prepare(
  'UPDATE notifications SET read_at = ? WHERE member_id = ? AND id = ? AND read_at IS NULL'
);
const markAllRead = db.prepare(
  'UPDATE notifications SET read_at = ? WHERE member_id = ? AND read_at IS NULL'
);
const deleteNotification = db.prepare('DELETE FROM notifications WHERE member_id = ? AND id = ?');

function markNotificationRead(memberId, id) {
  return markRead.run(now(), String(memberId), Number(id)).changes > 0;
}
function markAllNotificationsRead(memberId) {
  return markAllRead.run(now(), String(memberId)).changes;
}
function removeNotification(memberId, id) {
  return deleteNotification.run(String(memberId), Number(id)).changes > 0;
}

/* ── Favourites ─────────────────────────────────────────────────────────── */

const insertFavorite = db.prepare(
  'INSERT OR IGNORE INTO favorites (member_id, project_id, created_at) VALUES (?, ?, ?)'
);
const deleteFavorite = db.prepare('DELETE FROM favorites WHERE member_id = ? AND project_id = ?');
const selectFavorites = db.prepare(
  'SELECT project_id AS projectId, created_at AS createdAt FROM favorites WHERE member_id = ? ORDER BY created_at DESC'
);
const removeFavoritesForProject = db.prepare('DELETE FROM favorites WHERE project_id = ?');

function addFavorite(memberId, projectId) {
  return insertFavorite.run(String(memberId), String(projectId), now()).changes > 0;
}
function removeFavorite(memberId, projectId) {
  return deleteFavorite.run(String(memberId), String(projectId)).changes > 0;
}
function listFavorites(memberId) {
  return selectFavorites.all(String(memberId));
}
/* Everything in portal.db that points at a project, removed together when an
   admin purges it. Kept in one transaction so a purge can't half-happen. */
const deleteProjectActivity = db.prepare('DELETE FROM activity WHERE project_id = ?');

const purgeProjectRecords = db.transaction(projectId => {
  const id = String(projectId);
  const favourites = removeFavoritesForProject.run(id).changes;
  const activity = deleteProjectActivity.run(id).changes;
  return { favourites, activity };
});

function clearProjectFavorites(projectId) {
  return removeFavoritesForProject.run(String(projectId)).changes;
}

/* ── Events ─────────────────────────────────────────────────────────────── */

const EVENT_CATEGORIES = ['conference', 'workshop', 'field_trip', 'meeting'];

const insertEvent = db.prepare(`
  INSERT INTO events (title, category, description, location, starts_at, ends_at, capacity, registration_open, created_by, created_at)
  VALUES (@title, @category, @description, @location, @startsAt, @endsAt, @capacity, @registrationOpen, @createdBy, @createdAt)
`);

function createEvent(e) {
  const eventId = db.transaction(() => {
    const info = insertEvent.run({
      title: e.title,
      category: e.category,
      description: e.description || null,
      location: e.location || null,
      startsAt: e.startsAt,
      endsAt: e.endsAt || null,
      capacity: e.capacity == null ? null : Number(e.capacity),
      registrationOpen: e.registrationOpen === false ? 0 : 1,
      createdBy: e.createdBy || null,
      createdAt: now(),
    });
    const id = Number(info.lastInsertRowid);
    for (const file of e.files || []) {
      insertEventFile.run({
        eventId: id,
        fileName: file.fileName,
        storedName: file.storedName,
        size: file.size == null ? null : Number(file.size),
        mimeType: file.mimeType || null,
        createdAt: now(),
      });
    }
    return id;
  });
  return eventId();
}

const deleteEvent = db.prepare('DELETE FROM events WHERE id = ?');
function removeEvent(id) {
  return deleteEvent.run(Number(id)).changes > 0;
}

// Registration counts come from a join so capacity is always accurate.
const selectEvents = db.prepare(`
  SELECT e.id, e.title, e.category, e.description, e.location,
         e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity,
         e.registration_open AS registrationOpen, e.created_at AS createdAt,
         (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id) AS registered
  FROM events e ORDER BY e.starts_at ASC
`);

const insertEventFile = db.prepare(`
  INSERT INTO event_files (event_id, file_name, stored_name, size, mime_type, created_at)
  VALUES (@eventId, @fileName, @storedName, @size, @mimeType, @createdAt)
`);

const selectEventFiles = db.prepare(`
  SELECT id, event_id AS eventId, file_name AS fileName, stored_name AS storedName,
         size, mime_type AS mimeType, created_at AS createdAt
  FROM event_files WHERE event_id = ? ORDER BY id ASC
`);

const selectEventFile = db.prepare(`
  SELECT id, event_id AS eventId, file_name AS fileName, stored_name AS storedName,
         size, mime_type AS mimeType, created_at AS createdAt
  FROM event_files WHERE id = ? AND event_id = ?
`);

const selectMyRegistrations = db.prepare(
  'SELECT event_id AS eventId FROM event_registrations WHERE member_id = ?'
);

function listEvents(memberId) {
  const events = selectEvents.all();
  const mine = new Set(
    memberId ? selectMyRegistrations.all(String(memberId)).map(r => r.eventId) : []
  );
  const nowIso = now();
  return events.map(e => ({
    ...e,
    files: selectEventFiles.all(e.id),
    registrationOpen: !!e.registrationOpen,
    isRegistered: mine.has(e.id),
    isFull: e.capacity != null && e.registered >= e.capacity,
    // Past once it has finished (or started, when no end time was given).
    isPast: (e.endsAt || e.startsAt) < nowIso,
  }));
}

function listEventFiles(eventId) {
  return selectEventFiles.all(Number(eventId));
}

function findEventFile(eventId, fileId) {
  return selectEventFile.get(Number(fileId), Number(eventId));
}

const getEvent = db.prepare('SELECT * FROM events WHERE id = ?');
const countRegistrations = db.prepare(
  'SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ?'
);
const insertRegistration = db.prepare(`
  INSERT OR IGNORE INTO event_registrations (event_id, member_id, member_name, member_email, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const deleteRegistration = db.prepare(
  'DELETE FROM event_registrations WHERE event_id = ? AND member_id = ?'
);
const selectRegistrants = db.prepare(`
  SELECT member_id AS memberId, member_name AS memberName, member_email AS memberEmail,
         created_at AS createdAt
  FROM event_registrations WHERE event_id = ? ORDER BY created_at ASC
`);

// Capacity is checked inside a transaction so two simultaneous registrations
// can't both take the last seat.
const registerForEvent = db.transaction((eventId, member) => {
  const event = getEvent.get(Number(eventId));
  if (!event) return { ok: false, error: 'Event not found.' };
  if (!event.registration_open) return { ok: false, error: 'Registration is closed for this event.' };

  const already = db
    .prepare('SELECT 1 FROM event_registrations WHERE event_id = ? AND member_id = ?')
    .get(Number(eventId), String(member.memberId));
  if (already) return { ok: true, alreadyRegistered: true };

  if (event.capacity != null && countRegistrations.get(Number(eventId)).n >= event.capacity) {
    return { ok: false, error: 'This event is full.' };
  }

  insertRegistration.run(
    Number(eventId),
    String(member.memberId),
    member.name || null,
    member.email || null,
    now()
  );
  return { ok: true, event };
});

function unregisterFromEvent(eventId, memberId) {
  return deleteRegistration.run(Number(eventId), String(memberId)).changes > 0;
}
function listRegistrants(eventId) {
  return selectRegistrants.all(Number(eventId));
}

/* ── Resource library ───────────────────────────────────────────────────── */

const RESOURCE_CATEGORIES = [
  { value: 'geological_report', label: 'Geological Reports' },
  { value: 'exploration_guide', label: 'Exploration Guides' },
  { value: 'regulation', label: 'Regulations' },
  { value: 'template', label: 'Templates' },
  { value: 'technical', label: 'Technical Documents' },
];

const insertResource = db.prepare(`
  INSERT INTO resources (title, category, description, file_name, stored_name, size, mime_type, external_url, uploaded_by, created_at)
  VALUES (@title, @category, @description, @fileName, @storedName, @size, @mimeType, @externalUrl, @uploadedBy, @createdAt)
`);

function createResource(r) {
  const info = insertResource.run({
    title: r.title,
    category: r.category,
    description: r.description || null,
    fileName: r.fileName || null,
    storedName: r.storedName || null,
    size: r.size == null ? null : Number(r.size),
    mimeType: r.mimeType || null,
    externalUrl: r.externalUrl || null,
    uploadedBy: r.uploadedBy || null,
    createdAt: now(),
  });
  return Number(info.lastInsertRowid);
}

const getResource = db.prepare('SELECT * FROM resources WHERE id = ?');
const deleteResource = db.prepare('DELETE FROM resources WHERE id = ?');

function findResource(id) {
  return getResource.get(Number(id)) || null;
}
function removeResource(id) {
  return deleteResource.run(Number(id)).changes > 0;
}

// Category + free-text search, paginated. Search covers title and description.
function listResources({ category = '', query = '', limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (category) {
    where.push('category = @category');
    params.category = category;
  }
  if (query) {
    where.push("(title LIKE @q OR IFNULL(description, '') LIKE @q)");
    params.q = `%${query}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = db
    .prepare(`
      SELECT id, title, category, description, file_name AS fileName, size,
             external_url AS externalUrl, created_at AS createdAt
      FROM resources ${clause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset
    `)
    .all({ ...params, limit, offset });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM resources ${clause}`).get(params).n;
  const counts = db
    .prepare('SELECT category, COUNT(*) AS n FROM resources GROUP BY category')
    .all();

  return { items, total, counts };
}

module.exports = {
  db,
  EVENT_CATEGORIES,
  RESOURCE_CATEGORIES,
  getSetting,
  setSetting,
  getStudentVerification,
  saveStudentVerification,
  confirmStudentVerification,
  saveTenureWatch,
  getTenureWatch,
  recordTenureAlert,
  listTenureAlerts,
  listClaimAlerts,
  listActiveClaimAlerts,
  createClaimAlert,
  updateClaimAlert,
  removeClaimAlert,
  recordAlertMatch,
  listAlertMatches,
  replaceNeighbours,
  listNeighbours,
  recordActivity,
  listActivity,
  listProjectTimeline,
  addNotification,
  listNotifications,
  unreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  removeNotification,
  addFavorite,
  removeFavorite,
  listFavorites,
  clearProjectFavorites,
  purgeProjectRecords,
  createEvent,
  removeEvent,
  listEvents,
  listEventFiles,
  findEventFile,
  registerForEvent,
  unregisterFromEvent,
  listRegistrants,
  createResource,
  findResource,
  removeResource,
  listResources,
};
