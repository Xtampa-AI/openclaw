# Kairos-Wake Governance Bridge

This OpenClaw plugin emits bounded, HMAC-signed lifecycle events to Kairos-Wake. Wake stores the events, deduplicates them, links them to an `oc_session_key`, and adds tool/model/subagent spans to the Wake trace.

The plugin is disabled by default. Enable it only after configuring a private route to Wake and a shared secret in the OpenClaw secret manager:

```json
{
  "plugins": {
    "entries": {
      "kairos-wake-bridge": {
        "enabled": true,
        "config": {
          "eventsEnabled": true,
          "daemonUrl": "http://kairos-wake-proxy:19900",
          "eventSecret": "<injected-secret>",
          "agentId": "<openclaw-agent-id>",
          "wakerId": "<wake-waker-id>"
        }
      }
    }
  }
}
```

The plugin's event surface is observability-only: it does not alter prompts, tools, model routing, or session execution. It emits twelve lifecycle hooks using the envelope `kairos-wake.openclaw.v1`, signs `<unix-seconds>.<raw-body>` with HMAC-SHA256, and sends the signature in `X-Kairos-Wake-Signature` together with `X-Kairos-Wake-Timestamp`.

Payloads exclude prompts/transcripts/system messages and are bounded before transport. Delivery is best-effort and at-least-once; Wake deduplicates by `eventId` and remains authoritative for events it has accepted. The configured `agentId` is the stable governance alias (`kai`, `cangrejo`, or `hermes`); OpenClaw's internal context identity is only the fallback.

For a proxy session to appear in Wake's trace, the OpenClaw gateway must receive the durable key through the official `x-openclaw-session-key` request header. A JSON `session_key` field is not a valid substitute and is ignored by the OpenAI-compatible gateway. Wake deliberately keeps older events without an exact session-key match unlinked.

Wake-side session stopping is exposed separately through its governed `/api/openclaw/sessions/:sessionId/abort` endpoint and `openclaw_abort_session` tool; this plugin does not invoke control methods. Session option changes and compaction are Wake approval-gated operations and never edit `openclaw.json`.

Operational checklist:

1. Configure `eventsEnabled: true`, a private `daemonUrl`, and the correct alias.
2. Inject the same secret as Wake's `OPENCLAW_EVENT_SECRET`; do not commit it.
3. Verify a new proxy turn produces a matching `sessionKey`, accepted events, and a linked trace in Wake.
4. If the event endpoint is unavailable, OpenClaw continues operating and Wake does not infer activity from the missing delivery; the gap remains visible as incomplete observability.
