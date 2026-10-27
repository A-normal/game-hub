/**
 * @file packages/channel/napcat/src/index.mjs
 * @description NapCat OneBotv11 网关标准导出
 */

export * from "./rpc.mjs";
export * from "./server.mjs";

import { NapCatGateway } from "./server.mjs";
export const configSchema={type:"object",additionalProperties:false,required:["accessToken"],properties:{host:{type:"string",minLength:1},port:{type:"number",minimum:0,maximum:65535},path:{type:"string",pattern:"^/"},accessToken:{type:"string",minLength:1}}};
export default NapCatGateway;
export function createModule({ config, dispatcher }) {
  const gateway = new NapCatGateway({ ...config, port: Number(config.port ?? 8080), dispatcher });
  gateway.id = "napcat";
  gateway.kind = "channel";
  gateway.contractVersion = 1;
  gateway.platforms = ["qq-napcat"];
  gateway.capabilities = ["text","image","quote","notice","file","attachment-read"];
  return gateway;
}
