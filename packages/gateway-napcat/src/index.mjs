/**
 * @file packages/gateway-napcat/src/index.mjs
 * @description NapCat OneBotv11 网关标准导出
 */

export * from "./rpc.mjs";
export * from "./server.mjs";

import { NapCatGateway } from "./server.mjs";
export default NapCatGateway;
