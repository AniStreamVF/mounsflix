import { config, db } from '../lib/shim.js';


const OS = 'https://api.opensubtitles.com/api/v1';
const TOKEN_TTL = 11 * 3600 * 1000;

async function getKey() {
  return (await config.get('OPENSUBTITLES_API_KEY')) || '';
}

async function getToken() {
  const user = (await config.get('OPENSUBTITLES_USER')) || '';
  const pass = (await config.get('OPENSUBTITLES_PASS')) || '';
  const key = await getKey();
  if (!key || !user || !pass) return null;
  try {
    const { rows } = await db.query("SELECT value, updated_at FROM kv_cache WHERE key = 'os_token'");
    if (rows.length && Date.now() - new Date(rows[0].updated_at).getTime() < TOKEN_TTL) return rows[0].value;
  } catch { /* table absente : on login directement */ }
  const r = await fetch(`${OS}/login`, {
    method: 'POST',
    headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.token) return null;
  try {
    await db.query("INSERT INTO kv_cache (key, value, updated_at) VALUES ('os_token', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(d.token)]);
  } catch { /* cache best-effort */ }
  return d.token;
}

export default async function handler(req, res) {
  const action = req.query.action || 'search';
  const key = await getKey();
  if (!key) return res.json({ ok: false, error: 'no_key', message: 'Clé API OpenSubtitles non configurée.' });

  try {
    if (action === 'search') {
      const imdb = String(req.query.imdb || '').replace(/\D/g, '');
      if (!imdb) return res.status(400).json({ ok: false, error: 'imdb manquant.' });
      const langs = String(req.query.languages || 'fr');
      const url = `${OS}/subtitles?imdb_id=${imdb}&languages=${encodeURIComponent(langs)}&order_by=download_count&order_direction=desc&limit=20`;
      const r = await fetch(url, { headers: { 'Api-Key': key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
      const d = await r.json().catch(() => ({}));
      const data = (d.data || []).map(s => ({
        file_id: s.attributes?.files?.[0]?.file_id || null,
        lang: s.attributes?.language || 'inconnu',
        name: s.attributes?.release_name || '',
        score: s.attributes?.download_count || 0,
        hi: !!s.attributes?.hearing_impaired,
      })).filter(s => s.file_id);
      return res.json({ ok: r.ok, data, total: data.length });
    }

    if (action === 'dl') {
      const fileId = String(req.query.file_id || '').replace(/\D/g, '');
      if (!fileId) return res.status(400).json({ ok: false, error: 'file_id manquant.' });
      const tok = await getToken();
      if (!tok) return res.json({ ok: false, error: 'no_auth', message: 'Login OpenSubtitles requis pour télécharger les sous-titres.' });
      const r = await fetch(`${OS}/download`, {
        method: 'POST',
        headers: { 'Api-Key': key, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: Number(fileId) }),
        signal: AbortSignal.timeout(10000),
      });
      const d = await r.json().catch(() => ({}));
      return res.json({ ok: r.ok, link: d.link || null });
    }

    return res.status(400).json({ ok: false, error: 'action inconnue.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e).slice(0, 120) });
  }
}