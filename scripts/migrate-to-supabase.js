#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');
const supabase = require('../server/supabase');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

function text(cell) {
  let value = cell && cell.value;
  if (value && typeof value === 'object' && 'text' in value) value = value.text;
  return value == null ? '' : String(value);
}

function json(value, fallback) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function listText(value) {
  if (!Array.isArray(value)) return value ? String(value) : '';
  return value.map(item => {
    if (item && typeof item === 'object') return item.tenureNumber || item.label || item.value || '';
    return String(item || '');
  }).filter(Boolean).join(', ');
}

function documentsCellText(documents) {
  return (documents || [])
    .map(d => (d.title ? `${d.fileName} (${d.title})` : d.fileName))
    .join(', ');
}

async function readWorkbookRows(file, sheetName, mapper) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return [];
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const mapped = mapper(row);
    if (mapped) rows.push(mapped);
  });
  return rows;
}

async function migrateMembers() {
  const rows = await readWorkbookRows(path.join(DATA_DIR, 'users.xlsx'), 'Users', row => {
    const email = text(row.getCell(5));
    if (!email) return null;
    return {
      member_id: text(row.getCell(1)),
      created_at: text(row.getCell(2)) || new Date().toISOString(),
      first_name: text(row.getCell(3)),
      last_name: text(row.getCell(4)),
      email,
      email_lc: email.toLowerCase(),
      phone: text(row.getCell(6)),
      password_hash: text(row.getCell(7)),
      payment_customer_id: text(row.getCell(8)),
      subscription_id: text(row.getCell(9)),
      membership_status: text(row.getCell(10)) || 'none',
      member_since: text(row.getCell(11)) || null,
      account_status: text(row.getCell(12)) || 'active',
      membership_expiry: text(row.getCell(13)) || null,
      network_status: text(row.getCell(14)) || 'out',
      network_visibility: json(text(row.getCell(15)), { email: true, phone: false, projects: true, tenures: true, commodities: true }),
      profile: json(text(row.getCell(16)), {}),
    };
  });
  if (rows.length) await supabase.insert('members', rows, { upsert: true, onConflict: 'member_id' });
  return rows.length;
}

async function migrateProjects() {
  const rows = await readWorkbookRows(path.join(DATA_DIR, 'projects.xlsx'), 'Projects', row => {
    const id = text(row.getCell(1));
    if (!id) return null;
    return {
      id,
      created_at: text(row.getCell(2)) || new Date().toISOString(),
      member_id: text(row.getCell(3)),
      first_name: text(row.getCell(4)),
      last_name: text(row.getCell(5)),
      email: text(row.getCell(6)),
      phone: text(row.getCell(7)),
      title: text(row.getCell(8)),
      operator: text(row.getCell(9)),
      tenures_text: text(row.getCell(10)),
      commodities_text: text(row.getCell(11)),
      deposit_types_text: text(row.getCell(12)),
      project_stage: text(row.getCell(13)),
      resource_estimate: text(row.getCell(14)),
      resource_source: text(row.getCell(15)),
      website: text(row.getCell(16)),
      status: text(row.getCell(17)) || 'Pending',
      documents_text: text(row.getCell(18)),
      review_note: text(row.getCell(19)),
      reviewed_by: text(row.getCell(20)),
      reviewed_at: text(row.getCell(21)) || null,
      archived: text(row.getCell(22)).toLowerCase() === 'yes',
    };
  });
  if (rows.length) await supabase.insert('projects', rows, { upsert: true, onConflict: 'id' });
  return rows.length;
}

async function migrateSubmissions() {
  let submissions = [];
  try {
    submissions = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'submissions.json'), 'utf8'));
  } catch {
    submissions = [];
  }
  const rows = submissions.filter(s => s && s.id).map(submission => ({
    id: submission.id,
    payload: submission,
    created_at: submission.createdAt || new Date().toISOString(),
    updated_at: submission.updatedAt || new Date().toISOString(),
  }));
  if (rows.length) await supabase.insert('project_submissions', rows, { upsert: true, onConflict: 'id' });
  return rows.length;
}

