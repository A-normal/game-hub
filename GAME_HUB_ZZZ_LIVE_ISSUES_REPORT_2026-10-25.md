# Game-Hub / 绝区零插件：线上四问题调查与处置建议

> 本文前十节为较早调查和实施记录。后续部署与接口状态已变化，请同时阅读末尾“第十一节”，勿把旧维护状态或设备归因当作当前已验证结论。

- 生成时间：2026-10-25 19:18:19 +08:00（UTC 2026-10-25T11:18:19Z）
- 调查对象：`gamehub-service`（镜像 `game-hub:latest`，容器运行于 2026-10-25 18:38 启动）＋ QQ 渠道 `napcat-service`
- 调查方式：只读线上实测（容器内 vault 副本 + 真实米游社请求）、源码核对、历史版本对照
- 结论性质：本文是调查与方案文档，本轮**未修改任何运行代码**、未重启容器、未写生产库

## 一、任务目标

针对四项反馈给出可验证的结论与处置方案：

1. `gh` / `zzz` 指令集前缀冗余、命名空间重划分受限。
2. 「全部涉及 API 的指令都失败」（展柜、面板、月报等），需要区分是代码缺陷、网络问题还是设备风控。
3. 最近一次重构后纯字符回复的排版丢失。
4. QQ 渠道不支持「文字+文件」，导致「导入抽卡记录」事实上不可用。

## 二、调查基线与证据来源

- 线上代码与工作区**完全一致**：对 `handlers/note.mjs`、`handlers/records.mjs`、`handlers/help.mjs`、`core/dispatcher/dispatcher.mjs`、`provider/mihoyo/src/client.mjs` 逐个比对 SHA-256，5/5 与容器内 `/app` 文件一致 → 下文源码结论即线上行为。
- 线上日志（18:38–19:11）：扫码绑定成功（角色数 1）后，`zzz:note`、`zzz:panelRefresh`、`zzz:gachaImport`、`zzz:showcase` 全部落入 `Dispatcher｜路由失败`。
- 线上账号：`qq-napcat:1848296863` → 米游社 UID `17708598`（`prod_gf_cn`，修仙者一号，Lv.56）。
- 巡检工具：`tools/diagnose-zzz-api.mjs`（本轮新增，只读、不打印凭据值），可在容器内复现下表。

## 三、结论一：前缀冗余来自「提示层」而非「路由层」

### 现状实测

| 项 | 线上持久化值 |
| --- | --- |
| `namespace:zzz` | `{"prefix":"%","aliases":["zzz","绝"],"priority":100}` |
| `namespace:system` | `{"prefix":"/","aliases":["gh"],"priority":999}` |

`core/dispatcher/dispatcher.mjs:142` 的 `commandPrefix()` 只要插件有别名就**无条件**返回 `前缀+首个别名`，`formatCommand()`（`:149`）再用它拼词元。因此：

- 用同一份配置渲染 zzz 的 68 条命令，输出是清一色 `%zzz帮助 | %zzz扫码登录 | %zzz便签 | %zzz更新面板 | …`；
- 总线命令渲染成 `/gh帮助`、`/gh命名空间 <插件ID> <前缀或空字符串> <别名列表>`。

### 关键事实

- **路由层其实早就支持「只写前缀」**：`dispatcher.mjs:177` 命中 prefix 即算候选，`:183` 只在 `requireAlias` 为真时才要求显式别名。也就是说 `%便签`、`%更新面板` 现在就能正常路由，只有**提示文案**在多加一层 `zzz`。
- 因此「不需要 gh/zzz 前缀」这件事不需要重划分命名空间，也不需要动路由解析，改的是 `formatCommand` 的输出策略（这正是 README「所有提示由统一命令格式化服务在发送时生成」这条契约的落点）。
- 「重划分命名空间不允许重复」：`setNamespace()`（`:131`）要求 3 个参数（插件ID、前缀、别名列表），且 `checkNamespaceConflicts()`（`:120`）会把**别名**与其它插件逐一比对、硬拒绝重名；前缀重复只是 warning。所以想把 zzz 的别名去掉或与他人共用时会直接被拒，且没有「只给前缀」的两参用法。
- 兼容性注意：`tests/zzz-text.test.mjs:94` 断言定时通知里出现 `%new签到状态`，该断言固化了「前缀+别名」的旧形态，改格式时必须同步改为 `%签到状态`。

