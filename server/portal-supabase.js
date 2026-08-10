const supabase = require('./supabase');

const EVENT_CATEGORIES = ['conference', 'workshop', 'field_trip', 'meeting'];
const RESOURCE_CATEGORIES = [
  { value: 'geological_report', label: 'Geological Reports' },
  { value: 'exploration_guide', label: 'Exploration Guides' },
  { value: 'regulation', label: 'Regulations' },
  { value: 'template', label: 'Templates' },
  { value: 'technical', label: 'Technical Documents' },
];

const db = { close() {} };
const now = () => new Date().toISOString();
const esc = value => encodeURIComponent(String(value));
const like = value => encodeURIComponent(`*${String(value).replace(/\*/g, '')}*`);

function bool(value) {
  return value === true || value === 1 || value === '1';
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(String(value)) : fallback; } catch { return fallback; }
}

function camelEvent(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description || '',
    location: row.location || '',
    startsAt: row.starts_at,
    endsAt: row.ends_at || '',
    capacity: row.capacity,
    registrationOpen: bool(row.registration_open),
    createdAt: row.created_at,
    registered: Number(row.registered || 0),
  };
}

function camelEventFile(row) {
  return row && {
    id: row.id,
    eventId: row.event_id,
    fileName: row.file_name,
    storedName: row.stored_name,
    size: row.size,
    mimeType: row.mime_type,
    createdAt: row.created_at,
  };
}

function camelResource(row) {
  return row && {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description || '',
    file_name: row.file_name,
    fileName: row.file_name,
    stored_name: row.stored_name,
    storedName: row.stored_name,
    size: row.size,
    mime_type: row.mime_type,
    mimeType: row.mime_type,
    external_url: row.external_url,
    externalUrl: row.external_url,
    uploaded_by: row.uploaded_by,
    createdAt: row.created_at,
  };
}

async function count(table, query = '') {
  const rows = await supabase.select(table, `select=*${query ? `&${query}` : ''}`);
  return rows.length;
}

async function getSetting(key, fallback = null) {
  const rows = await supabase.select('portal_settings', `${supabase.eq('key', key)}&limit=1`);
  if (!rows[0]) return fallback;
  return parseJson(rows[0].value, fallback);
}

async function setSetting(key, value) {
  await supabase.insert('portal_settings', { key: String(key), value }, { upsert: true, onConflict: 'key' });
}

function studentFrom(row) {
  return row && {
    memberId: row.member_id,
    institution: row.institution || '',
    schoolEmail: row.school_email,
    emailDomain: row.email_domain,
    codeHash: row.code_hash,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at,
  };
}

async function getStudentVerification(memberId) {
  const rows = await supabase.select('student_verifications', `${supabase.eq('member_id', memberId)}&limit=1`);
  return studentFrom(rows[0]) || null;
}

async function saveStudentVerification(record) {
  await supabase.insert('student_verifications', {
    member_id: String(record.memberId),
    institution: record.institution || '',
    school_email: String(record.schoolEmail || '').toLowerCase(),
    email_domain: String(record.emailDomain || '').toLowerCase(),
    code_hash: record.codeHash || null,
    status: record.status || 'pending',
    requested_at: record.requestedAt || now(),
    expires_at: record.expiresAt || null,
    verified_at: record.verifiedAt || null,
  }, { upsert: true, onConflict: 'member_id' });
  return getStudentVerification(record.memberId);
}

async function confirmStudentVerification(memberId) {
  await supabase.update('student_verifications', supabase.eq('member_id', memberId), {
    status: 'verified',
    code_hash: null,
    expires_at: null,
    verified_at: now(),
  });
  return getStudentVerification(memberId);
}

async function saveTenureWatch(record) {
  await supabase.insert('tenure_watch', {
    tenure_number: String(record.tenureNumber),
    status: record.status || null,
    title_type: record.titleType || null,
    issue_date: record.issueDate || null,
    anniversary: record.anniversary || null,
    expiry: record.expiry || null,
    area_ha: record.areaHa == null ? null : Number(record.areaHa),
    holder: record.holder || null,
    checked_at: record.checkedAt || now(),
    missing: !!record.missing,
  }, { upsert: true, onConflict: 'tenure_number' });
}

async function getTenureWatch(tenureNumber) {
  const rows = await supabase.select('tenure_watch', `${supabase.eq('tenure_number', tenureNumber)}&limit=1`);
  const row = rows[0];
  return row ? {
    tenureNumber: row.tenure_number,
    status: row.status,
    titleType: row.title_type,
    issueDate: row.issue_date,
    anniversary: row.anniversary,
    expiry: row.expiry,
    areaHa: row.area_ha,
    holder: row.holder,
    checkedAt: row.checked_at,
    missing: !!row.missing,
  } : null;
}

async function recordTenureAlert(a) {
  try {
    await supabase.insert('tenure_alerts', {
      member_id: String(a.memberId),
      tenure_number: String(a.tenureNumber),
      kind: String(a.kind),
      milestone: String(a.milestone),
      due_date: a.dueDate || null,
      created_at: now(),
    }, { upsert: true, onConflict: 'member_id,tenure_number,kind,milestone,due_date' });
    return true;
  } catch (error) {
    if (String(error.message).includes('duplicate')) return false;
    throw error;
  }
}

async function listTenureAlerts(memberId, limit = 25) {
  const rows = await supabase.select('tenure_alerts', `${supabase.eq('member_id', memberId)}&order=created_at.desc&limit=${Number(limit)}`);
  return rows.map(r => ({
    tenureNumber: r.tenure_number,
    kind: r.kind,
    milestone: r.milestone,
    dueDate: r.due_date,
    createdAt: r.created_at,
  }));
}

function claimAlertFrom(row) {
  return row && {
    id: row.id,
    memberId: row.member_id,
    name: row.name,
    criteria: parseJson(row.criteria, {}),
    frequency: row.frequency,
    channel: row.channel,
    paused: !!row.paused,
    lastRunAt: row.last_run_at,
    matchCount: row.match_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listClaimAlerts(memberId) {
  const rows = await supabase.select('claim_alerts', `${supabase.eq('member_id', memberId)}&order=paused.asc,created_at.desc`);
  return rows.map(claimAlertFrom);
}

async function listActiveClaimAlerts() {
  const rows = await supabase.select('claim_alerts', 'paused=eq.false&order=created_at.asc');
  return rows.map(claimAlertFrom);
}

async function createClaimAlert(record) {
  const createdAt = now();
  const rows = await supabase.insert('claim_alerts', {
    member_id: String(record.memberId),
    name: record.name,
    criteria: record.criteria || {},
    frequency: record.frequency || 'daily',
    channel: record.channel || 'both',
    paused: !!record.paused,
    match_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
  });
  return claimAlertFrom(rows[0]);
}

async function updateClaimAlert(record) {
  const rows = await supabase.update('claim_alerts', `id=eq.${esc(record.id)}&member_id=eq.${esc(record.memberId)}`, {
    name: record.name,
    criteria: record.criteria || {},
    frequency: record.frequency || 'daily',
    channel: record.channel || 'both',
    paused: !!record.paused,
    updated_at: now(),
  });
  return claimAlertFrom(rows[0]) || null;
}

async function removeClaimAlert(memberId, id) {
  const before = await supabase.select('claim_alerts', `id=eq.${esc(id)}&member_id=eq.${esc(memberId)}&limit=1`);
  if (!before[0]) return false;
  await supabase.remove('claim_alerts', `id=eq.${esc(id)}&member_id=eq.${esc(memberId)}`);
  return true;
}

async function recordAlertMatch(match) {
  try {
    await supabase.insert('alert_matches', {
      alert_id: Number(match.alertId),
      member_id: String(match.memberId),
      tenure_number: String(match.tenureNumber),
      reason: match.reason,
      detail: match.detail || {},
      notified_at: match.notifiedAt || now(),
      created_at: now(),
    }, { upsert: true, onConflict: 'alert_id,tenure_number,reason' });
    const alertRows = await supabase.select('claim_alerts', `id=eq.${esc(match.alertId)}&select=match_count`);
    await supabase.update('claim_alerts', `id=eq.${esc(match.alertId)}`, {
      last_run_at: now(),
      match_count: Number((alertRows[0] || {}).match_count || 0) + 1,
    });
    return true;
  } catch (error) {
    if (String(error.message).includes('duplicate')) return false;
    throw error;
  }
}

async function listAlertMatches(memberId, limit = 25) {
  const rows = await supabase.select('alert_matches', `${supabase.eq('member_id', memberId)}&order=created_at.desc&limit=${Number(limit)}`);
  return rows.map(r => ({
    id: r.id,
    alertId: r.alert_id,
    memberId: r.member_id,
    tenureNumber: r.tenure_number,
    reason: r.reason,
    detail: parseJson(r.detail, {}),
    notifiedAt: r.notified_at,
    createdAt: r.created_at,
  }));
}

async function replaceNeighbours(memberId, tenureNumber, neighbours) {
  await supabase.remove('claim_neighbours', `member_id=eq.${esc(memberId)}&tenure_number=eq.${esc(tenureNumber)}`);
  if (!neighbours.length) return;
  const updatedAt = now();
  await supabase.insert('claim_neighbours', neighbours.map(n => ({
    member_id: String(memberId),
    tenure_number: String(tenureNumber),
    neighbour_tenure: String(n.tenureNumber),
    neighbour_member: n.neighbourMember || null,
    status: n.status || null,
    title_type: n.titleType || null,
    expiry: n.expiry || null,
    updated_at: updatedAt,
  })), { upsert: true, onConflict: 'member_id,tenure_number,neighbour_tenure' });
}

async function listNeighbours(memberId) {
  const rows = await supabase.select('claim_neighbours', `${supabase.eq('member_id', memberId)}&order=tenure_number.asc,neighbour_tenure.asc`);
  return rows.map(r => ({
    tenureNumber: r.tenure_number,
    neighbourTenure: r.neighbour_tenure,
    neighbourMember: r.neighbour_member,
    status: r.status,
    titleType: r.title_type,
    expiry: r.expiry,
    updatedAt: r.updated_at,
  }));
}

async function recordActivity(entry) {
  const rows = await supabase.insert('activity', {
    type: entry.type,
    actor_member_id: entry.actorMemberId || null,
    actor_name: entry.actorName || null,
    project_id: entry.projectId || null,
    project_title: entry.projectTitle || null,
    summary: entry.summary,
    created_at: entry.createdAt || now(),
  });
  return rows[0];
}

async function listActivity({ limit = 20, offset = 0 } = {}) {
  const rows = await supabase.select('activity', `type=neq.project_status_changed&order=created_at.desc,id.desc&limit=${Number(limit)}&offset=${Number(offset)}`);
  const total = await count('activity', 'type=neq.project_status_changed');
  return {
    items: rows.map(r => ({
      id: r.id,
      type: r.type,
      actorName: r.actor_name,
      projectId: r.project_id,
      projectTitle: r.project_title,
      summary: r.summary,
      createdAt: r.created_at,
    })),
    total,
  };
}

async function listProjectTimeline(projectId) {
  const rows = await supabase.select('activity', `${supabase.eq('project_id', projectId)}&order=created_at.asc,id.asc`);
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    actorName: r.actor_name,
    summary: r.summary,
    createdAt: r.created_at,
  }));
}

async function addNotification(n) {
  const row = {
    member_id: String(n.memberId),
    type: n.type,
    title: n.title,
    body: n.body || null,
    link: n.link || null,
    dedupe_key: n.dedupeKey || null,
    created_at: n.createdAt || now(),
  };
  try {
    return (await supabase.insert('notifications', row))[0];
  } catch (error) {
    if (row.dedupe_key && String(error.message).includes('duplicate')) return null;
    throw error;
  }
}

async function listNotifications(memberId, { limit = 30, offset = 0 } = {}) {
  const query = `${supabase.eq('member_id', memberId)}&order=created_at.desc,id.desc&limit=${Number(limit)}&offset=${Number(offset)}`;
  const rows = await supabase.select('notifications', query);
  return {
    items: rows.map(r => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.read_at,
      createdAt: r.created_at,
    })),
    total: await count('notifications', supabase.eq('member_id', memberId)),
    unread: await unreadCount(memberId),
  };
}

async function unreadCount(memberId) {
  return count('notifications', `${supabase.eq('member_id', memberId)}&read_at=is.null`);
}

async function markNotificationRead(memberId, id) {
  const rows = await supabase.update('notifications', `member_id=eq.${esc(memberId)}&id=eq.${esc(id)}&read_at=is.null`, { read_at: now() });
  return !!rows.length;
}

