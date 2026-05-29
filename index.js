// ============================================================
// vino.properties — Cloudflare Worker API (D1 backend)
//
// Replaces the Supabase data layer. Every endpoint the frontend
// needs is here. Bind your D1 database as `DB` and set the
// secrets ADMIN_PASSWORD and AUTH_SALT (see wrangler.toml + README).
// ============================================================

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(), ...extraHeaders },
  });

const cors = () => ({
  'Access-Control-Allow-Origin': '*',          // tighten to your Pages domain in prod
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
});

// --- password hashing (SHA-256 with a server-side salt) ---
async function hashPw(env, pw) {
  const data = new TextEncoder().encode(env.AUTH_SALT + ':' + pw);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- admin token: HMAC-ish derived from the admin password ---
async function adminToken(env) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('admin:' + env.AUTH_SALT + ':' + env.ADMIN_PASSWORD)
  );
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function requireAdmin(req, env) {
  const tok = req.headers.get('X-Admin-Token') || '';
  return tok && tok === (await adminToken(env));
}

// --- row shaping: parse JSON text columns, normalize booleans ---
function shapeProperty(r) {
  if (!r) return r;
  return {
    ...r,
    amenities: safeJson(r.amenities, []),
    photos: safeJson(r.photos, null),
    boosted: !!r.boosted,
  };
}
function safeJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
const enc = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// --- R2 helpers ---
// Decode a "data:<mime>;base64,<data>" string into { mime, bytes }.
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] || 'image/jpeg';
  const isB64 = !!m[2];
  const raw = m[3];
  let bytes;
  if (isB64) {
    const bin = atob(raw);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(raw));
  }
  return { mime, bytes };
}

