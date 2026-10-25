# 纯文本功能补齐：准备与恢复记录

> This is a development workflow process record. It is not a customer requirement, product rule, acceptance authority, or source for deriving requirements. Follow the cited active requirement sources.

```yaml
artifact_type: dev-workflow-process-ledger
authority: process-record-only
is_requirement_source: false
project: game-hub
increment_id: zzz-text-parity-2026-10-25
workflow_run_id: zzz-text-parity-2026-10-25
risk_level: HIGH
status: EXECUTING
plan_version: 2
checkpoint_sequence: 5
created_at: 2026-10-25
updated_at: 2026-10-25
evidence_valid_as_of: 2026-10-25
```

## 当前用户要求与决定

- 本轮要求：图片先不做，尝试纯文本数据流，补齐功能；自定义行为参考 `../zzz-bot`，不引用其依赖；补充 README 的功能、目标、插件标准、来源与致谢。
- 用户已明确选择：“仅复制许可明确且宽松兼容的代码；AGPL 只参考功能”。
- 用户本次明确：chatAi 作为独立插件以后加入，本轮只定义路由与开发标准，不实现聊天或模型切换。
- 用户已明确批准：“迁移明确了，功能差异按照上一次的结论实行，我看着没什么问题了。”批准修订的架构迁移及纯文本功能合同，不再逐项重复确认。
- 保留既有“禁止开启后台进程”的规则；不部署、不重启容器、不写生产数据、不触发真实签到／推送或付费调用。

## 技术证据与复用决策

- 当前工作区保留此前扫码修复及更早未提交修改，未回滚或重写它们。
- 旧仓库只读检查：`plugins/example/zzzShortcuts.js`、`zzzSign.js`、`zzzAIChat.js`／辅助模块，`plugins/ZZZ-Plugin/apps/panel.js`、`poolHistory.js` 及相关测试。
- 已确认定制行为：快捷指令统一映射；登录后默认官方全角色、未登录走公开展柜；签到状态和主动开启／关闭自动签到；卡池历史查询合并输出、刷新及本地缓存。指定角色刷新按本轮补齐目标实施，不将旧实现未证明的能力当已完成。
- ZZZ-Plugin 锁定 `1a322076120b6148188bab154834ad19628c179c`，实际 LICENSE 为 AGPL-3.0；`dist/lib/mysapi.js` 继承旧宿主 `MysApi`。不复制。
- 新候选 UIGF-org/mihoyo-api-sdk 锁定 `7c3107f95b72e7324af966b2e8989eb8375e5fc7`，根 LICENSE 为 MIT（Copyright 2026 UIGF Organization）。检查了 DS 辅助实现、CN 绝区零接口定义及响应模型；独立签名部分适合选择性移植，完整生成客户端有不必要的 Azure 依赖。
- 纯文本历史接入 GachaClock 的 MIT JSON 数据源；核验提交 `b1c96688913f7b2865a415e24432d7f60ee6c3e0`，只保存文字字段与来源摘要，不下载图片；完整许可保留于 docs/sources/gachaclock.md。
- 为补齐角色专属计算，核验 frzyc/genshin-optimizer 根 LICENSE 为 MIT（Copyright 2020-present frzyc），固定 `2ce06b88a442531b49d84cbed15204a4a03d078a`。开始裁取纯计算、规则与数据的传递依赖，保留逐文件 SHA-256、源码和许可；只增加构建期 esbuild@0.28.2，不导入原项目应用、UI、服务或旧宿主。
- 协议与签名为本仓库独立实现；MIT 计算库正在裁取适配，不声称其为原创。没有新增运行依赖或改变仓库统一许可。

## 用户修订与架构核对

- README 应说明配置式插件平台的目标和开发约定，不在根文档枚举当前 ZZZ 的实现状态。
- 模块分类为 core / channel / provider / plugin；具体实现使用二级独立包。
- 用户自有本地仓库不是外部致谢对象，仅将面板等具体定制行为作为内部演进依据。
- 所有提示中的命令必须实时读取有效命名空间统一格式化，包括错误、帮助和任务通知；禁止固定前缀回退。
- 业务图片从范围中排除并应移除代码与入口；保留认证载体二维码。
- 抽卡的核心是更新命令自动同步，JSON 导入只是辅助。
- 代码核对：core 构造器硬编码 ZZZ 命名空间；manifest 要求 gameId 和单一 community；dispatcher 对每个插件提前查询游戏角色、忽略 action 的处理结果；app.mjs 固定导入和注册实现。仅挪目录不能消除这些限制。
- 修订路线：先通用模块标识、能力与配置装配、动态命令格式化和路由阶段；再同步迁移目录、workspace 与构建；最后补齐具体 ZZZ 功能。

