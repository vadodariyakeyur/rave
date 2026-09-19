# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN pnpm --filter @rave/protocol build && pnpm --filter @rave/web build

FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# `output: standalone` emits a self-contained server with only the traced deps.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
ENV HOSTNAME=0.0.0.0 PORT=3000
CMD ["node", "apps/web/server.js"]
