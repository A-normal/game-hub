# Game-Hub 底层社区 API、动态签名与原生网关协议规格说明书
## (Community API Signatures, Device Parameters & Native Gateway Protocol Specifications)

- **归档路径**: `docx/2026-10-25/monorepo-dual-track/GAME_HUB_COMMUNITY_API_AND_GATEWAY_PROTOCOL_SPEC.md`
- **目标**: 为 `@game-hub/provider-mihoyo`、`@game-hub/provider-kuro` 以及 `@game-hub/gateway-standalone` 提供权威的底层通信协议与报文规格参考。

---

## 一、 米哈游社区驱动 SPI (`@game-hub/provider-mihoyo`) 通信规格

### 1.1 Takumi 动态签名 (Dynamic Secret) 算法体系
米游社客户端通过两套动态签名校验请求的合法性，防止重放攻击：

#### 1. DS1 签名（用于米游社游戏战绩接口：便签、角色面板、式舆防卫战）
- **适用接口**: `api-takumi-record.mihoyo.com` 下的游戏战绩查询
- **版本配置**: `x-rpc-app_version: 2.71.1`，`x-rpc-client_type: 5`
- **Salt (盐值)**: `xV8vVuOBqIOB00nugrIZug1xxBLOuWKK` (2.71.1)
- **计算逻辑**:
  ```typescript
  function getDs1(query = '', body = ''): string {
    const t = Math.floor(Date.now() / 1000);
    const r = Math.random().toString(36).substring(2, 8); // 6位随机字符串
    const content = `salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`;
    const hash = crypto.createHash('md5').update(content).digest('hex');
    return `${t},${r},${hash}`;
  }
  ```

#### 2. DS2 签名（用于米哈游通行证、米游社社区帖子、每日签到接口）
- **适用接口**: `api-takumi.mihoyo.com` / `bbs-api.mihoyo.com`
- **版本配置**: `x-rpc-app_version: 2.71.1`，`x-rpc-client_type: 2` (Android)
- **Salt (盐值)**: `t0qEgfub6cvueAPgR5mMgQFtmaJuoUZ6` (K2 盐值)
- **计算逻辑**:
  ```typescript
  function getDs2(query = '', body = ''): string {
    const t = Math.floor(Date.now() / 1000);
    const r = Math.floor(Math.random() * 100000 + 100000); // 100000~200000 随机数
    const content = `salt=${salt2}&t=${t}&r=${r}&b=${body}&q=${query}`;
    const hash = crypto.createHash('md5').update(content).digest('hex');
    return `${t},${r},${hash}`;
  }
  ```

### 1.2 设备指纹与请求头装配规范
所有发送至 Takumi 网关的请求必须装配完整的设备指纹头，否则将触发风控拦截（`retcode: 1034` 极验验证码）：

| 请求头字段 | 标准值示例 | 说明 |
| :--- | :--- | :--- |
| `x-rpc-app_version` | `2.71.1` | 米游社当前基线客户端版本 |
| `x-rpc-client_type` | `5` (Web战绩) / `2` (App社区) | 客户端类型标识 |
| `x-rpc-device_id` | `c5188846-953e-40fb-8868-cf1998319f07` | 标准 UUIDv4，每个账号绑定后持久化不变 |
| `x-rpc-device_fp` | `38d7f8a9b0c1` | 13位十六进制设备指纹码，避免频繁更换 |
| `x-rpc-device_name` | `Xiaomi 23049RAD8C` | 伪装真实手机型号 |
| `x-rpc-device_model` | `23049RAD8C` | 设备型号 |
| `x-rpc-sys_version` | `14` | Android 系统版本 |
| `DS` | `1729814400,a1b2c3,8f7a9d...` | 动态计算得出的 DS 签名 |
| `Cookie` | `ltuid=...; ltoken=...; account_id=...` | 用户通行证凭据 |

### 1.3 核心绝区零 Takumi API 端点清单
1. **实时便签 (Note)**:
   - `GET https://api-takumi-record.mihoyo.com/game_record/app/zzz/api/note?role_id={uid}&server={server}`
2. **角色基础清单 (Avatars)**:
   - `POST https://api-takumi-record.mihoyo.com/game_record/app/zzz/api/avatar/basic`
   - Body: `{"role_id":"{uid}","server":"{server}"}`
3. **式舆防卫战 / 危局强袭战战报**:
   - `GET https://api-takumi-record.mihoyo.com/game_record/app/zzz/api/challenge?role_id={uid}&server={server}`
4. **菲林月度手账 (Month Ledger)**:
   - `GET https://api-takumi.mihoyo.com/event/game_record_zzz/month_info?month={YYYYMM}&uid={uid}&region={server}`
