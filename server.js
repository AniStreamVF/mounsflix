import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Charge le fichier .env s'il existe (aucune dépendance requise)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* pas de .env */ }

import tmdb from './api/tmdb.js';
import subs from './api/subs.js';
import nuvio from './api/nuvio.js';
import mproxy from './api/mproxy.js';

const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error('route error', req.path, e);
    if (!res.headersSent) res.status(500).json({ error: String(e).slice(0, 200) });
  }
};

app.get('/api/tmdb', wrap(tmdb));
app.get('/api/subs', wrap(subs));
app.get('/api/nuvio', wrap(nuvio));
app.get('/api/mproxy/stream.m3u8', wrap(mproxy));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = Number(process.env.PORT) || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`MounsFlix prêt sur http://0.0.0.0:${PORT}`));
}

export default app;