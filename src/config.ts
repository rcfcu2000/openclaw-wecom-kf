/**
 * 微信客服账户配置管理
 */

import type {
  PluginConfig,
  ResolvedWecomKfAccount,
  WecomKfAccountConfig,
  WecomKfConfig,
} from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

const DEFAULT_API_BASE_URL = "https://qyapi.weixin.qq.com";

// ─── Config Accessors ───────────────────────────────────────

function getChannelConfig(cfg: PluginConfig): WecomKfConfig | undefined {
  return cfg.channels?.["wecom-kf"];
}

export function resolveApiBaseUrl(config: WecomKfAccountConfig): string {
  const raw = (config.apiBaseUrl ?? "").trim();
  if (!raw) return DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// ─── DM Policy ──────────────────────────────────────────────

export function resolveDmPolicy(
  config: WecomKfAccountConfig
): string {
  return config.dmPolicy ?? "open";
}

export function resolveAllowFrom(
  config: WecomKfAccountConfig
): string[] {
  return config.allowFrom ?? [];
}

export function checkDmPolicy(params: {
  dmPolicy: string;
  senderId: string;
  allowFrom?: string[];
}): { allowed: boolean; reason?: string } {
  const { dmPolicy, senderId, allowFrom = [] } = params;
  switch (dmPolicy) {
    case "open":
      return { allowed: true };
    case "pairing":
      return { allowed: true };
    case "allowlist":
      if (allowFrom.includes(senderId)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `sender ${senderId} not in DM allowlist`,
      };
    case "disabled":
      return { allowed: false, reason: "DM disabled" };
    default:
      return { allowed: true };
  }
}

// ─── Inbound Media ──────────────────────────────────────────

import { homedir } from "os";
import { join } from "path";

const DEFAULT_INBOUND_MEDIA_DIR = join(
  homedir(),
  ".openclaw",
  "media",
  "wecom-kf",
  "inbound"
);
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_INBOUND_MEDIA_KEEP_DAYS = 7;

export function resolveInboundMediaEnabled(
  config: WecomKfAccountConfig
): boolean {
  if (typeof config.inboundMedia?.enabled === "boolean")
    return config.inboundMedia.enabled;
  return true;
}

export function resolveInboundMediaDir(config: WecomKfAccountConfig): string {
  return (config.inboundMedia?.dir ?? "").trim() || DEFAULT_INBOUND_MEDIA_DIR;
}

export function resolveInboundMediaMaxBytes(
  config: WecomKfAccountConfig
): number {
  const v = config.inboundMedia?.maxBytes;
  if (typeof v === "number" && v > 0) return v;
  return DEFAULT_INBOUND_MEDIA_MAX_BYTES;
}

export function resolveInboundMediaKeepDays(
  config: WecomKfAccountConfig
): number {
  const v = config.inboundMedia?.keepDays;
  if (typeof v === "number") return v;
  return DEFAULT_INBOUND_MEDIA_KEEP_DAYS;
}

// ─── Account Resolution ─────────────────────────────────────

export function listAccountIds(cfg: PluginConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return [];
  const ids: string[] = [DEFAULT_ACCOUNT_ID];
  const accounts = channelCfg.accounts;
  if (accounts) {
    for (const id of Object.keys(accounts)) {
      if (id !== DEFAULT_ACCOUNT_ID) {
        ids.push(id);
      }
    }
  }
  return ids;
}

export function resolveDefaultAccountId(cfg: PluginConfig): string {
  const channelCfg = getChannelConfig(cfg);
  return channelCfg?.defaultAccount?.trim() || DEFAULT_ACCOUNT_ID;
}

export function resolveAccount(
  cfg: PluginConfig,
  accountId?: string
): ResolvedWecomKfAccount {
  const channelCfg = getChannelConfig(cfg);
  const id = accountId?.trim() || resolveDefaultAccountId(cfg);
  const isDefault = id === DEFAULT_ACCOUNT_ID;

  // Merge top-level + per-account config
  const topLevel: WecomKfAccountConfig = channelCfg ?? {};
  const perAccount: WecomKfAccountConfig =
    channelCfg?.accounts?.[id] ?? {};
  const merged: WecomKfAccountConfig = { ...topLevel, ...perAccount };

  // Resolve with env fallbacks for default account
  const corpId =
    merged.corpId?.trim() ||
    (isDefault ? process.env.WECOM_KF_CORP_ID?.trim() : undefined) ||
    undefined;
  const corpSecret =
    merged.corpSecret?.trim() ||
    (isDefault ? process.env.WECOM_KF_CORP_SECRET?.trim() : undefined) ||
    undefined;
  const openKfId =
    merged.openKfId?.trim() ||
    (isDefault ? process.env.WECOM_KF_OPEN_KF_ID?.trim() : undefined) ||
    undefined;
  const token =
    merged.token?.trim() ||
    (isDefault ? process.env.WECOM_KF_TOKEN?.trim() : undefined) ||
    undefined;
  const encodingAESKey =
    merged.encodingAESKey?.trim() ||
    (isDefault
      ? process.env.WECOM_KF_ENCODING_AES_KEY?.trim()
      : undefined) ||
    undefined;

  const configured = Boolean(
    token && encodingAESKey && corpId && corpSecret && openKfId
  );
  const canSendActive = Boolean(corpId && corpSecret && openKfId);
  const enabled = merged.enabled !== false;

  return {
    accountId: id,
    name: merged.name,
    enabled,
    configured,
    token,
    encodingAESKey,
    corpId,
    corpSecret,
    openKfId,
    canSendActive,
    config: merged,
  };
}

export function isConfigured(account: ResolvedWecomKfAccount): boolean {
  return account.configured;
}

export function describeAccount(account: ResolvedWecomKfAccount): {
  accountId: string;
  name: string | undefined;
  enabled: boolean;
  configured: boolean;
  canSendActive: boolean;
  webhookPath: string;
} {
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    canSendActive: account.canSendActive,
    webhookPath: account.config.webhookPath ?? "/wecom-kf",
  };
}
