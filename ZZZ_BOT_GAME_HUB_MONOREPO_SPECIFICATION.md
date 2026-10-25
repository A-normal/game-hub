# Game-Hub 新一代多社区游戏总线系统：Monorepo 与双轨演进技术规格说明书
## (Game-Hub: Monorepo Architecture & Dual-Track Channel Evolution Specification)

- **文档编号**: `GH-SPEC-20261025-V1`
- **生效日期**: `2026-10-25 01:00:00 +08:00`
- **架构状态**: `Approved / Draft for New Repository Implementation`
- **文档密级**: 核心工程设计规范（用于指导新独立仓库的创建与全量重构）

---

## 一、 项目愿景与架构范式转变 (Paradigm Shift)

### 1.1 历史单体架构的核心痛点回顾
在既有的单体部署形态中，Bot 整体生态呈现出严重的耦合与退化：
1. **插件臃肿与依赖倒挂**：TRSS-Yunzai 粗暴地扫描 `plugins/*/*.js`，使得一个仅服务绝区零的 Bot 内部被动加载了 79+ 个插件（其中原神 19 个、喵喵 10 个、杂项与示例数十个）。内存开销巨大，逻辑互相干扰；
2. **硬编码强依赖**：上层游戏插件（如 `ZZZ-Plugin`）在历史演进中硬编码引入了 `../../../genshin/model/...` 原神模型，导致“想玩绝区零，必须先装原神全家桶”；
3. **全局正则无序竞争**：各插件开发者各自编写复杂的正则表达式（如 Miao-plugin 宽正则 `^#.+换.+$`），不同游戏、不同功能的正则在全局循环中互相劫持，引发如“喵喵面板抢跑绝区零兑换码”等严重故障；
4. **命名空间与触发前缀写死**：插件内部写死 `#`、`/`、`zzz`，不同群聊和部署人员无法按自身习惯定义前缀（如 A 用户想要 `*便签`，B 用户想要 `/便签`）；
5. **跨渠道身份割裂**：QQ 官方开放平台哈希 OpenID、NapCat 真实 QQ 号、Telegram 纯数字 ID 各自为政，凭据无法打通。

### 1.2 Game-Hub 核心设计理念
为从根本上根除上述“屎山”，新仓库将彻底重构，基于**“三向微内核总线（Tri-Partite Broker）”**范式构建：
- **西向（Inbound Channels）**：渠道整形与自适应渲染。对外抹平不同聊天平台的事件差异与渲染能力差异；
- **中央（Core Dispatcher）**：动态命名空间微内核。业务插件只提交**纯语义指令词元（Pure Tokens）**，触发符号（`*`、`/`、`%`）与别名完全由**部署人员（Deployer）在配置中自主掌控**；
- **东向（Outbound SPI）**：可插拔的独立社区驱动。将米哈游米游社、库洛库街区等社区的鉴权、签名（DS1/DS2）、设备指纹与 API 请求抽离为标准 SPI 插件，与具体游戏逻辑正交解耦；
- **北向（Game Plugins）**：纯游戏功能插件。不带任何 regex、不绑定具体渠道、不耦合具体网络库，纯粹实现游戏业务流。

---

## 二、 Monorepo 工程拓扑与包设计 (Package Topology)

新项目采用 **Monorepo（单一多包仓库）** 进行统一版本化管理，基于 `pnpm workspace` 构建高内聚、低耦合的模块拓扑：

