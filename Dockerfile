# Single container: the Node server serves the built web app, so there is one
# origin and therefore no CORS, no separate hosting, and a valid HTTPS cert from
# Cloud Run -- which the browser requires before it will hand over a microphone.
FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# Cloud Run's filesystem is ephemeral. Recordings and drafted minutes live here
# for the life of the instance; mount a volume or set GCS_BUCKET if you need
# them to outlive it.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["node", "server/dist/index.js"]
