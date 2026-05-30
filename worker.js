// ============================================================
// vino.properties — Cloudflare Worker (D1 Backend)
// ============================================================
// Bind your D1 database as DB in wrangler.toml:
//   [[d1_databases]]
//   binding = "DB"
//   database_name = "vino-db"
//   database_id   = "YOUR_DATABASE_ID"
//
// Set these secrets with: wrangler secret put ADMIN_PASSWORD
//   ADMIN_PASSWORD  — admin panel password
//   ADMIN_PHONE     — admin phone number
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// ── ROUTER ──────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, ''); // strip trailing slash
    const method = request.method.toUpperCase();

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── PROPERTIES ──
    if (path === '/api/properties') {
      if (method === 'GET')    return getProperties(request, env);
      if (method === 'POST')   return createProperty(request, env);
    }
    if (path.startsWith('/api/properties/')) {
      const id = path.split('/').pop();
      if (method === 'PUT')    return updateProperty(request, env, id);
      if (method === 'DELETE') return deleteProperty(request, env, id);
    }

    // ── USER ACCOUNTS ──
    if (path === '/api/users/register') {
      if (method === 'POST')   return registerUser(request, env);
    }
    if (path === '/api/users/login') {
      if (method === 'POST')   return loginUser(request, env);
    }

    // ── AD SUBMISSIONS ──
    if (path === '/api/submissions') {
      if (method === 'GET')    return getSubmissions(request, env);
      if (method === 'POST')   return createSubmission(request, env);
    }
    if (path.startsWith('/api/submissions/')) {
      const id = path.split('/').pop();
      if (method === 'PUT')    return updateSubmission(request, env, id);
    }
    if (path === '/api/submissions/by-ref') {
      if (method === 'GET')    return getSubmissionsByRef(request, env);
    }

    // ── BOOST ──
    if (path.startsWith('/api/properties/') && path.endsWith('/boost')) {
      const id = path.split('/')[3]; // /api/properties/:id/boost
      if (method === 'PUT')    return boostProperty(request, env, id);
    }

    return err('Not found', 404);
  },
};

// ============================================================
// HELPERS
// ============================================================

function parseJSON(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
}

function rowToProperty(r) {
  return {
    id:           r.id,
    type:         r.type         || 'house',
    title:        r.title        || '',
    location:     r.location     || '',
    province:     r.province     || '',
    country:      r.country      || 'LK',
    price:        r.price        || 0,
    beds:         r.beds         || 0,
    baths:        r.baths        || 0,
    area:         r.area         || '—',
    land:         r.land         || '—',
    land_perches: r.land_perches || 0,
    img:          r.img          || 'img-custom',
    amenities:    parseJSON(r.amenities),
    deed:         r.deed         || 'freehold',
    badge:        r.badge        || null,
    badge_key:    r.badge_key    || null,
    description:  r.description  || '',
    photos:       parseJSON(r.photos),
    link:         r.link         || null,
    listing_mode: r.listing_mode || 'buy',
    views:        r.views        || 1,
    boosted:      !!r.boosted,
    boosted_until: r.boosted_until || null,
    boosted_days:  r.boosted_days  || 0,
    created_at:   r.created_at,
  };
}

// ============================================================
// PROPERTIES
// ============================================================

async function getProperties(request, env) {
  const url     = new URL(request.url);
  const mode    = url.searchParams.get('mode');    // buy | rent
  const country = url.searchParams.get('country'); // LK | MV | AE …
  const type    = url.searchParams.get('type');    // house | land …

  let query = 'SELECT * FROM properties WHERE 1=1';
  const params = [];

  if (mode)    { query += ' AND listing_mode = ?'; params.push(mode); }
  if (country) { query += ' AND country = ?';      params.push(country); }
  if (type && type !== 'all') { query += ' AND type = ?'; params.push(type); }

  // Boosted first, then newest
  query += ' ORDER BY boosted DESC, created_at DESC';

  const { results, error } = await env.DB.prepare(query).bind(...params).all();
  if (error) return err(error, 500);

  return json({ data: results.map(rowToProperty) });
}

