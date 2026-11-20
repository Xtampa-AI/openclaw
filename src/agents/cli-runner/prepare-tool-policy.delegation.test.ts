import { expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

type Input = Parameters<typeof resolveCliRuntimeToolPolicy>[0];
type Tools = RunCliAgentParams["cliToolAvailability"];
type Overrides = Partial<Omit<Input, "params">> & { params?: Partial<RunCliAgentParams> };
const session = { sessionId: "coding", updatedAt: 1 };
const emptyTools = { native: [], openClaw: [] };
const nativeSelection = { native: ["Read"], openClaw: [] };
const base: Input = {
  params: {
    sessionId: "coding",
    sessionKey: "agent:coder:dashboard:coding",
    sessionFile: "fixture.jsonl",
    workspaceDir: "/workspace",
    prompt: "implement",
    provider: "fixture-cli",
    model: "fixture",
    runId: "fixture-run",
    timeoutMs: 1000,
    config: {
      agents: {
        entries: {
          intake: { subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] } },
          coder: {},
        },
      },
    },
    sessionEntry: {
      ...session,
      spawnedBy: "agent:intake:main",
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec"],
      delegatedToolPolicy: {
        requesterSessionKey: "agent:intake:main",
        targetAgentId: "coder",
        deny: [],
        requesterDeny: ["exec"],
      },
    },
  },
  policyAgentId: "coder",
  policySessionKey: "agent:coder:dashboard:coding",
  backendId: "fixture-cli",
  bundleMcp: true,
  canEnforceExactToolAvailability: true,
  isSideQuestion: false,
  skipsTurnPreparation: false,
};
function makeInput({ params, ...overrides }: Overrides = {}, defaults = base): Input {
  return { ...defaults, ...overrides, params: { ...defaults.params, ...params } };
}
const workspace = makeInput({
  params: {
    sessionEntry: undefined,
    config: { tools: { fs: { workspaceOnly: true } } },
  },
});
const ordinary = makeInput({
  backendId: "claude-cli",
  params: { provider: "claude-cli", sessionEntry: session },
});
async function expectPolicy(request: Input, tools?: Tools, allow?: string[]) {
  const { params, runtimeToolsAllowPolicy } = await resolveCliRuntimeToolPolicy(request);
  expect([params.cliToolAvailability, runtimeToolsAllowPolicy]).toEqual([tools, allow]);
}

it.each([base, ordinary])("mediates delegated and ordinary Claude turns: %j", async (request) => {
  await expectPolicy(request, emptyTools, ["*"]);
});

it("refuses a backend that cannot enforce live delegated authority", async () => {
  await expect(
    resolveCliRuntimeToolPolicy(makeInput({ canEnforceExactToolAvailability: false })),
  ).rejects.toThrow("cannot enforce delegated execution tool policy");
});

it.each<Overrides>([
  { canEnforceExactToolAvailability: false },
  { bundleMcp: false },
  { params: { sessionEntry: { ...session, execHost: "node" } } },
])("refuses an unmediated workspace-only run: %j", async (overrides) => {
  await expect(resolveCliRuntimeToolPolicy(makeInput(overrides, workspace))).rejects.toThrow(
    "cannot enforce workspace-only tool policy",
  );
});

it("preserves an exact tool cap when replacing native tools", async () => {
  const request = makeInput(
    {
      params: { cliToolAvailability: { native: ["Read"], openClaw: ["message"] } },
      projectNativeToolAuthority: () => ["read"],
    },
    workspace,
  );
  await expectPolicy(request, { native: [], openClaw: ["message", "read"] });
});

it("keeps backend-enforced tool-free questions independent of the file tool policy", async () => {
  await expectPolicy(
    makeInput(
      {
        isSideQuestion: true,
        skipsTurnPreparation: true,
        sideQuestionToolMode: "disabled",
      },
      workspace,
    ),
  );
});

