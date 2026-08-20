import { config, db } from '../lib/shim.js';
import { gowaruStreams, GOWARU_PROVIDERS } from '../lib/gowaru.js';


/**
 * MounsFlix — Moteur de sources multi-providers
 * ═══════════════════════════════════════════════
 * Providers TMDB-natifs : VidLink · XPass · Mapple · Nakios · Papadustream
 *                        AutoEmbed · StreamFlix · Videasy · VaPlayer
 * Providers scraping   : FrenchStream · Coflix · Flemmix · Wookafr · Movix
 *                        Mugiwarastream · AnimeSama · AnimoFlix · DuLourd
 *                        StreamZo · Sekai · Vostfree
 * Tous lancés en parallèle, résultats dédupliqués par URL.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 8000;

// ─── helpers HTTP ─────────────────────────────────────────────────────────────

function abort(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function getText(url, hdrs, ms) {
  const { signal, clear } = abort(ms || TIMEOUT);
  try {
    const r = await fetch(url, { signal, headers: { 'User-Agent': UA, Accept: 'text/html,*/*', ...hdrs } });
    clear();
    return r.ok ? r.text() : null;
  } catch { clear(); return null; }
}

async function getJson(url, hdrs, ms) {
  const { signal, clear } = abort(ms || TIMEOUT);
  try {
    const r = await fetch(url, { signal, headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...hdrs } });
    clear();
    return r.ok ? r.json() : null;
  } catch { clear(); return null; }
}

// ─── normalisation stream ─────────────────────────────────────────────────────

const FAKE = /big.?buck|bbb_sunflower|sample\.mp4|test\.mp4/i;
const DIRECT = /\.(mp4|m3u8|mkv|webm|mpd)(\?|$|\/)/i;

function normOne(s, i, prov) {
  const url = String(s.url || s.link || s.file || s.src || '');
  if (!url || url.length < 10) return null;
  if (FAKE.test(url)) return null;
  if (!DIRECT.test(url)) return null;
  return {
    id: `${prov}-${i}`,
    name: s.name || `${prov} — ${s.quality || s.label || 'Auto'}`,
    url,
    quality:  s.quality  || s.label    || 'Auto',
    language: s.language || s.lang     || 'Multi',
    format:   s.format   || (url.includes('.m3u8') ? 'm3u8' : url.includes('.mpd') ? 'mpd' : url.includes('.mkv') ? 'mkv' : url.includes('.webm') ? 'webm' : 'mp4'),
    headers:  s.headers  || {},
  };
}

function normAll(arr, prov) {
  return arr.map((s, i) => normOne(s, i, prov)).filter(Boolean);
}

// ─── utilitaires HTML ─────────────────────────────────────────────────────────

function extractDirectUrls(html) {
  const out = [];
  for (const m of html.matchAll(/["']?(https?:\/\/[^\s"'<>]{6,}\.mp4[^\s"'<>]*)/gi))
    out.push({ url: m[1], format: 'mp4' });
  for (const m of html.matchAll(/["']?(https?:\/\/[^\s"'<>]{6,}\.m3u8[^\s"'<>]*)/gi))
    out.push({ url: m[1], format: 'm3u8' });
  return out;
}

function extractIframes(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/iframe[^>]+src=["']([^"']+)["']/gi))
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1].replace(/&#0?38;/g, '&')); }
  return out;
}

async function resolveSibnet(videoId) {
  const page = await getText(
    `https://video.sibnet.ru/shell.php?videoid=${videoId}`,
    { Referer: 'https://video.sibnet.ru/', Accept: '*/*' },
    8000
  );
  if (!page) return null;
  const m = page.match(/src:\s*["']([^"']+\.mp4[^"']*)/i);
  return m ? `https://video.sibnet.ru${m[1]}` : null;
}

// ─── Moteur de résolution de lecteurs (porté de AniStreamVF/nuvio-plugin) ───

function b64dec(s) { try { return typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'); } catch { return null; } }

const FAKE_HOSTS = /test-videos\.co\.uk|big_buck_bunny|sample-videos\.com|example\.com|localhost/i;
const DECOY = /\/troll\/|\/fake\/|\/decoy\/|\/notfound\/|\/error\//i;

function isDirectMedia(u) {
  u = String(u || '').toLowerCase();
  return /\.(mp4|m3u8|mkv|webm|mpd)(\?.*)?$/.test(u) || u.includes('/master.m3u8') || u.includes('/hls2/');
}

// Dean Edwards packer unpacker (port de deobfuscate.py)
function deobfuscate(code) {
  if (!code || !code.includes('p,a,c,k,e,d')) return code;
  let out = code, idx = 0, iter = 50;
  while (iter-- > 0) {
    const start = out.indexOf('eval(function(p,a,c,k,e,d)', idx);
    if (start === -1) break;
    let depth = 0, i = start, end = -1, inStr = null, esc = false;
    for (; i < out.length; i++) {
      const ch = out[i];
      if (inStr) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === inStr) { inStr = null; continue; } continue; }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) break;
    const block = out.slice(start, end);
    const dec = unpackOne(block);
    if (dec && dec !== block) { out = out.slice(0, start) + dec + out.slice(end); idx = start + dec.length; }
    else idx = end;
  }
  return out;
}

