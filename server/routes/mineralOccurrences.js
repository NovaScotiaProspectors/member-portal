function registerMineralOccurrenceRoutes(app, { mineralOccurrences }) {
  app.get('/api/mineral-occurrences/meta', async (req, res) => {
    try {
      const data = await mineralOccurrences.loadMineralOccurrences();
      res.json({
        available: true,
        count: data.features.length,
        updatedAt: null,
        sourceFile: 'data/reference/mineral-occurrences.geojson',
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.json({
          available: false,
          count: 0,
          sourceFile: 'data/reference/mineral-occurrences.geojson',
          hint: 'Import the MEB occurrence dataset as GeoJSON at data/reference/mineral-occurrences.geojson.',
        });
      }
      console.error('mineral occurrences meta:', error.message);
      res.status(500).json({ available: false, error: error.message });
    }
  });

  app.get('/api/mineral-occurrences', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json(await mineralOccurrences.loadMineralOccurrences());
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Mineral occurrences dataset has not been imported.' });
      }
      console.error('mineral occurrences:', error.message);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerMineralOccurrenceRoutes };
