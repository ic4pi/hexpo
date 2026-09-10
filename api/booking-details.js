const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/* The confirmation page calls this to show the customer the time
   they just booked. Stripe redirects back with the PaymentIntent
   id and its client secret; we only answer when the secret
   matches the intent, so a bare id can't be used to read someone
   else's booking. */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const id = (req.query && req.query.payment_intent) || '';
  const clientSecret = (req.query && req.query.client_secret) || '';
  if (!id || !clientSecret) {
    res.status(400).json({ error: 'Missing payment reference.' });
    return;
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(id);
    if (pi.client_secret !== clientSecret) {
      res.status(403).json({ error: 'Payment reference doesn’t match.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      kind: pi.metadata.kind || '',
      reading: pi.metadata.reading || '',
      slotShopTime: pi.metadata.slot_shop_time || '',
      slotStart: pi.metadata.slot_start_ms ? new Date(Number(pi.metadata.slot_start_ms)).toISOString() : '',
      timezone: pi.metadata.slot_timezone || '',
      email: pi.receipt_email || '',
    });
  } catch (err) {
    console.error('booking-details lookup failed:', err.message);
    res.status(500).json({ error: 'Couldn’t load your booking details.' });
  }
};
