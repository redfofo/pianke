# 构建阶段只产出与架构无关的 JS（生产依赖无原生模块），在构建机原生架构上运行，避免多架构构建走 QEMU 模拟
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8788 7359/udp
CMD ["node", "dist/server/index.js"]
