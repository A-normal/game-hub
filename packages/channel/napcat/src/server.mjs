/**
 * @file packages/channel/napcat/src/server.mjs
 * @description NapCat OneBotv11 反向 WebSocket 网关服务器
 * 严格解决 P0-02 (默认仅绑定环回口 127.0.0.1，强制 Token 鉴权，建立受信边界)
 * 严格解决 P1-07 (基于 Echo 异步关联与超时重试，确保回复交付可靠性)
 * 提供全链路可观测性入站/出站/握手结构化日志
 */

import http from "node:http";
import { WebSocketServer } from "ws";
import { InboundShaper, logger } from "@game-hub/core";
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
    this.port = options.port ?? 8080;
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
        const remoteIp = socket.remoteAddress || req.socket.remoteAddress || "未知IP";
        const urlObj = new URL(req.url, `http://${this.host}:${this.port}`);

        // 路径校验
        if (urlObj.pathname !== this.path && urlObj.pathname !== "/") {
          logger.warn("Gateway", `拒绝握手: 路径不匹配 [${urlObj.pathname}] (客户端IP: ${remoteIp})`);
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
            logger.warn("Gateway", `拒绝握手: Token 鉴权失败 (客户端IP: ${remoteIp})`);
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
        }

        logger.info("Gateway", `握手鉴权成功 (客户端IP: ${remoteIp}, 路径: ${urlObj.pathname})`);

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      });

      this.wss.on("connection", (ws, req) => {
        const remoteIp = req.socket?.remoteAddress || "未知IP";
        this.activeSockets.add(ws);
        logger.info("Gateway", `OneBot 客户端已在线 (当前活跃会话数: ${this.activeSockets.size}, 远端: ${remoteIp})`);

        ws.on("message", async (data) => {
          let payload;
          try {
            payload = JSON.parse(data.toString());
          } catch {
            logger.debug("Gateway", "忽略畸形非 JSON 数据包");
            return;
          }
          if (payload.self_id) ws.gameHubSelfId=String(payload.self_id);

          // 1. 若为 API 响应包，交由 RPC 管理器根据 echo 唤醒等待的 Promise (解决 P1-07)
          if (payload.echo) {
            this.rpc.handleIncoming(payload);
            return;
          }

          // 2. 心跳与生命周期消息处理
          if (payload.post_type === "meta_event") {
            if (payload.meta_event_type === "heartbeat") {
              logger.debug("Gateway:Heartbeat", `收到客户端心跳 (status: ${payload.status?.online ? "在线" : "离线"})`);
            }
            return;
          }

          // 3. 聊天消息事件处理
          if (payload.post_type === "message") {
            const isGroup = payload.message_type === "group";
            const targetDesc = isGroup ? `[群聊 ${payload.group_id}]` : `[私聊]`;
            const senderDesc = `${payload.user_id} (${payload.sender?.nickname || payload.sender?.card || "匿名"})`;

            logger.info("Gateway:Ingress", `${targetDesc} 来自 ${senderDesc} (消息正文不写入日志)`);

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

              const startSend = Date.now();
              try {
                const apiRes = await this.rpc.callApi(ws, "send_msg", params);
                const cost = Date.now() - startSend;
                logger.info("Gateway:Egress", `回复已送达 -> ${targetDesc} (耗时: ${cost}ms)`);
                return {
                  success: true,
                  messageId: String(apiRes.data?.message_id || "")
                };
              } catch (err) {
                const cost = Date.now() - startSend;
                logger.error("Gateway:Egress", `回复送达失败 -> ${targetDesc} (耗时: ${cost}ms): ${err.message}`);
                return {
                  success: false,
                  error: err.message
                };
              }
            };

            // 通过 InboundShaper 归一化为 EventEnvelope
            const eventEnvelope = InboundShaper.shape(payload, { sendFunction });

            // 注入微内核调度器
            try {
              await this.dispatcher.dispatch(eventEnvelope);
            } catch (dispatchErr) {
              logger.error("Gateway", "消息分发异常（正文与凭据不写入日志）");
            }
          }
        });

        ws.on("close", (code, reason) => {
          this.activeSockets.delete(ws);
          this.rpc.clear("客户端已断开连接");
          logger.warn("Gateway", `OneBot 客户端已断开 (Code: ${code}, 剩余活跃数: ${this.activeSockets.size})`);
        });

        ws.on("error", (err) => {
          this.activeSockets.delete(ws);
          logger.error("Gateway", `套接字底层错误: ${err.message}`);
        });
      });

      this.server.listen(this.port, this.host, () => {
        logger.info("Gateway", `NapCat 接入网关已启动在 ws://${this.host}:${this.port}${this.path}`);
        resolve();
      });

      this.server.on("error", (err) => {
        logger.error("Gateway", `HTTP 监听服务启动失败: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * 平滑停止网关服务
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      logger.info("Gateway", "正在关闭 NapCat 接入网关...");
      for (const socket of this.activeSockets) {
        try {
          socket.terminate();
        } catch {}
      }
      this.activeSockets.clear();
      this.rpc.clear("网关正在关闭");

      if (this.wss) {
        this.wss.close();
      }

      if (this.server) {
        this.server.close(() => {
          logger.info("Gateway", "NapCat 接入网关已完全退出");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
  async send(target, message) {
    const sockets=[...this.activeSockets].filter(ws=>ws.readyState===1 && (!target.botId || ws.gameHubSelfId===String(target.botId)));
    if (sockets.length!==1) throw Object.assign(new Error("No unambiguous OneBot connection"),{code:"DELIVERY_UNAVAILABLE"});
    const params={message_type:target.isGroup?"group":"private",message:[{type:"text",data:{text:String(message)}}],...(target.isGroup?{group_id:target.groupId}:{user_id:target.userId})};
    const result=await this.rpc.callApi(sockets[0],"send_msg",params);
    return {success:true,messageId:String(result.data?.message_id || "")};
  }
}

export default NapCatGateway;