it.each<Overrides>([
  { backendId: "fixture-cli" },
  { bundleMcp: false },
  { canEnforceExactToolAvailability: false },
  { isSideQuestion: true },
  { skipsTurnPreparation: true },
  { params: { cliToolAvailability: nativeSelection } },
  { params: { sessionEntry: { ...session, execHost: "node" } } },
  { params: { config: { tools: { exec: { host: "node" } } } } },
  { params: { execOverrides: { host: "node" } } },
])("preserves the unmediated ordinary CLI surface: %j", async (overrides) => {
  await expectPolicy(makeInput(overrides, ordinary), overrides.params?.cliToolAvailability);
});

const managedNative = ["Agent", "Workflow"];
const completion: Partial<RunCliAgentParams> = {
  trustedInternalHandoff: {
    kind: "subagent-completion",
    sourceSessionKey: "agent:coder:subagent:child",
    targetSessionKey: "agent:coder:dashboard:coding",
    targetSessionId: "coding",
    provider: "claude-cli",
    model: "fixture",
  },
};
function withManagedNative(overrides: Overrides, defaults = ordinary): Input {
  return makeInput(
    {
      // Resolve by the policy agent, so per-agent selections follow the turn's owner.
      resolveManagedNativeTools: ({ agentId }) => (agentId === "coder" ? managedNative : []),
      ...overrides,
    },
    defaults,
  );
}

it.each([{}, { params: completion }])(
  "keeps the operator's managed native tools on ordinary and completion turns: %j",
  async (overrides) => {
    await expectPolicy(withManagedNative(overrides), { native: managedNative, openClaw: [] }, [
      "*",
    ]);
    // Prepare reads this list to know the selection confers no file capability.
    const result = await resolveCliRuntimeToolPolicy(withManagedNative(overrides));
    expect(result.managedNativeTools).toEqual(managedNative);
  },
);

it.each<[string, Overrides, Input]>([
  ["delegated execution", {}, base],
  ["workspace-only", { params: { config: { tools: { fs: { workspaceOnly: true } } } } }, ordinary],
  ["a caller tool cap", { params: { ...completion, toolsAllow: ["read"] } }, ordinary],
])("drops managed native tools for %s", async (_name, overrides, defaults) => {
  const result = await resolveCliRuntimeToolPolicy(withManagedNative(overrides, defaults));
  expect(result.params.cliToolAvailability?.native).toEqual([]);
  expect(result.managedNativeTools).toEqual([]);
});

it("leaves node-placed Claude turns on their unmediated native surface", async () => {
  await expectPolicy(
    withManagedNative({ params: { sessionEntry: { ...session, execHost: "node" } } }),
    undefined,
  );
});

describe("workspace-only CLI tool policy", () => {
  const workspaceInput = {
    ...input,
    params: {
      ...params,
      sessionEntry: undefined,
      config: { tools: { fs: { workspaceOnly: true } } },
    },
  };

  it.each([
    { canEnforceExactToolAvailability: false },
    { bundleMcp: false },
    {
      params: {
        ...workspaceInput.params,
        sessionEntry: { sessionId: "coding", updatedAt: 1, execHost: "node" as const },
      },
    },
  ])("refuses an unmediated workspace-only run: %j", async (overrides) => {
    await expect(resolveCliRuntimeToolPolicy({ ...workspaceInput, ...overrides })).rejects.toThrow(
      "cannot enforce workspace-only tool policy",
    );
  });

  it("preserves an exact tool cap when replacing native tools", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...workspaceInput,
      params: {
        ...workspaceInput.params,
        cliToolAvailability: { native: ["Read"], openClaw: ["message"] },
      },
      projectNativeToolAuthority: () => ["read"],
    });
    expect(result.params.cliToolAvailability).toEqual({
      native: [],
      openClaw: ["message", "read"],
    });
    expect(result.runtimeToolsAllowPolicy).toBeUndefined();
  });

  it("keeps backend-enforced tool-free questions independent of the file tool policy", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...workspaceInput,
      isSideQuestion: true,
      skipsTurnPreparation: true,
      sideQuestionToolMode: "disabled",
    });
    expect(result.params.cliToolAvailability).toBeUndefined();
    expect(result.runtimeToolsAllowPolicy).toBeUndefined();
  });
});

