import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  defineToolPlugin,
  getToolPluginMetadata,
  toolPluginMetadataSymbol,
} from "openclaw/plugin-sdk/tool-plugin";
/**
 * Kairos-Wake Bridge plugin for OpenClaw.
 *
 * Registers tools that allow OpenClaw agents (Kai, Cangrejo, Hermes) to
 * delegate tasks to Kairos-Wake wakers via the KW daemon REST API.
 *
 * Tools registered:
 *  - kw_list_wakers   — list available wakers
 *  - kw_send_message   — create a new session or continue an existing one
 *  - kw_get_response   — poll for session events/responses
 *
 * Configuration via openclaw.json plugins.entries["kairos-wake-bridge"].config:
 *  - daemonUrl:   KW daemon URL (default: http://127.0.0.1:19900)
 *  - authToken:   Bearer token for KW API; falls back to KAIROS_WAKE_BRIDGE_TOKEN
 *  - defaultWaker: default waker ID
 *  - timeoutMs:   request timeout (default: 120000)
 *  - eventsEnabled: signed lifecycle events to Wake (default: false)
 *  - eventSecret:   HMAC secret; falls back to OPENCLAW_EVENT_SECRET
 *  - agentId:       stable Wake governance alias (kai/cangrejo/hermes)
 *  - wakerId:        optional Wake waker identity attached to events
 */
import { Type } from "typebox";
import {
  WakeArtifactParameters,
  WakeAttachmentParameters,
  createWakeArtifactTool,
  createWakeAttachmentTool,
} from "./attachment-tools.js";
import { WakeEventDispatcher, wakeEventConfig } from "./event-transport.js";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:19900";
const DEFAULT_TIMEOUT_MS = 120_000;

interface KwBridgeConfig {
  enabled?: boolean;
  daemonUrl?: string;
  authToken?: string;
  defaultWaker?: string;
  timeoutMs?: number;
}

