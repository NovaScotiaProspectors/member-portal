const DEFAULT_BASE_URL = 'https://api.metalpriceapi.com/v1';

const PRICE_SYMBOLS = [
  { key: 'gold',      name: 'Gold',      symbol: 'XAU', unit: 'per troy oz', category: 'Precious' },
  { key: 'silver',    name: 'Silver',    symbol: 'XAG', unit: 'per troy oz', category: 'Precious' },
  { key: 'platinum',  name: 'Platinum',  symbol: 'XPT', unit: 'per troy oz', category: 'Precious' },
  { key: 'palladium', name: 'Palladium', symbol: 'XPD', unit: 'per troy oz', category: 'Precious' },
];

function createMetalPriceService({
  apiKey = process.env.METALPRICE_API_KEY,
  baseUrl = process.env.METALPRICE_API_BASE_URL || DEFAULT_BASE_URL,
} = {}) {
  function getMetalpriceApiUrl(endpoint) {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/${endpoint}`);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('base', 'USD');
    url.searchParams.set('currencies', PRICE_SYMBOLS.map(m => m.symbol).join(','));
    return url;
  }

  function getUsdPrice(rates, symbol) {
    const direct = rates && rates[`USD${symbol}`];
    if (typeof direct === 'number') return direct;

    const reciprocal = rates && rates[symbol];
    if (typeof reciprocal === 'number' && reciprocal !== 0) return 1 / reciprocal;

    return null;
  }

  async function fetchMetalpriceRates(endpoint) {
    if (!apiKey) {
      throw new Error('METALPRICE_API_KEY is not set.');
    }

    const res = await fetch(getMetalpriceApiUrl(endpoint), {
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
    });

    if (!res.ok) {
      throw new Error(`MetalpriceAPI ${endpoint} HTTP ${res.status}`);
    }

    const json = await res.json();
    if (!json.success) {
      const info = getMetalpriceErrorMessage(json);
      throw new Error(`MetalpriceAPI ${endpoint}: ${info}`);
    }
    if (!json.rates || typeof json.rates !== 'object') {
      throw new Error(`MetalpriceAPI ${endpoint}: missing rates`);
    }

    return json;
  }

  async function loadMetalPrices() {
    const latest = await fetchMetalpriceRates('latest');

    const metals = PRICE_SYMBOLS.map((m) => {
      try {
        const price = getUsdPrice(latest.rates, m.symbol);
        if (typeof price !== 'number') throw new Error(`No price for ${m.symbol}`);

        return {
          ...m,
          price,
          currency: latest.base || 'USD',
          change: null,
          changePct: null,
          ok: true,
        };
      } catch (error) {
        return { ...m, ok: false, error: error.message };
      }
    });

    return {
      updatedAt: latest.timestamp ? new Date(latest.timestamp * 1000).toISOString() : new Date().toISOString(),
      metals,
    };
  }

  return { loadMetalPrices };
}

function getMetalpriceErrorMessage(json) {
  if (!json || typeof json !== 'object') return 'request failed';
  if (typeof json.message === 'string') return json.message;
  if (typeof json.info === 'string') return json.info;
  if (typeof json.error === 'string') return json.error;
  if (json.error && typeof json.error === 'object') {
    const parts = [];
    if (json.error.code !== undefined) parts.push(`code ${json.error.code}`);
    if (json.error.type) parts.push(json.error.type);
    if (json.error.info) parts.push(json.error.info);
    if (json.error.message) parts.push(json.error.message);
    if (parts.length) return parts.join(': ');
  }
  return JSON.stringify(json);
}

module.exports = { createMetalPriceService };
