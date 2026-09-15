FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg fonts-dejavu-core tesseract-ocr python3 python3-venv libgomp1 ca-certificates chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    PYTHONUNBUFFERED=1 \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium

COPY --from=build --chown=node:node /app/requirements-auto.txt ./requirements-auto.txt
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/python -m pip install --no-cache-dir --disable-pip-version-check -r requirements-auto.txt \
    && chown -R node:node /app/.venv

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/dist-remotion ./dist-remotion
COPY --from=build --chown=node:node /app/scripts ./scripts

RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787

CMD ["node", "dist-server/server/index.js"]
