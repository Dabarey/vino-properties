/**
 * vino.properties — Cloudflare Worker API
 * ==========================================
 * Uses Cloudflare D1 (SQLite) as the database.
 *
 * SETUP STEPS:
 * 1. Create a D1 database:
 *      npx wrangler d1 create vino-db
 *
 * 2. Add the binding to wrangler.toml:
 *      [[d1_databases]]
 *      binding = "DB"
 *      database_name = "vino-db"
 *      database_id = "YOUR_DATABASE_ID"
 *
 * 3. Run the schema (once):
 *      npx wrangler d1 execute vino-db --file=schema.sql
 *
 * 4. Deploy:
 *      npx wrangler deploy
 *
 * 5. Paste your Worker URL into index.html:
 *      const API = 'https://your-worker.your-subdomain.workers.dev';
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      // ── PROPERTIES ─────────────────────────────────────────────────────────

      // GET /api/properties
      if (method === 'GET' && path === '/api/properties') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM properties ORDER BY boosted_until DESC, created_at DESC'
        ).all();
        return json(results);
      }

      // POST /api/properties
      if (method === 'POST' && path === '/api/properties') {
        const b = await request.json();
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO properties
            (id,type,title,location,province,price,beds,baths,area,land,desc,amenities,deed,badge,img,emoji,phone,lp,created_at)
          VALUES
            (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          id, b.type, b.title, b.location, b.province, b.price,
          b.beds ?? null, b.baths ?? null, b.area ?? null, b.land ?? null,
          b.desc ?? null, JSON.stringify(b.amenities ?? []),
          b.deed ?? null, b.badge ?? null, b.img ?? null, b.emoji ?? null,
          b.phone ?? null, b.lp ?? 0,
          b.created_at ?? new Date().toISOString()
        ).run();
        return json({ id }, 201);
      }

      // PUT /api/properties/:id
      const propMatch = path.match(/^\/api\/properties\/([^/]+)$/);
      if (propMatch) {
        const id = propMatch[1];

        if (method === 'PUT') {
          const b = await request.json();
          const sets = [];
          const vals = [];
          const allowed = ['type','title','location','province','price','beds','baths',
                           'area','land','desc','amenities','deed','badge','img','emoji',
                           'phone','lp','created_at'];
          for (const k of allowed) {
            if (k in b) {
              sets.push(`${k} = ?`);
              vals.push(k === 'amenities' ? JSON.stringify(b[k]) : b[k]);
            }
          }
          if (sets.length === 0) return err('No valid fields to update');
          vals.push(id);
          await env.DB.prepare(
            `UPDATE properties SET ${sets.join(', ')} WHERE id = ?`
          ).bind(...vals).run();
          return json({ ok: true });
        }

        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM properties WHERE id = ?').bind(id).run();
          return json({ ok: true });
        }
      }

      // PUT /api/properties/:id/boost
      const boostMatch = path.match(/^\/api\/properties\/([^/]+)\/boost$/);
      if (boostMatch && method === 'PUT') {
        const id = boostMatch[1];
        const { days } = await request.json();
        const until = new Date(Date.now() + days * 86400000).toISOString();
        await env.DB.prepare(
          'UPDATE properties SET boosted_until = ? WHERE id = ?'
        ).bind(until, id).run();
        return json({ ok: true, boosted_until: until });
      }

      // ── USERS ───────────────────────────────────────────────────────────────

      // POST /api/users/register
      if (method === 'POST' && path === '/api/users/register') {
        const { phone, name, password, ref_code } = await request.json();
        if (!phone || !password) return err('phone and password required');

        const existing = await env.DB.prepare(
          'SELECT id FROM users WHERE phone = ?'
        ).bind(phone).first();
        if (existing) return err('Phone already registered', 409);

        const id = crypto.randomUUID();
        const myRefCode = 'REF' + Math.random().toString(36).slice(2,8).toUpperCase();
        await env.DB.prepare(`
          INSERT INTO users (id, phone, name, password, ref_code, referred_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(id, phone, name ?? null, password, myRefCode, ref_code ?? null,
          new Date().toISOString()).run();
        return json({ id, ref_code: myRefCode }, 201);
      }

      // POST /api/users/login
      if (method === 'POST' && path === '/api/users/login') {
        const { phone, password } = await request.json();
        if (!phone || !password) return err('phone and password required');

        const user = await env.DB.prepare(
          'SELECT id, phone, name, ref_code FROM users WHERE phone = ? AND password = ?'
        ).bind(phone, password).first();
        if (!user) return err('Invalid phone or password', 401);
        return json(user);
      }

      // ── SUBMISSIONS ─────────────────────────────────────────────────────────

      // GET /api/submissions?status=pending
      if (method === 'GET' && path === '/api/submissions') {
        const status = url.searchParams.get('status');
        let q = 'SELECT * FROM submissions ORDER BY created_at DESC';
        let result;
        if (status) {
          result = await env.DB.prepare(
            'SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC'
          ).bind(status).all();
        } else {
          result = await env.DB.prepare(q).all();
        }
        return json(result.results);
      }

      // GET /api/submissions/by-ref?ref_code=...
      if (method === 'GET' && path === '/api/submissions/by-ref') {
        const ref = url.searchParams.get('ref_code');
        if (!ref) return err('ref_code required');
        const { results } = await env.DB.prepare(
          'SELECT * FROM submissions WHERE ref_code = ? ORDER BY created_at DESC'
        ).bind(ref).all();
        return json(results);
      }

      // POST /api/submissions
      if (method === 'POST' && path === '/api/submissions') {
        const b = await request.json();
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO submissions
            (id,type,title,location,province,price,beds,baths,area,land,desc,amenities,deed,badge,img,emoji,phone,lp,ref_code,status,created_at)
          VALUES
            (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          id, b.type, b.title, b.location, b.province, b.price,
          b.beds ?? null, b.baths ?? null, b.area ?? null, b.land ?? null,
          b.desc ?? null, JSON.stringify(b.amenities ?? []),
          b.deed ?? null, b.badge ?? null, b.img ?? null, b.emoji ?? null,
          b.phone ?? null, b.lp ?? 0,
          b.ref_code ?? null, 'pending',
          new Date().toISOString()
        ).run();
        return json({ id }, 201);
      }

      // PUT /api/submissions/:id  (approve / reject)
      const subMatch = path.match(/^\/api\/submissions\/([^/]+)$/);
      if (subMatch && method === 'PUT') {
        const id = subMatch[1];
        const { status } = await request.json();
        if (!['approved','rejected','pending'].includes(status))
          return err('Invalid status');
        await env.DB.prepare(
          'UPDATE submissions SET status = ? WHERE id = ?'
        ).bind(status, id).run();
        return json({ ok: true });
      }

      return err('Not found', 404);

    } catch (e) {
      console.error(e);
      return err(e.message ?? 'Server error', 500);
    }
  },
};
