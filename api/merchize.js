/* ── MERCHIZE FULFILLMENT CLIENT ──
   Merchize's *storefront builder* is the paid product. Fulfillment is
   free: you sell on your own site, then hand Merchize the order and they
   print, pack, and ship it, charging you the base cost + shipping. That's
   the path this file implements — hexposed.com stays the store, Stripe
   stays the checkout, Merchize is only the print partner behind it.

   Set these in Vercel (Settings → Environment Variables), never here:
     MERCHIZE_API_BASE — from the Merchize dashboard's API menu, shaped
                         https://<your-store>.merchize.store/bo-api
     MERCHIZE_API_KEY  — the access token shown on that same API page

   If either is unset, order pushes are skipped and logged, so the site
   keeps taking payments safely while you finish setting Merchize up.
── */

// Product name + size -> the Merchize variant SKU that gets printed.
// Find these in the Merchize dashboard on the product's variant list.
// A size with no SKU here cannot be auto-fulfilled — it still sells and
// still gets logged, you just place that one by hand.
const MERCHIZE_SKUS = {
  'Occupied Skies Ugly Sweater': {
    S: '', M: '', L: '', XL: '',
    '2XL': '', '3XL': '', '4XL': '', '5XL': '',
  },
};

function skuFor(name, size) {
  const sizes = MERCHIZE_SKUS[name];
  return (sizes && sizes[size]) || '';
}

/* Builds the create-order request body.

   NOTE: this shape follows Merchize's documented order-import fields, but
   their dashboard's API page is the authority for your specific store —
   if a push comes back 400, the response body is logged in full below and
   this is the single function to correct. Nothing else needs to change.
*/
function buildMerchizeOrderPayload({ externalNumber, email, shipping, items }) {
  return {
    external_number: externalNumber,
    email,
    shipping_address: {
      full_name: shipping.name,
      address1: shipping.address.line1,
      address2: shipping.address.line2 || '',
      city: shipping.address.city,
      state: shipping.address.state,
      postal_code: shipping.address.postal_code,
      country: shipping.address.country,
      phone: shipping.phone || '',
    },
    line_items: items.map((item) => ({
      sku: skuFor(item.name, item.size),
      quantity: item.qty,
      variant: { size: item.size },
    })),
  };
}

/* Pushes one order to Merchize for fulfillment.

   Never throws. The caller is a Stripe webhook running after the card has
   already been charged — a Merchize outage must not turn into a failed
   webhook (Stripe would retry, and a retry that succeeds on the Merchize
   side would print the order twice). On any failure this logs everything
   needed to place the order by hand and returns { ok: false }.
*/
async function createMerchizeOrder({ externalNumber, email, shipping, items }) {
  const base = process.env.MERCHIZE_API_BASE;
  const key = process.env.MERCHIZE_API_KEY;

  if (!base || !key) {
    console.log('Merchize not configured — fulfil this order by hand:', {
      externalNumber, email, shipping, items,
    });
    return { ok: false, reason: 'not_configured' };
  }

  const missingSku = items.filter((item) => !skuFor(item.name, item.size));
  if (missingSku.length) {
    console.warn('Merchize SKU missing, fulfil these by hand:', missingSku);
  }

  const payload = buildMerchizeOrderPayload({ externalNumber, email, shipping, items });

  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/order/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': key,
      },
      body: JSON.stringify(payload),
    });

    const body = await response.text();

    if (!response.ok) {
      // Logged in full so a field-name mismatch is a one-line fix in
      // buildMerchizeOrderPayload above rather than a guessing game.
      console.error('Merchize order push failed:', {
        status: response.status, body, sent: payload,
      });
      return { ok: false, reason: 'http_' + response.status };
    }

    console.log('Merchize order created:', { externalNumber, body });
    return { ok: true };
  } catch (err) {
    console.error('Merchize order push errored:', err.message, { sent: payload });
    return { ok: false, reason: 'network' };
  }
}

module.exports = { createMerchizeOrder, MERCHIZE_SKUS, skuFor };
