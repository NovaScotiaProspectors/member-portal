/* ────────────────────────────────────────────────────────────────────────────
 * Claim watch — expiry/anniversary reminders and open-ground alerts.
 *
 * Two jobs, both driven by live NovaROC data rather than the snapshot captured
 * when a project was submitted (that copy drifts as claims are renewed, lapse,
 * or change hands):
 *
 *   1. Expiry watch — for every tenure a member has registered, track the
 *      anniversary and expiry dates and warn at staged thresholds. Losing
 *      ground to a missed anniversary is the expensive, common failure this
 *      is meant to prevent.
 *
 *   2. Open ground — when a *neighbouring* tenure is about to lapse, the
 *      ground becomes available for staking. Members are told before it opens,
 *      not after someone else has staked it.
 *
 * Everything is de-duplicated through portal.db so a reminder fires once per
 * threshold, no matter how often the sweep runs.
 * ──────────────────────────────────────────────────────────────────────────── */

const portal = require('./db');

const NOVAROC_QUERY =
  'https://novarocmaps.novascotia.ca/arcgis/rest/services/NovaRoc/MapServer/1/query';

// Days before a date at which to warn. Anniversaries get earlier warnings
// because the required work has to be planned and filed, not just paid.
// Overridable so the association can tune how much notice members get.
function daysListFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(',').map(v => Number(v.trim())).filter(Number.isFinite);
  return parsed.length ? [...new Set(parsed)].sort((a, b) => b - a) : fallback;
}

const EXPIRY_THRESHOLDS = daysListFromEnv('CLAIM_EXPIRY_DAYS', [90, 60, 30, 14, 7, 0]);
const ANNIVERSARY_THRESHOLDS = daysListFromEnv('CLAIM_ANNIVERSARY_DAYS', [90, 60, 30, 14, 7, 0]);

// How far around a member's claims to look for ground about to open, and how
// far ahead to look. ~0.02° is roughly 1.5–2 km at Nova Scotia's latitude.
const OPEN_GROUND_BUFFER_DEG = Number(process.env.CLAIM_OPEN_GROUND_BUFFER_DEG || 0.02);
const OPEN_GROUND_WINDOW_DAYS = Number(process.env.CLAIM_OPEN_GROUND_DAYS || 90);

// Statuses that mean the tenure is on its way out rather than in good standing.
const LAPSING_STATUSES = ['PEND_EXPIRY', 'EXPIRED', 'TERMINATED', 'CANCELLED', 'PEND_CANCEL'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** ArcGIS epoch-millis → ISO date string (date only), or ''. */
function toIsoDate(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** Whole days from today (UTC) until an ISO date; negative once past. */
function daysUntil(isoDate, now = Date.now()) {
  if (!isoDate) return null;
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Math.round((then - today) / DAY_MS);
}

/**
 * The threshold a countdown has just crossed — the smallest configured value
 * that `days` is still at or above. Returns null once past the date, so an
 * expired claim doesn't keep re-alerting forever.
 */
function crossedThreshold(days, thresholds) {
  if (days == null || days < 0) return null;
  const hit = thresholds.filter(t => days <= t);
  return hit.length ? Math.min(...hit) : null;
}

async function fetchJson(url, params) {
  const query = new URLSearchParams({ f: 'json', ...params });
  const res = await fetch(`${url}?${query}`, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`NovaROC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'NovaROC query failed');
  return json;
}

const OUT_FIELDS = [
  'TENURE_NUMBER_ID', 'MINERAL_TENURE_STATUS_CODE', 'MTA_TITLE_TYPE_CODE',
  'ISSUE_DATE', 'GOOD_TO_DATE', 'EXPIRY_DATE', 'TERMINATION_DATE', 'AREA_IN_HECTARES',
].join(',');

function attributesToRecord(a) {
  return {
    tenureNumber: String(a.TENURE_NUMBER_ID || '').trim().toUpperCase(),
    status: a.MINERAL_TENURE_STATUS_CODE || '',
    titleType: a.MTA_TITLE_TYPE_CODE || '',
    issueDate: toIsoDate(a.ISSUE_DATE),
    // GOOD_TO_DATE is the good-standing / anniversary date; EXPIRY_DATE the end
    // of the tenure. They often coincide, and either may be absent.
    anniversary: toIsoDate(a.GOOD_TO_DATE),
    expiry: toIsoDate(a.EXPIRY_DATE || a.TERMINATION_DATE),
    areaHa: a.AREA_IN_HECTARES == null ? null : Number(a.AREA_IN_HECTARES),
  };
}

/** Current NovaROC attributes for one tenure, or null when it no longer exists. */
async function fetchTenure(tenureNumber) {
  const json = await fetchJson(NOVAROC_QUERY, {
    where: `TENURE_NUMBER_ID='${String(tenureNumber).replace(/'/g, "''")}'`,
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
  });
  const feature = (json.features || [])[0];
  return feature ? attributesToRecord(feature.attributes) : null;
}