async function createProperty(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON');
  if (!body.title || !body.price || !body.location) {
    return err('title, price, and location are required');
  }

  const now = new Date().toISOString();
  const { error, meta } = await env.DB.prepare(`
    INSERT INTO properties
      (type,title,location,province,country,price,beds,baths,area,land,land_perches,
       img,amenities,deed,badge,badge_key,description,photos,link,listing_mode,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    body.type         || 'house',
    body.title,
    body.location,
    body.province     || '',
    body.country      || 'LK',
    body.price,
    body.beds         || 0,
    body.baths        || 0,
    body.area         || '—',
    body.land         || '—',
    body.land_perches || 0,
    body.img          || 'img-custom',
    JSON.stringify(body.amenities || []),
    body.deed         || 'freehold',
    body.badge        || null,
    body.badge_key    || null,
    body.description  || '',
    body.photos ? JSON.stringify(body.photos) : null,
    body.link         || null,
    body.listing_mode || 'buy',
    now,
  ).run();

  if (error) return err(error, 500);
  return json({ data: { id: meta.last_row_id } }, 201);
}

async function updateProperty(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON');

  // Build dynamic SET clause from supplied fields
  const allowed = [
    'type','title','location','province','country','price','beds','baths',
    'area','land','land_perches','img','amenities','deed','badge','badge_key',
    'description','photos','link','listing_mode','views',
    'boosted','boosted_until','boosted_days',
  ];
  const sets   = [];
  const params = [];

  for (const key of allowed) {
    if (!(key in body)) continue;
    sets.push(`${key} = ?`);
    if (key === 'amenities' || key === 'photos') {
      params.push(body[key] ? JSON.stringify(body[key]) : null);
    } else if (key === 'boosted') {
      params.push(body[key] ? 1 : 0);
    } else {
      params.push(body[key]);
    }
  }

  if (sets.length === 0) return err('No valid fields to update');
  params.push(id);

  const { error } = await env.DB.prepare(
    `UPDATE properties SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...params).run();

  if (error) return err(error, 500);
  return json({ data: { id } });
}

async function deleteProperty(request, env, id) {
  const { error } = await env.DB.prepare(
    'DELETE FROM properties WHERE id = ?'
  ).bind(id).run();
  if (error) return err(error, 500);
  return json({ data: { id } });
}

async function boostProperty(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const days = parseInt(body.days) || 7;
  const until = new Date(Date.now() + days * 86400000).toISOString();

  const { error } = await env.DB.prepare(`
    UPDATE properties SET boosted=1, boosted_until=?, boosted_days=? WHERE id=?
  `).bind(until, days, id).run();

  if (error) return err(error, 500);
  return json({ data: { id, boosted_until: until, boosted_days: days } });
}

// ============================================================
// USER ACCOUNTS
// ============================================================