### 建议

1. `formatCommand()` 改为输出**最短无歧义形态**：`prefix + token`；仅当 `requireAlias`、或该前缀被多个插件共享、或词元与其它插件冲突时，才退化为 `prefix + alias + 空格 + token`。别名继续作为被接受的兼容入口，只是不再出现在提示里。
2. 帮助按类别分组、附参数提示、超过 N 行分页，替代当前 68 行平铺。
3. `命名空间` 命令支持两参（仅改前缀）与 `别名` 显式清空，错误信息点名冲突的插件与别名，而不是笼统的「更新被拒绝」。

## 四、结论二：不是全线 API 故障，而是「特定接口族被米游社按设备/账号拦截（10041）」

### 指令级实测矩阵（真实账号、真实 Cookie、真实 DS，2026-10-25 19:0x）

| 业务 | 接口 | 结果 |
| --- | --- | --- |
| 式舆防卫战 | `hadal_info_v2` | ✅ retcode 0 |
| 危局强袭战 | `hadal_mem_detail_v2` | ✅ retcode 0 |
| 全息拟境 | `holo_boss_detail` | ✅ retcode 0 |
| 鏖战试炼 | `climbing_tower_detail` | ✅ retcode 0 |
| 临界推演 | `void_front_battle_period_detail` | ✅ retcode 0 |
| 零号空洞 / 枯萎之都 / 迷失之地 | `abyss_abstract` / `abyss_detail` / `abysss2_abstract` | ✅ retcode 0 |
| 绝境作战 / 详情 | `zenkov_abstract_info` / `zenkov_detail` | ✅ retcode 0 |
| 邦布列表 | `buddy/info` | ✅ retcode 0 |
| 活动日历 | `activity_calendar` | ✅ retcode 0 |
| 当前卡池 | `gacha_calendar` | ✅ retcode 0 |
| 签到状态 | `/event/luna/zzz/info` | ✅ retcode 0 |
| 调频授权 | `genAuthKey` | ✅ 返回 authkey |
| 角色绑定查询 | `getUserGameRolesByCookie` | ✅ retcode 0 |
| **直播便签** | `note` | ❌ **10041** |
| **代理人列表 / 面板详情** | `avatar/basic`、`avatar/info` | ❌ **10041** |
| **绳网资料** | `index` | ❌ **10041** |
| **探索** | `exploration_detail` | ❌ **10041** |
| **月报** | `nap_ledger/month_info` | ❌ **10041** |
| 临界总览 | `void_front_battle_abstract_info` | ❌ **HTTP 404**（接口不存在，见结论五） |
| 公开展柜 | Enka `api/zzz/uid/<uid>` | ❌ **HTTP 424**「game servers are under maintenance」（Enka 侧，任意 UID 都一样） |

失败集合恰好就是用户报告的「展柜、面板、月报 + 便签/资料」——即**个人数据类**接口；战绩类接口基本全通。

### 排除项（已实测）

