/**
 * 微信客服 ChannelPlugin 定义
 *
 * 实现 OpenClaw ChannelPlugin 接口规范
 */

import type { PluginConfig, ResolvedWecomKfAccount } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listAccountIds,
  resolveAccount,
  resolveDefaultAccountId,
  resolveAllowFrom,
} from "./config.js";
import {
  sendKfTextMessage,
  sendKfMessage,
  uploadMedia,
  stripMarkdown,
  createLogger,
} from "./api.js";
import { setWecomKfRuntime } from "./runtime.js";
import { registerWebhookTarget, handleWecomKfWebhookRequest } from "./webhook.js";

// ─── Helpers ────────────────────────────────────────────────

function parseDirectTarget(raw: string): { userId: string; accountId?: string } | null {
  let normalized = raw.trim();
  if (!normalized) return null;

  // Strip channel prefix
  if (normalized.startsWith("wecom-kf:")) {
    normalized = normalized.slice("wecom-kf:".length);
  }

  // Parse accountId suffix: "user:xxx@accountId"
  let accountId: string | undefined;
  const atIdx = normalized.lastIndexOf("@");
  if (atIdx > 0) {
    accountId = normalized.slice(atIdx + 1).trim();
    normalized = normalized.slice(0, atIdx);
  }

  // Strip user: prefix
  if (normalized.startsWith("user:")) {
    normalized = normalized.slice("user:".length);
  }

  if (!normalized) return null;
  return { userId: normalized, accountId };
}

// ─── Config Schema ──────────────────────────────────────────

const WecomKfConfigJsonSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      webhookPath: { type: "string" },
      token: { type: "string" },
      encodingAESKey: { type: "string" },
      corpId: { type: "string" },
      corpSecret: { type: "string" },
      openKfId: { type: "string" },
      apiBaseUrl: { type: "string" },
      inboundMedia: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          dir: { type: "string" },
          maxBytes: { type: "number" },
          keepDays: { type: "number" },
        },
      },
      welcomeText: { type: "string" },
      dmPolicy: {
        type: "string",
        enum: ["open", "pairing", "allowlist", "disabled"],
      },
      allowFrom: { type: "array", items: { type: "string" } },
      defaultAccount: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            webhookPath: { type: "string" },
            token: { type: "string" },
            encodingAESKey: { type: "string" },
            corpId: { type: "string" },
            corpSecret: { type: "string" },
            openKfId: { type: "string" },
            apiBaseUrl: { type: "string" },
            inboundMedia: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                dir: { type: "string" },
                maxBytes: { type: "number" },
                keepDays: { type: "number" },
              },
            },
            welcomeText: { type: "string" },
            dmPolicy: {
              type: "string",
              enum: ["open", "pairing", "allowlist", "disabled"],
            },
            allowFrom: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

// ─── Unregister Hooks ───────────────────────────────────────

const unregisterHooks = new Map<string, () => void>();

// ─── Channel Plugin ─────────────────────────────────────────

const meta = {
  id: "wecom-kf" as const,
  label: "WeCom KF",
  selectionLabel: "WeCom Customer Service (微信客服)",
  docsPath: "/channels/wecom-kf",
  docsLabel: "wecom-kf",
  blurb: "微信客服渠道，支持外部微信用户通过客服系统与 AI 交互",
  aliases: ["weixin-kf", "微信客服", "企微客服"] as const,
  order: 83,
};