```text
game-hub/ (Monorepo 根目录)
├── package.json
├── pnpm-workspace.yaml
├── turbo.json (可选：构建缓存调度)
├── tsconfig.base.json (或统一 ESM 配置)
│
├── packages/
│   ├── core/                      # [@game-hub/core] 微内核核心
│   │   ├── src/
│   │   │   ├── dispatcher/        # 动态命名空间分词器、路由与指令编译器
│   │   │   ├── shaper/            # 渠道入站事件整形器、能力适配器
│   │   │   ├── identity/          # 统一身份保密库 (Global Identity Vault)
│   │   │   ├── spi/               # 社区驱动 SPI 标准契约接口
│   │   │   └── types/             # 核心数据模型契约 (IUnifiedEvent, IGamePlugin 等)
│   │   └── package.json
│   │
│   ├── provider-mihoyo/           # [@game-hub/provider-mihoyo] 米游社社区驱动 SPI
│   │   ├── src/
│   │   │   ├── signer/            # Takumi DS1 / DS2 动态签名与时间戳算法
│   │   │   ├── device/            # 设备指纹 (Device FP)、UUID 生成与维护
│   │   │   ├── auth/              # 米游社二维码扫码登录、Token 刷新与保活
│   │   │   └── client/            # Takumi API 网关封装与 1034 验证码拦截
│   │   └── package.json
│   │
│   ├── provider-kuro/             # [@game-hub/provider-kuro] 库洛社区驱动 SPI (鸣潮)
│   │   ├── src/                   # 库街区 Token 管理、签名与 API 网关
│   │   └── package.json
│   │
│   ├── plugin-zzz/                # [@game-hub/plugin-zzz] 绝区零纯指令业务插件
│   │   ├── src/
│   │   │   ├── manifest.ts        # 纯语义词元清单 (便签, 面板, 兑换码, 驱动盘, 日历)
│   │   │   ├── handlers/          # 具体业务实现逻辑 (只消费 IGameContext)
│   │   │   └── renders/           # 页面渲染模板与资源
│   │   └── package.json
│   │
│   ├── gateway-yunzai/            # [@game-hub/gateway-yunzai] 轨道 A：云崽极简桥接适配器
│   │   ├── src/
│   │   │   ├── apps/dispatcher.ts # Priority: -1000 前置拦截分发器
│   │   │   ├── apps/admin.ts      # #game-hub 运维管理面板
│   │   │   └── index.ts           # 云崽标准插件导出
│   │   └── package.json
│   │
│   └── gateway-standalone/        # [@game-hub/gateway-standalone] 轨道 B：原生独立去云崽网关
│       ├── src/
│       │   ├── server.ts          # 独立进程启动入口
│       │   ├── channels/
│       │   │   ├── napcat.ts      # NapCat (OneBotv11) 正向/反向 WebSocket 纯净连接
│       │   │   ├── telegram.ts    # Telegram Bot API (Webhook / Long-Polling)
│       │   │   ├── qqbot.ts       # 腾讯官方 QQBot 开放平台 SDK 连接
│       │   │   └── satori.ts      # Satori 协议标准适配器
│       │   └── renderer/          # 极简独立 Puppeteer / HTML-Image 渲染服务
│       └── package.json
│
└── config/
    ├── namespaces.yaml            # 部署人员动态命名空间配置文件
    └── gateway.yaml               # 独立网关连接配置文件 (Standalone 模式)
```

---

## 三、 “云崽桥接 + 原生独立” 双轨演进模型 (Dual-Track Evolutionary Model)

为确保项目**既能立即接入既有成熟生态平稳过渡，又具备随时“彻底脱离云崽自立门户”的战略纵深**，系统设计为**严格双轨制**。

```text
                                +-----------------------------+
                                |  北向业务：纯游戏插件层     |
                                |  (@game-hub/plugin-zzz 等)  |
                                +--------------▲--------------+
                                               │ (纯语义词元 + IGameContext)
                                               │
                                +--------------┴--------------+
                                |  中央：微内核调度总线       |
                                |  (@game-hub/core)           |
                                |  - 动态命名空间分词编译器   |
                                |  - 统一用户身份中枢 Vault   |
                                +-------▲-------------▲-------+
                                        │             │
                    ┌───────────────────┘             └───────────────────┐
                    │ (标准化事件 IUnifiedEvent)                          │ (标准化事件 IUnifiedEvent)
                    │                                                     │
     +--------------┴--------------+                       +--------------┴--------------+
     |   【轨道 A：云崽平滑过渡轨】 |                       |   【轨道 B：原生去云崽纯净轨】 |
     |  (@game-hub/gateway-yunzai) |                       | (@game-hub/gateway-standalone)|
     +--------------▲--------------+                       +--------------▲--------------+
                    │                                                     │
     +--------------┴--------------+                       +--------------┴--------------+
     | 宿主：TRSS-Yunzai 传输骨架  |                       | 宿主：纯净 Node.js 原生进程  |
     | - 彻底剥离 genshin/miao     |                       | - 直接监听 NapCat ws-reverse |
     | - 仅保留 OneBot/TG Adapter  |                       | - 原生长轮询 Telegram API   |
     | - 插件总数从 79 压降至 4 个 |                       | - 内存占用 30MB，秒级冷启动  |
     +-----------------------------+                       +-----------------------------+
```

