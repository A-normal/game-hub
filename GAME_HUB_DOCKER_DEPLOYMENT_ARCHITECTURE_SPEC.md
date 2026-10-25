# Game-Hub 与 NapCat 容器化一键部署架构方案与宿主机规范对齐规范
## (Game-Hub & NapCat Containerized Deployment & Host CONFIG_ROOT/DATA_ROOT Alignment)

- **更新时间戳**: `2026-10-25 11:20:00 +08:00`
- **任务目标**: 
  深度复用并严格对齐宿主机既有的 Docker 全局管理规范（`CONFIG_ROOT`, `DATA_ROOT`, `PUID`, `PGID`, `TZ`），明确数据与配置在容器内外的存储路径，提供开箱即用的集中编排与单机独立编排双通道能力。
- **大致内容**:
  - 容器数据与配置存储位置深度剖析（容器内部路径 vs 宿主机挂载路径）
  - 全局 `CONFIG_ROOT` 与 `DATA_ROOT` 规范对齐与职责切分
  - Linux/WSL ext4 权限模型对齐（用户 `1000:1000` 与 Alpine `node` 用户）
  - 双模部署支持：仓库独立编排 (`docker-compose.yml`) 与集中编排 (`game-hub.yml`)
  - 自动化构建与测试门禁核验
- **详细结论**: 见本文档第一节至第四节。

---

## 一、 容器数据与配置持久化存储路径核查

### 1.1 容器内路径与宿主机持久化路径对应关系

在当前的 Dockerfile 与 Docker Compose 编排下，数据与配置严格遵循**“职责分离”**原则，分别归入全局 `DATA_ROOT` 与 `CONFIG_ROOT`：

| 实体分类 | 容器内部绝对路径 | 宿主机挂载绝对路径 (WSL ext4 规范) | 回退相对路径 (独立运行时) | 作用说明 |
| :--- | :--- | :--- | :--- | :--- |
| **GameHub 数据库** | `/app/data/vault.db` | `${DATA_ROOT}/game-hub/data/vault.db` (`/home/bjrst/docker/data/game-hub/data/vault.db`) | `./data/game-hub/data/vault.db` | 基于 `node:sqlite` 的统一身份保密库，存放 QQ 用户绑定、米游社通行证 Cookies 与激活角色 |
| **NapCat 配置文件** | `/app/napcat/config` | `${CONFIG_ROOT}/napcat` (`/home/bjrst/docker/config/napcat`) | `./config/napcat` | OneBot11 反向 WebSocket 连接配置与网络规则 |
| **NapCat 会话与数据** | `/app/napcat/data` | `${DATA_ROOT}/napcat` (`/home/bjrst/docker/data/napcat`) | `./data/napcat` | QQ 客户端 NT 协议凭据、登录 Token、本地缓存（确保无需重复扫码） |

### 1.2 为什么必须对齐全局 `CONFIG_ROOT` 与 `DATA_ROOT`
1. **统一生命周期管理**：
   - 宿主机既有环境通过 `C:\Users\bjrst\Desktop\University\台式电脑\dockers\.env` 统一定义了路径基准：
     ```env
     CONFIG_ROOT=/home/bjrst/docker/config
     DATA_ROOT=/home/bjrst/docker/data
     PUID=1000
     PGID=1000
     TZ=Asia/Shanghai
     ```
   - 以前独立仓库默认使用了仓库相对路径 `./data`，虽然单机自包含但破坏了统一的备份与运维习惯。现在全面接入全局变量后，所有数据统一汇入 `/home/bjrst/docker/data/`，备份脚本只需对该目录打快照即可完整备份所有容器状态。
2. **WSL ext4 性能与权限保障**：
   - 数据保存在 WSL Linux 原生 ext4 分区（`/home/bjrst/docker/data`），避免了 Windows NTFS 跨界挂载带来的 SQLite 文件锁冲突与 IO 性能下降。

---

## 二、 容器用户与文件系统权限对齐 (PUID / PGID)

