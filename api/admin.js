const crypto = require('crypto');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/* ── ADMIN API ──────────────────────────────────────────────────────────
   One function handling every dashboard action, selected by ?action=.
   Kept as a single endpoint because each file under api/ is a separate
   serverless function, and this is one logical surface.

   The password lives ONLY in the ADMIN_PASSWORD environment variable, set
   in the Vercel dashboard. It is never written into this repository (which
   is public) and never sent to the browser. The browser holds a signed,
   expiring token instead — so the password crosses the wire exactly once,
   at login.
── */

const SESSION_HOURS = 12;

function adminSecret() {
  return process.env.ADMIN_PASSWORD || '';
}

// Constant-time compare. Hash both sides first so differing lengths don't
// throw and don't leak length through timing.
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payload) {
  return crypto.createHmac('sha256', adminSecret()).update(payload).digest('base64url');
}

function issueToken() {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = String(expires);
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function tokenValid(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [encoded, mac] = token.split('.');
  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString();
  } catch (_) {
    return false;
  }
  const expected = sign(payload);
  // Same length by construction (both base64url HMAC-SHA256), but compare
  // through hashes anyway so a malformed mac can't throw.
  if (!sameSecret(mac, expected)) return false;
  const expires = Number(payload);
  return Number.isFinite(expires) && Date.now() < expires;
}

function authed(req) {
  const header = req.headers.authorization || '';
  return tokenValid(header.replace(/^Bearer\s+/i, ''));
}

/* ── Stripe reads ── */

