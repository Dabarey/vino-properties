/**
 * vino.properties — Cloudflare Worker API
 * Storage: D1 (database) + R2 (photos)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ─────────────────────────────────────────────
// ROUTING
// ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── Static frontend ──
    if (path === "/" || path === "/index.html") {
  const asset = await env.__STATIC_CONTENT.get("index.html", { type: "text" });
  return new Response(asset, { headers: { "Content-Type": "text/html" } });
}

    // ── API routes ──
    try {
      // Properties
      if (path === '/api/properties' && method === 'GET') return listProperties(request, env);
      if (path === '/api/properties' && method === 'POST') return createProperty(request, env);
      if (path.match(/^\/api\/properties\/\d+$/) && method === 'PUT') return updateProperty(request, env, path);
      if (path.match(/^\/api\/properties\/\d+$/) && method === 'DELETE') return deleteProperty(request, env, path);

      // Photo upload to R2
      if (path === '/api/photos/upload' && method === 'POST') return uploadPhoto(request, env);

      // User accounts
      if (path === '/api/users/login' && method === 'POST') return loginUser(request, env);
      if (path === '/api/users/register' && method === 'POST') return registerUser(request, env);
      if (path === '/api/users/google' && method === 'POST') return googleUser(request, env);
      if (path.match(/^\/api\/users\/by-phone\//) && method === 'GET') return getUserByPhone(request, env, path);

      // Ad submissions
      if (path === '/api/submissions' && method === 'GET') return listSubmissions(request, env);
      if (path === '/api/submissions' && method === 'POST') return createSubmission(request, env);
      if (path.match(/^\/api\/submissions\/\d+\/approve$/) && method === 'POST') return approveSubmission(request, env, path);
      if (path.match(/^\/api\/submissions\/\d+\/reject$/) && method === 'POST') return rejectSubmission(request, env, path);
      if (path.match(/^\/api\/submissions\/by-ref\//) && method === 'GET') return submissionsByRef(request, env, path);

      // Boost
      if (path.match(/^\/api\/properties\/\d+\/boost$/) && method === 'POST') return boostProperty(request, env, path);

      // Settings
      if (path === '/api/settings' && method === 'GET') return getSettings(request, env);
      if (path === '/api/settings' && method === 'PUT') return putSettings(request, env);

      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err('Internal error: ' + e.message, 500);
    }
  },
};

// ─────────────────────────────────────────────
// PROPERTIES
// ─────────────────────────────────────────────
async function listProperties(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM properties ORDER BY
       CASE WHEN boosted=1 AND (boosted_until IS NULL OR boosted_until > datetime('now')) THEN 0 ELSE 1 END,
       created_at DESC`
  ).all();
  const rows = results.map(parseProperty);
  return json(rows);
}

async function createProperty(request, env) {
  const body = await request.json();
  const cols = propertyColumns(body);
  const placeholders = cols.map(() => '?').join(',');
  const stmt = env.DB.prepare(
    `INSERT INTO properties (${cols.map(c => c.col).join(',')}, created_at)
     VALUES (${placeholders}, datetime('now'))`
  ).bind(...cols.map(c => c.val));
  const result = await stmt.run();
  const row = await env.DB.prepare('SELECT * FROM properties WHERE rowid=?').bind(result.meta.last_row_id).first();
  return json(parseProperty(row), 201);
}

async function updateProperty(request, env, path) {
  const id = path.split('/')[3];
  const body = await request.json();
  const cols = propertyColumns(body);
  const setClause = cols.map(c => `${c.col}=?`).join(',');
  await env.DB.prepare(`UPDATE properties SET ${setClause} WHERE id=?`)
    .bind(...cols.map(c => c.val), id).run();
  const row = await env.DB.prepare('SELECT * FROM properties WHERE id=?').bind(id).first();
  return json(parseProperty(row));
}

async function deleteProperty(request, env, path) {
  const id = path.split('/')[3];
  await env.DB.prepare('DELETE FROM properties WHERE id=?').bind(id).run();
  return json({ ok: true });
}

async function boostProperty(request, env, path) {
  const id = path.split('/')[3];
  const { days } = await request.json();
  const until = new Date(Date.now() + days * 86400000).toISOString();
  await env.DB.prepare(
    `UPDATE properties SET boosted=1, boosted_until=?, boosted_days=? WHERE id=?`
  ).bind(until, days, id).run();
  return json({ ok: true });
}

function propertyColumns(body) {
  const safe = (v, fallback = null) => v !== undefined ? v : fallback;
  const cols = [
    { col: 'type',         val: safe(body.type, 'house') },
    { col: 'title',        val: safe(body.title, '') },
    { col: 'location',     val: safe(body.location, '') },
    { col: 'province',     val: safe(body.province, '') },
    { col: 'price',        val: safe(body.price, 0) },
    { col: 'beds',         val: safe(body.beds, 0) },
    { col: 'baths',        val: safe(body.baths, 0) },
    { col: 'area',         val: safe(body.area, '—') },
    { col: 'land',         val: safe(body.land, '—') },
    { col: 'land_perches', val: safe(body.land_perches, 0) },
    { col: 'img',          val: safe(body.img, 'img-custom') },
    { col: 'amenities',    val: JSON.stringify(safe(body.amenities, [])) },
    { col: 'deed',         val: safe(body.deed, 'freehold') },
    { col: 'badge',        val: safe(body.badge) },
    { col: 'badge_key',    val: safe(body.badge_key) },
    { col: 'description',  val: safe(body.description, '') },
    { col: 'link',         val: safe(body.link) },
    { col: 'listing_mode', val: safe(body.listing_mode, 'buy') },
    { col: 'country',      val: safe(body.country, 'LK') },
    { col: 'photos',       val: body.photos ? JSON.stringify(body.photos) : null },
    { col: 'boosted',      val: safe(body.boosted, 0) },
    { col: 'boosted_until',val: safe(body.boosted_until) },
    { col: 'boosted_days', val: safe(body.boosted_days, 0) },
  ];
  return cols;
}

function parseProperty(r) {
  if (!r) return null;
  return {
    ...r,
    amenities: tryParse(r.amenities, []),
    photos: tryParse(r.photos, null),
    price: Number(r.price),
    beds: Number(r.beds),
    baths: Number(r.baths),
    land_perches: Number(r.land_perches || 0),
    boosted: !!r.boosted,
    boosted_days: Number(r.boosted_days || 0),
  };
}

// ─────────────────────────────────────────────
// PHOTO UPLOAD → R2
// ─────────────────────────────────────────────
async function uploadPhoto(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file) return err('No file');
  const ext = file.name.split('.').pop() || 'jpg';
  const key = `photos/${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });
  const url = `https://photos.vino.properties/${key}`;
  return json({ url, key });
}

// ─────────────────────────────────────────────
// USER ACCOUNTS
// ─────────────────────────────────────────────
async function loginUser(request, env) {
  const { phone, password } = await request.json();
  const row = await env.DB.prepare(
    'SELECT * FROM user_accounts WHERE phone=? AND password=?'
  ).bind(phone, password).first();
  if (!row) return err('Invalid credentials', 401);
  return json(row);
}

async function registerUser(request, env) {
  const { phone, name, password, ref_code } = await request.json();
  const existing = await env.DB.prepare('SELECT id FROM user_accounts WHERE phone=?').bind(phone).first();
  if (existing) {
    await env.DB.prepare('UPDATE user_accounts SET password=?, ref_code=? WHERE phone=?')
      .bind(password, ref_code, phone).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO user_accounts (phone, name, password, ref_code, created_at) VALUES (?,?,?,?,datetime("now"))'
    ).bind(phone, name, password, ref_code).run();
  }
  const row = await env.DB.prepare('SELECT * FROM user_accounts WHERE phone=?').bind(phone).first();
  return json(row);
}

async function googleUser(request, env) {
  const { google_id, name, email } = await request.json();
  let row = await env.DB.prepare('SELECT * FROM user_accounts WHERE google_id=?').bind(google_id).first();
  if (!row) {
    row = await env.DB.prepare('SELECT * FROM user_accounts WHERE phone=?').bind(email).first();
    if (!row) {
      const ref_code = 'G' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await env.DB.prepare(
        'INSERT INTO user_accounts (phone, name, google_id, ref_code, created_at) VALUES (?,?,?,?,datetime("now"))'
      ).bind(email, name, google_id, ref_code).run();
      row = await env.DB.prepare('SELECT * FROM user_accounts WHERE google_id=?').bind(google_id).first();
    } else {
      await env.DB.prepare('UPDATE user_accounts SET google_id=? WHERE phone=?').bind(google_id, email).run();
    }
  }
  return json(row);
}

async function getUserByPhone(request, env, path) {
  const phone = decodeURIComponent(path.split('/').pop());
  const row = await env.DB.prepare('SELECT * FROM user_accounts WHERE phone=?').bind(phone).first();
  if (!row) return err('Not found', 404);
  return json(row);
}

// ─────────────────────────────────────────────
// AD SUBMISSIONS
// ─────────────────────────────────────────────
async function listSubmissions(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const { results } = await env.DB.prepare(
    'SELECT * FROM ad_submissions WHERE status=? ORDER BY created_at DESC'
  ).bind(status).all();
  return json(results.map(parseSubmission));
}

async function createSubmission(request, env) {
  const body = await request.json();
  const row = {
    type: body.type, title: body.title, location: body.location,
    province: body.province, price: body.price,
    beds: body.beds, baths: body.baths, area: body.area, land: body.land,
    land_perches: body.land_perches || 0, img: body.img || 'img-custom',
    amenities: JSON.stringify(body.amenities || []),
    deed: body.deed, description: body.description,
    photos: body.photos ? JSON.stringify(body.photos) : null,
    status: 'pending',
    submitter_name: body.submitter_name, submitter_phone: body.submitter_phone,
    submitter_email: body.submitter_email || '',
    country: body.country || 'LK',
    package_name: body.package_name, package_price: body.package_price,
    payment_ref: body.payment_ref, ref_code: body.ref_code,
  };
  const cols = Object.keys(row);
  const vals = Object.values(row);
  await env.DB.prepare(
    `INSERT INTO ad_submissions (${cols.join(',')}, created_at) VALUES (${cols.map(() => '?').join(',')}, datetime('now'))`
  ).bind(...vals).run();
  const inserted = await env.DB.prepare('SELECT * FROM ad_submissions WHERE ref_code=? ORDER BY created_at DESC LIMIT 1').bind(body.ref_code).first();
  return json(parseSubmission(inserted), 201);
}

async function approveSubmission(request, env, path) {
  const id = path.split('/')[3];
  const sub = await env.DB.prepare('SELECT * FROM ad_submissions WHERE id=?').bind(id).first();
  if (!sub) return err('Not found', 404);
  const s = parseSubmission(sub);
  await env.DB.prepare(
    `INSERT INTO properties (type,title,location,province,price,beds,baths,area,land,land_perches,img,amenities,deed,description,photos,badge,badge_key,listing_mode,country,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).bind(s.type, s.title, s.location, s.province, s.price, s.beds, s.baths, s.area, s.land, s.land_perches || 0,
    s.img || 'img-custom', JSON.stringify(s.amenities || []), s.deed, s.description,
    s.photos ? JSON.stringify(s.photos) : null, s.badge || null, s.badge_key || null,
    s.listing_mode || 'buy', s.country || 'LK').run();
  await env.DB.prepare('UPDATE ad_submissions SET status=? WHERE id=?').bind('approved', id).run();
  return json({ ok: true });
}

async function rejectSubmission(request, env, path) {
  const id = path.split('/')[3];
  await env.DB.prepare('UPDATE ad_submissions SET status=? WHERE id=?').bind('rejected', id).run();
  return json({ ok: true });
}

async function submissionsByRef(request, env, path) {
  const ref = decodeURIComponent(path.split('/').pop());
  const { results } = await env.DB.prepare(
    'SELECT * FROM ad_submissions WHERE ref_code=? ORDER BY created_at DESC'
  ).bind(ref).all();
  return json(results.map(parseSubmission));
}

function parseSubmission(r) {
  if (!r) return null;
  return {
    ...r,
    amenities: tryParse(r.amenities, []),
    photos: tryParse(r.photos, null),
    price: Number(r.price),
  };
}

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────
async function getSettings(request, env) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key="site_settings"').first();
  return json(row ? JSON.parse(row.value) : {});
}

async function putSettings(request, env) {
  const body = await request.json();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES ("site_settings", ?)'
  ).bind(JSON.stringify(body)).run();
  return json({ ok: true });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function tryParse(v, fallback) {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
