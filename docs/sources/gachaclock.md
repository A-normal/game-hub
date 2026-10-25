# GachaClock 数据源

Game-Hub 的卡池历史功能在运行时请求 [iaoongin/GachaClock](https://github.com/iaoongin/GachaClock) 的 `spider/data/zzz/history.json`，只保存经过校验的文字字段。不会下载图片、导入其代码或依赖其宿主。来源的数据可能有延迟，当前卡池另行使用官方安排。

2026-10-25 核验的数据文件提交为 `b1c96688913f7b2865a415e24432d7f60ee6c3e0`（提交日期 2026-04-16）。运行时更新跟踪 main，缓存记录请求地址、内容 SHA-256、ETag 与抓取时间；刷新失败保留旧缓存。

仓库根 LICENSE 为 MIT。原始许可：[LICENSE](https://github.com/iaoongin/GachaClock/blob/b1c96688913f7b2865a415e24432d7f60ee6c3e0/LICENSE)。该许可不改变游戏内容自身的权利归属。

```text
MIT License

Copyright (c) [2025] [iaoongin]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
