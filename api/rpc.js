/**
 * Vercel Function: POST /api/rpc  { fn: 'login' | 'logout' | 'apiCall', args: [...] }
 * Pengganti google.script.run — meneruskan panggilan frontend ke Supabase.
 *
 * Kunci yang dipakai adalah publishable key (aman untuk publik): tabel terkunci RLS,
 * data hanya bisa dibaca/diubah lewat fungsi app_* yang memeriksa token sesi.
 * Bisa diganti lewat Environment Variables Vercel: SUPABASE_URL & SUPABASE_PUBLISHABLE_KEY.
 */
const { run } = require('../lib/backend');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qmocaylukvfitqengwag.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Cf0E0vqy1Yx4ZD62XdjLNw_UPSivBWD';
const AUTH_ERROR = 'Sesi berakhir. Silakan login kembali.';

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { message: text }; }
  if (!res.ok) {
    const err = new Error((body && body.message) || `Supabase error ${res.status}`);
    err.auth = !!body && body.message === 'AUTH';
    throw err;
  }
  return body;
}

/* ---------- Import dari URL Google Sheets (file harus dibagikan "Siapa saja yang memiliki link") ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function fetchSheetRows(url) {
  const id = String(url).match(/\/spreadsheets\/d\/([\w-]+)/);
  if (!id) throw new Error('URL Google Sheets tidak valid.');
  const gid = String(url).match(/[#&?]gid=(\d+)/);
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv${gid ? '&gid=' + gid[1] : ''}`);
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/csv')) {
    throw new Error('Tidak dapat membuka Google Sheets. Pastikan URL benar dan file dibagikan "Siapa saja yang memiliki link".');
  }
  const vals = parseCsv(await res.text());
  if (vals.length < 2) throw new Error('Sheet kosong atau hanya berisi header.');
  const head = vals[0];
  return vals.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}

/* ---------- Dispatcher ---------- */

async function apiCall(token, action, payload) {
  token = String(token || '');
  payload = payload || {};
  if (!token) return { ok: false, auth: true, error: AUTH_ERROR };
  try {
    if (action === 'changePassword') {
      await rpc('app_change_password', { p_token: token, p_old: String(payload.oldPassword || ''), p_new: String(payload.newPassword || '') });
      return { ok: true, data: true };
    }
    const db = await rpc('app_load', { p_token: token });
    if (payload.url && !(payload.rows && payload.rows.length)) payload.rows = await fetchSheetRows(payload.url);
    const r = run(db.tables, action, payload, db.username);
    if (r.ops.length) await rpc('app_apply', { p_token: token, p_ops: r.ops });
    return { ok: true, data: r.data };
  } catch (e) {
    if (e.auth) return { ok: false, auth: true, error: AUTH_ERROR };
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  const fn = body && body.fn, args = (body && body.args) || [];
  try {
    let out;
    if (fn === 'login') out = await rpc('app_login', { p_username: String(args[0] || ''), p_password: String(args[1] || '') });
    else if (fn === 'logout') { await rpc('app_logout', { p_token: String(args[0] || '') }); out = { ok: true }; }
    else if (fn === 'apiCall') out = await apiCall(args[0], args[1], args[2]);
    else out = { ok: false, error: 'Fungsi tidak dikenal.' };
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};
