// Tests payload visibility, threading, and source-send deduplication.
import { describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

function resolve(
  payloads: Parameters<typeof resolveFollowupDeliveryPayloads>[0]["payloads"],
  options: Omit<Parameters<typeof resolveFollowupDeliveryPayloads>[0], "cfg" | "payloads"> = {},
) {
  return resolveFollowupDeliveryPayloads({ cfg: {}, payloads, ...options });
}
const answer = "The answer remains unchanged.";
const sideReply = (question: string, text: string) => `BTW\nQuestion: ${question}\n\n${text}`;

const threadId = "111.000";
const questionPayload = (question: string, text = answer): ReplyPayload => ({
  text,
  btw: { question },
});

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops payloads without visible content", () => {
    expect(resolve([{ text: " \t\n " }, { text: "", mediaUrls: [" "] }])).toEqual([]);
  });

  it("keeps rich content when text is blank", () => {
    expect(resolve([{ text: " ", mediaUrl: "file:///tmp/reply.png" }])).toMatchObject([
      { mediaUrl: "file:///tmp/reply.png" },
    ]);
  });

  it("drops a durable reasoning payload when reasoningPayloadsEnabled is not set", () => {
    expect(
      resolve([{ text: "internal reasoning", isReasoning: true }, { text: "final answer" }]),
    ).toEqual([{ text: "final answer" }]);
  });

  it("drops commentary unless its delivery lane is enabled", () => {
    const payload = { text: "internal commentary", isCommentary: true };
    expect(resolve([payload])).toEqual([]);
    expect(resolve([payload], { commentaryPayloadsEnabled: true })).toMatchObject([payload]);
  });

  it("drops heartbeat ack payloads without media", () => {
    expect(resolve([{ text: "HEARTBEAT_OK" }])).toStrictEqual([]);
  });

  it("preserves transcript ownership when stripping heartbeat text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "HEARTBEAT_OK still working" },
      { assistantTranscriptOwned: true },
    );

    const [resolved] = resolve([payload]);

    expect(getReplyPayloadMetadata(resolved ?? {})).toEqual({
      assistantTranscriptOwned: true,
      replyDelivery: { replyToMode: "all" },
    });
  });

  it.each([
    [{ text: answer }, answer, "222.000", false],
    [questionPayload("new"), answer, threadId, false],
    [questionPayload("product", "323"), sideReply("product", "323"), threadId, true],
    [questionPayload("second"), sideReply("first", answer), threadId, false],
  ] as const)(
    "dedupes only the same question and route: %j",
    (payload, sentText, originThread, duplicate) => {
      const delivered = vi.fn();
      expect(
        resolve([payload], {
          messageProvider: "slack",
          originatingTo: "channel:C1",
          originatingThreadId: originThread,
          sentTexts: [sentText],
          sentTargets: [
            { tool: "slack", provider: "slack", to: "channel:C1", threadId, text: sentText },
          ],
          onDeliveredTerminalDuplicate: delivered,
        }),
      ).toEqual(duplicate ? [] : [payload]);
      expect(delivered).toHaveBeenCalledTimes(duplicate ? 1 : 0);
    },
  );

  it.each([
    {
      label: "new question with an already-sent answer",
      text: "The answer remains unchanged.",
      question: "What about the new case?",
      sentText: "The answer remains unchanged.",
      duplicate: false,
    },
    {
      label: "already-rendered short answer",
      text: "323",
      question: "What is 17 * 19?",
      sentText: `BTW
Question: What is 17 * 19?

323`,
      duplicate: true,
    },
    {
      label: "different questions sharing the same long answer",
      text: "The answer remains unchanged.",
      question: "What about the second case?",
      sentText: `BTW
Question: What about the first case?

The answer remains unchanged.`,
      duplicate: false,
    },
  ])(
    "dedupes the visible side-question reply: $label",
    ({ text, question, sentText, duplicate }) => {
      const payload = { text, btw: { question } };
      const delivered = vi.fn();
      expect(
        resolveFollowupDeliveryPayloads({
          cfg: baseConfig,
          payloads: [payload],
          messageProvider: "slack",
          originatingTo: "channel:C1",
          originatingThreadId: "111.000",
          sentTargets: [
            {
              tool: "slack",
              provider: "slack",
              to: "channel:C1",
              threadId: "111.000",
              text: sentText,
            },
          ],
          onDeliveredTerminalDuplicate: delivered,
        }),
      ).toEqual(duplicate ? [] : [payload]);
      expect(delivered).toHaveBeenCalledTimes(duplicate ? 1 : 0);
    },
  );

  it("delivers distinct replies when originating channel resolves the provider", () => {
    expect(
      resolve([{ text: "hello world!" }], {
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});