// Build the public URL for a stored object.
// If PHOTO_BASE_URL is set (public bucket or custom domain) use it;
// otherwise fall back to serving through this Worker at /r2/<key> using
// the Worker's own origin (so the URL is absolute and works from the page).
function photoUrl(env, key, origin) {
  if (env.PHOTO_BASE_URL) {
    return env.PHOTO_BASE_URL.replace(/\/+$/, '') + '/' + key;
  }
  return (origin ? origin.replace(/\/+$/, '') : '') + '/r2/' + key;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash
    let body = {};
    if (req.method !== 'GET') {
      try { body = await req.json(); } catch { body = {}; }
    }

    try {
      // ---------- R2 PHOTO UPLOAD / SERVE ----------
      // Upload: accepts JSON { images: ["data:image/jpeg;base64,...", ...] }
      // Returns { urls: [...] }. Admin-only (only used from listing forms).
      if (path === '/api/upload' && req.method === 'POST') {
        if (!(await requireAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
        if (!env.BUCKET) return json({ error: 'R2 not configured' }, 500);
        const images = Array.isArray(body.images) ? body.images : [];
        if (!images.length) return json({ error: 'no images' }, 400);
        const urls = [];
        for (const dataUrl of images.slice(0, 3)) {
          const parsed = parseDataUrl(dataUrl);
          if (!parsed) continue;
          const ext = parsed.mime.split('/')[1] || 'jpg';
          const key = `photos/${Date.now()}-${crypto.randomUUID()}.${ext}`;
          await env.BUCKET.put(key, parsed.bytes, {
            httpMetadata: { contentType: parsed.mime },
          });
          urls.push(photoUrl(env, key, url.origin));
        }
        return json({ urls });
      }

      // Serve an object from R2 (used when PHOTO_BASE_URL is not a public bucket).
      // GET /r2/photos/<file>
      if (path.startsWith('/r2/') && req.method === 'GET') {
        if (!env.BUCKET) return json({ error: 'R2 not configured' }, 500);
        const key = decodeURIComponent(path.slice('/r2/'.length));
        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'not found' }, 404);
        const headers = new Headers(cors());
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(obj.body, { headers });
      }

      // ---------- PROPERTIES ----------
      if (path === '/api/properties' && req.method === 'GET') {
        const { results } = await env.DB
          .prepare('SELECT * FROM properties ORDER BY created_at DESC')
          .all();
        return json(results.map(shapeProperty));
      }

      if (path === '/api/properties' && req.method === 'POST') {
        if (!(await requireAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
        const id = await insertProperty(env, body);
        return json({ id });
      }

      if (path.startsWith('/api/properties/') && req.method === 'PUT') {
        if (!(await requireAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
        const id = path.split('/').pop();
        await updateProperty(env, id, body);
        return json({ ok: true });
      }

      if (path.startsWith('/api/properties/') && req.method === 'DELETE') {
        if (!(await requireAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM properties WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // ---------- AD SUBMISSIONS ----------
      if (path === '/api/submissions' && req.method === 'POST') {
        const id = await insertSubmission(env, body);
        return json({ id });
      }

      if (path === '/api/submissions/pending' && req.method === 'GET') {
        if (!(await requireAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
        const { results } = await env.DB
          .prepare("SELECT * FROM ad_submissions WHERE status='pending' ORDER BY created_at DESC")
          .all();
        return json(results.map(shapeProperty));
      }

      // submissions belonging to one ref_code (user dashboard)
      if (path === '/api/submissions/by-ref' && req.method === 'GET') {
        const ref = url.searchParams.get('ref_code') || '';
        const { results } = await env.DB
          .prepare('SELECT * FROM ad_submissions WHERE ref_code = ? ORDER BY created_at DESC')
          .bind(ref).all();
        return json(results.map(shapeProperty));
      }

      // approve -> insert into properties + mark approved
      if (path === '/api/submissions/approve' && req.method === 'POST') {
        if (!(await requireAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
        const sub = (await env.DB.prepare('SELECT * FROM ad_submissions WHERE id = ?')
          .bind(body.id).first());
        if (!sub) return json({ error: 'not found' }, 404);
        // Move any base64 photos in the submission into R2, keep existing URLs.
        let subPhotos = safeJson(sub.photos, null);
        if (Array.isArray(subPhotos) && subPhotos.length && env.BUCKET) {
          const out = [];
          for (const p of subPhotos.slice(0, 3)) {
            if (typeof p === 'string' && p.startsWith('data:')) {
              const parsed = parseDataUrl(p);
              if (!parsed) continue;
              const ext = parsed.mime.split('/')[1] || 'jpg';
              const key = `photos/${Date.now()}-${crypto.randomUUID()}.${ext}`;
              await env.BUCKET.put(key, parsed.bytes, { httpMetadata: { contentType: parsed.mime } });
              out.push(photoUrl(env, key, url.origin));
            } else {
              out.push(p);
            }
          }
          subPhotos = out;
        }
        const propId = await insertProperty(env, {
          type: sub.type, title: sub.title, location: sub.location, province: sub.province,
          price: sub.price, beds: sub.beds, baths: sub.baths, area: sub.area, land: sub.land,
          land_perches: sub.land_perches, img: sub.img || 'img-custom',
          amenities: safeJson(sub.amenities, []), deed: sub.deed,
          badge: body.badge || null, badge_key: body.badge_key || null,
          description: sub.description, photos: subPhotos,
          country: sub.country, listing_mode: 'buy',
        });
        await env.DB.prepare("UPDATE ad_submissions SET status='approved' WHERE id = ?")
          .bind(body.id).run();
        return json({ id: propId });
      }

      if (path === '/api/submissions/reject' && req.method === 'POST') {
        if (!(await requireAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
        await env.DB.prepare("UPDATE ad_submissions SET status='rejected' WHERE id = ?")
          .bind(body.id).run();
        return json({ ok: true });
      }

      // ---------- BOOST / REPOST ----------
      // looks up a property by title+location (matches original behavior)
      if (path === '/api/boost' && req.method === 'POST') {
        const { ref_code, type, days } = body;
        const sub = await env.DB.prepare('SELECT * FROM ad_submissions WHERE ref_code = ? LIMIT 1')
          .bind(ref_code).first();
        if (!sub) return json({ error: 'submission not found' }, 404);
        const prop = await env.DB
          .prepare('SELECT * FROM properties WHERE title = ? AND location = ? LIMIT 1')
          .bind(sub.title, sub.location).first();
        if (!prop) return json({ error: 'property not found' }, 404);
        if (type === 'repost') {
          await env.DB.prepare("UPDATE properties SET created_at = datetime('now') WHERE id = ?")
            .bind(prop.id).run();
        } else {
          const until = new Date(Date.now() + (days || 0) * 86400000).toISOString();
          await env.DB.prepare('UPDATE properties SET boosted=1, boosted_until=?, boosted_days=? WHERE id=?')
            .bind(until, days || 0, prop.id).run();
        }
        return json({ ok: true });
      }

      // ---------- USER ACCOUNTS ----------
      if (path === '/api/account/create' && req.method === 'POST') {
        const { phone, name, ref_code, password } = body;
        const pw = password || (Math.random().toString(36).slice(2, 5).toUpperCase()
          + Math.floor(100 + Math.random() * 900));
        const hash = await hashPw(env, pw);
        const existing = await env.DB.prepare('SELECT id FROM user_accounts WHERE phone = ?')
          .bind(phone).first();
        if (existing) {
          await env.DB.prepare('UPDATE user_accounts SET password_hash=?, ref_code=? WHERE phone=?')
            .bind(hash, ref_code, phone).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO user_accounts (phone, name, password_hash, ref_code) VALUES (?,?,?,?)'
          ).bind(phone, name || '', hash, ref_code).run();
        }
        return json({ password: pw }); // returned once so UI can show credentials
      }

      if (path === '/api/account/login' && req.method === 'POST') {
        const { phone, password } = body;
        const hash = await hashPw(env, password);
        const acct = await env.DB
          .prepare('SELECT id, phone, name, ref_code, created_at FROM user_accounts WHERE phone=? AND password_hash=?')
          .bind(phone, hash).first();
        if (!acct) return json({ error: 'invalid credentials' }, 401);
        return json(acct);
      }

      // ---------- ADMIN LOGIN ----------
      if (path === '/api/admin/login' && req.method === 'POST') {
        if ((body.password || '') !== env.ADMIN_PASSWORD) {
          return json({ error: 'invalid' }, 401);
        }
        return json({ token: await adminToken(env) });
      }

      return json({ error: 'not found', path }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};

// ---------- helpers: column-safe insert/update ----------
const PROP_COLS = [
  'type', 'title', 'location', 'province', 'price', 'beds', 'baths', 'area', 'land',
  'land_perches', 'img', 'amenities', 'deed', 'badge', 'badge_key', 'description',
  'link', 'photos', 'listing_mode', 'country', 'boosted', 'boosted_until', 'boosted_days',
];
const JSON_COLS = new Set(['amenities', 'photos']);

async function insertProperty(env, row) {
  const cols = [], vals = [], q = [];
  for (const c of PROP_COLS) {
    if (row[c] === undefined) continue;
    cols.push(c); q.push('?');
    vals.push(JSON_COLS.has(c) ? enc(row[c]) : (c === 'boosted' ? (row[c] ? 1 : 0) : row[c]));
  }
  const sql = `INSERT INTO properties (${cols.join(',')}) VALUES (${q.join(',')})`;
  const res = await env.DB.prepare(sql).bind(...vals).run();
  return res.meta.last_row_id;
}

async function updateProperty(env, id, row) {
  const sets = [], vals = [];
  for (const c of PROP_COLS) {
    if (row[c] === undefined) continue;
    sets.push(`${c} = ?`);
    vals.push(JSON_COLS.has(c) ? enc(row[c]) : (c === 'boosted' ? (row[c] ? 1 : 0) : row[c]));
  }
  if (!sets.length) return;
  vals.push(id);
  await env.DB.prepare(`UPDATE properties SET ${sets.join(',')} WHERE id = ?`).bind(...vals).run();
}

const SUB_COLS = [
  'type', 'title', 'location', 'province', 'price', 'beds', 'baths', 'area', 'land',
  'land_perches', 'img', 'amenities', 'deed', 'description', 'photos',
  'submitter_name', 'submitter_phone', 'submitter_email', 'country',
  'package_name', 'package_price', 'payment_ref', 'ref_code',
];
async function insertSubmission(env, row) {
  const cols = [], vals = [], q = [];
  for (const c of SUB_COLS) {
    if (row[c] === undefined) continue;
    cols.push(c); q.push('?');
    vals.push(JSON_COLS.has(c) ? enc(row[c]) : row[c]);
  }
  const sql = `INSERT INTO ad_submissions (${cols.join(',')}) VALUES (${q.join(',')})`;
  const res = await env.DB.prepare(sql).bind(...vals).run();
  return res.meta.last_row_id;
}
