# @game-hub/plugin-chat-ai

Game-Hub聊天业务插件，无新增第三方运行依赖。模型协议在独立llm provider中，core负责通用路由与事件。

包含服务连接与多模型配置、显示名称及编号选择、人物分支、可靠队列、完整文本卡文件导入与导出、精确撤回、可选人物事件/表情素材/主动问候、显式记忆与手动摘要。所有管理命令保留双管理员鉴权。

完整操作、数据迁移、默认关闭项和验证边界见 [chatAi使用说明](../../../docs/chat-ai.md)。人物卡由管理员自行导入，个人卡片保存在私有数据中。

配置schema和缺省值见src/index.mjs。导入模块不启动服务；createModule在提供的Vault建立自有表；start执行模型健康检查并恢复已明确开启的任务；stop取消在途请求和进程内定时器。

不支持代码热重载、通用初始化或环境文件托管。新增模型/人物与会话选择可以通过命令立即生效，密钥仍来自运行环境。

## AI 插件管理员注册令牌

`CHATAI_ADMIN_REGISTRATION_TOKEN` 专供**聊天 AI 插件管理员注册**，由本插件验证，不授予 Game-Hub 系统管理员权限。

维护者在部署用私有 `.env` 中设置该变量，并将其传入 Game-Hub 运行环境。根 `.env.example` 仅汇总部署字段，本包不另行读取环境文件。真实令牌不提交仓库；留空关闭独立 AI 管理员自助注册，Game-Hub 系统管理员仍具有 AI 管理权限。

用户私聊机器人，发送当前 AI 插件调用标记下的 `AI认证 <注册令牌>`；本插件验证后将发送者登记为 AI 管理员。群聊认证被拒绝。AI 管理员身份由 Vault 保存，注册令牌自身不入库、不在回复中回显；注册令牌轮换不自动撤销已有授权。

系统管理员可以使用本插件的 `AI管理员列表` 和 `AI管理员删除 <统一用户ID>` 查看或删除独立 AI 管理员，独立 AI 管理员不能借此撤销系统管理员权限。

旧环境变量 `CHATAI_ADMIN_TOKEN` 已更名为 `CHATAI_ADMIN_REGISTRATION_TOKEN`，不再作为有效读取入口。升级时修改实际私有环境文件与 Compose 映射，变量名变更不要求改变令牌值本身。修改容器环境后需重建 Game-Hub，单纯 restart 不会载入新值。

Game-Hub 系统注册令牌由 [core 包](../../core/README.md#系统管理员注册与权限)说明；渠道连接令牌由[对应渠道包](../../channel/napcat/README.md#napcat-连接-game-hub-的令牌)说明。模型 API 密钥只接受 `CHATAI_KEY_*` 前缀，令牌不得作为模型 API 密钥引用，详见 [llm provider](../../provider/llm/README.md)。
