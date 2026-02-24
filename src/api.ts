/**
 * 微信客服 API 客户端
 *
 * - access_token 缓存 (2hr TTL minus 5min safety)
 * - sync_msg: 消息同步拉取
 * - send_msg: 客服消息发送
 * - send_msg_on_event: 事件响应消息（欢迎语）
 * - media upload / download
 */

import { tmpdir } from "os";
import { join, extname, basename } from "path";
import { mkdir, writeFile, readdir, stat, unlink, rename } from "fs/promises";
import type {
  AccessTokenCacheEntry,
  KfSendMsgParams,
  KfSendMsgResult,
  ResolvedWecomKfAccount,
  SyncMsgResponse,
  WecomKfAccountConfig,
} from "./types.js";
import {
  resolveApiBaseUrl,
  resolveInboundMediaDir,
  resolveInboundMediaKeepDays,
} from "./config.js";

// ─── Logger ─────────────────────────────────────────────────

export function createLogger(
  prefix: string,
  opts?: { log?: (msg: string) => void; error?: (msg: string) => void }
) {
  const logFn = opts?.log ?? console.log;
  const errorFn = opts?.error ?? console.error;
  return {
    debug: (msg: string) => logFn(`[${prefix}] [DEBUG] ${msg}`),
    info: (msg: string) => logFn(`[${prefix}] ${msg}`),
    warn: (msg: string) => logFn(`[${prefix}] [WARN] ${msg}`),
    error: (msg: string) => errorFn(`[${prefix}] [ERROR] ${msg}`),
  };
}

// ─── Access Token ───────────────────────────────────────────

const accessTokenCache = new Map<string, AccessTokenCacheEntry>();
const ACCESS_TOKEN_TTL_MS = 7200 * 1000 - 5 * 60 * 1000; // ~115 min

function buildApiUrl(
  account: ResolvedWecomKfAccount,
  pathWithQuery: string
): string {
  const normalizedPath = pathWithQuery.startsWith("/")
    ? pathWithQuery
    : `/${pathWithQuery}`;
  return `${resolveApiBaseUrl(account.config)}${normalizedPath}`;
}

export async function getAccessToken(
  account: ResolvedWecomKfAccount
): Promise<string> {
  if (!account.corpId || !account.corpSecret) {
    throw new Error("corpId or corpSecret not configured");
  }
  const key = `${account.corpId}:kf`;
  const cached = accessTokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  const url = buildApiUrl(
    account,
    `/cgi-bin/gettoken?corpid=${encodeURIComponent(account.corpId)}&corpsecret=${encodeURIComponent(account.corpSecret)}`
  );
  const resp = await fetch(url);
  const data = (await resp.json()) as {
    errcode?: number;
    errmsg?: string;
    access_token?: string;
  };
  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(
      `gettoken failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`
    );
  }
  if (!data.access_token) {
    throw new Error("gettoken returned empty access_token");
  }
  accessTokenCache.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  });
  return data.access_token;
}

export function clearAccessTokenCache(
  account: ResolvedWecomKfAccount
): void {
  const key = `${account.corpId}:kf`;
  accessTokenCache.delete(key);
}

export function clearAllAccessTokenCache(): void {
  accessTokenCache.clear();
}

// ─── Sync Messages ──────────────────────────────────────────

export async function syncMessages(
  account: ResolvedWecomKfAccount,
  params: {
    cursor?: string;
    token?: string;
    open_kfid?: string;
    limit?: number;
    voice_format?: number;
  }
): Promise<SyncMsgResponse> {
  const accessToken = await getAccessToken(account);
  const url = buildApiUrl(
    account,
    `/cgi-bin/kf/sync_msg?access_token=${encodeURIComponent(accessToken)}`
  );
  const body: Record<string, unknown> = {};
  if (params.cursor) body.cursor = params.cursor;
  if (params.token) body.token = params.token;
  if (params.open_kfid) body.open_kfid = params.open_kfid;
  if (params.limit) body.limit = params.limit;
  if (params.voice_format !== undefined)
    body.voice_format = params.voice_format;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as SyncMsgResponse;
  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(
      `sync_msg failed: ${data.errmsg ?? "unknown"} (errcode=${data.errcode})`
    );
  }
  return data;
}

// ─── Send Message ───────────────────────────────────────────

export async function sendKfMessage(
  account: ResolvedWecomKfAccount,
  params: KfSendMsgParams
): Promise<KfSendMsgResult> {
  const accessToken = await getAccessToken(account);
  const url = buildApiUrl(
    account,
    `/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`
  );
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await resp.json()) as KfSendMsgResult;
  return data;
}

