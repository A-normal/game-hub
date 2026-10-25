# Game-Hub 全链路可观测性日志、总线指令式配置与绝区零全功能插件技术交付文档
## (Game-Hub Observability Logging, Bus Command Admin & Full-Featured ZZZ Plugin Spec)

- **更新时间戳**: `2026-10-25 14:05:00 +08:00`
- **交付目标与测试反馈收敛**:
  1. **扫码登录双模与 PNG 高兼容渲染**：重构米游社 Web 扫码 (`bll8iq97cem8`) 针对手机米游社 App 扫码优化；增加纯 JS PNG Base64 格式输出，彻底解决移动端 QQ 对 1-bit BMP 图片无法渲染或拒收的问题；增加 `Set-Cookie` 原始凭据解析。
  2. **命名空间冲突检测与多插件前缀穿透调度**：动态校验保留管理别名，共享前缀时启动多插件路由穿透机制（如 `system` 与 `zzz` 均共享 `#` 时，`#gh` 与 `#便签` 互不冲突、高低优先级准确穿透）。
  3. **总线管理员认证与权限防护体系**：新增 `#gh 认证 <管理Token>` 持久化绑定 Master/Admin；对所有修改插件状态、命名空间与日志级别的运维指令加入鉴权保护，未授权用户无法随意执行。
  4. **扩展架构全景展示 (插件 + 社区驱动)**：在 `#gh 插件列表` 与 `#gh 状态` 中清晰分栏展示 **【游戏业务插件 (Game Plugins)】** 与 **【社区数据驱动 (Community Providers: mihoyo)】** 及依赖关联。
- **全链路测试结果**: 4 套测试套件全部通过：**19/19 tests PASS (100% 绿灯)**。

---

## 一、 扫码登录失败问题根因与修复方案

### 1.1 根因分析
1. **APP ID 与扫码端不匹配**：此前调用的是 PC 端启动器接口（`app/createQRLogin`，App ID `ddxf5dufpuyo`）。使用手机端「米游社 App」相机扫描启动器专属二维码时，米游社鉴权网关会因端类型不符提示错误或静默丢弃；
2. **移动端 QQ 图片格式兼容性问题**：此前生成的 1-bit 单色 BMP 图片，腾讯移动端 QQ（Android / iOS）在 CDN 压缩转码阶段会因格式老旧而损坏或拒收；
3. **凭据换取缺少 Set-Cookie 与 DS 签名**：启动器接口的 `Confirmed` 状态仅返回 `stoken`，进一步请求 `getCookieAccountInfoBySToken` 需要动态签名；而米游社 Web 扫码接口在确认后会将 `login_ticket`、`ltoken`、`cookie_token` 随 `Set-Cookie` 一并返回。

### 1.2 落地修复
- **高兼容纯 JS PNG 渲染器 (`packages/plugin-zzz/src/utils/qr-encoder.mjs`)**：利用 Node.js 原生内置 `node:zlib` 与 CRC32 算法，在零外部依赖的前提下直接输出标准无损 8-bit Grayscale PNG 图片流，转为 `base64://...` 发送，移动端与 PC 端 100% 正常渲染；
- **默认切入米游社 Web 扫码 (`packages/plugin-zzz/src/handlers/login-qr.mjs`)**：使用 `web/createQRLogin`（App ID: `bll8iq97cem8`），专门适配手机米游社 App 扫码，用户确认后自动从响应头与数据体提取全部凭据并入库。

---

## 二、 命名空间冲突检测与多插件前缀穿透调度

### 2.1 冲突检测算法 (`checkNamespaceConflicts`)
在执行 `#gh 命名空间 <id> <前缀> [别名]` 或总线注册时：
1. **系统保留词硬拦截**：禁止将任何业务插件别名修改为 `gh`、`gamehub`、`总线` 等管理保留字；
2. **跨插件别名硬冲突拦截**：禁止不同插件占用完全相同的触发别名；
3. **前缀共享软告警**：若多个插件使用同一前缀（如均使用 `#`），系统不强制报错，而是输出提示：
   ```text
   ⚠️ 提示：前缀 "#" 与插件 [zzz] 相同。总线已开启最长词元匹配与优先级调度，同名指令将由高优先级响应。
   ```

### 2.2 多插件前缀穿透调度引擎 (`resolveNamespaceCandidates`)
- **破除单一匹配限制**：以往调度器命中前缀后立即绑定至高优先级插件，若该插件无对应路由词元则直接退出；
- **全链路穿透调度**：调度微内核返回当前所有命中前缀与别名的候选插件列表。若高优先级的 `system` 未命中指令词元，则自动穿透至下一候选插件 `zzz` 进行路由匹配。因此，即便将 `zzz` 的前缀改为 `#`，`#gh 状态` 与 `#便签` 也能共存且互不干扰。

