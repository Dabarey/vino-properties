const R2_PUBLIC = 'https://pub-e45aa5ed38ff4e71be091492151a09fc.r2.dev';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function optionsResp() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── ROUTER ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return optionsResp();

    // ── PROPERTIES ──
    if (path === '/api/properties' && method === 'GET') return getProperties(request, env);
    if (path === '/api/properties' && method === 'POST') return createProperty(request, env);
    if (path.match(/^\/api\/properties\/\d+$/) && method === 'PUT') return updateProperty(request, env, path);
    if (path.match(/^\/api\/properties\/\d+$/) && method === 'DELETE') return deleteProperty(request, env, path);

    // ── PHOTO UPLOAD ──
    if (path === '/api/upload-photo' && method === 'POST') return uploadPhoto(request, env);

    // ── AD SUBMISSIONS ──
    if (path === '/api/submissions' && method === 'GET') return getSubmissions(request, env);
    if (path === '/api/submissions' && method === 'POST') return createSubmission(request, env);
    if (path.match(/^\/api\/submissions\/\d+\/approve$/) && method === 'POST') return approveSubmission(request, env, path);
    if (path.match(/^\/api\/submissions\/\d+\/reject$/) && method === 'POST') return rejectSubmission(request, env, path);

    // ── USER ACCOUNTS ──
    if (path === '/api/register' && method === 'POST') return registerUser(request, env);
    if (path === '/api/login' && method === 'POST') return loginUser(request, env);
    if (path === '/api/my-ads' && method === 'GET') return getMyAds(request, env);

    // ── BOOST / REPOST ──
    if (path.match(/^\/api\/properties\/\d+\/boost$/) && method === 'POST') return boostProperty(request, env, path);

    // ── STRIPE PAYMENT INTENT ──
    if (path === '/api/create-payment-intent' && method === 'POST') return createPaymentIntent(request, env);

    // ── ADMIN ──
    if (path === '/api/admin/properties' && method === 'GET') return adminGetProperties(request, env);

    return err('Not found', 404);
  },
};

// ════════════════════════════════════════════════════════
// PROPERTIES
// ════════════════════════════════════════════════════════
async function getProperties(request, env) {
  const url = new URL(request.url);
  const country = url.searchParams.get('country') || 'LK';
  const mode = url.searchParams.get('mode') || 'buy';

  let query = `SELECT * FROM properties WHERE 1=1`;
  const params = [];

  if (country !== 'ALL') { query += ` AND country = ?`; params.push(country); }
  if (mode !== 'ALL')    { query += ` AND listing_mode = ?`; params.push(mode); }

  // Boosted first, then newest
  query += ` ORDER BY
    CASE WHEN boosted = 1 AND boosted_until > datetime('now') THEN 0 ELSE 1 END,
    created_at DESC`;

  const { results } = await env.DB.prepare(query).bind(...params).all();

  // Parse JSON fields
  const props = results.map(r => ({
    ...r,
    amenities: safeJSON(r.amenities, []),
    photos:    safeJSON(r.photos, []),
  }));

  return json({ properties: props });
}

