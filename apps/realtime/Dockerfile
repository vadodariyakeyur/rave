# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/realtime/package.json apps/realtime/
RUN pnpm install --frozen-lockfile
COPY packages/protocol packages/protocol
COPY apps/realtime apps/realtime
RUN pnpm --filter @rave/protocol build && pnpm --filter @rave/realtime build
RUN pnpm --filter @rave/realtime --prod --legacy deploy /out

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/realtime/dist ./dist
COPY --from=build /repo/apps/realtime/package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
