# Churan — production image for Render (Background Worker).
#
# Why Docker:
#   Churan is a persistent Discord Gateway bot (client.login, no HTTP server),
#   so Render must run it as a Background Worker, not a Web Service.
#   The image pins Node 22 + system FFmpeg + a Linux yt-dlp binary, which the
#   local Windows setup (bin/yt-dlp.exe + ffmpeg-static) cannot provide.
#   Node 22 is required: @discordjs/voice@0.19.2 declares engines >=22.12.0.
#   No HTTP endpoint is added on purpose — a worker needs none.

FROM node:22-bookworm-slim

# System deps:
#   ffmpeg         — audio transcoding for @discordjs/voice (prism-media spawns it)
#   python3        — yt-dlp plugins / post-processing helper
#   ca-certificates, curl — fetch the yt-dlp binary over HTTPS
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp (Linux standalone). src/youtube/search.js prefers bin/yt-dlp.exe
# locally, then falls back to PATH `yt-dlp` — this PATH install is what
# production uses. `--js-runtimes node` is already passed by the app, and
# Node is present in this image, so YouTube signature challenges resolve.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version

WORKDIR /app

# Install prod dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code + small local test asset (used by /playtest).
# .env is NEVER copied — Render injects env vars at runtime.
COPY src ./src
COPY assets ./assets

ENV NODE_ENV=production

# Long-running gateway process. No PORT, no healthcheck — Render runs this
# service as a Background Worker (see render.yaml).
CMD ["node", "src/index.js"]
