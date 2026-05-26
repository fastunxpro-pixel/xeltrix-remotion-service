# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# Dépendances système pour Chrome Headless Shell (utilisé par Remotion)
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  lsb-release \
  wget \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copier node_modules et dist depuis le build stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Chrome headless shell sera téléchargé au démarrage du serveur (warm-up).
# Pour le pré-télécharger dans l'image (optionnel) :
# RUN node -e "const {ensureBrowser}=require('@remotion/renderer');ensureBrowser({chromeMode:'headless-shell'})"

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
