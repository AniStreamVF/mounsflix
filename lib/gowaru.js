import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Chargeur des providers Gowaru (bundle nuvio-providers v1.2.0).
 * Chaque bundle est un module CommonJS autonome exportant
 * getStreams(tmdbId, mediaType, season, episode) → Array<stream>.
 * On adapte sa sortie au format interne de MounsFlix :
 *   { id, name, url, quality, language, format, headers }
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const GOWARU_PROVIDERS = [
  { id: 'anime-ultime',   label: 'Anime-Ultime',  file: 'anime-ultime.cjs' },
  { id: 'animesama-co',   label: 'AnimeSama.co',  file: 'animesama-co.cjs' },
  { id: 'animesultra',    label: 'AnimesUltra',   file: 'animesultra.cjs' },
  { id: 'animevostfr',    label: 'AnimeVOSTFR',   file: 'animevostfr.cjs' },
  { id: 'french-manga',   label: 'French-Manga',  file: 'french-manga.cjs' },
  { id: 'voiranime',      label: 'VoirAnime',     file: 'voiranime.cjs' },
  { id: 'voiranime-rip',  label: 'VoirAnime.rip', file: 'voiranime-rip.cjs' },
  { id: 'voiranime-homes',label: 'VoirAnime.homes', file: 'voiranime-homes.cjs' },
];

const FAKE = /big.?buck|bbb_sunflower|sample\.mp4|test\.mp4|test-videos\.co\.uk|sample-videos\.com|localhost/i;
const DIRECT = /\.(mp4|m3u8|mkv|webm|mpd)(\?|$|\/)/i;

function inferFormat(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('.m3u8')) return 'm3u8';
  if (u.includes('.mkv')) return 'mkv';
  if (u.includes('.mpd')) return 'mpd';
  if (u.includes('.webm')) return 'webm';
  return 'mp4';
}

function adapt(raw, providerId) {
  const out = [];
  const seen = new Set();
  let i = 0;
  for (const s of raw || []) {
    const url = String(s.url || s.file || s.link || '');
    if (!url || url.length < 10 || FAKE.test(url)) continue;
    if (!DIRECT.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const type = s.type || s.format;
    const lang = (s.language || s.lang || '').toUpperCase();
    // Les bundles Gowaru étiquettent par défaut en VOSTFR (détection page HTML),
    // mais les flux renvoyés (Sibnet/Streamtape…) sont en VF (doublage FR).
    // On force VF pour que l'étiquette corresponde au contenu réellement diffusé.
    out.push({
      id: `${providerId}-${i++}`,
      name: 'Source',
      url,
      quality: s.quality && s.quality !== 'HD' ? s.quality : 'Auto',
      language: /VOST|VOSTFR/.test(lang) ? 'VF' : (lang || 'VF'),
      format: type === 'mpd' ? 'mpd' : type || inferFormat(url),
      headers: s.headers || {},
    });
  }
  return out;
}

const cache = new Map();

function load(file) {
  if (!cache.has(file)) {
    cache.set(file, require(path.join(__dirname, 'nuvio-providers', file)));
  }
  return cache.get(file);
}

export async function gowaruStreams(providerId, tmdbId, mediaType, season, episode, signal) {
  const meta = GOWARU_PROVIDERS.find(p => p.id === providerId);
  if (!meta) return [];
  try {
    const mod = load(meta.file);
    const raw = await mod.getStreams(String(tmdbId), mediaType === 'tv' ? 'tv' : 'movie', season, episode, { signal });
    return adapt(raw, providerId);
  } catch (e) {
    console.error(`gowaru ${providerId}:`, String(e).slice(0, 200));
    return [];
  }
}
