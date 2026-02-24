/**
 * openclaw-wecom-kf
 * 微信客服渠道插件入口
 *
 * 导出:
 * - wecomKfPlugin: ChannelPlugin 实现
 * - DEFAULT_ACCOUNT_ID: 默认账户 ID
 * - setWecomKfRuntime / getWecomKfRuntime: 运行时管理
 * - sendKfTextMessage: 主动发送文本消息
 * - getAccessToken: 获取 Access Token
 * - sendWecomKfDM: 发送私聊消息
 * - stripMarkdown: Markdown 转纯文本
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { MoltbotPluginApi } from "./types.js";
import { wecomKfPlugin } from "./channel.js";
import { setWecomKfRuntime, getWecomKfRuntime } from "./runtime.js";
import { handleWecomKfWebhookRequest } from "./webhook.js";

// Re-exports
export { DEFAULT_ACCOUNT_ID, resolveAccount, listAccountIds } from "./config.js";
export {
  getAccessToken,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
  sendKfMessage,
  sendKfTextMessage,
  sendKfWelcomeMessage,
  syncMessages,
  stripMarkdown,
  splitMessageByBytes,
} from "./api.js";
export { setWecomKfRuntime, getWecomKfRuntime, tryGetWecomKfRuntime } from "./runtime.js";
export { wecomKfPlugin } from "./channel.js";
export { sendWecomKfDM } from "./send.js";
export type {
  WecomKfConfig,
  WecomKfAccountConfig,
  ResolvedWecomKfAccount,
  PluginConfig,
  MoltbotPluginApi,
  SyncMsgItem,
  SyncMsgResponse,
  KfSendMsgParams,
  KfSendMsgResult,
  WecomKfDmPolicy,
} from "./types.js";

// ─── Plugin Entry ───────────────────────────────────────────

const plugin = {
  id: "wecom-kf",
  name: "WeCom KF",
  description: "微信客服渠道插件，支持外部微信用户通过客服系统与 AI 交互",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api: MoltbotPluginApi) {
    if (api.runtime) {
      setWecomKfRuntime(api.runtime as any);
    }
    api.registerChannel({ plugin: wecomKfPlugin });
    if (api.registerHttpHandler) {
      api.registerHttpHandler(handleWecomKfWebhookRequest);
    }
  },
};

export default plugin;
