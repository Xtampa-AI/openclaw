# Kairos-Wake Governance Bridge

This OpenClaw plugin emits bounded, HMAC-signed lifecycle events to Kairos-Wake. Wake stores the events, deduplicates them, links them to an `oc_session_key`, and adds tool/model/subagent spans to the Wake trace.

The plugin is loaded by OpenClaw but both the delegation tools and lifecycle
events are disabled by default. Enable each surface explicitly only after
configuring a private route to Wake and a shared secret in the OpenClaw secret
manager:

```json
{
  "plugins": {
    "entries": {
      "kairos-wake-bridge": {
        "enabled": true,
        "config": {
          "enabled": true,
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

Delegation additionally requires a Wake-issued OpenClaw service token. Keep
the clear value outside `openclaw.json`: inject it as the
`KAIROS_WAKE_BRIDGE_TOKEN` environment variable, or provide `authToken` via
OpenClaw's SecretRef mechanism. Wake stores only a hash, limits the token to
the bridge operations, and returns the clear value only when an administrator
creates it. Use one credential per gateway so a single revocation does not
disable the other agents.

When `config.enabled` is true, the plugin also registers two governed tools:

- `kw_wake_attachment` uploads a local workspace/agent `/tmp` file to the exact
  Wake proxy session or downloads an authorized attachment to an allowed local
  path.
- `kw_wake_artifact` lists or registers artifacts for the exact Wake room and
  proxy session.

Both tools call service-token-only Wake routes and keep the credential inside
the bridge. The token is never placed in a prompt, shell command, tool result,
or artifact metadata. The legacy `/api/proxy/*` attachment routes remain only
for compatibility and rollback.

The plugin's event surface is observability-only: it does not alter prompts, tools, model routing, or session execution. It emits twelve lifecycle hooks using the envelope `kairos-wake.openclaw.v1`, signs `<unix-seconds>.<raw-body>` with HMAC-SHA256, and sends the signature in `X-Kairos-Wake-Signature` together with `X-Kairos-Wake-Timestamp`.

Payloads exclude prompts/transcripts/system messages and are bounded before transport. Delivery is best-effort and at-least-once; Wake deduplicates by `eventId` and remains authoritative for events it has accepted. The configured `agentId` is the stable governance alias (`kai`, `cangrejo`, or `hermes`); OpenClaw's internal context identity is only the fallback.

Subagent lifecycle events use the hook's `requesterSessionKey` as the parent
`sessionKey`. The child identity is taken from `childSessionKey` on spawn and
`targetSessionKey` on completion, so Wake can attach both events to the same
parent trace even though the completion hook uses a different field name.

The event transport is deliberately isolated from the agent loop: it sends a
payload-free `openclaw.bridge_ready` probe at gateway startup and keeps at
most four HTTP deliveries in flight and 256 queued events per gateway. After
five consecutive delivery failures it opens a 30-second circuit and drops
queued lifecycle events until Wake is reachable again. The startup probe has
no session key and never creates a Wake shadow; it retries at most twice (after
1 and 5 seconds) with the same idempotent event before giving up. It only
confirms transport reachability. These limits prevent a
slow or unavailable Wake daemon from becoming an OpenClaw resource leak.

For a proxy session to appear in Wake's trace, the OpenClaw gateway must receive the durable key through the official `x-openclaw-session-key` request header. A JSON `session_key` field is not a valid substitute and is ignored by the OpenAI-compatible gateway. Wake deliberately keeps older events without an exact session-key match unlinked.

Wake-side session stopping is exposed separately through its governed `/api/openclaw/sessions/:sessionId/abort` endpoint and `openclaw_abort_session` tool; this plugin does not invoke control methods. Session option changes and compaction are Wake approval-gated operations and never edit `openclaw.json`.

Operational checklist:

1. Configure `eventsEnabled: true`, a private `daemonUrl`, and the correct alias.
2. Inject the same secret as Wake's `OPENCLAW_EVENT_SECRET`; do not commit it.
3. For delegation, inject the corresponding `KAIROS_WAKE_BRIDGE_TOKEN`; do not commit it or print it in diagnostics.
4. If attachments/artifacts are enabled, issue a token with `sessions:upload` only for the required proxy waker and validate the scoped canary.
5. Verify a new proxy turn produces a matching `sessionKey`, accepted events, and a linked trace in Wake.
6. If the event endpoint is unavailable, OpenClaw continues operating and Wake does not infer activity from the missing delivery; the gap remains visible as incomplete observability.

The Docker healthcheck uses an eight-minute startup window by default because
the OpenClaw entrypoint runs Doctor, schema migrations, and plugin recovery
before the gateway binds its port. Override it with
`OPENCLAW_HEALTH_START_PERIOD` when a persistent state needs more or less time.
