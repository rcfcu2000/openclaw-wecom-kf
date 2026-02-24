import type { IncomingMessage, ServerResponse } from "http";

// ─── DM Policy ──────────────────────────────────────────────
export type WecomKfDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

// ─── Account Config ─────────────────────────────────────────
export type WecomKfAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Webhook 路径 */
  webhookPath?: string;
  /** 回调 Token */
  token?: string;
  /** 回调消息加密密钥 */
  encodingAESKey?: string;
  /** 企业 ID */
  corpId?: string;
  /** 客服应用 Secret */
  corpSecret?: string;
  /** 客服账号 ID (open_kfid) */
  openKfId?: string;
  /** 企业微信 API 基础地址（可选，默认 https://qyapi.weixin.qq.com） */
  apiBaseUrl?: string;
  /** 入站媒体落盘设置 */
  inboundMedia?: {
    enabled?: boolean;
    dir?: string;
    maxBytes?: number;
    keepDays?: number;
  };
  /** 欢迎文本 */
  welcomeText?: string;
  /** DM 策略 */
  dmPolicy?: WecomKfDmPolicy;
  /** DM 允许列表 */
  allowFrom?: string[];
};

// ─── Top-Level Config ───────────────────────────────────────
export type WecomKfConfig = WecomKfAccountConfig & {
  accounts?: Record<string, WecomKfAccountConfig>;
  defaultAccount?: string;
};

// ─── Plugin Config (as seen in openclaw.json) ───────────────
export interface PluginConfig {
  session?: {
    store?: unknown;
  };
  channels?: {
    "wecom-kf"?: WecomKfConfig;
  };
}

// ─── Resolved Account ───────────────────────────────────────
export type ResolvedWecomKfAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  /** 回调 Token */
  token?: string;
  /** 回调消息加密密钥 */
  encodingAESKey?: string;
  /** 企业 ID */
  corpId?: string;
  /** 客服应用 Secret */
  corpSecret?: string;
  /** 客服账号 ID */
  openKfId?: string;
  /** 是否支持主动发送 (corpId + corpSecret + openKfId 均已配置) */
  canSendActive: boolean;
  config: WecomKfAccountConfig;
};

// ─── Access Token Cache ─────────────────────────────────────
export type AccessTokenCacheEntry = {
  token: string;
  expiresAt: number;
};

// ─── Sync Message Types ─────────────────────────────────────
export type SyncMsgItemBase = {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  /** 3=customer, 4=system, 5=kf agent */
  origin: number;
  servicer_userid?: string;
};

export type SyncMsgText = SyncMsgItemBase & {
  msgtype: "text";
  text: { content: string; menu_id?: string };
};

export type SyncMsgImage = SyncMsgItemBase & {
  msgtype: "image";
  image: { media_id: string };
};

export type SyncMsgVoice = SyncMsgItemBase & {
  msgtype: "voice";
  voice: { media_id: string };
};

export type SyncMsgVideo = SyncMsgItemBase & {
  msgtype: "video";
  video: { media_id: string };
};

export type SyncMsgFile = SyncMsgItemBase & {
  msgtype: "file";
  file: { media_id: string };
};

export type SyncMsgLocation = SyncMsgItemBase & {
  msgtype: "location";
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
};

export type SyncMsgLink = SyncMsgItemBase & {
  msgtype: "link";
  link: { title?: string; desc?: string; url?: string; pic_url?: string };
};

export type SyncMsgBusinessCard = SyncMsgItemBase & {
  msgtype: "business_card";
  business_card: { userid: string };
};

export type SyncMsgMiniprogram = SyncMsgItemBase & {
  msgtype: "miniprogram";
  miniprogram: {
    title?: string;
    appid?: string;
    pagepath?: string;
    thumb_media_id?: string;
  };
};

export type SyncMsgMsgMenu = SyncMsgItemBase & {
  msgtype: "msgmenu";
  msgmenu: {
    head_content?: string;
    tail_content?: string;
    list?: Array<{
      type: "click" | "view" | "miniprogram";
      click?: { id: string; content: string };
      view?: { url: string; content: string };
      miniprogram?: { appid: string; pagepath: string; content: string };
    }>;
  };
};

