# Zero runtime dependencies — node:sqlite, node:test and --env-file cover the
# database, tests and config, so there is no npm install step and nothing to
# audit. The image is the base plus about 60KB of source.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY *.js ./
COPY public ./public

# SQLite lives on the mounted volume so it survives deploys.
ENV DATABASE_PATH=/data/grosplit.db
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