| 假设 | 实验 | 结果 |
| --- | --- | --- |
| DS 签名错 | 同一客户端 12 个接口返回 0 | 排除 |
| Cookie 失效 | 无 Cookie 时报 `-100 请先登录`；带 Cookie 报 10041 | 排除（账号被识别） |
| 参数名错 | 改 `uid/region` → `-400005`；加 `schedule_type`、`game_biz`、`x-rpc-signgame`、去 `lang` | 均不改变 10041 |
| 客户端版本/类型 | `x-rpc-app_version` 2.104.0、`x-rpc-client_type` 2 | 均不改变 10041 |
| 设备指纹未带 | 补随机 `x-rpc-device_fp`(13) + `device_name` + `device_model` | 仍 10041（随机指纹无效） |
| 凭据等级不足 | 用已存 stoken 成功换出 `ltoken`+`ltuid`+`cookie_token`，再重试 | **仍 10041**（排除「缺 ltoken」这一项） |
| 网络/出网故障 | 同一容器到米游社、Enka 均可建立 HTTPS | 排除 |

### 判断

结合上游同族项目的自述（ZZZ-Plugin 帮助原文：「绑定设备：用于尝试解决 10041 报错等问题（无法 100% 解决）」），可以判定：**10041 是米游社对这批「个人数据」接口的设备/新设备验证结果，属于账号+设备环境维度的服务端拦截，不是本仓库的协议或网络缺陷。**

同时本仓库当前**设备环境本身是不自洽的**，这恰好是最常见的 10041 触发条件：

- 扫码登录（`handlers/login-qr.mjs:148,201`）每次现场随机生成 `device_id`，并在 passport 请求里塞一个**临时随机** `x-rpc-device_fp`，两个值都没有回写；
- 落库的设备只有 `{device_id}`（实测 `device 键: device_id`），后续所有业务请求**不带** `x-rpc-device_fp`（`client.mjs:50` 仅在存在时附加）；
- 「默认设备/重置设备」（`handlers/role.mjs:25-33`）生成的是随机十六进制指纹，不可能与账号侧已登记的真实设备匹配。

结论：要真正解 10041，只能用**该账号真实设备的 `device_id` + `device_fp`**（用户自己从官方客户端抓取）绑定后重试；随机生成或补 v2 凭据都无效。这一点必须在真机上验证，本轮无法代替。

## 五、结论三 & 附带发现的真实缺陷

| # | 缺陷 | 位置 | 影响 |
| --- | --- | --- | --- |
| 1 | 「临界总览」调用了不存在的接口 `void_front_battle_abstract_info`（实测 404，另有 5 个候选路径同样 404） | `provider/mihoyo/src/client.mjs:13` | 该指令 100% 失败，且不是风控 |
| 2 | 路由失败日志只记「路由失败: zzz:note」，丢弃 `retcode` 与原因 | `core/dispatcher/dispatcher.mjs:218-220` | 线上排障必须像本次一样写探针脚本才能定位 |
| 3 | `voidOverview` 与 `void` 共用 `uid` 身份但缺 `schedule_type` 时返回 `-400005` | 同上 | 参数组合脆弱 |
| 4 | `getDs1` 实际生成 **DS2**（默认 generation 2），`getDs2` 反而生成 **DS1** | `provider/mihoyo/src/signer.mjs:18-19` | 导出给外部/未来调用者是语义陷阱 |
| 5 | 10041 统一文案为「社区接口拒绝请求（代码 10041）」 | `client.mjs:72` | 用户不知道要做什么，「绑定设备」无从发现 |
| 6 | Enka 返回 424 时文案为「公开展柜请求失败（HTTP 424）」 | `handlers/panel.mjs:46` | 服务维护期应明确提示而非报错 |
| 7 | 扫码握手中途产生的 `aliyungf_tc` 等 WAF Cookie 被整包持久化 | `login-qr.mjs:284` | 无害但属于噪声凭据，可白名单化 |

## 六、结论四：排版确实回退，回退点在「重写为扁平 dataLines 的那些 handler」

对照证据：同一文件在上一版本是带标题框、分隔线与人类可读时间的排版，重写后被压成一行行 `键: 值`；`handlers/note.mjs` 已在未提交修改里被补回（约 +134 行，现为进度条 + 分隔线 + 中文时长），说明方向已被认可，但**其余 handler 尚未跟进**：

