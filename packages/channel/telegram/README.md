# @game-hub/channel-telegram

Game-Hub 的 Telegram Bot API 渠道。第一版使用官方机器人账号和长轮询，在 Game-Hub 进程内运行，不依赖个人账号登录、NapCat、本地 Bot API 服务或独立后台进程。模块导入和创建不联网；`start/stop` 统一管理请求、轮询、发送队列与代理资源。

运行环境为 Node.js 22.19+；渠道固定依赖官方 `undici` 8.12.3 的 HTTP 客户端与代理实现，版本记录在 workspace lockfile 中。

## 渠道环境变量

| 变量 | 用途 | 默认与要求 |
| --- | --- | --- |
| `TELEGRAM_BOT_API_TOKEN` | Telegram 验证机器人访问 Bot API 的凭据 | 必填；由 BotFather 创建机器人后取得，真实值只放部署用私有环境文件 |
| `TELEGRAM_BOT_API_HTTPS_PROXY_URL` | 仅供此渠道 API 和附件请求使用的 HTTP(S) 代理地址 | 可空；如 `http://代理主机:端口`，不支持 SOCKS；不设置全局代理，不改变模型/provider 请求路线 |
| `TELEGRAM_BOT_API_BASE_URL` | 可信的 Telegram Bot API HTTPS 根地址 | 默认 `https://api.telegram.org`；拒绝地址中的用户凭据、查询参数与片段 |

