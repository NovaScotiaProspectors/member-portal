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
  const CROWNLANDS = 'https://nsgiwa.novascotia.ca/arcgis/rest/services/PLAN/PLANCrownLandsWM84V1/MapServer';
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
function mineralCommodityColor(commodity) {
  const value = String(commodity || '').trim().toLowerCase();

  // Major exploration commodities
  if (value === 'au') return '#FFD700'; // Gold
  if (value === 'cu') return '#E67E22'; // Copper
  if (value === 'fe') return '#C0392B'; // Iron
  if (value === 'ag') return '#D7DCE2'; // Silver

  // Lead-Zinc
  if (['pb', 'zn'].includes(value)) {
    return '#3498DB';
  }

  // Critical and specialty metals
  if ([
    'li', 'sb', 'w', 'sn', 'co', 'ni', 'mo', 'mn',
    'be', 'ree', 'u', 'as', 'ti', 'v', 'ta', 'th',
    'bi', 'hg', 'cr', 'aluminium', 'mg'
  ].includes(value)) {
    return '#9B59B6';
  }

  // Industrial minerals
  if ([
    'gypsum', 'limestone', 'dolomite', 'barite', 'ba',
    'diatomite', 'clay', 'silica', 'quartz', 'graphite',
    'zeolite', 'salt', 'potash', 'potash salts', 'f',
    'kaolinite', 'k-feldspar', 'muscovite', 'garnet',
    'celestite', 'pyrophyllite'
  ].includes(value)) {
    return '#5DADE2';
  }

  // Construction and dimension stone
  if ([
    'aggregate', 'building stone', 'marble', 'slate'
  ].includes(value)) {
    return '#A1887F';
  }

  // Coal and carbonaceous / sedimentary materials
  if ([
    'coal', 'shale', 'siltstone', 'c'
  ].includes(value)) {
    return '#707B7C';
  }

  // Other or uncommon commodities
  return '#F5D547';
}
  function mineralOccurrenceLayer() {
    const layer = L.geoJSON(null, {
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 5,
        weight: 1.5,
        color: '#111',
        fillColor: mineralCommodityColor(
         feature.properties?.comm_prim || feature.properties?.Commodity
        ),
        fillOpacity: 0.85,
      }),
      onEachFeature: (feature, marker) => {
  const p = feature.properties || {};

  const name = p.name || p.Name || 'Mineral occurrence';
  const id = p.occ_num || p.ID;
  const primaryCommodity = p.comm_prim || p.Commodity;
  const occurrenceType = p.occ_type || p.Type;
  const status = p.status || p.Status;
  const commodityList = p.comm_list;
  const county = p.county;

  let otherCommodities = commodityList;

  // Avoid repeating the primary commodity when it is also
  // included in the full commodity list.
  if (otherCommodities && primaryCommodity) {
    const commodities = String(otherCommodities)
      .split(/[,;]+/)
      .map(value => value.trim())
      .filter(Boolean)
      .filter(value => value.toLowerCase() !== String(primaryCommodity).trim().toLowerCase());

    otherCommodities = commodities.join(', ');
  }

  const rows = [
    id && ['Occurrence ID', id],
    primaryCommodity && ['Primary commodity', primaryCommodity],
    occurrenceType && ['Occurrence type', occurrenceType],
    status && ['Status', status],
    otherCommodities && ['Other commodities', otherCommodities],
    county && ['County', county],
  ].filter(Boolean);

  marker.bindPopup(`
    <article class="map-popup">
      <header class="map-popup-head">
        <h3>${esc(name)}</h3>
      </header>
<div class="map-popup-grid" style="display:grid; grid-template-columns:max-content 1fr; gap:6px 14px; align-items:start;">
  ${rows.map(([k, v]) => `
    <span style="opacity:0.7;">${esc(k)}</span>
    <strong>${esc(v)}</strong>
  `).join('')}
</div>
    </article>
  `);
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
function otherExplorationLicencesLayer() {
  const layer = L.geoJSON(null, {
    style: {
      color: '#8a8a8a',
      weight: 1,
      opacity: 0.8,
      fillOpacity: 0,
    },

    onEachFeature: (feature, polygon) => {
      const p = feature.properties || {};

      const tenureNumber = p.TENURE_NUMBER_ID || '';
      const status = p.MINERAL_TENURE_STATUS_CODE || '';
      const area = p.AREA_IN_HECTARES;

      const rows = [
        tenureNumber && ['Tenure', tenureNumber],
        status && ['Status', status],
        area != null && ['Area', `${Number(area).toLocaleString()} ha`],
      ].filter(Boolean);

      polygon.bindPopup(`
        <article class="map-popup">
          <header class="map-popup-head">
            <h3>Exploration Licence ${esc(tenureNumber)}</h3>
          </header>
          <div class="map-popup-grid" style="display:grid; grid-template-columns:max-content 1fr; gap:6px 14px; align-items:start;">
            ${rows.map(([k, v]) => `
              <span style="opacity:0.7;">${esc(k)}</span>
              <strong>${esc(v)}</strong>
            `).join('')}
          </div>
        </article>
      `);
    },
  });

  Promise.all([
    fetch('/api/exploration-licences').then(response => {
      if (!response.ok) throw new Error('Exploration licences could not be loaded.');
      return response.json();
    }),
    fetch('/api/projects/map').then(response => {
      if (!response.ok) throw new Error('Member projects could not be loaded.');
      return response.json();
    }),
  ])
    .then(([licences, projectData]) => {
      const memberTenures = new Set(
        (projectData.projects || [])
          .flatMap(project => project.tenureNumbers || [])
          .map(number => String(number).trim().toUpperCase())
          .filter(Boolean)
      );

      const filtered = {
        type: 'FeatureCollection',
        features: (licences.features || []).filter(feature => {
          const tenureNumber = String(
            feature.properties?.TENURE_NUMBER_ID || ''
          ).trim().toUpperCase();

          return tenureNumber && !memberTenures.has(tenureNumber);
        }),
      };

      layer.addData(filtered);
    })
    .catch(error => {
      layer.fire('data:error', { error });
    });

  return layer;
}  
  /* ── Base maps (mutually exclusive) ── */
  const baseLayers = [
    {
      id: 'dark', label: 'Dark', default: true,
      make: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_3o0z_1_f84cae6759c0a0ab5a6506e5', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19,
      }),
    },
    {
      id: 'street', label: 'Street',
      make: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_3o0z_1_f84cae6759c0a0ab5a6506e5', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19,
      }),
    },
    {
      id: 'light', label: 'Light',
      make: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_3o0z_1_f84cae6759c0a0ab5a6506e5', {
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
      make: () => arcgis(NOVAROC, { showIds: '56,57,58', opacity: 0.8 }),
    },
    {
      id: 'occurrences', label: 'Mineral occurrences', group: 'Mining',
      minZoom: 10,
      hint: 'MEB occurrence dataset',
      make: mineralOccurrenceLayer,
    },
    {
    id: 'other-exploration-licences',
    label: 'Other exploration licences',
    group: 'Mining',
    minZoom: 8,
    hint: 'Other exploration licences',
    make: otherExplorationLicencesLayer,
},
    {
      id: 'claims', label: 'Claims & mining tracts', group: 'Mining', minZoom: 11,
      make: () => arcgis(NOVAROC, { showIds: '13,16,17', opacity: 0.7 }),
    },
 {
  id: 'crown', label: 'Crown lands', group: 'Land status', minZoom: 9,
  hint: 'Provincial Crown parcels',
  make: () => arcgis(CROWNLANDS, { showIds: '0', opacity: 0.5 }),
},
{
  id: 'restricted', label: 'Restricted lands (no staking)', group: 'Land status', minZoom: 8,
  make: () => arcgis(NOVAROC, {
    showIds: '23,24,25,26,27,28,29,30,31,32,33',
    opacity: 0.55
  }),
},
{
  id: 'conditional', label: 'Conditional lands (conditional staking)', group: 'Land status', minZoom: 9,
  make: () => arcgis(NOVAROC, {
    showIds: '35,36,37,38,39,40,41',
    opacity: 0.5
  }),
},
{
  id: 'staking', label: 'Designated lands — staking allowed', group: 'Land status', minZoom: 9,
  hint: 'Special land-use areas where mineral staking is permitted',
  make: () => arcgis(NOVAROC, {
    showIds: '43,44,45,46,47,48,49,50,51,52,53,54',
    opacity: 0.5
  }),
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
