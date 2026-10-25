# Android 设备 payload 来源

仅移植 `owwkmidream/zzz-seelie-sync` 的纯设备扩展字段构造函数，版本固定为 `5c15dee88eddb52640971e103621c70da7787afb`。原始文件保存在 `devicePayload.ts`，运行适配在 `payload.mjs`；来源、修改和 SHA-256 见 `manifest.json`。

上游该版本 [README 的 License 部分](https://github.com/owwkmidream/zzz-seelie-sync/blob/5c15dee88eddb52640971e103621c70da7787afb/README.md#-license) 明确声明 MIT，其 userscript 元数据标注作者 owwkmidream 和 MIT。上游没有单独的根 LICENSE 文件；这里随源码保留作者署名及标准 MIT 告知，不虚构版权年份。

适配仅去除 TypeScript 类型和导入，将 app version 改为参数；不包含浏览器存储、GM 请求、扫码、数据上传或旧宿主逻辑。我们自己的 `src/android-profile.mjs` 校验手机导出的七个字段，覆盖名称、型号、产品、主板、OAID、系统版本、厂商及构建信息。

其余容量、传感器、显示尺寸、安装时间等是上游的固定模板默认值，**不是从用户手机测得的数据**。官方签发指纹成功只证明该次 getFp 请求被接受，不证明便签可用或设备已被账号信任。后续若补充真实字段，应明确输入契约和来源，不能把模板写成真机采集。

修改移植文件后同步清单 hash，并运行 `tests/android-device.test.mjs`。AGPL ZZZ-Plugin 仅作功能对照，没有复制其 Android 导入实现。
