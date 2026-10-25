/**
 * @file packages/provider/mihoyo/src/index.mjs
 * @description 米哈游社区驱动 SPI 导出
 */

import { MihoyoTakumiClient } from "./client.mjs";
import { getDs1, getDs2, SALTS } from "./signer.mjs";
export const configSchema={type:"object",additionalProperties:false,properties:{timeoutMs:{type:"number",minimum:1000,maximum:60000}}};

export class MihoyoCommunityProvider {
  constructor(options={}) {
    this.options=options;
    this.id = "mihoyo";
    this.kind = "provider";
    this.contractVersion = 1;
    this.capabilities = ["game-record", "account", "sign", "gacha"];
    this.name = "米游社";
  }

  /**
   * 工厂方法：为指定凭据与设备创建专用的 Takumi 请求客户端
   * @param {string | Record<string, any>} cookies
   * @param {Object} [device]
   * @returns {MihoyoTakumiClient}
   */
  createClient(cookies, device) {
    return new MihoyoTakumiClient(cookies, device,this.options);
  }

  /**
   * 通用网关调用入口 (兼容 SPI ICommunityProvider 契约)
   * @param {import('@game-hub/core').IGatewayRequestOptions} options
   */
  async requestGateway(options) {
    const client = new MihoyoTakumiClient(options.credentials?.cookie || {}, {
      device_id: options.credentials?.deviceId,
      device_fp: options.credentials?.deviceFp
    });
    return client.request(options.url, {
      method: options.method,
      query: options.query,
      body: options.body,
      headers: options.headers
    });
  }
}

export {
  MihoyoTakumiClient,
  getDs1,
  getDs2,
  SALTS
};

export default MihoyoCommunityProvider;
export function createModule({config={}}={}) { return new MihoyoCommunityProvider(config); }
