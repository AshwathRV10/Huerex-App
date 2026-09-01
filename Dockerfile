# HUEREX GFES — one image, one process.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native module; the toolchain is not kept in the
# final image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/db/migrations ./server/dist/db/migrations
COPY --from=build /app/server/seed ./server/seed
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node

ENV DB_PATH=/app/data/huerex.sqlite \
    BACKUP_DIR=/app/backups \
    PORT=4000 \
    HOST=0.0.0.0
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