### 3.1 轨道 A：云崽极简桥接适配器 (`gateway-yunzai`)
- **适用场景**：当前存量部署环境，充分复用 TRSS-Yunzai 已配置好的登录态、网络通道与现成适配器。
- **治理与瘦身准则**：
  1. **彻底清空历史包袱**：容器内的 `plugins/genshin` 与 `plugins/miao-plugin` 彻底剔除（或置空其规则）。整个 Yunzai 容器内除基础通道外，不再运行任何原神代码；
  2. **绝对前置拦截（Priority: -1000）**：`gateway-yunzai` 在最高优先级拦截所有入站消息，经 `InboundShaper` 整形后输入微内核。微内核若命中游戏业务，执行后直接向 Yunzai 返回 `'return'`，强行掐断后续一切无关插件的判定流；
  3. **插件数断崖式压降**：通过剥离无关套件，将 Yunzai 加载的插件数由 **79 个骤降至 3~4 个**（通道适配器 + Game-Hub + 业务插件）。

### 3.2 轨道 B：原生独立去云崽网关 (`gateway-standalone`)
- **适用场景**：终极目标架构，追求极致的系统纯净度、低资源开销与完全掌控权。
- **设计要点**：
  1. **完全自包含进程**：直接基于 Node.js 启动，不引入任何 Yunzai / OICQ 历史代码；
  2. **协议直连支持**：
     - **OneBotv11 / NapCat**：支持作为 WebSocket Client 连接 NapCat，或作为 WebSocket Server 接收 NapCat 反向连接（ws-reverse）；
     - **Telegram**：基于原生 `node-telegram-bot-api` 或轻量 HTTP Webhook 处理 Updates；
     - **官方 QQBot**：使用腾讯官方 `@tencent-connect/bot` SDK 直连长连接网关；
  3. **极致性能**：无任何无用定时任务、无动态正则全量扫描，整机常驻内存可从 Yunzai 的 250MB+ 压缩至 **30~45MB**，服务冷启动在 500ms 内完成。

### 3.3 双轨无缝平替的技术保证：归一化契约
无论系统运行在轨道 A 还是轨道 B，**上层的 `@game-hub/core` 与所有 `@game-hub/plugin-*` 源码完全不需要改动一行代码**。其技术保障来自于双轨网关共同实现的归一化契约：

```typescript
// 归一化入站事件契约
export interface IUnifiedEvent {
  platform: 'qq-napcat' | 'telegram' | 'qqbot' | 'satori';
  unifiedUserId: string;     // 统一规范主键，如 "qq:123456", "tg:987654321"
  rawText: string;           // 原始输入文本
  cleanText: string;         // 预处理剥离 @Bot 后的干净文本
  isGroup: boolean;
  groupId?: string;
  sender: {
    id: string;
    name: string;
    role?: 'owner' | 'admin' | 'member';
  };
  // 渠道自适应回复代理
  reply: (content: string | IAdaptiveMessage, options?: IReplyOptions) => Promise<any>;
}
```

---

## 四、 部署人员动态命名空间与纯指令词元引擎 (Dynamic Namespace Engine)

彻底终结开发者“在插件内写死正则”的陋习，将命名空间与触发前缀的管理权交还给仓库部署人员。

### 4.1 部署人员配置文件规范 (`config/namespaces.yaml`)
部署人员在配置文件中为每个接入的游戏自主定义前缀、别名与判定权重：

