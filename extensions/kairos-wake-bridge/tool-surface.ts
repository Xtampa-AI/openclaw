import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:19900";
const MAX_TIMEOUT_MS = 300_000;

export type WakeToolSurfaceConfig = {
  enabled?: boolean;
  toolSurfaceEnabled?: boolean;
  daemonUrl?: string;
  authToken?: string;
  agentId?: string;
  timeoutMs?: number;
};

export const WakeToolDiscoveryParameters = Type.Object({}, { additionalProperties: false });

export const WakeToolDocsParameters = Type.Object(
  {
    tool_name: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const WakeToolExecuteParameters = Type.Object(
  {
    tool_name: Type.String({ minLength: 1, maxLength: 200 }),
    parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

type ToolDiscoveryParams = Static<typeof WakeToolDiscoveryParameters>;
type ToolDocsParams = Static<typeof WakeToolDocsParameters>;
type ToolExecuteParams = Static<typeof WakeToolExecuteParameters>;

function result(
  text: string,
  details?: Record<string, unknown>,
): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

function baseUrl(config: WakeToolSurfaceConfig): string {
  return (config.daemonUrl || DEFAULT_DAEMON_URL).replace(/\/$/, "");
}

function timeoutMs(config: WakeToolSurfaceConfig): number {
  return Math.min(Math.max(config.timeoutMs ?? 120_000, 5_000), MAX_TIMEOUT_MS);
}

function headers(
  config: WakeToolSurfaceConfig,
  toolContext: OpenClawPluginToolContext,
): Record<string, string> | null {
  if (!config.authToken || !toolContext.sessionKey) return null;
  return {
    Authorization: `Bearer ${config.authToken}`,
    "X-Kairos-Wake-Session-Key": toolContext.sessionKey,
    ...(config.agentId ? { "X-Kairos-Wake-Agent": config.agentId } : {}),
  };
}

async function fetchWithSignal(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const parsed = await response.json().catch(() => ({}));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function errorText(body: Record<string, unknown>, status: number): string {
  const error = body.error;
  if (typeof error === "string") return error.slice(0, 500);
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message.slice(0, 500);
  }
  return `HTTP ${status}`;
}

function disabled(config: WakeToolSurfaceConfig): string | null {
  if (!config.toolSurfaceEnabled) return "Kairos-Wake native tool surface is disabled.";
  if (!config.authToken) {
    return "Kairos-Wake native tool surface requires a scoped service token.";
  }
  return null;
}

function missingSession(): ReturnType<typeof result> {
  return result("Kairos-Wake native tool surface requires a Wake-linked OpenClaw session.");
}

export function createWakeToolDiscoveryTool(
  toolContext: OpenClawPluginToolContext,
  config: WakeToolSurfaceConfig,
): AnyAgentTool {
  return {
    name: "kw_wake_discover_tools",
    label: "Wake Discover Tools",
    description:
      "List the effective read-only Kairos-Wake native tools for this exact governed OpenClaw session. Call this before kw_wake_get_tool_docs.",
    parameters: WakeToolDiscoveryParameters,
    async execute(_toolCallId, _params: ToolDiscoveryParams, signal) {
      const blocked = disabled(config);
      if (blocked) return result(blocked);
      const requestHeaders = headers(config, toolContext);
      if (!requestHeaders) return missingSession();
      const response = await fetchWithSignal(
        `${baseUrl(config)}/api/openclaw/tools/effective`,
        { method: "GET", headers: requestHeaders },
        signal,
        timeoutMs(config),
      );
      const body = await responseBody(response);
      if (!response.ok)
        return result(`Wake tool discovery failed: ${errorText(body, response.status)}`);
      const data = (body.data ?? body) as { tools?: unknown };
      const tools = Array.isArray(data.tools) ? data.tools : [];
      const names = tools
        .map((tool) =>
          tool &&
          typeof tool === "object" &&
          typeof (tool as Record<string, unknown>).name === "string"
            ? String((tool as Record<string, unknown>).name)
            : null,
        )
        .filter((name): name is string => Boolean(name));
      return result(
        names.length > 0
          ? `Wake read-only tools (${names.length}):\n${names.map((name) => `- ${name}`).join("\n")}`
          : "Wake exposes no effective read-only tools for this session.",
        {
          tools: tools.map((tool) => {
            if (!tool || typeof tool !== "object") return tool;
            const record = tool as Record<string, unknown>;
            return { name: record.name, description: record.description };
          }),
        },
      );
    },
  };
}

export function createWakeToolDocsTool(
  toolContext: OpenClawPluginToolContext,
  config: WakeToolSurfaceConfig,
): AnyAgentTool {
  return {
    name: "kw_wake_get_tool_docs",
    label: "Wake Tool Docs",
    description:
      "Return the exact schema for one effective read-only Kairos-Wake native tool. Call kw_wake_discover_tools first.",
    parameters: WakeToolDocsParameters,
    async execute(_toolCallId, rawParams: ToolDocsParams, signal) {
      const blocked = disabled(config);
      if (blocked) return result(blocked);
      const requestHeaders = headers(config, toolContext);
      if (!requestHeaders) return missingSession();
      const response = await fetchWithSignal(
        `${baseUrl(config)}/api/openclaw/tools/docs/${encodeURIComponent(rawParams.tool_name)}`,
        { method: "GET", headers: requestHeaders },
        signal,
        timeoutMs(config),
      );
      const body = await responseBody(response);
      if (!response.ok) return result(`Wake tool docs failed: ${errorText(body, response.status)}`);
      const data = body.data ?? body;
      return result(JSON.stringify(data), { data });
    },
  };
}

export function createWakeToolExecuteTool(
  toolContext: OpenClawPluginToolContext,
  config: WakeToolSurfaceConfig,
): AnyAgentTool {
  return {
    name: "kw_wake_execute_tool",
    label: "Wake Execute Read-only Tool",
    description:
      "Execute one effective read-only Kairos-Wake native tool in the current governed session. Use kw_wake_get_tool_docs first. Mutating tools are rejected by Wake.",
    parameters: WakeToolExecuteParameters,
    async execute(_toolCallId, rawParams: ToolExecuteParams, signal) {
      const blocked = disabled(config);
      if (blocked) return result(blocked);
      const requestHeaders = headers(config, toolContext);
      if (!requestHeaders) return missingSession();
      const response = await fetchWithSignal(
        `${baseUrl(config)}/api/openclaw/tools/execute`,
        {
          method: "POST",
          headers: { ...requestHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            tool_name: rawParams.tool_name,
            parameters: rawParams.parameters ?? {},
          }),
        },
        signal,
        timeoutMs(config),
      );
      const body = await responseBody(response);
      if (!response.ok)
        return result(`Wake tool execution failed: ${errorText(body, response.status)}`);
      const data = (body.data ?? body) as { output?: unknown; error?: unknown };
      if (data.error)
        return result(`Wake tool returned an error: ${String(data.error).slice(0, 1_000)}`, {
          data,
        });
      return result(
        typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? data),
        { data },
      );
    },
  };
}
