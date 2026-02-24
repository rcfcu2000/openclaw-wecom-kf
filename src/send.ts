/**
 * 微信客服消息发送封装
 *
 * 提供业务层简化 API，统一调用入口
 */

import type { ResolvedWecomKfAccount } from "./types.js";
import { sendKfTextMessage, sendKfMessage, uploadMedia } from "./api.js";

// ─── Types ──────────────────────────────────────────────────

export type SendMessageOptions = {
  /** 文本内容 */
  text?: string;
  /** 媒体文件路径或 URL */
  mediaPath?: string;
  /** 客服账号 ID (open_kfid)，不传则使用 account 配置中的值 */
  openKfId?: string;
};

export type SendResult = {
  ok: boolean;
  msgid?: string;
  error?: string;
};

// ─── Target Parsing ─────────────────────────────────────────

/**
 * Parse target string, stripping channel prefix.
 * "wecom-kf:user:xxx" → "xxx"
 * "user:xxx" → "xxx"
 * "xxx" → "xxx"
 */
function parseExternalUserId(target: string): string {
  let normalized = target.trim();
  if (normalized.startsWith("wecom-kf:")) {
    normalized = normalized.slice("wecom-kf:".length);
  }
  if (normalized.startsWith("user:")) {
    normalized = normalized.slice("user:".length);
  }
  return normalized;
}

// ─── Send Helpers ───────────────────────────────────────────

export async function sendWecomKfDM(
  account: ResolvedWecomKfAccount,
  externalUserId: string,
  options: SendMessageOptions
): Promise<SendResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      error:
        "Account not configured for active sending (missing corpId or corpSecret)",
    };
  }

  const resolvedOpenKfId = options.openKfId ?? account.openKfId;
  if (!resolvedOpenKfId) {
    return {
      ok: false,
      error:
        "openKfId not available (not in config and not provided in options)",
    };
  }

  const userId = parseExternalUserId(externalUserId);
  const results: SendResult[] = [];

  if (options.text?.trim()) {
    try {
      const result = await sendKfTextMessage(account, userId, options.text, resolvedOpenKfId);
      results.push({
        ok: result.errcode === 0,
        msgid: result.msgid,
        error: result.errcode !== 0 ? result.errmsg : undefined,
      });
    } catch (err) {
      results.push({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (options.mediaPath?.trim()) {
    try {
      // Download and upload as image
      const mediaUrl = options.mediaPath;
      let buffer: Buffer;
      let contentType: string | undefined;

      if (
        mediaUrl.startsWith("http://") ||
        mediaUrl.startsWith("https://")
      ) {
        const resp = await fetch(mediaUrl);
        if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
        buffer = Buffer.from(await resp.arrayBuffer());
        contentType = resp.headers.get("content-type") ?? undefined;
      } else {
        const fs = await import("fs");
        buffer = await fs.promises.readFile(mediaUrl);
      }

      const mediaId = await uploadMedia(
        account,
        buffer,
        "image.jpg",
        contentType,
        "image"
      );

      const result = await sendKfMessage(account, {
        touser: userId,
        open_kfid: resolvedOpenKfId,
        msgtype: "image",
        image: { media_id: mediaId },
      });
      results.push({
        ok: result.errcode === 0,
        msgid: result.msgid,
        error: result.errcode !== 0 ? result.errmsg : undefined,
      });
    } catch (err) {
      results.push({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (results.length === 0) {
    return { ok: false, error: "No content to send (need text or mediaPath)" };
  }

  const allOk = results.every((r) => r.ok);
  const errors = results.filter((r) => r.error).map((r) => r.error);
  const msgids = results.filter((r) => r.msgid).map((r) => r.msgid);

  return {
    ok: allOk,
    msgid: msgids.join(",") || undefined,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}
