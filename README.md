# HEXPOSED — A Witch's Boutique by New Earth Frequency
## Setup Guide + 3D World Build Reference

---

## Project Structure

```
hexposed/
├── index.html       ← Storefront (spells, apparel, tarot booking+checkout, game launch)
├── game.html        ← Broomstick Run (Three.js 3D game)
├── thank-you.html   ← Post-payment confirmation page (Stripe redirects here)
├── api/
│   ├── _availability.js          ← THE SCHEDULE — the days/times readings can be booked
│   ├── availability.js           ← Vercel serverless fn: open slots for the time picker
│   ├── create-payment-intent.js  ← Vercel serverless fn: starts a Stripe payment
│   ├── booking-details.js        ← Vercel serverless fn: the booked time, for the confirmation page
│   └── webhook.js                ← Vercel serverless fn: verifies Stripe payment events
├── package.json      ← declares the `stripe` dependency the two functions above need
├── models/          ← Create this folder — put your .glb files here
│   ├── witch.glb
│   ├── broom.glb
│   ├── crystal.glb
│   ├── tree.glb
│   ├── house.glb
│   └── streetlight.glb
├── textures/        ← Create this folder — put your image textures here
│   └── (optional sky/ground textures)
└── README.md        ← You are here
```

To preview the static pages: just open `index.html` in a browser (booking's
"continue to payment" step needs the API routes below, so it'll show
"checkout coming soon" until deployed on Vercel).

---

## Tarot Booking Checkout (Stripe) — Deploy on Vercel

Booking a reading is a fully on-site checkout: the customer never leaves
the page. It's built from three pieces:

