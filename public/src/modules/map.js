(async function () {
    const { esc, api, showToast, favoriteButton, toggleFavorite, debounce, getSession } = NSPA;

    const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const STATUS_COLORS = {
      Approved: cssVar('--success') || '#6FBF73',
      Pending: cssVar('--gold') || '#C9A84C',
      Submitted: cssVar('--info') || '#5B9BD5',
      'Under Review': cssVar('--info') || '#5B9BD5',
      Resubmitted: cssVar('--info') || '#5B9BD5',
      'Revisions Requested': cssVar('--warning') || '#E39B4D',
      Rejected: cssVar('--danger') || '#E05C5C',
    };
    const statusColor = s => STATUS_COLORS[s] || STATUS_COLORS.Pending;

    // Below this zoom a claim block is only a few pixels across, so clustered
    // markers are the only way to find anything. At or above it the boundary
    // is the information, and the polygons take over.
    const POLYGON_ZOOM = 11;

    const countEl = document.getElementById('mapCount');
    const listEl = document.getElementById('mapProjectList');
    const searchEl = document.getElementById('mapSearch');
    const zoomHint = document.getElementById('zoomHint');
    const FILTERS = {
      commodity: document.getElementById('fCommodity'),
      county: document.getElementById('fCounty'),
      status: document.getElementById('fStatus'),
      deposit: document.getElementById('fDeposit'),
      operator: document.getElementById('fOperator'),
      owner: document.getElementById('fOwner'),
      stage: document.getElementById('fStage'),
      tenure: document.getElementById('fTenure'),
      media: document.getElementById('fMedia'),
      year: document.getElementById('fYear'),
      sort: document.getElementById('fSort'),
    };

    const map = L.map('projectMap', {
      preferCanvas: true,
      zoomControl: false,
      zoomSnap: 0.5,             // gentler steps make wheel zoom feel smooth
      wheelPxPerZoomLevel: 110,
    }).setView([45.1, -63.0], 7);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    /* ── Layers ── */
    const { baseLayers, overlays } = window.NSPAMapLayers;
    const baseInstances = new Map();
    const overlayInstances = new Map();
    let activeBase = null;
    try {
      const meta = await api('/api/mineral-occurrences/meta');
      const occurrenceSpec = overlays.find(o => o.id === 'occurrences');
      if (occurrenceSpec) {
        occurrenceSpec.unavailable = !meta.available;
        occurrenceSpec.hint = meta.available
          ? `${meta.count || 0} MEB occurrence${Number(meta.count) === 1 ? '' : 's'}`
          : (meta.hint || 'Import the MEB occurrence dataset — see README');
      }
    } catch {
      const occurrenceSpec = overlays.find(o => o.id === 'occurrences');
      if (occurrenceSpec) {
        occurrenceSpec.unavailable = true;
        occurrenceSpec.hint = 'Could not check occurrence dataset';
      }
    }

    function selectBase(id) {
      const spec = baseLayers.find(b => b.id === id) || baseLayers[0];
      if (activeBase) map.removeLayer(activeBase);
      if (!baseInstances.has(spec.id)) baseInstances.set(spec.id, spec.make());
      activeBase = baseInstances.get(spec.id);
      activeBase.addTo(map).bringToBack();
    }

    const baseList = document.getElementById('baseLayerList');
    baseList.innerHTML = baseLayers.map(b => `
      <label class="layer-option">
        <input type="radio" name="baselayer" value="${esc(b.id)}"${b.default ? ' checked' : ''} />
        <span>${esc(b.label)}</span>
      </label>`).join('');
    baseList.addEventListener('change', e => {
      if (e.target.name === 'baselayer') selectBase(e.target.value);
    });
    selectBase('dark');

    const groups = [...new Set(overlays.map(o => o.group))];
    document.getElementById('overlayGroups').innerHTML = groups.map(group => `
      <fieldset class="layer-group">
        <legend>${esc(group)}</legend>
        ${overlays.filter(o => o.group === group).map(o => `
          <label class="layer-option${o.unavailable ? ' unavailable' : ''}">
            <input type="checkbox" data-overlay="${esc(o.id)}"${o.unavailable ? ' disabled' : ''} />
            <span>${esc(o.label)}
              ${o.hint ? `<em class="layer-hint">${esc(o.hint)}</em>` : ''}
              ${o.minZoom ? `<em class="layer-hint layer-zoom" data-minzoom="${o.minZoom}">Zoom in to see detail</em>` : ''}
            </span>
          </label>`).join('')}
      </fieldset>`).join('');

    document.getElementById('overlayGroups').addEventListener('change', e => {
      const id = e.target.dataset.overlay;
      if (!id) return;
      const spec = overlays.find(o => o.id === id);
      if (!spec || !spec.make) return;
      if (e.target.checked) {
        if (!overlayInstances.has(id)) overlayInstances.set(id, spec.make());
        overlayInstances.get(id).on && overlayInstances.get(id).on('data:error', ev => showToast(ev.error.message, 'error'));
        overlayInstances.get(id).addTo(map);
        if (spec.minZoom && map.getZoom() < spec.minZoom) showToast(`Zoom in to see "${spec.label}".`, 'success');
      } else if (overlayInstances.has(id)) {
        map.removeLayer(overlayInstances.get(id));
      }
      restack();
    });

    const restack = () => polygonLayer.bringToFront();

    /* ── Data ── */
    let projects = [];
    try {
      const [data, filters] = await Promise.all([
        api('/api/projects/map'),
        api('/api/projects/filters'),
      ]);
      projects = data.projects || [];
      fillFilter(FILTERS.commodity, filters.commodities);
      fillFilter(FILTERS.county, filters.counties);
      fillFilter(FILTERS.status, filters.statuses);
      fillFilter(FILTERS.deposit, filters.depositTypes);
      fillFilter(FILTERS.operator, filters.operators);
      fillFilter(FILTERS.owner, filters.owners);
      fillFilter(FILTERS.stage, filters.stages);
      fillFilter(FILTERS.tenure, filters.tenureNumbers);
      fillFilter(FILTERS.year, filters.years);
    } catch (e) {
      countEl.textContent = 'Failed to load';
      listEl.innerHTML = `<div class="empty-state">
        <span class="empty-state-icon" aria-hidden="true">!</span>
        <p class="empty-state-title">Couldn't load projects</p>
        <p class="empty-state-text">${esc(e.message)}</p>
      </div>`;
      return;
    }

    function fillFilter(select, values) {
      const first = select.querySelector('option');
      select.innerHTML = '';
      select.appendChild(first);
      for (const v of values || []) {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        select.appendChild(o);
      }
    }

    const viewer = await getSession({ force: true });
    const canSaveProjects = !!(viewer.member && viewer.member.isMember);
    const savedIds = new Set();
    if (canSaveProjects) {
      try {
        const r = await fetch('/api/favorites/ids');
        if (r.ok) (await r.json()).ids.forEach(id => savedIds.add(id));
      } catch {}
    }

    /* ── Rendering ── */
    const polygonLayer = L.featureGroup();
    const clusterLayer = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 56,
      // Projects on the same ground share a coordinate. Fanning them out beats
      // zooming, which otherwise runs to max zoom and lands inside the claim.
      spiderfyOnMaxZoom: true,
      // Handled manually below so the zoom can be capped.
      zoomToBoundsOnClick: false,
      iconCreateFunction(cluster) {
        const n = cluster.getChildCount();
        const size = n < 10 ? 36 : n < 50 ? 42 : 48;
        return L.divIcon({ html: `<span>${n}</span>`, className: 'project-cluster', iconSize: [size, size] });
      },
    });

    // Clicking a cluster zooms to its members, but never past the point where
    // the claim boundaries are readable. Coincident projects (several members
    // on the same ground) spiderfy instead of zooming indefinitely.
    clusterLayer.on('clusterclick', e => {
      const bounds = e.layer.getBounds();
      const spread = Math.max(
        bounds.getNorth() - bounds.getSouth(),
        bounds.getEast() - bounds.getWest()
      );
      if (spread < 1e-6) {
        e.layer.spiderfy();      // all at one spot — fan them out
      } else {
        map.flyToBounds(bounds, { padding: [70, 70], maxZoom: 13, duration: 0.6 });
      }
    });

    const layersByProject = new Map();
    let visible = [];

    function popupHtml(p) {
      const rows = [
        p.operator && ['Company', p.operator],
        p.owner && ['Member', p.owner],
        p.commodities.length && ['Commodity', p.commodities.join(', ')],
        p.county && ['County', p.county],
      ].filter(Boolean);

      return `
        <article class="map-popup">
          <header class="map-popup-head">
            <h3>${esc(p.title)}</h3>
            <span class="status-badge status-${esc(String(p.status).toLowerCase().replace(/[^a-z]+/g, '-'))}">${esc(p.status)}</span>
          </header>
          ${p.description
            ? `<p class="map-popup-desc">${esc(p.description.slice(0, 140))}${p.description.length > 140 ? '…' : ''}</p>`
            : ''}
          <dl class="map-popup-facts">
            ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
          </dl>
          <div class="map-popup-actions">
            <a class="submit-btn map-popup-view" href="/project.html?id=${encodeURIComponent(p.id)}">View Project</a>
            ${p.dataRoomUrl
              ? `<a class="secondary-btn map-popup-dataroom" href="${esc(p.dataRoomUrl)}"
                     target="_blank" rel="noopener noreferrer external">Open Data Room<span class="sr-only"> (opens in a new tab)</span></a>`
              : ''}
            ${canSaveProjects ? favoriteButton(p.id, savedIds.has(p.id)) : ''}
          </div>
        </article>`;
    }

    function matches(p) {
      if (FILTERS.commodity.value && !p.commodities.includes(FILTERS.commodity.value)) return false;
      if (FILTERS.county.value && !(p.counties || []).includes(FILTERS.county.value)) return false;
      if (FILTERS.status.value && p.status !== FILTERS.status.value) return false;
      if (FILTERS.deposit.value && !p.depositTypes.includes(FILTERS.deposit.value)) return false;
      if (FILTERS.operator.value && p.operator !== FILTERS.operator.value) return false;
      if (FILTERS.owner.value && p.owner !== FILTERS.owner.value) return false;
      if (FILTERS.stage.value && p.projectStage !== FILTERS.stage.value) return false;
      if (FILTERS.tenure.value && !(p.tenureNumbers || []).includes(FILTERS.tenure.value)) return false;
      if (FILTERS.media.value === 'photos' && !p.hasPhotos) return false;
      if (FILTERS.media.value === 'documents' && !p.hasDocuments) return false;
      if (FILTERS.media.value === 'resource' && !p.hasResourceEstimate) return false;
      if (FILTERS.year.value && String(p.createdAt || '').slice(0, 4) !== FILTERS.year.value) return false;

      const q = searchEl.value.trim().toLowerCase();
      if (q) {
        const hay = [p.title, p.operator, p.owner, p.status, p.county, p.description,
          p.projectStage, p.resourceEstimate,
          ...(p.counties || []), ...p.commodities, ...p.depositTypes,
          ...(p.tenureNumbers || [])].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }

    function compareText(a, b) {
      return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
    }

    function sortProjects(list) {
      const mode = FILTERS.sort.value;
      return [...list].sort((a, b) => {
        if (mode === 'oldest') return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
        if (mode === 'title') return compareText(a.title, b.title);
        if (mode === 'company') return compareText(a.operator, b.operator) || compareText(a.title, b.title);
        if (mode === 'county') return compareText(a.county, b.county) || compareText(a.title, b.title);
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });
    }

    const centerOf = p => (p.center ? [p.center[1], p.center[0]] : null);

    /** Leaflet bounds for a project, from the bbox the API already provides. */
    function boundsOf(p) {
      if (p.bbox && p.bbox.length === 4) {
        const [minX, minY, maxX, maxY] = p.bbox;
        return L.latLngBounds([minY, minX], [maxY, maxX]);
      }
      const c = centerOf(p);
      return c ? L.latLng(c).toBounds(600) : null;   // ~600 m around a point
    }
    const activeFilterCount = () =>
      Object.entries(FILTERS).filter(([key, s]) => key !== 'sort' && s.value).length + (searchEl.value.trim() ? 1 : 0);

    function render() {
      polygonLayer.clearLayers();
      clusterLayer.clearLayers();
      layersByProject.clear();

      visible = sortProjects(projects.filter(matches));
      countEl.textContent = `${visible.length} project${visible.length === 1 ? '' : 's'}`;

      const badge = document.getElementById('activeFilterCount');
      const n = activeFilterCount();
      badge.textContent = n;
      badge.hidden = n === 0;

      for (const p of visible) {
        const color = statusColor(p.status);

        // Real claim boundaries, used from POLYGON_ZOOM upwards.
        const group = L.featureGroup();
        for (const t of p.tenures || []) {
          group.addLayer(L.geoJSON(t.geojson, {
            // Keep fills light so overlapping project areas do not obscure
            // the basemap.
            style: { color, weight: 2, fillColor: color, fillOpacity: 0.12 },
            pointToLayer: (f, latlng) =>
              L.circleMarker(latlng, { radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 2 }),
          }));
        }
        if (group.getLayers().length) {
          group.bindPopup(() => popupHtml(p), { maxWidth: 340, className: 'map-popup-wrap' });
          polygonLayer.addLayer(group);
          layersByProject.set(p.id, group);
        }

        // A marker for the clustered, zoomed-out view.
        const c = centerOf(p);
        if (c) {
          const marker = L.marker(c, {
            icon: L.divIcon({ className: 'project-pin', html: `<span style="--pin:${color}"></span>`, iconSize: [18, 18] }),
            title: p.title,
          });
          marker.bindPopup(() => popupHtml(p), { maxWidth: 340, className: 'map-popup-wrap' });
          clusterLayer.addLayer(marker);
        }
      }

      applyZoomMode();
      renderList();
    }

    /* Clustered markers when zoomed out, boundaries when zoomed in. */
    function applyZoomMode() {
      const z = map.getZoom();
      const showPolygons = z >= POLYGON_ZOOM;

      if (showPolygons) {
        if (map.hasLayer(clusterLayer)) map.removeLayer(clusterLayer);
        if (!map.hasLayer(polygonLayer)) polygonLayer.addTo(map);
        restack();
      } else {
        if (!map.hasLayer(polygonLayer)) { /* nothing to remove */ } else map.removeLayer(polygonLayer);
        if (!map.hasLayer(clusterLayer)) clusterLayer.addTo(map);
      }
      zoomHint.hidden = showPolygons;

      document.querySelectorAll('.layer-zoom').forEach(el => {
        el.style.display = z < Number(el.dataset.minzoom) ? '' : 'none';
      });
    }

    function renderList() {
      if (!visible.length) {
        listEl.innerHTML = `
          <div class="empty-state">
            <span class="empty-state-icon" aria-hidden="true">◎</span>
            <p class="empty-state-title">No projects match</p>
            <p class="empty-state-text">Try clearing a filter or searching for something else.</p>
            <button type="button" class="secondary-btn empty-state-action" id="emptyResetBtn">Reset filters</button>
          </div>`;
        const btn = document.getElementById('emptyResetBtn');
        if (btn) btn.addEventListener('click', resetFilters);
        return;
      }

      listEl.innerHTML = visible.map(p => `
        <button type="button" class="map-result" data-id="${esc(p.id)}">
          <span class="map-result-bar" style="background:${statusColor(p.status)}"></span>
          <span class="map-result-body">
            <span class="map-result-title">${esc(p.title)}</span>
            <span class="map-result-meta">${esc([p.operator, p.county, p.projectStage].filter(Boolean).join(' · '))}</span>
            ${p.commodities.length
              ? `<span class="map-result-tags">${p.commodities.slice(0, 3).map(c => `<span>${esc(c)}</span>`).join('')}</span>`
              : ''}
            <span class="map-result-facts">
              ${(p.tenureNumbers || []).length ? `<span>${esc((p.tenureNumbers || []).length)} tenure${(p.tenureNumbers || []).length === 1 ? '' : 's'}</span>` : ''}
              ${p.hasPhotos ? '<span>Photos</span>' : ''}
              ${p.hasDocuments ? '<span>Files</span>' : ''}
            </span>
          </span>
        </button>`).join('');

      listEl.querySelectorAll('.map-result').forEach(row => {
        row.addEventListener('click', () => {
          listEl.querySelectorAll('.map-result').forEach(r => r.classList.remove('active'));
          row.classList.add('active');

          const project = visible.find(p => p.id === row.dataset.id);
          if (!project) return;

          // Fly using the bbox from the API rather than the Leaflet layer:
          // below POLYGON_ZOOM the polygons aren't on the map, so their layer
          // bounds aren't a reliable source.
          const bounds = boundsOf(project);
          if (!bounds) return;

          map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 14, duration: 0.6 });
          map.once('moveend', () => {
            const group = layersByProject.get(project.id);
            if (group && map.hasLayer(polygonLayer)) group.openPopup();
          });
        });
      });
    }

    function resetFilters() {
      Object.entries(FILTERS).forEach(([key, s]) => { s.value = key === 'sort' ? 'newest' : ''; });
      searchEl.value = '';
      render();
      fitToVisible();
    }

    function fitToVisible() {
      const all = visible.map(boundsOf).filter(Boolean);
      if (!all.length) return;
      const b = all.reduce((acc, x) => acc.extend(x), L.latLngBounds(all[0].getSouthWest(), all[0].getNorthEast()));
      if (b.isValid()) map.flyToBounds(b, { padding: [60, 60], maxZoom: 12, duration: 0.7 });
    }

    /* ── Sidebar collapse ── */
    const toggle = document.getElementById('sidebarToggle');
    const toggleIcon = document.getElementById('toggleIcon');
    const toggleLabel = document.getElementById('toggleLabel');

    toggle.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggleIcon.setAttribute('d', collapsed ? 'M6 3.5L10.5 8 6 12.5' : 'M10 3.5L5.5 8l4.5 4.5');
      toggleLabel.textContent = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      // Leaflet has to be told its container resized.
      setTimeout(() => map.invalidateSize({ animate: true }), 260);
    });

    /* ── Wiring ── */
    Object.values(FILTERS).forEach(sel => sel.addEventListener('change', () => { render(); fitToVisible(); }));
    searchEl.addEventListener('input', debounce(render, 200));
    document.getElementById('resetFiltersBtn').addEventListener('click', resetFilters);
    document.getElementById('fitResultsBtn').addEventListener('click', fitToVisible);
    map.on('zoomend', applyZoomMode);

    document.addEventListener('click', async e => {
      const btn = e.target.closest && e.target.closest('.fav-btn');
      if (!btn || !canSaveProjects) return;
      const nowSaved = await toggleFavorite(btn);
      if (nowSaved) savedIds.add(btn.dataset.project);
      else savedIds.delete(btn.dataset.project);
    });

    render();

    const initial = visible.map(boundsOf).filter(Boolean);
    if (initial.length) {
      const b = initial.reduce((acc, x) => acc.extend(x), L.latLngBounds(initial[0].getSouthWest(), initial[0].getNorthEast()));
      if (b.isValid()) map.fitBounds(b, { padding: [60, 60], maxZoom: 11 });
    }
    applyZoomMode();
  })();
