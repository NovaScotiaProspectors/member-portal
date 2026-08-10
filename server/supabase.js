const fs = require('fs/promises');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'nspa-files';

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
}

function headers(extra = {}) {
  assertConfigured();
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function request(url, options = {}) {
  assertConfigured();
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase ${response.status}: ${body || response.statusText}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function restUrl(table, query = '') {
  return `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`;
}

function eq(column, value) {
  return `${encodeURIComponent(column)}=eq.${encodeURIComponent(String(value))}`;
}

async function select(table, query = '') {
  return request(restUrl(table, query), {
    headers: headers({ Accept: 'application/json' }),
  });
}

async function insert(table, rows, { upsert = false, onConflict = '' } = {}) {
  const query = upsert && onConflict ? `on_conflict=${encodeURIComponent(onConflict)}` : '';
  const prefer = upsert
    ? 'resolution=merge-duplicates,return=representation'
    : 'return=representation';
  return request(restUrl(table, query), {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: prefer,
    }),
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
}

async function update(table, query, patch) {
  return request(restUrl(table, query), {
    method: 'PATCH',
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(patch),
  });
}

async function remove(table, query) {
  return request(restUrl(table, query), {
    method: 'DELETE',
    headers: headers({ Prefer: 'return=minimal' }),
  });
}

function objectUrl(objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${objectPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

async function uploadFile(objectPath, filePath, contentType = 'application/octet-stream') {
  const data = await fs.readFile(filePath);
  return request(objectUrl(objectPath), {
    method: 'POST',
    headers: headers({
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    }),
    body: data,
  });
}

async function downloadObject(objectPath) {
  assertConfigured();
  const response = await fetch(objectUrl(objectPath), {
    headers: headers(),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase storage ${response.status}: ${body || response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function deleteObject(objectPath) {
  return request(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}`, {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [objectPath] }),
  });
}

module.exports = {
  isConfigured,
  eq,
  select,
  insert,
  update,
  remove,
  uploadFile,
  downloadObject,
  deleteObject,
  bucket: SUPABASE_STORAGE_BUCKET,
};
