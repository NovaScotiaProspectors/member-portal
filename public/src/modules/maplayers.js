/* ────────────────────────────────────────────────────────────────────────────
 * Map layer registry + a minimal ArcGIS dynamic-map-service layer for Leaflet.
 *
 * The Nova Scotia services (NovaROC, and the Geoscience/Mines services on
 * fletcher.novascotia.ca) are ArcGIS MapServers without a WMS extension, so
 * they're consumed through their `export` endpoint: one image request per
 * tile, with `layers=show:<ids>`.
 *
 * Many NS sublayers are scale-dependent (minScale) and simply draw nothing
 * until you zoom in — each layer therefore carries a `minZoom` hint that the
 * UI surfaces, so an empty overlay reads as "zoom in", not "broken".
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  const NOVAROC = 'https://novarocmaps.novascotia.ca/arcgis/rest/services/NovaRoc/MapServer';
  const BASEDATA = 'https://novarocmaps.novascotia.ca/arcgis/rest/services/Novaroc_basemaps/MapServer';
  const GEOSCIENCE = 'https://fletcher.novascotia.ca/arcgis/rest/services/geoscience';
  const SURFICIAL = 'https://fletcher.novascotia.ca/arcgis/rest/services/surficial';

  // Tiled ArcGIS `export` requests. Extending GridLayer means Leaflet handles
  // tile lifecycle, panning and zoom for us; we only build the URL.
  const ArcGISDynamicLayer = L.GridLayer.extend({
    options: { opacity: 0.75, minZoom: 0, showIds: null },

    initialize(url, options) {
      this._url = url;
      L.setOptions(this, options);
    },

    createTile(coords, done) {
      const tile = document.createElement('img');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      tile.alt = '';
      tile.setAttribute('role', 'presentation');

      // Tile bounds in Web Mercator metres — matching imageSR keeps the
      // service from reprojecting, which is faster and avoids edge slivers.
      // L.Projection.SphericalMercator.project() already returns metres.
      const nw = this._map.unproject(coords.scaleBy(size), coords.z);
      const se = this._map.unproject(coords.add([1, 1]).scaleBy(size), coords.z);
      const p1 = L.Projection.SphericalMercator.project(nw);
      const p2 = L.Projection.SphericalMercator.project(se);

      const params = new URLSearchParams({
        bbox: [p1.x, p2.y, p2.x, p1.y].join(','),
        bboxSR: '3857',
        imageSR: '3857',
        size: `${size.x},${size.y}`,
        format: 'png32',
        transparent: 'true',
        dpi: '96',
        f: 'image',
      });
      if (this.options.showIds) params.set('layers', `show:${this.options.showIds}`);

      tile.onload = () => done(null, tile);
      // A failed tile must not break the layer — leave it blank.
      tile.onerror = () => done(null, tile);
      tile.src = `${this._url}/export?${params}`;
      return tile;
    },
  });

  const arcgis = (url, opts) => new ArcGISDynamicLayer(url, opts);

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const firstProp = (props, names) => {
    for (const name of names) {
      const key = Object.keys(props || {}).find(k => k.toLowerCase() === name.toLowerCase());
      if (key && props[key] != null && String(props[key]).trim()) return String(props[key]).trim();
    }
    return '';
  };

  function mineralOccurrenceLayer() {
    const layer = L.geoJSON(null, {
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 5,
        weight: 1.5,
        color: '#111',
        fillColor: '#F5D547',
        fillOpacity: 0.85,
      }),
      onEachFeature: (feature, marker) => {
        const p = feature.properties || {};
        const name = firstProp(p, ['name', 'occurrence', 'occurrence_name', 'site_name', 'property', 'deposit']);
        const commodity = firstProp(p, ['commodity', 'commodities', 'primary_commodity', 'mineral']);
        const id = firstProp(p, ['id', 'occurrence_id', 'meb_id', 'deposit_id']);
        const status = firstProp(p, ['status', 'development_status', 'deposit_type', 'type']);
        const rows = [
          id && ['ID', id],
          commodity && ['Commodity', commodity],
          status && ['Type/status', status],
        ].filter(Boolean);
        marker.bindPopup(`
          <article class="map-popup">
            <header class="map-popup-head"><h3>${esc(name || 'Mineral occurrence')}</h3></header>
            <div class="map-popup-grid">
              ${rows.map(([k, v]) => `<span>${esc(k)}</span><strong>${esc(v)}</strong>`).join('')}
            </div>
          </article>`);
      },
    });
    fetch('/api/mineral-occurrences')
      .then(r => {
        if (!r.ok) throw new Error('Mineral occurrences are not imported.');
        return r.json();
      })
      .then(geojson => layer.addData(geojson))
      .catch(error => {
        layer.fire('data:error', { error });
      });
    return layer;
  }

  /* ── Base maps (mutually exclusive) ── */
  const baseLayers = [
    {
      id: 'dark', label: 'Dark', default: true,
      make: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19,
      }),
    },
    {
      id: 'street', label: 'Street',
      make: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19,
      }),
    },
    {
      id: 'light', label: 'Light',
      make: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19,
      }),
    },
    {
      id: 'gray', label: 'Gray',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; Esri', maxZoom: 16,
        }),
    },
    {
      id: 'satellite', label: 'Satellite',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics', maxZoom: 19,
        }),
    },
    {
      id: 'topo', label: 'Topographic',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Topo &copy; Esri', maxZoom: 19,
        }),
    },
    {
      id: 'natgeo', label: 'National Geographic',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'National Geographic, Esri', maxZoom: 16,
        }),
    },
    {
      id: 'terrain', label: 'Terrain',
      make: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenTopoMap (CC-BY-SA)', maxZoom: 17,
      }),
    },
  ];

  /* ── Overlays (independently toggleable) ──
     `ids` are ArcGIS sublayer ids; parent group ids are included because
     ArcGIS only draws a sublayer when its parent group is also shown. */
  const overlays = [
    {
      id: 'labels', label: 'Place labels', group: 'Reference',
      hint: 'Useful with satellite or geology layers',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Reference &copy; Esri', maxZoom: 19, opacity: 0.9,
        }),
    },
    {
      id: 'transportation', label: 'Roads & transportation', group: 'Reference',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Transportation &copy; Esri', maxZoom: 19, opacity: 0.85,
        }),
    },
    {
      id: 'hillshade', label: 'Hillshade', group: 'Reference',
      hint: 'Terrain relief for interpreting ground',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Hillshade &copy; Esri', maxZoom: 16, opacity: 0.42,
        }),
    },
    {
      id: 'ocean-reference', label: 'Coast & ocean reference', group: 'Reference',
      make: () => L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Ocean reference &copy; Esri', maxZoom: 16, opacity: 0.85,
        }),
    },
    {
      id: 'bedrock', label: 'Bedrock geology', group: 'Geology',
      make: () => arcgis(`${GEOSCIENCE}/bedrockgeologyprovscale_new/MapServer`, { opacity: 0.55 }),
    },
    {
      id: 'surficial', label: 'Surficial geology', group: 'Geology',
      make: () => arcgis(`${SURFICIAL}/Surficial_Geology_Units/MapServer`, { opacity: 0.55 }),
    },
    {
      id: 'mines', label: 'Historical mines', group: 'Mining',
      hint: 'Gold, iron and coal mining areas',
      make: () => arcgis(NOVAROC, { showIds: '55,56,57,58', opacity: 0.8 }),
    },
    {
      id: 'occurrences', label: 'Mineral occurrences', group: 'Mining',
      minZoom: 10,
      hint: 'MEB occurrence dataset',
      make: mineralOccurrenceLayer,
    },
    {
      id: 'claims', label: 'Claims & mining tracts', group: 'Mining', minZoom: 11,
      make: () => arcgis(NOVAROC, { showIds: '13,16,17', opacity: 0.7 }),
    },
    {
      id: 'crown', label: 'Crown land (staking allowed)', group: 'Land status', minZoom: 9,
      make: () => arcgis(NOVAROC, { showIds: '21,42', opacity: 0.5 }),
    },
    {
      id: 'protected', label: 'Protected areas', group: 'Land status', minZoom: 8,
      hint: 'Parks, wilderness areas, nature reserves',
      make: () => arcgis(NOVAROC, { showIds: '22,23,25,26,27,29,30,43,44,45,46,49', opacity: 0.55 }),
    },
    {
      id: 'restricted', label: 'Restricted lands', group: 'Land status', minZoom: 9,
      make: () => arcgis(NOVAROC, { showIds: '21,22,34', opacity: 0.5 }),
    },
    {
      id: 'basedata', label: 'Roads & water', group: 'Base data',
      hint: 'Roads, rivers, lakes, contours',
      make: () => arcgis(BASEDATA, { showIds: '0', opacity: 0.85 }),
    },
    {
      id: 'railtrail', label: 'Railways & trails', group: 'Base data', minZoom: 9,
      make: () => arcgis(NOVAROC, { showIds: '42,48,51', opacity: 0.8 }),
    },
  ];

  window.NSPAMapLayers = { baseLayers, overlays, ArcGISDynamicLayer, arcgis };
})();
