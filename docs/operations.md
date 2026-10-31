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
$env:NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN = '<自行生成的访问令牌>'
$env:GAMEHUB_DB = 'C:\your-data\game-hub\vault.db'
npm start
```

应用在前台持续运行，Ctrl+C 退出。当前开发约束禁止开启后台进程，代理不会代为启动或重启服务。

| 环境变量 | 现有入口用途 |
| --- | --- |
| `GAMEHUB_HOST` / `GAMEHUB_PORT` / `GAMEHUB_PATH` | [NapCat 渠道网关配置](../packages/channel/napcat/README.md#其他渠道环境配置) |
| `NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN` | [NapCat 渠道连接令牌](../packages/channel/napcat/README.md#napcat-连接-game-hub-的令牌) |
| `GAMEHUB_ADMIN_REGISTRATION_TOKEN` | [core 系统管理员注册令牌](../packages/core/README.md#系统管理员注册与权限) |
| `GAMEHUB_DB` | SQLite 文件路径，默认 `data/vault.db` |
| `GAMEHUB_CONFIG` | 模块装配 JSON 路径，默认 `config/modules.json` |
| `GAMEHUB_ADMIN_USERS` | [core 可选环境预置管理员](../packages/core/README.md#系统管理员注册与权限) |
| `GAMEHUB_LOG_LEVEL` | `DEBUG` / `INFO` / `WARN` / `ERROR` / `SILENT` |
| `CHATAI_KEY_*` | 大语言模型密钥（匹配 `^CHATAI_KEY_[A-Z0-9_]{1,56}$`，**只按该前缀读取，不入库**） |
| `CHATAI_ADMIN_REGISTRATION_TOKEN` | [chat-ai 插件管理员注册令牌](../packages/plugin/chat-ai/README.md#ai-插件管理员注册令牌) |

模型档案用管理员指令维护，密钥只放容器环境，严禁写入数据库或日志。

## 系统管理员注册与权限

系统管理员注册、授权来源、持久化、撤销与升级规则由 [core 包](../packages/core/README.md#系统管理员注册与权限)维护。本页只记录部署入口，不重复定义权限语义。

### 令牌文档入口

环境变量按“连接双方或权限范围 + 用途”命名，详细字段契约放在所属包内。根 `.env.example` 汇总当前部署需要的变量；不因文档按包组织而拆分实际环境文件或改变加载方式。

| 变量 | 所属包与详细说明 |
| --- | --- |
| `NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN` | [NapCat 渠道：连接鉴权、双方配置与旧名迁移](../packages/channel/napcat/README.md#napcat-连接-game-hub-的令牌) |
| `GAMEHUB_ADMIN_REGISTRATION_TOKEN` / `GAMEHUB_ADMIN_USERS` | [core：系统管理员注册、预置名单与授权管理](../packages/core/README.md#系统管理员注册与权限) |
| `CHATAI_ADMIN_REGISTRATION_TOKEN` | [chat-ai 插件：独立 AI 管理员注册与旧名迁移](../packages/plugin/chat-ai/README.md#ai-插件管理员注册令牌) |

实际部署若使用仓库外的 Compose，需在那里同步环境映射；修改私有环境文件后重建相应容器，单纯 restart 不会载入新值。真实值不写入模板或仓库，部署与备份操作由维护者执行。

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

### NapCat 启动时快速登录

`QQ_ACCOUNT`、QQ 登录数据挂载及前台重建步骤统一见 [NapCat 渠道包](../packages/channel/napcat/README.md#其他渠道环境配置)。

## 账号存储与验收

现有 Vault 将新写入的凭据 JSON 及设备元数据 JSON 以 AES-256-GCM 保存（`enc:v1:`），兼容读取旧明文；没有批量改写既有记录。设备元数据可能包含 OAID 和构建指纹，同样需要保护。任一密文校验失败会终止读取，不把密文冒充 Cookie 或随机设备发送到社区。

密钥由进程环境 `VAULT_SECRET` 派生。当前保留了历史代码中的固定回退密钥，因此**未单独配置密钥时不能视为有效的静态保密保护**。密钥须与数据库一起妥善备份；已有密文不能通过随意修改环境密钥完成轮换，错误密钥会使已有登录不可读取。不要提交真实数据库、Cookie 或密钥。Compose 当前没有映射该变量，维护者须在明确的密钥迁移方案下配置，不能仅修改宿主机 `.env` 后就宣称生效。

只读诊断可使用 `new IdentityVault(path, {readOnly:true})`；该模式不建表、不迁移，写操作由 SQLite 拒绝。`tools/diagnose-zzz-api.mjs` 必须显式指定 `DIAG_USER`，不自动选择或列出其它用户。诊断只查看请求结果，不签到、不推送；生产库在线备份仍使用上一节的方法。

扫码相关变更应覆盖登录状态、设备保留与异步保存竞态的回归；模拟测试与真实账号验收分别记录。个人现场复核和修复过程保存于私有开发资料。

## 10041 与设备环境

保留扫码授权和 device_info 设备绑定两条入口：扫码取得或更新账号登录凭据；device_info 在已有账号绑定上补充常用 Android 设备信息，复用其凭据。正常重新扫码保留该账号已绑定的设备档案，无需每次重新导入。

手机官方页面正常，不等于机器人设备已经通过同样的鉴权。当前扫码会先从官方公开接口取得设备指纹，必须同时满足 `retcode=0`、`data.code=200` 和正确的指纹格式；随机种子及失败响应中的回退值不保存成有效指纹。该实现独立于旧宿主。

部署新版本后，如果旧账号仅扫码、仍沿用旧代码生成的设备值，可在机器人私聊发送“扫码登录”并附 `重建设备` 参数，前缀以当前命名空间为准；该选项明确重建设备并重新进行手机授权。正常重新扫码会保留已有账号设备。只刷新指纹可给“默认设备”附 `刷新指纹` 参数，但官方签发指纹本身不代表已经获得常用手机设备授权。

便签接口出现 10041 时，先检查登录状态与真实设备绑定，不要无限重试，也不要将自动化测试或指纹签发成功当作业务接口成功。公开展柜的 403/424/429 与米游社账号接口分别排查。账号现场记录应保存在私有开发资料中。

### Android 常用设备信息导入

国服用户可从 [get_device_info 源码与构建说明](https://github.com/forchannot/get_device_info) 取得自己 Android 手机导出的 JSON。上游提供 Actions 构建产物；本仓库不分发 APK，不需要提供手机 Cookie。设备 JSON 包含 OAID 等信息，只发送给自己信任的机器人私聊。

维护者更新代码后，在机器人私聊发送当前命名空间下的 `绑定设备 <JSON>`（不要保留尖括号）；完整粘贴对象，允许多行。对象必须包含字符串字段 `deviceName`、`deviceBoard`、`deviceModel`、`oaid`、`androidVersion`、`deviceFingerprint`、`deviceProduct`。总长度最多 8 KiB 字符，仅保存白名单字段；字段格式无效会报字段名，不回显原值。原来的 `绑定设备 <device_id> [device_fp]` 仍可用，也支持仅含 `device_id`、`device_fp` 的对象。

导入沿用当前账号稳定的 device_id，以手机档案申请 platform=2 的官方指纹，成功后才保存；申请失败保留旧配置。后续查询、正常重新扫码和刷新指纹沿用 Android 档案；显式 `扫码登录 重建设备` 会清除这套档案重新建立 web 设备，勿把它当成导入后的必要步骤。共享同一社区账号的绑定也共享设备配置。

2026-10-25 用户真机验收反馈：绑定 device_info 后便签查询正常。结合此前单独扫码仍为 10041 的对照，当前账号的问题与设备环境校验相关，常用设备绑定路径已验证可用。该结论不代表已掌握服务端完整风控规则，也不保证所有账号均只需这一步。模板未采集的附属字段仍为明确记录的默认值，见 [payload 来源说明](../packages/provider/mihoyo/vendor/android-device/README.md)。

## chatAi可用性修订上线

操作入口见[chatAi说明](chat-ai.md)。本轮代码未自动部署；上线前备份完整Vault。装配时会添加连接、收据、可选任务等插件自有表以及人物分支字段，保留旧模型ID和密钥引用，原消息归通用助手分支。验证“连接/模型详情→选择模型→普通私聊→群聊@→切换已导入人物”；表情、事件和主动发言逐项显式开启并人工验证。模型列表HTTP200不等于生成成功。

旧main档案可以直接命名和切换，不必重填。新增密钥环境变量仍需维护者更新容器运行环境；本轮未引入环境文件托管或代码热重载。主动任务为进程内生命周期资源，禁止额外后台进程的约束不变。
