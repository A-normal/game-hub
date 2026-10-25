# ==============================================================================
# Game-Hub 轻量化生产 Dockerfile
# 基于 Node.js 22 Alpine (内置原生 node:sqlite，无需 Python/C++ 原生编译链)
# 内置 docker-entrypoint 自愈挂载卷权限，并使用 su-exec 对齐 PUID:PGID (1000:1000)
# ==============================================================================

# 1. 依赖安装与构建阶段 (Builder)
FROM node:22-alpine AS builder

WORKDIR /app

# 启用 corepack 并锁定 pnpm 版本
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate

# 复制 Workspace 依赖定义文件
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/

# 安装项目依赖 (冻结 lockfile)
RUN pnpm install --frozen-lockfile

# 复制全部应用源码
COPY . .

# ==============================================================================
# 2. 生产运行时镜像 (Runner)
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# 安装 tzdata (时区) 与 su-exec (轻量进程降权工具)
RUN apk add --no-cache tzdata su-exec

# 生产环境默认环境变量配置
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV GAMEHUB_HOST=0.0.0.0
ENV GAMEHUB_PORT=8080
ENV GAMEHUB_PATH=/onebot/v11/ws
ENV GAMEHUB_DB=/app/data/vault.db
ENV GAMEHUB_TOKEN=gamehub_secret_token_2026

# 从构建阶段复制必要文件与已解析的 node_modules
COPY --from=builder /app /app

# 复制并配置 entrypoint 自愈脚本
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 暴露内部端口
EXPOSE 8080

# 通过 entrypoint 自愈宿主机挂载目录权限并根据 PUID:PGID 降权
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# 启动常驻微内核服务
CMD ["node", "app.mjs"]
