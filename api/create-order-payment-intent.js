const Stripe = require('stripe');
const { findByName } = require('./_catalog');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Product name -> what a jar costs, in cents. Every jar is $22.
//
// These were priced from Stripe Price IDs until now. That went wrong: the
// storefront moved to $22 in September, but a Stripe Price object is
// immutable, so those IDs still held the launch amounts ($28.99 / $19.99 /
// $34.99). The card said $22 and checkout billed the old price. Replacing
// a Price can only be done from the Stripe dashboard, which this code
// cannot reach, so the amount it charges lives here instead.
//
// This is still server-side, so a price sent from the browser is never
// trusted — that property came from computing the total here, not from
// where the number was read.
//
// Keep in step with SPELL_PRICE_CENTS in index.html (display-only) and
// with the Price objects in the Stripe dashboard, so the receipt, the
// dashboard and the card all read the same.
const SPELL_PRICE_CENTS = {
  'Love Spell No. 4': 2200,
  'Protection Spell': 2200,
  'Success Spell': 2200,
};

// Apparel is sold here, not on a Merchize storefront — Merchize's hosted
// store is their paid product, while fulfillment is free. So the sweater
// is priced here exactly like a spell jar, and api/webhook.js hands the
// paid order to Merchize to print and ship.
//
// In cents, for the same reason as the jars above: a Stripe Price object
// is immutable, so anything priced through one silently keeps charging
// whatever it was created with, however often the card is edited. Nothing
// in the built-in catalog depends on a Price object any more.
//
// `default` covers every size at one price. Add a size key alongside it
// (e.g. '2XL': 5200) only if you charge more for that size.
const APPAREL_PRICE_CENTS = {
  'Occupied Skies Ugly Sweater': {
    default: 4400,
  },
  'Pizza Arcade Ugly Sweater': {
    default: 4400,
  },
};

const APPAREL_SIZES = {
  'Occupied Skies Ugly Sweater': ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'],
  'Pizza Arcade Ugly Sweater': ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'],
};

function apparelCents(name, size) {
  const entry = APPAREL_PRICE_CENTS[name];
  if (!entry) return 0;
  return entry[size] || entry.default || 0;
}

// ── SHIPPING ──
// Spell jars are packed and shipped by hand, so they carry a shipping
// charge. Apparel does not: the print partner's fulfillment cost is
// already inside the garment price.
//
// Free shipping once the order subtotal reaches the threshold — three
// jars at $22 hits $66 exactly, which is the intended trigger.
//
// TODO(capi): SPELL_SHIPPING_CENTS is a placeholder flat rate. Replace it
// with your real rate (or a calculated rate) before this goes live.
const SPELL_SHIPPING_CENTS = 600;
const FREE_SHIPPING_THRESHOLD_CENTS = 6600;

function shippingCents(subtotal, hasSpellItems) {
  if (!hasSpellItems) return 0;
  if (subtotal >= FREE_SHIPPING_THRESHOLD_CENTS) return 0;
  return SPELL_SHIPPING_CENTS;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { items, email, shipping } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Your bag is empty' });
    return;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  if (
    !shipping ||
    !shipping.name ||
    !shipping.line1 ||
    !shipping.city ||
    !shipping.state ||
    !shipping.postal_code ||
    !shipping.country
  ) {
    res.status(400).json({ error: 'A complete shipping address is required' });
    return;
  }

  let amount = 0;
  let currency = 'usd';
  const lineItems = [];
  // Apparel needs to survive into the webhook so it can be pushed to
  // Merchize for printing — spell jars you pack and ship yourself.
  const apparelItems = [];
  let hasSpellItems = false;
  try {
    for (const item of items) {
      const name = item && item.name;
      const size = item && item.size;
      const qty = Number(item && item.qty);
      const isApparel = Boolean(APPAREL_PRICE_CENTS[name]);
      // Only a jar from the map below is known to be a spell here. A product
      // added through /admin sets this from its own kind further down —
      // assuming "not apparel means spell" would bill shipping on an
      // apparel-only order.
      if (SPELL_PRICE_CENTS[name]) hasSpellItems = true;

      if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        res.status(400).json({ error: 'Invalid item in bag' });
        return;
      }

      // Products added through /admin live in Stripe, not in the maps above.
      // Look them up by name and take their own price and size list.
      if (!isApparel && !SPELL_PRICE_CENTS[name]) {
        const dynamic = await findByName(name);
        if (dynamic) {
          if (dynamic.sizes.length) {
            if (!dynamic.sizes.includes(size)) {
              res.status(400).json({ error: 'Pick a size for ' + name });
              return;
            }
          }
          const dp = await stripe.prices.retrieve(dynamic.priceId);
          amount += dp.unit_amount * qty;
          currency = dp.currency;
          lineItems.push(size ? `${name} [${size}] x${qty}` : `${name} x${qty}`);
          if (dynamic.kind === 'apparel') apparelItems.push({ name, size, qty });
          else hasSpellItems = true;
          continue;
        }
      }

      if (!isApparel) {
        const jarCents = SPELL_PRICE_CENTS[name];
        if (!jarCents) {
          res.status(400).json({ error: 'Invalid item in bag' });
          return;
        }
        amount += jarCents * qty;
        lineItems.push(`${name} x${qty}`);
        continue;
      }

      if (!(APPAREL_SIZES[name] || []).includes(size)) {
        res.status(400).json({ error: 'Pick a size for ' + name });
        return;
      }
      const unitCents = apparelCents(name, size);
      if (!unitCents) {
        res.status(400).json({ error: name + ' isn\u2019t available for purchase yet.' });
        return;
      }

      amount += unitCents * qty;
      lineItems.push(`${name} [${size}] x${qty}`);
      apparelItems.push({ name, size, qty });
    }
  } catch (err) {
    console.error('create-order-payment-intent price lookup failed:', err.message);
    res.status(500).json({ error: 'Could not price your bag. Please try again.' });
    return;
  }

  const subtotal = amount;
  const shippingAmount = shippingCents(subtotal, hasSpellItems);
  amount += shippingAmount;
  if (shippingAmount > 0) lineItems.push(`Shipping $${(shippingAmount / 100).toFixed(2)}`);

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      receipt_email: email,
      automatic_payment_methods: { enabled: true },
      shipping: {
        name: shipping.name,
        address: {
          line1: shipping.line1,
          line2: shipping.line2 || undefined,
          city: shipping.city,
          state: shipping.state,
          postal_code: shipping.postal_code,
          country: shipping.country,
        },
      },
      metadata: {
        kind: 'spell_order',
        order_email: email,
        items: lineItems.join('; ').slice(0, 500),
        // Read back by api/webhook.js to place the Merchize order. Stripe
        // caps a metadata value at 500 chars; short keys keep a realistic
        // apparel order well inside that.
        apparel: apparelItems.length
          ? JSON.stringify(apparelItems.map((a) => ({ n: a.name, s: a.size, q: a.qty }))).slice(0, 500)
          : '',
      },
    });
    res.status(200).json({ clientSecret: paymentIntent.client_secret, amount });
  } catch (err) {
    console.error('create-order-payment-intent failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
};
