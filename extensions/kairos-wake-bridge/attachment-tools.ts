import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

type WakeAttachmentConfig = {
  enabled?: boolean;
  daemonUrl?: string;
  authToken?: string;
  timeoutMs?: number;
};

function result(
  text: string,
  details?: Record<string, unknown>,
): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel));
}

async function safePath(
  input: string,
  ctx: OpenClawPluginToolContext,
  forWrite: boolean,
): Promise<string> {
  const candidate = resolve(input);
  const roots = [ctx.workspaceDir, ctx.agentDir, "/tmp"].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  let target: string;
  if (!forWrite) {
    target = await realpath(candidate);
  } else {
    try {
      target = await realpath(candidate);
    } catch {
      const missingSegments = [basename(candidate)];
      let current = dirname(candidate);
      while (true) {
        try {
          target = resolve(await realpath(current), ...missingSegments);
          break;
        } catch {
          const parent = dirname(current);
          if (parent === current) throw new Error("Download path cannot be resolved safely.");
          missingSegments.unshift(basename(current));
          current = parent;
        }
      }
    }
  }
  for (const root of roots) {
    const canonicalRoot = await realpath(root).catch(() => resolve(root));
    if (pathWithin(canonicalRoot, target)) return target;
  }
  throw new Error("Path is outside the OpenClaw workspace, agent directory, or /tmp");
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function fetchWithSignal(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(timeoutMs, 5_000), 300_000),
  );
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500) || `HTTP ${response.status}`;
}

