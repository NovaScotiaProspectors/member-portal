const MINERAL_OCCURRENCES_URL =
  'https://dawson.novascotia.ca/arcgis/rest/services/Hosted/mineral_occurrence_database_d002ns_UT83/FeatureServer/1/query';

function createMineralOccurrenceService() {
  let cache = null;

  async function loadMineralOccurrences() {
    if (cache) return cache;

    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'occ_num,name,occ_type,status,comm_prim,comm_list,county,lat_wm84dd,lon_wm84dd',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson'
    });

    const response = await fetch(`${MINERAL_OCCURRENCES_URL}?${params}`);

    if (!response.ok) {
      throw new Error(`Nova Scotia Mineral Occurrence service returned ${response.status}.`);
    }

    const data = await response.json();

    if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      const err = new Error('Nova Scotia Mineral Occurrence service did not return valid GeoJSON.');
      err.code = 'BAD_OCCURRENCES';
      throw err;
    }

    // Map the official Nova Scotia fields to the property names
    // already expected by the NSPA map and its pop-ups.
    data.features.forEach(feature => {
      const p = feature.properties || {};

      feature.properties = {
        ...p,
        ID: p.occ_num,
        Name: p.name,
        Commodity: p.comm_prim || p.comm_list,
        Status: p.status,
        Type: p.occ_type
      };
    });

    cache = data;
    return cache;
  }

  return { loadMineralOccurrences };
}

module.exports = { createMineralOccurrenceService };