## 已交付与验证

- `README.md`：已按最新要求重写为平台目标、四类包组织、配置装配、动态命名空间、路由与开发约定；删除 ZZZ 状态矩阵及本地仓库致谢。
- `docs/operations.md`：从根文档分离安装、Compose、备份回滚和现有运行事实，保留可用操作说明。
- `docs/plugin-development.md`：补充稳定 pluginId、零／多 provider 能力依赖、动态命令格式化和 NOT_MATCHED / HANDLED / FAILED / DENIED、chatAi 接入边界。
- `docs/upstream-reuse.md`：复制改造的许可、耦合、节省范围与维护成本。
- `docs/zzz-text-feature-plan.md`：REQ-01–08 / TASK-01–08 / AC-01–08 / VAL-01–08 的范围与验收映射。
- 文档检查通过：上述四份文档的本地 Markdown 链接有效，无尾随空白。
- 已迁移实际包、workspace 与容器复制路径；配置装配、无 gameId 插件、多 provider、延迟动态提示、路由隔离和共享账号主角色隔离的 6 项新增测试通过。
- 41 项扫码回归通过；provider 与 NapCat 本机前台 WebSocket 端到端测试 8 项通过。测试退出时网关已关闭，没有后台进程。
- pnpm 12 锁文件为两个 YAML document，前半记录包管理器、后半记录工作区依赖；迁移后的相对链接已重解析，冻结安装通过。此前仅看锁文件前半产生的怀疑已排除。
- ZZZ 已开始独立实现自动调频同步／事务、按用户和来源持久化的面板、官方战绩族、月报与任务配置；这些扩展尚待完整 fixture 与安全边界验证，不将路由存在当作功能完成。
- 首批文本与请求契约 23 项测试通过；核对真实 Cookie 调频协议为命名枚举和 gacha_item_list/date/rarity，已经修正先前简写编号的假设并加入回归。六类频段含独家重映与音擎回响。
- MIT 计算源码首次裁取成功：1221 个传递源码文件约 5.2 MB，生成无外部运行依赖的单一 ESM 约 4.86 MB。发现角色突破下标为 0–5、核心 0–6，正在实现与官方／Enka 原始数据的明确映射；不使用固定满级面板冒充真实数据。

## 门禁和后续

- Gate 0：READY，配置式插件平台、纯文本和许可策略明确。
- Gate 1：用户修订已记录；chatAi 仅定义契约、图片排除和自动更新抽卡主链路已明确。
- Gate 2–3：架构现状已核对；新模块及路由契约提出具体建议，实际迁移前需完成可执行接口和数据兼容方案。逐角色伤害的规则覆盖仍须闭合证据。
- Gate 4：修订架构和纯文本功能范围已批准；按依赖顺序实施，每个接口和计算规则保留实际验证边界。
- 实现与验证进行中；评分／伤害规则覆盖、完整历史内容来源仍存在缺口，不声称功能补齐完成。

## 状态历史

- 2026-10-25：收到纯文本补齐请求，完成本地定制行为与网络许可核查。
- 2026-10-25：用户确认仅复用许可明确且宽松兼容的代码，AGPL 只参考功能。
- 2026-10-25：提交两项范围／实施问题等待回复，先完成可审阅的 README 与方案。当前 PAUSED，仅指等待实施确认，不是用户取消需求。
- 2026-10-25：用户明确平台定位与六项修订；核对实现后修正根 README、模块开发标准和功能方案，新增运行操作文档，移除本地仓库外部致谢。状态回到 PREPARING，未迁移目录或改变运行代码。
- 2026-10-25：用户批准迁移与既定功能差异实施。重新核对工作区和扫码修复；进入 EXECUTING，先迁移布局、配置装配与动态命令契约。

## 恢复检查点

- 当前边界：用户已批准迁移和纯文本补齐；禁止后台进程、部署和真实签到／推送。
- 最近完成：配置装配、动态命名空间、数据隔离和扫码回归；首批文本实现。
- 在途操作：前台一次性 MIT 计算库构建；没有后台服务或临时登录状态。
- 已发生外部副作用：只读网络访问公开仓库及许可，读取本地旧仓库源码；无写入旧仓库或生产环境。
- 下一安全动作：验证新增 ZZZ 数据链路并修复失败，核对接口结构、调度恢复与剩余功能；chatAi 业务本轮不开始。
