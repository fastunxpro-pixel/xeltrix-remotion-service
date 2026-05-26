# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-bookworm AS builder

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm

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

# dist/ — bundle esbuild compilé
COPY --from=builder /app/dist ./dist

# remotion/ — Root.tsx + VideoComposition.tsx (requis par bundle() au runtime)
COPY --from=builder /app/remotion ./remotion

# node_modules — requis par @remotion/bundler, @remotion/renderer, @aws-sdk
COPY --from=builder /app/node_modules ./node_modules

# package.json — utile pour Node (type: module, etc.)
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