function unpackOne(block) {
  try {
    const v = block.indexOf('}(');
    if (v === -1) return null;
    const skipWs = p => { while (p < block.length && /\s/.test(block[p])) p++; return p; };
    const parseStr = p => {
      const q = block[p];
      if (q !== "'" && q !== '"') return null;
      let out = '', i = p + 1;
      for (; i < block.length; i++) {
        const ch = block[i];
        if (ch === '\\') { out += block[i + 1] || ''; i++; continue; }
        if (ch === q) return { val: out, end: i + 1 };
        out += ch;
      }
      return null;
    };
    const parseNum = p => { const m = block.slice(p).match(/^\d+/); return m ? { val: parseInt(m[0], 10), end: p + m[0].length } : null; };
    let pos = skipWs(v + 2);
    const payload = parseStr(pos); if (!payload) return null;
    pos = skipWs(payload.end);
    if (block[pos] !== ',') return null;
    const a = parseNum(pos + 1); if (!a) return null;
    pos = skipWs(a.end);
    if (block[pos] !== ',') return null;
    const c = parseNum(pos + 1); if (!c) return null;
    pos = skipWs(c.end);
    if (block[pos] !== ',') return null;
    const words = parseStr(pos + 1); if (!words) return null;
    if (!/\.split\(\s*['"]\|['"]\s*\)/.test(block.slice(words.end, words.end + 30))) return null;
    const dict = words.val.split('|');
    const dec = n => n < a.val ? '' : dec(Math.floor(n / a.val)) + ((n %= a.val) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const map = {};
    for (let k = c.val; k--;) map[dec(k)] = dict[k] || dec(k);
    return payload.val.replace(/\b\w+\b/g, w => map[w] || w);
  } catch { return null; }
}

function extractMediaUrl(code) {
  let m = code.match(/https?:\/\/[^"'\s]*master\.txt[^"'\s]*/)
    || code.match(/https?:\/\/[^"'\s]*master\.m3u8[^"'\s]*/)
    || code.match(/https?:\/\/[^"'\s]*\.m3u8[^"'\s]*/)
    || code.match(/https?:\/\/[^"'\s]*\.mp4[^"'\s]*/);
  if (m) return m[0];
  m = code.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
    || code.match(/sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i)
    || code.match(/['"]hls['"]\s*:\s*['"]([^"']+\.(?:m3u8|mp4)[^"']*)['"]/i);
  return m ? m[1] : null;
}

// fsvid.lol / vidzy.org XOR decoder (_fsvid_decode port)
function fsvidDecode(code, hostname) {
  code = code || '';
  hostname = hostname || 'fsvid.lol';
  const km = code.match(/\(\s*(0x[0-9a-fA-F]+|\d+)\s*\+\s*i\s*\*\s*(\d+)\s*\+\s*H\s*\)/);
  if (km) {
    try {
      const offset = km[1].toLowerCase().startsWith('0x') ? parseInt(km[1], 16) : parseInt(km[1], 10);
      const mult = parseInt(km[2], 10);
      let m2 = code.slice(km.index).match(/\}\)\(?\s*"([A-Za-z0-9+/=]{40,})"\s*\)/);
      if (!m2) m2 = code.match(/\}\)\(?\s*"([A-Za-z0-9+/=]{40,})"\s*\)/);
      const reverse = code.includes('.reverse()');
      if (m2) {
        const raw = b64dec(m2[1]);
        if (raw) {
          let H = 0;
          for (let i = 0; i < hostname.length; i++) H = (H + hostname.charCodeAt(i)) & 255;
          const bytes = [];
          for (let j = 0; j < raw.length; j++) bytes.push(raw.charCodeAt(j));
          if (reverse) bytes.reverse();
          let outStr = '';
          for (let k = 0; k < bytes.length; k++) outStr += String.fromCharCode(bytes[k] ^ ((offset + k * mult + H) & 255));
          if (outStr.startsWith('http') && outStr.includes('.m3u8')) return outStr;
        }
      }
    } catch { /* fall through */ }
  }
  const km2 = code.match(/var\s+k\s*=\s*\[([0-9,\s]+)\]/);
  if (km2) {
    try {
      const key = km2[1].split(',').map(x => parseInt(x.trim(), 10)).filter(x => !isNaN(x));
      const m = code.slice(km2.index).match(/\}\)\(?\s*"([A-Za-z0-9+/=]+)"\s*\)/);
      if (m && key.length) {
        const raw = b64dec(m[1]);
        if (raw) {
          let outStr = '';
          for (let l = 0; l < raw.length; l++) outStr += String.fromCharCode(raw.charCodeAt(l) ^ key[l % key.length]);
          if (outStr.startsWith('http') && outStr.includes('.m3u8')) return outStr;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

// veev.to decoder (LZW + hex + règles)
function veevLzw(etext) {
  const lut = {};
  for (let i = 0; i < 256; i++) lut[i] = String.fromCharCode(i);
  let n = 256, c = etext[0], result = [c];
  for (let j = 1; j < etext.length; j++) {
    const code = etext.charCodeAt(j);
    const entry = lut[code] !== undefined ? lut[code] : c + c[0];
    result.push(entry);
    lut[n++] = c + entry[0];
    c = entry;
  }
  return result.join('');
}
function veevRules(encoded) {
  const digits = (encoded.match(/\d/g) || []).join('');
  if (!digits) return [];
  const count = parseInt(digits[0], 10);
  if (count === 0) return [];
  const row = [];
  for (let i = 1; i <= count && i < digits.length; i++) row.push(parseInt(digits[i], 10));
  return row.reverse();
}
function veevHex(text) {
  let out = '';
  for (let i = 0; i + 1 < text.length; i += 2) { const b = parseInt(text.substr(i, 2), 16); if (!isNaN(b)) out += String.fromCharCode(b); }
  return out;
}
function veevFinal(encoded, rules) {
  let text = encoded;
  for (const rule of rules) {
    if (rule === 1) text = text.split('').reverse().join('');
    const dec = veevHex(text);
    if (dec) text = dec;
    text = text.replace(/dXRmOA==/g, '');
  }
  return text;
}

async function extractSibnetV2(url) {
  const m = url.match(/videoid=(\d+)/) || url.match(/embed\/(\d+)/) || url.match(/(\d{6,})/);
  if (!m) return null;
  const r = await resolveSibnet(m[1]);
  return r ? { url: r, headers: { Referer: 'https://video.sibnet.ru/' } } : null;
}

async function extractUqload(url) {
  const watch = url.replace('embed-', '');
  const text = await getText(watch, { Referer: 'https://uqload.is/' }, 8000);
  if (!text) return null;
  const hay = deobfuscate(text) + '\n' + text;
  const pats = [
    /file:\s*"([^"]+\.(?:m3u8|mp4)[^"]*)"/,
    /sources:\s*\[\s*"([^"]+)"/,
    /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/,
    /(https?:\/\/[^\s"']+\.mp4[^\s"']*)/,
  ];
  for (const p of pats) { const m = hay.match(p); if (m) return { url: m[1], headers: { Referer: 'https://uqload.is/' } }; }
  return null;
}

async function extractVoe(url) {
  const code0 = await getText(url, {}, 8000);
  if (!code0) return null;
  const code = deobfuscate(code0);
  const m = code.match(/['"]hls['"]\s*:\s*['"]([^'"]+)['"]/)
    || code.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
    || code.match(/sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i)
    || code.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
  if (m) {
    let u = m[1] || m[0];
    if (u.includes('base64')) u = b64dec(u.split(',')[1] || u) || u;
    if (!FAKE_HOSTS.test(u)) return { url: u, headers: { Referer: url } };
  }
  return null;
}

async function extractDood(url) {
  const host = (url.match(/https?:\/\/([^/]+)/) || [])[1] || 'dood.to';
  const code0 = await getText(url, {}, 8000);
  if (!code0) return null;
  const code = deobfuscate(code0);
  const m = code.match(/\$\.get\(['"]\/pass_md5\/([^'"]+)['"]/);
  if (m) {
    const t = await getText('https://' + host + '/pass_md5/' + m[1], { Referer: url }, 8000);
    if (t && t.trim()) return { url: t.trim() + Math.random().toString(36).substring(2, 12) + '?token=' + m[1] + '&expiry=' + Date.now(), headers: { Referer: 'https://' + host + '/' } };
  }
  return null;
}

async function extractStreamtape(url) {
  const code0 = await getText(url, {}, 8000);
  if (!code0) return null;
  const code = deobfuscate(code0);
  const m = code.match(/robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*([^;]+)/);
  if (m) {
    try {
      let o = 'https:' + m[1];
      for (const part of m[2].split('+')) {
        const q = part.match(/['"]([^'"]+)['"]/);
        if (q) {
          let d = q[1];
          const sub = part.match(/substring\((\d+)\)/);
          if (sub) d = d.substring(parseInt(sub[1], 10));
          o += d;
        }
      }
      return { url: o, headers: { Referer: 'https://streamtape.com/' } };
    } catch { /* ignore */ }
  }
  return null;
}

async function extractSendvid(url) {
  const embed = url.includes('/embed/') ? url : url.replace(/sendvid\.com\/([a-z0-9]+)/i, 'sendvid.com/embed/$1');
  const code = await getText(embed, { Referer: 'https://sendvid.com/' }, 8000);
  if (!code) return null;
  const m = code.match(/video_source\s*:\s*["']([^"']+\.mp4[^"']*)["']/i)
    || code.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
    || code.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
    || code.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
    || code.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i)
    || code.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["']/i);
  return m ? { url: m[1], headers: { Referer: 'https://sendvid.com/' } } : null;
}

async function extractVidmoly(url) {
  const hosts = [...new Set([
    url.replace(/vidmoly\.(net|to|biz|me|bz)/, 'vidmoly.net'),
    url.replace(/vidmoly\.(net|to|ru|is)/, 'vidmoly.me'),
    url.replace(/vidmoly\.(net|to|ru|is)/, 'vidmoly.biz'),
  ])];
  const hdrs = { Referer: 'https://vidmoly.me/', Origin: 'https://vidmoly.me' };
  for (const h of hosts) {
    const code0 = await getText(h, hdrs, 8000);
    if (!code0) continue;
    const code = deobfuscate(code0);
    const m = code.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
      || code.match(/sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i)
      || code.match(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
    if (m) return { url: m[1], headers: { Referer: 'https://vidmoly.me/' } };
  }
  return null;
}

async function extractYounetu(url) {
  const origin = ((url.match(/^https?:\/\/[^/]+/) || [])[0] || 'https://younetu.org') + '/';
  const code0 = await getText(url, { Referer: origin }, 8000);
  if (!code0) return null;
  const code = deobfuscate(code0);
  const m = code.match(/src\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
    || code.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
    || code.match(/sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i)
    || code.match(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  return m ? { url: m[1], headers: { Referer: origin } } : null;
}

async function extractVidoza(url) {
  const code = await getText(url, { Referer: 'https://vidoza.net/' }, 8000);
  if (!code) return null;
  const m = code.match(/<source[^>]+src=["']([^"']+)["']/i)
    || code.match(/src\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
    || code.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
    || code.match(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
  return m ? { url: m[1], headers: { Referer: 'https://vidoza.net/' } } : null;
}

async function extractFsvid(url, headers) {
  const host = String(url.split('/')[2] || 'fsvid.lol');
  const code0 = await getText(url, { Referer: 'https://' + host + '/', ...(headers || {}) }, 8000);
  if (!code0) return null;
  const code = deobfuscate(code0);
  const out = fsvidDecode(code, host);
  if (out) return { url: out, headers: { Referer: 'https://' + host + '/' } };
  const m = extractMediaUrl(code);
  return m ? { url: m, headers: { Referer: 'https://' + host + '/' } } : null;
}

async function genericResolver(url, headers) {
  const code0 = await getText(url, headers || {}, 8000);
  if (!code0) return null;
  let code = deobfuscate(code0);
  const red = code.match(/window\.location\.(?:href|replace)\s*=\s*['"]([^'"]+)['"]/);
  if (red && red[1] && red[1] !== url) {
    const r2 = await getText(red[1], headers || {}, 8000);
    if (r2) code = deobfuscate(r2);
  }
  const out = extractMediaUrl(code);
  if (out) {
    const clean = out.replace(/\\\//g, '/');
    return { url: clean.startsWith('//') ? 'https:' + clean : clean, headers: { Referer: url } };
  }
  const ifm = code.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (ifm) {
    let src = ifm[1];
    if (src.startsWith('//')) src = 'https:' + src;
    else if (src.startsWith('/')) { const mh = url.match(/^https?:\/\/[^/]+/); if (mh) src = mh[0] + src; }
    if (src.startsWith('http') && src !== url) return resolvePlayer(src, headers);
  }
  return null;
}

async function extractVeev(url) {
  const mh = url.match(/(?:\/\/|\.)(?:veev|kinoger|poophq|doods)\.(?:to|pw|com)\/[ed]\/([0-9A-Za-z]+)/);
  if (!mh) return null;
  const mediaId = mh[1];
  const code = await getText('https://veev.to/e/' + mediaId, {}, 8000);
  if (!code) return null;
  const found = [];
  const re = /[.\s'](?:fc|_vvto\[[^\]]*)(?:['\]]*)?\s*[:=]\s*['"]([^'"]+)/g;
  let m;
  while ((m = re.exec(code)) !== null) found.push(m[1]);
  for (let i = found.length - 1; i >= 0; i--) {
    const ch = veevLzw(found[i]);
    if (ch === found[i]) continue;
    const dl = await getJson('https://veev.to/dl?op=player_api&cmd=gi&file_code=' + mediaId + '&r=https://veev.to&ch=' + encodeURIComponent(ch) + '&ie=1', {}, 8000);
    if (!dl) continue;
    const file = dl && dl.file;
    if (!file || file.file_status !== 'OK' || !(file.dv && file.dv.length)) continue;
    const step1 = veevLzw(file.dv[0].s);
    const finalLink = veevFinal(step1, veevRules(ch));
    if (finalLink && finalLink.startsWith('http')) return { url: finalLink, headers: { Referer: 'https://veev.to/' } };
  }
  return null;
}

async function resolvePlayer(u, headers) {
  if (!u) return null;
  const url = String(u).trim();
  if (!url) return null;
  if (isDirectMedia(url)) return { url, headers: headers || {}, isDirect: true, type: url.includes('.m3u8') ? 'm3u8' : url.includes('.mpd') ? 'mpd' : url.includes('.mkv') ? 'mkv' : 'mp4' };
  const lower = url.toLowerCase();
  let task;
  if (lower.includes('sibnet')) task = extractSibnetV2(url);
  else if (lower.includes('vidmoly')) task = extractVidmoly(url);
  else if (lower.includes('sendvid') || lower.includes('daisukianime')) task = extractSendvid(url);
  else if (lower.includes('uqload') || lower.includes('oneupload')) task = extractUqload(url);
  else if (lower.includes('vidoza') || lower.includes('videzz')) task = extractVidoza(url);
  else if (lower.includes('voe') || lower.includes('weneverbeenfree') || lower.includes('maryspecialwatch') || lower.includes('charlestoughrace') || lower.includes('sandratableother')) task = extractVoe(url);
  else if (lower.includes('streamtape') || lower.includes('stape')) task = extractStreamtape(url);
  else if (lower.includes('dood') || lower.includes('ds2play') || lower.includes('bigwar5')) task = extractDood(url);
  else if (lower.includes('younetu') || lower.includes('netu.') || lower.includes('waaw')) task = extractYounetu(url);
  else if (lower.includes('veev') || lower.includes('kinoger') || lower.includes('poophq')) task = extractVeev(url);
  else if (lower.includes('fsvid') || lower.includes('vidzy') || lower.includes('vidstream.pro') || lower.includes('vidcdn')) task = extractFsvid(url, headers);
  else task = genericResolver(url, headers);
  const result = await task;
  if (!result || !result.url) return { url, headers: headers || {}, isDirect: false };
  if (result.url !== url && !FAKE_HOSTS.test(result.url)) {
    return {
      url: result.url,
      headers: { ...(headers || {}), ...(result.headers || {}) },
      isDirect: !DECOY.test(result.url),
      type: result.url.includes('.m3u8') ? 'm3u8' : result.url.includes('.mpd') ? 'mpd' : result.url.includes('.mkv') ? 'mkv' : 'mp4',
    };
  }
  return { url, headers: headers || {}, isDirect: false };
}

async function resolveIframe(iUrl, referer) {
  const r = await resolvePlayer(iUrl, { Referer: referer });
  if (!r || !r.url) return [];
  if (!r.isDirect && r.url === iUrl) return [];
  return [{ url: r.url, format: r.type || (r.url.includes('.m3u8') ? 'm3u8' : 'mp4'), headers: r.headers || {} }];
}

// ─── TMDB title helper ────────────────────────────────────────────────────────

async function getTmdbTitle(tmdbId, type) {
  const key = await config.get('TMDB_API_KEY');
  const path = `/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}`;
  const params = new URLSearchParams({ language: 'fr-FR', append_to_response: 'external_ids' });
  const headers = key.length > 80 ? { Authorization: `Bearer ${key}` } : {};
  if (key.length <= 80) params.set('api_key', key);
  let d = null;
  try {
    const r = await fetch(`https://api.themoviedb.org/3${path}?${params}`, { headers, signal: AbortSignal.timeout(8000) });
    d = r.ok ? await r.json() : null;
  } catch { d = null; }
  if (!d) return null;
  return {
    fr:   d.title || d.name || '',
    en:   d.original_title || d.original_name || d.title || d.name || '',
    year: (d.release_date || d.first_air_date || '').slice(0, 4),
    imdb: d.external_ids?.imdb_id || '',
    lang: d.original_language || '',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDERS TMDB-NATIFS
// ═══════════════════════════════════════════════════════════════════════════════

async function vidlink(id, type, s, e) {
  const base = 'https://vidlink.pro';
  const path = type === 'tv' && s && e ? `/tv/${id}/${s}/${e}` : `/movie/${id}`;
  const d = await getJson(base + path, { Accept: 'application/json', Referer: base + '/' });
  if (!d) return [];
  const sources = d.stream?.playlist || d.playlist || d.sources || [];
  const arr = (Array.isArray(sources) ? sources : []).map(x => ({
    url: x.file || x.url || '', quality: x.label || 'Auto', name: `VidLink — ${x.label || 'Auto'}`, language: 'Multi',
  }));
  if (!arr.length && (d.url || d.stream_url))
    arr.push({ url: d.url || d.stream_url, quality: 'Auto', name: 'VidLink', language: 'Multi' });
  return normAll(arr, 'VidLink');
}

async function xpass(id, type, s, e) {
  const base = 'https://xpwatch.com';
  const url = type === 'tv' && s && e
    ? `${base}/api/episode?tmdb=${id}&s=${s}&e=${e}` : `${base}/api/movie?tmdb=${id}`;
  const d = await getJson(url, { Referer: base + '/', Origin: base });
  if (!d) return [];
  const sources = d.backups || d.sources || d.streams || (Array.isArray(d) ? d : []);
  const arr = sources.map(x => ({ url: x.url || x.link || '', quality: x.quality || x.label || 'Auto',
    name: `XPass — ${x.label || x.name || 'Auto'}`, language: x.lang || 'Multi', headers: x.headers || {} }));
  if (!arr.filter(x => x.url).length && typeof d.playlist === 'string') {
    const pl = await getJson(d.playlist, { Referer: base + '/' });
    const items = Array.isArray(pl) ? pl : (pl?.sources || []);
    for (const x of items) if (x.file || x.url) arr.push({ url: x.file || x.url, quality: x.label || 'Auto', name: `XPass — ${x.label || 'Auto'}`, language: 'Multi' });
  }
  return normAll(arr, 'XPass');
}

async function mapple(id, type, s, e) {
  const base = 'https://mapple.uk';
  const url = type === 'tv' && s && e
    ? `${base}/api/tv?tmdb=${id}&season=${s}&episode=${e}` : `${base}/api/movie?tmdb=${id}`;
  const d = await getJson(url, { Referer: base + '/', Origin: base });
  if (!d) return [];
  const sources = d.sources || d.streams || d.results || (Array.isArray(d) ? d : []);
  return normAll(sources.map(x => ({ ...x, name: `Mapple — ${x.name || x.quality || 'Auto'}` })), 'Mapple');
}

async function nakios(id, type, s, e) {
  const base = 'https://nakios.store';
  const url = type === 'tv' && s && e
    ? `${base}/api/streams/tv/${id}?season=${s}&episode=${e}` : `${base}/api/streams/movie/${id}`;
  const d = await getJson(url, { Referer: base + '/', Origin: base });
  if (!d) return [];
  const sources = d.streams || d.sources || d.results || (Array.isArray(d) ? d : []);
  return normAll(sources.map(x => ({ ...x, name: `Nakios — ${x.quality || x.label || 'Auto'}`, language: x.language || 'Multi' })), 'Nakios');
}

async function papadustream(id, type, s, e) {
  if (type !== 'tv') return [];
  const base = 'https://papadustream.club';
  const d = await getJson(`${base}/api/tmdb/${id}/season/${s || 1}/episode/${e || 1}`, { Referer: base + '/', Origin: base });
  if (!d) return [];
  const sources = d.streams || d.sources || d.links || (Array.isArray(d) ? d : []);
  return normAll(sources.map(x => ({
    url: x.url || x.hls || x.link || '', quality: x.quality || x.label || 'Auto',
    name: `Papadustream — ${x.quality || 'Auto'}`, language: x.language || 'fr', format: 'm3u8',
  })), 'Papadustream');
}

async function autoembed(id, type, s, e) {
  const base = 'https://autoembed.co';
  const qs = type === 'tv' && s && e
    ? `tmdb_id=${id}&type=tv&season=${s}&episode=${e}` : `tmdb_id=${id}&type=movie&season=&episode=`;
  const d = await getJson(`${base}/api/v2/episode?${qs}`, { Referer: base + '/' });
  if (!d) return [];
  const sources = d.streams || d.sources || (Array.isArray(d) ? d : []);
  return normAll(sources.map(x => ({
    url: x.url || x.file || '', quality: x.quality || 'Auto',
    name: `AutoEmbed — ${x.quality || 'Auto'}`, language: x.language || 'Multi',
  })), 'AutoEmbed');
}

// ═════════════════════════════════════════════════════════════════════════
// PROVIDERS SCRAPING-TITRE

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDERS SCRAPING-TITRE
// ═══════════════════════════════════════════════════════════════════════════════

async function frenchstream(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://french-stream.one';
  const q = encodeURIComponent(t.fr || t.en);
  const res = await fetch(`${base}/engine/ajax/search.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: base + '/' },
    body: `query=${q}`,
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  const html = res ? await res.text().catch(() => '') : '';
  if (!html) return [];
  const lmm = html.match(/location\.href='([^']+)'/);
  const lm = lmm ? (lmm[1].startsWith('http') ? lmm[1] : base + lmm[1]) : null;
  if (!lm) return [];
  let page = await getText(lm, { Referer: base + '/' });
  if (!page) return [];
  if (type === 'tv' && s && e) {
    const em = page.match(new RegExp(`href="([^"]+saison.{0,6}${s}[^"]*episode.{0,6}${e}[^"]+)"`, 'i'))
      || page.match(/href="([^"]+\/episode-\d[^"]+)"/i);
    if (em) page = await getText(em[1], { Referer: lm }) || page;
  }
  const streams = extractDirectUrls(page);
  const embedUrls = [...page.matchAll(/data-url="([^"]+)"/gi)].map(m => m[1]);
  const targets = [...new Set([...extractIframes(page), ...embedUrls])];
  const subs = await Promise.all(targets.slice(0, 4).map(iUrl => resolveIframe(iUrl, base + '/').catch(() => [])));
  subs.forEach(s => s.forEach(u => streams.push(u)));
  const sibs = [...page.matchAll(/sibnet\.ru[^"']*?(\d{6,})/gi)].map(m => m[1]);
  const sibStreams = await Promise.all(sibs.slice(0, 3).map(async vid => {
    const r = await resolveSibnet(vid);
    return r ? { url: r, format: 'mp4' } : null;
  }));
  for (const r of sibStreams) if (r) streams.push(r);
  return normAll(streams.map((x, i) => ({ ...x, name: `FrenchStream — Source ${i + 1}`, language: 'VF' })), 'FrenchStream');
}

async function coflix(id, type, s, e, t) {
  if (!t) return [];
  const origins = ['https://coflix.esq', 'https://coflix.blue', 'https://coflix.cymru'];
  let base = null;
  const probes = await Promise.allSettled(origins.map(async o => {
    const h = await getText(o + '/', {}, 4000);
    return h ? o : null;
  }));
  base = probes.find(p => p.status === 'fulfilled' && p.value)?.value || null;
  if (!base) return [];
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/?s=${q}`, { Referer: base + '/' }, 8000);
  if (!html) return [];
  const lm = html.match(/href="([^"]*\/(?:film|serie)\/[^"]*)"/i);
  if (!lm) return [];
  const pageUrl = lm[1].startsWith('http') ? lm[1] : base + lm[1];
  let page = await getText(pageUrl, { Referer: base + '/' }, 8000);
  if (!page) return [];

  // Série : naviguer vers la page de l'épisode demandé
  if (type === 'tv' && s && e) {
    const epUrl = coflixEpisodeUrl(page, base, s, e);
    if (epUrl) {
      const epPage = await getText(epUrl, { Referer: base + '/' }, 8000);
      if (epPage) page = epPage;
    }
  }

  // cfServers[] + cfPlayerToken → lecteurvideo.com → showVideo(base64)
  const tokenM = page.match(/var\s+cfPlayerToken\s*=\s*"([^"]+)"/);
  const token = tokenM ? tokenM[1] : '';
  const aggs = [];
  const sm = page.match(/var\s+cfServers\s*=\s*(\[[\s\S]*?\]);/);
  if (sm) {
    try { for (const x of JSON.parse(sm[1])) if (x.embed_url) aggs.push(x.embed_url.replace(/\\\//g, '/')); } catch { /* fall through */ }
  }
  if (!aggs.length) {
    const im = page.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (im && im[1]) aggs.push(im[1].replace(/&#0?38;/g, '&'));
  }
  const streams = [];
  const seen = new Set();
  const aggUrls = aggs.slice(0, 3).map(agg => {
    if (agg.includes('lecteurvideo.com') && token && !agg.includes('t=')) return agg + (agg.includes('?') ? '&' : '?') + 't=' + token;
    return agg;
  });
  const aggHtmls = await Promise.all(aggUrls.map(u => getText(u, { Referer: base + '/' }, 8000)));
  const decUrls = [];
  for (const ah of aggHtmls) {
    if (!ah) continue;
    for (const m of ah.matchAll(/onclick=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/li>/gi)) {
      const onclick = m[1] !== undefined ? m[1] : m[2];
      const sv = onclick.match(/showVideo\(\s*'([^']+)'/);
      if (!sv) continue;
      const dec = b64dec(sv[1]);
      if (!dec || !dec.startsWith('http') || seen.has(dec)) continue;
      seen.add(dec);
      decUrls.push(dec);
    }
  }
  const resolved = await Promise.all(decUrls.map(async d => {
    const r = await resolvePlayer(d, { Referer: 'https://lecteurvideo.com/' }).catch(() => null);
    return r && r.url && r.url !== d && !FAKE.test(r.url) ? r : null;
  }));
  for (const r of resolved) {
    if (!r) continue;
    streams.push({ url: r.url, format: r.type || (r.url.includes('.m3u8') ? 'm3u8' : 'mp4'), name: 'Coflix — lecteur', language: 'VF', headers: r.headers || {} });
  }
  return normAll(streams, 'Coflix');
}

function coflixEpisodeUrl(html, origin, season, episode) {
  let searchFrom = 0;
  while (true) {
    const pOpen = html.indexOf('<div class="cf-episodes-panel', searchFrom);
    if (pOpen === -1) break;
    const kM = html.slice(pOpen, pOpen + 300).match(/data-panel="([^"]+)"/);
    const gt = html.indexOf('>', pOpen);
    if (gt === -1) break;
    const inner = html.slice(gt + 1, html.indexOf('</div>', gt));
    if (kM && String(kM[1]) === String(season)) {
      for (const em of inner.matchAll(/location\.href=['"]([^'"]+)['"]/gi)) {
        const href = em[1];
        const n = (href.match(/(\d+)/) || [])[1];
        if (String(n) === String(episode)) return href.startsWith('http') ? href : origin + href;
      }
      break;
    }
    searchFrom = pOpen + 1;
  }
  return null;
}

async function flemmix(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://flemmix.me';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/?s=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const lm = html.match(/href="(https:\/\/flemmix\.me\/[^"]+)"/i);
  if (!lm) return [];
  const page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  const streams = extractDirectUrls(page);
  const subs = await Promise.all(extractIframes(page).slice(0, 3).map(iUrl => resolveIframe(iUrl, base + '/').catch(() => [])));
  subs.forEach(s => s.forEach(u => streams.push(u)));
  return normAll(streams.map((x, i) => ({ ...x, name: `Flemmix — Source ${i + 1}`, language: 'VF' })), 'Flemmix');
}

async function wookafr(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://wookafr.center';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/search/${q}/`, { Referer: base + '/' });
  if (!html) return [];
  const navRe = /\/(?:slider|country|collections|series|production|years|category|films|genres|page|wp-content)\//i;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ');
  const words = norm(t.fr || t.en).split(' ').filter(w => w.length >= 4);
  const candidates = [...html.matchAll(/href="(https:\/\/wookafr\.center\/streaming\/[^"]+)"/gi)].map(m => m[1]).filter(u => !navRe.test(u));
  const lm = candidates.find(u => words.some(w => norm(u).includes(w))) || candidates[0];
  if (!lm) return [];
  const page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  const streams = extractDirectUrls(page);
  const subs = await Promise.all(extractIframes(page).slice(0, 3).map(iUrl => resolveIframe(iUrl, base + '/').catch(() => [])));
  subs.forEach(s => s.forEach(u => streams.push(u)));
  return normAll(streams.map((x, i) => ({ ...x, name: `Wookafr — Source ${i + 1}`, language: 'VF' })), 'Wookafr');
}

async function movix(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://movix.fun';
  const apiUrl = type === 'tv' && s && e
    ? `${base}/api/streams?tmdb=${id}&type=tv&season=${s}&episode=${e}`
    : `${base}/api/streams?tmdb=${id}&type=movie`;
  const d = await getJson(apiUrl, { Referer: base + '/', Origin: base });
  if (d) {
    const sources = d.streams || d.sources || d.results || (Array.isArray(d) ? d : []);
    if (sources.length)
      return normAll(sources.map(x => ({ ...x, name: `Movix — ${x.quality || x.label || 'Auto'}`, language: x.language || 'VF' })), 'Movix');
  }
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/?s=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const lm = html.match(/href="(https:\/\/movix\.fun\/[^"]+)"/i);
  if (!lm) return [];
  const page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  const streams = extractDirectUrls(page);
  return normAll(streams.map((x, i) => ({ ...x, name: `Movix — Source ${i + 1}`, language: 'VF' })), 'Movix');
}

async function mugiwarastream(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://mugiwara-no-streaming.com';
  const q = encodeURIComponent(t.fr || t.en);
  const d = await getJson(`${base}/api/search?q=${q}`, { Referer: base + '/' });
  if (!d) return [];
  const items = d.results || d.data || (Array.isArray(d) ? d : []);
  const first = items[0];
  if (!first) return [];
  const slug = first.slug || first.id || '';
  const sdUrl = type === 'tv' && s && e
    ? `${base}/api/episode?slug=${slug}&season=${s}&episode=${e}`
    : `${base}/api/movie?slug=${slug}`;
  const sd = await getJson(sdUrl, { Referer: base + '/' });
  if (!sd) return [];
  const sources = sd.sources || sd.streams || sd.links || (Array.isArray(sd) ? sd : []);
  const streams = [];
  for (const x of sources) {
    const url = x.url || x.link || x.file || '';
    if (!url) continue;
    if (/sibnet/i.test(url)) {
      const vid = url.match(/videoid=(\d+)/)?.[1];
      if (vid) { const r = await resolveSibnet(vid); if (r) streams.push({ url: r, format: 'mp4', name: 'Mugiwara — Sibnet', language: 'VF' }); }
    } else {
      streams.push({ url, format: url.includes('.m3u8') ? 'm3u8' : 'mp4', name: `Mugiwara — ${x.label || x.quality || 'Auto'}`, language: 'VF' });
    }
  }
  return normAll(streams, 'Mugiwara');
}

async function animesama(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://anime-sama.fr';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/catalogue/?search=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const lm = html.match(/href="(https:\/\/anime-sama\.fr\/catalogue\/[^"]+)"/i);
  if (!lm) return [];
  const saison = s || 1;
  const ep = e || 1;
  const epPage = await getText(`${lm[1]}saison${saison}/`, { Referer: base + '/' });
  if (!epPage) return [];
  const streams = [];
  for (const m of epPage.matchAll(/eps\d*\s*=\s*\[([^\]]+)\]/g)) {
    const urls = m[1].match(/["'](https?:\/\/[^"']+)["']/g) || [];
    const epUrl = urls[Number(ep) - 1] || urls[0];
    if (!epUrl) continue;
    const url = epUrl.replace(/["']/g, '');
    if (/sibnet/i.test(url)) {
      const vid = url.match(/videoid=(\d+)/)?.[1];
      if (vid) { const r = await resolveSibnet(vid); if (r) streams.push({ url: r, format: 'mp4', name: 'AnimeSama — Sibnet', language: 'VF' }); }
    } else {
      streams.push({ url, format: url.includes('.m3u8') ? 'm3u8' : 'mp4', name: 'AnimeSama — lecteur', language: 'VF' });
    }
  }
  return normAll(streams, 'AnimeSama');
}

async function animoflix(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://animoflix.to';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/?s=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const lm = html.match(/href="(https:\/\/animoflix\.to\/[^"]+)"/i);
  if (!lm) return [];
  let page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  if (type === 'tv' && s && e) {
    const em = page.match(new RegExp(`href="([^"]+episode-${e}[^"]+)"`, 'i'));
    if (em) page = await getText(em[1], { Referer: base + '/' }) || page;
  }
  const streams = extractDirectUrls(page);
  const subs = await Promise.all(extractIframes(page).slice(0, 3).map(iUrl => resolveIframe(iUrl, base + '/').catch(() => [])));
  subs.forEach(s => s.forEach(u => streams.push(u)));
  return normAll(streams.map((x, i) => ({ ...x, name: `AnimoFlix — Source ${i + 1}`, language: 'VF' })), 'AnimoFlix');
}

async function dulourd(id, type, s, e, t) {
  if (!t || type !== 'tv') return [];
  const base = 'https://www.dulourd.hair';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/?do=search&subaction=search&story=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const lm = html.match(/href="(https:\/\/www\.dulourd\.hair\/[^"]+)"/i);
  if (!lm) return [];
  const page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  const streams = [];
  const subs = await Promise.all(extractIframes(page).slice(0, 5).map(async (iUrl) => {
    if (/sibnet/i.test(iUrl)) {
      const vid = iUrl.match(/videoid=(\d+)/)?.[1] || iUrl.match(/embed\/(\d+)/)?.[1];
      if (vid) { const r = await resolveSibnet(vid); if (r) return [{ url: r, format: 'mp4', name: 'DuLourd — Sibnet', language: 'VF' }]; }
      return [];
    }
    const sub = await resolveIframe(iUrl, base + '/').catch(() => []);
    return sub.map(u => ({ ...u, name: 'DuLourd — lecteur', language: 'VF' }));
  }));
  subs.forEach(s => s.forEach(u => streams.push(u)));
  return normAll(streams, 'DuLourd');
}

async function streamzo(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://streamzo.fr';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/recherche/?q=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const lm = html.match(/href="(https:\/\/streamzo\.fr\/(?:film|serie)[^"]+)"/i);
  if (!lm) return [];
  const page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  const streams = extractDirectUrls(page);
  const players = [...page.matchAll(/(?:data-src|src)="(https?:\/\/[^"]+)"/gi)]
    .map(m => m[1]).filter(u => /player|embed|stream/i.test(u));
  for (const iUrl of players.slice(0, 4)) {
    const sub = await resolveIframe(iUrl, base + '/');
    sub.forEach(u => streams.push(u));
  }
  return normAll(streams.map((x, i) => ({ ...x, name: `StreamZo — Source ${i + 1}`, language: 'VF' })), 'StreamZo');
}

async function sekai(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://sekai.one';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/?s=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const navRe = /\/(?:page|category|tag|genre|annee|acteur|wp-content)\/|\.(webp|png|jpg|css|js)(\?|")/i;
  const lm = [...html.matchAll(/href="(https:\/\/sekai\.one\/[^"]+)"/gi)].map(m => m[1]).filter(u => !navRe.test(u))[0];
  if (!lm) return [];
  const page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  const streams = extractDirectUrls(page);
  for (const m of page.matchAll(/(?:file|src|url)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)/gi))
    streams.push({ url: m[1], format: m[1].includes('.m3u8') ? 'm3u8' : 'mp4' });
  return normAll(streams.map((x, i) => ({ ...x, name: `Sekai — Source ${i + 1}`, language: 'VF' })), 'Sekai');
}

async function vostfree(id, type, s, e, t) {
  if (!t) return [];
  const base = 'https://vostfree.ws';
  const q = encodeURIComponent(t.fr || t.en);
  const html = await getText(`${base}/?do=search&subaction=search&story=${q}`, { Referer: base + '/' });
  if (!html) return [];
  const lm = html.match(/href="(https:\/\/vostfree\.ws\/[^"]+)"/i);
  if (!lm) return [];
  let page = await getText(lm[1], { Referer: base + '/' });
  if (!page) return [];
  if (type === 'tv' && s && e) {
    const em = page.match(new RegExp(`href="([^"]+episode${e}[^"]+)"`, 'i'))
      || page.match(/href="([^"]+\/episode-\d[^"]+)"/i);
    if (em) page = await getText(em[1], { Referer: base + '/' }) || page;
  }
  const streams = [];
  const subs = await Promise.all(extractIframes(page).slice(0, 5).map(async (iUrl) => {
    if (/sibnet/i.test(iUrl)) {
      const vid = iUrl.match(/videoid=(\d+)/)?.[1] || iUrl.match(/embed\/(\d+)/)?.[1];
      if (vid) { const r = await resolveSibnet(vid); if (r) return [{ url: r, format: 'mp4', name: 'Vostfree — Sibnet', language: 'VOSTFR' }]; }
      return [];
    }
    const sub = await resolveIframe(iUrl, base + '/').catch(() => []);
    return sub.map(u => ({ ...u, name: 'Vostfree — lecteur', language: 'VOSTFR' }));
  }));
  subs.forEach(s => s.forEach(u => streams.push(u)));
  return normAll(streams, 'Vostfree');
}

// ═════════════════════════════════════════════════════════════════════
// Providers TMDB-ID récupérés depuis GitHub (Inside4ndroid/TMDB-Embed-API)
// ═════════════════════════════════════════════════════════════════════

// Cache DB pour les gros payloads de providers (ex : data.json StreamFlix ≈ 3 Mo)
async function cachedJson(key, ttlMs, fetcher) {
  try {
    const { rows } = await db.query('SELECT value, updated_at FROM kv_cache WHERE key = $1', [key]);
    if (rows.length && Date.now() - new Date(rows[0].updated_at).getTime() < ttlMs) return rows[0].value;
  } catch { /* table pas encore migrée : on refetch directement */ }
  const fresh = await fetcher();
  if (fresh !== null && fresh !== undefined) {
    try {
      await db.query(
        'INSERT INTO kv_cache (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [key, JSON.stringify(fresh)]
      );
    } catch { /* cache best-effort */ }
  }
  return fresh;
}

async function streamflix(tmdbId, type, s, e) {
  try {
    const data = await cachedJson('sf_data', 30 * 60 * 1000, () =>
      getJson('https://api.streamflix.app/data.json', { 'User-Agent': UA, Referer: 'https://streamflix.app/' }, 25000));
    const cfg = await cachedJson('sf_cfg', 86400 * 1000, () =>
      getJson('https://api.streamflix.app/config/config-streamflixapp.json', { 'User-Agent': UA, Referer: 'https://streamflix.app/' }, 10000));
    const items = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const match = items.find(x => x && String(x.tmdb) === String(tmdbId));
    if (!match) return [];
    const bases = [...new Set([...(cfg?.download || []), ...(cfg?.movies || []), ...(cfg?.tv || [])])].filter(Boolean);
    if (!bases.length) return [];
    if (type === 'movie') {
      if (!match.movielink) return [];
      const streams = bases.map((base, i) => ({ url: base + match.movielink, quality: 'Auto', name: `StreamFlix${i ? ' Mirror ' + i : ''}`, language: 'EN' }));
      return normAll(streams, 'StreamFlix');
    }
    if (!s || !e || !match.moviekey) return [];
    const eps = await cachedJson(`sf_ep_${match.moviekey}_${s}`, 60 * 60 * 1000, () =>
      getJson(`https://chilflix-410be-default-rtdb.asia-southeast1.firebasedatabase.app/Data/${match.moviekey}/seasons/${s}/episodes.json`, {}, 10000));
    const ep = (eps && (eps[String(e - 1)] || eps[String(e)])) || null;
    if (!ep || !ep.link) return [];
    const streams = bases.map((base, i) => ({ url: base + ep.link, quality: 'Auto', name: `StreamFlix${i ? ' Mirror ' + i : ''}`, language: 'EN' }));
    return normAll(streams, 'StreamFlix');
  } catch { return []; }
}

// ── Videasy (chiffrement seed + keystream, vérifié en runtime) ─────────
const VD_API  = 'https://api.speedracelight.com';
const VD_HDRS = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://player.videasy.net', Referer: 'https://player.videasy.net/' };
const VD_MAGIC = [109, 118, 109, 49];
const VD_HASH  = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580];
const vdU32 = x => x >>> 0;
const vdMul = (a, b) => Math.imul(a, b) >>> 0;
const vdRotl = (x, n) => { x >>>= 0; n &= 31; return n === 0 ? x : ((x << n) | (x >>> (32 - n))) >>> 0; };
const vdHash = x => { x = vdU32(x); x ^= x >>> 16; x = vdMul(x, 2246822507); x ^= x >>> 13; x = vdMul(x, 3266489909); x ^= x >>> 16; return vdU32(x); };
const vdFnv = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = vdMul(h ^ s.charCodeAt(i), 16777619); return vdHash(h); };
function vdInit(seed, secondKey) {
  const S = new Array(61);
  let a = vdU32(vdHash(vdFnv(seed) ^ vdHash(vdU32((secondKey >>> 0) ^ 2654435769))));
  for (let i = 0; i < 8; i++) {
    const idx = a % 61;
    a = vdRotl(a + vdU32(2654435769), 7 + (7 & i));
    S[idx] = vdU32(a ^ vdHash(a));
    a = vdHash(vdU32(a + idx));
  }
  return { S, acc: vdU32(vdHash(2779096485 ^ a)) };
}
function vdNext(st, ctr) {
  const r = st.S, o = st.acc, n = o % 61;
  const inSet = 0 - Number(n in r);
  const d = r[n] >>> 0;
  const x = vdU32(d ^ vdMul(2654435769, ctr + 1));
  const y = vdU32((o ^ x) | (o & x & inSet));
  const no = vdHash(vdU32(vdRotl(vdU32(y + o), 31 & n) ^ vdRotl(o, 31 & Math.imul(n, 7))) + 2654435769);
  r[n] = no >>> 0;
  st.acc = no;
  return no >>> 0;
}
function vdKeystream(seed, secondKey, len) {
  const st = vdInit(seed, secondKey);
  const out = new Uint8Array(len);
  let ctr = 0;
  for (let i = 0; i < len;) {
    const b = vdNext(st, ctr++);
    out[i++] = 255 & b;
    if (i < len) out[i++] = (b >>> 8) & 255;
    if (i < len) out[i++] = (b >>> 16) & 255;
    if (i < len) out[i++] = (b >>> 24) & 255;
  }
  return out;
}
function vdDecrypt(payload, seed, secondKey) {
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(payload.length / 4), '=');
  const bin = atob(b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const ks = vdKeystream(seed, secondKey, data.length);
  for (let i = 0; i < data.length; i++) data[i] ^= ks[i];
  if (!(data[0] === VD_MAGIC[0] && data[1] === VD_MAGIC[1] && data[2] === VD_MAGIC[2] && data[3] === VD_MAGIC[3])) return null;
  try { return JSON.parse(new TextDecoder().decode(data.subarray(4))); } catch { return null; }
}
async function videasy(tmdbId, type, s, e, t) {
  return cachedJson(`vd:${tmdbId}:${type}`, 60 * 60 * 1000, async () => {
  try {
    if (!t || !t.en) return [];
    const seedRes = await fetch(`${VD_API}/seed?mediaId=${tmdbId}`, { headers: VD_HDRS, signal: AbortSignal.timeout(10000) });
    if (!seedRes.ok) return [];
    const seed = (await seedRes.json()).seed;
    if (!seed) return [];
    const mediaType = type === 'tv' ? 'Tv' : 'Movie';
    // Serveurs vérifiés : CDN OK. LaMovie (vimeos.zip) = 403, Meine = 500 → retirés.
    const servers = [
      { label: 'CDN', path: 'cdn/sources-with-title' },
    ];
    const results = [];
    await Promise.allSettled(servers.filter(sv => !sv.moviesOnly || type === 'movie').map(async (sv) => {
      const params = new URLSearchParams({
        title: t.en, mediaType, year: t.year || '', tmdbId: String(tmdbId),
        imdbId: t.imdb || '', enc: '2', seed,
      });
      const r = await fetch(`${VD_API}/${sv.path}?${params}`, { headers: VD_HDRS, signal: AbortSignal.timeout(12000) });
      if (!r.ok) return;
      const txt = await r.text();
      if (!txt) return;
      const j = vdDecrypt(txt, seed, String(tmdbId));
      if (!j || !Array.isArray(j.sources)) return;
      for (const src of j.sources) {
        if (!src || !src.url) continue;
        results.push({
          url: src.url,
          quality: src.quality || 'Auto',
          name: `Videasy — ${sv.label}`,
          language: 'Multi',
          format: /\.mp4(\?|$|\/)/i.test(src.url) ? 'mp4' : 'm3u8',
        });
      }
    }));
    return normAll(results, 'Videasy');
  } catch { return []; }
  });
}

async function vaplayer(tmdbId, type, s, e, t) {
  try {
    if (!t || !t.imdb) return [];
    const params = new URLSearchParams({ imdb: t.imdb, type: type === 'tv' ? 'tv' : 'movie' });
    if (type === 'tv' && s && e) { params.set('season', s); params.set('episode', e); }
    const referer = type === 'tv'
      ? `https://nextgencloudfabric.com/embed/tv/${t.imdb}/${s}/${e}`
      : `https://nextgencloudfabric.com/embed/movie/${t.imdb}`;
    const d = await getJson(`https://streamdata.vaplayer.ru/api.php?${params}`, { Referer: referer, Origin: 'https://nextgencloudfabric.com' }, 12000);
    if (!d) return [];
    if (String(d.status_code) !== '200') return [];
    const urls = (d.data && Array.isArray(d.data.stream_urls)) ? d.data.stream_urls : [];
    const seen = new Set();
    const streams = [];
    for (const url of urls) {
      if (typeof url !== 'string' || url.length < 12 || FAKE.test(url) || seen.has(url)) continue;
      seen.add(url);
      streams.push({ id: 'VaPlayer', url, quality: 'Auto', name: `VaPlayer HLS ${streams.length + 1}`, language: t.lang === 'ja' ? 'VOSTFR' : 'Multi', format: 'm3u8' });
    }
    return streams;
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  const tmdbId  = String(req.query.tmdbId  || '').replace(/\D/g, '');
  const type    = req.query.type === 'tv' ? 'tv' : 'movie';
  const season  = String(req.query.season  || '').replace(/\D/g, '');
  const episode = String(req.query.episode || '').replace(/\D/g, '');
  const only    = String(req.query.provider || 'all').toLowerCase();

  if (!tmdbId) return res.status(400).json({ error: 'tmdbId manquant.' });

  const cacheKey = `nuv:${tmdbId}:${type}:${season || 0}:${episode || 0}`;
  const cached = await cachedJson(cacheKey, 30 * 60 * 1000, async () => {
    // Tous les providers tournent en parallèle ; la réponse part à 6,5 s,
    // ou 14 s si le contenu est un anime (les bundles Gowaru sont des sources anime).
    const collected = [];
    const grab = p => p.then(v => { if (Array.isArray(v)) collected.push(...v); return v; }).catch(() => null);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // Budget par provider : un provider lent ne bloque jamais les autres
    const cap = (p, ms) => Promise.race([p, sleep(ms).then(() => [])]);

    const titleP = grab(getTmdbTitle(tmdbId, type));
    const natives = [
      vidlink, xpass, mapple, nakios, papadustream, autoembed, streamflix,
    ];
    // videasy + vaplayer + scraping ont besoin du titre TMDB
    const scrapers = [
      videasy, vaplayer, frenchstream, coflix, flemmix, wookafr, movix, mugiwarastream,
      animesama, animoflix, dulourd, streamzo, sekai, vostfree,
    ];
    // Budget étendu pour les bundles Gowaru (calibrés 45 s : probes multi-domaines)
    const GOWARU_BUDGET = 14000;
    const abortGowaru = new AbortController();
    const tasks = [
      titleP,
      ...natives.map(fn => grab(cap(fn(tmdbId, type, season, episode), 5500))),
      ...scrapers.map(fn => grab(cap(titleP.then(t => fn(tmdbId, type, season, episode, t)), 5500))),
      // Providers Gowaru (bundle nuvio-providers) : autonomes en TMDB-id
      ...GOWARU_PROVIDERS.map(p => grab(cap(gowaruStreams(p.id, tmdbId, type, season, episode, abortGowaru.signal), GOWARU_BUDGET))),
    ];
    const baseWait = 6500;
    const t0 = await titleP;
    // Contenu japonais → on laisse tourner les providers anime jusqu'au budget Gowaru
    const isAnime = t0?.lang === 'ja'
      || /[\u3040-\u30ff\u4e00-\u9fff]/.test(t0?.en || '')
      || /\b(?:anime|manga|shonen|shoujo|seinen)\b/i.test(t0?.en || '');
    const budget = isAnime ? GOWARU_BUDGET : baseWait;
    await Promise.race([Promise.all(tasks), sleep(budget)]);
    if (!isAnime) abortGowaru.abort();

    return { streams: collected, title: t0?.fr || t0?.en || '', imdb: t0?.imdb || '' };
  });

  // Merge + déduplication URL
  const seen = new Set();
  const streams = (cached?.streams || []).filter(s => {
    if (!s?.url || seen.has(s.url)) return false;
    // MKV/WebM non lisibles par les navigateurs → exclus du résultat
    if (s.format === 'mkv' || s.format === 'webm') return false;
    seen.add(s.url);
    return true;
  });

  // Filtre par provider si demandé
  const filtered = only === 'all' ? streams : streams.filter(s => s.id.toLowerCase().startsWith(only));

  res.json({
    streams: filtered,
    total: filtered.length,
    providers: 21 + GOWARU_PROVIDERS.length,
    title: cached?.title || '',
    imdb: cached?.imdb || '',
  });
}