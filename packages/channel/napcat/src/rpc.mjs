/**
 * @file packages/channel/napcat/src/rpc.mjs
 * @description OneBotv11 Echo 异步响应管理器：修复 P1-07 盲发不读取响应与超时缺陷
 */

export class OneBotRpcManager {
  constructor() {
    this.seq = 0;
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout, action: string }>} */
    this.pendingCalls = new Map();
  }

  /**
   * 发起带 echo 追踪的 OneBot API 调用
   * @param {any} ws - WebSocket 实例
   * @param {string} action - 动作名称 (如 "send_msg", "send_private_msg")
   * @param {Record<string, any>} [params={}] - 动作参数
   * @param {number} [timeoutMs=8000] - 超时时限 (毫秒)
   * @returns {Promise<any>}
   */
  callApi(ws, action, params = {}, timeoutMs = 8000) {
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      return Promise.reject(new Error("WebSocket 未连接，无法发送 API 请求"));
    }

    const echo = `gh_echo_${++this.seq}_${Date.now()}`;
    const payload = { action, params, echo };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`OneBot API [${action}] 调用超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingCalls.set(echo, { resolve, reject, timer, action });

      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pendingCalls.delete(echo);
        reject(err);
      }
    });
  }

  /**
   * 拦截并处理 OneBot 响应包
   * @param {Object} payload
   * @returns {boolean} 是否为成功匹配到的 RPC 响应
   */
  handleIncoming(payload) {
    if (!payload || !payload.echo) return false;

    const pending = this.pendingCalls.get(payload.echo);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingCalls.delete(payload.echo);

    if (payload.status === "ok" || payload.retcode === 0) {
      pending.resolve(payload);
    } else {
      const errMsg = payload.wording || payload.message || `OneBot API 失败 (retcode: ${payload.retcode})`;
      pending.reject(new Error(errMsg));
    }

    return true;
  }

  /**
   * 清理所有在途调用 (如连接中断时)
   */
  clear(reason = "WebSocket 连接已断开") {
    for (const [echo, pending] of this.pendingCalls.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingCalls.clear();
  }
}

export default OneBotRpcManager;
