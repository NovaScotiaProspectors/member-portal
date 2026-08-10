const fs = require('fs/promises');

function createMineralOccurrenceService({ geojsonPath }) {
  let cache = null;

  async function loadMineralOccurrences() {
    if (cache) return cache;
    const raw = await fs.readFile(geojsonPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      const err = new Error('Mineral occurrences file must be a GeoJSON FeatureCollection.');
      err.code = 'BAD_OCCURRENCES';
      throw err;
    }
    cache = data;
    return cache;
  }

  return { loadMineralOccurrences };
}

module.exports = { createMineralOccurrenceService };
