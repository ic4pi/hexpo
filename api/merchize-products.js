// Server-side proxy for the Merchize product catalog (t-shirts + accessories).
// Requires MERCHIZE_API_BASE_URL and MERCHIZE_API_TOKEN as Vercel project
// environment variables — never hardcoded here, never sent to the browser.
// See README for setup steps.
//
// The exact endpoint path and response field names depend on your Merchize
// store's bo-api version. MERCHIZE_PRODUCTS_PATH is configurable (defaults
// to '/v1/products'). If products don't show up after deploying, check this
// function's logs in the Vercel dashboard for the raw upstream response and
// adjust PRODUCTS_PATH / the field names read in normalizeProduct() below.

const PRODUCTS_PATH = process.env.MERCHIZE_PRODUCTS_PATH || '/v1/products';

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = firstDefined(raw.id, raw._id, raw.product_id, raw.sku);
  const name = firstDefined(raw.name, raw.title, raw.product_name);
  if (!id || !name) return null;

  const images = raw.images || raw.image_urls || raw.gallery || [];
  const image = firstDefined(
    raw.image, raw.thumbnail, raw.thumb, raw.main_image,
    Array.isArray(images) ? images[0] : undefined
  );

  const variantsRaw = raw.variants || raw.sizes || raw.options || [];
  const sizes = Array.isArray(variantsRaw)
    ? [...new Set(
        variantsRaw
          .map((v) => (typeof v === 'string' ? v : firstDefined(v.size, v.name, v.title)))
          .filter(Boolean)
      )]
    : [];

  const rawPrice = firstDefined(raw.price, raw.retail_price, raw.base_cost);
  const priceCents = firstDefined(
    raw.price_cents,
    typeof rawPrice === 'number' ? Math.round(rawPrice * 100) : undefined
  );

  const category = String(firstDefined(raw.category, raw.product_type, raw.type, 'apparel')).toLowerCase();
  const url = firstDefined(raw.url, raw.product_url, raw.permalink, raw.link);

  return {
    id: String(id),
    name: String(name),
    image: image || null,
    sizes,
    priceCents: typeof priceCents === 'number' && !Number.isNaN(priceCents) ? priceCents : null,
    category: category.includes('access') ? 'accessory' : 'apparel',
    url: url || null,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const baseUrl = process.env.MERCHIZE_API_BASE_URL;
  const token = process.env.MERCHIZE_API_TOKEN;

  if (!baseUrl || !token) {
    console.error('merchize-products: MERCHIZE_API_BASE_URL / MERCHIZE_API_TOKEN not set in Vercel env vars');
    res.status(200).json({ products: [] });
    return;
  }

  try {
    const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}${PRODUCTS_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      console.error('merchize-products: upstream returned', upstream.status, body.slice(0, 500));
      res.status(200).json({ products: [] });
      return;
    }

    const data = await upstream.json();
    const rawList = Array.isArray(data) ? data : data.products || data.data || data.items || [];
    const products = rawList.map(normalizeProduct).filter(Boolean);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ products });
  } catch (err) {
    console.error('merchize-products failed:', err.message);
    res.status(200).json({ products: [] });
  }
};