export const wecomKfPlugin = {
  id: "wecom-kf",
  meta: { ...meta },
  capabilities: {
    chatTypes: ["direct"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: false,
    polls: false,
    activeSend: true,
  },
  messaging: {
    normalizeTarget: (raw: string) => {
      const parsed = parseDirectTarget(raw);
      if (!parsed) return undefined;
      return `user:${parsed.userId}${parsed.accountId ? `@${parsed.accountId}` : ""}`;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw).trim();
        return Boolean(parseDirectTarget(candidate));
      },
      hint: "Use external_userid only: user:<external_userid> (optional @accountId).",
    },
    formatTargetDisplay: (params: { target: string; display?: string }) => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return params.display?.trim() || params.target;
      return `user:${parsed.userId}`;
    },
  },
  configSchema: WecomKfConfigJsonSchema,
  reload: { configPrefixes: ["channels.wecom-kf"] },
  config: {
    listAccountIds: (cfg: PluginConfig) => listAccountIds(cfg),
    resolveAccount: (cfg: PluginConfig, accountId?: string) =>
      resolveAccount(cfg, accountId),
    defaultAccountId: (cfg: PluginConfig) => resolveDefaultAccountId(cfg),
    setAccountEnabled: (params: {
      cfg: PluginConfig;
      accountId?: string;
      enabled: boolean;
    }) => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccount = Boolean(
        params.cfg.channels?.["wecom-kf"]?.accounts?.[accountId]
      );
      if (!useAccount) {
        return {
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            "wecom-kf": {
              ...(params.cfg.channels?.["wecom-kf"] ?? {}),
              enabled: params.enabled,
            },
          },
        };
      }
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          "wecom-kf": {
            ...(params.cfg.channels?.["wecom-kf"] ?? {}),
            accounts: {
              ...(params.cfg.channels?.["wecom-kf"]?.accounts ?? {}),
              [accountId]: {
                ...(params.cfg.channels?.["wecom-kf"]?.accounts?.[accountId] ??
                  {}),
                enabled: params.enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }) => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const next = { ...params.cfg };
      const current = next.channels?.["wecom-kf"];
      if (!current) return next;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { accounts: _ignored, defaultAccount: _ignored2, ...rest } =
          current;
        next.channels = {
          ...next.channels,
          "wecom-kf": { ...rest, enabled: false },
        };
        return next;
      }
      const accounts = { ...(current.accounts ?? {}) };
      delete accounts[accountId];
      next.channels = {
        ...next.channels,
        "wecom-kf": {
          ...current,
          accounts:
            Object.keys(accounts).length > 0 ? accounts : undefined,
        },
      };
      return next;
    },
    isConfigured: (account: ResolvedWecomKfAccount) => account.configured,
    describeAccount: (account: ResolvedWecomKfAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      canSendActive: account.canSendActive,
      webhookPath: account.config.webhookPath ?? "/wecom-kf",
    }),
    resolveAllowFrom: (params: {
      cfg: PluginConfig;
      accountId?: string;
    }) => {
      const account = resolveAccount(params.cfg, params.accountId);
      return resolveAllowFrom(account.config);
    },
    formatAllowFrom: (params: { allowFrom: (string | number)[] }) =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  directory: {
    canResolve: (params: { target: string }) => {
      return Boolean(parseDirectTarget(params.target));
    },
    resolveTarget: (params: { cfg: PluginConfig; target: string }) => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return null;
      return {
        channel: "wecom-kf",
        accountId: parsed.accountId,
        to: parsed.userId,
      };
    },
    resolveTargets: (params: {
      cfg: PluginConfig;
      targets: string[];
    }) => {
      const results: Array<{
        channel: string;
        accountId?: string;
        to: string;
      }> = [];
      for (const target of params.targets) {
        const resolved = wecomKfPlugin.directory.resolveTarget({
          cfg: params.cfg,
          target,
        });
        if (resolved) results.push(resolved);
      }
      return results;
    },
    getTargetFormats: () => [
      "wecom-kf:user:<external_userid>",
      "user:<external_userid>",
      "<external_userid>",
    ],
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      text: string;
      options?: { markdown?: boolean };
    }) => {
      const account = resolveAccount(params.cfg, params.accountId);
      if (!account.canSendActive) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error(
            "Account not configured for active sending (missing corpId, corpSecret, or openKfId)"
          ),
        };
      }
      const parsed = parseDirectTarget(params.to);
      if (!parsed) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error(`Unsupported target for WeCom KF: ${params.to}`),
        };
      }
      try {
        const result = await sendKfTextMessage(
          account,
          parsed.userId,
          params.text
        );
        return {
          channel: "wecom-kf",
          ok: result.errcode === 0,
          messageId: result.msgid ?? "",
          error:
            result.errcode !== 0
              ? new Error(result.errmsg ?? "send failed")
              : undefined,
        };
      } catch (err) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    sendMedia: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      mediaUrl: string;
      text?: string;
      mimeType?: string;
    }) => {
      const account = resolveAccount(params.cfg, params.accountId);
      if (!account.canSendActive || !account.openKfId) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error(
            "Account not configured for active sending"
          ),
        };
      }
      const parsed = parseDirectTarget(params.to);
      if (!parsed) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error(`Unsupported target for WeCom KF: ${params.to}`),
        };
      }
      try {
        // Send caption text first if present
        if (params.text?.trim()) {
          try {
            await sendKfTextMessage(account, parsed.userId, params.text);
          } catch {
            // Continue even if caption fails
          }
        }

        // Download and upload media
        let buffer: Buffer;
        let contentType: string | undefined;

        if (
          params.mediaUrl.startsWith("http://") ||
          params.mediaUrl.startsWith("https://")
        ) {
          const resp = await fetch(params.mediaUrl);
          if (!resp.ok)
            throw new Error(`Download failed: HTTP ${resp.status}`);
          buffer = Buffer.from(await resp.arrayBuffer());
          contentType =
            resp.headers.get("content-type") ?? undefined;
        } else {
          const fs = await import("fs");
          buffer = await fs.promises.readFile(params.mediaUrl);
        }

        // Determine media type
        const mime = (
          params.mimeType ??
          contentType ??
          ""
        ).toLowerCase();
        const isImage = mime.startsWith("image/");
        const mediaType = isImage ? "image" : "file";

        const mediaId = await uploadMedia(
          account,
          buffer,
          "media",
          contentType,
          mediaType
        );

        const result = await sendKfMessage(account, {
          touser: parsed.userId,
          open_kfid: account.openKfId,
          msgtype: mediaType,
          [mediaType]: { media_id: mediaId },
        });

        return {
          channel: "wecom-kf",
          ok: result.errcode === 0,
          messageId: result.msgid ?? "",
          error:
            result.errcode !== 0
              ? new Error(result.errmsg ?? "send failed")
              : undefined,
        };
      } catch (err) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },
  gateway: {
    startAccount: async (ctx: {
      cfg: PluginConfig;
      runtime?: unknown;
      abortSignal?: AbortSignal;
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }) => {
      ctx.setStatus?.({ accountId: ctx.accountId });

      if (ctx.runtime) {
        const candidate = ctx.runtime as any;
        if (
          candidate.channel?.routing?.resolveAgentRoute &&
          candidate.channel?.reply?.dispatchReplyFromConfig
        ) {
          setWecomKfRuntime(ctx.runtime as any);
        }
      }

      const account = resolveAccount(ctx.cfg, ctx.accountId);
      if (!account.configured) {
        ctx.log?.info(
          `[wecom-kf] account ${ctx.accountId} not configured; webhook not registered`
        );
        ctx.setStatus?.({
          accountId: ctx.accountId,
          running: false,
          configured: false,
        });
        return;
      }

      const path = (
        account.config.webhookPath ?? "/wecom-kf"
      ).trim();
      const unregister = registerWebhookTarget({
        account,
        config: ctx.cfg ?? {},
        runtime: {
          log: ctx.log?.info ?? console.log,
          error: ctx.log?.error ?? console.error,
        },
        path,
        statusSink: (patch) =>
          ctx.setStatus?.({ accountId: ctx.accountId, ...patch }),
      });

      const existing = unregisterHooks.get(ctx.accountId);
      if (existing) existing();
      unregisterHooks.set(ctx.accountId, unregister);

      ctx.log?.info(
        `[wecom-kf] webhook registered at ${path} for account ${ctx.accountId} (canSendActive=${account.canSendActive})`
      );
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: true,
        configured: true,
        canSendActive: account.canSendActive,
        webhookPath: path,
        lastStartAt: Date.now(),
      });
    },
    stopAccount: async (ctx: {
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
    }) => {
      const unregister = unregisterHooks.get(ctx.accountId);
      if (unregister) {
        unregister();
        unregisterHooks.delete(ctx.accountId);
      }
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