async function registerUser(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON');
  const { phone, name, password, ref_code } = body;
  if (!phone || !ref_code) return err('phone and ref_code are required');

  // Upsert — update if phone exists, insert otherwise
  const { results } = await env.DB.prepare(
    'SELECT id FROM user_accounts WHERE phone = ?'
  ).bind(phone).all();

  const now = new Date().toISOString();
  if (results.length > 0) {
    await env.DB.prepare(
      'UPDATE user_accounts SET password=?, ref_code=? WHERE phone=?'
    ).bind(password || '', ref_code, phone).run();
    return json({ data: { phone, ref_code, updated: true } });
  }

  const { error, meta } = await env.DB.prepare(`
    INSERT INTO user_accounts (phone, name, password, ref_code, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(phone, name || '', password || '', ref_code, now).run();

  if (error) return err(error, 500);
  return json({ data: { id: meta.last_row_id, phone, ref_code } }, 201);
}

async function loginUser(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON');
  const { phone, password } = body;
  if (!phone || !password) return err('phone and password are required');

  const { results } = await env.DB.prepare(
    'SELECT * FROM user_accounts WHERE phone=? AND password=? LIMIT 1'
  ).bind(phone, password).all();

  if (!results.length) return err('Invalid phone or password', 401);
  const u = results[0];
  return json({ data: { id: u.id, phone: u.phone, name: u.name, ref_code: u.ref_code } });
}

// ============================================================
// AD SUBMISSIONS
// ============================================================

async function getSubmissions(request, env) {
  const url    = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';

  const { results, error } = await env.DB.prepare(
    'SELECT * FROM ad_submissions WHERE status=? ORDER BY created_at DESC'
  ).bind(status).all();

  if (error) return err(error, 500);

  const data = results.map(r => ({
    ...r,
    amenities: parseJSON(r.amenities),
    photos:    parseJSON(r.photos),
  }));
  return json({ data });
}

async function getSubmissionsByRef(request, env) {
  const url      = new URL(request.url);
  const ref_code = url.searchParams.get('ref_code');
  if (!ref_code) return err('ref_code query param required');

  const { results, error } = await env.DB.prepare(
    'SELECT * FROM ad_submissions WHERE ref_code=? ORDER BY created_at DESC'
  ).bind(ref_code).all();

  if (error) return err(error, 500);
  return json({ data: results.map(r => ({ ...r, amenities: parseJSON(r.amenities), photos: parseJSON(r.photos) })) });
}

async function createSubmission(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON');

  const now = new Date().toISOString();
  const { error, meta } = await env.DB.prepare(`
    INSERT INTO ad_submissions
      (type,title,location,province,country,price,beds,baths,area,land,land_perches,
       img,amenities,deed,listing_mode,badge,badge_key,description,photos,
       status,submitter_name,submitter_phone,submitter_email,
       ref_code,package_name,package_price,payment_ref,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    body.type             || 'house',
    body.title            || '',
    body.location         || '',
    body.province         || '',
    body.country          || 'LK',
    body.price            || 0,
    body.beds             || 0,
    body.baths            || 0,
    body.area             || '—',
    body.land             || '—',
    body.land_perches     || 0,
    body.img              || 'img-custom',
    JSON.stringify(body.amenities || []),
    body.deed             || 'freehold',
    body.listing_mode     || 'buy',
    body.badge            || null,
    body.badge_key        || null,
    body.description      || '',
    body.photos ? JSON.stringify(body.photos) : null,
    'pending',
    body.submitter_name   || '',
    body.submitter_phone  || '',
    body.submitter_email  || '',
    body.ref_code         || '',
    body.package_name     || 'basic',
    body.package_price    || 'LKR 500',
    body.payment_ref      || '',
    now,
  ).run();

  if (error) return err(error, 500);
  return json({ data: { id: meta.last_row_id } }, 201);
}

async function updateSubmission(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.status) return err('status is required');

  // If approving — publish to properties table
  if (body.status === 'approved') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM ad_submissions WHERE id=? LIMIT 1'
    ).bind(id).all();

    if (!results.length) return err('Submission not found', 404);
    const sub = results[0];
    const now  = new Date().toISOString();

    const { error: insErr } = await env.DB.prepare(`
      INSERT INTO properties
        (type,title,location,province,country,price,beds,baths,area,land,land_perches,
         img,amenities,deed,badge,badge_key,description,photos,listing_mode,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      sub.type, sub.title, sub.location, sub.province,
      sub.country || 'LK', sub.price, sub.beds, sub.baths,
      sub.area, sub.land, sub.land_perches, sub.img || 'img-custom',
      sub.amenities || '[]', sub.deed,
      sub.badge || null, sub.badge_key || null,
      sub.description, sub.photos || null,
      sub.listing_mode || 'buy', now,
    ).run();

    if (insErr) return err(insErr, 500);
  }

  const { error } = await env.DB.prepare(
    'UPDATE ad_submissions SET status=? WHERE id=?'
  ).bind(body.status, id).run();

  if (error) return err(error, 500);
  return json({ data: { id, status: body.status } });
}
