const Stripe = require('stripe');
const { getMerchizeProducts } = require('../lib/merchize');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Spell jar name -> Stripe Price ID. Amounts are fetched live from Stripe
// (via prices.retrieve below) rather than hardcoded, so a client-sent
// price can never be trusted or tampered with — Stripe is the one source
// of truth for what each jar actually costs.
const SPELL_PRICE_IDS = {
  'Love Spell No. 4': 'price_1U87I5ALwINGiotH4ii8KNGn',
  'Protection Spell': 'price_1U87PyALwINGiotHkVyXIvDl',
  'Success Spell': 'price_1U87TVALwINGiotHQTp8Sxkv',
};

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
  // Merch line items (id/size/qty only) get handed to the webhook via
  // metadata so it can push a fulfillment order to Merchize once payment
  // actually succeeds — never before.
  const merchLines = [];
  let merchProducts = null;

  try {
    for (const item of items) {
      const qty = Number(item && item.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        res.status(400).json({ error: 'Invalid item in bag' });
        return;
      }

      if (item && item.type === 'merch') {
        if (!merchProducts) merchProducts = await getMerchizeProducts();
        const product = merchProducts.find((p) => p.id === String(item.id));
        if (!product || typeof product.priceCents !== 'number') {
          res.status(400).json({ error: 'One of the apparel items is no longer available' });
          return;
        }
        const size = typeof item.size === 'string' ? item.size : '';
        if (product.sizes.length && !product.sizes.includes(size)) {
          res.status(400).json({ error: `Invalid size for ${product.name}` });
          return;
        }
        amount += product.priceCents * qty;
        lineItems.push(`${product.name}${size ? ` (${size})` : ''} x${qty}`);
        merchLines.push({ id: product.id, name: product.name, size, qty });
      } else {
        const priceId = SPELL_PRICE_IDS[item && item.name];
        if (!priceId) {
          res.status(400).json({ error: 'Invalid item in bag' });
          return;
        }
        const price = await stripe.prices.retrieve(priceId);
        amount += price.unit_amount * qty;
        currency = price.currency;
        lineItems.push(`${item.name} x${qty}`);
      }
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
        kind: 'order',
        order_email: email,
        items: lineItems.join('; ').slice(0, 500),
        merch_items: merchLines.length ? JSON.stringify(merchLines).slice(0, 500) : '',
      },
    });
    res.status(200).json({ clientSecret: paymentIntent.client_secret, amount });
  } catch (err) {
    console.error('create-order-payment-intent failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
};