const SecretRefSchema = Type.Object({
  source: Type.Union([
    Type.Literal("env"),
    Type.Literal("file"),
    Type.Literal("exec"),
    Type.Literal("store"),
  ]),
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);

export function resolveConfig(config: Record<string, unknown> | undefined): KwBridgeConfig {
  const hasExplicitAuthToken = config && Object.prototype.hasOwnProperty.call(config, "authToken");
  const configuredAuthToken = typeof config?.authToken === "string" ? config.authToken : undefined;
  return {
    // The plugin can be loaded for event tracing without exposing delegation
    // tools. Require an explicit opt-in for the tool surface.
    enabled: config?.enabled === true,
    daemonUrl: (config?.daemonUrl as string) || DEFAULT_DAEMON_URL,
    // Prefer an explicit SecretRef-resolved value. Only an omitted field may
    // use the ambient env fallback; an unresolved explicit SecretRef fails
    // closed instead of silently selecting another credential.
    authToken:
      configuredAuthToken ||
      (!hasExplicitAuthToken ? process.env.KAIROS_WAKE_BRIDGE_TOKEN : undefined),
    defaultWaker: config?.defaultWaker as string | undefined,
    timeoutMs: (config?.timeoutMs as number) || DEFAULT_TIMEOUT_MS,
  };
}

function buildHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

const toolEntry = defineToolPlugin({
  id: "kairos-wake-bridge",
  name: "Kairos-Wake Bridge",
  description:
    "Delegate tasks to Kairos-Wake wakers. Create sessions, send messages, and receive responses from waker agents running on the Kairos-Wake daemon.",
  configSchema: Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    daemonUrl: Type.Optional(Type.String()),
    authToken: Type.Optional(SecretInputSchema),
    defaultWaker: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer()),
    eventsEnabled: Type.Optional(Type.Boolean()),
    eventSecret: Type.Optional(SecretInputSchema),
    agentId: Type.Optional(Type.String()),
    wakerId: Type.Optional(Type.String()),
  }),
  tools: (tool) => [
    tool({
      name: "kw_list_wakers",
      label: "List Wakers",
      description:
        "List all available Kairos-Wake wakers with their status, model, and tool preset. Use this to discover which wakers are available before sending tasks.",
      parameters: Type.Object({}),
      async execute(_params, rawConfig) {
        const config = resolveConfig(rawConfig as Record<string, unknown>);
        if (!config.enabled) {
          return "Kairos-Wake bridge is disabled.";
        }
        const res = await fetchWithTimeout(
          `${config.daemonUrl}/api/wakers`,
          {
            method: "GET",
            headers: buildHeaders(config.authToken),
          },
          10_000,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return `Error listing wakers: ${res.status} ${text}`;
        }
        const data = (await res.json()) as {
          data?: Array<{
            id: string;
            name: string;
            status: string;
            model?: string;
            tool_preset?: string;
          }>;
        };
        const wakers = data.data ?? [];
        if (wakers.length === 0) {
          return "No wakers found.";
        }
        const lines = wakers.map(
          (w) =>
            `  ${w.id}: ${w.name} (status=${w.status}, model=${w.model ?? "default"}, preset=${w.tool_preset ?? "base"})`,
        );
        return `Available wakers (${wakers.length}):\n${lines.join("\n")}`;
      },
    }),
    tool({
      name: "kw_send_message",
      label: "Send Message to Waker",
      description:
        "Send a message to a Kairos-Wake waker. If session_id is provided, continues an existing conversation (the waker remembers previous messages). If omitted, creates a new session. Returns the session ID and the waker's response. Use kw_list_wakers first to find available waker IDs. To have a multi-turn conversation, reuse the session_id from the first call.",
      parameters: Type.Object({
        waker_id: Type.String({
          description:
            "The waker ID to send the message to. Use kw_list_wakers to find available IDs.",
        }),
        message: Type.String({
          description: "The message or task to send to the waker.",
        }),
        session_id: Type.Optional(
          Type.String({
            description:
              "Optional: reuse an existing session for multi-turn conversation. Pass the session_id returned from a previous kw_send_message call to continue the same conversation. The waker will have full context of previous messages.",
          }),
        ),
        project_id: Type.Optional(
          Type.String({
            description: "Optional project ID to associate with a new session.",
          }),
        ),
      }),
      async execute(params, rawConfig) {
        const config = resolveConfig(rawConfig as Record<string, unknown>);
        if (!config.enabled) {
          return "Kairos-Wake bridge is disabled.";
        }
        const wakerId = (params as { waker_id: string }).waker_id || config.defaultWaker;
        if (!wakerId) {
          return "Error: waker_id is required (or set defaultWaker in plugin config).";
        }
        const message = (params as { message: string }).message;
        if (!message) {
          return "Error: message is required.";
        }
        const sessionId = (params as { session_id?: string }).session_id;
        const projectId = (params as { project_id?: string }).project_id;

        let sessionUrl: string;
        const body: Record<string, unknown> = { message };

        if (sessionId) {
          // Continue existing session via /api/sessions/:id/send
          sessionUrl = `${config.daemonUrl}/api/sessions/${encodeURIComponent(sessionId)}/send`;
        } else {
          // Create new session via /api/wakers/:id/sessions
          sessionUrl = `${config.daemonUrl}/api/wakers/${encodeURIComponent(wakerId)}/sessions`;
          if (projectId) {
            body.project_id = projectId;
          }
        }

        const res = await fetchWithTimeout(
          sessionUrl,
          {
            method: "POST",
            headers: buildHeaders(config.authToken),
            body: JSON.stringify(body),
          },
          config.timeoutMs!,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return `Error ${sessionId ? "sending to" : "creating"} session: ${res.status} ${text}`;
        }
        const data = (await res.json()) as {
          data?: {
            id: string;
            status: string;
            waker_id: string;
          };
          sessionId?: string;
          status?: string;
        };
        const session = data.data;
        const resolvedSessionId = session?.id || data.sessionId;
        if (!resolvedSessionId) {
          return "Error: unexpected response format from Kairos-Wake.";
        }
        // Poll for the response — the session may take time to process
        const pollRes = await fetchWithTimeout(
          `${config.daemonUrl}/api/sessions/${encodeURIComponent(resolvedSessionId)}/poll?since=0`,
          {
            method: "GET",
            headers: buildHeaders(config.authToken),
          },
          config.timeoutMs!,
        );
        if (!pollRes.ok) {
          return `Session ${sessionId ? "updated" : "created"} (id=${resolvedSessionId}) but polling failed: ${pollRes.status}`;
        }
        const pollData = (await pollRes.json()) as {
          data?: Array<{
            type: string;
            content?: string;
            text?: string;
            _seq?: number;
          }>;
          checkpoint?: { content?: string };
          sessionStatus?: string;
        };
        const events = pollData.data ?? [];
        const checkpoint = pollData.checkpoint;
        const assistantMessages = events
          .filter((e) => e.type === "assistant" || e.type === "response")
          .map((e) => e.content || e.text || "")
          .filter(Boolean);
        const checkpointContent = checkpoint?.content || "";
        const responseText =
          assistantMessages.length > 0
            ? assistantMessages.join("\n")
            : checkpointContent
              ? checkpointContent
              : "Session created but no response yet. Use kw_get_response with the session ID to poll for results.";
        const prefix = sessionId
          ? `Session: ${resolvedSessionId} (continued, waker=${wakerId})`
          : `Session: ${resolvedSessionId} (new, waker=${wakerId}, status=${session?.status ?? data.status ?? "active"})`;
        return `${prefix}\n\nResponse:\n${responseText}`;
      },
    }),
    tool({
      name: "kw_get_response",
      label: "Get Waker Response",
      description:
        "Poll a Kairos-Wake session for new events/responses. Use this after kw_send_message if the initial response was incomplete or to check for updates on a long-running task.",
      parameters: Type.Object({
        session_id: Type.String({
          description: "The session ID to poll for responses.",
        }),
        since: Type.Optional(
          Type.Integer({
            description: "Event sequence number to poll from (default: 0 for all events).",
          }),
        ),
      }),
      async execute(params, rawConfig) {
        const config = resolveConfig(rawConfig as Record<string, unknown>);
        if (!config.enabled) {
          return "Kairos-Wake bridge is disabled.";
        }
        const sessionId = (params as { session_id: string }).session_id;
        if (!sessionId) {
          return "Error: session_id is required.";
        }
        const since = (params as { since?: number }).since ?? 0;
        const res = await fetchWithTimeout(
          `${config.daemonUrl}/api/sessions/${encodeURIComponent(sessionId)}/poll?since=${since}`,
          {
            method: "GET",
            headers: buildHeaders(config.authToken),
          },
          30_000,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return `Error polling session: ${res.status} ${text}`;
        }
        const data = (await res.json()) as {
          data?: Array<{
            type: string;
            content?: string;
            text?: string;
            _seq?: number;
            role?: string;
          }>;
          checkpoint?: { content?: string };
          sessionStatus?: string;
        };
        const events = data.data ?? [];
        const checkpoint = data.checkpoint;
        const sessionStatus = data.sessionStatus;
        if (events.length === 0 && !checkpoint?.content) {
          if (sessionStatus === "completed") {
            return `Session ${sessionId} is completed but no response content was found.`;
          }
          return `No new events for session ${sessionId}. Status: ${sessionStatus ?? "unknown"}. Poll again in a few seconds.`;
        }
        const lines = events.map((e) => {
          const content = e.content || e.text || "";
          const role = e.role || e.type || "unknown";
          return `[${e["_seq"] ?? "?"}] ${role}: ${content}`;
        });
        const parts: string[] = [];
        if (lines.length > 0) {
          parts.push(`Session ${sessionId} events (${events.length}):`);
          parts.push(lines.join("\n"));
        }
        if (checkpoint?.content && lines.length === 0) {
          parts.push(`Session ${sessionId} (${sessionStatus ?? "unknown"}):`);
          parts.push(checkpoint.content);
        }
        return parts.join("\n");
      },
    }),
    tool({
      name: "kw_wake_attachment",
      label: "Wake Attachment",
      description:
        "Upload or download a file in the current governed Kairos-Wake proxy session. The scoped Wake service token is kept inside the bridge and is never exposed to the model.",
      parameters: WakeAttachmentParameters,
      factory({ toolContext, config }) {
        return createWakeAttachmentTool(
          toolContext,
          resolveConfig(config as Record<string, unknown>),
        );
      },
    }),
    tool({
      name: "kw_wake_artifact",
      label: "Wake Room Artifact",
      description:
        "List or register a governed artifact in a Kairos-Wake room without exposing a Wake token in the prompt.",
      parameters: WakeArtifactParameters,
      factory({ toolContext, config }) {
        return createWakeArtifactTool(
          toolContext,
          resolveConfig(config as Record<string, unknown>),
        );
      },
    }),
  ],
});

