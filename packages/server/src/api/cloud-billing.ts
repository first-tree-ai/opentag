import {
  CLOUD_BILLING_CHECKOUT_PATH,
  CLOUD_BILLING_PATH,
  CLOUD_USAGE_PATH,
  CloudBillingSummarySchema,
  CloudCreditCheckoutRequestSchema,
  CloudCreditCheckoutResponseSchema,
  CloudUsageQuerySchema,
  CloudUsageSummarySchema,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { CloudBilling } from "../cloud-billing.js";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import type { CloudUsageService } from "../services/cloud-usage.js";
import { parseRequest } from "./request-validation.js";

/** Private provider failures must not expose credentials through public responses or logs. */
async function billingOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
    if (status === 403)
      throw new AuthServiceError(
        "CLOUD_BILLING_UNAVAILABLE",
        "deterministic",
        "Cloud credit requires payment review",
        403,
      );
    if (status === 400)
      throw new AuthServiceError("CLOUD_BILLING_UNAVAILABLE", "deterministic", "Invalid cloud credit request", 400);
    throw new AuthServiceError(
      "CLOUD_BILLING_UNAVAILABLE",
      "transient",
      "Cloud billing is temporarily unavailable",
      503,
    );
  }
}

/** Separate from application readiness so a billing outage does not take local usage offline. */
export function registerCloudBillingReadinessRoute(
  app: FastifyInstance,
  billing: CloudBilling | undefined,
  headers: Record<string, string>,
): void {
  app.get("/cloud-readyz", async (_request, reply) => {
    reply.headers(headers);
    if (!billing) return reply.code(503).send({ status: "not_ready" });
    try {
      return { status: "ready", billing: await billing.readiness() };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
}

export function registerCloudBillingRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  billing: CloudBilling | undefined,
  authOptions: UserAuthPreHandlerOptions,
  usage?: CloudUsageService,
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions);
  app.get(CLOUD_BILLING_PATH, { preHandler }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const accountId = request.authContext?.me.user.id;
    if (!accountId) throw new Error("Missing authenticated Account");
    return CloudBillingSummarySchema.parse(
      billing ? await billingOperation(() => billing.summary(accountId)) : { enabled: false },
    );
  });
  app.get(CLOUD_USAGE_PATH, { preHandler }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { windowDays } = parseRequest(CloudUsageQuerySchema, request.query);
    const accountId = request.authContext?.me.user.id;
    if (!accountId) throw new Error("Missing authenticated Account");
    return CloudUsageSummarySchema.parse(usage ? await usage.read(accountId, windowDays) : { enabled: false });
  });
  app.post(CLOUD_BILLING_CHECKOUT_PATH, { preHandler }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!billing)
      throw new AuthServiceError("CLOUD_BILLING_UNAVAILABLE", "deterministic", "Cloud billing is disabled", 503);
    const accountId = request.authContext?.me.user.id;
    if (!accountId) throw new Error("Missing authenticated Account");
    const input = parseRequest(CloudCreditCheckoutRequestSchema, request.body);
    return CloudCreditCheckoutResponseSchema.parse(await billingOperation(() => billing.checkout(accountId, input)));
  });
}

/** Encapsulated parser preserves signed bytes without changing any other JSON route. */
export function registerCloudBillingWebhook(app: FastifyInstance, billing: CloudBilling | undefined): void {
  if (!billing) return;
  app.register(async (webhooks) => {
    webhooks.removeContentTypeParser("application/json");
    webhooks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 256 * 1024 },
      (_request, body, done) => done(null, body),
    );
    webhooks.post("/stripe/webhook", { bodyLimit: 256 * 1024 }, async (request) => {
      const signature = request.headers["stripe-signature"];
      try {
        await billing.webhook(request.body as Buffer, typeof signature === "string" ? signature : undefined);
      } catch (error) {
        if (error instanceof Error && "statusCode" in error && error.statusCode === 400)
          throw new AuthServiceError("CLOUD_BILLING_UNAVAILABLE", "deterministic", "Invalid payment notification", 400);
        throw new AuthServiceError(
          "CLOUD_BILLING_UNAVAILABLE",
          "transient",
          "Payment processing is temporarily unavailable",
          503,
        );
      }
      return { received: true };
    });
  });
  app.addHook("preClose", async () => billing.stop());
  app.addHook("onClose", async () => billing.close());
}
