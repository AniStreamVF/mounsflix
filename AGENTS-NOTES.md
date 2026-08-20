## Objective
- Utilisateur quitte Hatchable : projet exporté puis porté en app Node+Express standalone pour hébergement gratuit (Render recommandé, `mounsflix.onrender.com`).
- En cours : intégrer les providers du bundle Gowaru (gowaru-nuvio-providers v1.2.0) pour les films et séries.

## Important Details
- Env sandbox : torsocks (`LD_PRELOAD=libtorsocks.so`, `ALL_PROXY=socks5h://127.0.0.1:9050`) → toujours `env -u LD_PRELOAD -u ALL_PROXY` pour serveur/curl/tests.
- Serveur local : `cd /home/mouns/mounsflix-app && env -u LD_PRELOAD -u ALL_PROXY setsid -f node server.js >/tmp/opencode/mf-server.log 2>&1 < /dev/null` (PID à vérifier avec pgrep/fuser). Arrêt : `pkill -f 'node.*server.js'` ou par PID (`ps -eo pid,cmd | grep '[n]ode'`). Les `&`/nohup simples meurent (timeout bash) — `setsid -f` fiable.
- **Le serveur sert les fichiers statiques depuis le disque → pas besoin de redémarrer après édition de public/index.html.**
- Clé TMDB dans `/home/mouns/mounsflix-app/.env` : `61bebc28e3810a5026f5da59c18a1b69` (api_key, pas Bearer).
- **INTÉGRATION GOWARU (fait ce jour)** : 8 providers du bundle ajoutés (Anime-Ultime, AnimeSama.co, AnimesUltra, AnimeVOSTFR, French-Manga, VoirAnime, VoirAnime.rip, VoirAnime.homes). Bundles CJS copiés dans `lib/nuvio-providers/*.cjs` — **renommés en .cjs obligatoirement** car `package.json` est `"type":"module"` (un `.js` CJS y est exécuté en ESM → `module.exports` ignoré, require renvoie `{}`). Loader/adaptateur dans `lib/gowaru.js` (createRequire + mapping vers le format local {id,name,url,quality,language,format,headers}).
  - Budget : non-anime = 6,5 s (abort propre via AbortController) ; anime (détection `original_language==='ja'` ou titre japonais/mots-clés) = 14 s (les bundles sont calibrés 45 s avec probes multi-domaines).
  - Filtre DIRECT appliqué dans `adapt()` (seules les URLs `.mp4/.m3u8/.mkv/.webm/.mpd` passent) + dédup URL + exclusion MKV/mpd côté handler.
  - Front corrigé : les MP4 avec headers Referer/Origin passent désormais par `/api/mproxy` (avant : lecture directe sans headers → 403 Streamtape/Sibnet). Proxy enrichi : support header Origin + Range (seek MP4) + streaming (pas de bufferisation mémoire des gros fichiers).
- **ROOT CAUSE du chargement infini (TROUVÉE) :** la source « Videasy — CDN 1080p » (premier choix de `autoBest`) a un **audio en AC-3 (Dolby Digital)**. Chrome/Firefox ne décodent pas l'AC-3 en MSE (`MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"')` = false) → hls.js lève `bufferAddCodecError` fatal → l'ancien handler appelait `recoverMediaError()` en boucle → spinner infini.
  - Preuve : warning Firefox « Cannot play media. No decoders for requested formats: audio/mp4; codecs="ac-3", ... » + analyse binaire des inits : s1080p = ac-3, mais s720p/s480p/s2160p = mp4a (AAC) + avc1. VaPlayer = mp4a.40.2+avc1 (AAC, OK). FrenchStream = avc1.64001e,mp4a.40.2 (AAC, OK).
- Limite du sandbox : Playwright chromium (full ET headless-shell) et Firefox headless n'ont **AUCUN codec** (isTypeSupported faux pour tout) → impossible de vérifier la lecture réelle ici. Les tests locaux vérifient la logique, pas la lecture.

## Work State
### Completed
- **INTÉGRATION GOWARU** : 8 providers du bundle nuvio-providers ajoutés (21 → 29) — voir « Important Details ». Testé : One Piece S1E1 → 9 flux dont AnimeSama.co et AnimeVOSTFR (Sibnet MP4) ; filtre `?provider=voiranime` OK ; proxy MP4 avec Range OK (HTTP 206).
- **Fix player** (public/index.html) :
  - `sourceCodecOK(h)` : vérifie audioCodec/videoCodec de `h.levels[0]` après MANIFEST_PARSED ; si non supporté → `failSource`.
  - `failSource(msg)` : toast + destroy hls + `nextSource()` (source m3u8 suivante) ; garde anti-boucle `PV.fails` — après `streams.length` échecs → toast « Aucune source ne fonctionne sur ce navigateur » et stop.
  - Handler ERROR : `mediaError` fatal → failSource (plus jamais recoverMediaError en boucle) ; `networkError` retry<2 → recoverNetworkError ; sinon failSource.
  - `nextSource()` : `(PV.sel+k)%n` sur les sources m3u8.
  - `selectSource(i, manual)` : `manual=true` (clic utilisateur) réinitialise `PV.fails`.
- Vérifié sous Firefox headless : le lecteur essaie les 10 sources (0→9) puis s'arrête proprement, toast « Aucune source ne fonctionne », plus de boucle. En vrai navigateur : la 1080p AC-3 saute → repli sur 720p AAC (jouable) — 1 bascule max.
- Toute la chaîne média vérifiée 200 côté serveur local (master, init, segments) ; durée 1:48:37 s'affiche (hls.js parse bien le manifest).
- Le code JS de la page passe `new Function()` (syntaxe OK).

### Active
- Rien — en attente du test utilisateur sur vrai navigateur (Chrome/Edge/Firefox/Safari) : recharger http://localhost:3000, relancer Obsession → doit jouer via repli auto (provider affiché « VIDEASY » 720p ou VaPlayer/FrenchStream).

### Blocked
- Vérification lecture réelle impossible dans le sandbox (aucun codec dans les navigateurs headless dispo).

## Next Move
1. Demander à l'utilisateur de tester sur son navigateur réel (localhost:3000, serveur tourne). Si ça joue → déployer sur Render : `cd /home/mouns/mounsflix-app && git init && git add -A && git commit` puis push vers un repo GitHub, connecter à Render (render.yaml présent, build npm install, start node server.js). Alternative gratuite : Railway/Glitch/Fly. Le serveur doit pouvoir sortir vers les providers (pas de blocage IP comme l'IP sandbox).
2. Si l'utilisateur veut : ajouter un filtre qualité dans le menu pour choisir manuellement avant autoBest.

## Relevant Files
- `/home/mouns/mounsflix-app/` : app standalone (server.js, lib/shim.js, api/*.js, public/index.html, Dockerfile, render.yaml, .env.example, README-DEPLOY.md, .env).
- `/home/mouns/mounsflix/` : export brut de sauvegarde (version Hatchable v17).
- `/tmp/opencode/browser/fx.mjs` : test Firefox de bout en bout (recherche → lecture).
- Scripts diag : /tmp/opencode/browser/{direct,codec}.mjs, analyse inits via python3 inline.