- `handlers/help.mjs`：68 行平铺、无分组、无参数提示、且每条都带 `%zzz`；
- `handlers/records.mjs`：资料/战绩/月报基本是 `dataLines()` 原始字段直出，字段名与取值不排版、无对齐、无分区间隔；
- `handlers/gacha.mjs:38-46`：抽卡分析把多池统计塞进单行分号串；
- `handlers/sign.mjs`、`handlers/content.mjs`、`handlers/bind.mjs`：单段一句话，缺少标题/下一步提示的层次；
- 中英混排无宽度对齐，长列表无分页脚注（仅部分有）。

### 建议

抽一层 `packages/plugin/zzz/src/layout.mjs`（纯文本）：`section(title)`、`divider()`、`kv(pairs,{align:true})`、`bar(cur,max)`、`list(items,{numbered})`、`footer(next)`，宽度按东亚字符宽度计算；各 handler 统一改用该层。以现行 `note.mjs` 的成稿风格为基准，不复制旧版图片排版。

## 七、结论五：导入抽卡不可用是「输入通道」问题，不是解析问题

现状链路：`导入抽卡` → `handlers/gacha.mjs:24-27` 取 `ctx.args.join(" ")` 当 JSON 文本 → 5 MB 上限 → `importGacha()` 解析入库。

三个硬约束导致事实不可用：

1. UIGF 导出体积远超 QQ 单条文本消息上限，粘贴不可行；
2. `core/shaper/inbound-shaper.mjs` 只解析 `image` 段（`:56-62`），**没有 `file` 段**，用户发文件拿不到内容；
3. `channel/napcat/src/server.mjs:232` 的出站消息只拼 `text` 段，无法「文字+文件」；导出（`gacha.mjs:34`）在 >50000 字符时也直接报错。

### 方案（按改动量排序）

| 方案 | 做法 | 改动面 | 备注 |
| --- | --- | --- | --- |
| **A. 直链导入（推荐先做）** | `导入抽卡 <https 直链>`，复用 `public-data.mjs` 的 `fetchPublicJson()`（已有大小上限、协议校验） | 仅插件 + 一处 URL 校验 | 不需要渠道支持，用户把 JSON 放任意可直链位置即可 |
| **B. 两段式文件导入（体验最好）** | `导入抽卡` → 进入「等待文件」会话 → 用户**单独一条**消息发文件 → 渠道用 `get_file`/`get_private_file_download` 取回内容 → 完成导入 | channel + shaper + 插件会话状态 | 完全绕开「文字+文件」限制；需要会话超时与并发保护 |
| **C. 服务器侧迁移 CLI（零改动）** | 一次性历史迁移用 `tools/import-gacha.mjs <JSON> <统一用户ID> <UID>` | 无 | 已实现，适合自己动手迁移 |
| **D. 导出配套** | 导出改为「生成文件后单独发送文件」，或分页文本 + 直链 | channel 出站 | 否则导出同样不可用 |

建议本轮 A + C，B 留作后续（需要渠道新增文件下载能力，属于渠道契约变更）。

## 八、建议的处置顺序（待确认后执行）

1. **P0 修复**：`voidOverview` 404（改为用 `void`/`hollow` 数据聚合，或下线该路由）、`dispatcher` 记录真实错误码、10041/424 换成可操作文案。
2. **P1 指令层**：`formatCommand` 最短形态 + 帮助分组分页 + `命名空间` 两参用法。
3. **P1 排版**：新增 `layout.mjs` 并改造 records/gacha/sign/content/help。
4. **P1 导入**：A（直链导入）+ 导出配套。
5. **P2 10041**：设备环境自洽化（登录即生成并持久化稳定的 `device_id`/`device_fp`、全链路统一发送）＋「绑定真实设备」指令；最终验证需要用户提供真机 `device_id`/`device_fp` 或授权采集。
6. **验收**：`node tests/*.test.mjs` 全绿 → 重新构建镜像 → 容器内重跑 `tools/diagnose-zzz-api.mjs` → 真实 QQ 端逐条验证。

