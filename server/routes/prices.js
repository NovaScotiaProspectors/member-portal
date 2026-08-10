function registerPriceRoutes(app, { getMetalPrices }) {
  app.get('/api/metal-prices', async (req, res) => {
    try {
      res.json(await getMetalPrices());
    } catch (error) {
      console.error('metal-prices:', error.message);
      res.status(502).json({ error: 'Could not load metal prices.' });
    }
  });
}

module.exports = { registerPriceRoutes };