async function uploadProjectFiles() {
  const submissionsPath = path.join(DATA_DIR, 'submissions.json');
  let submissions = [];
  try {
    submissions = JSON.parse(await fs.readFile(submissionsPath, 'utf8'));
  } catch {
    return 0;
  }

  let count = 0;
  for (const submission of submissions) {
    for (const doc of submission.documents || []) {
      if (!doc.storedName) continue;
      const filePath = path.join(DATA_DIR, 'uploads', submission.id, doc.storedName);
      await supabase.uploadFile(`projects/${submission.id}/${doc.storedName}`, filePath, doc.mimeType || 'application/octet-stream');
      count += 1;
    }
  }
  return count;
}

function openPortalDb() {
  const dbPath = path.join(DATA_DIR, 'portal.db');
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function readTable(db, table) {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    return [];
  }
}

async function migratePortalDb() {
  const db = openPortalDb();
  if (!db) return { rows: 0, files: 0 };

  let rows = 0;
  let files = 0;
  const copy = async (table, target = table, mapper = row => row, conflict = '') => {
    const data = readTable(db, table).map(mapper);
    if (data.length) {
      await supabase.insert(target, data, conflict ? { upsert: true, onConflict: conflict } : {});
      rows += data.length;
    }
  };

  await copy('settings', 'portal_settings', row => ({
    key: row.key,
    value: json(row.value, row.value),
  }), 'key');

  await copy('activity');
  await copy('notifications');
  await copy('favorites', 'favorites', row => row, 'member_id,project_id');
  await copy('events', 'events', row => ({
    ...row,
    registration_open: !!row.registration_open,
  }));
  await copy('event_registrations', 'event_registrations', row => row, 'event_id,member_id');
  await copy('event_files');
  await copy('resources');
  await copy('student_verifications', 'student_verifications', row => row, 'member_id');
  await copy('tenure_watch', 'tenure_watch', row => ({
    ...row,
    missing: !!row.missing,
  }), 'tenure_number');
  await copy('tenure_alerts');
  await copy('claim_neighbours', 'claim_neighbours', row => row, 'member_id,tenure_number,neighbour_tenure');
  await copy('claim_alerts', 'claim_alerts', row => ({
    ...row,
    criteria: json(row.criteria, {}),
    paused: !!row.paused,
  }));
  await copy('alert_areas', 'alert_areas', row => ({
    ...row,
    geojson: json(row.geojson, {}),
    bbox: json(row.bbox, []),
  }));
  await copy('alert_matches', 'alert_matches', row => ({
    ...row,
    detail: json(row.detail, {}),
  }));
  await copy('watchlist_items', 'watchlist_items', row => row, 'member_id,kind,value');

  for (const file of readTable(db, 'event_files')) {
    const filePath = path.join(DATA_DIR, 'event-files', file.stored_name);
    await supabase.uploadFile(`events/${file.stored_name}`, filePath, file.mime_type || 'application/octet-stream');
    files += 1;
  }

  for (const resource of readTable(db, 'resources')) {
    if (!resource.stored_name) continue;
    const filePath = path.join(DATA_DIR, 'resources', resource.stored_name);
    await supabase.uploadFile(`resources/${resource.stored_name}`, filePath, resource.mime_type || 'application/octet-stream');
    files += 1;
  }

  db.close();
  return { rows, files };
}

async function main() {
  if (!supabase.isConfigured()) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  }
  const members = await migrateMembers();
  const projects = await migrateProjects();
  const submissions = await migrateSubmissions();
  const projectFiles = await uploadProjectFiles();
  const portal = await migratePortalDb();
  console.log(
    `Migrated ${members} members, ${projects} projects, ${submissions} submissions, ` +
    `${portal.rows} portal rows, ${projectFiles + portal.files} files.`
  );
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
