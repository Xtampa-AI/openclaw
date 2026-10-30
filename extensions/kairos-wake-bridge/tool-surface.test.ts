import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWakeToolDiscoveryTool,
  createWakeToolDocsTool,
  createWakeToolExecuteTool,
} from "./tool-surface.js";

const config = {
  enabled: true,
  toolSurfaceEnabled: true,
  daemonUrl: "http://wake.test",
  authToken: "kwoc_test-only",
  agentId: "kai",
  timeoutMs: 10_000,
};

const context = {
  sessionKey: "agent:kai:openai:openclaw-eval",
  workspaceDir: "/tmp",
  agentDir: "/tmp",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Kairos-Wake governed native tool surface", () => {
  it("discovers effective tools with the linked session headers", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse({ data: { tools: [{ name: "sys_list_wakers", description: "List wakers" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeToolDiscoveryTool(context as never, config);
    const response = await tool.execute("discover", {}, undefined);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://wake.test/api/openclaw/tools/effective");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer kwoc_test-only",
      "X-Kairos-Wake-Session-Key": "agent:kai:openai:openclaw-eval",
      "X-Kairos-Wake-Agent": "kai",
    });
    expect(JSON.stringify(response)).toContain("sys_list_wakers");
    expect(JSON.stringify(response)).not.toContain("kwoc_test-only");
  });

  it("retrieves a URL-encoded tool schema without accepting a model session id", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse({ data: { tool: { name: "sys_list_wakers", readOnly: true } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeToolDocsTool(context as never, config);
    await tool.execute("docs", { tool_name: "sys_list_wakers" }, undefined);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://wake.test/api/openclaw/tools/docs/sys_list_wakers");
    expect((init as RequestInit).method).toBe("GET");
    expect(String((init as RequestInit).body ?? "")).toBe("");
  });

  it("executes only through the Wake session-bound endpoint", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse({ data: { output: "2 wakers", error: null } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeToolExecuteTool(context as never, config);
    const response = await tool.execute(
      "execute",
      { tool_name: "sys_list_wakers", parameters: { status: "online" } },
      undefined,
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://wake.test/api/openclaw/tools/execute");
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer kwoc_test-only",
      "X-Kairos-Wake-Session-Key": "agent:kai:openai:openclaw-eval",
      "X-Kairos-Wake-Agent": "kai",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      tool_name: "sys_list_wakers",
      parameters: { status: "online" },
    });
    expect(JSON.stringify(response)).toContain("2 wakers");
    expect(JSON.stringify(response)).not.toContain("kwoc_test-only");
  });

  it("stays disabled or sessionless without making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const disabledTool = createWakeToolDiscoveryTool(context as never, {
      ...config,
      toolSurfaceEnabled: false,
    });
    const disabled = await disabledTool.execute("disabled", {}, undefined);
    expect(JSON.stringify(disabled)).toContain("disabled");

    const sessionlessTool = createWakeToolDiscoveryTool({} as never, config);
    const sessionless = await sessionlessTool.execute("sessionless", {}, undefined);
    expect(JSON.stringify(sessionless)).toContain("session");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can be enabled without enabling legacy delegation tools", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse({ data: { tools: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeToolDiscoveryTool(context as never, {
      ...config,
      enabled: false,
      toolSurfaceEnabled: true,
    });
    await tool.execute("native-only", {}, undefined);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