```yaml
# ==============================================================================
# Game-Hub 部署人员动态命名空间路由配置
# ==============================================================================

namespaces:
  # 部署人员 A 的喜好：绝区零用星号触发
  zzz:
    prefix: "*"               # 触发前缀（如 "*", "/", "%", "!" 等，允许配置为空字符串 ""）
    aliases:                  # 游戏中文/英文别名
      - "zzz"
      - "ZZZ"
      - "绝区零"
    priority: 100             # 路由判定优先级
    allow_bare_keywords: false # 是否允许群内直接发送无前缀的词元（如直接发 "便签"）

  # 鸣潮采用斜杠触发
  wuwa:
    prefix: "/"
    aliases:
      - "wuwa"
      - "鸣潮"
      - "mc"
    priority: 80
    allow_bare_keywords: false
```

### 4.2 纯语义词元与编译器算法 (Compiler & Dispatch Algorithm)
1. **纯游戏插件契约**：插件只提交由纯词汇构成的词元数组，严禁包含任何符号（如 `#`、`^`、`$`）：
   ```typescript
   export const ZZZManifest: IGamePluginManifest = {
     gameId: "zzz",
     name: "绝区零",
     community: "mihoyo",
     routes: [
       { id: "note", tokens: ["便签", "体力", "电量"], action: handleNote },
       { id: "code", tokens: ["兑换码", "code", "前瞻码"], action: handleCode },
       { id: "panel", tokens: ["面板", "更新面板"], action: handlePanel }
     ]
   };
   ```
2. **复合前缀与别名剥离算法**：
   当用户输入消息时，调度器执行最长前缀分词匹配：
   - 部署人员配置：`prefix = "*"`，`aliases = ["zzz", "绝区零"]`；
   - 用户输入：`*绝区零便签` 或 `*便签` 或 `zzz便签`；
   - 调度器解析步骤：
     - Step 1: 扫描并剥离配置的前缀符号 `*` -> 剩余 `绝区零便签` 或 `便签`；
     - Step 2: 扫描并剥离命中的别名 `绝区零` -> 剩余纯语义词元 `便签`；
     - Step 3: 在 `plugin-zzz` 的路由表中寻找与 `便签` 最长前缀匹配的路由 -> 命中 `note` 路由；
     - Step 4: 将纯词元后面的剩余文本作为参数安全切分（如 `*面板 简` -> 提取指令 `panel`，参数 `简`）；
     - Step 5: 驱动就绪校验与执行注入。

---

## 五、 社区驱动 SPI (Community Provider SPI) 与统一身份中枢

### 5.1 社区驱动标准接口契约
社区驱动（如米游社、库洛库街区）作为完全独立的外接 SPI 实现：

```typescript
export interface ICommunityProvider {
  id: string;               // 驱动唯一标识，如 "mihoyo", "kuro"
  name: string;             // 驱动中文名，如 "米游社", "库街区"
  
  // 凭据生命周期与鉴权
  createLoginQrCode: () => Promise<{ qrUrl: string; checkStatus: () => Promise<IAuthTicket> }>;
  refreshSession: (ticket: IAuthTicket) => Promise<ISessionCredentials>;
  
  // 核心网关与动态签名请求
  requestGateway: (options: IGatewayRequestOptions) => Promise<any>;
}
```

### 5.2 全局统一身份保密库 (Global Identity Vault)
将用户在聊天软件中的账号、米哈游/库洛通行证、游戏内角色 UID 进行三层解耦与集中映射：

```text
+-------------------------------------------------------------------------------+
|               【第 1 层：聊天软件用户主体 (Chat User Layer)】                 |
|   统一主键: unifiedUserId                                                     |
|   - "qq:12345678"           (来自 NapCat / OneBotv11)                         |
|   - "tg:987654321"          (来自 Telegram Bot API)                           |
|   - "qqbot:C2C_OPENID_xxxx" (来自 官方 QQBot 开放平台)                        |
+---------------------------------------┬---------------------------------------+
                                        │ 绑定 (1:N 跨平台认领与关联)
+---------------------------------------▼---------------------------------------+
|               【第 2 层：社区通行证凭据主体 (Community Account Layer)】       |
|   - providerId: "mihoyo"                                                      |
|   - accountKey: ltuid ("100023456")                                           |
|   - credentials: { cookie: "ltuid=...; ltoken=...", deviceFp, deviceId }      |
+---------------------------------------┬---------------------------------------+
                                        │ 拥有角色 (1:N 通行证与角色关联)
+---------------------------------------▼---------------------------------------+
|               【第 3 层：游戏角色实体 (Game Role Layer)】                     |
|   - gameId: "zzz" / "hsr" / "wuwa"                                            |
|   - uid: "17708598"                                                           |
|   - region: "prod_gf_cn"                                                      |
|   - isDefault: true                                                           |
+-------------------------------------------------------------------------------+
```

