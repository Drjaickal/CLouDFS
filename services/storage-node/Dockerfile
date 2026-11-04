FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY services/storage-node/package.json ./services/storage-node/package.json

RUN npm ci

COPY services/storage-node/tsconfig.json ./services/storage-node/tsconfig.json
COPY services/storage-node/src ./services/storage-node/src

RUN npm run build --workspace=@cloudfs/storage-node

FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY services/storage-node/package.json ./services/storage-node/package.json

RUN npm ci --omit=dev

COPY --from=builder /app/services/storage-node/dist ./services/storage-node/dist

WORKDIR /app/services/storage-node

EXPOSE 4001

CMD ["node", "dist/index.js"]
