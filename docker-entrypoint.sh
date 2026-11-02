#!/bin/sh
# 以 root 启动时：修正数据目录归属后降权为 node 用户运行。
# 这样 ./pianke_data 这类由 Docker 自动以 root 创建的本地目录也能直接使用。
# 通过 compose 的 user: 指定非 root 用户启动时，直接运行，不做任何修改。
set -e

if [ "$(id -u)" = "0" ]; then
  for dir in "${DATA_DIR:-/app/data}" "${TRANSCODE_DIR:-}"; do
    [ -n "$dir" ] || continue
    mkdir -p "$dir"
    # 只在归属不对时递归修正，避免每次启动都遍历海报缓存
    if [ "$(stat -c %u:%g "$dir")" != "1000:1000" ]; then
      chown -R node:node "$dir"
    fi
  done
  exec su-exec node "$@"
fi

exec "$@"
