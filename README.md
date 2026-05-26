# xeltrix-remotion-service

Service Node.js autonome pour générer des vidéos MP4 avec Remotion.
Conçu pour être déployé sur **Render** ou **Railway** (séparé du site principal Replit).

## Architecture

```
n8n  →  POST /render  →  xeltrix-remotion-service (Render)
                              ↓ PATCH video_jobs
                          Supabase
                              ↓ upload MP4
                          Cloudflare R2
```

## Endpoint

### `GET /healthz`
```json
{ "ok": true, "uptime": 42.1, "bundleReady": true }
```

### `POST /render`

**Header requis :**
```
x-api-key: <REMOTION_RENDER_SECRET>
```

**Body :**
```json
{
  "job_id": "uuid-du-job",
  "user_id": "user_clerk_id",
  "ai_plan": {
    "format": "9:16",
    "width": 1080,
    "height": 1920,
    "hook_text": "Votre accroche",
    "cta_text": "Découvrez maintenant",
    "text_color": "white",
    "music_style": "none",
    "scenes": [
      {
        "asset_url": "https://...",
        "asset_type": "image",
        "duration": 4,
        "text": "Texte de scène",
        "transition": "cut"
      }
    ]
  }
}
```

**Réponse (202 Accepted) :**
```json
{ "accepted": true, "job_id": "uuid-du-job" }
```
Le rendu continue en arrière-plan. Supabase est mis à jour directement.

## Variables d'environnement

| Variable | Description |
|---|---|
| `PORT` | Port du serveur (défaut : 3000) |
| `REMOTION_RENDER_SECRET` | Clé secrète partagée avec n8n |
| `SUPABASE_URL` | URL de ton projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key Supabase (bypass RLS) |
| `R2_ACCOUNT_ID` | Account ID Cloudflare |
| `R2_ACCESS_KEY_ID` | Access Key ID R2 |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key R2 |
| `R2_BUCKET_NAME` | Nom du bucket R2 |
| `R2_PUBLIC_URL` | URL publique du bucket (ex: `https://pub-xxx.r2.dev`) |
| `REMOTION_MAX_WIDTH` | Cap largeur (défaut : 720, mettre 1080 en prod) |
| `REMOTION_MAX_HEIGHT` | Cap hauteur (défaut : 1280, mettre 1920 en prod) |
| `REMOTION_MAX_SCENE_SEC` | Durée max par scène en secondes (défaut : 15) |

## Déploiement sur Render (sans Docker)

1. Connecte ton repo GitHub à Render
2. **New Web Service** → sélectionne le repo
3. **Root Directory** : `services/xeltrix-remotion-service`
4. **Environment** : Node
5. **Build Command** : `npm install && npm run build`
6. **Start Command** : `node dist/index.mjs`
7. **Plan** : Standard (1 CPU min recommandé pour Remotion)
8. Ajoute toutes les variables d'environnement listées ci-dessus

## Déploiement sur Render (avec Docker)

1. Connecte ton repo GitHub à Render
2. **New Web Service** → sélectionne le repo
3. **Root Directory** : `services/xeltrix-remotion-service`
4. **Environment** : Docker
5. Ajoute toutes les variables d'environnement listées ci-dessus

Le Dockerfile installe automatiquement les dépendances système pour Chrome Headless Shell.

## Déploiement sur Railway

1. `railway new` dans le dossier `services/xeltrix-remotion-service/`
2. Ou connecte le repo GitHub et configure le **Root Directory** à `services/xeltrix-remotion-service`
3. Railway détecte le `Dockerfile` automatiquement
4. Configure les variables d'environnement dans le dashboard Railway

## Mise à jour de n8n

Remplace l'URL de l'ancien webhook Remotion dans ton workflow n8n :

**Avant (Replit) :**
```
https://ton-replit.replit.dev/api/remotion/render
```

**Après (Render/Railway) :**
```
https://xeltrix-remotion-service.onrender.com/render
```

Le header `x-api-key` reste identique.

## Commandes locales

```bash
cd services/xeltrix-remotion-service

# Installer les dépendances
npm install

# Compiler TypeScript → dist/
npm run build

# Démarrer le serveur (après build)
npm start

# Vérifier les types sans compiler
npm run typecheck
```

## Notes

- Le premier démarrage télécharge Chrome Headless Shell (~92 Mo) si absent.
- Le bundle webpack est compilé une seule fois au démarrage (warm-up) et mis en cache en mémoire.
- Si le bundle dépasse 2 minutes, le job passe en `failed` avec `error_message: "Remotion bundle timeout (>2 min)"`.
- Le rendu est limité à 10 minutes par vidéo.
- `concurrency: 1` — adapté aux petits serveurs. Augmenter avec l'env var ou en modifiant le code.