describe("ordinary Claude tool policy", () => {
  const ordinaryParams: RunCliAgentParams = {
    ...params,
    provider: "claude-cli",
    sessionEntry: { sessionId: "coding", updatedAt: 1 },
  };
  const ordinary = { ...input, params: ordinaryParams, backendId: "claude-cli" };

  it("selects the existing completion projection for ordinary agent turns", async () => {
    const result = await resolveCliRuntimeToolPolicy(ordinary);
    expect(result.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
    expect(result.runtimeToolsAllowPolicy).toEqual(["*"]);
  });

  it.each([
    { name: "another backend", backendId: "fixture-cli" },
    { name: "standalone without MCP", bundleMcp: false },
    { name: "without exact tool enforcement", canEnforceExactToolAvailability: false },
    { name: "side question", isSideQuestion: true },
    { name: "isolated utility completion", skipsTurnPreparation: true },
  ])("preserves the existing surface for $name", async ({ name: _name, ...overrides }) => {
    const result = await resolveCliRuntimeToolPolicy({ ...ordinary, ...overrides });
    expect(result.params.cliToolAvailability).toBeUndefined();
    expect(result.runtimeToolsAllowPolicy).toBeUndefined();
  });

  it("preserves explicit native tool selection and node placement", async () => {
    const selection = { native: ["Read"], openClaw: [] };
    const explicit = await resolveCliRuntimeToolPolicy({
      ...ordinary,
      params: { ...ordinaryParams, cliToolAvailability: selection },
    });
    expect(explicit.params.cliToolAvailability).toEqual(selection);
    const node = await resolveCliRuntimeToolPolicy({
      ...ordinary,
      params: {
        ...ordinaryParams,
        sessionEntry: { sessionId: "coding", updatedAt: 1, execHost: "node" },
      },
    });
    expect(node.params.cliToolAvailability).toBeUndefined();
  });

  it.each(["config", "run"] as const)(
    "preserves node-only execution selected by %s",
    async (source) => {
      const result = await resolveCliRuntimeToolPolicy({
        ...ordinary,
        params: {
          ...ordinaryParams,
          ...(source === "config"
            ? { config: { tools: { exec: { host: "node" as const } } } }
            : { execOverrides: { host: "node" as const } }),
        },
      });
      expect(result.params.cliToolAvailability).toBeUndefined();
    },
  );
});

it.each([false, true])(
  "keeps only operator-selected native tools on managed completion=%s",
  async (completion) => {
    const ordinary = {
      ...params,
      provider: "claude-cli",
      sessionEntry: { sessionId: "coding", updatedAt: 1 },
    };
    const result = await resolveCliRuntimeToolPolicy({
      ...input,
      backendId: "claude-cli",
      resolveManagedNativeTools: () => ["Agent", "Workflow"],
      params: {
        ...ordinary,
        ...(completion
          ? {
              trustedInternalHandoff: {
                kind: "subagent-completion",
                sourceSessionKey: "agent:coder:subagent:child",
                targetSessionKey: ordinary.sessionKey!,
                targetSessionId: "coding",
                provider: "claude-cli",
                model: "fixture",
              },
            }
          : {}),
      },
    });
    expect(result.managedNativeTools).toEqual(["Agent", "Workflow"]);
    expect(result.params.cliToolAvailability).toEqual({
      native: ["Agent", "Workflow"],
      openClaw: [],
    });
  },
);
it("never adds managed native tools to delegated runs", async () => {
  const result = await resolveCliRuntimeToolPolicy({
    ...input,
    backendId: "claude-cli",
    resolveManagedNativeTools: () => ["Agent"],
  });
  expect(result.managedNativeTools).toEqual([]);
  expect(result.params.cliToolAvailability?.native).toEqual([]);
});