export async function sendKfWelcomeMessage(
  account: ResolvedWecomKfAccount,
  welcomeCode: string,
  msgtype: string,
  content: Record<string, unknown>
): Promise<KfSendMsgResult> {
  const accessToken = await getAccessToken(account);
  const url = buildApiUrl(
    account,
    `/cgi-bin/kf/send_msg_on_event?access_token=${encodeURIComponent(accessToken)}`
  );
  const body: Record<string, unknown> = {
    code: welcomeCode,
    msgtype,
    ...content,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as KfSendMsgResult;
  return data;
}

// ─── Text Helpers ───────────────────────────────────────────

/**
 * Strip Markdown formatting for plain text display.
 * WeChat KF doesn't support markdown.
 */
export function stripMarkdown(text: string): string {
  let result = text;
  // Code blocks → indented
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const trimmedCode = (code as string).trim();
    if (!trimmedCode) return "";
    const langLabel = lang ? `[${lang}]\n` : "";
    const indentedCode = trimmedCode
      .split("\n")
      .map((line: string) => `    ${line}`)
      .join("\n");
    return `\n${langLabel}${indentedCode}\n`;
  });
  // Headings → 【】
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "【$1】");
  // Bold/italic
  result = result
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/(?<![\w/])_(.+?)_(?![\w/])/g, "$1");
  // Lists
  result = result.replace(/^[-*]\s+/gm, "· ");
  result = result.replace(/^(\d+)\.\s+/gm, "$1. ");
  // Inline code
  result = result.replace(/`([^`]+)`/g, "$1");
  // Strikethrough
  result = result.replace(/~~(.*?)~~/g, "$1");
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // Images
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]");
  // Tables → simplified
  result = result.replace(
    /\|(.+)\|\n\|[-:| ]+\|\n((?:\|.+\|\n?)*)/g,
    (_match, header, body) => {
      const headerCells = (header as string)
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      const rows = (body as string)
        .trim()
        .split("\n")
        .map((row) =>
          row
            .split("|")
            .map((c) => c.trim())
            .filter(Boolean)
        );
      const colWidths = headerCells.map((h, i) => {
        const maxRowWidth = Math.max(
          ...rows.map((r) => (r[i] || "").length)
        );
        return Math.max(h.length, maxRowWidth);
      });
      const formattedHeader = headerCells
        .map((h, i) => h.padEnd(colWidths[i]!))
        .join("  ");
      const formattedRows = rows
        .map((row) =>
          headerCells
            .map((_, i) => (row[i] || "").padEnd(colWidths[i]!))
            .join("  ")
        )
        .join("\n");
      return `${formattedHeader}\n${formattedRows}\n`;
    }
  );
  // Blockquote
  result = result.replace(/^>\s?/gm, "");
  // Horizontal rule
  result = result.replace(/^[-*_]{3,}$/gm, "────────────");
  // Collapse extra blank lines
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Split text by byte length (UTF-8), respecting the 2048-byte KF limit.
 */
export function splitMessageByBytes(
  text: string,
  maxBytes: number = 2048
): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of text) {
    const next = current + char;
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      if (current) chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Send a text message to a KF customer, handling chunking + markdown stripping.
 * openKfId can be provided explicitly (e.g. from inbound message) or falls back to account config.
 */
export async function sendKfTextMessage(
  account: ResolvedWecomKfAccount,
  externalUserId: string,
  text: string,
  openKfId?: string
): Promise<KfSendMsgResult> {
  const resolvedOpenKfId = openKfId ?? account.openKfId;
  if (!resolvedOpenKfId) {
    return { errcode: -1, errmsg: "openKfId not available (not in config and not provided)" };
  }
  const plainText = stripMarkdown(text);
  const chunks = splitMessageByBytes(plainText, 2048);
  let lastResult: KfSendMsgResult = {
    errcode: 0,
    errmsg: "ok",
  };
  for (const chunk of chunks) {
    lastResult = await sendKfMessage(account, {
      touser: externalUserId,
      open_kfid: resolvedOpenKfId,
      msgtype: "text",
      text: { content: chunk },
    });
    if (lastResult.errcode !== 0) {
      return lastResult;
    }
  }
  return lastResult;
}

// ─── Media Upload ───────────────────────────────────────────

const MIME_EXT_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

function pickExtFromMime(mimeType?: string): string {
  const t = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return (t && MIME_EXT_MAP[t]) || "";
}

export async function uploadMedia(
  account: ResolvedWecomKfAccount,
  buffer: Buffer,
  filename: string,
  contentType: string | undefined,
  type: "image" | "voice" | "video" | "file" = "file"
): Promise<string> {
  const accessToken = await getAccessToken(account);
  const url = buildApiUrl(
    account,
    `/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${type}`
  );

  // Build multipart/form-data manually
  const boundary = `----WebKitFormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const mime = contentType || "application/octet-stream";
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const data = (await resp.json()) as {
    errcode?: number;
    errmsg?: string;
    media_id?: string;
    type?: string;
  };
  if (data.errcode && data.errcode !== 0) {
    throw new Error(
      `media upload failed: ${data.errmsg ?? "unknown"} (errcode=${data.errcode})`
    );
  }
  if (!data.media_id) {
    throw new Error("media upload returned empty media_id");
  }
  return data.media_id;
}

