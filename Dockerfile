# Node app image WITH ffmpeg (required for streamed audio extraction + chunking).
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    MEDIA_TMP_DIR=/tmp_media

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /tmp_media

EXPOSE 3000

# Run node directly as PID 1 (not via `npm start`) so Render's SIGTERM reaches
# the process cleanly on deploy/shutdown — avoids npm's spurious
# "command failed / signal SIGTERM" error when the old instance is retired.
CMD ["node", "--max-old-space-size=1024", "server.js"]
