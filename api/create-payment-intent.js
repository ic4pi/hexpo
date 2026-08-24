const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Prices are looked up server-side by reading name — never trust an amount
// sent from the browser, or a customer could pay whatever they want.
const READING_PRICES_CENTS = {
  'Celtic Cross Reading': 4500,
  'The Single Draw': 1200,
  'Past · Present · Path': 2200,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { reading, email, question } = req.body || {};
  const amount = READING_PRICES_CENTS[reading];

  if (!amount) {
    res.status(400).json({ error: 'Unknown reading' });
    return;
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      receipt_email: email,
      automatic_payment_methods: { enabled: true },
      metadata: {
        kind: 'reading',
        reading,
        zoom_email: email,
        question: typeof question === 'string' ? question.slice(0, 500) : '',
      },
    });
    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('create-payment-intent failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
};
