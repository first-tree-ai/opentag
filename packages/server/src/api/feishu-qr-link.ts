import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FEISHU_QR_LINK_PATH_PREFIX, type FeishuSetupService } from "../services/im-bindings/feishu/index.js";

type QrLinkFailure = "unavailable" | "temporary";

const FAILURE_COPY: Record<"en" | "zh", Record<QrLinkFailure, { title: string; body: string }>> = {
  en: {
    unavailable: {
      title: "This QR code no longer works",
      body: "It has expired or has already been used. Go back to openTag and start connecting again to get a new one.",
    },
    temporary: { title: "This QR code can't be opened right now", body: "Wait a moment, then scan it again." },
  },
  zh: {
    unavailable: {
      title: "这个二维码已失效",
      body: "它已过期或已被使用。回到 openTag 重新发起连接，生成新的二维码。",
    },
    temporary: { title: "这个二维码暂时打不开", body: "请稍等片刻，再扫一次。" },
  },
};

function replyLocale(request: FastifyRequest): "en" | "zh" {
  return /^\s*zh\b/i.test(request.headers["accept-language"] ?? "") ? "zh" : "en";
}

/** The page is the same for a forged, unknown, expired or finished link, so it reveals none of them. */
function failurePage(request: FastifyRequest, reply: FastifyReply, failure: QrLinkFailure, statusCode: number) {
  const locale = replyLocale(request);
  const { title, body } = FAILURE_COPY[locale][failure];
  return reply
    .code(statusCode)
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:15vh 24px;text-align:center;color:#1f2328}h1{font-size:20px}p{color:#57606a;line-height:1.5}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`,
    );
}

/**
 * The target of a Feishu setup QR code. A phone that scans one has no openTag session, so this route
 * takes no authentication and answers with nothing except the redirect the token was minted for.
 */
export function registerFeishuQrLinkRoute(app: FastifyInstance, feishu: FeishuSetupService): void {
  app.get<{ Params: { token: string } }>(`${FEISHU_QR_LINK_PATH_PREFIX}:token`, async (request, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-robots-tag", "noindex");
    let target: string | undefined;
    try {
      target = await feishu.resolveQrLink(request.params.token);
    } catch (error) {
      request.log.warn({ err: error, code: "FEISHU_QR_LINK_UNAVAILABLE" }, "Feishu QR link could not be resolved");
      return failurePage(request, reply, "temporary", 503);
    }
    if (!target) return failurePage(request, reply, "unavailable", 410);
    return reply.redirect(target, 302);
  });
}
