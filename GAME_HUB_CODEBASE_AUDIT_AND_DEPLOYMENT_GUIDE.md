# Game-Hub 代码库纯洁性核验与 NapCat + GameHub 部署运行指南
## (Codebase Integrity Audit & NapCat + Game-Hub Deployment Specification)

- **生成时间戳**: `2026-10-25 10:45:00 +08:00`
- **任务目标**: 
  1. 深度核验当前分支 (`main`) 代码是否只包含确实的提交内容，排查是否存在 `zzz-bot` 的迁移残留代码与杂质；
  2. 梳理并提供当前插件架构下，NapCat 与 GameHub 协同部署与运行的完整启动方式。
- **大致内容**:
  - Git 分支提交历史与工作区状态核查
  - 核心模块代码纯洁性与 zzz-bot 迁移遗留排查
  - 自动化测试与质量门禁核验
  - NapCat + GameHub 系统拓扑与通信架构
  - GameHub 独立常驻服务启动脚本规范
  - NapCat 侧 OneBotv11 反向 WebSocket 配置
  - 完整启动步骤与端到端联调验证
- **详细结论**: 见本文档第一节与第五节。

---

## 一、 代码库纯洁性与确实性核验结论 (Audit Summary)

### 1.1 Git 分支与提交历史确实性
当前分支为 `main`，共有 3 次规范且目的明确的 Git 提交，无任何多余分支与冗余提交：
1. `dd5447a` - `Initail commit: 设计架构文档与实现方案`：包含新仓库的脚手架规划、协议规范与首轮架构审查记录。
2. `d4226d4` - `feat(game-hub): 完成 NapCat 独立网关与首个端到端纵切链路 (绑定选角色/查询便签)`：
   - 完成了微内核架构 (`@game-hub/core`)、NapCat 反向 WebSocket 网关 (`@game-hub/gateway-napcat`)、米哈游驱动 SPI (`@game-hub/provider-mihoyo`) 以及绝区零业务插件 (`@game-hub/plugin-zzz`)；
   - 彻底落实审查意见，放弃旧数据库自动迁移，旧数据作为脏数据丢弃；
   - 交付了标准 UIGF 结构抽卡记录手动导入工具 `tools/import-gacha.mjs`；
   - 建立了全链路自动化测试套件。
3. `b1907b8` - `feat(tools): 增强抽卡记录导入工具，完美适配 ZZZ-Plugin 原生多卡池频段结构与自动建库`：
   - 进一步优化 `tools/import-gacha.mjs`，兼容原生字典频段结构并实现按需自动建表。

### 1.2 工作区状态与物理文件核查
- **工作区状态**: `git status` 显示 `working tree clean, nothing to commit`。
- **Git 跟踪文件**: 共 35 个文件，全部为当前架构必需的核心代码、测试、工具与技术规格文档。
- **未跟踪/忽略文件**: 仅包含 `node_modules/` 与 `data/vault.db`（本地运行测试与导入工具时由 `node:sqlite` 产生的数据文件，已被 `.gitignore` 正确忽略）。
- **文件纯度**: 工作区内没有任何未清理的临时文件、备份文件或迁移残片。

### 1.3 `zzz-bot` 迁移代码与遗留包袱排查
经对 `packages/`、`tools/`、`tests/` 全代码树进行多维度全文检索（检索词包含 `zzz-bot`, `zzz_bot`, `lotus`, `genshin`, `miao`, `redis`, `yunzai` 等）：
1. **代码零残留**: 业务代码与微内核中**完全没有**旧仓库的残留代码；
2. **彻底脱离云崽基类与正则污染**: 彻底去除了 TRSS-Yunzai 的 `plugins/*/*.js` 全局扫描机制、正则指令竞争体系以及原神 (`genshin`) / 喵喵 (`miao-plugin`) 依赖倒挂；
3. **摒弃自动迁移脚本**: 早期设计文档中提及的概念性自动迁移脚本（`scripts/migrate-from-yunzai.mjs`）已按照审查意见被彻底丢弃，从未进入代码仓库，仅保留了独立且安全幂等的 `tools/import-gacha.mjs`；
4. **测试门禁 100% 通过**: 执行 `pnpm test`，保密库、米游社客户端及端到端纵切链路等 12 项自动化测试全部通过 (12/12 PASS)。

---

## 二、 NapCat + GameHub 架构与通信机制