Bot API Token **不用于 Game-Hub 系统管理员或 AI 管理员注册**，不能根据机器人凭据自动认领某个个人账号。系统注册令牌见 [core 包](../../core/README.md#系统管理员注册与权限)，独立 AI 管理员注册见 [chat-ai 包](../../plugin/chat-ai/README.md#ai-插件管理员注册令牌)。

根 `.env.example` 只做部署汇总，本包不额外加载包内环境文件。私有值经实际 Compose 映射进入 Game-Hub，或由前台启动环境注入；`npm start` 本身不会加载 `.env`。API Token、代理凭据和带 Token 的文件地址不写入日志、数据库、业务事件、AI 上下文或回复。

## 接入步骤

1. 在 Telegram 的 BotFather 创建机器人，将取得的凭据填写到部署私有环境文件的 `TELEGRAM_BOT_API_TOKEN`。如运行环境需要代理，填写本渠道代理变量；容器中的 `localhost` 指容器自身，不能用它假定宿主机代理可达。
2. 同一私有环境文件中填写 `GAMEHUB_ADMIN_REGISTRATION_TOKEN`，供核心登记系统管理员；不要求手填个人 ID。按需要填写模型密钥和已有插件配置。
3. 使用仓库的当前模块配置：`telegram` 启用，`napcat` 显式停用。已有自定义配置需增加本渠道声明，而不是把 Telegram Token 填进旧 NapCat 连接字段。
4. 由维护者构建并在前台重建 Game-Hub；实际使用仓库外 Compose 时，同步三个渠道变量和核心注册变量。修改环境文件后仅执行 restart 不会更新容器环境。
5. 私聊机器人发送 `/start`，获得按当前命名空间生成的系统注册指令。按提示使用系统的 `认证 <注册令牌>`；Token 校验、授权及持久化均由 core 处理，渠道只转交事件和结果。

示例前台部署命令，文件名以实际部署为准：

```sh
docker compose --env-file .env -f docker-compose.yml build gamehub
docker compose --env-file .env -f docker-compose.yml up --no-deps --force-recreate gamehub
```

`start` 会通过 `getMe` 核对机器人身份和凭据，再用 `getWebhookInfo` 检查接收模式。若已经配置 webhook，将明确拒绝启动；不自动删除 webhook、不清空待收消息。同一机器人应只运行一个长轮询消费者，发现 409 并发冲突或无效凭据时停止接收并记录安全错误码。

## 私聊、群聊与话题

支持私聊、普通群和超级群中的新消息，群和私聊话题的 `message_thread_id` 会保留在标准 `threadId` 字段及回复目标中。用户使用 `telegram:<数字用户ID>` 身份，昵称和用户名不能代替权限身份；QQ 绑定和管理员权限不会自动迁移到 Telegram。

群消息可见性由 Telegram 决定。需要处理普通群聊天、自定义前缀命令或 AI 插话时，在 BotFather 按官方要求关闭隐私模式并重新添加机器人，或通过合适的群管理员权限获得消息；本渠道不会修改这些远端设置。保留隐私模式时，不能假定机器人会收到所有普通消息或任意自定义前缀。启动日志提示隐私模式状态，但不能替代真实群内验证。

现有插件的命名空间继续生效，不将业务命令硬编码成 Telegram 命令。Telegram 原生 `/指令@机器人用户名` 会移除当前机器人的后缀后交给核心，例如默认系统别名 `/gh` 可继续使用；发给其他机器人的指令不进入 AI 兜底。未知原生命令也不会成为 AI 对话。

显式 @ 当前机器人，以及回复当前机器人的消息，都可以触发现有 AI 的 mention 策略；不因此开启默认关闭的随机插话或主动任务。同群不同话题的 AI 历史、策略、草稿和主动任务目标分别隔离，原有非话题会话键保持不变。ZZZ 提醒目标也保存话题字段。群管理员身份不自动授予系统权限；首版不通过额外平台请求映射群角色，系统管理员仍可使用已有业务插件中允许其执行的管理操作。

首版只处理 `message` 更新，不将编辑、频道广播、匿名身份或其他机器人消息伪装成普通用户消息；不提供群成员事件、普通消息撤回通知、按钮、命令菜单注册或个人账号客户端。图片附件可读写，不意味着聊天插件自动增加视觉模型能力。

## 消息与附件交付

支持普通文本、受约束的 `text/image` 消息段，以及 `{text?,files:[{name,data:Buffer}]}` 文件出站。文本按最多 4096 UTF-16 单元安全分段，不拆坏代理对，默认不使用 Telegram Markdown/HTML 解析。回复保留话题；仅在显式 `quote:true` 时引用原消息，且只加在第一段。默认不引用原始消息，避免认证回复通过引用重复展示凭据；多文件按顺序发送。

图片出站支持 HTTPS 地址或 `base64://` 数据，不读取本地路径。文件默认上限 4 MiB、一次最多五个；图片和文档入站保留名称、大小及不透明文件 ID，通过渠道惰性 `readBytes({maxBytes})` 读取。实际流量同样受字节上限约束，文件路径只能来自本渠道的 `getFile` 响应，不接受任意下载 URL，不向插件暴露带 Token 的下载地址。原生 Telegram 云端下载另有 20 MB 上限，本渠道不能绕过。

同聊天发送串行，群聊按约每 3.1 秒一条、私聊约每 1.05 秒一条节奏提交，并共享全局节奏；不同话题仍属于同一聊天的限流范围。明确返回 429 时按 `retry_after` 等待，最多重试一次。网络超时、结果不明或部分发送成功时不盲重发；交付结果包含已知消息 ID、已交付段数、部分成功和不确定标记。

## 进度、停机与恢复边界

更新游标按 bot ID 保存在现有 Vault 的 `channel:telegram:<bot-id>:cursor`，不保存 Token 或消息正文。每条更新交给核心前先持久认领；落库失败停止接收，重复及更旧的更新不再次执行。长时间无新消息时按 Telegram 的序号重置规则重新获取游标起点。

此策略是**至多一次处理尝试**：进程若在认领后、实际处理完成前崩溃，该条可能未完成，不会在重启后自动重放。它不承诺“恰好一次”，也不自动补偿外部业务副作用。Telegram 待收更新最多保留 24 小时，长期停机不能保证追回所有消息。网络错误按 1–30 秒退避，停止时取消轮询、请求和等待；平台凭据、并发或协议错误需修复后重新启动实例。

模块配置还可设置 `pollTimeoutSeconds`（默认 25）、`requestTimeoutMs`（默认 15000）和 `maxAttachmentBytes`（默认 4 MiB，最多 20 MiB），由本包 schema 校验。业务插件自身的附件上限仍然生效。

## 验证与参考

自动测试使用模拟 Telegram API，覆盖核心认证、人物卡真实导入/导出链路、ZZZ 查询、话题 AI 历史与任务目标、持久游标、重复更新、限流、部分交付、读取上限、错误脱敏和停止取消。自动回归不等于实际账号、代理网络与群消息验收；配置真实值后需维护者分别验证。

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Bot FAQ：群消息可见性](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)
- [Bot API：getUpdates](https://core.telegram.org/bots/api#getupdates)
- [Bot API：getFile](https://core.telegram.org/bots/api#getfile)
- [undici ProxyAgent](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md)

通用部署与备份入口见[操作说明](../../../docs/operations.md)。
