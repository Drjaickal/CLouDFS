FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY services/storage-node/package.json ./services/storage-node/package.json

RUN npm ci

COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/src ./apps/api/src

RUN npm run build --workspace=@cloudfs/api

FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY services/storage-node/package.json ./services/storage-node/package.json

RUN npm ci --omit=dev

COPY --from=builder /app/apps/api/dist ./apps/api/dist

WORKDIR /app/apps/api

EXPOSE 4000

CMD ["node", "dist/index.js"]