async function markAllNotificationsRead(memberId) {
  const rows = await supabase.update('notifications', `member_id=eq.${esc(memberId)}&read_at=is.null`, { read_at: now() });
  return rows.length;
}

async function removeNotification(memberId, id) {
  const existing = await supabase.select('notifications', `member_id=eq.${esc(memberId)}&id=eq.${esc(id)}&limit=1`);
  if (!existing[0]) return false;
  await supabase.remove('notifications', `member_id=eq.${esc(memberId)}&id=eq.${esc(id)}`);
  return true;
}

async function addFavorite(memberId, projectId) {
  try {
    await supabase.insert('favorites', {
      member_id: String(memberId),
      project_id: String(projectId),
      created_at: now(),
    }, { upsert: true, onConflict: 'member_id,project_id' });
    return true;
  } catch (error) {
    if (String(error.message).includes('duplicate')) return false;
    throw error;
  }
}

async function removeFavorite(memberId, projectId) {
  const existing = await supabase.select('favorites', `member_id=eq.${esc(memberId)}&project_id=eq.${esc(projectId)}&limit=1`);
  if (!existing[0]) return false;
  await supabase.remove('favorites', `member_id=eq.${esc(memberId)}&project_id=eq.${esc(projectId)}`);
  return true;
}

async function listFavorites(memberId) {
  const rows = await supabase.select('favorites', `${supabase.eq('member_id', memberId)}&order=created_at.desc`);
  return rows.map(r => ({ projectId: r.project_id, createdAt: r.created_at }));
}

async function clearProjectFavorites(projectId) {
  const rows = await supabase.select('favorites', `${supabase.eq('project_id', projectId)}`);
  await supabase.remove('favorites', supabase.eq('project_id', projectId));
  return rows.length;
}

async function purgeProjectRecords(projectId) {
  const id = String(projectId);
  const favourites = await clearProjectFavorites(id);
  const activityRows = await supabase.select('activity', `${supabase.eq('project_id', id)}`);
  await supabase.remove('activity', supabase.eq('project_id', id));
  return { favourites, activity: activityRows.length };
}

async function createEvent(e) {
  const rows = await supabase.insert('events', {
    title: e.title,
    category: e.category,
    description: e.description || null,
    location: e.location || null,
    starts_at: e.startsAt,
    ends_at: e.endsAt || null,
    capacity: e.capacity == null ? null : Number(e.capacity),
    registration_open: e.registrationOpen === false ? false : true,
    created_by: e.createdBy || null,
    created_at: now(),
  });
  const eventId = rows[0].id;
  if ((e.files || []).length) {
    await supabase.insert('event_files', e.files.map(file => ({
      event_id: eventId,
      file_name: file.fileName,
      stored_name: file.storedName,
      size: file.size == null ? null : Number(file.size),
      mime_type: file.mimeType || null,
      created_at: now(),
    })));
  }
  return eventId;
}

async function removeEvent(id) {
  const existing = await supabase.select('events', `id=eq.${esc(id)}&limit=1`);
  if (!existing[0]) return false;
  await supabase.remove('events', `id=eq.${esc(id)}`);
  return true;
}

async function listEventFiles(eventId) {
  const rows = await supabase.select('event_files', `event_id=eq.${esc(eventId)}&order=id.asc`);
  return rows.map(camelEventFile);
}

async function findEventFile(eventId, fileId) {
  const rows = await supabase.select('event_files', `id=eq.${esc(fileId)}&event_id=eq.${esc(eventId)}&limit=1`);
  return camelEventFile(rows[0]) || null;
}

async function listEvents(memberId) {
  const [events, regs, files] = await Promise.all([
    supabase.select('events', 'select=*&order=starts_at.asc'),
    memberId ? supabase.select('event_registrations', `${supabase.eq('member_id', memberId)}`) : Promise.resolve([]),
    supabase.select('event_files', 'select=*&order=id.asc'),
  ]);
  const mine = new Set(regs.map(r => r.event_id));
  const filesByEvent = new Map();
  for (const file of files.map(camelEventFile)) {
    if (!filesByEvent.has(file.eventId)) filesByEvent.set(file.eventId, []);
    filesByEvent.get(file.eventId).push(file);
  }
  const regRows = await supabase.select('event_registrations', 'select=event_id');
  const counts = new Map();
  for (const row of regRows) counts.set(row.event_id, (counts.get(row.event_id) || 0) + 1);
  const nowIso = now();
  return events.map(row => {
    const e = camelEvent(row);
    const registered = counts.get(e.id) || 0;
    return {
      ...e,
      files: filesByEvent.get(e.id) || [],
      registered,
      isRegistered: mine.has(e.id),
      isFull: e.capacity != null && registered >= e.capacity,
      isPast: (e.endsAt || e.startsAt) < nowIso,
    };
  });
}

