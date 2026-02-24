/**
 * 微信客服消息分发到 OpenClaw 运行时
 *
 * 构建 inbound context → resolveAgentRoute → dispatchReplyWithBufferedBlockDispatcher
 * 响应通过 sendKfTextMessage 发送回客户。
 */

import type {
  PluginConfig,
  PluginRuntime,
  ResolvedWecomKfAccount,
  SyncMsgItem,
} from "./types.js";
import { resolveDmPolicy, resolveAllowFrom, checkDmPolicy } from "./config.js";
import { createLogger, sendKfTextMessage, stripMarkdown, splitMessageByBytes } from "./api.js";
import { enrichInboundWithMedia } from "./bot.js";

export async function dispatchKfMessage(params: {
  cfg: PluginConfig;
  account: ResolvedWecomKfAccount;
  msg: SyncMsgItem;
  core: PluginRuntime;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { cfg, account, msg, core } = params;
  const safeCfg = cfg ?? {};
  const logger = createLogger("wecom-kf", {
    log: params.log,
    error: params.error,
  });

  const senderId = msg.external_userid ?? "unknown";
  const accountConfig = account.config;
  const dmPolicy = resolveDmPolicy(accountConfig);
  const allowFrom = resolveAllowFrom(accountConfig);
  const policyResult = checkDmPolicy({ dmPolicy, senderId, allowFrom });

  if (!policyResult.allowed) {
    logger.debug(`policy rejected: ${policyResult.reason}`);
    return;
  }

  const channel = core.channel;
  if (
    !channel?.routing?.resolveAgentRoute ||
    !channel.reply?.dispatchReplyWithBufferedBlockDispatcher
  ) {
    logger.debug(
      "core routing or buffered dispatcher missing, skipping dispatch"
    );
    return;
  }

  const route = channel.routing.resolveAgentRoute({
    cfg: safeCfg,
    channel: "wecom-kf",
    accountId: account.accountId,
    peer: { kind: "dm", id: senderId },
  });

  // Enrich message content with media
  const enriched = await enrichInboundWithMedia(msg, account, logger);
  const rawBody = enriched.text;

  const fromLabel = `user:${senderId}`;

  // Session handling
  const storePath = channel.session?.resolveStorePath?.(
    (safeCfg as any).session?.store,
    { agentId: route.agentId }
  );
  const previousTimestamp = channel.session?.readSessionUpdatedAt
    ? (channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      }) ?? undefined)
    : undefined;

  // Format agent envelope
  const envelopeOptions = channel.reply?.resolveEnvelopeFormatOptions
    ? channel.reply.resolveEnvelopeFormatOptions(safeCfg)
    : undefined;
  const body = channel.reply?.formatAgentEnvelope
    ? channel.reply.formatAgentEnvelope({
        channel: "WeCom KF",
        from: fromLabel,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      })
    : rawBody;

  const from = `wecom-kf:user:${senderId}`;
  const to = `user:${senderId}`;
  const msgid = msg.msgid;

  // Build inbound context
  const ctxPayload: Record<string, unknown> = channel.reply?.finalizeInboundContext
    ? (channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId ?? account.accountId,
        ChatType: "direct",
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-kf",
        Surface: "wecom-kf",
        MessageSid: msgid,
        OriginatingChannel: "wecom-kf",
        OriginatingTo: to,
      }) as Record<string, unknown>)
    : {
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId ?? account.accountId,
        ChatType: "direct",
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-kf",
        Surface: "wecom-kf",
        MessageSid: msgid,
        OriginatingChannel: "wecom-kf",
        OriginatingTo: to,
      };

  // Stabilize To field
  const ctxTo =
    typeof ctxPayload.To === "string" && (ctxPayload.To as string).trim()
      ? (ctxPayload.To as string).trim()
      : undefined;
  const ctxOriginatingTo =
    typeof ctxPayload.OriginatingTo === "string" &&
    (ctxPayload.OriginatingTo as string).trim()
      ? (ctxPayload.OriginatingTo as string).trim()
      : undefined;
  const stableTo = ctxOriginatingTo ?? ctxTo ?? to;
  ctxPayload.To = stableTo;
  ctxPayload.OriginatingTo = stableTo;
  ctxPayload.SenderId = senderId;
  ctxPayload.SenderName = senderId;
  ctxPayload.ConversationLabel = fromLabel;
  ctxPayload.CommandAuthorized = true;

  // Record session
  if (channel.session?.recordInboundSession && storePath) {
    const mainSessionKey =
      typeof (route as any).mainSessionKey === "string" &&
      (route as any).mainSessionKey.trim()
        ? (route as any).mainSessionKey
        : undefined;
    const updateLastRoute = {
      sessionKey: mainSessionKey ?? route.sessionKey,
      channel: "wecom-kf",
      to: stableTo,
      accountId: route.accountId ?? account.accountId,
    };
    const recordSessionKey =
      typeof ctxPayload.SessionKey === "string" &&
      (ctxPayload.SessionKey as string).trim()
        ? (ctxPayload.SessionKey as string)
        : route.sessionKey;
    await channel.session.recordInboundSession({
      storePath,
      sessionKey: recordSessionKey,
      ctx: ctxPayload,
      updateLastRoute,
      onRecordError: (err) => {
        logger.error(
          `wecom-kf: failed updating session meta: ${String(err)}`
        );
      },
    });
  }

  // Collect full response then send
  const responseChunks: string[] = [];

  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: safeCfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const rawText = payload.text ?? "";
        if (!rawText.trim()) return;
        responseChunks.push(rawText);
      },
      onError: (err, info) => {
        logger.error(`${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  // Send coalesced response back to customer
  if (responseChunks.length > 0 && account.canSendActive) {
    const fullResponse = responseChunks.join("\n\n").trim();
    if (fullResponse) {
      try {
        await sendKfTextMessage(account, senderId, fullResponse);
        logger.info(
          `reply sent to ${senderId}: ${fullResponse.length} chars`
        );
      } catch (err) {
        logger.error(`failed to send reply: ${String(err)}`);
      }
    }
  }

  await enriched.cleanup();
}