async function createProperty(request, env) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const data = await request.json();
  const now = new Date().toISOString();

  const stmt = env.DB.prepare(`
    INSERT INTO properties
      (type,title,location,province,price,beds,baths,area,land,land_perches,
       img,amenities,deed,badge,badge_key,description,photos,link,listing_mode,country,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const result = await stmt.bind(
    data.type, data.title, data.location, data.province,
    data.price, data.beds || 0, data.baths || 0,
    data.area || '', data.land || '', data.land_perches || 0,
    data.img || 'img-custom',
    JSON.stringify(data.amenities || []),
    data.deed || 'freehold',
    data.badge || null, data.badge_key || null,
    data.description || '',
    JSON.stringify(data.photos || []),
    data.link || null,
    data.listing_mode || 'buy',
    data.country || 'LK',
    now
  ).run();

  return json({ id: result.meta.last_row_id, ok: true });
}

async function updateProperty(request, env, path) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const id = path.split('/')[3];
  const data = await request.json();

  await env.DB.prepare(`
    UPDATE properties SET
      type=?, title=?, location=?, province=?, price=?,
      beds=?, baths=?, area=?, land=?, land_perches=?,
      img=?, amenities=?, deed=?, badge=?, badge_key=?,
      description=?, photos=?, link=?, listing_mode=?, country=?
    WHERE id=?
  `).bind(
    data.type, data.title, data.location, data.province,
    data.price, data.beds || 0, data.baths || 0,
    data.area || '', data.land || '', data.land_perches || 0,
    data.img || 'img-custom',
    JSON.stringify(data.amenities || []),
    data.deed || 'freehold',
    data.badge || null, data.badge_key || null,
    data.description || '',
    JSON.stringify(data.photos || []),
    data.link || null,
    data.listing_mode || 'buy',
    data.country || 'LK',
    id
  ).run();

  return json({ ok: true });
}

async function deleteProperty(request, env, path) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const id = path.split('/')[3];
  await env.DB.prepare(`DELETE FROM properties WHERE id=?`).bind(id).run();
  return json({ ok: true });
}

async function boostProperty(request, env, path) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const id = path.split('/')[3];
  const { days } = await request.json();
  const until = new Date();
  until.setDate(until.getDate() + days);

  await env.DB.prepare(`
    UPDATE properties SET boosted=1, boosted_until=?, boosted_days=? WHERE id=?
  `).bind(until.toISOString(), days, id).run();

  return json({ ok: true });
}

async function adminGetProperties(request, env) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const { results } = await env.DB.prepare(
    `SELECT * FROM properties ORDER BY created_at DESC`
  ).all();
  const props = results.map(r => ({
    ...r,
    amenities: safeJSON(r.amenities, []),
    photos:    safeJSON(r.photos, []),
  }));
  return json({ properties: props });
}

// ════════════════════════════════════════════════════════
// PHOTO UPLOAD → R2
// ════════════════════════════════════════════════════════
async function uploadPhoto(request, env) {
  const formData = await request.formData();
  const file = formData.get('photo');

  if (!file) return err('No photo provided');

  const ext = file.name.split('.').pop().toLowerCase() || 'jpg';
  const allowed = ['jpg', 'jpeg', 'png', 'webp'];
  if (!allowed.includes(ext)) return err('Only JPG, PNG, WEBP allowed');

  const key = `photos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const buffer = await file.arrayBuffer();

  await env.PHOTOS.put(key, buffer, {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });

  const publicUrl = `${R2_PUBLIC}/${key}`;
  return json({ url: publicUrl, key });
}

// ════════════════════════════════════════════════════════
// AD SUBMISSIONS
// ════════════════════════════════════════════════════════
async function createSubmission(request, env) {
  const data = await request.json();
  const now = new Date().toISOString();
  const refCode = 'EST-' + Date.now().toString(36).toUpperCase().slice(-6);

  await env.DB.prepare(`
    INSERT INTO ad_submissions
      (type,title,location,province,price,beds,baths,area,land,land_perches,
       img,amenities,deed,description,photos,submitter_name,submitter_phone,
       submitter_email,country,package_name,package_price,payment_ref,ref_code,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    data.type, data.title, data.location, data.province,
    data.price, data.beds || 0, data.baths || 0,
    data.area || '', data.land || '', data.land_perches || 0,
    data.img || 'img-custom',
    JSON.stringify(data.amenities || []),
    data.deed || 'freehold',
    data.description || '',
    JSON.stringify(data.photos || []),
    data.submitter_name, data.submitter_phone,
    data.submitter_email || '',
    data.country || 'LK',
    data.package_name, data.package_price,
    data.payment_ref || '',
    refCode, 'pending', now
  ).run();

  // Auto-create user account
  const pw = data.password || (Math.random().toString(36).slice(2,5).toUpperCase() + Math.floor(100+Math.random()*900));
  const existing = await env.DB.prepare(
    `SELECT id FROM user_accounts WHERE phone=?`
  ).bind(data.submitter_phone).first();

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO user_accounts (phone,name,password,ref_code,created_at) VALUES (?,?,?,?,?)`
    ).bind(data.submitter_phone, data.submitter_name, pw, refCode, now).run();
  } else {
    await env.DB.prepare(
      `UPDATE user_accounts SET ref_code=? WHERE phone=?`
    ).bind(refCode, data.submitter_phone).run();
  }

  return json({ ok: true, ref_code: refCode, password: existing ? null : pw });
}

