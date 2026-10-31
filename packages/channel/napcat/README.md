# @game-hub/channel-napcat

NapCat / OneBot v11 渠道包，负责协议端连接鉴权、平台事件整形、消息与文件交付。模块导入和创建不启动监听；监听、连接与资源清理由 Game-Hub 的 `start/stop` 生命周期管理。

当前仓库默认使用 [Telegram 渠道](../telegram/README.md)，本模块默认停用，Compose 服务位于可选 `napcat` profile。继续使用时需显式启用模块与该 profile；旧数据目录不因默认渠道切换而删除。

## NapCat 连接 Game-Hub 的令牌

`NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN` 是 **NapCat 协议端连接 Game-Hub 网关**使用的共享令牌，归本渠道包管理。它判断连接方是否可以提交渠道事件，不用于个人系统管理员或 AI 管理员注册。

| 配置位置 | 字段或变量 | 要求 |
| --- | --- | --- |
| 部署用私有环境文件 | `NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN` | 由维护者自行设置真实值，不提交仓库 |
| 本渠道的模块配置 | `accessToken` | 由 `config/modules.json` 的 `$env` 引用上述环境变量；启用本模块时必填且不能为空 |
| NapCat 的 OneBot 反向 WebSocket 客户端 | 原生 `token` 字段 | 与 Game-Hub 一侧的连接令牌值保持一致 |

Game-Hub 网关在连接握手时验证令牌。NapCat 的反向 WebSocket 目标在当前 Compose 中为 `ws://gamehub:8080/onebot/v11/ws`，8080 仅用于专用容器网络。OneBot 原生协议字段仍叫 `token`，本包内部配置字段仍叫 `accessToken`；它们都不是另一种管理员凭据。

根 `.env.example` 是部署汇总模板，实际环境值从私有 `.env` 提供；包目录不另行加载环境文件。仓库 Compose 将连接变量传入 Game-Hub，NapCat 一侧的 OneBot 设置仍需由维护者配置成同一个值。

旧环境变量 `GAMEHUB_TOKEN` 已更名为 `NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN`，不再作为有效读取入口。升级时同步修改私有环境文件、实际 Compose 映射与自定义模块配置中的环境引用；令牌值本身不必因为字段更名而改变。修改容器环境后需重建对应容器，单纯 restart 不会重新读取 `.env`。

## 其他渠道环境配置

| 变量 | 用途 |
| --- | --- |
| `GAMEHUB_HOST` / `GAMEHUB_PORT` / `GAMEHUB_PATH` | 本渠道在 Game-Hub 中的 OneBot 网关监听地址、端口和路径 |
| `QQ_ACCOUNT` | Compose 映射为 NapCat 镜像的 `ACCOUNT`，用于启动时快速登录 |
| `NAPCAT_WEBUI_PORT` | NapCat WebUI 的宿主机映射端口 |

`QQ_ACCOUNT` 首次仍需扫码；后续启动使用 `/app/.config/QQ` 内保存的账号状态尝试快速登录。留空时通过 WebUI 扫码登录，登录状态失效或平台要求验证时仍需人工处理。

当前 Compose 将 `/app/.config/QQ` 挂载到 `${DATA_ROOT}/napcat/QQ`，将 `/app/napcat/config` 挂载到 `${CONFIG_ROOT}/napcat`。保留完整 QQ 数据和配置目录；`/app/napcat/data` 不能代替 QQ 登录数据目录。

修改登录账号后，由维护者在实际部署目录、原 Docker/WSL 环境前台重建 NapCat。以下文件名使用仓库示例，部署时换成实际使用的 Compose 文件：

```sh
docker compose --env-file .env -f docker-compose.yml up --no-deps --force-recreate napcat
```

## 用户权限边界

用户的系统管理员认证指令由本渠道转交 core，本包不读取或验证系统管理员注册令牌。系统注册与授权说明见 [core 包](../../core/README.md#系统管理员注册与权限)，AI 插件注册说明见 [chat-ai 包](../../plugin/chat-ai/README.md#ai-插件管理员注册令牌)。

通用部署、备份与升级操作见[部署操作说明](../../../docs/operations.md)。