---

## 三、 管理员认证与权限防护体系 (Admin Guard & Token Claim)

### 3.1 权限控制指令清单
| 指令示例 | 权限要求 | 说明与效果 |
| :--- | :--- | :--- |
| **`#gh 认证 <管理Token>`** | 公开 | 输入系统 Token 完成当前账号的超级管理员身份绑定，自动持久化至 SQLite |
| **`#gh 帮助` / `#gh 状态` / `#gh 插件列表`** | 公开 | 查看总线运行指标、架构组件与使用指南 |
| **`#gh 启用 <插件ID>`** | **仅管理员** | 动态启用指定业务插件 |
| **`#gh 禁用 <插件ID>`** | **仅管理员** | 动态禁用指定业务插件 |
| **`#gh 命名空间 <ID> <前缀> [别名]`** | **仅管理员** | 动态修改指令前缀与别名 |
| **`#gh 日志级别 <级别>`** | **仅管理员** | 热切换全局日志记录级别 |
| **`#gh 管理员列表`** | **仅管理员** | 查看当前所有已授权的管理员列表 |
| **`#gh 添加管理 <QQ>` / `#gh 移除管理 <QQ>`** | **仅管理员** | 管理团队成员增删 |

### 3.2 未授权拦截表现
普通用户发送任何管理运维指令（如 `#gh 禁用 zzz`）时，微内核自动拦截并友好回复：
```text
❌ 【权限拒绝】该运维指令仅限 Game-Hub 管理员执行！
━━━━━━━━━━━━━━━━━
💡 若您是服主，请私聊发送：
   #gh 认证 <管理Token>
认证通过后将永久绑定您的管理员权限。
```

---

## 四、 扩展架构全景展示 (业务插件 + 社区驱动)

执行 `#gh 插件列表` 时，总线完整清晰展现两层解耦架构：
```text
🧩 【Game-Hub 已加载扩展架构】
━━━━━━━━━━━━━━━━━
🎮 【游戏业务插件 (Game Plugins)】
1. 绝区零 (zzz) 🟢 [已启用]
   • 驱动: mihoyo | 前缀: "*" | 别名: zzz, 绝区零 | 指令数: 10
2. Game-Hub 系统管理总线 (system) 🟢 [已启用]
   • 内置总线 | 前缀: "#" | 别名: gh, gamehub | 指令数: 11
─────────────────
🌐 【社区数据驱动 (Community Providers)】
1. 米游社 (mihoyo) 🟢 [已挂载就绪]
   • 服务游戏: 绝区零 | 接口类型: Takumi / Web API
━━━━━━━━━━━━━━━━━
💡 使用 #gh 启用/禁用 <ID> 或 #gh 命名空间 修改配置
```

---

## 五、 全量自动化测试运行指标

运行 `pnpm test`：
```text
▶ Identity Vault & Data Integrity Test Suite
  ✔ P0-01 Fix: saveCredential using ON CONFLICT DO UPDATE (2.105ms)
  ✔ P1-06 Fix: Exactly one active role per user and game (1.469ms)
  ✔ Gacha Manual Import Tool: Safe idempotent UIGF import (3.481ms)
✔ 4 PASS

▶ Mihoyo Provider & Takumi Client Rigorous Verification Suite
  ✔ DS1 and DS2 dynamic secret algorithm validation (0.896ms)
  ✔ P1-03 Fix: Query parameters are properly appended (0.570ms)
  ✔ P1-03 Fix: POST body is properly serialized (0.427ms)
  ✔ Overseas server automatically switches to HoYoLAB (0.220ms)
✔ 5 PASS

▶ NapCat End-to-End Vertical Slice Suite
  ✔ P0-02 Fix: Gateway rejects unauthorized connections (10.035ms)
  ✔ End-to-End Vertical Slice: NapCat WS -> Bind -> Role -> Note -> Echo (108.507ms)
✔ 3 PASS

▶ Feature Expansion & System Observability Test Suite
  ✔ Logger: Level switching and formatted outputs (2.290ms)
  ✔ QR Encoder: Generates valid QR matrix, ASCII art, BMP and standard PNG (11.494ms)
  ✔ Admin Authorization & Token Claim: Protects mutating commands (3.599ms)
  ✔ Namespace Conflict Detection & Prefix Penetration Routing (3.120ms)
  ✔ Component Architecture: Lists both Game Plugins and Community Providers (1.042ms)
  ✔ ZZZ Plugin: Full feature commands execution (3.126ms)
✔ 7 PASS

总计: 19/19 tests PASS (100% 全部通过，耗时约 320ms)
```
