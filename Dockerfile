# Range Book: trajectory calculator + reloading log
# No npm packages are needed; Node's built-in SQLite does the storage.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=9090 \
    DATA_DIR=/data

WORKDIR /app
COPY server.js export.js backup.js merge.js ./
COPY public ./public
COPY seed ./seed

# Everything you need to keep (database + photos) lives in /data.
# The server starts as root only long enough to give /data to PUID/PGID
# (Unraid's nobody:users, 99:100, by default), then drops root.
ENV PUID=99 PGID=100
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9090/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
