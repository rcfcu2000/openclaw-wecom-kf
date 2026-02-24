/**
 * 微信客服入站消息处理
 *
 * 从 sync_msg 拉取的消息中提取文本内容，并下载富媒体文件。
 */

import type { ResolvedWecomKfAccount, SyncMsgItem, SyncMsgEvent } from "./types.js";
import {
  resolveInboundMediaEnabled,
  resolveInboundMediaMaxBytes,
} from "./config.js";
import {
  downloadWecomMediaToFile,
  finalizeInboundMedia,
  pruneInboundMediaDir,
} from "./api.js";

// ─── Content Extraction ─────────────────────────────────────

export function extractKfMessageContent(msg: SyncMsgItem): string {
  switch (msg.msgtype) {
    case "text":
      return msg.text?.content ?? "";
    case "image":
      return "[image]";
    case "voice":
      return "[voice]";
    case "video":
      return "[video]";
    case "file":
      return "[file]";
    case "location": {
      const loc = (msg as any).location;
      const parts: string[] = [];
      if (loc?.latitude !== undefined && loc?.longitude !== undefined) {
        parts.push(`${loc.latitude},${loc.longitude}`);
      }
      if (loc?.name) parts.push(loc.name);
      if (loc?.address) parts.push(loc.address);
      return parts.length ? `[location] ${parts.join(" ")}` : "[location]";
    }
    case "link": {
      const link = (msg as any).link;
      const title = link?.title ?? "";
      const url = link?.url ?? "";
      return url ? `[link] ${title} ${url}`.trim() : `[link] ${title}`.trim();
    }
    case "business_card":
      return `[business_card] userid:${(msg as any).business_card?.userid ?? ""}`;
    case "miniprogram": {
      const mp = (msg as any).miniprogram;
      return `[miniprogram] ${mp?.title ?? ""}`.trim();
    }
    case "msgmenu": {
      const menu = (msg as any).msgmenu;
      const head = menu?.head_content ?? "";
      const items = (menu?.list ?? [])
        .map((item: any) => {
          if (item.type === "click") return item.click?.content ?? "";
          if (item.type === "view") return item.view?.content ?? "";
          if (item.type === "miniprogram")
            return item.miniprogram?.content ?? "";
          return "";
        })
        .filter(Boolean);
      return head
        ? `${head}\n${items.join("\n")}`.trim()
        : items.join("\n") || "[msgmenu]";
    }
    case "event": {
      const evt = (msg as SyncMsgEvent).event;
      return evt?.event_type
        ? `[event] ${evt.event_type}`
        : "[event]";
    }
    default:
      return msg.msgtype ? `[${msg.msgtype}]` : "";
  }
}

// ─── Media Enrichment ───────────────────────────────────────

export type EnrichedResult = {
  text: string;
  mediaPaths: string[];
  cleanup: () => Promise<void>;
};

export async function enrichInboundWithMedia(
  msg: SyncMsgItem,
  account: ResolvedWecomKfAccount,
  logger?: { warn: (msg: string) => void }
): Promise<EnrichedResult> {
  const mediaPaths: string[] = [];
  const makeResult = (text: string): EnrichedResult => ({
    text,
    mediaPaths,
    cleanup: async () => {
      try {
        await pruneInboundMediaDir(account);
      } catch {
        // ignore
      }
    },
  });

  const accountConfig = account.config;
  const enabled = resolveInboundMediaEnabled(accountConfig);
  const maxBytes = resolveInboundMediaMaxBytes(accountConfig);

  if (!enabled) {
    return makeResult(extractKfMessageContent(msg));
  }

  // Handle image
  if (msg.msgtype === "image") {
    try {
      const mediaId = (msg as any).image?.media_id;
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, {
          maxBytes,
          prefix: "img",
        });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[image] saved:${finalPath}`);
        }
        return makeResult(
          `[image] (save failed) ${saved.error ?? ""}`.trim()
        );
      }
    } catch (err) {
      return makeResult(
        `[image] (download error: ${err instanceof Error ? err.message : String(err)})`
      );
    }
    return makeResult(extractKfMessageContent(msg));
  }

  // Handle voice
  if (msg.msgtype === "voice") {
    try {
      const mediaId = (msg as any).voice?.media_id;
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, {
          maxBytes,
          prefix: "voice",
        });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[voice] saved:${finalPath}`);
        }
        return makeResult(
          `[voice] (save failed) ${saved.error ?? ""}`.trim()
        );
      }
    } catch (err) {
      return makeResult(
        `[voice] (download error: ${err instanceof Error ? err.message : String(err)})`
      );
    }
    return makeResult(extractKfMessageContent(msg));
  }

  // Handle video
  if (msg.msgtype === "video") {
    try {
      const mediaId = (msg as any).video?.media_id;
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, {
          maxBytes,
          prefix: "video",
        });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[video] saved:${finalPath}`);
        }
        return makeResult(
          `[video] (save failed) ${saved.error ?? ""}`.trim()
        );
      }
    } catch (err) {
      return makeResult(
        `[video] (download error: ${err instanceof Error ? err.message : String(err)})`
      );
    }
    return makeResult(extractKfMessageContent(msg));
  }

  // Handle file
  if (msg.msgtype === "file") {
    try {
      const mediaId = (msg as any).file?.media_id;
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, {
          maxBytes,
          prefix: "file",
        });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[file] saved:${finalPath}`);
        }
        return makeResult(
          `[file] (save failed) ${saved.error ?? ""}`.trim()
        );
      }
    } catch (err) {
      return makeResult(
        `[file] (download error: ${err instanceof Error ? err.message : String(err)})`
      );
    }
    return makeResult(extractKfMessageContent(msg));
  }

  // Default: text extraction
  return makeResult(extractKfMessageContent(msg));
}