## 九、验证边界与未决项

- 10041 的设备归因只能做到「排除其它可能 + 上游同族佐证」，**未能用真实设备指纹复现成功**；不宣称已定位到可修复的单一代码缺陷。
- Enka 424 是对方维护状态（任意 UID 均 424），本轮无法验证展柜正确性；恢复后需重测 `面板 <UID>` / `更新展柜面板`。
- 本轮未部署、未重启容器、未写入生产库；仅新增只读工具 `tools/diagnose-zzz-api.mjs`。
- 待确认：命名空间目标形态（`%便签` 还是裸 `便签`）、导入方案取舍、以及是否授权按上述顺序实施并部署实测。

## 十、本轮实施记录（P0 + P1，未部署）

用户决策：命名空间取「`%便签`」形态；导入只保留服务器 CLI；本轮只做 P0+P1 代码改动，**不部署**。

### 语义修正（用户 2026-10-25 第二轮反馈）

用户明确：命名空间 `% zzz zzz,绝,绝区零` 的含义是 **`%帮助` = `zzz帮助` = `绝帮助` = `绝区零帮助`**，前缀与别名是等价且独立的调用标记；上一版实现的「前缀 + 别名」拼接属于多余的兼容语法，已废弃。

- `resolveNamespaceCandidates()` 改为：对「前缀 ∪ 别名」的标记集合逐个匹配（最长优先），命中后紧跟的内容才是词元；`%zzz便签` 不再被解析成便签。
- `formatCommand()` 只渲染主前缀：`%便签`；标记与词元两侧都是拉丁字母数字时才补空格（`bus help`），中文直接相粘（`zzz便签`）。
- 冲突检查改为标记语义：别名与其它插件的任一标记重叠 → 硬冲突；仅前缀共享 → 警告，由优先级消歧。
- system 默认命名空间补 `#gh` 显式别名，`#gh 认证`、`/gh 帮助`、`gh 帮助`、`#帮助` 全部是独立标记，不再依赖拼接。
- 新增回归测试：`tests/platform-contract.test.mjs`「prefix and every alias are equivalent independent command markers」。

### 设备环境修正（同轮）

- 扫码登录生成一次 `device_fp`（13 位十六进制）并与 `device_id` 一起落库，passport 与后续业务请求共用同一设备环境（此前每个请求都是新设备身份或完全不带指纹）。
- 重复扫码**保留**已绑定的设备环境（尤其是用户手填的真机指纹），不再被本次随机值覆盖。
- 重复扫码**保留**用户手动选过的主角色；仅当该角色不属于本次登录时才回落到最高等级角色。
- `绑定设备 <device_id> [device_fp]` 改为合并保存（只改给出的字段），不再把已有指纹抹掉；无参数时展示当前设备状态（掩码）。
- `默认设备/重置设备` 只补缺失字段、绝不覆盖已有真机指纹，并提示随机指纹过不了米游社设备校验。

### 已改动

