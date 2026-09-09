const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Product name -> Stripe Price ID. Amounts are fetched live from Stripe
// (via prices.retrieve below) rather than hardcoded, so a client-sent
// price can never be trusted or tampered with — Stripe is the one source
// of truth for what each jar actually costs.
const SPELL_PRICE_IDS = {
  'Love Spell No. 4': 'price_1U87I5ALwINGiotH4ii8KNGn',
  'Protection Spell': 'price_1U87PyALwINGiotHkVyXIvDl',
  'Success Spell': 'price_1U87TVALwINGiotHQTp8Sxkv',
};

// Apparel is sold here, not on a Merchize storefront — Merchize's hosted
// store is their paid product, while fulfillment is free. So the shirt is
// priced in Stripe exactly like a spell jar, and api/webhook.js hands the
// paid order to Merchize to print and ship.
//
// `default` covers every size at one price. Add a size key alongside it
// (e.g. '2XL': 'price_...') only if you charge more for that size.
const APPAREL_PRICE_IDS = {
  'Occupied Skies Ugly Sweater': {
    default: 'price_1UDbp3ALwINGiotHWI1JKHRx',
  },
};

const APPAREL_SIZES = {
  'Occupied Skies Ugly Sweater': ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'],
};

function apparelPriceId(name, size) {
  const entry = APPAREL_PRICE_IDS[name];
  if (!entry) return '';
  return entry[size] || entry.default || '';
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
  try {
    for (const item of items) {
      const name = item && item.name;
      const size = item && item.size;
      const qty = Number(item && item.qty);
      const isApparel = Boolean(APPAREL_PRICE_IDS[name]);

      if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        res.status(400).json({ error: 'Invalid item in bag' });
        return;
      }

      let priceId;
      if (isApparel) {
        if (!(APPAREL_SIZES[name] || []).includes(size)) {
          res.status(400).json({ error: 'Pick a size for ' + name });
          return;
        }
        priceId = apparelPriceId(name, size);
        if (!priceId) {
          res.status(400).json({ error: name + ' isn\u2019t available for purchase yet.' });
          return;
        }
      } else {
        priceId = SPELL_PRICE_IDS[name];
      }

      if (!priceId) {
        res.status(400).json({ error: 'Invalid item in bag' });
        return;
      }

      const price = await stripe.prices.retrieve(priceId);
      amount += price.unit_amount * qty;
      currency = price.currency;
      lineItems.push(isApparel ? `${name} [${size}] x${qty}` : `${name} x${qty}`);
      if (isApparel) apparelItems.push({ name, size, qty });
    }
  } catch (err) {
    console.error('create-order-payment-intent price lookup failed:', err.message);
    res.status(500).json({ error: 'Could not price your bag. Please try again.' });
    return;
  }

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
