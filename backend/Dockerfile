# ── deps + build ─────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app

# build tools for native deps (bcrypt) + openssl (Prisma's engine needs
# libssl to run at all — bookworm-slim doesn't ship it by default)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
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

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/prisma       ./prisma
COPY --from=build /app/package.json ./package.json

RUN mkdir -p uploads

EXPOSE 3000
# The dedupe has to run before `db push`: the reaction index became
# (userId, messageId), and rows from the old "one row per emoji" model would
# make the new unique index fail to create, which would stop the API booting.
CMD ["sh", "-c", "npx prisma db execute --file prisma/sql/dedupe-reactions.sql --schema prisma/schema.prisma && npx prisma db push --skip-generate && node dist/main"]
