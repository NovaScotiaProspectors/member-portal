const { normalizeTenure, fetchTenureGeoJSON } = require('../services/novaRoc');

function registerTenureRoutes(app) {
  app.get('/api/tenure/:number', async (req, res) => {
    try {
      res.json(await fetchTenureGeoJSON(normalizeTenure(req.params.number)));
    } catch (error) {
      console.error(error);
      res.status(error.status || 500).json({
        error: error.status ? error.message : 'Could not fetch tenure location from NovaROC.',
      });
    }
  });
}

module.exports = { registerTenureRoutes };