function registerWakeEvents(api: OpenClawPluginApi): void {
  const config = wakeEventConfig(api);
  if (!config.eventsEnabled) {
    api.logger.debug?.("Kairos-Wake event bridge is disabled (set eventsEnabled=true to activate)");
    return;
  }
  if (!config.daemonUrl || !config.eventSecret) {
    api.logger.warn("Kairos-Wake event bridge disabled: daemonUrl and eventSecret are required");
    return;
  }

  const dispatcher = new WakeEventDispatcher(api.logger, config);
  api.on("session_start", (event, context) => dispatcher.enqueue("session_start", event, context));
  api.on("session_end", (event, context) => dispatcher.enqueue("session_end", event, context));
  api.on("model_call_started", (event, context) =>
    dispatcher.enqueue("model_call_started", event, context),
  );
  api.on("model_call_ended", (event, context) =>
    dispatcher.enqueue("model_call_ended", event, context),
  );
  api.on("before_tool_call", (event, context) =>
    dispatcher.enqueue("before_tool_call", event, context),
  );
  api.on("after_tool_call", (event, context) =>
    dispatcher.enqueue("after_tool_call", event, context),
  );
  api.on("before_compaction", (event, context) =>
    dispatcher.enqueue("before_compaction", event, context),
  );
  api.on("after_compaction", (event, context) =>
    dispatcher.enqueue("after_compaction", event, context),
  );
  api.on("subagent_spawned", (event, context) =>
    dispatcher.enqueue("subagent_spawned", event, context),
  );
  api.on("subagent_progress", (event, context) =>
    dispatcher.enqueue("subagent_progress", event, context),
  );
  api.on("subagent_ended", (event, context) =>
    dispatcher.enqueue("subagent_ended", event, context),
  );
  api.on("agent_end", (event, context) => dispatcher.enqueue("agent_end", event, context));
  // Emit a bounded, payload-free transport probe at gateway startup. It has
  // no session identity and therefore cannot create a Wake shadow; it only
  // proves that this configured bridge can reach Wake without requiring an
  // LLM turn or leaking user content.
  dispatcher.enqueue("bridge_ready", {}, {});
  api.logger.info("Kairos-Wake event bridge enabled for 12 lifecycle hooks + startup probe");
}

const eventEntry = definePluginEntry({
  id: "kairos-wake-bridge",
  name: "Kairos-Wake Bridge",
  description:
    "Delegate tasks to Kairos-Wake wakers and emit signed OpenClaw lifecycle events for Wake tracing.",
  configSchema: toolEntry.configSchema,
  register(api) {
    toolEntry.register(api);
    registerWakeEvents(api);
  },
});
const toolMetadata = getToolPluginMetadata(toolEntry);
if (toolMetadata) {
  Object.defineProperty(eventEntry, toolPluginMetadataSymbol, {
    value: toolMetadata,
    enumerable: false,
  });
}

export default eventEntry;
