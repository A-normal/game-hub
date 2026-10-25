# 绝区零扫码登录修复记录

> This is a development workflow process record. It is not a customer requirement, product rule, acceptance authority, or source for deriving requirements. Follow the cited active requirement sources.

```yaml
artifact_type: dev-workflow-process-ledger
authority: process-record-only
is_requirement_source: false
project: game-hub
increment_id: zzz-qr-login-2026-10-25
workflow_run_id: zzz-qr-login-2026-10-25
risk_level: HIGH
status: VERIFICATION_PENDING
plan_version: 1
checkpoint_sequence: 3
created_at: 2026-10-25
updated_at: 2026-10-25
evidence_valid_as_of: 2026-10-25
```

## 授权与范围

- 用户最初要求修复扫码并对照上游补齐功能，随后明确：这是独立新版仓库，上游只作为功能参照，必须自行实现，不依赖旧代码。
- 用户在实施确认中选择“先仅修复扫码，功能补齐另行确认”。本增量只修复扫码，不实施功能扩展。
- 不开启后台进程，不启动、重启或替换现有容器，不写入现有容器数据库。
- 保留仓库原有未提交修改。允许本增量必要的代码、测试、使用说明和过程记录。

## 已确认的证据

- `docker logs gamehub-service`，2026-10-25 14:59:27：扫码已 Confirmed，随后 `IdentityVault.bindUser` 抛出 `Cannot read properties of undefined (reading 'toString')`。
- `login-qr.mjs:328` 传入不存在的 `event.originalId`，而 `InboundShaper.shape` 提供的是 `event.sender.id`、`event.platform`。
- 容器和工作区上述扫码、身份库、整形器文件 SHA256 一致。
- 内存库复现：同样的身份字段错误；裸 Cookie 字符串保存后，`getActiveRole` 返回空凭据。
- 容器数据库只读检查：凭据 1 条、绑定 0 条、角色 0 条。不得据此猜测绑定所有者或自动恢复登录。
- 扫码保存分多次写入，失败时会留下孤立凭据；旧会话在取消、替换后也可能继续请求或清理新会话。
- 基线 `npm test` 四组全部通过，但未覆盖真实整形事件的扫码授权到绑定及凭据读回路径。

## 开发合同

| 需求 | 任务 | 验收 | 验证 |
| --- | --- | --- | --- |
| REQ-01：真实入站事件扫码后正确绑定当前用户 | TASK-01：使用 sender.id/platform，校验身份，不依赖 originalId；保留已经在容器成功扫码的默认 app 模式和可选 web 模式 | AC-01：真实 InboundShaper 事件经过扫码可保存绑定、角色并选择最高等级角色 | VAL-01：整形器→调度器→扫码处理→真实内存 Vault 集成回归 |
| REQ-02：保存的凭据可供后续请求使用 | TASK-02：统一 Cookie JSON 写入，兼容读取此前裸字符串；保留 token 类型和值，支持 v2 Cookie，不把 stoken 冒充 ltoken；校验角色查询返回码 | AC-02：后续 provider 请求带正确 Cookie；授权或角色请求失败不报告成功、不落库 | VAL-02：Cookie 往返、带等号的值、多 Set-Cookie、凭据缺失与非零返回码测试 |
| REQ-03：失败不产生部分绑定 | TASK-03：新增原子保存账号绑定的方法，复用现有 upsert 和角色逻辑；事务失败回滚 | AC-03：凭据/用户/绑定/角色/激活全部提交或全部回滚，重试不丢原有绑定 | VAL-03：中途写入失败与更新已有账号回滚测试、外键检查 |
| REQ-04：取消、替换、超时和发送失败正确结束会话 | TASK-04：会话拥有者检查、AbortController、HTTP 超时、有限轮询和 finally 清理；取消后不保存、不继续成功回复 | AC-04：旧会话不能删除或覆盖新会话；网络失败和异常状态不伪装成过期或成功 | VAL-04：可控异步请求下的取消/重发竞态、超时、二维码发送失败测试 |
| REQ-05：交付可复核且遵守独立实现与运行限制 | TASK-05：新增独立测试、更新测试入口和本修复说明 | AC-05：原有测试及新增测试通过，语法/补丁检查通过；不启动后台服务、不部署、不触碰生产数据 | VAL-05：完整 npm test、node --check、改动审查与状态复核 |

## 数据与操作边界

