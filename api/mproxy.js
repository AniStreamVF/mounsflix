
/**
 * Proxy média — sert les flux HLS/CDN en même-origine.
 * Certains CDN (moon.peakstorm.top, polarcandy.top…) renvoient 403 dès
 * qu'un header Origin est présent (i.e. dès qu'un navigateur les appelle).
 * Le fetch serveur n'envoie pas d'Origin → on proxie manifestes + segments,
 * et on réécrit les URLs des playlists pour qu'elles pointent ici aussi.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export default async function handler(req, res) {
  const raw = String(req.query.u || '');
  let url = raw;
  try { url = decodeURIComponent(raw); } catch { /* URL déjà décodée */ }
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return res.status(400).send('bad url');

  const ref = String(req.query.ref || '');
  const origin = String(req.query.origin || '');
  let r;
  try {
    const hdrs = { 'User-Agent': UA };
    if (ref) hdrs.Referer = ref;
    if (origin) hdrs.Origin = origin;
    if (req.headers.range) hdrs.Range = req.headers.range;
    r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return res.status(502).send('upstream error');
  }

  const ct = r.headers.get('content-type') || '';
  const isPlaylist = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8(\?|$|\/)/i.test(url);

  if (!isPlaylist) {
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    const range = r.headers.get('content-range');
    if (range) res.setHeader('Content-Range', range);
    if (r.status === 206) res.status(206);
    if (r.body) {
      // Stream en flux (pas de bufferisation en mémoire → pas de crash sur les gros MP4)
      const total = r.headers.get('content-length');
      if (total) res.setHeader('Content-Length', total);
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch { /* flux coupé */ }
      return res.end();
    }
    const buf = await r.arrayBuffer().catch(() => null);
    if (!buf) return res.status(502).send('upstream read error');
    return res.status(r.status).send(Buffer.from(buf));
  }

  const text = await r.text().catch(() => null);
  if (text === null) return res.status(502).send('upstream read error');
  // Le constructeur URL du runtime est non standard (absolu traité en relatif,
  // '//host' non résolu) → résolution manuelle.
  const resolveUrl = (u, baseUrl) => {
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) {
      const m = /^https?:\/\/[^/]+/.exec(baseUrl);
      return m ? m[0] + u : u;
    }
    const slash = baseUrl.lastIndexOf('/');
    return slash > 8 ? baseUrl.slice(0, slash + 1) + u : baseUrl + '/' + u;
  };
  const rewrite = (u) => {
    const abs = resolveUrl(u, url);
    return `/api/mproxy/stream.m3u8?u=${encodeURIComponent(abs)}${ref ? '&ref=' + encodeURIComponent(ref) : ''}`;
  };
  const lines = text.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      if (t.includes('URI="')) return line.replace(/URI="([^"]+)"/gi, (m, u2) => `URI="${rewrite(u2)}"`);
      return line;
    }
    return rewrite(t);
  });
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(r.status).send(lines.join('\n'));
}