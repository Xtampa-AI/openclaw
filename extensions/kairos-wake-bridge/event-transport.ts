import { createHmac, randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const EVENT_PROTOCOL = "kairos-wake.openclaw.v1";
const EVENT_DEFAULT_TIMEOUT_MS = 5_000;
const EVENT_MAX_STRING_LENGTH = 2_048;
const EVENT_MAX_DEPTH = 4;
const EVENT_MAX_ARRAY_ITEMS = 16;
const EVENT_MAX_OBJECT_KEYS = 32;

export const EVENT_MAX_IN_FLIGHT = 4;
export const EVENT_MAX_QUEUE = 256;
export const EVENT_FAILURE_THRESHOLD = 5;
export const EVENT_CIRCUIT_COOLDOWN_MS = 30_000;

export type WakeEventConfig = {
  eventsEnabled?: boolean;
  daemonUrl?: string;
  eventSecret?: string;
  agentId?: string;
  wakerId?: string;
  timeoutMs?: number;
};

export type WakeHookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  childSessionKey?: string;
};

type WakeEventRequest = {
  endpoint: string;
  body: string;
  headers: Record<string, string>;
  hookName: string;
};

const EVENT_SENSITIVE_KEY =
  /(^|_)(authorization|api[_-]?key|password|passwd|secret|token|cookie|credential|private[_-]?key|access[_-]?key|prompt|system|messages?|history|transcript|environment|env)(_|$)/i;

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedEventValue(value: unknown, depth = 0): unknown {
  if (depth > EVENT_MAX_DEPTH) {
    return "[TRUNCATED]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > EVENT_MAX_STRING_LENGTH
      ? value.slice(0, EVENT_MAX_STRING_LENGTH) + "…[TRUNCATED]"
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, EVENT_MAX_ARRAY_ITEMS).map((item) => boundedEventValue(item, depth + 1));
  }
  const record = eventRecord(value);
  if (!record) {
    return String(value);
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record).slice(0, EVENT_MAX_OBJECT_KEYS)) {
    if (EVENT_SENSITIVE_KEY.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = boundedEventValue(child, depth + 1);
    }
  }
  return result;
}

function pickEventFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = eventRecord(value);
  if (!record) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) {
      result[key] = boundedEventValue(record[key]);
    }
  }
  return result;
}

function eventCorrelationId(event: unknown, context: WakeHookContext): string | undefined {
  const record = eventRecord(event);
  return (
    eventString(record?.toolCallId) ??
    eventString(record?.callId) ??
    eventString(record?.childSessionKey) ??
    eventString(context.childSessionKey) ??
    eventString(context.runId)
  );
}

function wakeEventPayload(hookName: string, event: unknown): Record<string, unknown> {
  switch (hookName) {
    case "before_tool_call": {
      const record = eventRecord(event);
      return {
        toolName: eventString(record?.toolName),
        toolCallId: eventString(record?.toolCallId),
        params: boundedEventValue(record?.params),
      };
    }
    case "after_tool_call": {
      const record = eventRecord(event);
      return {
        toolName: eventString(record?.toolName),
        toolCallId: eventString(record?.toolCallId),
        durationMs: record?.durationMs,
        error: eventString(record?.error),
        result: boundedEventValue(record?.result),
      };
    }
    case "model_call_started":
      return pickEventFields(event, ["callId", "provider", "model", "api", "transport"]);
    case "model_call_ended":
      return pickEventFields(event, [
        "callId",
        "provider",
        "model",
        "api",
        "transport",
        "durationMs",
        "outcome",
        "errorCategory",
        "failureKind",
        "requestPayloadBytes",
        "responseStreamBytes",
        "timeToFirstByteMs",
        "upstreamRequestIdHash",
      ]);
    case "session_start":
      return pickEventFields(event, ["sessionId", "sessionKey", "resumedFrom"]);
    case "session_end":
      return pickEventFields(event, [
        "sessionId",
        "sessionKey",
        "messageCount",
        "durationMs",
        "reason",
        "transcriptArchived",
        "nextSessionId",
        "nextSessionKey",
      ]);
    case "before_compaction":
    case "after_compaction":
      return pickEventFields(event, [
        "messageCount",
        "compactingCount",
        "tokenCount",
        "compactedCount",
        "previousSessionId",
      ]);
    case "subagent_spawned":
      return pickEventFields(event, [
        "childSessionKey",
        "agentId",
        "label",
        "mode",
        "threadRequested",
        "resolvedModel",
        "resolvedProvider",
      ]);
    case "subagent_progress":
      return pickEventFields(event, ["phase", "runId", "childSessionKey", "outcome"]);
    case "subagent_ended":
      return pickEventFields(event, [
        "targetSessionKey",
        "targetKind",
        "reason",
        "sendFarewell",
        "runId",
        "endedAt",
        "outcome",
        "error",
      ]);
    case "agent_end":
      return pickEventFields(event, ["runId", "success", "error", "durationMs"]);
    default:
      return pickEventFields(event, ["runId", "sessionId", "sessionKey"]);
  }
}

