import { TelegramChannel } from "./channel.mjs";
export { TelegramChannel } from "./channel.mjs";
export { BotApiClient } from "./client.mjs";
export { shapeUpdate } from "./shaper.mjs";
export const configSchema = {
  type: "object", additionalProperties: false, required: ["botApiToken"], properties: {
    botApiToken: { type: "string", minLength: 3, maxLength: 512, pattern: "^[0-9]+:[A-Za-z0-9_-]+$" },
    apiBaseUrl: { type: "string", minLength: 1 }, httpsProxyUrl: { type: "string" },
    requestTimeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
    pollTimeoutSeconds: { type: "integer", minimum: 1, maximum: 50 },
    maxAttachmentBytes: { type: "integer", minimum: 1, maximum: 20 * 1024 * 1024 }
  }
};
export function createModule({ config, dispatcher, vault }) { return new TelegramChannel({ config, dispatcher, vault }); }
