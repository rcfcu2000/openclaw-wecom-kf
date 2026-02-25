/**
 * 微信客服 Webhook HTTP 处理器
 *
 * 关键区别: 微信客服回调仅是通知（不含消息内容），
 * 必须通过 sync_msg API 拉取实际消息。
 *
 * GET: URL 验证 (decrypt echostr, return plaintext)
 * POST: 事件回调 → 立即返回 200 "success" → 异步拉取消息
 */

import type { IncomingMessage, ServerResponse } from "http";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import type {
  PluginConfig,
  ResolvedWecomKfAccount,
  SyncMsgItem,
  SyncMsgEvent,
  WebhookTarget,
} from "./types.js";
import { verifyWecomSignature, decryptWecomEncrypted } from "./crypto.js";
import { syncMessages, sendKfWelcomeMessage, createLogger } from "./api.js";
import { tryGetWecomKfRuntime } from "./runtime.js";
import { dispatchKfMessage } from "./dispatch.js";

// ─── Webhook Target Registry ────────────────────────────────

const webhookTargets = new Map<string, WebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/"))
    return withSlash.slice(0, -1);
  return withSlash;
}

export function registerWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter(
      (entry) => entry !== normalizedTarget
    );
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
  };
}

// ─── Cursor Store (per account:openKfId) ────────────────────

const cursorStore = new Map<string, string>();

const CURSOR_FILE = join(
  homedir(),
  ".openclaw",
  "state",
  "wecom-kf",
  "cursors.json"
);
let cursorsLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function loadCursors(): Promise<void> {
  if (cursorsLoaded) return;
  try {
    const raw = await readFile(CURSOR_FILE, "utf8");
    const data = JSON.parse(raw);
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") cursorStore.set(k, v);
    }
  } catch {
    // file doesn't exist yet — first run, ok
  }
  cursorsLoaded = true;
}

function scheduleSaveCursors(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const obj = Object.fromEntries(cursorStore);
      await mkdir(dirname(CURSOR_FILE), { recursive: true });
      await writeFile(CURSOR_FILE, JSON.stringify(obj, null, 2));
    } catch {
      // best-effort; will retry on next cursor update
    }
  }, 1000);
}

function getCursorKey(accountId: string, openKfId?: string): string {
  return `${accountId}:${openKfId ?? "all"}`;
}

// ─── Message Dedup ──────────────────────────────────────────

const processedMsgIds = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function pruneProcessedMsgIds(): void {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [id, ts] of processedMsgIds.entries()) {
    if (ts < cutoff) processedMsgIds.delete(id);
  }
}

function isDuplicate(msgid: string): boolean {
  if (processedMsgIds.has(msgid)) return true;
  processedMsgIds.set(msgid, Date.now());
  return false;
}

// ─── HTTP Helpers ───────────────────────────────────────────

function resolvePath(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const qIdx = raw.indexOf("?");
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  return normalizeWebhookPath(path);
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? "/";
  const qIdx = raw.indexOf("?");
  return new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : "");
}

function readRawBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: boolean; raw?: string; error?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

function isXmlFormat(raw: string): boolean {
  return raw.trimStart().startsWith("<");
}

function parseXmlBody(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const tagRegex = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  let match;
  while ((match = tagRegex.exec(raw)) !== null) {
    result[match[1]!] = match[2]!;
  }
  // Also try non-CDATA values
  const simpleTagRegex = /<(\w+)>([^<]+)<\/\1>/g;
  while ((match = simpleTagRegex.exec(raw)) !== null) {
    if (!result[match[1]!]) {
      result[match[1]!] = match[2]!;
    }
  }
  return result;
}

// ─── Pull and Dispatch Messages ─────────────────────────────

