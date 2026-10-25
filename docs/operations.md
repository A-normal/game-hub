# 开发验证与部署操作

本文记录现有运行入口的操作方法。平台结构及开发契约见根 README；插件功能与验收状态放在对应文档。目录迁移时同步更新本文，不因改目录而假定运行配置也已迁移。

## 本地运行

使用支持 `node:sqlite` 的 Node.js 和仓库锁定的包管理器。

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
npm test
```

测试使用模拟网络。已有网关集成测试会在测试进程内短暂监听环回端口，并在结束时关闭，不需要常驻服务或真实 QQ 账号。

人工启动应用前，配置访问令牌和数据路径：

```powershell
$env:GAMEHUB_TOKEN = '<自行生成的访问令牌>'
$env:GAMEHUB_DB = 'C:\your-data\game-hub\vault.db'
npm start
```

应用在前台持续运行，Ctrl+C 退出。当前开发约束禁止开启后台进程，代理不会代为启动或重启服务。

| 环境变量 | 现有入口用途 |
| --- | --- |
| `GAMEHUB_HOST` / `GAMEHUB_PORT` | 监听地址与端口，本地默认 `127.0.0.1:8080` |
| `GAMEHUB_PATH` | OneBot 路径，默认 `/onebot/v11/ws` |
| `GAMEHUB_TOKEN` | 网关鉴权令牌，部署时自行生成并与渠道配置保持一致 |
| `GAMEHUB_DB` | SQLite 文件路径，默认 `data/vault.db` |
| `GAMEHUB_CONFIG` | 模块装配 JSON 路径，默认 `config/modules.json` |
| `GAMEHUB_ADMIN_USERS` | 初始管理员标识，逗号分隔 |
| `GAMEHUB_LOG_LEVEL` | `DEBUG` / `INFO` / `WARN` / `ERROR` / `SILENT` |

## Compose

现有 Compose 包含 `gamehub`、`napcat`。按环境填写 `.env.example` 对应配置后，先验证和构建：

```powershell
docker compose config --quiet
docker compose build gamehub
```

由维护者人工在前台启动：`docker compose up`。NapCat 的内部反向 WebSocket 目标为 `ws://gamehub:8080/onebot/v11/ws`，双方令牌一致。现有 8080 端口只在专用容器网络内使用。

- `CONFIG_ROOT` 为 NapCat 配置位置，`DATA_ROOT` 为 Vault 与 NapCat 状态位置。Docker 在 WSL 内运行时优先使用 WSL Linux 路径。
- 更新前运行测试，记录旧镜像 ID 并备份数据，再构建新镜像。替换运行服务属于独立运行操作，不自动执行。
- 停止写入后备份完整持久化目录，或使用 SQLite 在线备份接口；写入期间不能只复制主 `.db` 而遗漏 WAL。备份包含凭据，应独立保护。
- 更新后检查 `docker compose ps`、`docker compose logs --tail 100 gamehub`，再验收真实登录和查询。构建成功不代表官方接口验收通过。
- 回滚使用旧镜像和兼容备份，不直接删库。新增迁移必须说明版本、兼容范围及恢复步骤。

## 账号存储与验收

现有 Vault 使用 SQLite JSON 保存凭据，没有应用层静态加密。不要提交真实数据库、Cookie 或密钥。帮助文案不得宣称不存在的加密能力。

扫码工作区修复与验收边界见 [扫码修复记录](zzz-qr-login-fix.md)。后续目录和模块契约迁移需保留这些回归，不触碰正在运行的容器或生产数据。