// PaymentIntents carry both readings and shop orders, told apart by
// metadata.kind. Listing and filtering here rather than using Stripe's
// search API, which is eventually consistent and would hide an order that
// was placed a minute ago.
async function recentIntents(limit = 300) {
  const out = [];
  let startingAfter;
  while (out.length < limit) {
    const page = await stripe.paymentIntents.list({
      limit: Math.min(100, limit - out.length),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

function money(cents, currency) {
  return { cents: cents || 0, display: `$${((cents || 0) / 100).toFixed(2)}`, currency: currency || 'usd' };
}

function shapeOrder(pi) {
  return {
    id: pi.id,
    created: pi.created * 1000,
    status: pi.status,
    paid: pi.status === 'succeeded',
    amount: money(pi.amount, pi.currency),
    email: pi.metadata.order_email || pi.receipt_email || '',
    items: pi.metadata.items || '',
    apparel: pi.metadata.apparel || '',
    shipping: pi.shipping
      ? {
          name: pi.shipping.name,
          line1: pi.shipping.address && pi.shipping.address.line1,
          line2: (pi.shipping.address && pi.shipping.address.line2) || '',
          city: pi.shipping.address && pi.shipping.address.city,
          state: pi.shipping.address && pi.shipping.address.state,
          postal: pi.shipping.address && pi.shipping.address.postal_code,
          country: pi.shipping.address && pi.shipping.address.country,
        }
      : null,
  };
}

function shapeBooking(pi) {
  const startMs = Number(pi.metadata.slot_start_ms);
  return {
    id: pi.id,
    created: pi.created * 1000,
    status: pi.status,
    paid: pi.status === 'succeeded',
    amount: money(pi.amount, pi.currency),
    reading: pi.metadata.reading || '',
    email: pi.metadata.zoom_email || pi.receipt_email || '',
    question: pi.metadata.question || '',
    slotStart: Number.isFinite(startMs) ? startMs : null,
    slotEnd: Number(pi.metadata.slot_end_ms) || null,
    slotLabel: pi.metadata.slot_shop_time || '',
    timezone: pi.metadata.slot_timezone || '',
    upcoming: Number.isFinite(startMs) && startMs > Date.now(),
  };
}

/* ── Products ──
   Products added through the dashboard are stored in Stripe itself: a
   Stripe Product plus a default Price, tagged with metadata.hexposed so
   the storefront can pick them out. Stripe is already the authority for
   what a customer is charged, so keeping the catalog there is what stops
   the displayed price and the charged price drifting apart.
── */

const TAG = 'hexposed';

function shapeProduct(p) {
  const price = p.default_price && typeof p.default_price === 'object' ? p.default_price : null;
  let sizes = [];
  try {
    sizes = p.metadata.sizes ? JSON.parse(p.metadata.sizes) : [];
  } catch (_) {
    sizes = [];
  }
  let skus = {};
  try {
    skus = p.metadata.skus ? JSON.parse(p.metadata.skus) : {};
  } catch (_) {
    skus = {};
  }
  return {
    id: p.id,
    name: p.name,
    active: p.active,
    kind: p.metadata.kind || 'spell',
    tagline: p.description || '',
    image: (p.images && p.images[0]) || '',
    sizes,
    skus,
    priceId: price ? price.id : '',
    amount: price ? money(price.unit_amount, price.currency) : money(0),
    durationMinutes: Number(p.metadata.duration_minutes) || 0,
  };
}

async function listProducts() {
  const page = await stripe.products.list({ limit: 100, active: true, expand: ['data.default_price'] });
  return page.data.filter((p) => p.metadata && p.metadata[TAG] === '1').map(shapeProduct);
}

// Merchize shows two SKUs per size: this listing's own variant code and the
// generic blank-garment code shared by every seller on that base product.
// Pasting the dashboard block straight in is far quicker than typing eight
// sizes by hand, so accept it verbatim and pull out the listing's own codes
// — using the blank code would risk printing an undecorated garment.
function parseSkuBlock(text) {
  if (typeof text !== 'string' || !text.trim()) return {};
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out = {};
  let pendingSku = null;
  for (const line of lines) {
    const skuMatch = line.match(/^SKU:\s*(\S+)/i);
    if (skuMatch) {
      const code = skuMatch[1];
      // Own variant codes look like 1C-XXXX-<listing>-<variant>; the blank
      // garment codes are a single run of letters and digits.
      if (/-/.test(code)) pendingSku = code;
      continue;
    }
    const sizeMatch = line.match(/^size:\s*(\S+)/i);
    if (sizeMatch && pendingSku) {
      out[sizeMatch[1].toUpperCase()] = pendingSku;
      pendingSku = null;
    }
  }
  return out;
}

// Which storefront section the product lands in. These are the three
// grids on the site, and the value decides where the card is rendered and
// how it is bought — a jar and a sweater go through the bag, a reading
// goes through the booking calendar.
const KINDS = ['spell', 'apparel', 'reading'];

// Only apparel printed by Merchize has SKUs. A jar you pack yourself or a
// reading you deliver over Zoom has nothing to print, so there is nothing
// to look up, and asking for one would be asking for a number that does
// not exist.
function takesSkus(kind) {
  return kind === 'apparel';
}

async function createProduct(body) {
  const name = String(body.name || '').trim();
  const kind = KINDS.includes(body.kind) ? body.kind : 'spell';
  const image = String(body.image || '').trim();
  const tagline = String(body.tagline || '').slice(0, 300);
  const givenPriceId = String(body.priceId || '').trim();

  if (!name) return { error: 'Name is required' };
  if (givenPriceId && !/^price_[A-Za-z0-9]+$/.test(givenPriceId)) {
    return { error: 'A Stripe Price ID looks like price_1ABC… — check that one.' };
  }

  const sizes = Array.isArray(body.sizes) ? body.sizes.filter((s) => typeof s === 'string' && s) : [];
  const skus = takesSkus(kind) ? parseSkuBlock(body.skuBlock || '') : {};

  // A reading is booked into a calendar, so its length has to be known
  // before a slot can be offered. Default to an hour if none is given.
  const duration = kind === 'reading' ? Math.round(Number(body.durationMinutes)) || 60 : 0;
  if (kind === 'reading' && (duration < 15 || duration > 240)) {
    return { error: 'A reading runs between 15 and 240 minutes.' };
  }

  const metadata = {
    [TAG]: '1',
    kind,
    sizes: JSON.stringify(sizes).slice(0, 500),
    skus: JSON.stringify(skus).slice(0, 500),
    duration_minutes: duration ? String(duration) : '',
  };

  // Connecting an existing price. The Price already belongs to a Stripe
  // product, and a Price cannot be moved between products — so the thing
  // to do is adopt the product it is already on rather than make a second
  // one that would sit alongside it in the dashboard as a duplicate.
  if (givenPriceId) {
    let price;
    try {
      price = await stripe.prices.retrieve(givenPriceId);
    } catch (_) {
      return { error: 'No Stripe price with that ID. Copy it from the price, not the product.' };
    }
    if (price.active === false) {
      return { error: 'That price is archived in Stripe. Pick an active one.' };
    }
    if (!price.unit_amount) {
      return { error: 'That price has no fixed amount, so the site cannot show a price on the card.' };
    }
    const productId = typeof price.product === 'string' ? price.product : price.product.id;
    const updated = await stripe.products.update(productId, {
      name,
      description: tagline || undefined,
      images: image ? [image] : undefined,
      default_price: price.id,
      metadata,
    });
    return {
      product: shapeProduct({ ...updated, default_price: price }),
      skusParsed: Object.keys(skus).length,
      connected: true,
    };
  }

  // No price given, so make one. This is the common path.
  const cents = Math.round(Number(body.priceCents));
  if (!Number.isInteger(cents) || cents < 50) {
    return { error: 'Enter a price of at least $0.50, or paste an existing Stripe Price ID.' };
  }

  const product = await stripe.products.create({
    name,
    description: tagline || undefined,
    images: image ? [image] : undefined,
    metadata,
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: cents,
    currency: 'usd',
  });
  await stripe.products.update(product.id, { default_price: price.id });

  return {
    product: shapeProduct({ ...product, default_price: price }),
    skusParsed: Object.keys(skus).length,
    connected: false,
  };
}

/* ── Handler ── */

module.exports = async (req, res) => {
  if (!adminSecret()) {
    res.status(503).json({ error: 'ADMIN_PASSWORD is not set on this deployment.' });
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(503).json({ error: 'STRIPE_SECRET_KEY is not set on this deployment.' });
    return;
  }

  const action = String((req.query && req.query.action) || '');

  if (action === 'login') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    const supplied = (req.body && req.body.password) || '';
    if (!supplied || !sameSecret(supplied, adminSecret())) {
      // Slow a guessing loop down a little without holding the function open.
      await new Promise((r) => setTimeout(r, 600));
      res.status(401).json({ error: 'Wrong password' });
      return;
    }
    res.status(200).json({ token: issueToken(), expiresInHours: SESSION_HOURS });
    return;
  }

  if (!authed(req)) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  try {
    if (action === 'summary') {
      const intents = await recentIntents();
      const orders = intents.filter((p) => p.metadata.kind === 'spell_order').map(shapeOrder);
      const bookings = intents.filter((p) => p.metadata.kind === 'reading').map(shapeBooking);
      const paidOrders = orders.filter((o) => o.paid);
      const paidBookings = bookings.filter((b) => b.paid);
      const revenue =
        paidOrders.reduce((s, o) => s + o.amount.cents, 0) +
        paidBookings.reduce((s, b) => s + b.amount.cents, 0);
      const thirtyDays = Date.now() - 30 * 24 * 3600 * 1000;
      res.status(200).json({
        revenueAll: money(revenue),
        revenue30: money(
          [...paidOrders, ...paidBookings]
            .filter((x) => x.created >= thirtyDays)
            .reduce((s, x) => s + x.amount.cents, 0)
        ),
        orderCount: paidOrders.length,
        bookingCount: paidBookings.length,
        upcomingCount: paidBookings.filter((b) => b.upcoming).length,
        abandoned: orders.filter((o) => !o.paid).length + bookings.filter((b) => !b.paid).length,
      });
      return;
    }

    if (action === 'orders') {
      const intents = await recentIntents();
      res.status(200).json({
        orders: intents
          .filter((p) => p.metadata.kind === 'spell_order')
          .map(shapeOrder)
          .sort((a, b) => b.created - a.created),
      });
      return;
    }

    if (action === 'bookings') {
      const intents = await recentIntents();
      const bookings = intents
        .filter((p) => p.metadata.kind === 'reading')
        .map(shapeBooking)
        .sort((a, b) => (b.slotStart || b.created) - (a.slotStart || a.created));
      res.status(200).json({ bookings });
      return;
    }

    if (action === 'products') {
      res.status(200).json({ products: await listProducts() });
      return;
    }

    if (action === 'create-product') {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const result = await createProduct(req.body || {});
      if (result.error) {
        res.status(400).json(result);
        return;
      }
      res.status(200).json(result);
      return;
    }

    if (action === 'archive-product') {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const id = String((req.body && req.body.id) || '');
      if (!id.startsWith('prod_')) {
        res.status(400).json({ error: 'Bad product id' });
        return;
      }
      await stripe.products.update(id, { active: false });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(404).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('admin action failed:', action, err.message);
    res.status(500).json({ error: 'That request failed. Check the function logs.' });
  }
};

module.exports.parseSkuBlock = parseSkuBlock;