| 项 | 文件 | 改动 |
| --- | --- | --- |
| 指令前缀 | `packages/core/src/dispatcher/dispatcher.mjs` | 前缀与别名等价且独立（`%帮助` = `zzz帮助` = `绝帮助`）；`formatCommand()` 只渲染主前缀，不拼接 `%zzz帮助` |
| 总线命名 | 同上 | system 默认命名空间补 `#gh` 显式别名并去掉 `requireAlias`；`#帮助`、`#gh 认证`、`gh 帮助`、`/gh 帮助` 等价 |
| 命名空间命令 | 同上 | 支持「只改前缀」两参用法；明确提示留空别名；拒绝时给出具体冲突插件，成功后回显新前缀与示例 |
| 排障日志 | 同上 | 失败日志写入 `code`/`retcode`/脱敏后的原因，不再只有「路由失败: id:route」 |
| 临界总览 404 | `provider/mihoyo/src/client.mjs`、`plugin/zzz/src/manifest.mjs`、`handlers/records.mjs` | 删除不存在的 `void_front_battle_abstract_info`，`临界总览` 并入真实的 `void` 接口 |
| 10041 文案 | `provider/mihoyo/src/client.mjs` | 改为「要求设备校验（10041）」并给出「新设备验证」指引 |
| Enka 维护文案 | `handlers/panel.mjs` | HTTP 424 明确为公开展柜服务维护，不再表现为普通失败 |
| 帮助 | `handlers/help.mjs` | 8 个分组 + 每页 14 条分页（`%帮助 2`），去掉每条重复的插件名 |
| 排版 | 新增 `plugin/zzz/src/layout.mjs`；改造 `records/gacha/sign/role/bind/note/content` | 统一标题、分区线、键值对齐、进度条、分页脚注；`text.mjs` 拆出 `dataEntries()` 供对齐使用 |
| 导入 | `handlers/gacha.mjs`、`manifest.mjs` | 聊天内不再解析 JSON，改为输出服务器 CLI 用法（含当前聊天用户 ID） |
| 文档 | `README.md`、`docs/plugin-development.md` | 补「提示输出最短可用形态，别名仅作兼容入口」 |

### 验证结果

- `node tests/*.test.mjs` 逐文件运行：**9 个文件全绿**（platform-contract 8/8、provider-contract 7/7、mihoyo-client 5/5、vault 4/4、vertical-slice 3/3、zzz-qr-login 42/42、zzz-text 12/12、zzz-skin-and-security 5/5、zzz-calculation 6/6）。
- `feature-expansion.test.mjs` 剩 1 项失败：帮助里出现「换装/原图」，与 README「不实现面板图片、原图、换装图片」冲突。该冲突由工作区既有未提交代码（`handlers/skin.mjs`、manifest 的两条路由、`tests/zzz-skin-and-security.test.mjs`）引入，**早于本轮**，需用户裁定保留还是移除，本轮未擅自改动。
- 顺带修好 3 处既有测试/实现不一致：`settings.mjs` 缓存清理文案多出空格；`vault.test.mjs` 与 `zzz-qr-login.test.mjs` 仍按「凭据明文落库」断言，已改为校验密文落库 + 公开读取路径还原。
- 未部署、未重启容器；线上仍是本轮前的代码。

### 复现方式（部署后）

```powershell
docker cp tools/diagnose-zzz-api.mjs gamehub-service:/tmp/diagnose-zzz-api.mjs
docker exec -e DIAG_USER=qq-napcat:<QQ号> gamehub-service node /tmp/diagnose-zzz-api.mjs
```

上述诊断使用工具当前的只读 Vault；不能在写入期间仅复制主 DB 而遗漏 WAL。停止状态下读取完整数据目录，或采用 SQLite 在线备份；Docker Desktop 报告的挂载路径不保证与新容器绑定同名宿主路径得到相同数据视图。


## 十一、当前复核与修复（2026-10-25 20:32，未部署本轮代码）

当前用户要求核对其他工具完成后的代码与线上 bug，并直接修复。保留既有有效修改，不启动后台进程、不重启容器、不写生产库。

### 刷新的线上证据

只读容器日志显示 19:59 扫码绑定已成功；后续便签与面板返回 10041。进一步以 SQLite `readOnly:true` 读取当前账号，仅输出结果码，实际只读请求得到：

| 接口 | 本次结果 |
| --- | --- |
| note | API retcode 10041 |
| shiyu | 成功，返回 hadal_info_v2 |
| Cookie 自动调频第一页 | 成功，返回 list |
| Enka 公开展柜 | HTTP 403 |

