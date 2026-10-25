#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# 1. 确保数据挂载根目录存在
mkdir -p /app/data

# 2. 挂载目录权限自愈修正
# 当宿主机挂载点首次被 Docker 创建为 root:root (0755) 时，自动将目录所有权与读写权限移交给目标运行用户
if [ "$(id -u)" = "0" ]; then
    echo "[Game-Hub Entrypoint] 正在对齐 /app/data 数据目录所有权至 UID:${PUID} GID:${PGID}..."
    chown -R "${PUID}:${PGID}" /app/data
    chmod -R 775 /app/data

    # 3. 若指定了非 root 用户 (如 PUID=1000)，使用 su-exec 安全降权启动应用
    if [ "${PUID}" != "0" ]; then
        echo "[Game-Hub Entrypoint] 已平滑降权至 UID:${PUID} 启动服务..."
        exec su-exec "${PUID}:${PGID}" "$@"
    fi
fi

exec "$@"
