import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWakeArtifactTool, createWakeAttachmentTool } from "./attachment-tools.js";

const config = {
  enabled: true,
  daemonUrl: "http://wake.test",
  authToken: "kwoc_test-only",
  timeoutMs: 10_000,
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createContext() {
  const directory = await mkdtemp("/tmp/kairos-wake-bridge-test-");
  tempDirs.push(directory);
  return {
    workspaceDir: directory,
    agentDir: directory,
  };
}

describe("Kairos-Wake governed attachment tools", () => {
  it("uploads a workspace file with the service token kept in the request layer", async () => {
    const context = await createContext();
    const source = join(context.workspaceDir, "report.txt");
    await writeFile(source, "hello from OpenClaw");
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ data: { attachmentId: 41 } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeAttachmentTool(context as never, config);
    const response = await tool.execute(
      "call-upload",
      { action: "upload", session_id: "wake-session", path: source },
      undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://wake.test/api/openclaw/sessions/wake-session/attachments");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer kwoc_test-only" });
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect(JSON.stringify(response)).not.toContain("kwoc_test-only");
    expect(JSON.stringify(response)).toContain("41");
  });

  it("downloads an attachment only into an allowed local path", async () => {
    const context = await createContext();
    const output = join(context.workspaceDir, "downloaded.txt");
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response("downloaded content", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeAttachmentTool(context as never, config);
    const response = await tool.execute(
      "call-download",
      {
        action: "download",
        session_id: "wake-session",
        attachment_id: 41,
        output_path: output,
      },
      undefined,
    );

    expect(await readFile(output, "utf8")).toBe("downloaded content");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://wake.test/api/openclaw/sessions/wake-session/attachments/41",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer kwoc_test-only" },
      }),
    );
    expect(JSON.stringify(response)).toContain(output);
  });

  it("rejects a path outside the workspace before making a network request", async () => {
    const context = await createContext();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeAttachmentTool(context as never, config);
    const response = await tool.execute(
      "call-unsafe",
      { action: "upload", session_id: "wake-session", path: "/etc/hosts" },
      undefined,
    );

    expect(JSON.stringify(response)).toContain("outside");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the same governed service-token boundary for room artifacts", async () => {
    const context = await createContext();
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ data: { artifacts: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWakeArtifactTool(context as never, config);
    await tool.execute(
      "call-artifacts",
      { action: "list", room_id: "room-1", session_id: "wake-session" },
      undefined,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://wake.test/api/openclaw/rooms/room-1/artifacts?session_id=wake-session",
      expect.objectContaining({ headers: { Authorization: "Bearer kwoc_test-only" } }),
    );
  });
});
