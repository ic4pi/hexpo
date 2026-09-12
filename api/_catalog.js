const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/* ── DYNAMIC CATALOG ────────────────────────────────────────────────────
   Products added through /admin are stored as Stripe Products with a
   default Price, tagged metadata.hexposed = '1'.

   Stripe is already the authority for what a customer is charged, so
   keeping the catalog there means the price on the card, the price in the
   bag and the price billed all come from one place and cannot drift —
   which is exactly the bug class that hit the spell jars, the readings and
   the Pizza Arcade sweater.

   The original products still live in the site's own arrays and in the
   hardcoded ID maps. Anything here is additive to those.
── */

const TAG = 'hexposed';

function parseJSON(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

// The three places a product can appear on the storefront. Anything
// unrecognised falls back to a spell jar rather than vanishing.
const KINDS = ['spell', 'apparel', 'reading'];

function shape(p) {
  const price = p.default_price && typeof p.default_price === 'object' ? p.default_price : null;
  return {
    id: p.id,
    name: p.name,
    kind: KINDS.includes(p.metadata.kind) ? p.metadata.kind : 'spell',
    tagline: p.description || '',
    image: (p.images && p.images[0]) || '',
    sizes: parseJSON(p.metadata.sizes, []) || [],
    skus: parseJSON(p.metadata.skus, {}) || {},
    priceId: price ? price.id : '',
    priceCents: price ? price.unit_amount : 0,
    currency: price ? price.currency : 'usd',
    // Readings only: how long the session runs, so the booking calendar
    // can lay it out without the length being hardcoded in the site.
    durationMinutes: Number(p.metadata.duration_minutes) || 0,
  };
}

async function listCatalog() {
  const page = await stripe.products.list({
    limit: 100,
    active: true,
    expand: ['data.default_price'],
  });
  return page.data
    .filter((p) => p.metadata && p.metadata[TAG] === '1')
    .map(shape)
    .filter((p) => p.priceId); // a product with no price cannot be sold
}

// Never let the browser see SKUs — those are fulfilment data, not shopper data.
function publicFields(p) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    tagline: p.tagline,
    image: p.image,
    sizes: p.sizes,
    priceCents: p.priceCents,
    price: `$${(p.priceCents / 100).toFixed(2)}`,
    durationMinutes: p.durationMinutes,
  };
}

async function findByName(name) {
  const all = await listCatalog();
  return all.find((p) => p.name === name) || null;
}

module.exports = { listCatalog, publicFields, findByName, TAG, KINDS };
