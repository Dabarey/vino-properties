/**
 * Vino Realty – Cloudflare Worker
 * - POST /api/upload          → streams image to R2, returns public URL
 * - POST /api/<table>         → D1 query (select/insert/update/delete)
 * Static assets served by the CF Pages / Workers Assets binding.
 *
 * Bindings required (set in wrangler.toml + CF dashboard):
 *   DB     → D1 database
 *   PHOTOS → R2 bucket
 *   ASSETS → Static assets directory
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS pre-flight ──
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5); // strip "/api/"

      // ── Photo upload → R2 ──
      if (route === 'upload') {
        return cors(await handleUpload(request, env));
      }

      // ── D1 table query ──
      if (['properties', 'ad_submissions', 'user_accounts'].includes(route)) {
        let body;
        try { body = await request.json(); } catch {
          return cors(json({ error: { message: 'Invalid JSON' } }, 400));
        }
        return cors(await handleQuery(env.DB, route, body));
      }

      return cors(json({ error: { message: 'Unknown route' } }, 404));
    }

    // Static assets fallback
    return new Response('Not found', { status: 404 });
  }
};

// ─────────────────────────────────────────
// R2 Upload
// ─────────────────────────────────────────
async function handleUpload(request, env) {
  if (!env.PHOTOS) {
    return json({ error: { message: 'R2 bucket not configured' } }, 500);
  }
  const key = request.headers.get('X-Key');
  if (!key || key.includes('..')) {
    return json({ error: { message: 'Invalid key' } }, 400);
  }
  const contentType = request.headers.get('Content-Type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    return json({ error: { message: 'Only images allowed' } }, 400);
  }
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > 8 * 1024 * 1024) {
      return json({ error: { message: 'File too large (max 8MB)' } }, 400);
    }
    await env.PHOTOS.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { uploadedAt: new Date().toISOString() }
    });
    // Public URL — requires the bucket to have public access enabled in the CF dashboard
    const publicUrl = `https://pub-${env.R2_PUBLIC_DOMAIN || 'REPLACE_R2_PUBLIC_DOMAIN'}.r2.dev/${key}`;
    return json({ url: publicUrl, key });
  } catch (e) {
    console.error('R2 upload error:', e);
    return json({ error: { message: e.message } }, 500);
  }
}

// ─────────────────────────────────────────
// D1 Query dispatcher
// ─────────────────────────────────────────
async function handleQuery(DB, table, { op, cols, filters = [], body, order, single }) {
  try {
    switch (op) {
      case 'select': return json(await dbSelect(DB, table, filters, order, single));
      case 'insert': return json(await dbInsert(DB, table, body));
      case 'update': return json(await dbUpdate(DB, table, body, filters));
      case 'delete': return json(await dbDelete(DB, table, filters));
      default:       return json({ data: null, error: { message: `Unknown op: ${op}` } }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ data: null, error: { message: e.message } }, 500);
  }
}

// ─────────────────────────────────────────
// SELECT
// ─────────────────────────────────────────
async function dbSelect(DB, table, filters, order, single) {
  let sql = `SELECT * FROM ${table}`;
  const params = [];
  if (filters.length) {
    sql += ' WHERE ' + filters.map(f => {
      params.push(f.val);
      return `${f.col} = ?`;
    }).join(' AND ');
  }
  if (order) {
    sql += ` ORDER BY ${order.col} ${order.ascending === false ? 'DESC' : 'ASC'}`;
  }
  if (single) sql += ' LIMIT 1';

  const stmt = DB.prepare(sql).bind(...params);
  if (single) {
    const row = await stmt.first();
    if (!row) return { data: null, error: { message: 'No rows found' } };
    return { data: parseRow(row), error: null };
  }
  const { results } = await stmt.all();
  return { data: (results || []).map(parseRow), error: null };
}

// ─────────────────────────────────────────
// INSERT
// ─────────────────────────────────────────
async function dbInsert(DB, table, body) {
  const schema = SCHEMAS[table];
  if (!schema) return { data: null, error: { message: 'No schema for ' + table } };
  const row = {};
  for (const col of schema) {
    if (col in body) row[col] = serializeVal(body[col]);
  }
  row.created_at = row.created_at || new Date().toISOString();
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  const info = await DB.prepare(sql).bind(...Object.values(row)).run();
  return { data: { id: info.meta?.last_row_id }, error: null };
}

// ─────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────
async function dbUpdate(DB, table, body, filters) {
  const schema = SCHEMAS[table];
  const row = {};
  for (const col of (schema || Object.keys(body))) {
    if (col in body) row[col] = serializeVal(body[col]);
  }
  if (!Object.keys(row).length) return { data: null, error: { message: 'Nothing to update' } };
  const setClauses = Object.keys(row).map(c => `${c} = ?`).join(', ');
  const setVals = Object.values(row);
  let sql = `UPDATE ${table} SET ${setClauses}`;
  const params = [...setVals];
  if (filters.length) {
    sql += ' WHERE ' + filters.map(f => { params.push(f.val); return `${f.col} = ?`; }).join(' AND ');
  }
  await DB.prepare(sql).bind(...params).run();
  return { data: null, error: null };
}

// ─────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────
async function dbDelete(DB, table, filters) {
  let sql = `DELETE FROM ${table}`;
  const params = [];
  if (filters.length) {
    sql += ' WHERE ' + filters.map(f => { params.push(f.val); return `${f.col} = ?`; }).join(' AND ');
  }
  await DB.prepare(sql).bind(...params).run();
  return { data: null, error: null };
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────
function parseRow(row) {
  for (const col of ['amenities', 'photos']) {
    if (typeof row[col] === 'string') {
      try { row[col] = JSON.parse(row[col]); } catch { row[col] = []; }
    }
  }
  return row;
}

function serializeVal(v) {
  if (Array.isArray(v) || (v !== null && typeof v === 'object')) return JSON.stringify(v);
  return v;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Key');
  return r;
}

// ─────────────────────────────────────────
// Column schemas
// ─────────────────────────────────────────
const SCHEMAS = {
  properties: [
    'type','title','location','province','price','beds','baths',
    'area','land','land_perches','img','amenities','deed',
    'badge','badge_key','description','link','listing_mode','country',
    'photos','boosted','boosted_until','boosted_days','created_at','views'
  ],
  ad_submissions: [
    'type','title','location','province','price','beds','baths',
    'area','land','land_perches','img','amenities','deed',
    'description','photos','status','submitter_name','submitter_phone',
    'submitter_email','country','package_name','package_price',
    'payment_ref','ref_code','created_at'
  ],
  user_accounts: [
    'phone','name','password','ref_code','created_at'
  ]
};
