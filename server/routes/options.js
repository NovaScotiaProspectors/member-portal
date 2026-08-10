function registerOptionRoutes(app, ctx) {
  const { getCommodities, getDepositTypes } = ctx;

  app.get('/api/commodities', async (req, res) => {
    try {
      res.json(await getCommodities());
    } catch (error) {
      console.error('commodities:', error.message);
      res.status(502).json({ error: error.message });
    }
  });

  app.get('/api/deposit-types', async (req, res) => {
    try {
      res.json(await getDepositTypes());
    } catch (error) {
      console.error('deposit-types:', error.message);
      res.status(502).json({ error: error.message });
    }
  });
}

module.exports = { registerOptionRoutes };