function buildEventRequest(
  config: WakeEventConfig,
  hookName: string,
  event: unknown,
  context: WakeHookContext,
): WakeEventRequest | undefined {
  if (!config.eventsEnabled || !config.daemonUrl || !config.eventSecret) {
    return undefined;
  }

  const record = eventRecord(event);
  const sessionKey = eventString(context.sessionKey) ?? eventString(record?.sessionKey);
  const runId = eventString(context.runId) ?? eventString(record?.runId);
  const body = JSON.stringify({
    protocol: EVENT_PROTOCOL,
    eventId: randomUUID(),
    eventType: "openclaw." + hookName,
    occurredAt: new Date().toISOString(),
    agentId: config.agentId ?? context.agentId ?? "unknown",
    sessionKey,
    runId,
    correlationId: eventCorrelationId(event, context),
    wakerId: config.wakerId,
    payload: wakeEventPayload(hookName, event),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", config.eventSecret)
    .update(timestamp + "." + body)
    .digest("hex");

  return {
    endpoint: config.daemonUrl.replace(/\/$/, "") + "/api/public/openclaw/events",
    body,
    hookName,
    headers: {
      "content-type": "application/json",
      "x-kairos-wake-timestamp": timestamp,
      "x-kairos-wake-signature": signature,
    },
  };
}

/**
 * Best-effort event delivery with bounded memory and concurrency.
 * Lifecycle hooks must never create an unbounded fetch storm or wait on Wake.
 */
export class WakeEventDispatcher {
  private readonly queue: WakeEventRequest[] = [];
  private active = 0;
  private draining = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private lastNoticeAt = 0;

  constructor(
    private readonly logger: OpenClawPluginApi["logger"],
    private readonly config: WakeEventConfig,
  ) {}

  enqueue(hookName: string, event: unknown, context: WakeHookContext): void {
    const now = Date.now();
    if (this.circuitOpenUntil > now) {
      return;
    }
    if (this.circuitOpenUntil !== 0) {
      this.circuitOpenUntil = 0;
      this.consecutiveFailures = 0;
    }

    let request: WakeEventRequest | undefined;
    try {
      request = buildEventRequest(this.config, hookName, event, context);
    } catch (error) {
      this.logger.warn("Kairos-Wake event dropped before delivery: " + String(error));
      return;
    }
    if (!request) {
      return;
    }
    if (this.queue.length >= EVENT_MAX_QUEUE) {
      this.notice(
        `Kairos-Wake event queue full; dropping lifecycle events (capacity=${EVENT_MAX_QUEUE})`,
      );
      return;
    }
    this.queue.push(request);
    this.drain();
  }

  private drain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.active < EVENT_MAX_IN_FLIGHT && this.queue.length > 0) {
        const request = this.queue.shift()!;
        this.active += 1;
        void this.deliver(request)
          .then(() => {
            this.consecutiveFailures = 0;
          })
          .catch((error: unknown) => {
            this.consecutiveFailures += 1;
            if (this.consecutiveFailures >= EVENT_FAILURE_THRESHOLD) {
              this.circuitOpenUntil = Date.now() + EVENT_CIRCUIT_COOLDOWN_MS;
              this.queue.length = 0;
              this.notice(
                `Kairos-Wake event circuit open for ${EVENT_CIRCUIT_COOLDOWN_MS}ms after ${this.consecutiveFailures} delivery failures`,
              );
            } else {
              this.notice(
                `Kairos-Wake event delivery failed for ${request.hookName}: ${String(error)}`,
              );
            }
          })
          .finally(() => {
            this.active -= 1;
            this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(request: WakeEventRequest): Promise<void> {
    const response = await fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? EVENT_DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`);
    }
  }

  private notice(message: string): void {
    const now = Date.now();
    if (now - this.lastNoticeAt < 10_000) {
      return;
    }
    this.lastNoticeAt = now;
    this.logger.warn(message);
  }
}

export function wakeEventConfig(api: OpenClawPluginApi): WakeEventConfig {
  const raw = api.pluginConfig ?? {};
  const configuredEventSecret = eventString(raw.eventSecret);
  return {
    eventsEnabled: raw.eventsEnabled === true,
    daemonUrl: eventString(raw.daemonUrl),
    // An omitted secret may use the documented environment fallback. An
    // explicit but unresolved SecretRef must fail closed rather than silently
    // selecting an unrelated ambient credential.
    eventSecret:
      configuredEventSecret ||
      (!Object.prototype.hasOwnProperty.call(raw, "eventSecret")
        ? eventString(process.env.OPENCLAW_EVENT_SECRET)
        : undefined),
    agentId: eventString(raw.agentId),
    wakerId: eventString(raw.wakerId),
    timeoutMs:
      typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
        ? Math.min(Math.max(Math.trunc(raw.timeoutMs), 500), 30_000)
        : undefined,
  };
}
