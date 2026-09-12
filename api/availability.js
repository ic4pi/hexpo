const Stripe = require('stripe');
const { openSlots, readingDuration, registerReadingDuration, TIMEZONE, MIN_LEAD_HOURS } = require('./_availability');
const { findByName } = require('./_catalog');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/* Feeds the booking modal's day/time picker. Slots come back as
   plain ISO instants — the browser renders them in whatever zone
   the customer is sitting in, and we render them in ours. */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const reading = (req.query && req.query.reading) || '';
  // A reading added through /admin keeps its length in Stripe, so look it
  // up before deciding the reading is unknown — otherwise its picker would
  // come back empty and the booking could never be started.
  if (!readingDuration(reading)) {
    let dynamic = null;
    try {
      dynamic = await findByName(reading);
    } catch (_) {
      dynamic = null;
    }
    if (dynamic && dynamic.kind === 'reading') {
      registerReadingDuration(reading, dynamic.durationMinutes || 60);
    }
  }
  if (!readingDuration(reading)) {
    res.status(400).json({ error: 'Unknown reading.' });
    return;
  }

  try {
    const slots = await openSlots(stripe, reading);
    // The picker is a live view of an ever-changing calendar, so
    // don't let a CDN or browser serve a stale copy of it.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      timezone: TIMEZONE,
      durationMinutes: readingDuration(reading),
      minLeadHours: MIN_LEAD_HOURS,
      slots: slots.map((s) => ({ start: new Date(s.startMs).toISOString(), end: new Date(s.endMs).toISOString() })),
    });
  } catch (err) {
    console.error('availability lookup failed:', err.message);
    res.status(500).json({ error: 'Couldn’t load the calendar right now. Please try again shortly.' });
  }
};
