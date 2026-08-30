// Shared Merchize bo-api helpers, used by api/merchize-products.js,
// api/create-order-payment-intent.js, and api/webhook.js.
// Requires MERCHIZE_API_BASE_URL and MERCHIZE_API_TOKEN as Vercel project
// environment variables — never hardcoded here, never sent to the browser.
//
// The exact endpoint paths and JSON field names depend on your Merchize
// store's bo-api version and weren't verified against a live account while
// building this (no network access to merchize.com from that environment).
// MERCHIZE_PRODUCTS_PATH / MERCHIZE_ORDERS_PATH are configurable — if
// products don't load or fulfillment orders don't land in Merchize, check
// the relevant function's logs in the Vercel dashboard for the raw
// upstream response and adjust the paths / field names here to match.

const PRODUCTS_PATH = process.env.MERCHIZE_PRODUCTS_PATH || '/v1/products';
const ORDERS_PATH = process.env.MERCHIZE_ORDERS_PATH || '/v1/orders';

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

// Cached per lambda instance so a checkout with several merch items doesn't
// refetch the whole catalog once per item.
let cache = { at: 0, products: null };
const CACHE_MS = 60 * 1000;

async function getMerchizeProducts() {
  const baseUrl = process.env.MERCHIZE_API_BASE_URL;
  const token = process.env.MERCHIZE_API_TOKEN;
  if (!baseUrl || !token) {
    console.error('Merchize: MERCHIZE_API_BASE_URL / MERCHIZE_API_TOKEN not set in Vercel env vars');
    return [];
  }

  if (cache.products && Date.now() - cache.at < CACHE_MS) return cache.products;

  const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}${PRODUCTS_PATH}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    console.error('Merchize products fetch failed:', upstream.status, body.slice(0, 500));
    return cache.products || [];
  }

  const data = await upstream.json();
  const rawList = Array.isArray(data) ? data : data.products || data.data || data.items || [];
  const products = rawList.map(normalizeProduct).filter(Boolean);
  cache = { at: Date.now(), products };
  return products;
}

// Pushes a fulfillment order to Merchize after a Stripe payment succeeds.
// `order` shape is a best-effort guess (email, shipping, line items) — see
// the note at the top of this file about verifying it against your account.
async function createMerchizeOrder(order) {
  const baseUrl = process.env.MERCHIZE_API_BASE_URL;
  const token = process.env.MERCHIZE_API_TOKEN;
  if (!baseUrl || !token) throw new Error('Merchize API not configured (missing env vars)');

  const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}${ORDERS_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
  const text = await upstream.text().catch(() => '');
  if (!upstream.ok) {
    throw new Error(`Merchize order create failed (${upstream.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

module.exports = { getMerchizeProducts, createMerchizeOrder, normalizeProduct };
