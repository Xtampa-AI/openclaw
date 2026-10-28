import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_MAX_IN_FLIGHT, EVENT_MAX_QUEUE, WakeEventDispatcher } from "./event-transport.js";

const config = {
  eventsEnabled: true,
  daemonUrl: "http://wake.test",
  eventSecret: "test-secret",
  agentId: "kai",
  timeoutMs: 1_000,
};

function makeLogger() {
  return {
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as OpenClawPluginApi["logger"],
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WakeEventDispatcher", () => {
  it("bounds concurrent deliveries and drains queued events", async () => {
    let active = 0;
    let maxActive = 0;
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          pending.push((response) => {
            active -= 1;
            resolve(response);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { logger } = makeLogger();
    const dispatcher = new WakeEventDispatcher(logger, config);
    const total = EVENT_MAX_IN_FLIGHT * 3;
    for (let index = 0; index < total; index += 1) {
      dispatcher.enqueue("subagent_progress", { runId: String(index) }, { runId: String(index) });
    }

    expect(fetchMock).toHaveBeenCalledTimes(EVENT_MAX_IN_FLIGHT);
    expect(maxActive).toBe(EVENT_MAX_IN_FLIGHT);

    while (fetchMock.mock.calls.length < total) {
      const batch = pending.splice(0);
      expect(batch.length).toBeGreaterThan(0);
      for (const resolve of batch) {
        resolve(new Response(null, { status: 202 }));
      }
      await tick();
    }

    for (const resolve of pending.splice(0)) {
      resolve(new Response(null, { status: 202 }));
    }
    await tick();
    expect(maxActive).toBe(EVENT_MAX_IN_FLIGHT);
    expect(active).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("drops excess queued events instead of growing without a bound", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const { logger } = makeLogger();
    const dispatcher = new WakeEventDispatcher(logger, config);
    const total = EVENT_MAX_IN_FLIGHT + EVENT_MAX_QUEUE + 1;
    for (let index = 0; index < total; index += 1) {
      dispatcher.enqueue("agent_end", { runId: String(index) }, { runId: String(index) });
    }

    expect(fetchMock).toHaveBeenCalledTimes(EVENT_MAX_IN_FLIGHT);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`capacity=${EVENT_MAX_QUEUE}`),
    );
  });

  it("opens a circuit after repeated failures and suppresses new sends", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const { logger } = makeLogger();
    const dispatcher = new WakeEventDispatcher(logger, config);
    for (let index = 0; index < 32; index += 1) {
      dispatcher.enqueue("model_call_ended", { callId: String(index) }, {});
    }
    for (let index = 0; index < 10; index += 1) {
      await tick();
    }

    const callsWhenOpen = fetchMock.mock.calls.length;
    dispatcher.enqueue("session_end", { sessionId: "after-failure" }, {});
    await tick();

    expect(callsWhenOpen).toBeLessThan(32);
    expect(fetchMock).toHaveBeenCalledTimes(callsWhenOpen);
  });
});
