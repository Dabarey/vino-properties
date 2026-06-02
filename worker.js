/**
 * Vino Realty — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────────
 * Handles all API calls from vinorealtynew.html
 *
 * SETUP (wrangler.toml):
 * ───────────────────────
 * name = "vino-api"
 * main = "vino-worker.js"
 * compatibility_date = "2024-01-01"
 *
 * [[d1_databases]]
 * binding = "DB"
 * database_name = "vino-realty"
 * database_id = "YOUR_D1_DATABASE_ID"
 *
 * [[r2_buckets]]
 * binding = "PHOTOS"
 * bucket_name = "vino-photos"
 *
 * [vars]
 * R2_PUBLIC_URL = "https://pub-XXXX.r2.dev"   # your R2 public bucket URL
 * ALLOWED_ORIGIN = "https://yourdomain.com"    # your site domain
 *
 * D1 SCHEMA (run via `wrangler d1 execute vino-realty --file=schema.sql`):
 * ──────────────────────────────────────────────────────────────────────────
 * See schema.sql delivered alongside this file.
 *
 * DEPLOY:
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler d1 create vino-realty
 *   wrangler d1 execute vino-realty --file=schema.sql
 *   wrangler r2 bucket create vino-photos
 *   wrangler deploy
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin === '*' ? '*' : (origin === allowedOrigin ? origin : allowedOrigin),
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname; // e.g. /api/properties or /api/upload

    try {
      // ── R2 PHOTO UPLOAD ─────────────────────────────────────────
      if (path === '/api/upload' && request.method === 'POST') {
        const { dataUrl, filename } = await request.json();
        if (!dataUrl || !filename) return jsonError('Missing dataUrl or filename', 400, corsHeaders);

        // Decode base64 data URL
        const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
        if (!match) return jsonError('Invalid dataUrl format', 400, corsHeaders);
        const contentType = match[1];
        const base64Data = match[2];
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

        // Sanitize filename and store under "photos/" prefix
        const safeName = 'photos/' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        await env.PHOTOS.put(safeName, binaryData, { httpMetadata: { contentType } });

        const publicUrl = `${env.R2_PUBLIC_URL}/${safeName}`;
        return json({ url: publicUrl }, corsHeaders);
      }

      // ── D1 TABLE CRUD ────────────────────────────────────────────
      const tableMatch = path.match(/^\/api\/([a-z_]+)$/);
      if (!tableMatch) return jsonError('Not found', 404, corsHeaders);
      const table = tableMatch[1];

      // Whitelist allowed tables
      const ALLOWED = ['properties', 'ad_submissions', 'user_accounts'];
      if (!ALLOWED.includes(table)) return jsonError('Table not allowed', 403, corsHeaders);

      // ── GET (SELECT) ─────────────────────────────────────────────
      if (request.method === 'GET') {
        const params = Object.fromEntries(url.searchParams.entries());
        const isSingle = params._single === '1';
        const orderCol = params._order;
        const orderAsc = params._asc !== 'false';
        delete params._single; delete params._order; delete params._asc;

        let query = `SELECT * FROM ${table}`;
        const values = [];
        const conditions = Object.entries(params);
        if (conditions.length) {
          query += ' WHERE ' + conditions.map(([k]) => `${k} = ?`).join(' AND ');
          conditions.forEach(([, v]) => values.push(v));
        }
        if (orderCol) query += ` ORDER BY ${orderCol} ${orderAsc ? 'ASC' : 'DESC'}`;

        if (isSingle) {
          const row = await env.DB.prepare(query).bind(...values).first();
          if (!row) return jsonError('Not found', 404, corsHeaders);
          return json({ data: parseRow(row) }, corsHeaders);
        } else {
          const result = await env.DB.prepare(query).bind(...values).all();
          return json({ data: (result.results || []).map(parseRow) }, corsHeaders);
        }
      }

      // ── POST (INSERT) ────────────────────────────────────────────
      if (request.method === 'POST') {
        const body = await request.json();
        const row = flattenForD1(body);
        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(', ');
        const vals = cols.map(c => row[c]);
        const query = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
        await env.DB.prepare(query).bind(...vals).run();
        return json({ data: row }, corsHeaders);
      }

      // ── PATCH (UPDATE) ───────────────────────────────────────────
      if (request.method === 'PATCH') {
        const { _filters, _data } = await request.json();
        if (!_filters || !_data) return jsonError('Missing _filters or _data', 400, corsHeaders);
        const row = flattenForD1(_data);
        const sets = Object.keys(row).map(c => `${c} = ?`).join(', ');
        const setVals = Object.values(row);
        const conditions = Object.entries(_filters);
        if (!conditions.length) return jsonError('No filter provided for UPDATE', 400, corsHeaders);
        const where = conditions.map(([k]) => `${k} = ?`).join(' AND ');
        const whereVals = conditions.map(([, v]) => v);
        const query = `UPDATE ${table} SET ${sets} WHERE ${where}`;
        await env.DB.prepare(query).bind(...setVals, ...whereVals).run();
        return json({ data: { updated: true } }, corsHeaders);
      }

      // ── DELETE ───────────────────────────────────────────────────
      if (request.method === 'DELETE') {
        const { _filters } = await request.json();
        if (!_filters) return jsonError('Missing _filters', 400, corsHeaders);
        const conditions = Object.entries(_filters);
        if (!conditions.length) return jsonError('No filter provided for DELETE', 400, corsHeaders);
        const where = conditions.map(([k]) => `${k} = ?`).join(' AND ');
        const vals = conditions.map(([, v]) => v);
        const query = `DELETE FROM ${table} WHERE ${where}`;
        await env.DB.prepare(query).bind(...vals).run();
        return json({ data: { deleted: true } }, corsHeaders);
      }

      return jsonError('Method not allowed', 405, corsHeaders);

    } catch (e) {
      return jsonError(e.message || 'Internal error', 500, corsHeaders);
    }
  }
};

// ── Helpers ──────────────────────────────────────────────────────

/** Serialize arrays/objects to JSON strings for D1 storage */
function flattenForD1(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Parse JSON strings back to arrays/objects when reading from D1 */
function parseRow(row) {
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try { out[k] = JSON.parse(v); } catch {}
    }
  }
  return out;
}

function json(data, headers = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function jsonError(msg, status = 500, headers = {}) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