export const WakeAttachmentParameters = Type.Object(
  {
    action: Type.Union([Type.Literal("upload"), Type.Literal("download")]),
    session_id: Type.String({ minLength: 1, maxLength: 200 }),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    attachment_id: Type.Optional(Type.Integer({ minimum: 1 })),
    output_path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    file_name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    mime_type: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);

export const WakeArtifactParameters = Type.Object(
  {
    action: Type.Union([Type.Literal("list"), Type.Literal("register")]),
    room_id: Type.String({ minLength: 1, maxLength: 200 }),
    session_id: Type.String({ minLength: 1, maxLength: 200 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    type: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    reference: Type.Optional(Type.String({ maxLength: 2000 })),
    summary: Type.Optional(Type.String({ maxLength: 4000 })),
    source_tool: Type.Optional(Type.String({ maxLength: 100 })),
    status: Type.Optional(Type.String({ maxLength: 50 })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export function createWakeAttachmentTool(
  toolContext: OpenClawPluginToolContext,
  config: WakeAttachmentConfig,
): AnyAgentTool {
  return {
    name: "kw_wake_attachment",
    label: "Wake Attachment",
    description:
      "Upload a local file to, or download a file from, the current governed Kairos-Wake proxy session. The Wake service token stays inside the bridge and is never exposed to the model.",
    parameters: WakeAttachmentParameters,
    async execute(_toolCallId, rawParams, signal) {
      if (!config.enabled) return result("Kairos-Wake bridge is disabled.");
      if (!config.authToken)
        return result("Kairos-Wake attachment tools require a scoped service token.");
      const params = rawParams as {
        action: "upload" | "download";
        session_id: string;
        path?: string;
        attachment_id?: number;
        output_path?: string;
        file_name?: string;
        mime_type?: string;
      };
      const baseUrl = (config.daemonUrl ?? "http://127.0.0.1:19900").replace(/\/$/, "");

      if (params.action === "upload") {
        if (!params.path) return result("path is required for upload.");
        let source: string;
        try {
          source = await safePath(params.path, toolContext, false);
        } catch (error) {
          return result(error instanceof Error ? error.message : "Upload path is not allowed.");
        }
        const fileInfo = await stat(source);
        if (!fileInfo.isFile()) return result("Upload path is not a regular file.");
        if (fileInfo.size <= 0 || fileInfo.size > MAX_ATTACHMENT_BYTES) {
          return result("File is empty or exceeds the 50 MB bridge limit.");
        }
        const bytes = await readFile(source);
        const form = new FormData();
        form.append(
          "file",
          new Blob([bytes], { type: params.mime_type || "application/octet-stream" }),
          params.file_name || source.split(/[\\/]/).pop() || "attachment.bin",
        );
        const response = await fetchWithSignal(
          `${baseUrl}/api/openclaw/sessions/${encodeURIComponent(params.session_id)}/attachments`,
          { method: "POST", headers: authHeaders(config.authToken), body: form },
          signal,
          config.timeoutMs ?? 120_000,
        );
        if (!response.ok)
          return result(`Wake attachment upload failed: ${await readError(response)}`);
        const data = await response.json().catch(() => ({}));
        return result("Attachment uploaded to Kairos-Wake.", { data });
      }

      if (!params.attachment_id) return result("attachment_id is required for download.");
      let output: string;
      try {
        output = await safePath(
          params.output_path || `/tmp/wake-attachment-${params.attachment_id}`,
          toolContext,
          true,
        );
      } catch (error) {
        return result(error instanceof Error ? error.message : "Download path is not allowed.");
      }
      const response = await fetchWithSignal(
        `${baseUrl}/api/openclaw/sessions/${encodeURIComponent(params.session_id)}/attachments/${params.attachment_id}`,
        { method: "GET", headers: authHeaders(config.authToken) },
        signal,
        config.timeoutMs ?? 120_000,
      );
      if (!response.ok)
        return result(`Wake attachment download failed: ${await readError(response)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
        return result("Downloaded attachment exceeds the bridge limit.");
      await writeFile(output, bytes, { mode: 0o600 });
      return result(`Attachment downloaded to ${output}.`, {
        path: output,
        bytes: bytes.byteLength,
        mime: response.headers.get("content-type") || "application/octet-stream",
      });
    },
  };
}

export function createWakeArtifactTool(
  _toolContext: OpenClawPluginToolContext,
  config: WakeAttachmentConfig,
): AnyAgentTool {
  return {
    name: "kw_wake_artifact",
    label: "Wake Room Artifact",
    description:
      "List or register a governed artifact in the current Kairos-Wake room without exposing a Wake token in the prompt.",
    parameters: WakeArtifactParameters,
    async execute(_toolCallId, rawParams, signal) {
      if (!config.enabled) return result("Kairos-Wake bridge is disabled.");
      if (!config.authToken)
        return result("Kairos-Wake artifact tools require a scoped service token.");
      const params = rawParams as Record<string, unknown>;
      const action = params.action === "register" ? "register" : "list";
      const roomId = String(params.room_id || "");
      const sessionId = String(params.session_id || "");
      const baseUrl = (config.daemonUrl ?? "http://127.0.0.1:19900").replace(/\/$/, "");
      const endpoint = `${baseUrl}/api/openclaw/rooms/${encodeURIComponent(roomId)}/artifacts`;

      if (action === "list") {
        const response = await fetchWithSignal(
          `${endpoint}?session_id=${encodeURIComponent(sessionId)}`,
          { method: "GET", headers: authHeaders(config.authToken) },
          signal,
          config.timeoutMs ?? 120_000,
        );
        if (!response.ok)
          return result(`Wake artifact listing failed: ${await readError(response)}`);
        return result("Kairos-Wake room artifacts retrieved.", {
          data: await response.json().catch(() => ({})),
        });
      }

      if (!params.title) return result("title is required when registering an artifact.");
      const response = await fetchWithSignal(
        endpoint,
        {
          method: "POST",
          headers: { ...authHeaders(config.authToken), "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            title: params.title,
            type: params.type,
            reference: params.reference,
            summary: params.summary,
            source_tool: params.source_tool,
            status: params.status,
            metadata: params.metadata,
          }),
        },
        signal,
        config.timeoutMs ?? 120_000,
      );
      if (!response.ok)
        return result(`Wake artifact registration failed: ${await readError(response)}`);
      return result("Artifact registered in Kairos-Wake.", {
        data: await response.json().catch(() => ({})),
      });
    },
  };
}