async function registerForEvent(eventId, member) {
  const events = await supabase.select('events', `id=eq.${esc(eventId)}&limit=1`);
  const event = events[0];
  if (!event) return { ok: false, error: 'Event not found.' };
  if (!event.registration_open) return { ok: false, error: 'Registration is closed for this event.' };
  const existing = await supabase.select('event_registrations', `event_id=eq.${esc(eventId)}&member_id=eq.${esc(member.memberId)}&limit=1`);
  if (existing[0]) return { ok: true, alreadyRegistered: true };
  const registered = await count('event_registrations', `event_id=eq.${esc(eventId)}`);
  if (event.capacity != null && registered >= Number(event.capacity)) return { ok: false, error: 'This event is full.' };
  await supabase.insert('event_registrations', {
    event_id: Number(eventId),
    member_id: String(member.memberId),
    member_name: member.name || null,
    member_email: member.email || null,
    created_at: now(),
  }, { upsert: true, onConflict: 'event_id,member_id' });
  return { ok: true, event };
}

async function unregisterFromEvent(eventId, memberId) {
  const existing = await supabase.select('event_registrations', `event_id=eq.${esc(eventId)}&member_id=eq.${esc(memberId)}&limit=1`);
  if (!existing[0]) return false;
  await supabase.remove('event_registrations', `event_id=eq.${esc(eventId)}&member_id=eq.${esc(memberId)}`);
  return true;
}

async function listRegistrants(eventId) {
  const rows = await supabase.select('event_registrations', `event_id=eq.${esc(eventId)}&order=created_at.asc`);
  return rows.map(r => ({
    memberId: r.member_id,
    memberName: r.member_name,
    memberEmail: r.member_email,
    createdAt: r.created_at,
  }));
}

async function createResource(r) {
  const rows = await supabase.insert('resources', {
    title: r.title,
    category: r.category,
    description: r.description || null,
    file_name: r.fileName || null,
    stored_name: r.storedName || null,
    size: r.size == null ? null : Number(r.size),
    mime_type: r.mimeType || null,
    external_url: r.externalUrl || null,
    uploaded_by: r.uploadedBy || null,
    created_at: now(),
  });
  return rows[0].id;
}

async function findResource(id) {
  const rows = await supabase.select('resources', `id=eq.${esc(id)}&limit=1`);
  return camelResource(rows[0]) || null;
}

async function removeResource(id) {
  const existing = await findResource(id);
  if (!existing) return false;
  await supabase.remove('resources', `id=eq.${esc(id)}`);
  return true;
}

async function listResources({ category = '', query = '', limit = 20, offset = 0 } = {}) {
  const filters = [];
  if (category) filters.push(`category=eq.${esc(category)}`);
  if (query) filters.push(`or=(title.ilike.${like(query)},description.ilike.${like(query)})`);
  const base = filters.join('&');
  const rows = await supabase.select('resources', `${base ? `${base}&` : ''}order=created_at.desc,id.desc&limit=${Number(limit)}&offset=${Number(offset)}`);
  const total = await count('resources', base);
  const all = await supabase.select('resources', 'select=category');
  const counts = Object.values(all.reduce((acc, row) => {
    acc[row.category] = acc[row.category] || { category: row.category, n: 0 };
    acc[row.category].n += 1;
    return acc;
  }, {}));
  return {
    items: rows.map(row => {
      const r = camelResource(row);
      return {
        id: r.id,
        title: r.title,
        category: r.category,
        description: r.description,
        fileName: r.fileName,
        size: r.size,
        externalUrl: r.externalUrl,
        createdAt: r.createdAt,
      };
    }),
    total,
    counts,
  };
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
