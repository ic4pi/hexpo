const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Reading name -> Stripe Price ID. The amount actually charged is fetched
// live from Stripe (via prices.retrieve below), never hardcoded here — so
// the price shown in your Stripe dashboard is always the price charged.
const READING_PRICE_IDS = {
  'Celtic Cross Reading': 'price_1U8889ALwINGiotHjAdUC9Rr',
  'Past · Present · Path': 'price_1U87gYALwINGiotH1RYIF6Ns',
  // 'Two Steps Between': 'price_...'  ← no Price ID given yet. Create a
  // $99.00 one-time Price in Stripe for this reading and paste its ID
  // here — until then this reading's checkout will show an error.
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { reading, email, question } = req.body || {};
  const priceId = READING_PRICE_IDS[reading];

  if (!priceId) {
    res.status(400).json({ error: 'This reading isn’t available for checkout yet.' });
    return;
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }

  try {
    const price = await stripe.prices.retrieve(priceId);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: price.unit_amount,
      currency: price.currency,
      receipt_email: email,
      automatic_payment_methods: { enabled: true },
      metadata: {
        kind: 'reading',
        reading,
        zoom_email: email,
        question: typeof question === 'string' ? question.slice(0, 500) : '',
      },
    });
    res.status(200).json({ clientSecret: paymentIntent.client_secret, amount: price.unit_amount });
  } catch (err) {
    console.error('create-payment-intent failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
};