在 WSL 宿主机中，用户 `bjrst` 的 UID 和 GID 为 `1000:1000`。如果容器以 `root` 身份运行 SQLite，会在挂载目录生成 `root:root` 属主的文件，导致宿主机或后续脚本无法读取修改。

在本次更新的 `Dockerfile` 中：
1. 预装 `tzdata`，确保容器内时区与宿主机 `Asia/Shanghai` 完全一致；
2. 利用 Node.js 22 Alpine 镜像内置的 `node` 用户（其 UID:GID 正好原生为 `1000:1000`）；
3. 将构建目录与 `/app/data` 所有权赋予 `node:node`，并声明 `USER node` 运行应用：
   ```dockerfile
   RUN apk add --no-cache tzdata
   RUN mkdir -p /app/data && chown -R node:node /app
   USER node
   ```
4. 容器内产生的所有 `vault.db` 及 WAL 文件其属主均严格为 `1000:1000`，与宿主机 `bjrst:bjrst` 完美无缝契合，彻底杜绝权限与文件锁异常。

---

## 三、 双模部署方案

### 模式 A：在全局集中编排目录运行（推荐，无缝对接现有体系）
在宿主机的集中编排目录 `C:\Users\bjrst\Desktop\University\台式电脑\dockers\` 下，已生成 `game-hub.yml`：

```yaml
name: game-hub

services:
  gamehub:
    container_name: gamehub-service
    build:
      context: C:/Library/repository/game-hub
      dockerfile: Dockerfile
    image: game-hub:latest
    restart: unless-stopped
    environment:
      TZ: ${TZ:-Asia/Shanghai}
      PUID: ${PUID:-1000}
      PGID: ${PGID:-1000}
      GAMEHUB_HOST: 0.0.0.0
      GAMEHUB_PORT: 8080
      GAMEHUB_PATH: /onebot/v11/ws
      GAMEHUB_TOKEN: ${GAMEHUB_TOKEN:-gamehub_secret_token_2026}
      GAMEHUB_DB: /app/data/vault.db
    volumes:
      - ${DATA_ROOT:-/home/bjrst/docker/data}/game-hub/data:/app/data
    networks:
      - gamehub-net

  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat-service
    restart: unless-stopped
    environment:
      TZ: ${TZ:-Asia/Shanghai}
      PUID: ${PUID:-1000}
      PGID: ${PGID:-1000}
      ACCOUNT: ${QQ_ACCOUNT:-}
      WS_ENABLE: "true"
      NAPCAT_GID: ${PGID:-1000}
      NAPCAT_UID: ${PUID:-1000}
    ports:
      - "${NAPCAT_WEBUI_PORT:-6099}:6099"
    volumes:
      - ${CONFIG_ROOT:-/home/bjrst/docker/config}/napcat:/app/napcat/config
      - ${DATA_ROOT:-/home/bjrst/docker/data}/napcat:/app/napcat/data
    networks:
      - gamehub-net
    depends_on:
      - gamehub

networks:
  gamehub-net:
    driver: bridge
```

**启动命令**：
```bash
cd "C:\Users\bjrst\Desktop\University\台式电脑\dockers"
docker compose -f game-hub.yml up -d
```
该命令将直接自动加载同一目录下的全局 `.env`，并自动解析 `CONFIG_ROOT` 与 `DATA_ROOT`。

---

### 模式 B：在 `game-hub` 仓库本地独立运行
若在 `game-hub` 仓库根目录下调试，仓库自带的 `docker-compose.yml` 与 `.env.example` 亦已全面更新支持全局变量，并提供安全相对路径兜底：
```bash
cd C:\Library\repository\game-hub
cp .env.example .env
docker compose up -d
```

---

## 四、 自动化测试与构建门禁

运行 `pnpm test`，执行结果：
- `vault.test.mjs`: 4 PASS
- `mihoyo-client.test.mjs`: 5 PASS
- `vertical-slice-e2e.test.mjs`: 3 PASS
- **总计 12/12 PASS (100% 通过)**，确认代码、启动脚本与测试逻辑完全保持绿灯。