- 输入：当前聊天事件、米哈游 create/query 响应、Set-Cookie、官方角色列表。
- 处理：有限会话生命周期、凭据提取和校验、角色查询、原子保存。
- 输出：当前用户的登录结果；已校验的账号/角色关联；后续 provider 可读取的 Cookie。
- 复用当前 Vault、provider 和 PNG 二维码生成器，不引入旧插件或新增依赖。
- 无表结构迁移，无现存数据批量改写；保留读取旧裸 Cookie 的能力。
- 真实扫码仍需人使用手机确认；不代替用户授权，不通过日志或残留凭据推断聊天账号归属。
- 回滚：仅还原本增量补丁；新保存的 Cookie 格式兼容旧客户端的 `{ ck }`，不删除现有数据。
- 风险：身份和凭据路径变更；通过有限模块改动、内存库事务回归和异常路径测试约束。

## 门禁与验证状态

- Gate 0–4：READY；依据为本轮用户的明确授权和上述已复现的技术链路。
- Material unknowns：0（本增量不选择功能扩展方案、不调整既有鉴权协议/部署配置）。
- static / automated runtime / integration / database：REQUIRED。
- end-to-end / human acceptance：真实手机扫码为 REQUIRED，实施完成后若未实测则保留 VERIFICATION_PENDING。
- 外部副作用：只读日志、代码指纹和数据库计数查询；未创建后台服务，未变更容器或生产数据。

## 状态历史

- 2026-10-25：完成只读定位、内存复现和基线测试；用户缩小并批准范围为仅修复扫码；进入 EXECUTING。
- 2026-10-25：TASK-01–04 已实现，新增扫码集成测试首次通过（39 项独立场景，含父测试共 40 项）；继续完成归属冲突回归、完整回归和交付审查。
- 2026-10-25：TASK-05 完成；`npm test` 五组全部通过。新增扫码测试含 40 项独立场景（含父测试共 41 项）；生产代码与测试代码 `node --check` 通过；`git diff --check` 通过。
- 2026-10-25：沙箱内 `git diff` 与 `rev-parse`/`status` 的工作树判断不一致；使用获准的只读外部检查完成 diff 审查，没有 Git 写入或修改配置。
- 2026-10-25：工作区修复和自动化验收完成；最终状态 VERIFICATION_PENDING，等待代码部署后的真实扫码验收。功能补齐仍待另行确认。

## 验证结果

| 验证 | 层级 | 结果 | 边界 |
| --- | --- | --- | --- |
| VAL-01 | integration | PASS | 真实 InboundShaper / Dispatcher / Vault / provider；官方网络响应模拟 |
| VAL-02 | automated runtime | PASS | Cookie v1/v2、等号保留、token 类型、失败返回码和后续带凭据查询 |
| VAL-03 | database | PASS | 内存 SQLite 回滚、嵌套激活回滚、跨账号角色归属拒绝、文件库关闭后重开和旧格式只读兼容 |
| VAL-04 | automated runtime | PASS | 创建/轮询/换凭据/查角色期间取消、替换后旧响应晚到、网络/HTTP/未知状态/发送失败 |
| VAL-05 | static + regression | PASS | 五组 `npm test`、三个本轮代码文件的语法检查、补丁空白检查；保留已有修改 |
| 手机扫码与真实容器完整链路 | end-to-end / human | PENDING | 没有启动/重启/部署服务；没有请求新的真实登录票据，没有修改生产库 |

## 交付文件

- `packages/plugin-zzz/src/handlers/login-qr.mjs`：本仓库自行实现的会话控制与绑定流程修复。
- `packages/core/src/identity/vault.mjs`：Cookie 读写、身份校验和原子保存；保留本轮前已存在的系统设置及其它修改。
- `tests/zzz-qr-login.test.mjs`、`package.json` 的测试脚本：新增并接入扫码回归。
- `docs/zzz-qr-login-fix.md`：使用、验收、部署边界与回滚说明。
- 未新增依赖、未迁移表结构、未修改运行中服务或生产数据；测试产生的临时库已删除。

## 恢复检查点

- 最近完成：TASK-01–05 和 VAL-01–05。
- 当前工作：工作区交付；代码尚未部署。
- 待执行：代码部署后真实扫码（需用户交互且当前禁止启动/重启服务）。
- 下一安全操作：交付补丁与验证边界；用户另行安排代码部署后，按 `docs/zzz-qr-login-fix.md` 验收登录。功能补齐必须另行确认，不自动开始。
