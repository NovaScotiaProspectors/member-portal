/* Project editing rules — ownership, administrator permissions, and the
 * Data Room URL validator. These are the server-side rules; the interface
 * hiding a control is not what stops a member using it, this is.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMBER_EDITABLE_FIELDS,
  ADMIN_ONLY_FIELDS,
  parseDataRoomUrl,
  planProjectEdit,
} = require('../server/projectEdits');

/* ── Data Room URL validation ───────────────────────────────────────────── */

test('accepts a Google Drive folder link', () => {
  const url = 'https://drive.google.com/drive/folders/1A2b3C4d5E6f7G8h9I0j';
  assert.deepEqual(parseDataRoomUrl(url), { ok: true, value: url });
});

test('accepts docs.google.com and a www. prefix', () => {
  assert.equal(parseDataRoomUrl('https://docs.google.com/document/d/abc/edit').ok, true);
  assert.equal(parseDataRoomUrl('https://www.drive.google.com/drive/folders/abc').ok, true);
});

test('an empty value is valid and means "no data room"', () => {
  // This is how a member removes a link they previously set.
  assert.deepEqual(parseDataRoomUrl(''), { ok: true, value: '' });
  assert.deepEqual(parseDataRoomUrl('   '), { ok: true, value: '' });
  assert.deepEqual(parseDataRoomUrl(null), { ok: true, value: '' });
  assert.deepEqual(parseDataRoomUrl(undefined), { ok: true, value: '' });
});

test('rejects http and other schemes', () => {
  for (const url of [
    'http://drive.google.com/drive/folders/abc',
    'ftp://drive.google.com/abc',
    'javascript:alert(1)//drive.google.com',
  ]) {
    const result = parseDataRoomUrl(url);
    assert.equal(result.ok, false, `${url} must be rejected`);
    assert.match(result.error, /https|full URL/);
  }
});

test('rejects non-Drive hosts, including lookalikes', () => {
  for (const url of [
    'https://example.com/folder',
    'https://drive.google.com.evil.test/folder',
    'https://notdrive.google.com/folder',
    'https://evil.test/?x=drive.google.com',
  ]) {
    const result = parseDataRoomUrl(url);
    assert.equal(result.ok, false, `${url} must be rejected`);
    assert.match(result.error, /Google Drive link/);
  }
});

test('rejects text that is not a URL at all', () => {
  const result = parseDataRoomUrl('drive.google.com/drive/folders/abc');
  assert.equal(result.ok, false, 'a bare host with no scheme is not a full URL');
  assert.match(result.error, /full URL/);
});

test('rejects an absurdly long link rather than storing it', () => {
  const long = `https://drive.google.com/drive/folders/${'a'.repeat(600)}`;
  assert.equal(parseDataRoomUrl(long).ok, false);
});

/* ── Ownership ──────────────────────────────────────────────────────────── */

