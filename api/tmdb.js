import { config } from '../lib/shim.js';


const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const UA = 'MounsFlix/1.0 (contact: local)';

async function anilistChars(q) {
  try {
    const query = `query($s:String){Page(page:1,perPage:14){characters(search:$s){name{full}image{large}media(sort:POPULARITY_DESC,perPage:2){nodes{title{romaji}}}}}}`;
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { s: q } }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data?.Page?.characters || []).map(x => ({
      kind: 'anime',
      name: x.name?.full || '',
      img: x.image?.large || null,
      known: (x.media?.nodes || []).map(n => n.title?.romaji || '').filter(Boolean).slice(0, 2)
    })).filter(x => x.name && x.img);
  } catch (e) { return [] }
}

async function wikiChars(q) {
  try {
    const s = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=10&search=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000)
    });
    if (!s.ok) return [];
    const [, titles] = await s.json();
    if (!titles?.length) return [];
    const ranked = titles.slice(0, 8).sort((a, b) => {
      const score = t => t.includes('(character)') ? 0 : t.includes('(film)') ? 1 : t.includes('(TV series)') ? 1 : 2;
      return score(a) - score(b);
    });
    const p = await fetch(`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&piprop=thumbnail&pithumbsize=400&titles=${encodeURIComponent(ranked.join('|'))}`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000)
    });
    if (!p.ok) return [];
    const d = await p.json();
    const seen = new Set();
    const out = [];
    for (const pg of Object.values(d.query?.pages || {})) {
      if (pg.missing || !pg.thumbnail?.source) continue;
      const name = pg.title.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const k = name.toLowerCase();
      if (!name || seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: 'wiki', name, img: pg.thumbnail.source.replace(/\/\d+px-/, '/400px-'), known: [] });
    }
    return out.slice(0, 10);
  } catch (e) { return [] }
}

export default async function (req, res) {
  const key = await config.get('TMDB_API_KEY');
  const action = String(req.query.action || 'home');
  const language = 'fr-FR';
  const region = 'FR';
  let path;
  let params = new URLSearchParams({ language, region });

  if (action === 'search') {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.status(400).json({ error: 'Recherche vide.' });
    path = '/search/multi';
    params.set('query', q);
    params.set('include_adult', 'false');
    params.set('page', String(Math.min(20, Math.max(1, Number(req.query.page || 1)))));
  } else if (action === 'details') {
    const id = String(req.query.id || '').replace(/[^0-9]/g, '');
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    if (!id) return res.status(400).json({ error: 'ID manquant.' });
    path = `/${type}/${id}`;
    params.set('append_to_response', 'credits,videos,similar,recommendations');
  } else if (action === 'episodes') {
    const id = String(req.query.id || '').replace(/[^0-9]/g, '');
    const season = String(req.query.season || '1').replace(/[^0-9]/g, '');
    if (!id || !season) return res.status(400).json({ error: 'ID/saison manquant.' });
    path = `/tv/${id}/season/${season}`;
  } else if (action === 'seasons') {
    const id = String(req.query.id || '').replace(/[^0-9]/g, '');
    if (!id) return res.status(400).json({ error: 'ID manquant.' });
    path = `/tv/${id}`;
  } else if (action === 'characters') {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.status(400).json({ error: 'Recherche vide.' });

    const [anime, wiki] = await Promise.all([anilistChars(q), wikiChars(q)]);
    const seen = new Set();
    const results = [];
    for (const c of [...anime, ...wiki]) {
      const k = c.name.toLowerCase() + '|' + c.img;
      if (seen.has(k)) continue;
      seen.add(k);
      results.push(c);
    }
    return res.json({ results });
  } else if (action === 'trending') {
    path = '/trending/all/week';
    params.set('include_adult', 'false');
  } else if (action === 'popular') {
    path = '/movie/popular';
    params.set('page', '1');
  } else if (action === 'top') {
    path = '/movie/top_rated';
    params.set('page', '1');
  } else if (action === 'tv') {
    path = '/tv/popular';
    params.set('page', '1');
  } else {
    path = '/trending/all/week';
  }

  const headers = key.length > 80 ? { Authorization: `Bearer ${key}` } : {};
  if (key.length <= 80) params.set('api_key', key);
  const r = await fetch(`${BASE}${path}?${params}`, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) {
    console.error('TMDB error', r.status);
    return res.status(502).json({ error: 'Catalogue temporairement indisponible.' });
  }
  const data = await r.json();
  res.json({ ...data, _img: IMG });
}