async function pullAndDispatchMessages(
  target: WebhookTarget,
  callbackToken?: string,
  callbackOpenKfId?: string
): Promise<void> {
  const logger = createLogger("wecom-kf", {
    log: target.runtime.log,
    error: target.runtime.error,
  });
  const account = target.account;
  const core = tryGetWecomKfRuntime();

  if (!account.corpId || !account.corpSecret) {
    logger.warn("account missing corpId/corpSecret, skip pull");
    return;
  }

  pruneProcessedMsgIds();

  // Resolve openKfId: prefer account config, then callback XML, then fail
  const effectiveOpenKfId = account.openKfId || callbackOpenKfId;
  if (!effectiveOpenKfId) {
    logger.warn("no open_kfid available (not in config, not in callback), skip pull");
    return;
  }

  await loadCursors();

  const cursorKey = getCursorKey(account.accountId, effectiveOpenKfId);
  let cursor = cursorStore.get(cursorKey) ?? "";
  const isColdStart = !cursor;

  if (isColdStart) {
    logger.info(
      `cold start for ${cursorKey} — draining history to advance cursor`
    );
  }

  let hasMore = true;

  while (hasMore) {
    try {
      const syncParams: {
        cursor?: string;
        token?: string;
        open_kfid?: string;
        limit?: number;
      } = { limit: 1000 };

      if (cursor) {
        syncParams.cursor = cursor;
      } else if (callbackToken) {
        syncParams.token = callbackToken;
      }
      syncParams.open_kfid = effectiveOpenKfId;

      const resp = await syncMessages(account, syncParams);

      if (resp.next_cursor) {
        cursorStore.set(cursorKey, resp.next_cursor);
        cursor = resp.next_cursor;
        scheduleSaveCursors();
      }
      hasMore = resp.has_more === 1;

      if (!resp.msg_list || resp.msg_list.length === 0) {
        hasMore = false;
        continue;
      }

      // On cold start, skip dispatching — just advance the cursor
      if (isColdStart) {
        logger.info(
          `cold start drain: skipped ${resp.msg_list.length} historical messages`
        );
        continue;
      }

      for (const msg of resp.msg_list) {
        // Deduplicate
        if (msg.msgid && isDuplicate(msg.msgid)) {
          continue;
        }

        // Handle events
        if (msg.msgtype === "event") {
          await handleKfEvent(msg as SyncMsgEvent, account, logger);
          continue;
        }

        // Only process customer messages (origin === 3)
        if (msg.origin !== 3) {
          continue;
        }

        // Dispatch to agent
        if (core) {
          try {
            await dispatchKfMessage({
              cfg: target.config,
              account,
              msg,
              core,
              log: target.runtime.log,
              error: target.runtime.error,
            });
            target.statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            logger.error(`dispatch failed for msgid=${msg.msgid}: ${String(err)}`);
          }
        } else {
          logger.warn("runtime not available, cannot dispatch message");
        }
      }
    } catch (err) {
      logger.error(`sync_msg failed: ${String(err)}`);
      hasMore = false;
    }
  }
}

// ─── Event Handling ─────────────────────────────────────────

async function handleKfEvent(
  msg: SyncMsgEvent,
  account: ResolvedWecomKfAccount,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const eventType = msg.event?.event_type ?? "";

  if (eventType === "enter_session") {
    // Customer enters session - send welcome message
    const welcomeCode = msg.event?.welcome_code;
    const welcomeText = account.config.welcomeText?.trim();

    if (welcomeCode && welcomeText) {
      try {
        await sendKfWelcomeMessage(account, welcomeCode, "text", {
          text: { content: welcomeText },
        });
        logger.info(
          `welcome sent to ${msg.external_userid} via welcome_code`
        );
      } catch (err) {
        logger.error(`failed to send welcome: ${String(err)}`);
      }
    }
    return;
  }

  if (eventType === "msg_send_fail") {
    const failType = msg.event?.fail_type;
    const failMsgId = msg.event?.fail_msgid;
    logger.warn(
      `msg_send_fail: msgid=${failMsgId}, fail_type=${failType}`
    );
    return;
  }

  if (
    eventType === "servicer_status_change" ||
    eventType === "session_status_change"
  ) {
    logger.info(`event: ${eventType} for ${msg.external_userid ?? "?"}`);
    return;
  }

  logger.debug(`unhandled KF event: ${eventType}`);
}

// ─── Main HTTP Handler ──────────────────────────────────────

