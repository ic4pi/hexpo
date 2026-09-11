const { listCatalog, publicFields } = require('./_catalog');

/* Public, read-only list of products added through /admin, for the
   storefront to render alongside the ones defined in index.html.
   Only shopper-facing fields are returned — SKUs and Stripe price IDs
   stay server-side. */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(200).json({ products: [] });
    return;
  }
  try {
    const products = (await listCatalog()).map(publicFields);
    // Short cache: new products should show up quickly, but a burst of
    // shoppers shouldn't each hit the Stripe API.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ products });
  } catch (err) {
    console.error('products list failed:', err.message);
    // The storefront falls back to its built-in products, so a failure here
    // must never take the shop down.
    res.status(200).json({ products: [] });
  }
};