/** Bounding box of an ArcGIS polygon's rings, as [minX, minY, maxX, maxY]. */
function ringsBbox(geometry) {
  if (!geometry || !Array.isArray(geometry.rings)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of geometry.rings) {
    for (const [x, y] of ring) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Every tenure intersecting a lon/lat envelope. Geometry is requested when the
 * caller needs to work out which specific claim each neighbour sits beside —
 * the merged search envelope alone can't tell them apart.
 */
async function fetchTenuresInEnvelope([minX, minY, maxX, maxY], { withGeometry = false } = {}) {
  const json = await fetchJson(NOVAROC_QUERY, {
    geometry: [minX, minY, maxX, maxY].join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    returnGeometry: withGeometry ? 'true' : 'false',
    ...(withGeometry ? { outSR: '4326' } : {}),
  });
  return (json.features || []).map(f => ({
    ...attributesToRecord(f.attributes),
    bbox: withGeometry ? ringsBbox(f.geometry) : null,
  }));
}

/** Do two bounding boxes touch or overlap, allowing a small tolerance? */
function boxesAdjacent(a, b, tolerance = 0.0015) { // ~150 m
  if (!a || !b) return false;
  return !(
    b[0] > a[2] + tolerance || b[2] < a[0] - tolerance ||
    b[1] > a[3] + tolerance || b[3] < a[1] - tolerance
  );
}

/* ── The sweep ───────────────────────────────────────────────────────────── */

/**
 * @param {object} deps
 * @param {() => Promise<Array>} deps.listHoldings  active members and their tenures:
 *        [{ memberId, email, name, tenures: [{ tenureNumber, bbox }] }]
 * @param {(payload) => void} deps.notify  delivers one alert to one member
 * @param {(payload) => void} [deps.notifyOpportunity]
 *        checks saved member preferences against nearby open-ground candidates
 * @param {(holder, tenureNumber, neighbours) => Promise<void>|void} [deps.saveNeighbours]
 *        receives the tenures abutting each of a member's claims
 */
async function runClaimWatch({ listHoldings, notify, notifyOpportunity = null, saveNeighbours = null, log = () => {} }) {
  const holdings = await listHoldings();
  const summary = {
    members: holdings.length, tenures: 0, refreshed: 0,
    alerts: 0, openGround: 0, neighbours: 0, errors: 0,
  };
  const now = Date.now();

  // Refresh each distinct tenure once, even when several members list it.
  const seen = new Map();
  async function refresh(tenureNumber) {
    if (seen.has(tenureNumber)) return seen.get(tenureNumber);
    let record = null;
    try {
      record = await fetchTenure(tenureNumber);
      summary.refreshed++;
      await portal.saveTenureWatch({
        tenureNumber,
        ...(record || {}),
        checkedAt: new Date().toISOString(),
        missing: !record,
      });
    } catch (error) {
      summary.errors++;
      log(`tenure ${tenureNumber}: ${error.message}`);
      // Fall back to the last known good copy so one bad request doesn't
      // silence a reminder that's already due.
      record = await portal.getTenureWatch(tenureNumber);
    }
    seen.set(tenureNumber, record);
    return record;
  }

  for (const holder of holdings) {
    const ownTenures = new Set(holder.tenures.map(t => t.tenureNumber));

    for (const held of holder.tenures) {
      summary.tenures++;
      const record = await refresh(held.tenureNumber);
      if (!record) continue;

      /* 1. Anniversary and expiry countdowns. */
      const checks = [
        { kind: 'anniversary', date: record.anniversary, thresholds: ANNIVERSARY_THRESHOLDS },
        { kind: 'expiry', date: record.expiry, thresholds: EXPIRY_THRESHOLDS },
      ];

      for (const check of checks) {
        // When both dates are the same only the expiry warning is worth sending.
        if (check.kind === 'anniversary' && record.anniversary === record.expiry) continue;

        const days = daysUntil(check.date, now);
        const threshold = crossedThreshold(days, check.thresholds);
        if (threshold == null) continue;

        const fresh = await portal.recordTenureAlert({
          memberId: holder.memberId,
          tenureNumber: held.tenureNumber,
          kind: check.kind,
          milestone: String(threshold),
          dueDate: check.date,
        });
        if (!fresh) continue;

        summary.alerts++;
        notify({
          holder,
          kind: check.kind,
          tenureNumber: held.tenureNumber,
          days,
          dueDate: check.date,
          record,
        });
      }

      /* 2. Status changes that mean the claim is slipping away. */
      if (LAPSING_STATUSES.includes(record.status)) {
        const fresh = await portal.recordTenureAlert({
          memberId: holder.memberId,
          tenureNumber: held.tenureNumber,
          kind: 'status',
          milestone: record.status,
          dueDate: record.expiry || '',
        });
        if (fresh) {
          summary.alerts++;
          notify({
            holder, kind: 'status', tenureNumber: held.tenureNumber,
            days: daysUntil(record.expiry, now), dueDate: record.expiry, record,
          });
        }
      }
    }

    /* 3. Open ground + adjacency — what sits next to this member's ground. */
    const envelopes = holder.tenures.map(t => t.bbox).filter(Boolean);
    const neighboursByClaim = new Map(); // own tenure -> neighbour records

    for (const bbox of mergeEnvelopes(envelopes)) {
      let nearby = [];
      try {
        nearby = await fetchTenuresInEnvelope(bbox, { withGeometry: true });
      } catch (error) {
        summary.errors++;
        log(`open ground for ${holder.memberId}: ${error.message}`);
        continue;
      }

      // Attribute each neighbour to whichever of the member's claims it abuts.
      for (const candidate of nearby) {
        if (!candidate.tenureNumber || ownTenures.has(candidate.tenureNumber)) continue;
        for (const own of holder.tenures) {
          if (!boxesAdjacent(own.bbox, candidate.bbox)) continue;
          if (!neighboursByClaim.has(own.tenureNumber)) neighboursByClaim.set(own.tenureNumber, []);
          const list = neighboursByClaim.get(own.tenureNumber);
          if (!list.some(n => n.tenureNumber === candidate.tenureNumber)) list.push(candidate);
        }
      }

      for (const candidate of nearby) {
        if (!candidate.tenureNumber || ownTenures.has(candidate.tenureNumber)) continue;

        const days = daysUntil(candidate.expiry, now);
        const lapsing = LAPSING_STATUSES.includes(candidate.status);
        const closing = days != null && days >= 0 && days <= OPEN_GROUND_WINDOW_DAYS;
        if (!closing && !lapsing) continue;
        const adjacentTo = holder.tenures.filter(own => boxesAdjacent(own.bbox, candidate.bbox));

        if (notifyOpportunity) {
          await notifyOpportunity({
            holder,
            kind: 'open_ground',
            tenureNumber: candidate.tenureNumber,
            days,
            dueDate: candidate.expiry,
            record: candidate,
            adjacentTo,
          });
        }

        const fresh = await portal.recordTenureAlert({
          memberId: holder.memberId,
          tenureNumber: candidate.tenureNumber,
          kind: 'open_ground',
          milestone: lapsing ? candidate.status : String(crossedThreshold(days, [90, 30, 7]) ?? 90),
          dueDate: candidate.expiry || '',
        });
        if (!fresh) continue;

        summary.openGround++;
        summary.alerts++;
        notify({
          holder, kind: 'open_ground', tenureNumber: candidate.tenureNumber,
          days, dueDate: candidate.expiry, record: candidate,
        });
      }
    }

    // Hand the adjacency picture back so the caller can attribute neighbours
    // to other NSPA members and persist it.
    if (saveNeighbours) {
      for (const own of holder.tenures) {
        await saveNeighbours(holder, own.tenureNumber, neighboursByClaim.get(own.tenureNumber) || []);
        summary.neighbours += (neighboursByClaim.get(own.tenureNumber) || []).length;
      }
    }
  }

  return summary;
}

/**
 * Collapses claim bounding boxes into a few padded search envelopes, so a
 * member with a dozen adjacent claims triggers one spatial query rather than
 * a dozen overlapping ones.
 */
function mergeEnvelopes(bboxes, pad = OPEN_GROUND_BUFFER_DEG) {
  const boxes = bboxes
    .filter(b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite))
    .map(([minX, minY, maxX, maxY]) => [minX - pad, minY - pad, maxX + pad, maxY + pad]);

  const merged = [];
  for (const box of boxes) {
    const hit = merged.find(m => overlaps(m, box));
    if (hit) {
      hit[0] = Math.min(hit[0], box[0]);
      hit[1] = Math.min(hit[1], box[1]);
      hit[2] = Math.max(hit[2], box[2]);
      hit[3] = Math.max(hit[3], box[3]);
    } else {
      merged.push([...box]);
    }
  }
  return merged;
}

function overlaps(a, b) {
  return !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
}

module.exports = {
  runClaimWatch,
  fetchTenure,
  fetchTenuresInEnvelope,
  toIsoDate,
  daysUntil,
  boxesAdjacent,
  ringsBbox,
  crossedThreshold,
  mergeEnvelopes,
  EXPIRY_THRESHOLDS,
  ANNIVERSARY_THRESHOLDS,
  OPEN_GROUND_WINDOW_DAYS,
  LAPSING_STATUSES,
};
