/* ── Project editing: what may change, and who may change it ────────────────
 * The rules live here rather than inline in the route so they can be tested
 * directly, and so there is exactly one place that decides them. The interface
 * hides controls a member may not use, but that is a courtesy — this module is
 * what actually enforces it, and it runs on every request.
 *
 * Three tiers:
 *   · MEMBER_EDITABLE_FIELDS — the project's own description of itself. The
 *     owner may change these, and so may an administrator.
 *   · ADMIN_ONLY_FIELDS — ownership, review outcome, archive state, and the
 *     member identity copied onto the record. Only an administrator.
 *   · everything else (id, tenures, timestamps, documents) is not editable
 *     through this path at all, by anyone.
 * ──────────────────────────────────────────────────────────────────────────── */

const MEMBER_EDITABLE_FIELDS = [
  'project', 'operator', 'description', 'commodities', 'depositTypes',
  'projectStage', 'resourceEstimate', 'resourceSource', 'website', 'dataRoomUrl',
];

const ADMIN_ONLY_FIELDS = [
  'memberId', 'status', 'archived', 'reviewNote', 'reviewedBy', 'reviewedAt',
  'firstName', 'lastName', 'email', 'phone',
];

// Fields that arrive as arrays of short labels rather than free text.
const LIST_FIELDS = new Set(['commodities', 'depositTypes']);

const TEXT_MAX = 4000;
const LIST_ITEM_MAX = 120;
const URL_MAX = 500;

/* ── Data Room ─────────────────────────────────────────────────────────────
 * A Google Drive folder link, supplied by the member, replacing the old
 * per-project file uploads. Only https and only Google's own Drive hosts:
 * anything else is either a mistake or an attempt to point members somewhere
 * they would reasonably assume is Drive.
 * ──────────────────────────────────────────────────────────────────────────── */

const DATA_ROOM_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
]);

/**
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 *   An empty value is valid and means "no data room" — that is how a member
 *   removes a link they previously set.
 */
function parseDataRoomUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { ok: true, value: '' };

  if (raw.length > URL_MAX) {
    return { ok: false, error: `The Data Room link must be ${URL_MAX} characters or fewer.` };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'The Data Room link must be a full URL, starting with https://' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'The Data Room link must start with https:// — http and other schemes are not accepted.' };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!DATA_ROOM_HOSTS.has(host)) {
    return {
      ok: false,
      error: 'The Data Room link must be a Google Drive link (drive.google.com or docs.google.com).',
    };
  }

  return { ok: true, value: url.toString() };
}

/* ── Applying an edit ───────────────────────────────────────────────────── */

function clampText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function clampList(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  return list.map(item => clampText(item, LIST_ITEM_MAX)).filter(Boolean);
}

/** Which admin-only fields a request body is trying to set. */
function attemptedAdminFields(body) {
  return ADMIN_ONLY_FIELDS.filter(field => body[field] !== undefined);
}

/**
 * Decides whether an edit is allowed and, if so, what it changes. Nothing is
 * mutated here — the caller applies `changes` — so a rejected edit cannot have
 * left a half-written record behind.
 *
 * @param {object} args
 * @param {object} args.body         the request body
 * @param {boolean} args.isOwner     the actor owns the project
 * @param {boolean} args.isAdmin     the actor is an administrator
 * @returns {{ ok: true, changes: object, changedFields: string[] }
 *          | { ok: false, status: number, error: string }}
 */
function planProjectEdit({ body = {}, isOwner = false, isAdmin = false } = {}) {
  if (!isOwner && !isAdmin) {
    return { ok: false, status: 403, error: 'You can only edit your own projects.' };
  }

  // Refused outright rather than quietly dropped: a member who thinks they
  // changed the status should be told they did not.
  if (!isAdmin) {
    const attempted = attemptedAdminFields(body);
    if (attempted.length) {
      return {
        ok: false,
        status: 403,
        error: `Only an administrator can change: ${attempted.join(', ')}.`,
      };
    }
  }

  const allowed = isAdmin ? [...MEMBER_EDITABLE_FIELDS, ...ADMIN_ONLY_FIELDS] : MEMBER_EDITABLE_FIELDS;
  const changes = {};
  const changedFields = [];

  for (const field of allowed) {
    if (body[field] === undefined) continue;

    if (field === 'dataRoomUrl') {
      const parsed = parseDataRoomUrl(body[field]);
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      changes.dataRoomUrl = parsed.value;
      changedFields.push(field);
      continue;
    }

    if (field === 'archived') {
      changes.archived = body[field] === true || body[field] === 'true';
      changedFields.push(field);
      continue;
    }

    if (LIST_FIELDS.has(field)) {
      changes[field] = clampList(body[field]);
      changedFields.push(field);
      continue;
    }

    changes[field] = clampText(body[field], TEXT_MAX);
    changedFields.push(field);
  }

  return { ok: true, changes, changedFields };
}

module.exports = {
  MEMBER_EDITABLE_FIELDS,
  ADMIN_ONLY_FIELDS,
  parseDataRoomUrl,
  planProjectEdit,
};
