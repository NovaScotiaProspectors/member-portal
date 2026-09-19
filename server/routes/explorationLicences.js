function registerExplorationLicenceRoutes(app, { explorationLicences }) {
  app.get('/api/exploration-licences/meta', async (req, res) => {
    try {
      const data = await explorationLicences.loadExplorationLicences();

      res.json({
        available: true,
        count: data.features.length,
        source: 'NovaRoc Exploration Licences',
      });
    } catch (error) {
      console.error('exploration licences meta:', error.message);
      res.status(500).json({
        available: false,
        count: 0,
        error: error.message,
      });
    }
  });

  app.get('/api/exploration-licences', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json(await explorationLicences.loadExplorationLicences());
    } catch (error) {
      console.error('exploration licences:', error.message);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerExplorationLicenceRoutes };
