const Stripe = require('stripe');
const { createMerchizeOrder } = require('../lib/merchize');

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

// Any apparel/accessory lines in the order get pushed to Merchize here so
// they're fulfilled automatically — this only runs after Stripe confirms
// payment actually succeeded. A failure here never blocks the webhook
// response to Stripe; it's logged loudly so the order can be pushed to
// Merchize manually instead.
async function fulfillMerchizeOrder(pi) {
  let merchLines;
  try {
    merchLines = JSON.parse(pi.metadata.merch_items || '[]');
  } catch (err) {
    merchLines = [];
  }
  if (!merchLines.length) return;

  try {
    const order = await createMerchizeOrder({
      email: pi.metadata.order_email,
      shipping: pi.shipping,
      line_items: merchLines.map((l) => ({ product_id: l.id, variant: l.size, quantity: l.qty })),
      external_reference: pi.id,
    });
    console.log('Merchize fulfillment order created for', pi.id, ':', order);
  } catch (err) {
    console.error(
      'Merchize order push FAILED for payment', pi.id, '-', err.message,
      '- fulfill this order in Merchize manually. Items:', pi.metadata.merch_items
    );
  }
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
    if (pi.metadata.kind === 'order') {
      console.log('Order placed:', {
        email: pi.metadata.order_email,
        items: pi.metadata.items,
        shipping: pi.shipping,
        amount: pi.amount,
        paymentIntentId: pi.id,
      });
      await fulfillMerchizeOrder(pi);
    } else {
      console.log('Reading booked:', {
        reading: pi.metadata.reading,
        zoomEmail: pi.metadata.zoom_email,
        question: pi.metadata.question,
        amount: pi.amount,
        paymentIntentId: pi.id,
      });
    }
  }

  res.status(200).json({ received: true });
};
