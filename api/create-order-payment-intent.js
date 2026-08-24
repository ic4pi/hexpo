const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Source of truth for spell jar prices — must stay in sync with
// SPELL_PRICE_CENTS in index.html (that copy is display-only; this one is
// what actually gets charged, since client-sent amounts can't be trusted).
const SPELL_PRICES_CENTS = {
  'Love Spell No. 4': 2899,
  'Protection Spell': 1999,
  'Success Spell': 3499,
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
  const lineItems = [];
  for (const item of items) {
    const unitPrice = SPELL_PRICES_CENTS[item && item.name];
    const qty = Number(item && item.qty);
    if (!unitPrice || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      res.status(400).json({ error: 'Invalid item in bag' });
      return;
    }
    amount += unitPrice * qty;
    lineItems.push(`${item.name} x${qty}`);
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
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
      },
    });
    res.status(200).json({ clientSecret: paymentIntent.client_secret, amount });
  } catch (err) {
    console.error('create-order-payment-intent failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
};
