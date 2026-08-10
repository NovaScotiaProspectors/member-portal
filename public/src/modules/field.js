(async function () {
    const { esc, api, showToast } = NSPA;

    /* ── Offline support ── */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const netEl = document.getElementById('netStatus');
    const paintNet = () => {
      const on = navigator.onLine;
      netEl.textContent = on ? 'Online' : 'Offline — using saved maps';
      netEl.className = `field-net ${on ? 'is-online' : 'is-offline'}`;
    };
    window.addEventListener('online', paintNet);
    window.addEventListener('offline', paintNet);
    paintNet();

    /* ── Claim geometry ──
       Cached by the service worker for offline use. */
    let claims = [];
    try {
      claims = (await api('/api/claims/geometry')).claims || [];
    } catch (e) {
      showToast('Could not load claims. Saved boundaries will be used if available.', 'error');
    }

    /* ── Map ── */
    const map = L.map('fieldMap', { zoomControl: false, preferCanvas: true })
      .setView([45.1, -63.0], 7);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);

    const claimLayer = L.featureGroup().addTo(map);

    function featuresFromGeoJSON(geojson) {
      if (!geojson) return [];
      if (geojson.type === 'FeatureCollection') return geojson.features || [];
      if (geojson.type === 'Feature') return [geojson];
      if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
        return [{ type: 'Feature', properties: {}, geometry: geojson }];
      }
      return [];
    }

    for (const claim of claims) {
      for (const t of claim.tenures || []) {
        L.geoJSON(featuresFromGeoJSON(t.geojson), {
          style: { color: '#C9A84C', weight: 2.5, fillColor: '#E8C97A', fillOpacity: 0.18 },
        }).bindPopup(`<strong>${esc(t.tenureNumber || 'Tenure')}</strong>`).addTo(claimLayer);
      }
    }
    const claimBounds = claimLayer.getBounds();
    if (claimBounds.isValid()) map.fitBounds(claimBounds, { padding: [24, 24], maxZoom: 13 });

    /* ── Point-in-polygon checks for offline claim status ── */
    function pointInRing(lng, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }

    // A polygon is inside its outer ring but outside any holes.
    function pointInPolygon(lng, lat, coords) {
      if (!coords || !coords.length) return false;
      if (!pointInRing(lng, lat, coords[0])) return false;
      for (let i = 1; i < coords.length; i++) {
        if (pointInRing(lng, lat, coords[i])) return false;
      }
      return true;
    }

    function pointInGeometry(lng, lat, geometry) {
      if (!geometry) return false;
      if (geometry.type === 'Polygon') return pointInPolygon(lng, lat, geometry.coordinates);
      if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.some(poly => pointInPolygon(lng, lat, poly));
      }
      return false;
    }

    /** Returns the claim containing the current point, when one exists. */
    function claimAt(lng, lat) {
      for (const claim of claims) {
        for (const t of claim.tenures || []) {
          const features = featuresFromGeoJSON(t.geojson);
          for (const f of features) {
            if (pointInGeometry(lng, lat, f.geometry)) {
              return { tenureNumber: t.tenureNumber, projectTitle: claim.projectTitle };
            }
          }
        }
      }
      return null;
    }

    // Approximate metres between two lon/lat points at claim scale.
    function metresBetween(lng1, lat1, lng2, lat2) {
      const R = 6378137;
      const rad = Math.PI / 180;
      const x = (lng2 - lng1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
      const y = (lat2 - lat1) * rad;
      return Math.round(Math.sqrt(x * x + y * y) * R);
    }

    /** Nearest claim boundary vertex for outside-claim status. */
    function nearestClaim(lng, lat) {
      let best = null;
      for (const claim of claims) {
        for (const t of claim.tenures || []) {
          for (const f of featuresFromGeoJSON(t.geojson)) {
            const g = f.geometry;
            if (!g) continue;
            const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
            for (const poly of polys) {
              for (const ring of poly) {
                for (const [x, y] of ring) {
                  const d = metresBetween(lng, lat, x, y);
                  if (!best || d < best.metres) best = { metres: d, tenureNumber: t.tenureNumber };
                }
              }
            }
          }
        }
      }
      return best;
    }

    /* ── Live position ── */
    const verdict = document.getElementById('verdict');
    let meMarker = null;
    let meCircle = null;
    let follow = true;

    const fmtDistance = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

    function paintVerdict(lng, lat, accuracy) {
      const inside = claimAt(lng, lat);
      if (inside) {
        verdict.className = 'field-verdict is-inside';
        verdict.innerHTML = `
          <p class="field-verdict-label">Inside ${esc(inside.tenureNumber)}</p>
          <p class="field-verdict-detail">${esc(inside.projectTitle || 'Your claim')}${
            accuracy > 25 ? ` · GPS accurate to ${Math.round(accuracy)} m` : ''}</p>`;
        return;
      }
      const near = nearestClaim(lng, lat);
      verdict.className = 'field-verdict is-outside';
      verdict.innerHTML = near
        ? `<p class="field-verdict-label">Outside your claims</p>
           <p class="field-verdict-detail">Nearest is ${esc(near.tenureNumber)}, about ${esc(fmtDistance(near.metres))} away.</p>`
        : `<p class="field-verdict-label">Outside your claims</p>
           <p class="field-verdict-detail">No claim boundaries saved on this device.</p>`;
    }

    function onPosition(pos) {
      const { latitude: lat, longitude: lng, accuracy, altitude } = pos.coords;

      document.getElementById('rLat').textContent = lat.toFixed(6);
      document.getElementById('rLng').textContent = lng.toFixed(6);
      document.getElementById('rAcc').textContent = `± ${Math.round(accuracy)} m`;
      document.getElementById('rAlt').textContent = altitude == null ? '—' : `${Math.round(altitude)} m`;

      const here = [lat, lng];
      if (!meMarker) {
        meMarker = L.marker(here, {
          icon: L.divIcon({ className: 'field-me', html: '<span></span>', iconSize: [22, 22] }),
          keyboard: false,
        }).addTo(map);
        meCircle = L.circle(here, { radius: accuracy, color: '#5B9BD5', weight: 1, fillOpacity: 0.12 }).addTo(map);
        map.setView(here, Math.max(map.getZoom(), 15));
      } else {
        meMarker.setLatLng(here);
        meCircle.setLatLng(here).setRadius(accuracy);
        if (follow) map.panTo(here, { animate: true });
      }

      paintVerdict(lng, lat, accuracy);
    }

    function onPositionError(err) {
      verdict.className = 'field-verdict is-error';
      const msg = err.code === err.PERMISSION_DENIED
        ? 'Location permission denied. Enable it in your browser settings to use field mode.'
        : err.code === err.POSITION_UNAVAILABLE
          ? 'No GPS fix yet. Under heavy tree cover this can take a minute.'
          : 'Could not get your position.';
      verdict.innerHTML = `<p class="field-verdict-label">Location unavailable</p>
                           <p class="field-verdict-detail">${esc(msg)}</p>`;
    }

    if ('geolocation' in navigator) {
      navigator.geolocation.watchPosition(onPosition, onPositionError, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 20000,
      });
    } else {
      onPositionError({ code: 2, POSITION_UNAVAILABLE: 2 });
    }

    // Dragging disables auto-follow; the recenter button resumes it.
    map.on('dragstart', () => { follow = false; });
    document.getElementById('recentreBtn').addEventListener('click', () => {
      follow = true;
      if (meMarker) map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 15));
    });

    /* ── Claim list ── */
    document.getElementById('claimList').innerHTML = claims.length
      ? claims.map(c => `
          <div class="field-claim">
            <span class="mono">${esc((c.tenures || []).map(t => t.tenureNumber).join(', '))}</span>
            <span class="field-claim-title">${esc(c.projectTitle || '')}</span>
          </div>`).join('')
      : '<p class="field-hint">No claims registered yet.</p>';

    /* ── Offline tile caching ── */
    const lngLatToTile = (lng, lat, z) => {
      const n = 2 ** z;
      const x = Math.floor(((lng + 180) / 360) * n);
      const latRad = (lat * Math.PI) / 180;
      const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
      return { x, y };
    };

    const TILE_ZOOMS = [12, 13, 14, 15];
    const TILE_LIMIT = 1200; // limits offline saves on mobile data

    function tileUrlsForBounds(bounds) {
      const urls = [];
      const pad = 0.004; // include a small buffer around claim edges
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();

      for (const z of TILE_ZOOMS) {
        const a = lngLatToTile(sw.lng - pad, ne.lat + pad, z);
        const b = lngLatToTile(ne.lng + pad, sw.lat - pad, z);
        for (let x = a.x; x <= b.x; x++) {
          for (let y = a.y; y <= b.y; y++) {
            for (const s of ['a', 'b', 'c']) {
              urls.push(`https://${s}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`);
              break; // one subdomain is sufficient for cache matching
            }
          }
        }
      }
      return urls.slice(0, TILE_LIMIT);
    }

    const cacheBtn = document.getElementById('cacheBtn');
    const progress = document.getElementById('cacheProgress');
    const bar = document.getElementById('cacheBar');
    const cacheText = document.getElementById('cacheText');
    const cacheState = document.getElementById('cacheState');

    async function reportCacheSize() {
      if (!('caches' in window)) return;
      try {
        const cache = await caches.open('nspa-tiles-v3');
        const keys = await cache.keys();
        cacheState.textContent = keys.length ? `${keys.length} tiles saved` : 'Nothing saved yet';
      } catch { /* cache storage unavailable */ }
    }
    reportCacheSize();

    cacheBtn.addEventListener('click', async () => {
      if (!claimBounds.isValid()) return showToast('No claim boundaries to save.', 'error');
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      const worker = navigator.serviceWorker.controller || (registration && registration.active);
      if (!worker) {
        return showToast('Offline saving is still starting up — try again in a moment.', 'error');
      }
      const urls = tileUrlsForBounds(claimBounds);
      progress.hidden = false;
      cacheBtn.disabled = true;
      cacheText.textContent = `Saving ${urls.length} tiles…`;
      worker.postMessage({ type: 'cache-tiles', urls });
    });

    navigator.serviceWorker.addEventListener('message', event => {
      const m = event.data || {};
      if (m.type === 'cache-progress') {
        const pct = Math.round((m.done / m.total) * 100);
        bar.style.width = `${pct}%`;
        cacheText.textContent = `Saving… ${m.done} of ${m.total}`;
      } else if (m.type === 'cache-complete') {
        bar.style.width = '100%';
        cacheText.textContent = `Saved ${m.done} tiles${m.failed ? ` · ${m.failed} failed` : ''}.`;
        cacheBtn.disabled = false;
        showToast('Claim areas saved for offline use.', 'success');
        reportCacheSize();
      }
    });
  })();
