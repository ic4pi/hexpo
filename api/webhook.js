const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook signature verification needs the raw request body, so Vercel's
// default JSON body parser has to be turned off for this route.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const signature = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    // No business email/domain set up yet — for now this just gets you a
    // durable, verified record in the Vercel function logs to follow up
    // from manually. Once a domain + mailbox exist, send the confirmation
    // email to `pi.receipt_email` right here.
    console.log('Reading booked:', {
      reading: pi.metadata.reading,
      zoomEmail: pi.metadata.zoom_email,
      question: pi.metadata.question,
      amount: pi.amount,
      paymentIntentId: pi.id,
    });
  }

  res.status(200).json({ received: true });
};