export async function handleWecomKfWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const path = resolvePath(req);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature =
    query.get("msg_signature") ?? query.get("signature") ?? "";
  const primary = targets[0]!;
  const logger = createLogger("wecom-kf", {
    log: primary.runtime.log,
    error: primary.runtime.error,
  });

  // ─── GET: URL Verification ──────────────────────────────
  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      res.statusCode = 400;
      res.end("missing query params");
      return true;
    }

    // Find matching account by signature
    const matched = targets.filter((t) => {
      if (!t.account.token) return false;
      return verifyWecomSignature({
        token: t.account.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
    });

    if (matched.length === 0) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    // Decrypt echostr
    const target = matched[0]!;
    if (!target.account.encodingAESKey) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    try {
      const plaintext = decryptWecomEncrypted({
        encodingAESKey: target.account.encodingAESKey,
        receiveId: target.account.corpId,
        encrypt: echostr,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plaintext);
      return true;
    } catch (err) {
      logger.error(`echostr decrypt failed: ${String(err)}`);
      res.statusCode = 400;
      res.end("decrypt failed");
      return true;
    }
  }

  // ─── POST: Event Callback ──────────────────────────────
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return true;
  }

  if (!timestamp || !nonce || !signature) {
    res.statusCode = 400;
    res.end("missing query params");
    return true;
  }

  const body = await readRawBody(req, 1024 * 1024);
  if (!body.ok || !body.raw) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const rawBody = body.raw;
  let encrypt = "";
  let msgSignature = signature;
  let msgTimestamp = timestamp;
  let msgNonce = nonce;

  if (isXmlFormat(rawBody)) {
    const xmlData = parseXmlBody(rawBody);
    encrypt = xmlData.Encrypt ?? "";
    msgSignature = xmlData.MsgSignature ?? signature;
    msgTimestamp = xmlData.TimeStamp ?? timestamp;
    msgNonce = xmlData.Nonce ?? nonce;
  } else {
    try {
      const record = JSON.parse(rawBody);
      encrypt = String(record.encrypt ?? record.Encrypt ?? "");
    } catch {
      res.statusCode = 400;
      res.end("invalid payload format");
      return true;
    }
  }

  if (!encrypt) {
    res.statusCode = 400;
    res.end("missing encrypt");
    return true;
  }

  // Verify signature
  const signatureMatched = targets.filter((t) => {
    if (!t.account.token) return false;
    return verifyWecomSignature({
      token: t.account.token,
      timestamp: msgTimestamp,
      nonce: msgNonce,
      encrypt,
      signature: msgSignature,
    });
  });

  if (signatureMatched.length === 0) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  // Respond immediately (< 5 seconds requirement)
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("success");

  // Decrypt callback body to extract Token and OpenKfId
  const target = signatureMatched[0]!;
  let callbackToken: string | undefined;
  let callbackOpenKfId: string | undefined;

  if (target.account.encodingAESKey) {
    try {
      const plaintext = decryptWecomEncrypted({
        encodingAESKey: target.account.encodingAESKey,
        receiveId: target.account.corpId,
        encrypt,
      });
      // Parse decrypted callback content (XML or JSON)
      logger.debug(`callback decrypted (first 500 chars): ${plaintext.slice(0, 500)}`);
      if (isXmlFormat(plaintext)) {
        const xmlData = parseXmlBody(plaintext);
        logger.debug(`callback parsed XML fields: ${JSON.stringify(Object.keys(xmlData))}`);
        callbackToken = xmlData.Token;
        callbackOpenKfId = xmlData.OpenKfId;
      } else {
        // Try JSON format
        try {
          const jsonData = JSON.parse(plaintext);
          logger.debug(`callback parsed JSON keys: ${JSON.stringify(Object.keys(jsonData))}`);
          callbackToken = String(jsonData.Token ?? jsonData.token ?? "");
          callbackOpenKfId = String(jsonData.OpenKfId ?? jsonData.open_kfid ?? "");
        } catch {
          logger.warn(`callback plaintext is neither XML nor JSON`);
        }
      }
      // Ensure empty strings are treated as undefined
      if (!callbackToken) callbackToken = undefined;
      if (!callbackOpenKfId) callbackOpenKfId = undefined;
      logger.info(
        `callback received: openKfId=${callbackOpenKfId ?? "?"}, hasToken=${Boolean(callbackToken)}`
      );
    } catch (err) {
      logger.error(`callback decrypt failed: ${String(err)}`);
    }
  }

  // Asynchronously pull and dispatch messages
  target.statusSink?.({ lastInboundAt: Date.now() });
  pullAndDispatchMessages(target, callbackToken, callbackOpenKfId).catch((err) => {
    logger.error(`pullAndDispatch failed: ${String(err)}`);
  });

  return true;
}
