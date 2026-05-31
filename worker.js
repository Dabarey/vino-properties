import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import manifestJSON from "__STATIC_CONTENT_MANIFEST";
const assetManifest = JSON.parse(manifestJSON);

// ── R2 helpers ──────────────────────────────────────────────────
async function r2Get(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return [];
  const text = await obj.text();
  try { return JSON.parse(text); } catch { return []; }
}

async function r2Put(bucket, key, data) {
  await bucket.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' }
  });
}

// ── CORS headers ─────────────────────────────────────────────────
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

// ── Generic table CRUD via R2 ────────────────────────────────────
// Tables: properties | user_accounts | ad_submissions
async function handleTable(request, bucket, table) {
  const url = new URL(request.url);
  const method = request.method;

  // OPTIONS preflight
  if (method === 'OPTIONS') return new Response(null, { headers: CORS });

  const rows = await r2Get(bucket, `${table}.json`);

  // GET — with optional query filters  e.g. ?phone=x&password=y&status=pending
  if (method === 'GET') {
    const params = Object.fromEntries(url.searchParams);
    let result = rows;
    for (const [k, v] of Object.entries(params)) {
      result = result.filter(r => String(r[k]) === String(v));
    }
    // order by created_at desc by default
    result = [...result].sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );
    return json({ data: result, error: null });
  }

  // POST — insert
  if (method === 'POST') {
    const body = await request.json();
    const newRow = { ...body, id: body.id || Date.now(), created_at: body.created_at || new Date().toISOString() };
    rows.push(newRow);
    await r2Put(bucket, `${table}.json`, rows);
    return json({ data: newRow, error: null });
  }

  // PUT — update by id (pass ?id=xxx)
  if (method === 'PUT') {
    const id = url.searchParams.get('id');
    if (!id) return json({ data: null, error: { message: 'Missing id' } }, 400);
    const patch = await request.json();
    const updated = rows.map(r => String(r.id) === String(id) ? { ...r, ...patch } : r);
    await r2Put(bucket, `${table}.json`, updated);
    return json({ data: null, error: null });
  }

  // DELETE — by id (?id=xxx)
  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ data: null, error: { message: 'Missing id' } }, 400);
    const filtered = rows.filter(r => String(r.id) !== String(id));
    await r2Put(bucket, `${table}.json`, filtered);
    return json({ data: null, error: null });
  }

  return json({ error: { message: 'Method not allowed' } }, 405);
}

// ── Main fetch handler ───────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith('/api/')) {
      const table = url.pathname.replace('/api/', '').replace(/\/$/, '');
      const allowed = ['properties', 'user_accounts', 'ad_submissions'];
      if (!allowed.includes(table)) {
        return json({ error: { message: 'Unknown table' } }, 404);
      }
      return handleTable(request, env.VINO_BUCKET, table);
    }

    // Static assets
    try {
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          ASSET_MANIFEST: assetManifest,
          mapRequestToAsset(req) {
            const u = new URL(req.url);
            if (u.pathname === '/' || u.pathname === '') {
              return new Request(`${u.origin}/index.html`, req);
            }
            return req;
          },
        }
      );
    } catch (e) {
      // SPA fallback
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
