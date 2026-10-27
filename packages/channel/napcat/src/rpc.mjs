/**
 * @file packages/channel/napcat/src/rpc.mjs
 * @description OneBotv11 Echo 异步响应管理器：修复 P1-07 盲发不读取响应与超时缺陷
 */

import {decodeBase64} from "./files.mjs";

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

      this.pendingCalls.set(echo, { resolve, reject, timer, action, ws });

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
  downloadFile(ws,fileId,maxBytes,timeoutMs=30000,action="download_file_stream") {
    if(!ws || ws.readyState!==1)return Promise.reject(new Error("WebSocket 未连接"));
    const echo=`gh_file_${++this.seq}_${Date.now()}`;
    return new Promise((resolve,reject)=>{
      const chunks=[];let size=0,info=null;
      const finish=(error,value)=>{clearTimeout(timer);this.pendingCalls.delete(echo);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(Object.assign(new Error("文件读取超时"),{code:"FILE_TIMEOUT"})),timeoutMs);
      const invalid=()=>Object.assign(new Error("文件流无效或超过大小上限"),{code:"FILE_INVALID"});
      this.pendingCalls.set(echo,{ws,timer,reject,stream:payload=>{
        try {
          if(payload.status==="failed" || (payload.retcode!=null && payload.retcode!==0) || payload.data?.type==="error")return finish(Object.assign(new Error("文件流 API 不可用"),{code:"ONEBOT_API_FAILED"}));
          const data=payload.data;
          if(data?.data_type==="file_info") {
            if(info || !Number.isInteger(data.file_size) || data.file_size<0 || data.file_size>maxBytes)throw invalid();
            info=data;
          } else if(data?.data_type==="file_chunk") {
            if(!info || data.index!==chunks.length || chunks.length>Math.ceil(maxBytes/1024))throw invalid();
            const bytes=decodeBase64(data.data,Math.min(65536,maxBytes-size));
            if(bytes.length!==data.size || !bytes.length)throw invalid();
            size+=bytes.length;chunks.push(bytes);
          } else if(data?.data_type==="file_complete") {
            if(!info || data.total_chunks!==chunks.length || data.total_bytes!==size || info.file_size!==size)throw invalid();
            finish(null,Buffer.concat(chunks,size));
          } else throw invalid();
        } catch(error) {finish(error);}
      }});
      try {ws.send(JSON.stringify({action,params:{file_id:fileId,chunk_size:65536},echo}));}catch(error){finish(error);}
    });
  }

  handleIncoming(payload,ws) {
    if (!payload || !payload.echo) return false;

    const pending = this.pendingCalls.get(payload.echo);
    if (!pending || (ws && pending.ws!==ws)) return false;
    if(pending.stream) {pending.stream(payload);return true;}

    clearTimeout(pending.timer);
    this.pendingCalls.delete(payload.echo);

    if (payload.status === "ok" || payload.retcode === 0) {
      pending.resolve(payload);
    } else {
      const errMsg = payload.wording || payload.message || `OneBot API 失败 (retcode: ${payload.retcode})`;
      pending.reject(Object.assign(new Error(errMsg),{code:"ONEBOT_API_FAILED",retcode:payload.retcode}));
    }

    return true;
  }

  /**
   * 清理所有在途调用 (如连接中断时)
   */
  clear(reason = "WebSocket 连接已断开",ws) {
    for (const [echo, pending] of this.pendingCalls.entries()) {
      if(ws && pending.ws!==ws)continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingCalls.delete(echo);
    }
  }
}

export default OneBotRpcManager;
