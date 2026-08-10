(async function () {
    const { esc, api, showToast, fmtDate, fmtDateTime, fmtRelative, fmtSize,
            statusBadge, favoriteButton, toggleFavorite } = NSPA;

    const body = document.getElementById('projectBody');
    const main = document.getElementById('main');
    const projectId = new URLSearchParams(location.search).get('id');

    if (!projectId) {
      body.innerHTML = '<p class="membership-lead">No project specified.</p>';
      main.setAttribute('aria-busy', 'false');
      return;
    }

    let data;
    try {
      data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    } catch (e) {
      body.innerHTML = `<p class="membership-lead">${esc(e.message)}</p>
        <p class="form-hint">This project may have been removed, or its owner's membership may have lapsed.</p>`;
      main.setAttribute('aria-busy', 'false');
      return;
    }

    const p = data.project;
    document.title = `${p.title} · NSPA`;

    let saved = false;
    try {
      const r = await fetch('/api/favorites/ids');
      if (r.ok) saved = (await r.json()).ids.includes(p.id);
    } catch {}

    const facts = [
      ['Status', statusBadge(p.status)],
      ['Operator', p.operator && esc(p.operator)],
      ['Member', p.owner && esc(p.owner)],
      ['County', p.counties.length ? esc(p.counties.join(', ')) : ''],
      ['Project stage', p.projectStage && esc(p.projectStage)],
      ['Commodities', p.commodities.length ? esc(p.commodities.join(', ')) : ''],
      ['Deposit type', p.depositTypes.length ? esc(p.depositTypes.join(', ')) : ''],
      ['Tenure numbers', p.tenureNumbers.length
        ? `<span class="mono">${esc(p.tenureNumbers.join(', '))}</span>` : ''],
      ['Resource estimate', p.resourceEstimate && esc(p.resourceEstimate)],
      ['Resource source', p.resourceSource && esc(p.resourceSource)],
      ['Website', p.website
        ? `<a href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">${esc(p.website)}<span class="sr-only"> (opens in a new tab)</span></a>` : ''],
      ['Submitted', esc(fmtDate(p.createdAt))],
      ['Last updated', esc(fmtDate(p.updatedAt))],
    ].filter(([, v]) => v);

    const docRow = d => `
      <div class="doc-item">
        <a class="doc-download" href="/api/projects/${encodeURIComponent(p.id)}/documents/${encodeURIComponent(d.id)}/download"
           download>${esc(d.title || d.fileName)}</a>
        <span class="doc-item-meta">${esc(d.fileName)}${d.size ? ' · ' + esc(fmtSize(d.size)) : ''} · ${esc(fmtDate(d.uploadedAt))}</span>
      </div>`;

    const photoTile = (d, i) => `
      <button type="button" class="gallery-tile" data-index="${i}"
              aria-label="View photo: ${esc(d.title || d.fileName)}">
        <img loading="lazy" decoding="async"
             src="/api/projects/${encodeURIComponent(p.id)}/documents/${encodeURIComponent(d.id)}/view"
             alt="${esc(d.title || d.fileName)}" />
        <span class="gallery-caption">${esc(d.title || d.fileName)}</span>
      </button>`;

    const TIMELINE_ICONS = {
      project_submitted: '◆',
      project_approved: '✓',
      project_status_changed: '↻',
      documents_added: '⎘',
    };

    const timelineRow = t => `
      <li class="timeline-item">
        <span class="timeline-icon" aria-hidden="true">${TIMELINE_ICONS[t.type] || '•'}</span>
        <span class="timeline-main">
          <span class="timeline-summary">${esc(t.summary)}</span>
          <span class="timeline-meta">
            <time datetime="${esc(t.createdAt)}">${esc(fmtDateTime(t.createdAt))}</time>
            · ${esc(fmtRelative(t.createdAt))}
          </span>
        </span>
      </li>`;

    body.innerHTML = `
      <header class="page-header project-detail-header">
        <p class="eyebrow">Project <span class="mono">${esc(p.id)}</span></p>
        <h1>${esc(p.title)}</h1>
        ${!p.shared && p.ownedByViewer
          ? `<p class="project-private-note">This project isn't visible to other members yet — it becomes visible once approved.</p>`
          : ''}
        <div class="project-header-actions">
          ${favoriteButton(p.id, saved)}
          ${data.canEdit ? '<a class="secondary-btn" href="/dashboard.html">Manage in dashboard</a>' : ''}
        </div>
      </header>

      <div class="stack-card">
        <div class="form-section">
          <p class="section-label">Overview</p>
          ${p.description
            ? `<p class="project-description">${esc(p.description)}</p>`
            : '<p class="form-hint">No description was provided for this project.</p>'}
          <dl class="project-facts">
            ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
          </dl>
        </div>
      </div>

      ${p.tenures.length ? `
      <div class="stack-card">
        <div class="form-section">
          <p class="section-label">Location</p>
          <div id="projectMap" role="application" aria-label="Map of this project's claim tenures"></div>
        </div>
      </div>` : ''}

      <div class="stack-card">
        <div class="form-section">
          <p class="section-label">Documents</p>
          ${p.documents.length
            ? `<div class="doc-list">${p.documents.map(docRow).join('')}</div>`
            : '<p class="form-hint">No documents have been attached to this project.</p>'}
        </div>
      </div>

      <div class="stack-card">
        <div class="form-section">
          <p class="section-label">Photos</p>
          ${p.photos.length
            ? `<div class="gallery-grid">${p.photos.map(photoTile).join('')}</div>`
            : '<p class="form-hint">No photos have been uploaded for this project.</p>'}
        </div>
      </div>

      <div class="stack-card">
        <div class="form-section">
          <p class="section-label">History</p>
          ${data.timeline.length
            ? `<ul class="timeline">${data.timeline.map(timelineRow).join('')}</ul>`
            : '<p class="form-hint">No recorded history for this project yet.</p>'}
        </div>
      </div>`;

    main.setAttribute('aria-busy', 'false');

    /* ── Map ── */
    if (p.tenures.length) {
      const map = L.map('projectMap', { preferCanvas: true }).setView([45.1, -63.0], 8);
      const { baseLayers } = window.NSPAMapLayers;
      (baseLayers.find(b => b.id === 'dark') || baseLayers[0]).make().addTo(map);

      const group = L.featureGroup().addTo(map);
      for (const t of p.tenures) {
        L.geoJSON(t.geojson, {
          style: { color: '#C9A84C', weight: 2, fillColor: '#E8C97A', fillOpacity: 0.25 },
          pointToLayer: (f, latlng) =>
            L.circleMarker(latlng, { radius: 6, color: '#C9A84C', fillOpacity: 0.8, weight: 2 }),
          onEachFeature: (f, layer) => layer.bindPopup(`<strong>${esc(t.tenureNumber || 'Tenure')}</strong>`),
        }).addTo(group);
      }
      const b = group.getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 13 });
      setTimeout(() => map.invalidateSize(), 120);
    }

    /* ── Gallery lightbox ── */
    const lightbox = document.getElementById('lightbox');
    const lbImg = document.getElementById('lightboxImg');
    const lbCaption = document.getElementById('lightboxCaption');
    let index = 0;
    let lastFocus = null;

    function openLightbox(i) {
      index = (i + p.photos.length) % p.photos.length;
      const photo = p.photos[index];
      lbImg.src = `/api/projects/${encodeURIComponent(p.id)}/documents/${encodeURIComponent(photo.id)}/view`;
      lbImg.alt = photo.title || photo.fileName;
      lbCaption.textContent =
        `${photo.title || photo.fileName} — uploaded ${fmtDate(photo.uploadedAt)}` +
        (p.photos.length > 1 ? ` (${index + 1} of ${p.photos.length})` : '');
      lastFocus = document.activeElement;
      lightbox.hidden = false;
      document.getElementById('lightboxClose').focus();
    }

    function closeLightbox() {
      lightbox.hidden = true;
      lbImg.src = '';
      if (lastFocus) lastFocus.focus();
    }

    body.querySelectorAll('.gallery-tile').forEach(tile =>
      tile.addEventListener('click', () => openLightbox(Number(tile.dataset.index)))
    );
    document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
    document.getElementById('lightboxPrev').addEventListener('click', () => openLightbox(index - 1));
    document.getElementById('lightboxNext').addEventListener('click', () => openLightbox(index + 1));
    lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });

    document.addEventListener('keydown', e => {
      if (lightbox.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') openLightbox(index - 1);
      if (e.key === 'ArrowRight') openLightbox(index + 1);
    });

    // Hide gallery navigation when only one photo is available.
    if (p.photos.length < 2) {
      document.getElementById('lightboxPrev').hidden = true;
      document.getElementById('lightboxNext').hidden = true;
    }

    body.addEventListener('click', async e => {
      const btn = e.target.closest('.fav-btn');
      if (btn) await toggleFavorite(btn);
    });
  })();
