FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY policy ./policy
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 ceo \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin ceo

WORKDIR /app
ENV NODE_ENV=production
ARG BUILD_SHA=dev
ENV CEO_BUILD_SHA=$BUILD_SHA
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY policy ./policy
# Operator acceptance script for the Redis op-timeout fix; run inside the pod
# via `kubectl exec` -> node /app/scripts/verify-redis-op-timeout.mjs.
COPY scripts/verify-redis-op-timeout.mjs ./scripts/verify-redis-op-timeout.mjs

USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