1. **`index.html`** — the booking modal has the customer pick a session
   time from your open slots, then collects their email (the one tied to
   their Zoom account — that's how you reach them) and an optional
   question, then mounts Stripe's embedded Payment Element to take the
   card.
2. **`api/availability.js`** — a Vercel serverless function that generates
   the open slots from your schedule (`api/_availability.js`) and drops
   any that are already booked or on hold. The picker shows them in the
   *customer's* timezone with yours alongside.
3. **`api/create-payment-intent.js`** — a Vercel serverless function that
   re-checks the chosen time server-side (never trusts the browser: the
   picker's list can be minutes stale, and the request can be
   hand-written), looks up the reading's Stripe Price ID, fetches the real
   amount from Stripe *server-side*, then creates a PaymentIntent for that
   amount with the session time attached.
4. **`api/webhook.js`** — a Vercel serverless function Stripe calls when a
   payment succeeds, so you have a durable, verified record even if the
   customer closes the tab before the confirmation page loads. Right now
   it just logs the booking (reading, session time, email, question) —
   once you have a business domain + mailbox, send the confirmation email
   and the Zoom link from here.
5. **`api/booking-details.js`** — lets `thank-you.html` show the customer
   the session they just booked. Stripe redirects back with the payment's
   id *and* its client secret, and this only answers when the two match,
   so nobody can read someone else's booking off a guessed id.

### Setup steps

1. **Create a Stripe account** (or use your existing one) at
   [dashboard.stripe.com](https://dashboard.stripe.com).
2. **Deploy this repo to Vercel** — import `ic4pi/hexpo` as a new Vercel
   project. Vercel auto-detects the `api/` folder as serverless functions
   and installs `package.json` dependencies at build time.
3. **Set environment variables** in the Vercel project (Settings →
   Environment Variables) — never in this repo, never in chat:
   - `STRIPE_SECRET_KEY` — your Stripe secret key (`sk_live_…` or
     `sk_test_…`). Used server-side only, in `api/*.js`.
   - `STRIPE_WEBHOOK_SECRET` — from the webhook endpoint you register in
     step 4 below (`whsec_…`).
4. **Register the webhook** in the Stripe Dashboard (Developers →
   Webhooks → Add endpoint): URL = `https://<your-vercel-domain>/api/webhook`,
   event = `payment_intent.succeeded`. Stripe gives you the signing secret
   for `STRIPE_WEBHOOK_SECRET` at this point.
5. **Set the publishable key** — open `index.html`, find
   `STRIPE_PUBLISHABLE_KEY = 'pk_live_REPLACE_ME'` near the top of the
   `<script>` block, and paste in your real publishable key (`pk_live_…`
   or `pk_test_…`). This key is meant to be public/client-side — it is
   **not** the secret key.
6. Redeploy. Until the publishable key is filled in, the "book & pay"
   flow correctly shows **"checkout coming soon"** instead of breaking.

Reading prices are set by **Stripe Price ID**, in `READING_PRICE_IDS` in
`api/create-payment-intent.js` — that's the one place that matters, since
the amount charged is fetched live from Stripe at checkout time. To add or
change a reading's price: create/update the Price in the Stripe dashboard
(Products), then put its `price_...` ID in `READING_PRICE_IDS`.

All three readings have Price IDs set. A reading also needs an entry in
`READING_DURATIONS` in `api/_availability.js` (how long the session runs)
— without one it won't appear as bookable, since there'd be no way to
know how much of the calendar to hold.

---

## Setting Your Reading Hours

Both of you work day jobs, so readings only open on the days and times you
say. **`api/_availability.js` is the only file you edit for that** — the
time picker on the site, the server-side check at checkout, and the
confirmation all read from it, so there's never a second place to keep in
sync.

Open it and you'll find, in order:

| Setting | What it does |
|---|---|
| `TIMEZONE` | Your timezone. Every time below is in *this* zone; customers see their own. |
| `WEEKLY_HOURS` | The schedule. `0` = Sunday … `6` = Saturday, each holding any number of `['HH:MM','HH:MM']` windows in 24h time. `[]` = closed that day. |
| `BLACKOUT_DATES` | One-off days off (vacation, a double shift), as `'YYYY-MM-DD'`. |
| `READING_DURATIONS` | How long each reading runs, in minutes. |
| `SLOT_INTERVAL_MINUTES` | Start times offered — `30` gives :00 and :30. |
| `BUFFER_MINUTES` | Gap kept between two sessions. |
| `MIN_LEAD_HOURS` | How much notice you need. `24` = nothing bookable inside a day. |
| `BOOKING_WINDOW_DAYS` | How far ahead the calendar opens. |
| `HOLD_MINUTES` | How long an in-progress checkout holds its slot. |

Shipped defaults (change them to your real availability): Tuesday and
Thursday evenings 7:00–9:30 PM, Saturday 12:00–5:00 PM, Sunday 1:00–5:00
PM, Eastern — everything else closed.

A few things it handles so you don't have to think about them:

- **Windows are start *and* finish.** A 90-minute reading won't be offered
  at 8:00 PM in a window that closes at 9:30.
- **One shared calendar.** Both of you read together on *Two Steps
  Between*, so any booking blocks that time for every reading — no
  double-booking yourselves.
- **Daylight saving.** Times are wall-clock in your zone; the conversion
  is done per-date, so 7:00 PM stays 7:00 PM across the March and November
  changes.
- **Abandoned checkouts free themselves.** Starting a checkout holds the
  slot for `HOLD_MINUTES`; if they never pay, it reopens on its own.

### Where bookings are stored

In Stripe, on the payment itself (`slot_start_ms`, `slot_end_ms`,
`slot_shop_time` in the PaymentIntent metadata) — no database to run or
pay for. The booked time shows on the Stripe payment in your dashboard,
in the `payment_intent.succeeded` webhook log, and on the customer's
confirmation page.

One caveat: Stripe's search index takes up to about a minute to see a new
payment, so two people starting checkout for the same slot inside that
same minute could both get through. At your volume that's unlikely; if it
ever happens, refund or reschedule one of them. The fix if bookings ever
get heavy is a real bookings table with a unique index on the slot —
nothing else in the flow would change.

### Still manual for now

Nothing sends a Zoom link automatically yet. Watch the Vercel function
logs (or your Stripe dashboard) for `Reading booked:` — it carries the
session time in your timezone, the customer's Zoom email, and their
question — and send the invite from there. The booking modal tells
customers to reply to their Stripe receipt to reschedule, which is your
cue to move them into another open slot.

---

## Spell Jar Checkout (Stripe) — Same Deploy, One More Function

The "add to bag" → bag icon flow is a real cart (in-memory, per page load),
checked out the same on-site way as readings, plus a shipping address
since these are physical products:

1. **`index.html`** — `cart` tracks `{ productName: quantity }`. The bag
   modal lets you adjust quantities, then collects email + shipping
   address, then mounts a second Payment Element for the order total.
2. **`api/create-order-payment-intent.js`** — looks up each cart item's
   Stripe Price ID in `SPELL_PRICE_IDS`, fetches the real amount from
   Stripe *server-side* for each (never trusts cart contents/prices sent
   from the browser), sums the order total, and creates the PaymentIntent
   with the shipping address attached.
3. **`api/webhook.js`** — same endpoint as readings, already branches on
   `metadata.kind` (`'reading'` vs `'spell_order'`) and logs orders with
   their shipping address so you can fulfill them manually for now.

No extra setup beyond what's above — it reuses the same
`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / publishable key. Product
prices are set by Stripe Price ID in `SPELL_PRICE_IDS` in
`api/create-order-payment-intent.js` — that's the one place that matters
for what's actually charged. `SPELL_PRICE_CENTS` in `index.html` is
display-only (the bag subtotal shown before checkout), so update it too
when a price changes so the displayed total doesn't drift from Stripe's.

---

## The Game — What's In It (Current State)

The game (`game.html`) uses **Three.js r128** (loaded from CDN) and is fully self-contained. It currently builds everything from primitives:

| Game Element | Current Implementation | Status |
|---|---|---|
| Witch + Broom | Built from Three.js geometries (cylinders, spheres, cones) | ✅ Working |
| City backdrop | Canvas-generated texture scrolling on a flat plane | ✅ Working |
| Towers/obstacles | Purple column pairs (BoxGeometry) | ✅ Working |
| Moon crystals | Teal octahedrons (OctahedronGeometry) | ✅ Working |
| Ambient dust/particles | Point geometry + burst system | ✅ Working |
| Trees, houses, streetlights | NOT YET IN GAME — placeholder city texture only | ⚠️ Needs models |

---

## 3D Models You Need

The game code already has a comment marking where to swap in GLB models:
```
/* Swap broomGroup children for GLB loader when you have model files ready */
```

Here is every element you need a model for, what it should look like, and exactly where it drops in:

---

### 1. Witch + Broom (Player Character)
**File:** `models/witch.glb` and/or `models/broom.glb`

What it needs:
- The **broom** is the flying vehicle — horizontal stick with bristle bundle at back end
- Optional **witch silhouette** seated/crouched on broom (robes, hat)
- Keep it **low-poly** — this is a fast arcade game, not a cutscene
- Style: dark, sleek, slightly stylized — not cartoony
- The model should face **+Z (toward camera)** and fly along the **X axis**
- Hat and robes can animate (flapping) if you add a simple bone rig

**Poly budget:** 500–1500 tris total for broom + witch combined
**Texture:** 512×512 or 1024×1024 PNG, baked albedo only (no PBR needed for game perf)

---

### 2. Moon Crystal (Collectible)
**File:** `models/crystal.glb`

What it needs:
- Glowing, faceted gem — octahedron or elongated diamond shape
- Teal/cyan color (`#14b8a6` is the current particle color)
- Should look good spinning (it rotates on Y and X axes continuously)
- Add emissive map to make it glow without needing extra lights

**Poly budget:** 50–200 tris
**Texture:** 256×256 with emissive channel

---

### 3. Tower / Obstacle
**File:** `models/tower.glb` (optional — current box geometry works fine)

What it needs:
- Cyberpunk-ish building column or antenna tower
- Purple/neon tones to match the palette
- Spawns in pairs (top + bottom) with a gap in the middle for the player to fly through
- Current code handles positioning — you'd just replace the BoxGeometry mesh

**Poly budget:** 200–400 tris
**Texture:** 512×512 with emissive windows

---

### 4. Tree (Background/World Element)
**File:** `models/tree.glb`

What it needs:
- Dead/bare tree — no leaves, twisted branches, dark wood
- Could have faint purple/pink bioluminescent glow on bark
- Will be placed along the **ground plane** in the background
- Should be visible from the side (the camera looks forward, not top-down)

**Poly budget:** 300–600 tris
**Texture:** 512×512 albedo + optional emissive for glow veins

---

### 5. House / Building (Background Element)
**File:** `models/house.glb`

What it needs:
- Small Gothic/Victorian roofline silhouette — pointed roof, narrow windows
- Neon window glow (use emissive texture — pink or purple)
- Will tile across the ground plane at varied scales in the background
- Not detailed — it's scenery passing in the distance

**Poly budget:** 200–500 tris
**Texture:** 512×512 with strong emissive on windows

---

### 6. Street Light (Atmosphere Element)
**File:** `models/streetlight.glb`

What it needs:
- Tall thin pole with lamp head — gothic/ornate preferred
- Pink or purple point light baked into the lamp or added via Three.js PointLight
- Will be placed at ground level, receding into the distance

**Poly budget:** 100–300 tris
**Texture:** 256×256

---

## File Format + Export Settings

**Always save as `.glb`** (binary glTF) — not `.gltf`, not `.fbx`, not `.obj`.

Why GLB: it's a single file, loads natively in Three.js via `GLTFLoader`, includes textures embedded. No separate texture files to manage.

**Export settings (Blender → glTF 2.0):**
- Format: **glTF Binary (.glb)**
- Include: Geometry ✅ | Materials ✅ | Textures ✅
- Compression: **Draco** (reduces file size ~70%, Three.js supports it natively)
- Apply Modifiers: ✅
- Export Normals: ✅
- Do NOT export cameras or lights from Blender — handle lighting in Three.js

**Where to put them:** `/models/` folder in the same directory as `game.html`

---

## How to Load GLB in the Existing Game Code

The game already imports Three.js from CDN. Add the GLTFLoader right after:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
<!-- If using Draco compression: -->
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js"></script>
```

Then load a model:

```javascript
const loader = new THREE.GLTFLoader();
loader.load('models/broom.glb', (gltf) => {
  const broom = gltf.scene;
  broom.scale.set(0.5, 0.5, 0.5); // adjust scale
  scene.add(broom);
});
```

The game's `buildBroom()` function returns a `THREE.Group` — just replace its contents with the loaded GLB scene children.

---

## Building the Full 3D World

You asked about this specifically — here's the full breakdown.

### The Architecture

Your game is **full 3D rendered in Three.js** with a **perspective camera** looking forward along the Z axis. The player flies left-right and up-down while the world scrolls toward them. This is NOT a 2D game — it's a 3D game with a cinematic fixed-ish camera angle, like an endless flyer (think Temple Run but side-scrolling from the side).

The "2D feel" comes from constraining the player to a flat plane (X and Y movement only, no Z movement for the player). The world itself is fully 3D.

---

### World Layers (Depth Order, Back to Front)

```
[Sky / Stars]          Z = -50 to -100   ← Skybox or skysphere
[Moon]                 Z = -60           ← Static sphere, glowing
[Far buildings]        Z = -30 to -20    ← Low-detail, heavily fogged
[Mid buildings/trees]  Z = -15 to -10    ← Medium detail, some fog
[Street level]         Z = -5 to -2      ← Houses, trees, streetlights
[Game lane]            Z = 0             ← Where player flies
[Tower obstacles]      Z = -1 to 1       ← Spawned into lane
[Player / Broom]       Z = 0             ← Fixed Z, moves on X/Y
```

The fog in the current code (`FogExp2`) already handles depth fading — things further back naturally disappear, which is why you don't need highly detailed background models.

---

### Ground Plane Setup

You'll want an actual ground plane the player flies over:

```javascript
// Endless ground plane
const groundGeo = new THREE.PlaneGeometry(200, 80);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x04020c,
  roughness: 1,
  metalness: 0,
  emissive: 0x0a0018,
  emissiveIntensity: 0.3
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -6; // below flight lane
scene.add(ground);
```

Then you place houses, trees, streetlights along this ground plane, and scroll them the same way obstacles scroll (move X position each frame).

---

### Infinite Scrolling World Objects

Use an **object pool** — pre-create N instances of each prop, move them left each frame, and when they go off-screen on the left, teleport them back to the right:

```javascript
const PROPS = [];
const propLoader = new THREE.GLTFLoader();

propLoader.load('models/tree.glb', (gltf) => {
  for (let i = 0; i < 8; i++) {
    const tree = gltf.scene.clone();
    tree.position.set(
      20 + i * 15,          // space them out along X
      -5.5,                  // sit on ground plane
      -8 - Math.random() * 6 // vary depth
    );
    tree.scale.setScalar(0.8 + Math.random() * 0.6);
    scene.add(tree);
    PROPS.push(tree);
  }
});

// In your animate() loop:
PROPS.forEach(prop => {
  prop.position.x -= worldSpeed;
  if (prop.position.x < -30) {
    prop.position.x += 200; // loop back to the right
  }
});
```

Do the same for houses and streetlights — just vary the Z depth and spacing.

---

### Sky Setup (Replace the Canvas Texture)

Instead of the canvas-painted city texture on a flat plane, do a proper sky:

```javascript
// Option A: Skysphere (simple, works great)
const skyGeo = new THREE.SphereGeometry(150, 32, 32);
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    topColor: { value: new THREE.Color(0x000005) },
    bottomColor: { value: new THREE.Color(0x0a0020) },
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    varying vec3 vWorldPosition;
    void main() {
      float h = normalize(vWorldPosition).y;
      gl_FragColor = vec4(mix(bottomColor, topColor, max(h, 0.0)), 1.0);
    }
  `,
  side: THREE.BackSide
});
const sky = new THREE.Mesh(skyGeo, skyMat);
scene.add(sky);
```

---

### Recommended Tools to Build the Models

**Blender (free)** — the only real answer.

1. **Broom:** Cylinder for handle → Boolean or manual mesh for bristle bundle → UV unwrap → bake to 512×512 → export GLB
2. **Witch:** Start from a Rigify rig (Blender add-on) or just do a rigid posed mesh if no animation needed → same export process
3. **Trees:** Use Blender's Sapling Tree Gen add-on → reduce poly count → paint dark colors → export
4. **Houses:** Box model, extrude roofline → add window insets → paint emissive texture in Substance Painter or just Blender's texture paint mode
5. **Streetlights:** Simple cylinder pole → curve the top → add lamp head from a sphere → done in under 20 minutes

**Poly targets** are conservative — modern phones handle 50k–200k tris in Three.js no problem. The limits above are per-object so you can have many instances without tanking framerate.

---

### Performance Tips for Mobile

- Enable **Draco compression** on all models — cuts load time dramatically
- Use **instanced meshes** for trees/streetlights (THREE.InstancedMesh) — one draw call for 20 trees
- Keep textures **power-of-two** dimensions (256, 512, 1024)
- Disable shadow casting on background props — only the player needs shadows if any
- Use `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` — already in the code ✅
- Test on actual device — Three.js perf on iOS Safari can differ from desktop

---

## Quick Start Checklist

- [ ] Fix is live: title reads **HEXPOSED** / subtitle reads **A Witch's Boutique by New Earth Frequency**
- [ ] Deploy `index.html` + `game.html` to Vercel/Netlify
- [ ] Set your real reading days/times in `api/_availability.js` (`WEEKLY_HOURS`)
- [ ] Create `/models/` directory alongside the HTML files
- [ ] Build or source models in Blender → export as `.glb` into `/models/`
- [ ] Add GLTFLoader script tag to `game.html`
- [ ] Replace `buildBroom()` primitive group with GLB loader call
- [ ] Add object pool for trees, houses, streetlights along ground plane
- [ ] Add skysphere to replace canvas-painted flat city backdrop
- [ ] Test on iOS Safari (newest iPhone) before calling anything done

---

*Hexposed — A Witch's Boutique by New Earth Frequency*
*Take your position.*
