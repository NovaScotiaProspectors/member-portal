const EXPLORATION_LICENCES_URL =
  'https://novarocmaps.novascotia.ca/arcgis/rest/services/NovaRoc/MapServer/1/query';

function createExplorationLicenceService() {
  let cache = null;

  async function loadExplorationLicences() {
    if (cache) return cache;

    const allFeatures = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const params = new URLSearchParams({
        where: '1=1',
        outFields: [
          'TENURE_NUMBER_ID',
          'MTA_TITLE_TYPE_CODE',
          'MTA_TENURE_TYPE_CODE',
          'ISSUE_DATE',
          'GOOD_TO_DATE',
          'AREA_IN_HECTARES',
          'TERMINATION_DATE',
          'EXPIRY_DATE',
          'MINERAL_TENURE_STATUS_CODE',
          'OBJECTID'
        ].join(','),
        returnGeometry: 'true',
        outSR: '4326',
        f: 'geojson',
        resultOffset: String(offset),
        resultRecordCount: String(pageSize),
        orderByFields: 'OBJECTID'
      });

      const response = await fetch(`${EXPLORATION_LICENCES_URL}?${params}`);

      if (!response.ok) {
        throw new Error(
          `NovaRoc Exploration Licences service returned ${response.status}.`
        );
      }

      const page = await response.json();

      if (
        !page ||
        page.type !== 'FeatureCollection' ||
        !Array.isArray(page.features)
      ) {
        const error = new Error(
          'NovaRoc Exploration Licences service did not return valid GeoJSON.'
        );
        error.code = 'BAD_EXPLORATION_LICENCES';
        throw error;
      }

      allFeatures.push(...page.features);

      if (page.features.length < pageSize) break;

      offset += pageSize;
    }

    const data = {
      type: 'FeatureCollection',
      features: allFeatures
    };

    cache = data;
    return cache;
  }

  return { loadExplorationLicences };
}

module.exports = { createExplorationLicenceService };
