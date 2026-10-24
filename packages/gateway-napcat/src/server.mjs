/**
 * @file packages/gateway-napcat/src/server.mjs
 * @description NapCat OneBotv11 反向 WebSocket 网关服务器
 * 严格解决 P0-02 (默认仅绑定环回口 127.0.0.1，强制 Token 鉴权，建立受信边界)
 * 严格解决 P1-07 (基于 Echo 异步关联与超时重试，确保回复交付可靠性)
 */

import http from "node:http";
import { WebSocketServer } from "ws";
import { InboundShaper } from "@game-hub/core";
import { OneBotRpcManager } from "./rpc.mjs";

export class NapCatGateway {
  /**
   * @param {Object} options
   * @param {import('@game-hub/core').GameHubDispatcher} options.dispatcher - 调度微内核
   * @param {string} [options.host="127.0.0.1"] - 监听网卡 (默认仅绑定环回口，严禁默认 0.0.0.0)
   * @param {number} [options.port=8080] - 监听端口
   * @param {string} [options.path="/onebot/v11/ws"] - WebSocket 接入路径
   * @param {string} [options.accessToken] - 可选接入密钥 (配置后强制校验)
   */
  constructor(options) {
    if (!options || !options.dispatcher) {
      throw new Error("NapCatGateway 需要传入有效的 dispatcher 实例");
    }
    this.dispatcher = options.dispatcher;
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 8080;
    this.path = options.path || "/onebot/v11/ws";
    this.accessToken = options.accessToken || "";

    this.server = null;
    this.wss = null;
    this.rpc = new OneBotRpcManager();
    /** @type {Set<any>} */
    this.activeSockets = new Set();
  }

  /**
   * 启动网关服务
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      // 1. 创建原生 HTTP 服务器以处理 Token 握手鉴权 (解决 P0-02)
      this.server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({
        noServer: true
      });

      this.server.on("upgrade", (req, socket, head) => {
        const urlObj = new URL(req.url, `http://${this.host}:${this.port}`);

        // 路径校验
        if (urlObj.pathname !== this.path && urlObj.pathname !== "/") {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }

        // Token 鉴权校验 (解决 P0-02)
        if (this.accessToken) {
          const authHeader = req.headers["authorization"] || "";
          const tokenFromHeader = authHeader.replace(/^Bearer\s+/i, "").trim();
          const tokenFromQuery = urlObj.searchParams.get("access_token") || "";

          if (tokenFromHeader !== this.accessToken && tokenFromQuery !== this.accessToken) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      });

      this.wss.on("connection", (ws, req) => {
        this.activeSockets.add(ws);

        ws.on("message", async (data) => {
          let payload;
          try {
            payload = JSON.parse(data.toString());
          } catch {
            return; // 忽略畸形非 JSON 数据包
          }

          // 1. 若为 API 响应包，交由 RPC 管理器根据 echo 唤醒等待的 Promise (解决 P1-07)
          if (payload.echo) {
            this.rpc.handleIncoming(payload);
            return;
          }

          // 2. 心跳与生命周期消息处理
          if (payload.post_type === "meta_event") {
            return;
          }

          // 3. 聊天消息事件处理
          if (payload.post_type === "message") {
            // 定义可靠回复闭包：通过带 echo 的 OneBot RPC 发送并等待真实交付确认 (解决 P1-07)
            const sendFunction = async (target, content, replyOpts = {}) => {
              const msgType = payload.message_type || (target.isGroup ? "group" : "private");
              const message = typeof content === "string" ? content : (content.content || "");

              const params = {
                message_type: msgType,
                user_id: payload.user_id,
                message: message
              };

              if (msgType === "group" && payload.group_id) {
                params.group_id = payload.group_id;
              }

              if (replyOpts.quote && payload.message_id) {
                params.message = `[CQ:reply,id=${payload.message_id}]${params.message}`;
              }

              try {
                const apiRes = await this.rpc.callApi(ws, "send_msg", params);
                return {
                  success: true,
                  messageId: String(apiRes.data?.message_id || "")
                };
              } catch (err) {
                return {
                  success: false,
                  error: err.message
                };
              }
            };

            // 通过 InboundShaper 归一化为 EventEnvelope
            const eventEnvelope = InboundShaper.shape(payload, { sendFunction });

            // 注入微内核调度器
            await this.dispatcher.dispatch(eventEnvelope);
          }
        });

        ws.on("close", () => {
          this.activeSockets.delete(ws);
          this.rpc.clear("客户端已断开连接");
        });

        ws.on("error", () => {
          this.activeSockets.delete(ws);
        });
      });

      this.server.listen(this.port, this.host, () => {
        resolve();
      });

      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * 关闭网关
   */
  async stop() {
    this.rpc.clear("网关服务已关闭");
    for (const ws of this.activeSockets) {
      ws.terminate();
    }
    this.activeSockets.clear();

    if (this.wss) {
      await new Promise(r => this.wss.close(r));
    }
    if (this.server) {
      await new Promise(r => this.server.close(r));
    }
  }
}

export default NapCatGateway;
