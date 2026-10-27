import test from "node:test";
import assert from "node:assert/strict";
import LlmProvider, {createModule, configSchema, normalizeChatEndpoint, modelsEndpointFrom} from "../packages/provider/llm/src/index.mjs";
import {LlmClient, validateApiKeyEnv, validateEndpoint} from "../packages/provider/llm/src/client.mjs";
import {validateConfig} from "../packages/core/src/runtime/config-schema.mjs";

// 全程注入假 fetch，绝不真实联网。
const profile = (overrides = {}) => ({endpoint: "https://api.example.com/v1/chat/completions", model: "test-model", apiKeyEnv: "CHATAI_KEY_TEST", ...overrides});
const withEnv = (name, value) => {
  const previous = process.env[name];
  process.env[name] = value;
  return () => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; };
};
const capture = promise => promise.then(value => ({value}), error => ({error}));
const configError = run => { try { run(); return null; } catch (error) { return error; } };

test("成功路径：发出正确的 URL / Bearer / body，并解析 text 与 usage", async t => {
  const restore = withEnv("CHATAI_KEY_TEST", "sk-test-123"); t.after(restore);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    return {ok: true, status: 200, json: async () => ({model: "test-model-0613", choices: [{message: {content: "你好"}}], usage: {prompt_tokens: 12, completion_tokens: 34}})};
  };
  const client = new LlmClient({...profile(), fetchImpl, sleep: async () => {}});
  const result = await client.complete({messages: [{role: "user", content: "hi"}], temperature: 0.5, maxOutputTokens: 64});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-123");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {model: "test-model", messages: [{role: "user", content: "hi"}], stream: false, temperature: 0.5, max_tokens: 64});
  assert.equal(result.text, "你好");
  assert.deepEqual(result.usage, {input: 12, output: 34});
  assert.equal(result.model, "test-model-0613");
  // usage 缺失时补 0，不抛错。
  const bare = new LlmClient({...profile(), fetchImpl: async () => ({ok: true, status: 200, json: async () => ({choices: [{message: {content: "ok"}}]})})});
  assert.deepEqual((await bare.complete({messages: []})).usage, {input: 0, output: 0});
});

test("超时 → LLM_TIMEOUT，且 fetch 只调用 1 次（不重试）", async t => {
  const restore = withEnv("CHATAI_KEY_TEST", "sk-test-123"); t.after(restore);
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      const abort = () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); };
      if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, {once: true});
    });
  };
  const client = new LlmClient({...profile(), fetchImpl, sleep: async () => {}, timeoutMs: 20});
  const {error} = await capture(client.complete({messages: []}));
  assert.equal(error?.code, "LLM_TIMEOUT");
  assert.doesNotMatch(error.publicMessage, /sk-test|api\.example\.com/);
  assert.equal(calls, 1);
});

test("HTTP 5xx → LLM_HTTP_5XX、400 → LLM_HTTP_4XX，均不重试且不回显响应体", async t => {
  const restore = withEnv("CHATAI_KEY_TEST", "sk-test-123"); t.after(restore);
  let calls = 0;
  const respond = status => async () => { calls += 1; return {ok: false, status, json: async () => ({error: "internal detail " + status})}; };
  const five = new LlmClient({...profile(), fetchImpl: respond(503)});
  const {error: server} = await capture(five.complete({messages: []}));
  assert.equal(server.code, "LLM_HTTP_5XX");
  assert.equal(calls, 1);
  assert.ok(!server.publicMessage.includes("internal detail"));
  calls = 0;
  const four = new LlmClient({...profile(), fetchImpl: respond(400)});
  const {error: client4xx} = await capture(four.complete({messages: []}));
  assert.equal(client4xx.code, "LLM_HTTP_4XX");
  assert.equal(calls, 1);
  assert.ok(!client4xx.publicMessage.includes("internal detail"));
});

