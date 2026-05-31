/**
 * vino.properties — Cloudflare Worker
 * Bindings set in CF Dashboard (NOT in wrangler.toml):
 *   D1 Database  → bind as: DB
 *   R2 Bucket    → bind as: PHOTOS
 *   Variable     → R2_PUBLIC_URL = https://pub-XXXX.r2.dev
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const j = (d, s=200) => new Response(JSON.stringify(d), {
  status: s, headers: { ...CORS, 'Content-Type': 'application/json' }
});
const jErr = (msg, s=400) => j({ error: { message: msg } }, s);

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

function arr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return []; }
}

function refCode() {
  return 'VN' + Math.random().toString(36).slice(2,8).toUpperCase();
}

async function storePhotos(env, photos, prefix) {
  const base = (env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  const urls = [];
  for (let i = 0; i < (photos||[]).length; i++) {
    const p = photos[i];
    if (!p) continue;
    if (typeof p === 'string' && p.startsWith('http')) { urls.push(p); continue; }
    const m = String(p).match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) continue;
    const [, mime, b64] = m;
    const ext = mime.split('/')[1]?.replace('jpeg','jpg') || 'jpg';
    const key = `${prefix}-${Date.now()}-${i}.${ext}`;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: mime } });
    urls.push(`${base}/${key}`);
  }
  return urls;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    const m = req.method.toUpperCase();

    if (m === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── POST /api/photos ─────────────────────────────────────────────────
    if (p === '/api/photos' && m === 'POST') {
      const { photos=[], prefix='photo' } = await body(req);
      const urls = await storePhotos(env, photos, prefix);
      return j({ urls });
    }

    // ── GET /api/properties ──────────────────────────────────────────────
    if (p === '/api/properties' && m === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM properties ORDER BY boosted DESC, created_at DESC'
      ).all();
      return j({ data: results.map(r => ({...r, amenities:arr(r.amenities), photos:arr(r.photos)})) });
    }

    // ── POST /api/properties ─────────────────────────────────────────────
    if (p === '/api/properties' && m === 'POST') {
      const d = await body(req);
      const photos = await storePhotos(env, arr(d.photos), 'prop');
      const r = await env.DB.prepare(`
        INSERT INTO properties (type,title,location,province,price,beds,baths,
          area_num,area,land,land_perches,img,amenities,deed,badge,badge_key,
          description,photos,listing_mode,country,boosted,boosted_until,boosted_days)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        d.type||'house', d.title||'', d.location||'', d.province||null,
        +(d.price||0), +(d.beds||0), +(d.baths||0),
        +(d.area_num||d.areaNum||0), d.area||'—', d.land||'—',
        +(d.land_perches||d.lp||0), d.img||'img-custom',
        JSON.stringify(arr(d.amenities)),
        d.deed||'freehold', d.badge||null, d.badge_key||d.bk||null,
        d.description||d.desc||null,
        JSON.stringify(photos),
        d.listing_mode||d.mode||'buy', d.country||'LK',
        d.boosted?1:0, d.boosted_until||null, +(d.boosted_days||0)
      ).run();
      return j({ data: { id: r.meta.last_row_id } }, 201);
    }

    // ── /api/properties/:id ──────────────────────────────────────────────
    const pm = p.match(/^\/api\/properties\/(\d+)(\/.*)?$/);
    if (pm) {
      const id = +pm[1], sub = pm[2]||'';

      if (sub === '/boost' && m === 'POST') {
        const { days=7 } = await body(req);
        const until = new Date(Date.now() + +days*86400000).toISOString();
        await env.DB.prepare(
          'UPDATE properties SET boosted=1, boosted_until=?, boosted_days=? WHERE id=?'
        ).bind(until, +days, id).run();
        return j({ ok:true });
      }

      if (m === 'PUT') {
        const d = await body(req);
        const sets=[], vals=[];
        const fmap = {
          type:1,title:1,location:1,province:1,price:1,beds:1,baths:1,
          area:1,land:1,img:1,deed:1,badge:1,listing_mode:1,country:1,
          boosted:1,boosted_until:1,boosted_days:1
        };
        for (const [k,v] of Object.entries(d)) {
          if (k==='photos'||k==='amenities') continue;
          if (fmap[k]) { sets.push(`${k}=?`); vals.push(v); }
        }
        if (d.land_perches!==undefined){sets.push('land_perches=?');vals.push(+(d.land_perches));}
        if (d.lp!==undefined){sets.push('land_perches=?');vals.push(+(d.lp));}
        if (d.areaNum!==undefined){sets.push('area_num=?');vals.push(+(d.areaNum));}
        if (d.badge_key!==undefined){sets.push('badge_key=?');vals.push(d.badge_key);}
        if (d.bk!==undefined){sets.push('badge_key=?');vals.push(d.bk);}
        if (d.description!==undefined||d.desc!==undefined){sets.push('description=?');vals.push(d.description??d.desc);}
        if (d.amenities!==undefined){sets.push('amenities=?');vals.push(JSON.stringify(arr(d.amenities)));}
        if (d.photos!==undefined){
          const urls=await storePhotos(env,arr(d.photos),`prop-${id}`);
          sets.push('photos=?');vals.push(JSON.stringify(urls));
        }
        sets.push("created_at=datetime('now')");
        vals.push(id);
        if (sets.length>1) await env.DB.prepare(`UPDATE properties SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
        return j({ ok:true });
      }

      if (m === 'DELETE') {
        await env.DB.prepare('DELETE FROM properties WHERE id=?').bind(id).run();
        return j({ ok:true });
      }
    }

    // ── GET /api/submissions ─────────────────────────────────────────────
    if (p === '/api/submissions' && m === 'GET') {
      const { results } = await env.DB.prepare(
        "SELECT * FROM ad_submissions WHERE status='pending' ORDER BY created_at DESC"
      ).all();
      return j({ data: results.map(r=>({...r, amenities:arr(r.amenities), photos:arr(r.photos)})) });
    }

    // ── POST /api/submissions ────────────────────────────────────────────
    if (p === '/api/submissions' && m === 'POST') {
      const d = await body(req);
      const photos = await storePhotos(env, arr(d.photos), 'sub');
      const r = await env.DB.prepare(`
        INSERT INTO ad_submissions (ref_code,submitter_name,submitter_phone,type,title,
          location,province,price,beds,baths,area,land,land_perches,img,amenities,deed,
          description,photos,listing_mode,country,package_name,package_price,payment_ref,
          badge,badge_key,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')
      `).bind(
        d.ref_code||null,
        d.submitter_name||d.name||null,
        d.submitter_phone||d.phone||null,
        d.type||'house', d.title||'', d.location||'', d.province||null,
        +(d.price||0), +(d.beds||0), +(d.baths||0),
        d.area||'—', d.land||'—', +(d.land_perches||0),
        d.img||'img-custom',
        JSON.stringify(arr(d.amenities)),
        d.deed||'freehold',
        d.description||null,
        JSON.stringify(photos),
        d.listing_mode||d.mode||'buy', d.country||'LK',
        d.package_name||null, +(d.package_price||0), d.payment_ref||null,
        d.badge||null, d.badge_key||null
      ).run();
      return j({ data: { id: r.meta.last_row_id } }, 201);
    }

    // ── POST /api/submissions/:id/approve|reject ─────────────────────────
    const sm = p.match(/^\/api\/submissions\/(\d+)\/(approve|reject)$/);
    if (sm && m === 'POST') {
      const id = +sm[1], action = sm[2];
      const status = action==='approve'?'approved':'rejected';
      await env.DB.prepare('UPDATE ad_submissions SET status=? WHERE id=?').bind(status,id).run();
      if (action==='approve') {
        const sub = await env.DB.prepare('SELECT * FROM ad_submissions WHERE id=?').bind(id).first();
        if (sub) await env.DB.prepare(`
          INSERT INTO properties (type,title,location,province,price,beds,baths,area,land,
            land_perches,img,amenities,deed,badge,badge_key,description,photos,listing_mode,country)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          sub.type, sub.title, sub.location, sub.province,
          sub.price, sub.beds, sub.baths, sub.area, sub.land, sub.land_perches,
          sub.img||'img-custom', sub.amenities, sub.deed,
          sub.badge, sub.badge_key, sub.description,
          sub.photos, sub.listing_mode||'buy', sub.country||'LK'
        ).run();
      }
      return j({ ok:true });
    }

    // ── POST /api/users/register ─────────────────────────────────────────
    if (p === '/api/users/register' && m === 'POST') {
      const { phone, name, password, ref_code } = await body(req);
      if (!phone) return jErr('phone required');
      const existing = await env.DB.prepare(
        'SELECT * FROM user_accounts WHERE phone=?'
      ).bind(phone).first();
      if (existing) {
        if (password) await env.DB.prepare(
          'UPDATE user_accounts SET password=? WHERE phone=?'
        ).bind(password,phone).run();
        return j({ data: existing });
      }
      const ref = ref_code || refCode();
      const r = await env.DB.prepare(
        'INSERT INTO user_accounts (phone,name,password,ref_code) VALUES (?,?,?,?)'
      ).bind(phone, name||null, password||null, ref).run();
      return j({ data:{ id:r.meta.last_row_id, phone, name, ref_code:ref } }, 201);
    }

    // ── POST /api/users/login ────────────────────────────────────────────
    if (p === '/api/users/login' && m === 'POST') {
      const { phone, password } = await body(req);
      const user = await env.DB.prepare(
        'SELECT * FROM user_accounts WHERE phone=? AND password=?'
      ).bind(phone, password).first();
      if (!user) return jErr('Invalid credentials', 401);
      return j({ data: user });
    }

    // ── GET /api/users/:ref/submissions ──────────────────────────────────
    const um = p.match(/^\/api\/users\/([^/]+)\/submissions$/);
    if (um && m === 'GET') {
      const ref = decodeURIComponent(um[1]);
      const { results } = await env.DB.prepare(
        'SELECT * FROM ad_submissions WHERE ref_code=? ORDER BY created_at DESC'
      ).bind(ref).all();
      return j({ data: results.map(r=>({...r, photos:arr(r.photos)})) });
    }

    if (p.startsWith('/api/')) return jErr('Not found', 404);
    return new Response('Not found', { status:404 });
  }
};
