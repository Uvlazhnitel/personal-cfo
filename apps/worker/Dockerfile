FROM node:24.10.0-alpine AS base

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/data/package.json packages/data/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/financial-engine/package.json packages/financial-engine/package.json
COPY packages/integrations/package.json packages/integrations/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @personal-cfo/worker run build
RUN pnpm --filter @personal-cfo/worker deploy --legacy --prod /app/deploy

FROM node:24.10.0-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 worker
COPY --from=build --chown=worker:nodejs /app/deploy ./
COPY --from=build --chown=worker:nodejs /app/apps/worker/dist ./dist
COPY --from=build --chown=worker:nodejs /app/packages/data/migrations ./migrations
USER worker

CMD ["node", "dist/index.js"]