```
┌──────────────────┐               ┌────────────────────────────────────────────────────────┐
│  NapCat (OneBot) │ ──ws-reverse─►│ Game-Hub: @game-hub/gateway-napcat                     │
│  (QQ NT 客户端)   │ ◄──Echo RPC───│ (端口: 8080, 路径: /onebot/v11/ws, Token: 安全密钥)      │
└──────────────────┘               └───────────────────────────┬────────────────────────────┘
                                                               │ InboundShaper 归一化事件
                                                               ▼
                                   ┌────────────────────────────────────────────────────────┐
                                   │ Game-Hub Core: @game-hub/core                          │
                                   │ ├── GameHubDispatcher (前缀 * / 命名空间路由)             │
                                   │ └── IdentityVault (SQLite 统一身份凭据与角色库)           │
                                   └───────────────────────────┬────────────────────────────┘
                                                               │ 派发 Context (包含 Client)
                                                               ▼
                                   ┌────────────────────────────────────────────────────────┐
                                   │ Game-Hub Plugin: @game-hub/plugin-zzz                  │
                                   │ (词元: *便签, *绑定, *选角色, *角色列表)                  │
                                   └───────────────────────────┬────────────────────────────┘
                                                               │ Takumi 请求 (装配 DS1/DS2)
                                                               ▼
                                   ┌────────────────────────────────────────────────────────┐
                                   │ Game-Hub Provider: @game-hub/provider-mihoyo           │
                                   │ (MihoyoTakumiClient / 设备指纹 / 动态签名)              │
                                   └────────────────────────────────────────────────────────┘
```

1. **连接模型**：NapCat 作为客户端，向 GameHub 网关发起反向 WebSocket 连接（Reverse WebSocket）。
2. **安全隔离**：GameHub 网关默认仅监听环回口 `127.0.0.1:8080`，并在 WebSocket 握手阶段强制校验 `accessToken`（支持 `Authorization: Bearer <token>` 头或 `?access_token=<token>` Query）。
3. **可靠回复**：网关内置 `OneBotRpcManager`，所有回复均带有自增 `echo` 序列号，等待 NapCat 客户端响应确认，杜绝丢包。
4. **指令格式**：由微内核 `GameHubDispatcher` 统一剥离前缀与别名，默认前缀为 `*`，支持别名 `zzz` / `绝区零`。

---

## 三、 Game-Hub 服务端启动脚本

在项目根目录下，可以通过如下轻量级入口脚本（例如 `start.mjs` 或 `app.mjs`）完成全组件组装与常驻监听：

```javascript
/**
 * @file app.mjs
 * @description Game-Hub 常驻服务启动入口
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { IdentityVault, GameHubDispatcher } from "@game-hub/core";
import { MihoyoCommunityProvider } from "@game-hub/provider-mihoyo";
import { ZZZPluginManifest } from "@game-hub/plugin-zzz";
import { NapCatGateway } from "@game-hub/gateway-napcat";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. 配置参数 (可通过环境变量动态覆盖)
const PORT = Number(process.env.GAMEHUB_PORT || process.env.PORT || 8080);
const HOST = process.env.GAMEHUB_HOST || process.env.HOST || "127.0.0.1";
const PATH = process.env.GAMEHUB_PATH || "/onebot/v11/ws";
const ACCESS_TOKEN = process.env.GAMEHUB_TOKEN || "gamehub_secret_token_2026";
const DB_PATH = process.env.GAMEHUB_DB || path.resolve(__dirname, "data/vault.db");

// 确保数据目录存在
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

async function main() {
  console.log("=== 正在启动 Game-Hub 多社区游戏总线 ===");
  console.log(`• 数据库路径: ${DB_PATH}`);
  console.log(`• 网关监听: ws://${HOST}:${PORT}${PATH}`);

  // 2. 初始化统一身份保密库 (Identity Vault)
  const vault = new IdentityVault(DB_PATH);

  // 3. 初始化调度内核与社区驱动 SPI
  const dispatcher = new GameHubDispatcher({ vault });
  const mihoyoProvider = new MihoyoCommunityProvider();
  dispatcher.registerProvider(mihoyoProvider);

  // 4. 注册绝区零纯指令业务插件
  dispatcher.registerPlugin(ZZZPluginManifest);

  // 5. 初始化 NapCat OneBotv11 反向 WebSocket 网关
  const gateway = new NapCatGateway({
    host: HOST,
    port: PORT,
    path: PATH,
    accessToken: ACCESS_TOKEN,
    dispatcher
  });

  await gateway.start();
  console.log(`✅ Game-Hub 服务就绪，正在等待 NapCat 连接...`);

  // 优雅停机处理
  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal} 信号，正在平滑关闭 Game-Hub...`);
    await gateway.stop();
    vault.close();
    console.log("Game-Hub 已安全退出。");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Game-Hub 启动失败:", err);
  process.exit(1);
});
```