async function getSubmissions(request, env) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const { results } = await env.DB.prepare(
    `SELECT * FROM ad_submissions WHERE status='pending' ORDER BY created_at DESC`
  ).all();
  const subs = results.map(r => ({
    ...r,
    amenities: safeJSON(r.amenities, []),
    photos:    safeJSON(r.photos, []),
  }));
  return json({ submissions: subs });
}

async function approveSubmission(request, env, path) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const id = path.split('/')[3];
  const sub = await env.DB.prepare(
    `SELECT * FROM ad_submissions WHERE id=?`
  ).bind(id).first();
  if (!sub) return err('Submission not found', 404);

  const PKGS = {
    basic:    { badge: 'Basic',    bk: 'basic' },
    featured: { badge: 'Featured', bk: 'featured' },
    premium:  { badge: 'Premium',  bk: 'premium' },
  };
  const pkg = PKGS[(sub.package_name || 'basic').toLowerCase()] || PKGS.basic;
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO properties
      (type,title,location,province,price,beds,baths,area,land,land_perches,
       img,amenities,deed,badge,badge_key,description,photos,listing_mode,country,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    sub.type, sub.title, sub.location, sub.province,
    sub.price, sub.beds, sub.baths,
    sub.area, sub.land, sub.land_perches,
    sub.img || 'img-custom', sub.amenities, sub.deed,
    pkg.badge, pkg.bk, sub.description, sub.photos,
    sub.listing_mode || 'buy', sub.country || 'LK', now
  ).run();

  await env.DB.prepare(
    `UPDATE ad_submissions SET status='approved' WHERE id=?`
  ).bind(id).run();

  return json({ ok: true });
}

async function rejectSubmission(request, env, path) {
  if (!isAdmin(request, env)) return err('Unauthorized', 401);
  const id = path.split('/')[3];
  await env.DB.prepare(
    `UPDATE ad_submissions SET status='rejected' WHERE id=?`
  ).bind(id).run();
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════
// USER ACCOUNTS
// ════════════════════════════════════════════════════════
async function registerUser(request, env) {
  const { phone, name, password, ref_code } = await request.json();
  if (!phone || !password) return err('Phone and password required');

  const existing = await env.DB.prepare(
    `SELECT id FROM user_accounts WHERE phone=?`
  ).bind(phone).first();

  if (existing) return err('Account already exists for this phone');

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO user_accounts (phone,name,password,ref_code,created_at) VALUES (?,?,?,?,?)`
  ).bind(phone, name, password, ref_code || '', now).run();

  return json({ ok: true });
}

async function loginUser(request, env) {
  const { phone, password } = await request.json();
  if (!phone || !password) return err('Phone and password required');

  const user = await env.DB.prepare(
    `SELECT * FROM user_accounts WHERE phone=? AND password=?`
  ).bind(phone, password).first();

  if (!user) return err('Invalid phone or password', 401);
  return json({ ok: true, user });
}

async function getMyAds(request, env) {
  const url = new URL(request.url);
  const ref = url.searchParams.get('ref_code');
  if (!ref) return err('ref_code required');

  const { results } = await env.DB.prepare(
    `SELECT * FROM ad_submissions WHERE ref_code=? ORDER BY created_at DESC`
  ).bind(ref).all();

  return json({ ads: results });
}

// ════════════════════════════════════════════════════════
// STRIPE PAYMENT INTENT
// ════════════════════════════════════════════════════════
async function createPaymentIntent(request, env) {
  const { amount_usd, ref } = await request.json();
  if (!amount_usd) return err('amount_usd required');

  const amountCents = Math.round(parseFloat(amount_usd) * 100);

  const resp = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: amountCents,
      currency: 'usd',
      description: `vino.properties listing — ${ref || ''}`,
      metadata: JSON.stringify({ ref }),
    }),
  });

  const pi = await resp.json();
  if (pi.error) return err(pi.error.message);

  return json({ client_secret: pi.client_secret, id: pi.id });
}

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════
function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  return token === env.ADMIN_PASSWORD;
}

function safeJSON(val, fallback) {
  try { return typeof val === 'string' ? JSON.parse(val) : val ?? fallback; }
  catch { return fallback; }
}
