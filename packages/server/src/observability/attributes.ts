export const OPENTAG_ATTR = {
  AGENT_ID: "opentag.agent.id",
  ATTEMPT: "opentag.attempt",
  COMPUTER_ID: "opentag.computer.id",
  ERROR_CODE: "opentag.error.code",
  IM_BINDING_ID: "opentag.im.binding.id",
  IM_DELIVERY_COUNT: "opentag.im.delivery.count",
  IM_DELIVERY_ID: "opentag.im.delivery.id",
  IM_DUPLICATE: "opentag.im.duplicate",
  IM_EXTERNAL_MESSAGE_ID: "opentag.im.external_message.id",
  IM_MESSAGE_ID: "opentag.im.message.id",
  IM_PROVIDER: "opentag.im.provider",
  IM_PROVIDER_EVENT_ID: "opentag.im.provider_event.id",
  OPERATION_OUTCOME: "opentag.operation.outcome",
  REQUEST_ID: "opentag.request.id",
  RUNTIME_FRAME_TYPE: "opentag.runtime.frame.type",
  RUNTIME_INSTANCE_ID: "opentag.runtime.instance.id",
  RUNTIME_PLACEMENT_GENERATION: "opentag.runtime.placement_generation",
  SESSION_ID: "opentag.session.id",
  WS_CLOSE_CODE: "opentag.runtime.ws.close_code",
} as const;

export type ImProvider = "feishu" | "slack";

export function imAttrs(input: {
  provider?: ImProvider;
  bindingId?: string;
  providerEventId?: string | null;
  externalMessageId?: string | null;
  messageId?: string;
  deliveryId?: string;
  deliveryCount?: number;
  duplicate?: boolean;
}): Record<string, unknown> {
  return {
    [OPENTAG_ATTR.IM_PROVIDER]: input.provider,
    [OPENTAG_ATTR.IM_BINDING_ID]: input.bindingId,
    [OPENTAG_ATTR.IM_PROVIDER_EVENT_ID]: input.providerEventId,
    [OPENTAG_ATTR.IM_EXTERNAL_MESSAGE_ID]: input.externalMessageId,
    [OPENTAG_ATTR.IM_MESSAGE_ID]: input.messageId,
    [OPENTAG_ATTR.IM_DELIVERY_ID]: input.deliveryId,
    [OPENTAG_ATTR.IM_DELIVERY_COUNT]: input.deliveryCount,
    [OPENTAG_ATTR.IM_DUPLICATE]: input.duplicate,
  };
}

export function runtimeAttrs(input: {
  requestId?: string;
  deliveryId?: string;
  messageId?: string;
  sessionId?: string;
  agentId?: string;
  computerId?: string;
  instanceId?: string;
  placementGeneration?: number;
  attempt?: number;
  frameType?: string;
}): Record<string, unknown> {
  return {
    [OPENTAG_ATTR.REQUEST_ID]: input.requestId,
    [OPENTAG_ATTR.IM_DELIVERY_ID]: input.deliveryId,
    [OPENTAG_ATTR.IM_MESSAGE_ID]: input.messageId,
    [OPENTAG_ATTR.SESSION_ID]: input.sessionId,
    [OPENTAG_ATTR.AGENT_ID]: input.agentId,
    [OPENTAG_ATTR.COMPUTER_ID]: input.computerId,
    [OPENTAG_ATTR.RUNTIME_INSTANCE_ID]: input.instanceId,
    [OPENTAG_ATTR.RUNTIME_PLACEMENT_GENERATION]: input.placementGeneration,
    [OPENTAG_ATTR.ATTEMPT]: input.attempt,
    [OPENTAG_ATTR.RUNTIME_FRAME_TYPE]: input.frameType,
  };
}

export function outcomeAttrs(outcome: string, errorCode?: string): Record<string, unknown> {
  return {
    [OPENTAG_ATTR.OPERATION_OUTCOME]: outcome,
    [OPENTAG_ATTR.ERROR_CODE]: errorCode ? safeDiagnosticCode(errorCode) : undefined,
  };
}

export function safeDiagnosticCode(code: string): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(code) ? code : "INTERNAL_ERROR";
}
