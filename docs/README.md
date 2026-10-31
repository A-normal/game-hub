# 项目文档

此目录保存随源码发布、持续维护的使用说明与开发契约。

- [指令与帮助、旧指令迁移](commands.md)
- [运行与部署](operations.md)
- [core 系统管理员注册与权限](../packages/core/README.md)
- [NapCat 渠道配置与连接令牌](../packages/channel/napcat/README.md)
- [Telegram 渠道配置与 Bot API Token](../packages/channel/telegram/README.md)
- [chat-ai 插件配置与管理员注册令牌](../packages/plugin/chat-ai/README.md)
- [插件开发约定](plugin-development.md)
- [chatAi 使用说明](chat-ai.md)
- [外部代码复用与许可记录](upstream-reuse.md)
- [卡池数据来源](sources/gachaclock.md)

公开文档描述当前可用行为、接口和维护方法。不要放入个人实施计划、开发过程台账、现场日志、账号配置或未脱敏的案例。

本地开发参考统一放在仓库根目录的 `.private/development/`，个人人物卡等素材放在 `.private/characters/`。`.private/` 同时由 Git 和 Docker 构建上下文排除；个人资料需自行备份。历史上已经提交的文件仍可能存在于 Git 历史中，移动文件不会清除历史。