因此不能称“全部 API 都失败”，也不能把 Enka 固定解释为维护。旧报告“只能用真实设备解决”的断言超过证据：设备链路存在缺陷，但没有成功对照实验能证明修正设备必然消除 10041。部分接口成功同样不足以证明所有接口族的鉴权参数完全正确。此项保留为官方设备/账号校验或接口鉴权约束尚待验证，不做反复自动重试。

### 本轮代码修复

- 纯文本目标：移除换装/原图路由、实现、面板 CQ 图片输出和皮肤存储方法。保留渠道通用附件整形与认证二维码；不删除线上曾建的旧表或资料。
- 设备作用域：扫码根据本次确认的通行证查设备，而非拿当前主角色的其它账号设备；手动重新绑定也复用该账号设备并保留角色选择。登录请求禁止跨域重定向，凭据交换与角色查询使用选定设备。
- 私密操作：群聊不能发起/取消扫码、删除/生成/修改设备；设备帮助给出实时命令。10041 文案提供当前命名空间下的设备入口，并说明不能保证解除校验。
- 动态命令：帮助不再嵌入固定 `%便签 = zzz便签` 示例；支持显式空别名；共享前缀时提示选择确实能到达目标路由的独立标记；禁用插件的别名也不进入 AI 兜底。
- 协议与错误：修正 DS1/DS2 命名导出与协议相反的问题；Enka 403/404/424/429 分别提示；不把公开服务错误当作登录失败。
- 数据与日志：解密校验失败立即停止，不把密文当裸 Cookie 发出；结构化附加日志和 Error 堆栈同样脱敏；支持仅提供 OneBot 文本段的事件。
- 群排名：新增周期表，校验官方截止时间、分区服展示、过滤过期及历史周期；旧无周期数据不参与新榜单。群关闭后仍可撤回授权。
- 诊断工具：真正只读打开 SQLite，不初始化或迁移，不猜测/打印其它账号，不输出 Enka 原始响应正文。

### 验证与剩余边界

完整测试 108/108，通过；42 个 JavaScript 源模块语法检查通过；MIT vendoring 的 1224 个源码文件及 bundle 校验通过。修复没有部署，真实 QQ 对修复后的人工验收尚未执行；不能宣称 10041 已解除。

另记录现有加密实现的限制：缺少独立 `VAULT_SECRET` 时仍使用历史固定回退密钥，不能视为有效静态保密保护；本轮没有擅自轮换生产密钥或重写已有凭据。详见 docs/operations.md。


### 十二、用户补充后的设备链路核查（20:49）

用户确认：手机官方页面正常、没有验证提示；没有绑定过真实手机设备，仅扫码登录。完整请求头对照仍为 10041。官方公开指纹接口已验证：正确的 10 位网页种子可得到内层 `data.code=200` 的正式指纹；外层 `retcode=0`、内层 `code=403` 时仍带回退值，不能误判成功。

本轮新增 provider 的官方指纹签发服务；扫码在生成授权二维码之前获取正式指纹，失败不保存随机值；正常重登保留已有设备，显式 `扫码登录 重建设备` 才更新旧环境。`默认设备 刷新指纹` 可显式刷新，手动绑定的真机字段仍受保护。源码独立实现，没有复制 AGPL 源码，也不导入旧宿主。

但是：在内存中用正式指纹搭配现存 Cookie，便签、代理人、月报仍为 10041。因此本轮修复了可证实的设备协议错误，**没有证明 10041 已解除**；新指纹从扫码前一直参与新授权的完整链路仍待部署后真机验证。本轮未部署、未重启、未写生产库，也没有调用账号的设备登录或设备保存接口。

最终完整自动化套件为 114/114；状态保留为线上验收待完成。当前代码符合已确认的平台布局及纯文本方向，不能据此宣称全部外部服务已经可用。


## 十三、完整重新授权后仍失败：MysApi 差异复核

用户已部署并按前述操作重试；21:42 扫码绑定成功后 note 仍返回 10041。本轮线上验收明确为 VERIFICATION_FAILED，取代“尚未重扫”的旧恢复点。

