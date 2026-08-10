const cheerio = require('cheerio');

function normalizeTenure(value) {
  return String(value || '').trim().toUpperCase();
}

async function fetchNovaRocSearchMetadata(tenureNumber) {
  const searchUrl =
    'https://novaroc.novascotia.ca/novaroc/page/viewer/mineralSearch/searchForm.jsf';
  const params = new URLSearchParams({
    searchType: 'tenure',
    tenureNumber: tenureNumber,
  });

  const response = await fetch(`${searchUrl}?${params.toString()}`);
  if (!response.ok) return {};

  const html = await response.text();
  const $ = cheerio.load(html);
  const rows = [];
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td,th').map((__, cell) => $(cell).text().trim()).get();
    if (cells.length) rows.push(cells);
  });

  let location = '';
  for (const row of rows) {
    const joined = row.join(' ');
    if (/county|district|location/i.test(joined) && row.length >= 2) {
      location = row[row.length - 1];
      break;
    }
  }

  return { location, parsedLocation: parseNovaRocLocation(location) };
}

function parseNovaRocLocation(location) {
  const text = String(location || '').trim();
  if (!text) return {};
  const parts = text.split(/[,;|]/).map(p => p.trim()).filter(Boolean);
  const county = parts.find(p => /county/i.test(p)) || '';
  return {
    raw: text,
    county: county.replace(/\s*county\s*/i, '').trim(),
    area: parts.find(p => p !== county) || '',
  };
}

async function fetchTenureGeoJSON(tenureNumber) {
  const normalized = normalizeTenure(tenureNumber);
  const url = 'https://novarocmaps.novascotia.ca/arcgis/rest/services/NovaRoc/MapServer/1/query';
  const params = new URLSearchParams({
    where: `TENURE_NUMBER_ID='${normalized}'`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });
  const response = await fetch(`${url}?${params.toString()}`);
  const data = await response.json();
  const metadata = await fetchNovaRocSearchMetadata(normalized);

  if (data.error) {
    const err = new Error(data.error.message || 'NovaROC query failed.');
    err.status = 502;
    throw err;
  }
  if (!data.features || data.features.length === 0) {
    const err = new Error(`No NovaROC geometry found for ${normalized}.`);
    err.status = 404;
    throw err;
  }

  return {
    type: 'FeatureCollection',
    features: data.features.map(feature => ({
      type: 'Feature',
      properties: {
        ...feature.attributes,
        location: metadata.location,
        parsedLocation: metadata.parsedLocation,
      },
      geometry: arcgisPolygonToGeoJSON(feature.geometry),
    })),
  };
}

function arcgisPolygonToGeoJSON(geometry) {
  return { type: 'Polygon', coordinates: geometry.rings };
}

module.exports = {
  normalizeTenure,
  fetchTenureGeoJSON,
  parseNovaRocLocation,
  arcgisPolygonToGeoJSON,
};
