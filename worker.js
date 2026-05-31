/**
 * vino.properties — Cloudflare Worker
 * Bindings needed in wrangler.toml:
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "vino_db"
 *   database_id = "YOUR_D1_DATABASE_ID"
 *
 *   [[r2_buckets]]
 *   binding = "PHOTOS"
 *   bucket_name = "vino-photos"
 *
 * Environment variables (set in CF dashboard or wrangler.toml [vars]):
 *   ADMIN_SECRET = "your-secret-admin-token"
 *
 * D1 schema (run once via `wrangler d1 execute vino_db --file=schema.sql`):
 *   See bottom of this file for CREATE TABLE statements.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
function isAdmin(req, env) {
  return req.headers.get('X-Admin-Secret') === env.ADMIN_SECRET;
}

// ─────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── HEALTH CHECK ─────────────────────────────
    if (path === '/' || path === '/health') {
      try {
        await env.DB.prepare('SELECT 1').run();
        return json({ ok: true, db: 'connected' });
      } catch (e) {
        return json({ ok: false, db: e.message }, 500);
      }
    }

    try {

    // ── PROPERTIES ──────────────────────────────
    if (path === '/properties' && method === 'GET') {
      return getProperties(env);
    }
    if (path === '/properties' && method === 'POST') {
      return createProperty(req, env);
    }
    const propMatch = path.match(/^\/properties\/(\d+)$/);
    if (propMatch) {
      const id = propMatch[1];
      if (method === 'PATCH') return updateProperty(id, req, env);
      if (method === 'DELETE') return deleteProperty(id, req, env);
    }
    const boostMatch = path.match(/^\/properties\/(\d+)\/boost$/);
    if (boostMatch && method === 'PATCH') {
      return boostProperty(boostMatch[1], req, env);
    }
    if (path === '/properties/by_title_loc' && method === 'PATCH') {
      return updateByTitleLoc(req, env);
    }

    // ── AD SUBMISSIONS ───────────────────────────
    if (path === '/ad_submissions' && method === 'GET') {
      return getSubmissions(url, env);
    }
    if (path === '/ad_submissions' && method === 'POST') {
      return createSubmission(req, env);
    }
    const subMatch = path.match(/^\/ad_submissions\/(\d+)$/);
    if (subMatch && method === 'PATCH') {
      return updateSubmission(subMatch[1], req, env);
    }
    const subRefMatch = path.match(/^\/ad_submissions\/by_ref\/(.+)$/);
    if (subRefMatch && method === 'GET') {
      return getSubmissionByRef(subRefMatch[1], env);
    }

    // ── USER ACCOUNTS ────────────────────────────
    if (path === '/user_accounts/upsert' && method === 'POST') {
      return upsertUserAccount(req, env);
    }
    if (path === '/user_accounts/login' && method === 'POST') {
      return loginUser(req, env);
    }

    // ── PHOTO UPLOAD (R2) ────────────────────────
    if (path === '/photos/upload' && method === 'POST') {
      return uploadPhoto(req, env);
    }
    if (path.startsWith('/photos/') && method === 'GET') {
      return getPhoto(path.replace('/photos/', ''), env);
    }

    return err('Not found', 404);

    } catch (e) {
      console.error(e);
      return err('Server error: ' + e.message, 500);
    }
  },
};

// ─────────────────────────────────────────────
// PROPERTIES
// ─────────────────────────────────────────────
async function getProperties(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM properties ORDER BY boosted DESC, created_at DESC'
  ).all();
  // Parse JSON fields
  const props = results.map(parsePropertyRow);
  return json(props);
}

async function createProperty(req, env) {
  const body = await req.json();
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(`
    INSERT INTO properties
      (type,title,location,province,price,beds,baths,area,land,land_perches,
       img,amenities,deed,badge,badge_key,description,photos,link,listing_mode,country,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const r = await stmt.bind(
    body.type||'house', body.title||'', body.location||'', body.province||'',
    body.price||0, body.beds||0, body.baths||0,
    body.area||'—', body.land||'—', body.land_perches||0,
    body.img||'img-custom',
    JSON.stringify(body.amenities||[]),
    body.deed||'freehold', body.badge||null, body.badge_key||null,
    body.description||'',
    body.photos ? JSON.stringify(body.photos) : null,
    body.link||null, body.listing_mode||'buy', body.country||'LK',
    now
  ).run();
  return json({ id: r.meta.last_row_id, created_at: now }, 201);
}

async function updateProperty(id, req, env) {
  const body = await req.json();
  const fields = [];
  const values = [];
  const allowed = ['type','title','location','province','price','beds','baths',
    'area','land','land_perches','img','deed','badge','badge_key','description',
    'link','listing_mode','country','created_at','views'];
  const jsonFields = ['amenities','photos'];

  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); values.push(body[k]); }
  }
  for (const k of jsonFields) {
    if (k in body) { fields.push(`${k}=?`); values.push(JSON.stringify(body[k])); }
  }
  if (!fields.length) return err('Nothing to update');
  values.push(id);
  await env.DB.prepare(`UPDATE properties SET ${fields.join(',')} WHERE id=?`)
    .bind(...values).run();
  return json({ ok: true });
}

async function deleteProperty(id, req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await env.DB.prepare('DELETE FROM properties WHERE id=?').bind(id).run();
  return json({ ok: true });
}

async function boostProperty(id, req, env) {
  const body = await req.json();
  await env.DB.prepare(
    'UPDATE properties SET boosted=1,boosted_until=?,boosted_days=? WHERE id=?'
  ).bind(body.boosted_until, body.boosted_days||0, id).run();
  return json({ ok: true });
}

async function updateByTitleLoc(req, env) {
  const body = await req.json();
  const { title, location, data } = body;
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    fields.push(`${k}=?`);
    values.push(v);
  }
  if (!fields.length) return err('Nothing to update');
  values.push(title, location);
  await env.DB.prepare(
    `UPDATE properties SET ${fields.join(',')} WHERE title=? AND location=?`
  ).bind(...values).run();
  return json({ ok: true });
}

function parsePropertyRow(r) {
  return {
    ...r,
    amenities: tryParse(r.amenities, []),
    photos: tryParse(r.photos, []),
    boosted: !!r.boosted,
  };
}

// ─────────────────────────────────────────────
// AD SUBMISSIONS
// ─────────────────────────────────────────────
async function getSubmissions(url, env) {
  const status = url.searchParams.get('status');
  const ref = url.searchParams.get('ref_code');
  let query = 'SELECT * FROM ad_submissions';
  const params = [];
  const conditions = [];
  if (status) { conditions.push('status=?'); params.push(status); }
  if (ref) { conditions.push('ref_code=?'); params.push(ref); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC';
  const { results } = await env.DB.prepare(query).bind(...params).all();
  const rows = results.map(r => ({
    ...r,
    amenities: tryParse(r.amenities, []),
    photos: tryParse(r.photos, null),
  }));
  return json(rows);
}

async function createSubmission(req, env) {
  const b = await req.json();
  const now = new Date().toISOString();
  const r = await env.DB.prepare(`
    INSERT INTO ad_submissions
      (type,title,location,province,price,beds,baths,area,land,land_perches,
       img,amenities,deed,description,photos,submitter_name,submitter_phone,
       submitter_email,country,package_name,package_price,payment_ref,ref_code,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)
  `).bind(
    b.type||'house', b.title||'', b.location||'', b.province||'',
    b.price||0, b.beds||0, b.baths||0,
    b.area||'—', b.land||'—', b.land_perches||0,
    b.img||'img-custom',
    JSON.stringify(b.amenities||[]),
    b.deed||'freehold', b.description||'',
    b.photos ? JSON.stringify(b.photos) : null,
    b.submitter_name||'', b.submitter_phone||'', b.submitter_email||'',
    b.country||'LK', b.package_name||'Basic', b.package_price||'LKR 2,900',
    b.payment_ref||'', b.ref_code||'',
    now
  ).run();
  return json({ id: r.meta.last_row_id }, 201);
}

async function updateSubmission(id, req, env) {
  const body = await req.json();
  const allowed = ['status'];
  const fields = [];
  const values = [];
  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); values.push(body[k]); }
  }
  if (!fields.length) return err('Nothing to update');
  values.push(id);
  await env.DB.prepare(`UPDATE ad_submissions SET ${fields.join(',')} WHERE id=?`)
    .bind(...values).run();
  return json({ ok: true });
}

async function getSubmissionByRef(ref, env) {
  const row = await env.DB.prepare(
    'SELECT * FROM ad_submissions WHERE ref_code=? ORDER BY created_at DESC LIMIT 1'
  ).bind(ref).first();
  if (!row) return err('Not found', 404);
  return json({ ...row, amenities: tryParse(row.amenities, []), photos: tryParse(row.photos, null) });
}

// ─────────────────────────────────────────────
// USER ACCOUNTS
// ─────────────────────────────────────────────
async function upsertUserAccount(req, env) {
  const { phone, name, password, ref_code } = await req.json();
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT id FROM user_accounts WHERE phone=?').bind(phone).first();
  if (existing) {
    await env.DB.prepare('UPDATE user_accounts SET password=?,ref_code=? WHERE phone=?')
      .bind(password, ref_code, phone).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO user_accounts (phone,name,password,ref_code,created_at) VALUES (?,?,?,?,?)'
    ).bind(phone, name||'', password, ref_code, now).run();
  }
  return json({ ok: true });
}

async function loginUser(req, env) {
  const { phone, pw } = await req.json();
  const user = await env.DB.prepare(
    'SELECT * FROM user_accounts WHERE phone=? AND password=?'
  ).bind(phone, pw).first();
  if (!user) return err('Invalid credentials', 401);
  return json(user);
}

// ─────────────────────────────────────────────
// PHOTO UPLOAD — R2
// ─────────────────────────────────────────────
async function uploadPhoto(req, env) {
  const formData = await req.formData();
  const file = formData.get('file');
  if (!file) return err('No file');
  const key = `photos/${Date.now()}-${file.name}`;
  await env.PHOTOS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
  // Public URL assumes R2 public bucket or custom domain:
  const photoUrl = `https://photos.vino.properties/${key}`;
  return json({ url: photoUrl, key }, 201);
}

async function getPhoto(key, env) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return err('Not found', 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000',
      ...CORS,
    },
  });
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function tryParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

/* ═══════════════════════════════════════════════
   SCHEMA — save as schema.sql and run:
   wrangler d1 execute vino_db --file=schema.sql
   ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS properties (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    DEFAULT 'house',
  title           TEXT    NOT NULL,
  location        TEXT    DEFAULT '',
  province        TEXT    DEFAULT '',
  price           INTEGER DEFAULT 0,
  beds            INTEGER DEFAULT 0,
  baths           INTEGER DEFAULT 0,
  area            TEXT    DEFAULT '—',
  land            TEXT    DEFAULT '—',
  land_perches    INTEGER DEFAULT 0,
  img             TEXT    DEFAULT 'img-custom',
  amenities       TEXT    DEFAULT '[]',
  deed            TEXT    DEFAULT 'freehold',
  badge           TEXT,
  badge_key       TEXT,
  description     TEXT    DEFAULT '',
  photos          TEXT,
  link            TEXT,
  listing_mode    TEXT    DEFAULT 'buy',
  country         TEXT    DEFAULT 'LK',
  views           INTEGER DEFAULT 1,
  boosted         INTEGER DEFAULT 0,
  boosted_until   TEXT,
  boosted_days    INTEGER DEFAULT 0,
  created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ad_submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    DEFAULT 'house',
  title           TEXT    DEFAULT '',
  location        TEXT    DEFAULT '',
  province        TEXT    DEFAULT '',
  price           INTEGER DEFAULT 0,
  beds            INTEGER DEFAULT 0,
  baths           INTEGER DEFAULT 0,
  area            TEXT    DEFAULT '—',
  land            TEXT    DEFAULT '—',
  land_perches    INTEGER DEFAULT 0,
  img             TEXT    DEFAULT 'img-custom',
  amenities       TEXT    DEFAULT '[]',
  deed            TEXT    DEFAULT 'freehold',
  description     TEXT    DEFAULT '',
  photos          TEXT,
  submitter_name  TEXT    DEFAULT '',
  submitter_phone TEXT    DEFAULT '',
  submitter_email TEXT    DEFAULT '',
  country         TEXT    DEFAULT 'LK',
  package_name    TEXT    DEFAULT 'Basic',
  package_price   TEXT    DEFAULT 'LKR 2,900',
  payment_ref     TEXT    DEFAULT '',
  ref_code        TEXT    DEFAULT '',
  status          TEXT    DEFAULT 'pending',
  created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON ad_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_ref ON ad_submissions(ref_code);

CREATE TABLE IF NOT EXISTS user_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT    UNIQUE NOT NULL,
  name        TEXT    DEFAULT '',
  password    TEXT    DEFAULT '',
  ref_code    TEXT    DEFAULT '',
  created_at  TEXT    DEFAULT (datetime('now'))
);
*/
