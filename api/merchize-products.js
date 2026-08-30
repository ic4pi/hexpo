// Returns the live Merchize product catalog (t-shirts + accessories) for
// index.html to render. All the actual Merchize API logic lives in
// lib/merchize.js, shared with the checkout + fulfillment functions.

const { getMerchizeProducts } = require('../lib/merchize');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const products = await getMerchizeProducts();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ products });
  } catch (err) {
    console.error('merchize-products failed:', err.message);
    res.status(200).json({ products: [] });
  }
};