test("连接类失败：重试 1 次后成功；连续失败共 2 次调用后 LLM_NETWORK", async t => {
  const restore = withEnv("CHATAI_KEY_TEST", "sk-test-123"); t.after(restore);
  let calls = 0;
  const sleeps = [];
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return {ok: true, status: 200, json: async () => ({choices: [{message: {content: "重试成功"}}], usage: {prompt_tokens: 1, completion_tokens: 2}})};
  };
  const client = new LlmClient({...profile(), fetchImpl: flaky, sleep: async ms => { sleeps.push(ms); }});
  const result = await client.complete({messages: []});
  assert.equal(result.text, "重试成功");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [client.retryDelayMs]);
  let failedCalls = 0;
  const alwaysFails = async () => { failedCalls += 1; throw new TypeError("fetch failed"); };
  const broken = new LlmClient({...profile(), fetchImpl: alwaysFails, sleep: async () => {}});
  const {error} = await capture(broken.complete({messages: []}));
  assert.equal(error.code, "LLM_NETWORK");
  assert.equal(failedCalls, 2);
});

test("密钥引用白名单：系统变量与前缀不符在创建 client 时即拒绝，合法引用通过", async t => {
  const restoreMain = withEnv("CHATAI_KEY_MAIN", "sk-live-456"); t.after(restoreMain);
  const previousUnset = process.env.CHATAI_KEY_UNSET; delete process.env.CHATAI_KEY_UNSET; t.after(() => { if (previousUnset !== undefined) process.env.CHATAI_KEY_UNSET = previousUnset; });
  for (const apiKeyEnv of ["GAMEHUB_TOKEN", "VAULT_SECRET", "ACCESS_TOKEN", "MASTER_QQ", "GAMEHUB_ADMIN_USERS", "MY_KEY", "", "CHATAI_KEY_lower"]) {
    const error = configError(() => new LlmClient({...profile(), apiKeyEnv}));
    assert.equal(error?.code, "LLM_CONFIG", apiKeyEnv || "<空>");
    assert.ok(!String(error.message).includes("sk-live-456"));
  }
  assert.equal(validateApiKeyEnv("CHATAI_KEY_MAIN"), "CHATAI_KEY_MAIN");
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("测试中不允许真实请求"); };
  const client = new LlmClient({...profile({apiKeyEnv: "CHATAI_KEY_MAIN"}), fetchImpl});
  assert.equal(client.apiKeyEnv, "CHATAI_KEY_MAIN");
  assert.equal(calls, 0);
  // 环境变量未配置：调用时按 LLM_CONFIG 处理，且不发请求。
  const missing = new LlmClient({...profile({apiKeyEnv: "CHATAI_KEY_UNSET"}), fetchImpl});
  const {error} = await capture(missing.complete({messages: []}));
  assert.equal(error.code, "LLM_CONFIG");
  assert.equal(calls, 0);
});

test("端点安全：默认拒绝 http 与私网，显式开关放行", async () => {
  const insecure = configError(() => new LlmClient({...profile(), endpoint: "http://api.example.com/x"}));
  assert.equal(insecure?.code, "LLM_CONFIG");
  assert.ok(!insecure.message.includes("api.example.com"));
  assert.ok(new LlmClient({...profile(), endpoint: "http://api.example.com/x", allowInsecureHttp: true}));

  const loopback = configError(() => new LlmClient({...profile(), endpoint: "https://127.0.0.1/x"}));
  assert.equal(loopback?.code, "LLM_CONFIG");
  assert.ok(!loopback.message.includes("127.0.0.1"));
  assert.ok(new LlmClient({...profile(), endpoint: "https://127.0.0.1/x", allowPrivateHosts: true}));

  for (const endpoint of ["https://10.1.2.3/x", "https://172.20.0.1/x", "https://192.168.1.1/x", "https://169.254.169.254/latest", "https://localhost/x", "https://nas.local/x", "https://[::1]/x", "not a url", ""]) {
    assert.equal(configError(() => new LlmClient({...profile(), endpoint}))?.code, "LLM_CONFIG", endpoint);
  }
  assert.equal(validateEndpoint("https://api.example.com/x").hostname, "api.example.com");
});

