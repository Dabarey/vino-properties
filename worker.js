// ══════════════════════════════════════════
// vino-api — Cloudflare Worker
// Bindings: DB (D1), PHOTOS (R2)
// ══════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const err = (msg, status = 400) => json({ error: msg }, status);

// ── ADMIN KEY (set as Worker secret: wrangler secret put ADMIN_KEY) ──
const checkAdmin = (req, env) => req.headers.get('X-Admin-Key') === env.ADMIN_KEY;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Preflight
    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── ROUTES ──

    // GET /api/properties
    if (path === '/api/properties' && method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT * FROM properties ORDER BY boosted DESC, created_at DESC`
      ).all();
      // Parse JSON fields
      const props = results.map(r => ({
        ...r,
        amenities: safeJson(r.amenities, []),
        photos: safeJson(r.photos, []),
      }));
      return json(props);
    }

    // POST /api/properties (admin)
    if (path === '/api/properties' && method === 'POST') {
      if (!checkAdmin(request, env)) return err('Unauthorized', 401);
      const b = await request.json();
      const stmt = env.DB.prepare(`
        INSERT INTO properties (type,title,location,province,price,beds,baths,area,land,land_perches,
          img,amenities,deed,badge,badge_key,description,photos,link,listing_mode,country,
          boosted,boosted_until,boosted_days,views,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,null,0,1,datetime('now'))
      `).bind(
        b.type||'house', b.title||'', b.location||'', b.province||'',
        b.price||0, b.beds||0, b.baths||0, b.area||'—', b.land||'—', b.land_perches||0,
        b.img||'img-custom', JSON.stringify(b.amenities||[]),
        b.deed||'freehold', b.badge||null, b.badge_key||null, b.description||'',
        JSON.stringify(b.photos||[]), b.link||null,
        b.listing_mode||'buy', b.country||'LK'
      );
      const res = await stmt.run();
      return json({ id: res.meta.last_row_id });
    }

    // PUT /api/properties/:id (admin)
    if (path.startsWith('/api/properties/') && method === 'PUT') {
      if (!checkAdmin(request, env)) return err('Unauthorized', 401);
      const id = path.split('/')[3];
      const b = await request.json();
      await env.DB.prepare(`
        UPDATE properties SET type=?,title=?,location=?,province=?,price=?,beds=?,baths=?,
          area=?,land=?,land_perches=?,img=?,amenities=?,deed=?,badge=?,badge_key=?,
          description=?,photos=?,link=?,listing_mode=?,country=?,
          boosted=?,boosted_until=?,boosted_days=?
        WHERE id=?
      `).bind(
        b.type||'house', b.title||'', b.location||'', b.province||'',
        b.price||0, b.beds||0, b.baths||0, b.area||'—', b.land||'—', b.land_perches||0,
        b.img||'img-custom', JSON.stringify(b.amenities||[]),
        b.deed||'freehold', b.badge||null, b.badge_key||null, b.description||'',
        JSON.stringify(b.photos||[]), b.link||null,
        b.listing_mode||'buy', b.country||'LK',
        b.boosted?1:0, b.boosted_until||null, b.boosted_days||0,
        id
      ).run();
      return json({ ok: true });
    }

    // DELETE /api/properties/:id (admin)
    if (path.startsWith('/api/properties/') && method === 'DELETE') {
      if (!checkAdmin(request, env)) return err('Unauthorized', 401);
      const id = path.split('/')[3];
      await env.DB.prepare(`DELETE FROM properties WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }

    // PUT /api/properties/:id/boost (admin)
    if (path.startsWith('/api/properties/') && path.endsWith('/boost') && method === 'PUT') {
      if (!checkAdmin(request, env)) return err('Unauthorized', 401);
      const id = path.split('/')[3];
      const { days } = await request.json();
      const until = new Date();
      until.setDate(until.getDate() + days);
      await env.DB.prepare(`
        UPDATE properties SET boosted=1, boosted_until=?, boosted_days=? WHERE id=?
      `).bind(until.toISOString(), days, id).run();
      return json({ ok: true });
    }

    // ── AD SUBMISSIONS ──

    // GET /api/submissions?status=pending (admin)
    if (path === '/api/submissions' && method === 'GET') {
      if (!checkAdmin(request, env)) return err('Unauthorized', 401);
      const status = url.searchParams.get('status') || 'pending';
      const { results } = await env.DB.prepare(
        `SELECT * FROM ad_submissions WHERE status=? ORDER BY created_at DESC`
      ).bind(status).all();
      const subs = results.map(r => ({
        ...r,
        amenities: safeJson(r.amenities, []),
        photos: safeJson(r.photos, []),
      }));
      return json(subs);
    }

    // GET /api/submissions/user/:ref_code
    if (path.startsWith('/api/submissions/user/') && method === 'GET') {
      const refCode = path.split('/')[4];
      const { results } = await env.DB.prepare(
        `SELECT * FROM ad_submissions WHERE ref_code=? ORDER BY created_at DESC`
      ).bind(refCode).all();
      return json(results.map(r => ({ ...r, amenities: safeJson(r.amenities,[]), photos: safeJson(r.photos,[]) })));
    }

    // POST /api/submissions
    if (path === '/api/submissions' && method === 'POST') {
      const b = await request.json();
      const res = await env.DB.prepare(`
        INSERT INTO ad_submissions (type,title,location,province,price,beds,baths,area,land,land_perches,
          img,amenities,deed,description,photos,submitter_name,submitter_phone,submitter_email,
          country,package_name,package_price,payment_ref,ref_code,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',datetime('now'))
      `).bind(
        b.type||'house', b.title||'', b.location||'', b.province||'',
        b.price||0, b.beds||0, b.baths||0, b.area||'—', b.land||'—', b.land_perches||0,
        b.img||'img-custom', JSON.stringify(b.amenities||[]),
        b.deed||'freehold', b.description||'',
        JSON.stringify(b.photos||[]),
        b.submitter_name||'', b.submitter_phone||'', b.submitter_email||'',
        b.country||'LK', b.package_name||'Basic', b.package_price||'LKR 500',
        b.payment_ref||'', b.ref_code||''
      ).run();
      return json({ id: res.meta.last_row_id });
    }

    // PUT /api/submissions/:id/approve (admin)
    if (path.startsWith('/api/submissions/') && path.endsWith('/approve') && method === 'PUT') {
      if (!checkAdmin(request, env)) return err('Unauthorized', 401);
      const id = path.split('/')[3];
      const { results } = await env.DB.prepare(`SELECT * FROM ad_submissions WHERE id=?`).bind(id).all();
      const sub = results[0];
      if (!sub) return err('Not found', 404);
      const b = await request.json(); // pkgInfo { badge, badge_key }
      await env.DB.prepare(`
        INSERT INTO properties (type,title,location,province,price,beds,baths,area,land,land_perches,
          img,amenities,deed,badge,badge_key,description,photos,listing_mode,country,
          boosted,boosted_days,views,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,1,datetime('now'))
      `).bind(
        sub.type, sub.title, sub.location, sub.province,
        sub.price, sub.beds, sub.baths, sub.area, sub.land, sub.land_perches,
        sub.img||'img-custom', sub.amenities, sub.deed,
        b.badge||null, b.badge_key||null, sub.description,
        sub.photos, sub.listing_mode||'buy', sub.country||'LK'
      ).run();
      await env.DB.prepare(`UPDATE ad_submissions SET status='approved' WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }

    // PUT /api/submissions/:id/reject (admin)
    if (path.startsWith('/api/submissions/') && path.endsWith('/reject') && method === 'PUT') {
      if (!checkAdmin(request, env)) return err('Unauthorized', 401);
      const id = path.split('/')[3];
      await env.DB.prepare(`UPDATE ad_submissions SET status='rejected' WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }

    // ── USER ACCOUNTS ──

    // POST /api/users/register
    if (path === '/api/users/register' && method === 'POST') {
      const b = await request.json();
      const { results } = await env.DB.prepare(`SELECT * FROM user_accounts WHERE phone=?`).bind(b.phone).all();
      if (results[0]) {
        // Update
        await env.DB.prepare(`UPDATE user_accounts SET password=?,ref_code=? WHERE phone=?`)
          .bind(b.password, b.ref_code, b.phone).run();
        return json({ ...results[0], password: b.password, ref_code: b.ref_code });
      }
      const res = await env.DB.prepare(`
        INSERT INTO user_accounts (phone,name,password,ref_code,google_id,created_at)
        VALUES (?,?,?,?,?,datetime('now'))
      `).bind(b.phone, b.name||'', b.password||'', b.ref_code||'', b.google_id||null).run();
      const { results: r2 } = await env.DB.prepare(`SELECT * FROM user_accounts WHERE id=?`).bind(res.meta.last_row_id).all();
      return json(r2[0]);
    }

    // POST /api/users/login
    if (path === '/api/users/login' && method === 'POST') {
      const b = await request.json();
      const { results } = await env.DB.prepare(
        `SELECT * FROM user_accounts WHERE phone=? AND password=?`
      ).bind(b.phone, b.password).all();
      if (!results[0]) return err('Invalid credentials', 401);
      return json(results[0]);
    }

    // POST /api/users/google
    if (path === '/api/users/google' && method === 'POST') {
      const b = await request.json(); // { google_id, name, email }
      let { results } = await env.DB.prepare(`SELECT * FROM user_accounts WHERE google_id=?`).bind(b.google_id).all();
      let user = results[0];
      if (!user) {
        // Try by email/phone
        const r2 = await env.DB.prepare(`SELECT * FROM user_accounts WHERE phone=?`).bind(b.email).all();
        user = r2.results[0];
        if (user) {
          // Link google_id
          await env.DB.prepare(`UPDATE user_accounts SET google_id=? WHERE id=?`).bind(b.google_id, user.id).run();
          user.google_id = b.google_id;
        }
      }
      if (!user) {
        // Create
        const refCode = 'G-' + b.google_id.slice(-6).toUpperCase();
        const pw = Math.random().toString(36).slice(2, 8).toUpperCase();
        const res = await env.DB.prepare(`
          INSERT INTO user_accounts (phone,name,password,ref_code,google_id,created_at)
          VALUES (?,?,?,?,?,datetime('now'))
        `).bind(b.email, b.name, pw, refCode, b.google_id).run();
        const r3 = await env.DB.prepare(`SELECT * FROM user_accounts WHERE id=?`).bind(res.meta.last_row_id).all();
        user = r3.results[0];
      }
      return json(user);
    }

    // ── R2 PHOTO UPLOAD ──

    // POST /api/upload
    if (path === '/api/upload' && method === 'POST') {
      const form = await request.formData();
      const file = form.get('file');
      if (!file) return err('No file');
      const ext = file.name.split('.').pop().toLowerCase() || 'jpg';
      const key = `photos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      await env.PHOTOS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'image/jpeg' }
      });
      const publicUrl = `https://pub-e45aa5ed38ff4e71be091492151a09fc.r2.dev/${key}`;
      return json({ url: publicUrl, key });
    }

    return err('Not found', 404);
  }
};

function safeJson(val, def) {
  if (!val) return def;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return def; }
}
