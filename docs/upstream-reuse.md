# 上游代码复用评估

## 结论

可以将许可兼容的上游代码复制到本仓库、按当前接口改造并自行维护。这通常称为源码移植或 vendoring，不要求在运行时依赖原项目。但上游版权和许可仍然存在，不能声明这些部分是原创。

本轮用户已明确选择：**仅复制许可明确且宽松兼容的外部代码；AGPL 只参考功能**。本地自有仓库中的定制需求属于内部项目演进，不是外部致谢对象；按新模块契约重做所需业务，不引入旧宿主兼容层。实际混有第三方实现的文件仍按其来源与许可分别核查。

## 已核对的来源

| 来源 | 固定版本 | 许可和耦合 | 决策 |
| --- | --- | --- | --- |
| ZZZure/ZZZ-Plugin | `1a322076120b6148188bab154834ad19628c179c` | 实际 LICENSE 为 AGPL-3.0；`dist/lib/mysapi.js` 继承云崽 `MysApi`，其它模块依赖旧插件的全局设施 | 仅核对功能；不复制实现 |
| UIGF-org/mihoyo-api-sdk | `7c3107f95b72e7324af966b2e8989eb8375e5fc7` | MIT；有独立 DS 辅助代码、TypeSpec 协议和生成客户端 | 合适的选择性移植候选；本文件落地时尚未复制 |
| frzyc/genshin-optimizer | `2ce06b88a442531b49d84cbed15204a4a03d078a` | MIT；角色公式、数值表及所需纯计算模块 | 已以源码和独立 ESM bundle 纳入 `packages/plugin/zzz/vendor/optimizer`，原许可证及逐文件 hash 位于该目录；运行不依赖旧宿主 |
| owwkmidream/zzz-seelie-sync | `5c15dee88eddb52640971e103621c70da7787afb` | README 及 userscript 明确 MIT；独立设备扩展字段模板 | 仅移植纯 payload 构造函数至 `packages/provider/mihoyo/vendor/android-device`；保留作者、MIT 告知、原始源码和 hash；七字段导入、校验、持久化由本仓库实现 |

UIGF 的完整生成客户端带有 Azure 运行依赖，包含大量本仓库不需要的服务。更适合从 MIT 来源裁取独立签名逻辑、核对所需接口，再用当前原生 fetch 实现 provider 的统一生命周期；不为省去少量包装引入整套生成客户端。

内部自定义优化单独记录为需求／行为依据，例如 `../zzz-bot` 的面板刷新、快捷指令和签到行为；不列入本表或根 README 的外部致谢。

Android 模板的容量、传感器等默认值不是手机实测信息，不能当作真机信任凭证；适配和许可依据见 [设备 payload 说明](../packages/provider/mihoyo/vendor/android-device/README.md)。`forchannot/get_device_info` 仅作为用户取得七字段 JSON 的工具来源，没有把 APK 或其实现打包进仓库。

DS 实现本身不包含可用盐值；仍需确认具体接口族的盐值、签名代际、请求头、设备和凭据类型。协议定义不是官方服务可用性的保证。

实际计算代码完整性用 `node tools/verify-vendor.mjs` 核对；构建入口为 `tools/vendor-optimizer.mjs`。公式测试覆盖当前锁定目录的角色技能，但模拟输入和有限独立基准不能等同于全部角色真机数值验收。

## 能节省什么

- 已验证的签名算法、序列化规则和接口结构，减少从零摸索协议的工作。
- 独立于旧宿主的数据转换或纯计算模块，在输入输出相容时可以直接复用并增加契约测试。
- 纯文本输出省去了浏览器渲染、模板、字体、图片缓存和面板素材管理。

## 仍然要做什么

- 适配 Game-Hub 的事件、provider、账号作用域、事务、错误和取消契约。
- 对照真实服务验证鉴权、数据字段、区服和版本变化；不把上游 mock 或类型定义当在线证明。
- 处理业务状态、持久化、分页、去重、缓存失效、权限和用户回复。
- 为移植代码保留许可证、固定来源版本，审查上游更新并维护自己的回归。

因此移植适合减少基础设施和算法研发成本，不能将“复制文件耗时”当作总开发周期。没有选定模块和实际适配结果前，不给出缺乏依据的节省百分比。

## 许可边界

- MIT 允许复制、修改和分发，但其版权与许可告知须随适用代码保留。
- ZZZ-Plugin 的 AGPL-3.0 不是“README 致谢即可使用”；复制修改及适用的分发、网络交互涉及相应告知和源码提供要求。当前用户选择下不采用此路线。
- 客户端代码、协议格式、游戏内容和攻略文章是不同权利对象，分别核对来源和使用条件。
- 此评估记录已核对的条款与工程策略；没有替本仓库选择统一许可证。

来源：[ZZZ-Plugin LICENSE](https://raw.githubusercontent.com/ZZZure/ZZZ-Plugin/1a322076120b6148188bab154834ad19628c179c/LICENSE)、[UIGF SDK LICENSE](https://raw.githubusercontent.com/UIGF-org/mihoyo-api-sdk/7c3107f95b72e7324af966b2e8989eb8375e5fc7/LICENSE)、[UIGF DS 实现](https://github.com/UIGF-org/mihoyo-api-sdk/blob/7c3107f95b72e7324af966b2e8989eb8375e5fc7/generated/clients/javascript/ds.ts)。