test("choices[0].message.content 非字符串 → LLM_BAD_RESPONSE", async t => {
  const restore = withEnv("CHATAI_KEY_TEST", "sk-test-123"); t.after(restore);
  const payloads = [{choices: [{message: {content: null}}]}, {choices: [{message: {content: {}}}]}, {choices: []}, {}];
  for (const payload of payloads) {
    const client = new LlmClient({...profile(), fetchImpl: async () => ({ok: true, status: 200, json: async () => payload})});
    const {error} = await capture(client.complete({messages: []}));
    assert.equal(error?.code, "LLM_BAD_RESPONSE");
  }
  const broken = new LlmClient({...profile(), fetchImpl: async () => ({ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); }})});
  assert.equal((await capture(broken.complete({messages: []}))).error?.code, "LLM_BAD_RESPONSE");
});

test("createModule 返回 provider 契约形态，且不产生任何 fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("不应发起真实请求"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const instance = createModule({config: {timeoutMs: 5000}});
  assert.equal(instance.id, "llm");
  assert.equal(instance.kind, "provider");
  assert.equal(instance.contractVersion, 1);
  assert.deepEqual(instance.capabilities, ["chat"]);
  assert.deepEqual(instance.config, {timeoutMs: 5000});
  assert.equal(typeof instance.createClient, "function");
  const client = instance.createClient({endpoint: "https://api.example.com/x", model: "m", apiKeyEnv: "CHATAI_KEY_MAIN"});
  assert.equal(typeof client.complete, "function");
  assert.equal(calls, 0);
  assert.equal(new LlmProvider({}).id, "llm");
  validateConfig(configSchema, {timeoutMs: 5000, allowInsecureHttp: false, allowPrivateHosts: false}, "provider:llm");
  assert.throws(() => validateConfig(configSchema, {endpoint: "https://api.example.com/x"}, "provider:llm"), /unknown field/);
});

test("normalizeChatEndpoint 纯函数：8 种输入归一化、query/hash 拒绝与 models 端点推导", () => {
  // 1. path 为空
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com"), {ok: true, url: "https://api.example.com/v1/chat/completions"});
  // 2. path 为 /
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com/"), {ok: true, url: "https://api.example.com/v1/chat/completions"});
  // 3. path 以 /v1 结尾
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com/v1"), {ok: true, url: "https://api.example.com/v1/chat/completions"});
  // 4. path 以 /v1/ 结尾
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com/v1/"), {ok: true, url: "https://api.example.com/v1/chat/completions"});
  // 5. path 以 /v2 结尾
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com/v2"), {ok: true, url: "https://api.example.com/v2/chat/completions"});
  // 6. path 以 /chat/completions 结尾
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com/v1/chat/completions"), {ok: true, url: "https://api.example.com/v1/chat/completions"});
  // 7. path 以 /chat/completions/ 结尾
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com/v1/chat/completions/"), {ok: true, url: "https://api.example.com/v1/chat/completions"});
  // 8. 其它非空自定义 path
  assert.deepEqual(normalizeChatEndpoint("https://api.example.com/custom/gateway"), {ok: true, url: "https://api.example.com/custom/gateway/chat/completions"});

  // 异常输入
  assert.equal(normalizeChatEndpoint("https://api.example.com/v1?token=123").ok, false);
  assert.equal(normalizeChatEndpoint("https://api.example.com/v1#hash").ok, false);
  assert.equal(normalizeChatEndpoint("not-a-url").ok, false);
  assert.equal(normalizeChatEndpoint("").ok, false);
  assert.equal(normalizeChatEndpoint(null).ok, false);

  // modelsEndpointFrom
  assert.deepEqual(modelsEndpointFrom("https://api.example.com/v1"), {ok: true, url: "https://api.example.com/v1/models"});
  assert.deepEqual(modelsEndpointFrom("https://api.example.com/v1/chat/completions"), {ok: true, url: "https://api.example.com/v1/models"});
  assert.equal(modelsEndpointFrom("https://api.example.com/v1?bad=1").ok, false);
});
