# @game-hub/provider-llm

Game-Hub 的 OpenAI 兼容大语言模型 provider。**零第三方依赖**：只用内置 `fetch`、`AbortController` 与 `URL`；
导入模块与 `createModule()` 都不发任何网络请求。

## 模块契约

```js
import LlmProvider, {createModule, configSchema} from "./packages/provider/llm/src/index.mjs";

const provider = createModule({config: {timeoutMs: 30000}});
// provider = {id:"llm", kind:"provider", contractVersion:1, capabilities:["chat"], name, config, createClient(profile)}

const client = provider.createClient({
  endpoint: "https://api.example.com/v1/chat/completions",
  model: "gpt-4o-mini",
  apiKeyEnv: "CHATAI_KEY_MAIN",
  temperature: 0.8,
  maxOutputTokens: 400,
  timeoutMs: 20000
});

const {text, usage, model} = await client.complete({
  messages: [{role: "system", content: "..."}, {role: "user", content: "你好"}],
  temperature: 0.6,
  maxOutputTokens: 200,
  signal: abortController.signal
});
// text: 模型纯文本；usage: {input, output}（缺失字段记 0）；model: 响应中的模型 ID，缺失时回退为请求的模型 ID
```

`configSchema` 只接受以下模块级配置（严格子集，未知字段直接拒绝）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timeoutMs` | number，1000–120000 | 单次请求超时，缺省 30000 |
| `allowInsecureHttp` | boolean | 显式允许 `http:` 端点，缺省 false |
| `allowPrivateHosts` | boolean | 显式允许本机 / 私网端点，缺省 false |

`createClient(profile)` 的 `profile` 字段：`endpoint`（必填）、`model`（必填）、`apiKeyEnv`（必填）、
`temperature`、`maxOutputTokens`、`timeoutMs`、`allowInsecureHttp`、`allowPrivateHosts`。
`profile` 覆盖模块级配置。调用参数 `temperature` / `maxOutputTokens` 再覆盖 `profile` 默认值；
两者都未提供时请求体不带对应字段，由服务端取默认值。

## 协议

`POST {endpoint}`，请求头：

```
Authorization: Bearer ${process.env[apiKeyEnv]}
Content-Type: application/json
```

请求体：`{model, messages, temperature?, max_tokens?, stream:false}`（只发纯文本补全，不启用流式）。
响应取 `choices[0].message.content`，必须是字符串；`usage.prompt_tokens`/`usage.completion_tokens` 映射为
`usage.input`/`usage.output`。跟随重定向被禁用（`redirect:"error"`）。

## 错误与重试

统一错误形态：`Object.assign(new Error(message), {code, publicMessage})`。`publicMessage` 恒为中文短句，
**不含密钥、端点、响应体**，可直接用于群回复。

| code | 触发条件 | 是否重试 |
| --- | --- | --- |
| `LLM_CONFIG` | 密钥引用非法、端点非法、模型 ID 缺失、调用时环境变量未配置 | 否 |
| `LLM_TIMEOUT` | 超过 `timeoutMs` | 否 |
| `LLM_HTTP_4XX` | 响应 4xx | 否 |
| `LLM_HTTP_5XX` | 响应 5xx | 否 |
| `LLM_NETWORK` | 连接类失败（fetch 抛出非超时异常）；外部 `signal` 取消也归入此码 | 连接类失败重试 1 次（共 2 次调用），取消不重试 |
| `LLM_BAD_RESPONSE` | 响应不是 JSON，或 `content` 不是字符串 | 否 |

## 安全规则（创建 client 时立即校验，失败抛 `LLM_CONFIG`）

1. `apiKeyEnv` 必须匹配 `^CHATAI_KEY_[A-Z0-9_]{1,56}$`，且必须先通过显式 denylist
   （`GAMEHUB_TOKEN`、`VAULT_SECRET`、`ACCESS_TOKEN`、`MASTER_QQ`、`GAMEHUB_ADMIN_USERS`）——
   即使前缀规则将来放宽，系统变量也不可能被引用为模型密钥。
2. 端点必须能被 `new URL()` 解析，默认只允许 `https:`；`allowInsecureHttp:true` 才允许 `http:`。
3. 主机为 `localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0`、`*.local` 或私有网段字面量
   （`10.`、`172.16-31.`、`192.168.`、`169.254.`）时，只有 `allowPrivateHosts:true` 才放行。
4. 校验失败信息只回显环境变量**名**，不回显任何密钥值；密钥只在发请求时从 `process.env` 读取。

## 注入点（便于测试与集成）

`new LlmClient({fetchImpl, now, sleep, log, ...profile})`：

- `fetchImpl`：替换 fetch；
- `now`：耗时统计用的时钟；
- `sleep`：重试间隔等待，测试可注入空实现，避免真实等待；
- `log`：可选日志钩子，回调参数只有 `{status, code, elapsedMs}`——**只允许**记录状态码、错误码与耗时，
  不记录请求头、请求体、正文或密钥；缺省为空实现，因此本模块默认不产生任何控制台输出。

## 已知限制（P1 范围）

- 只做端点字面量检查，**不做 DNS 解析后的 IP 复检**，`allowPrivateHosts` 打开时无法防御 DNS rebinding。
- 不支持流式、function calling / tool 调用、图片与多模态消息、代理配置。
- 不支持多端点故障转移、令牌桶限流、响应缓存；这些都是调用方（chat-ai 插件）的职责。
- `temperature` / `maxOutputTokens` 未提供时不写入请求体（不使用内置默认值）。
- 外部 `signal` 取消归入 `LLM_NETWORK`（没有独立的取消错误码），且不重试。
