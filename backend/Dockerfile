# ── deps + build ─────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app

# build tools for native deps (bcrypt) in case no prebuilt binary matches
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ── runtime ──────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/prisma       ./prisma
COPY --from=build /app/package.json ./package.json

RUN mkdir -p uploads

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/main"]
