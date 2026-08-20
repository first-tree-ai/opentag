import {
  AuthProvidersResponseSchema,
  HTTP_PATHS,
  InvitationPreviewSchema,
  InvitationRedemptionResponseSchema,
  invitationPreviewPath,
  invitationRedeemPath,
  MeResponseSchema,
} from "@opentag/shared/browser";
import type { BrowserTransport } from "./transport.js";

export function createAuthApi(transport: BrowserTransport) {
  return {
    me: () => transport.request("/api/v1/me", MeResponseSchema),
    providers: () => transport.request(HTTP_PATHS.authProviders, AuthProvidersResponseSchema, undefined, false),
    invitationPreview: (token: string) =>
      transport.request(invitationPreviewPath(token), InvitationPreviewSchema, undefined, false),
    async redeemInvitation(token: string): Promise<void> {
      await transport.request(invitationRedeemPath(token), InvitationRedemptionResponseSchema, {
        method: "POST",
        headers: transport.csrfHeaders(),
      });
    },
    logout: () =>
      transport.requestNoContent("/api/v1/auth/browser/logout", {
        method: "POST",
        headers: transport.csrfHeaders(),
      }),
  };
}