// ─── Media Download ─────────────────────────────────────────

function getWecomKfTempDir(): string {
  return join(tmpdir(), "wecom-kf-media");
}

function parseContentDispositionFilename(
  headerValue?: string | null
): string | undefined {
  const v = String(headerValue ?? "");
  if (!v) return undefined;
  const m1 = v.match(/filename\*=UTF-8''([^;]+)/i);
  if (m1?.[1]) {
    try {
      return decodeURIComponent(m1[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return m1[1].trim().replace(/^"|"$/g, "");
    }
  }
  const m2 = v.match(/filename=([^;]+)/i);
  if (m2?.[1]) return m2[1].trim().replace(/^"|"$/g, "");
  return undefined;
}

export async function downloadWecomMediaToFile(
  account: ResolvedWecomKfAccount,
  mediaId: string,
  opts?: { maxBytes?: number; prefix?: string }
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    let url: string;
    // If mediaId is a URL, use it directly
    if (mediaId.startsWith("http://") || mediaId.startsWith("https://")) {
      url = mediaId;
    } else {
      url = buildApiUrl(
        account,
        `/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`
      );
    }

    const resp = await fetch(url);
    if (!resp.ok) {
      return {
        ok: false,
        error: `HTTP ${resp.status}`,
      };
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      return {
        ok: false,
        error: `file too large (${buffer.length} > ${maxBytes})`,
      };
    }

    const prefix = opts?.prefix ?? "media";
    const contentDisp = resp.headers.get("content-disposition");
    const cdFilename = parseContentDispositionFilename(contentDisp);
    const contentType = resp.headers.get("content-type") ?? undefined;
    let ext = cdFilename ? extname(cdFilename) : pickExtFromMime(contentType);
    if (!ext) ext = ".bin";

    const dir = getWecomKfTempDir();
    await mkdir(dir, { recursive: true });
    const filename = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = join(dir, filename);
    await writeFile(filePath, buffer);

    return { ok: true, path: filePath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Inbound Media Finalize ─────────────────────────────────

function formatDateDir(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isProbablyInWecomKfTmpDir(p: string): boolean {
  try {
    const base = getWecomKfTempDir();
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    return norm(p).includes(norm(base));
  } catch {
    return false;
  }
}

export async function finalizeInboundMedia(
  account: ResolvedWecomKfAccount,
  filePath: string
): Promise<string> {
  const p = String(filePath ?? "").trim();
  if (!p) return p;
  if (!isProbablyInWecomKfTmpDir(p)) return p;
  const baseDir = resolveInboundMediaDir(account.config);
  const datedDir = join(baseDir, formatDateDir());
  await mkdir(datedDir, { recursive: true });
  const name = basename(p);
  const dest = join(datedDir, name);
  try {
    await rename(p, dest);
    return dest;
  } catch {
    try {
      await unlink(p);
    } catch {
      // ignore
    }
    return p;
  }
}

export async function pruneInboundMediaDir(
  account: ResolvedWecomKfAccount
): Promise<void> {
  const baseDir = resolveInboundMediaDir(account.config);
  const keepDays = resolveInboundMediaKeepDays(account.config);
  if (keepDays < 0) return;
  const now = Date.now();
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const dirPath = join(baseDir, entry);
    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const dirTime = st.mtimeMs || st.ctimeMs || 0;
    if (dirTime >= cutoff) continue;
    let files: string[] = [];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = join(dirPath, f);
      try {
        const fst = await stat(fp);
        if (fst.isFile() && (fst.mtimeMs || fst.ctimeMs || 0) < cutoff) {
          await unlink(fp);
        }
      } catch {
        // ignore
      }
    }
  }
}