5. **前瞻直播兑换码兑换**:
   - `POST https://api-takumi.mihoyo.com/common/apicdkey/api/exchangeCdkeySys`
   - Body: `{"cdkey":"{code}","uid":"{uid}","game_biz":"nap_cn","region":"{server}"}`

---

## 二、 库洛社区驱动 SPI (`@game-hub/provider-kuro`) 通信规格 (鸣潮扩展)

为证明 Game-Hub 多厂商多社区的解耦能力，为库洛社区建立同等 SPI 规范：

### 2.1 库街区 API 网关鉴权
- **Base URL**: `https://api.kurobbs.com`
- **鉴权头**:
  - `token`: 库街区用户登录凭据（通过手机号验证码或扫码获取）；
  - `devCode`: 客户端设备唯一码；
  - `source`: `android`；
  - `version`: `2.2.0`。
- **鸣潮游戏战绩端点**:
  - `POST https://api.kurobbs.com/gamer/role/box/getData`
  - Body: `{"gameId": 3, "roleId": "{roleId}", "serverId": "{serverId}"}`
  - 获取体力（结晶波片）、活跃度、深坠异想奇境、全息战略数据。

---

## 三、 轨道 B：原生独立去云崽网关协议适配规范 (`gateway-standalone`)

在完全脱离 Yunzai 的纯净模式下，`gateway-standalone` 作为轻量 Node.js 守护进程，直接处理三大主流协议：

### 3.1 NapCat (OneBotv11) 反向 WebSocket 协议
- **工作机制**: 由 NapCat (QQ NT客户端) 主动发起连接至 Game-Hub 网关端口（如 `ws://127.0.0.1:8080/onebot/v11/ws`）。
- **心跳保活与状态确认**:
  - NapCat 每 5 秒推送 `meta_event_type: "heartbeat"`；
  - Game-Hub 检测到心跳即更新通道存活状态。
- **消息事件处理**:
  - 监听 `post_type: "message"`；
  - 提取 `message` 数组（标准 CQ 消息段，如 `[{type: "text", data: {text: "*便签"}}]`）；
  - 提取 `user_id` -> 包装为 `unifiedUserId = "qq:" + user_id`；
  - 回复消息：通过当前 WebSocket 发送 `{"action": "send_msg", "params": {...}}`，支持文本与 base64 图片直发。

### 3.2 Telegram Bot API 协议
- **工作机制**: 支持两种模式（本地开发使用 `getUpdates` 长轮询；公网生产使用 `setWebhook` 接收推送）。
- **消息归一化**:
  - 提取 `message.text`；
  - 自动剥离群聊中的 `@bot_username`，修复云崽生态中 TG 判定缺失的缺陷；
  - 提取 `from.id` -> 包装为 `unifiedUserId = "tg:" + from.id`；
- **自适应渲染输出**:
  - 对文本类回复（如便签、兑换码）：直接调用 `sendMessage`，启用 `parse_mode: "MarkdownV2"`，原生长文本渲染，**无需截图**；
  - 对图表类回复（如角色面板）：调用 `sendPhoto` 发送独立 Puppeteer 渲染的 PNG Buffer。

### 3.3 腾讯官方 QQBot 开放平台协议
- **工作机制**: 建立 WSS 长连接至腾讯网关接收 `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE`。
- **消息归一化**:
  - 提取 `author.user_openid` -> 包装为 `unifiedUserId = "qqbot:" + openid`；
- **平台合规与限制对齐**:
  - 严禁包含外部链接，避免触发二维码切片风控；
  - 被动消息在 5 轮内完成；
  - 支持直接下发 Markdown 模板或经独立 Puppeteer 渲染生成的直连图片 URL。

---

## 四、 架构完备性审查总结

至此，新项目所需的所有技术细节已全部形成权威文档，涵盖：
1. **架构与演进总纲** (`ZZZ_BOT_GAME_HUB_MONOREPO_SPECIFICATION.md`)
2. **Monorepo 脚手架与包契约** (`GAME_HUB_MONOREPO_SCAFFOLD_BLUEPRINT.md`)
3. **数据迁移与纯业务 Handler 重构指南** (`GAME_HUB_DATA_MIGRATION_AND_EXTRACTION_GUIDE.md`)
4. **底层 API 签名与原生网关协议规格** (`GAME_HUB_COMMUNITY_API_AND_GATEWAY_PROTOCOL_SPEC.md`)

新仓库一旦建立，便可直接按图索骥进行初始化与分包开发，不再有任何架构模糊或需求真空！