最新只读实验使用该次绑定，同一 Cookie/设备下的当前请求、genshin 请求形态、ZZZ 封装请求形态均返回 10041。官方成功兑换的真实 LToken、补 stuid 以及旧自有补丁字段排列的内存对照也全部返回 10041；没有写回任何实验凭据。外层 API 结果没有提供可用 challenge 数据。

差异确实存在：核心 DS 公式及盐相同，但本仓库使用通用 UA 和网页设备指纹；上游 ZZZ 使用移动客户端设备配置，并能将 10041/1034/10035 交给外部 mys.req.err 处理器。genshin 基类不是自动解除校验的服务。仅照抄请求头、重复扫码或补 LToken 都不能据此保证修复。

需要进一步确认旧环境同账号是否能绕开缓存实时成功，再比较真实成功的设备与验证链。当前没有旧环境成功基线，不能把源码差异直接写成根因。保持不依赖旧宿主、不复制 AGPL 实现及不启动后台进程的边界。

参考源码：
- https://github.com/yoimiya-kokomi/Miao-Yunzai/blob/master/plugins/genshin/model/mys/mysApi.js
- https://github.com/ZZZure/ZZZ-Plugin/blob/master/dist/lib/mysapi.js

## 十四、Android 设备导入功能差异已补齐，10041 尚未解除（22:19）

用户确认官方页面使用 Android 手机；旧环境启动失败，无法取得成功基线。当前 Game-Hub 服务容器已停止，本轮没有启动它。后续诊断使用完整 SQLite/WAL 的只读内存副本，一次性前台容器已退出；没有写回生产库。

最小真实 LToken（有/无 DS）、Cookie Token、完整合成 Android 档案等对照仍为 10041。移动端 getFp 可以成功签发，但便签错误响应没有 challenge、AIGIS 或可用验证入口。因此不能认定缺某个请求头或更换 MysApi 就能修好，也没有依据接入第三方验证码服务。

已确认并补齐的功能缺口：上游支持导入手机导出的七字段 JSON，本仓库此前只有 ID/FP 文本。当前新增私聊 `绑定设备 <JSON>`，自行校验字段、沿用账号稳定 ID、申请移动端指纹、成功才保存；后续查询、刷新和正常重新扫码保持 Android 档案。失败保留旧设备；与重新登录、设备变更或解绑并发时避免覆盖状态。原 ID/FP 文本与对象格式保留。

设备元数据按现有 Vault 密钥机制加密，兼容旧明文读取；命令原文和设备字段日志脱敏。设备扩展 payload 仅移植许可明确的 MIT 纯函数，来源与模板局限见 [复用说明](docs/upstream-reuse.md)。没有引入旧宿主依赖或 AGPL 源码。

最新完整测试 **123/123**，50 个模块语法检查及 vendor hash 校验通过。当前整体线上验收仍为 **VERIFICATION_FAILED**，真实 Android 档案导入后的便签验收待执行。操作说明见 [Android 导入步骤](docs/operations.md#android-常用设备信息导入)；本轮未部署、未重启、未修改生产数据，也未启动后台进程。

## 十五、device_info 真机验收通过，保留双入口

2026-10-25 用户反馈：绑定 device_info 后查询正常，要求保留扫码与设备信息两种方式。此前第十四节的待验收/失败状态由此更新：当前账号的便签人工验收通过，扫码授权和 Android 设备导入继续保留。

现有实现中，扫码获取账号凭据，device_info 补充该账号的常用设备环境；设备信息本身不包含独立账号凭据。正常重新扫码复用设备，仅显式重建才清除。10041 引导已改为私聊导入手机 JSON，并提示保留已有设备，避免引导用户反复重建。

依据用户成功对照，可以归为当前账号的设备环境相关校验；并未取得服务端完整风控规则。该成功不自动覆盖其他账号、其他接口或 Enka 服务。未启动后台进程、部署、重启或修改生产数据。