test('the owner may edit their own project', () => {
  const result = planProjectEdit({
    body: { project: 'Burnt Point', operator: 'NSPA' },
    isOwner: true,
    isAdmin: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.changes.project, 'Burnt Point');
  assert.equal(result.changes.operator, 'NSPA');
});

test('a member may not edit a project owned by someone else', () => {
  const result = planProjectEdit({
    body: { project: 'Hijacked' },
    isOwner: false,
    isAdmin: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /only edit your own projects/);
});

test('a non-owner is refused even when the body is empty', () => {
  // Authorization is decided before anything is inspected, so there is no
  // "harmless" edit that slips past the check.
  const result = planProjectEdit({ body: {}, isOwner: false, isAdmin: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('every member-editable field is accepted from the owner', () => {
  const body = {};
  for (const field of MEMBER_EDITABLE_FIELDS) {
    if (field === 'dataRoomUrl') body[field] = 'https://drive.google.com/drive/folders/x';
    else if (field === 'commodities' || field === 'depositTypes') body[field] = ['Gold'];
    else body[field] = `value for ${field}`;
  }
  const result = planProjectEdit({ body, isOwner: true, isAdmin: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedFields.sort(), [...MEMBER_EDITABLE_FIELDS].sort());
});

/* ── Administrative fields ──────────────────────────────────────────────── */

test('a member cannot change administrative fields on their own project', () => {
  for (const field of ADMIN_ONLY_FIELDS) {
    const result = planProjectEdit({
      body: { project: 'Legitimate edit', [field]: 'x' },
      isOwner: true,
      isAdmin: false,
    });
    assert.equal(result.ok, false, `${field} must be refused`);
    assert.equal(result.status, 403);
    assert.match(result.error, new RegExp(field));
  }
});

test('an attempt to change ownership is refused, not silently dropped', () => {
  // Dropping it quietly would tell the member their edit succeeded.
  const result = planProjectEdit({
    body: { memberId: '00002' },
    isOwner: true,
    isAdmin: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Only an administrator/);
});

test('a refused edit yields no changes at all', () => {
  const result = planProjectEdit({
    body: { project: 'New name', status: 'Approved' },
    isOwner: true,
    isAdmin: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.changes, undefined, 'the legitimate half must not be applied either');
});

test('an administrator may edit every field, including ownership and status', () => {
  const result = planProjectEdit({
    body: {
      project: 'Renamed by staff',
      memberId: '00007',
      status: 'Approved',
      reviewNote: 'Looks good',
      archived: true,
    },
    isOwner: false,
    isAdmin: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.changes.project, 'Renamed by staff');
  assert.equal(result.changes.memberId, '00007');
  assert.equal(result.changes.status, 'Approved');
  assert.equal(result.changes.reviewNote, 'Looks good');
  assert.equal(result.changes.archived, true);
});

test('an administrator editing their own project keeps admin powers', () => {
  const result = planProjectEdit({
    body: { status: 'Approved' },
    isOwner: true,
    isAdmin: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.changes.status, 'Approved');
});

/* ── Data Room through the edit path ────────────────────────────────────── */

test('the owner may add, change and remove the Data Room link', () => {
  const added = planProjectEdit({
    body: { dataRoomUrl: 'https://drive.google.com/drive/folders/first' },
    isOwner: true,
  });
  assert.equal(added.changes.dataRoomUrl, 'https://drive.google.com/drive/folders/first');

  const removed = planProjectEdit({ body: { dataRoomUrl: '' }, isOwner: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.changes.dataRoomUrl, '', 'an empty value clears the link');
});

test('a bad Data Room link fails the whole edit with a 400', () => {
  const result = planProjectEdit({
    body: { project: 'Fine', dataRoomUrl: 'https://example.com/folder' },
    isOwner: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /Google Drive link/);
});

/* ── Shape of the edit ──────────────────────────────────────────────────── */

test('fields absent from the body are left untouched', () => {
  const result = planProjectEdit({ body: { project: 'Only this' }, isOwner: true });
  assert.deepEqual(result.changedFields, ['project']);
  assert.deepEqual(Object.keys(result.changes), ['project']);
});

test('list fields are trimmed and emptied entries dropped', () => {
  const result = planProjectEdit({
    body: { commodities: [' Gold ', '', 'Copper'], depositTypes: 'Vein, , Porphyry' },
    isOwner: true,
  });
  assert.deepEqual(result.changes.commodities, ['Gold', 'Copper']);
  assert.deepEqual(result.changes.depositTypes, ['Vein', 'Porphyry']);
});

test('archived is coerced to a real boolean', () => {
  assert.equal(planProjectEdit({ body: { archived: 'true' }, isAdmin: true }).changes.archived, true);
  assert.equal(planProjectEdit({ body: { archived: false }, isAdmin: true }).changes.archived, false);
});

test('id, tenures and documents are not editable by anyone', () => {
  const result = planProjectEdit({
    body: { id: 'PRJ-99999', tenures: [{ tenureNumber: '1234' }], documents: [], createdAt: '2020-01-01' },
    isOwner: true,
    isAdmin: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedFields, [], 'none of these are editable through this path');
});