---

## 四、 NapCat 客户端配置方式

NapCat 启动后，需配置其连接至 Game-Hub 的反向 WebSocket 服务端口。

### 4.1 配置文件修改 (`onebot11_<QQ号>.json`)
打开 NapCat 对应账号的 OneBot11 配置文件（通常位于 `config/onebot11_<QQ号>.json` 或 NapCat WebUI 管理面板的「网络配置」-「反向 WebSocket」）：

```json
{
  "network": {
    "httpServers": [],
    "httpClients": [],
    "websocketServers": [],
    "websocketClients": [
      {
        "enable": true,
        "name": "Game-Hub-Gateway",
        "url": "ws://127.0.0.1:8080/onebot/v11/ws",
        "reportSelfMessage": false,
        "messagePostFormat": "array",
        "reconnectInterval": 3000,
        "heartbeatInterval": 5000,
        "token": "gamehub_secret_token_2026"
      }
    ]
  }
}
```

> **配置关键项说明**：
> 1. `url`: 填入 Game-Hub 监听的完整地址 `ws://127.0.0.1:8080/onebot/v11/ws`；
> 2. `token`: 必须与 Game-Hub 网关配置的 `ACCESS_TOKEN` 完全一致，否则握手阶段将被 `401 Unauthorized` 拒绝；
> 3. 若 NapCat 与 Game-Hub 分别运行在不同的 Docker 容器中：
>    - 若使用 Docker Compose，建议将两者置于同一自定义网络，`url` 填 `ws://game-hub:8080/onebot/v11/ws`，并将 GameHub 的 `HOST` 设为 `0.0.0.0`；
>    - 若 GameHub 运行在宿主机，NapCat 容器可配置 `ws://host.docker.internal:8080/onebot/v11/ws`。

---

## 五、 端到端部署与联调验证步骤

### 5.1 启动顺序
1. **安装依赖与环境自检**：
   ```bash
   pnpm install
   pnpm test
   ```
   确保 12 项单元与集成测试全绿。

2. **启动 Game-Hub 服务端**：
   ```bash
   # 直接运行或带自定义环境变量
   GAMEHUB_TOKEN="gamehub_secret_token_2026" node app.mjs
   ```
   控制台将输出：
   ```text
   === 正在启动 Game-Hub 多社区游戏总线 ===
   • 数据库路径: C:\Library\repository\game-hub\data\vault.db
   • 网关监听: ws://127.0.0.1:8080/onebot/v11/ws
   ✅ Game-Hub 服务就绪，正在等待 NapCat 连接...
   ```

3. **启动 NapCat 客户端**：
   - 运行 NapCat Shell / Docker / 桌面版；
   - 登录目标 QQ 机器人账号；
   - 查看 NapCat 控制台日志，确认输出：`[WebSocketClient] 连接至 ws://127.0.0.1:8080/onebot/v11/ws 成功`。

### 5.2 交互指令实测
在 QQ 私聊或群聊中，向机器人发送以下指令测试当前已就绪的 4 项业务功能：

| 指令 | 说明 | 预期响应 |
| :--- | :--- | :--- |
| `*便签` / `*体力` | 初次未绑定时查询 | 提示：`【绝区零便签】未检测到已激活的绝区零角色！请发送：*绑定 <米游社Cookie>` |
| `*绑定 <Cookie>` | 绑定米游社通行证 | 提示：`【绝区零】通行证绑定成功！检测到 N 个绑定的绳匠角色...`，并自动激活首个角色 |
| `*便签` / `*电量` | 已绑定状态下查询 | 输出当前激活角色的实时电量、恢复倒计时、每日活跃度、录像店与刮刮乐状态 |
| `*角色列表` | 列出全部绑定角色 | 列出该用户绑定的全部绝区零角色，并标注当前主角色（带 ★ 标识） |
| `*选角色 <UID>` | 切换主查询角色 | 提示：`【绝区零】已成功将主角色切换为：[UID] 角色名`，后续便签自动针对该角色查询 |
| `zzz便签` / `绝区零便签` | 使用游戏别名触发 | 与 `*便签` 效果相同，验证动态命名空间多别名解析能力 |

### 5.3 抽卡记录导入工具使用
如需导入旧系统的抽卡历史记录，直接使用独立 CLI 工具导入至当前 SQLite 库：
```bash
node tools/import-gacha.mjs <抽卡记录JSON路径> ./data/vault.db
```
支持标准 UIGF 结构及 ZZZ 原生多频段卡池结构，支持幂等重跑与自动建表。
