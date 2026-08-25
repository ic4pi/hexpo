const Stripe = require('stripe');
const { validateSlot, readingDuration, shopTimeLabel, TIMEZONE, HOLD_MINUTES } = require('./_availability');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Reading name -> Stripe Price ID. The amount actually charged is fetched
// live from Stripe (via prices.retrieve below), never hardcoded here — so
// the price shown in your Stripe dashboard is always the price charged.
// Session length for each reading lives in _availability.js.
const READING_PRICE_IDS = {
  'Celtic Cross Reading': 'price_1U8889ALwINGiotHjAdUC9Rr',
  'Past · Present · Path': 'price_1U87gYALwINGiotH1RYIF6Ns',
  'Two Steps Between': 'price_1U8IICALwINGiotHWSkyDTzV',
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { reading, email, question, slotStart } = req.body || {};
  const priceId = READING_PRICE_IDS[reading];

  if (!priceId || !readingDuration(reading)) {
    res.status(400).json({ error: 'This reading isn’t available for checkout yet.' });
    return;
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }

  try {
    // The picker already filtered the calendar, but its list can be
    // minutes old and the request can be hand-written — so the chosen
    // time is re-checked against the schedule and the existing bookings
    // here, server-side, before any money is involved.
    const check = await validateSlot(stripe, reading, Date.parse(slotStart));
    if (!check.ok) {
      res.status(409).json({ error: check.error });
      return;
    }
    const { slot } = check;

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
        // These four are the booking itself. slot_start_ms / slot_end_ms
        // are what the availability check reads back, so don't rename
        // them without updating _availability.js.
        slot_start_ms: String(slot.startMs),
        slot_end_ms: String(slot.endMs),
        slot_shop_time: shopTimeLabel(slot.startMs),
        slot_timezone: TIMEZONE,
      },
    });

    // Creating the PaymentIntent puts a HOLD_MINUTES hold on the slot —
    // long enough to finish paying, short enough that an abandoned
    // checkout frees the time back up on its own.
    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      amount: price.unit_amount,
      slotShopTime: shopTimeLabel(slot.startMs),
      slotStart: new Date(slot.startMs).toISOString(),
      holdMinutes: HOLD_MINUTES,
    });
  } catch (err) {
    console.error('create-payment-intent failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
};