export type SyncMsgEvent = SyncMsgItemBase & {
  msgtype: "event";
  event: {
    event_type: string;
    open_kfid?: string;
    external_userid?: string;
    scene?: string;
    scene_param?: string;
    welcome_code?: string;
    wechat_channels?: unknown;
    fail_msgid?: string;
    fail_type?: number;
    servicer_userid?: string;
    status?: number;
    change_type?: number;
    old_servicer_userid?: string;
    new_servicer_userid?: string;
    msg_code?: string;
    recall_msgid?: string;
  };
};

export type SyncMsgItem =
  | SyncMsgText
  | SyncMsgImage
  | SyncMsgVoice
  | SyncMsgVideo
  | SyncMsgFile
  | SyncMsgLocation
  | SyncMsgLink
  | SyncMsgBusinessCard
  | SyncMsgMiniprogram
  | SyncMsgMsgMenu
  | SyncMsgEvent
  | (SyncMsgItemBase & { msgtype: string; [key: string]: unknown });

export type SyncMsgResponse = {
  errcode: number;
  errmsg: string;
  next_cursor: string;
  has_more: number;
  msg_list: SyncMsgItem[];
};

// ─── Send Message Types ─────────────────────────────────────
export type KfSendMsgParams = {
  touser: string;
  open_kfid: string;
  msgid?: string;
  msgtype: string;
  [key: string]: unknown;
};

export type KfSendMsgResult = {
  errcode: number;
  errmsg: string;
  msgid?: string;
};

// ─── Webhook Target ─────────────────────────────────────────
export type WebhookTarget = {
  account: ResolvedWecomKfAccount;
  config: PluginConfig;
  runtime: {
    log: (msg: string) => void;
    error: (msg: string) => void;
  };
  path: string;
  statusSink?: (patch: Record<string, unknown>) => void;
};

// ─── Plugin Runtime ─────────────────────────────────────────
export interface PluginRuntime {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  channel?: {
    routing?: {
      resolveAgentRoute?: (params: {
        cfg: unknown;
        channel: string;
        accountId?: string;
        peer: { kind: string; id: string };
      }) => {
        sessionKey: string;
        accountId: string;
        agentId?: string;
        mainSessionKey?: string;
      };
    };
    reply?: {
      dispatchReplyFromConfig?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcher?: unknown;
        replyOptions?: unknown;
      }) => Promise<{
        queuedFinal: boolean;
        counts: { final: number };
      }>;
      dispatchReplyWithBufferedBlockDispatcher?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text?: string }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }) => Promise<void>;
      finalizeInboundContext?: (ctx: unknown) => unknown;
      resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
      formatAgentEnvelope?: (params: {
        channel: string;
        from: string;
        previousTimestamp?: number;
        envelope?: unknown;
        body: string;
      }) => string;
    };
    session?: {
      resolveStorePath?: (
        store: unknown,
        params: { agentId?: string }
      ) => string | undefined;
      readSessionUpdatedAt?: (params: {
        storePath?: string;
        sessionKey: string;
      }) => number | null;
      recordInboundSession?: (params: {
        storePath: string;
        sessionKey: string;
        ctx: unknown;
        updateLastRoute?: {
          sessionKey: string;
          channel: string;
          to: string;
          accountId?: string;
          threadId?: string | number;
        };
        onRecordError?: (err: unknown) => void;
      }) => Promise<void>;
    };
    text?: {
      resolveMarkdownTableMode?: (params: {
        cfg: unknown;
        channel: string;
        accountId?: string;
      }) => unknown;
      convertMarkdownTables?: (text: string, mode: unknown) => string;
    };
  };
  system?: {
    enqueueSystemEvent?: (message: string, options?: unknown) => void;
  };
  [key: string]: unknown;
}

// ─── Moltbot Plugin API ─────────────────────────────────────
export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  registerHttpHandler?: (
    handler: (
      req: IncomingMessage,
      res: ServerResponse
    ) => Promise<boolean> | boolean
  ) => void;
  runtime?: unknown;
  config?: PluginConfig;
  [key: string]: unknown;
}
