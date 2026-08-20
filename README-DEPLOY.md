# MounsFlix — App Node standalone (hors Hatchable)

Ce dossier est le portage complet du site en **Node.js + Express**, prêt à tourner
sur n'importe quel hébergeur (Render, Railway, Koyeb, VPS, Docker…). Plus aucune
dépendance à Hatchable.

## Contenu

```
mounsflix-app/
├── server.js          ← serveur Express (routes + statique)
├── lib/shim.js        ← émulation du SDK Hatchable (config=env, db=pg|mémoire)
├── api/
│   ├── nuvio.js       ← moteur 21 providers (le cœur)
│   ├── tmdb.js        ← catalogue TMDB
│   ├── subs.js        ← sous-titres OpenSubtitles
│   └── mproxy.js      ← proxy média HLS/CDN
├── public/index.html  ← l'app front complète
├── package.json       ← express + pg (Node >= 18)
├── Dockerfile         ← déploiement conteneur
├── render.yaml        ← blueprint Render (1 clic)
└── .env.example       ← variables d'environnement
```

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `TMDB_API_KEY` | **oui** | Token/API key TMDB (catalogue + enrichissement des sources) |
| `OPENSUBTITLES_API_KEY` | non | Recherche de sous-titres |
| `OPENSUBTITLES_USER` + `OPENSUBTITLES_PASS` | non | Téléchargement des sous-titres |
| `DATABASE_URL` | non | Postgres (cache persistant) — sinon cache en mémoire |
| `PORT` | non | Défaut 3000 |

Sans `DATABASE_URL`, le cache de sources est **en mémoire** : perdu au redémarrage et
non partagé entre instances (mettre `max: 1` instance). Une base gratuite
(Neon / Supabase) est recommandée : récupère `migrations/001_kv_cache.sql` du dossier
`../mounsflix/` et exécute-le pour créer la table `kv_cache`.

## Lancer en local

```bash
npm install
cp .env.example .env   # remplir TMDB_API_KEY (minimum)
npm start              # http://localhost:3000
```

## Déployer gratuitement sur Render (recommandé — pas de carte bancaire)

URL obtenue : **`https://mounsflix.onrender.com`** (libre, courte, HTTPS).

1. Crée un compte sur https://render.com (connexion GitHub suffit).
2. Pousse ce dossier sur un dépôt GitHub.
3. Sur Render : **New → Blueprint** et colle le nom du dépôt (`render.yaml` est détecté).
   Ou **New → Web Service** :
   - Runtime : **Docker** (Dockerfile inclus) — ou **Node** : build `npm install`,
     start `npm start`.
   - Plan : **Free**.
4. Dans **Environment**, renseigne `TMDB_API_KEY` (et `DATABASE_URL` si tu veux un cache persistant).
5. **Deploy**. L'URL `https://mounsflix.onrender.com` est active au bout de ~3 min.

**Piège du plan gratuit Render** : le service s'endort après 15 min sans trafic
(1er chargement = ~1 min). Solution : un ping gratuit (UptimeRobot, cron sur ton PC…)
toutes les ~10 min sur `https://mounsflix.onrender.com/` le garde éveillé.

## Alternatives

- **Railway / Koyeb** : même principe (Docker), compte requis, URL `mounsflix.up.railway.app`
  / `mounsflix.koyeb.app`.
- **VPS gratuit** (Oracle Cloud free tier, etc.) : `docker build` + `docker run`, nginx
  en face, toujours allumé.
- **Vercel** : fonctionnel via `api/index.js` + `vercel.json` (voir section dédiée).
  À réserver à un usage personnel : la fonction proxy est plus lente qu'un vrai
  serveur (le 1er chargement de chaque segment prend 1 à 4 s selon le CDN).

## Déployer sur Vercel (CLI) — fonctionnel

Le projet est configuré pour Vercel : `api/index.js` exporte l'app Express
comme fonction serverless, `vercel.json` route tout le trafic vers elle
(`maxDuration: 60` pour dépasser le timeout 10 s par défaut).

```bash
env -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY vercel --prod
```

(`env -u ALL_PROXY` est indispensable si un proxy socks5h type Tor est défini —
le CLI Vercel refuse `socks5h:` et échoue avant l'upload.)

Env dans Vercel (projet → Settings → Environment Variables) :
`TMDB_API_KEY` (+ OpenSubtitles si souhaité).

Limites Vercel à connaître : réponse max ~4,5 Mo par fonction (un segment
4K peut dépasser → flux coupé ; la 720p/1080p passe), et certains providers
Cloudflare-refusent les IP de datacenter (ignorés proprement).

## Particularités techniques (pièges déjà résolus)

- Le runtime Hatchable ne supportait pas `new URL(rel, base)` → tout passe par
  résolution manuelle (`resolveUrl`), inutile ici en Node standard mais conservé tel quel.
- Certains CDN (moon.peakstorm.top, polarcandy.top) renvoient 403 dès qu'un header
  `Origin` est présent → tout le média passe par `/api/mproxy/stream.m3u8` (fetch serveur,
  rewrite des playlists, propagation `Referer` via `&ref=`).
- Providers bloqués par Cloudflare depuis des IP de datacenter (lecteurvideo.com,
  flemmix.me, movix.fun…) : ignorés proprement côté serveur. Sur une IP résidentielle
  ils peuvent fonctionner — le code les réessaye à chaque appel.
- Le site se met à jour par simple `git push` sur le dépôt connecté à Render.