---

## 六、 渐进式实施路线图 (Phased Implementation Roadmap)

```text
[Phase 0: 新仓脚手架]  ──►  [Phase 1: 内核与驱动]  ──►  [Phase 2: 纯插件与双轨A]  ──►  [Phase 3: 独立网关双轨B]  ──►  [Phase 4: 彻底去云崽]
 - pnpm workspace            - @game-hub/core            - @game-hub/plugin-zzz          - @game-hub/gateway-standalone   - 卸载 TRSS-Yunzai
 - TS / Vitest 基础工程      - @game-hub/provider-mihoyo - @game-hub/gateway-yunzai      - NapCat / TG 直连通信           - 全容器转为纯净 Node 镜像
                             - DS1/DS2 与 SPI            - 云崽容器内瘦身(砍原神喵喵)    - 内存降至 30MB 级               - 彻底交付
```

### Phase 0: 新仓库初始化与 Monorepo 脚手架搭建
- 初始化全新 Git 仓库（如 `game-hub`）；
- 配置 `pnpm-workspace.yaml` 与 TypeScript 模块解析配置；
- 建立统一的 Vitest / Node:Test 自动化测试套件与 ESLint 规范。

### Phase 1: 核心微内核抽离与社区驱动研发
- 实现 `@game-hub/core`：InboundShaper、Dynamic Namespace Dispatcher、Identity Vault；
- 实现 `@game-hub/provider-mihoyo`：将 Takumi DS 签名、设备指纹、网关调用封装为纯 SPI 模块；
- 实现 `@game-hub/provider-kuro`（可选扩展）：完成鸣潮社区驱动的原型接口。

### Phase 2: 绝区零纯业务化插件重构与云崽轨道 A（过渡轨）上线
- 实现 `@game-hub/plugin-zzz`：重构便签、面板、兑换码、驱动盘等功能，纯净暴露 Pure Tokens；
- 实现 `@game-hub/gateway-yunzai`：提供 Priority -1000 云崽前置拦截器与 `#game-hub` 运维面板；
- **环境治理**：在现有云崽容器中彻底剔除 `plugins/genshin` 与 `plugins/miao-plugin`，验证在极简插件结构下的平稳运行。

### Phase 3: 原生独立网关（轨道 B）落地与验证
- 实现 `@game-hub/gateway-standalone`：
  - 基于 WebSocket 直连 NapCat (OneBotv11)；
  - 基于官方 Telegram Bot API 轮询直连；
  - 接入轻量独立 Puppeteer 渲染管道；
- 双轨并行验证：相同一套业务代码，在 Yunzai 宿主与 Standalone 宿主下运行效果完全一致。

### Phase 4: 全量切入独立架构，彻底终结云崽历史依赖
- 验证生产环境在 Standalone 独立网关下的稳定性与极低资源占用；
- 容器化镜像全面切换为微型 Node.js 原生镜像（无需预装 Redis 全家桶与旧云崽依赖）；
- 归档历史项目，完成架构重构的全面胜利。

---

## 七、 详细结论

1. **彻底告别屎山堆叠**：通过将代码解耦至独立 Monorepo 仓库，彻底摆脱旧 Yunzai“79 个插件乱堆、强行绑架原神与喵喵全家桶”的历史包袱；
2. **战略主动权与双轨演进**：通过设计标准化 `IUnifiedEvent`，同时支持“云崽极简过渡轨（轨道 A）”与“原生去云崽纯净轨（轨道 B）”，既保障了现有服务不停机的平滑过渡，又赋予了未来彻底切断云崽依赖、自建轻量级底座的绝对自由；
3. **部署人员真正的自由**：彻底根除开发者写死正则导致的指令冲突，部署人员在 `namespaces.yaml` 中掌握前缀与别名的绝对调度权。
