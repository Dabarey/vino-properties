import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import manifestJSON from "__STATIC_CONTENT_MANIFEST";
const assetManifest = JSON.parse(manifestJSON);

// ── CORS ─────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

// ── Allowed tables & their columns ───────────────────────────────
const TABLES = {
  properties: [
    'id','type','title','location','province','price','beds','baths',
    'area','land','land_perches','img','amenities','deed','badge','badge_key',
    'description','link','listing_mode','country','photos',
    'boosted','boosted_until','boosted_days','created_at'
  ],
  user_accounts: ['id','phone','name','password','ref_code','created_at'],
  ad_submissions: [
    'id','type','title','location','province','price','beds','baths',
    'area','land','land_perches','img','amenities','deed','description','photos',
    'submitter_name','submitter_phone','submitter_email','country',
    'package_name','package_price','payment_ref','ref_code','status','created_at'
  ]
};

// ── D1 helpers ────────────────────────────────────────────────────
async function d1All(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

async function d1Run(db, sql, params = []) {
  await db.prepare(sql).bind(...params).run();
}

// Deserialize JSON fields stored as text
function parseRow(table, row) {
  if (!row) return row;
  const jsonFields = ['amenities', 'photos'];
  const out = { ...row };
  for (const f of jsonFields) {
    if (typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]); } catch { out[f] = []; }
    }
  }
  return out;
}

// ── Table CRUD handler ────────────────────────────────────────────
async function handleTable(request, db, table) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { headers: CORS });

  const cols = TABLES[table];

  // GET — with optional filter params
  if (method === 'GET') {
    // Only filter on known columns to avoid malformed queries
    const params = [...url.searchParams.entries()].filter(([k]) => cols.includes(k));
    let sql = `SELECT * FROM ${table}`;
    const binds = [];
    if (params.length) {
      sql += ' WHERE ' + params.map(([k]) => `${k} = ?`).join(' AND ');
      params.forEach(([, v]) => binds.push(v));
    }
    sql += ' ORDER BY created_at DESC';
    try {
      const { results } = await db.prepare(sql).bind(...binds).all();
      const rows = results || [];
      return json({ data: rows.map(r => parseRow(table, r)), error: null });
    } catch (e) {
      return json({ data: [], error: { message: e.message } });
    }
  }

  // POST — insert
  if (method === 'POST') {
    try {
      const body = await request.json();
      const id = body.id || Date.now();
      const created_at = body.created_at || new Date().toISOString();
      const row = { ...body, id, created_at };

      // Only use known columns
      const useCols = cols.filter(c => row[c] !== undefined);
      const vals = useCols.map(c => {
        const v = row[c];
        return (Array.isArray(v) || typeof v === 'object' && v !== null)
          ? JSON.stringify(v) : v;
      });

      const placeholders = useCols.map(() => '?').join(',');
      await d1Run(db,
        `INSERT OR REPLACE INTO ${table} (${useCols.join(',')}) VALUES (${placeholders})`,
        vals
      );
      return json({ data: row, error: null });
    } catch (e) {
      return json({ data: null, error: { message: e.message } });
    }
  }

  // PUT — update by id
  if (method === 'PUT') {
    const id = url.searchParams.get('id');
    if (!id) return json({ data: null, error: { message: 'Missing id' } }, 400);
    try {
      const patch = await request.json();
      const useCols = cols.filter(c => c !== 'id' && patch[c] !== undefined);
      if (!useCols.length) return json({ data: null, error: null });
      const vals = useCols.map(c => {
        const v = patch[c];
        return (Array.isArray(v) || typeof v === 'object' && v !== null)
          ? JSON.stringify(v) : v;
      });
      const setClause = useCols.map(c => `${c} = ?`).join(', ');
      await d1Run(db, `UPDATE ${table} SET ${setClause} WHERE id = ?`, [...vals, id]);
      return json({ data: null, error: null });
    } catch (e) {
      return json({ data: null, error: { message: e.message } });
    }
  }

  // DELETE — by id
  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ data: null, error: { message: 'Missing id' } }, 400);
    try {
      await d1Run(db, `DELETE FROM ${table} WHERE id = ?`, [id]);
      return json({ data: null, error: null });
    } catch (e) {
      return json({ data: null, error: { message: e.message } });
    }
  }

  return json({ error: { message: 'Method not allowed' } }, 405);
}

// ── Main ──────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const table = url.pathname.replace('/api/', '').replace(/\/$/, '');
      if (!TABLES[table]) return json({ error: { message: 'Unknown table' } }, 404);
      return handleTable(request, env.DB, table);
    }

    try {
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          ASSET_MANIFEST: assetManifest,
          mapRequestToAsset(req) {
            const u = new URL(req.url);
            if (u.pathname === '/' || u.pathname === '')
              return new Request(`${u.origin}/index.html`, req);
            return req;
          },
        }
      );
    } catch {
      try {
        const u = new URL(request.url);
        const r = await getAssetFromKV(
          { request: new Request(`${u.origin}/index.html`, request), waitUntil: ctx.waitUntil.bind(ctx) },
          { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
        );
        return new Response(r.body, { ...r, status: 200 });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  }
};
