# holo-card-agent — server image
# Build:  docker build -f deploy/Dockerfile -t holo-card-agent .
# Run:    see deploy/docker-compose.yml
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    NODE_ENV=production

# Python + Pillow for the card pipeline, Blender runtime libraries (the official portable
# Blender 4.5 is downloaded by `setup deps` into the data volume), CJK fonts for typography,
# zip for packaging deliverables.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pil fontconfig fonts-noto-cjk fonts-dejavu-core zip xz-utils ca-certificates curl \
      libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libglu1-mesa libxkbcommon0 libsm6 libice6 libegl1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build \
 && cd skills/holo-card-studio/assets/web-holographic && npm install --ignore-scripts --no-audit --no-fund \
 && cd ../web-lenticular && npm install --ignore-scripts --no-audit --no-fund

ENV DATA_DIR=/data HTTP_HOST=0.0.0.0 HTTP_PORT=8787
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=10s --retries=3 CMD curl -fsS http://127.0.0.1:8787/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
