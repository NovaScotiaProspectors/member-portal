/* ────────────────────────────────────────────────────────────────────────────
 * Geometry helpers: county lookup and geometry summarisation.
 *
 * NovaROC returns claim polygons but no county, so county is derived here by
 * point-in-polygon against data/reference/ns-counties.json — a simplified
 * dissolve of the Nova Scotia municipality boundaries (which carry a county
 * on every feature). Simplified to ~400 m, which is far finer than needed to
 * decide which county a claim sits in.
 *
 * Source: data.novascotia.ca "Municipality Boundaries" (7bqh-hssn),
 * Nova Scotia Open Government Licence.
 * ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const COUNTIES_PATH = path.join(__dirname, '..', 'data', 'reference', 'ns-counties.json');

let counties = [];
try {
  counties = JSON.parse(fs.readFileSync(COUNTIES_PATH, 'utf8')).counties || [];
} catch (error) {
  console.warn('counties: reference file unavailable —', error.message);
}

const COUNTY_NAMES = counties.map(c => c.name);

// Ray casting. `ring` is a closed [lng, lat] loop.
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** County containing a point, or '' when it falls outside every county. */
function countyForPoint(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return '';
  for (const county of counties) {
    const [minX, minY, maxX, maxY] = county.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    for (const ring of county.rings) {
      if (pointInRing(lng, lat, ring)) return county.name;
    }
  }
  return '';
}

/**
 * Nearest county to a point, used as a fallback for coastal or offshore claims
 * whose centroid lands just outside the simplified boundary. Compares against
 * ring vertices, which is accurate enough at this scale.
 */
function nearestCounty(lng, lat, maxDegrees = 0.25) {
  let best = '';
  let bestSq = maxDegrees * maxDegrees;
  for (const county of counties) {
    const [minX, minY, maxX, maxY] = county.bbox;
    // Cheap reject: bounding box already further away than the current best.
    const dx = lng < minX ? minX - lng : lng > maxX ? lng - maxX : 0;
    const dy = lat < minY ? minY - lat : lat > maxY ? lat - maxY : 0;
    if (dx * dx + dy * dy > bestSq) continue;

    for (const ring of county.rings) {
      for (const [x, y] of ring) {
        const ddx = x - lng;
        const ddy = y - lat;
        const sq = ddx * ddx + ddy * ddy;
        if (sq < bestSq) { bestSq = sq; best = county.name; }
      }
    }
  }
  return best;
}

/** Walk every coordinate pair in a GeoJSON geometry. */
function eachCoordinate(geometry, visit) {
  if (!geometry) return;
  const walk = coords => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      visit(coords[0], coords[1]);
      return;
    }
    for (const child of coords) walk(child);
  };
  if (geometry.type === 'GeometryCollection') {
    (geometry.geometries || []).forEach(g => eachCoordinate(g, visit));
  } else {
    walk(geometry.coordinates);
  }
}

function eachGeometry(geojson, visit) {
  if (!geojson) return;
  if (geojson.type === 'FeatureCollection') {
    (geojson.features || []).forEach(f => f && visit(f.geometry, f.properties || {}));
  } else if (geojson.type === 'Feature') {
    visit(geojson.geometry, geojson.properties || {});
  } else if (geojson.type) {
    visit(geojson, {});
  }
}

/**
 * Bounding box + centroid for any GeoJSON, plus the geometry types present.
 * Supports point, line and polygon geometry so the map can render all three.
 */
function summarizeGeoJSON(geojson) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0, count = 0;
  const types = new Set();

  eachGeometry(geojson, geometry => {
    if (!geometry || !geometry.type) return;
    types.add(geometry.type);
    eachCoordinate(geometry, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x; sumY += y; count++;
    });
  });

  if (!count) return null;
  return {
    bbox: [minX, minY, maxX, maxY],
    // Mean vertex rather than true area centroid: cheap, and for a claim block
    // it lands well inside the shape.
    center: [sumX / count, sumY / count],
    types: [...types],
    vertexCount: count,
  };
}

/** County for a whole GeoJSON blob, falling back to the nearest county. */
function countyForGeoJSON(geojson) {
  const summary = summarizeGeoJSON(geojson);
  if (!summary) return '';
  const [lng, lat] = summary.center;
  return countyForPoint(lng, lat) || nearestCounty(lng, lat);
}

/** Counties touched by a project's tenures, in first-seen order. */
function countiesForTenures(tenures) {
  const found = [];
  for (const tenure of tenures || []) {
    if (!tenure || !tenure.geojson) continue;
    const county = countyForGeoJSON(tenure.geojson);
    if (county && !found.includes(county)) found.push(county);
  }
  return found;
}

/** Combined bbox and centre across every tenure, for map fitting. */
function summarizeTenures(tenures) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0, n = 0;
  const types = new Set();

  for (const tenure of tenures || []) {
    const summary = tenure && tenure.geojson ? summarizeGeoJSON(tenure.geojson) : null;
    if (!summary) continue;
    minX = Math.min(minX, summary.bbox[0]);
    minY = Math.min(minY, summary.bbox[1]);
    maxX = Math.max(maxX, summary.bbox[2]);
    maxY = Math.max(maxY, summary.bbox[3]);
    sumX += summary.center[0] * summary.vertexCount;
    sumY += summary.center[1] * summary.vertexCount;
    n += summary.vertexCount;
    summary.types.forEach(t => types.add(t));
  }

  if (!n) return null;
  return { bbox: [minX, minY, maxX, maxY], center: [sumX / n, sumY / n], types: [...types] };
}

module.exports = {
  COUNTY_NAMES,
  countyForPoint,
  nearestCounty,
  countyForGeoJSON,
  countiesForTenures,
  summarizeGeoJSON,
  summarizeTenures,
};
