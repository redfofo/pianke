# 构建阶段只产出与架构无关的 JS（生产依赖无原生模块），在构建机原生架构上运行，避免多架构构建走 QEMU 模拟
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache ffmpeg su-exec
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir /app/data && chown node:node /app/data
# 不设 USER：入口脚本以 root 修正数据目录归属后，降权为 node 运行服务
EXPOSE 8789 7359/udp
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
