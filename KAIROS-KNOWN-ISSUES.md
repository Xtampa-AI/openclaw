# KAIROS — Bugs upstream conocidos (fork Xtampa-AI/openclaw)

Registro de bugs observados en producción (OpenClaw 2026.11.3, imagen `openclaw:local`) que proceden del upstream o de la interacción tool/schema. Cada entrada incluye evidencia, impacto y estado.

---

## BUG-001 — `openclaw:core:automations` devuelve payload que no valida contra su `outputSchema` (EN INVESTIGACIÓN)

**Severidad**: baja-media (4 eventos en una semana; ruido en logs + turno degradado cuando el agente consulta automatizaciones).
**Estado**: 15-nov-2026 — contrato **verificado correcto**; fallo real pero causa raíz NO aislada aún. NO aplicar fix de schema (ver abajo).
**Reproducible**: NO de forma determinista — depende del path de dispatch dentro del agent run.

### Síntoma en logs

```
[d tools] dispatch_action failed: Tool "openclaw:core:automations" returned details that
  do not match its declared outputSchema. ... Validation: jobs: must have required
  property 'jobs'; total: must have required property 'total'; offset: must have
  required property 'offset'; limit: must have required property 'limit';
  hasMore: must have required property 'hasMore'; 11 additional validation issues omitted.
  raw_params={"args":{"action":"list"},"id":"openclaw:core:automations"}
```

Segunda variante (`action:"status"`): `enabled: must have required property 'enabled';
<root>: must not have additional properties: "gated"`.

Ocurre en kai (12-nov, Slack C0ADHFT3NFN) y hermes (13-nov, Slack C0BLH0TK85C vía
Code Mode bridge → `assertCatalogOutputMatchesSchema` en `tool-search-*.mjs`).

### Lo que YA está descartado (verificado 15-nov)

- **El contrato tool↔gateway es correcto.** Reproducción real dentro del contenedor
  (`callGateway` WS → `cron.list`/`cron.status` con datos vivos + `createCronTool`
  del dist desplegado + `Value.Errors(tool.outputSchema, details)`):
  `action:list`, `action:list+includeDisabled`, `action:status` → **0 errores**.
  `details` resultante = `{jobs, snapshotRevision, total, offset, limit, hasMore,
nextOffset, scope, scopeHint}` — exactamente lo que `CronListOutputSchema` declara
  (`scope`/`scopeHint` YA son `Type.Optional` en `cron-tool-output-schema.ts`).
- **`gated` no lo produce ningún método `cron.*` ni el wrapper before-tool-call**
  (búsqueda exhaustiva en src + packages; solo aparecen falsos positivos de
  "dele**gated**"). Origen desconocido → sospechoso de rewrite por hook/plugin o
  proyección code-mode.
- **No es un problema de versión**: dist desplegado == src del árbol actual para
  `cron-tool*.mjs` y `cron-tool-output-schema` (último cambio upstream 22-oct,
  imagen construida 11-nov).

### Hipótesis vivas (ordenadas)

1. **Dispatch in-process divergente**: dentro del gateway, `callGatewayTool` usa
   `callAgentToolGatewayRequest` → `dispatchGatewayMethodInProcess` →
   `unwrapGatewayMethodDispatchResponse` → `response.payload`. Si algún wrapper
   (`createCronMutationCompletion`, prepared-read `respond`, `meta`) altera el
   payload para callers sintéticos con scope, `details` llega deformado. No
   reproducido aún — requiere instrumentación o un caller con identidad real.
2. **Rewrite por hook/plugin**: `wrapToolWithBeforeToolCallHook` permite que
   hooks reescriban results ("Hook rewrites must also satisfy the result type").
   Un hook kairos/plugin podría sustituir `details` por un payload mínimo
   `{gated: ...}` cuando decide bloquear/anonimizar. Coincidiría con la rareza
   (solo cuando el contenido dispara la política).
3. **Proyección code-mode/bridge**: el fallo de hermes fue dentro de code-mode;
   el de kai fue `dispatch_action` directo. Si ambos comparten un punto de
   proyección que muta `details` antes de `assertCatalogOutputMatchesSchema`,
   es la causa común.

### Siguiente paso recomendado (upstream)

Mejorar `formatCatalogOutputError`/`assertCatalogOutputMatchesSchema`
(`src/agents/tool-search-runtime.ts`) para incluir en el mensaje un resumen del
payload real (`Object.keys(details)` + tipo de `jobs`/`enabled`) — hoy el error
lista constraints del schema pero NO enseña qué llegó, lo que hace el bug
indiagnosticable desde logs. Con ese dato la causa raíz se aisla en una
reproducción.

### Impacto

Bajo: el tool ejecuta y devuelve datos al modelo; la validación es post-hoc.
Coste: turno degradado + reintentos improductivos del modelo cuando consulta
automatizaciones (los agentes tienen instrucción de verificarlas).

---

## BUG-002/003/005 — "Unknown tool id" masivo: CONFIRMADO error de input (docs), RESUELTO vía documentación (15-nov-2026)

**Volumen**: 82 eventos "Unknown tool id" desde sep-2026 (kai 56 · cangrejo 12 · hermes 14).
**Causa raíz (verificada)**: los agentes invocaban tools AACT/kairos-wake como si fueran tools nativas del catálogo OpenClaw, con ids que no existen:

- `tool_call`/`dispatch_action` con `id="kai_recall"`, `"kai_think"`, `"kai_insight"`, `"kairos-evo.kai_recall"`, `"aact_execute_tool"`, `"aact_discover_tools"`, `"kairos-evo_memory.memory_get"`, `"tool_search"` (meta-tool invocado vía el dispatcher — recursión imposible).
  -Ids correctos que SÍ existen como nativos (plugin `kairos-bridge`, registrado pero **filtrado del catálogo por `tools.profile="coding"`** — allow list solo-core): `kairos_recall`, `kairos_think`, `kairos_insight`, `kairos_experience`, `aact_discover`, `aact_recommend`, `aact_execute`, `mcp_discover`, `mcp_execute`, `kairos_session_status`. Probe en vivo (15-nov): el agente confirma que NO los ve.
- **Path que SÍ funciona y usan los agentes**: `exec` + `curl http://aact-server:9999/api/execute` (toolId `app.tool` + `X-API-Key: $AACT_API_KEY`) y `GET /api/apps[/<app>/tools]` para discovery. Verificado end-to-end.

**Por qué pasaba**: AGENTS.md/TOOLS.md/skills enseñaban la sintaxis del lado MCP (`aact_execute_tool`, `aact_discover_tools`, `aact_get_tool_docs`) — nombres de meta-tools de AACT para clientes MCP (Cursor etc.), inexistentes como tools OpenClaw. El modelo copiaba esos nombres a `tool_call`/`dispatch_action` → error → reintento (los errores se auto-corrigen: el propio mensaje "Did you mean" guía, pero cuesta tokens y turnos).

**Fix aplicado (15-nov)**: reescritas las secciones "Herramientas (AACT unificado)" / ritual de memoria / punteros en los 3 `AGENTS.md` + `TOOLS.md` de kai — ahora enseñan el patrón `exec`+curl real y añaden la regla "las tools AACT NO son nativas; nunca `tool_call`/`dispatch_action`/`aact_execute_tool`". Backups `AGENTS.md.bak-20261115-rediet` ya cubren el estado previo.

**Barrido completado (15-nov, tarde)**: 22 invocaciones `aact_execute_tool(...)` transformadas a curl real en 9 SKILL.md de workspaces (kai 2, cangrejo 5, hermes 2) + 3 docs agent-facing de `compartida/` (xtampa-product-images, IMPORTACION.md roly, incident-response) + nota aclaratoria en GUIA-INTEGRACION-NUEVA-API.md + 2 líneas stale en `MEMORY.md` de cangrejo (se inyecta en sesiones main). Quedan solo referencias en `.bak`, memorias históricas (`memory/`, `.dreams/`, `dreaming/`) y docs conceptuales de arquitectura MCP — correcto dejarlas (son registro histórico o contexto MCP-client donde el nombre sí aplica).

**Pendiente conocido (no bug)**: los tools nativos del bridge (`kairos_*`, `aact_*`) quedan disponibles pero filtrados por profile — si se quieren activar algún día: `tools.alsoAllow` con `group:plugins` o ids de plugin (verificar antes que `aact_execute`/`kairos_*` funcionan contra el gateway vivo; `mcp_*` dependen del MCP Gateway legacy posiblemente retirado).

- **BUG-003** (`Unknown tool id: tool_search` en cangrejo, 12 eventos): MISMA clase — el modelo invoca meta-tools (`tool_search`, `tool_call`, `dispatch_action`) a través del dispatcher. `tool_search` existe pero solo como tool directa, no como id despachable. Mitigado por la misma corrección de docs.
- **BUG-004 RESUELTO 16-nov — era configuración, no código**: investigación profunda reveló que el modelo **SÍ emitía `NO_REPLY`** (transcript: `content:[{text:"NO_REPLY"}]` en ambos intentos) — el problema era que `silentReplyPolicy` estaba **unset → default `disallow`** → mensajes de grupo/canal no mencionados recibían `replyExpectation="required"` → NO_REPLY/empty computaba `incompleteTurnText` = error visible. **Fix aplicado (config, hot-reload, los 3 agentes)**: `agents.defaults.silentReply.group="allow"` vía `config patch --stdin`. Con policy allow: (a) mensajes de grupo/canal sin mención explícita (o `implicit_thread`) → expectation `optional` → empty finalization produce `incompleteTurnText=null` → silencio; (b) `allowEmptyStopContinuation=false` → el skip de retry para `silent && nonVisibleEligibleForSilentReply` funciona → NO_REPLY completa sin retry ni error; (c) el group-context prompt (`canUseSilentReply`) ahora sí instruye el token NO_REPLY → mejor compliance. **Sin cambios en**: DMs (`direct`→disallow siempre), menciones explícitas (`WasMentioned=true` no-implicit → `required` → NO_REPLY sigue siendo error — fail-safe correcto cuando te hablan directamente). Rollback: `config patch` con `{"agents":{"defaults":{"silentReply":null}}}` o restaurar backup. **Verificación pendiente**: observar próximos turnos de canal — NO_REPLY/empty en threads debe completar sin `surfacing error to user` ni `delivered reply` de error.
  - **BUG-004b — path residual resuelto (18-nov-2026)**: el fix anterior dejaba un caso vivo: `mention_source:"mention_pattern"` (nombre del agente en el texto, `explicitly_mentioned_bot:false`) cuenta como `WasMentioned=true` → `resolveSourceReplyExpectation` → `required` → NO_REPLY = error visible **incluso con `silentReply.group:"allow"`**. Detonante real: el informe diario de vig-a en `#kairos-informes` (`C0BLLV7V473`, config `*` requireMention:true + allowBots:mentions) contenía `Matrix 15, Kai 10, Cangrejo 9, Hermes 5` → los 3 agentes dispararon turno required, los 3 modelos emitieron `NO_REPLY` (verificado en transcript `content:[{text:"NO_REPLY"}]` ×2 intentos por agente), y los 3 publicaron `⚠️ Agent couldn't generate a response` a las 09:34–09:35. Mismo patrón en `#kairos-oraculo` a las 08:27/08:30 (mensajes de otros bots que nombraban a "Kai"). **Fix aplicado (config, hot-reload, los 3 agentes)**: `channels.slack.mentionPatterns.mode="deny"` — desactiva la detección de mención por patrón de nombre en todo Slack → el informe de vig-a ya no dispara turnos (requireMention:true) y en oráculo `WasMentioned=false` → `optional` → silencio limpio vía silentReply allow. Las menciones explícitas `<@bot>` (`explicit_bot`), `implicit_thread` y `command_bypass` no se tocan. **Gap upstream documentado**: `mention_pattern` (señal débil) no debería elevar `replyExpectation` a `required` igual que un `explicit_bot` — candidato a upstream; no aplicado en fork (mitigado por config). Rollback: `config patch` `{"channels":{"slack":{"mentionPatterns":null}}}` o backups `openclaw.json.bak-20261118-silentfix` en cada contenedor.
  - **BUG-004c — caso residual cerrado por patch de fork (18-nov-2026)**: con `mentionPatterns.mode="deny"` el único path vivo que publicaba `⚠️ Agent couldn't generate a response` tras un NO_REPLY deliberado era **@mención explícita / `command_bypass` / DM** (`replyExpectation:"required"`). Upstream codifica a propósito "Model output cannot waive a required reply" (`src/agents/reply-completion.ts`); el fork diverge deliberadamente porque en este ecosistema el token `NO_REPLY` ES la respuesta deliberada del modelo. **Patch aplicado (fork, 3 puntos coordinados)**: (1) `resolveEmptyResponseRetryInstruction` retorna `null` cuando `classifyAssistantTurn().silent` — no quema una llamada pidiendo respuesta visible; (2) `resolveIncompleteTurnPayloadText` retorna `null` cuando `assistantState.silent && !textToolCallAttempt && stopReason !== "error"` — el run completa con 0 payloads, sin texto de error; (3) `agent-runner-result-payloads.ts` computa `explicitSilentFinal` (`meta.terminalReply.disposition==="silent"`, `meta.terminalReplyKind==="silent-empty"`, `isSilentReplyPayloadText(finalAssistantRawText ?? finalAssistantVisibleText)`, o todos los payloads del run son token silencioso) → `resolveReplyCompletion("optional")` → outcome `silent` en vez de `missing` → sin "did not produce a visible reply". **Intacto**: texto vacío real sin token → retry + error como antes; `stopReason:"error"`, tool calls textuales, media failures, side effects y trabajo async/lifecycle pendiente siguen bloqueando el silencio (guards existentes, test `keeps $owner out of completed silence`). **Regresión**: `incomplete-turn-recovery.test.ts` (2 tests nuevos) + cases actualizados en `agent-runner.runreplyagent.required-reply.cases.ts`. Requiere rebuild de `openclaw:local` + recreación de contenedores. Rollback: revert del commit del patch.
- **BUG-005** (`skill_workshop` ToolInputError): mismo patrón de error de input del modelo; sin evento específico localizado — clasificado como error de input hasta evidencia contraria.

---

## Pendientes de documentar (evidencia ya recopilada)

- **BUG-006 RESUELTO — falso positivo confirmado (15-nov)**: el guard `secret-exfiltration` de `src/skills/security/scanner.ts` es un regex `/\b(process\.env|env)\b.{0,80}\b(fetch|curl|wget|http|https)\b/i` sobre el SKILL.md. La versión rejectada (archive `20261112T161052248Z-write_file`, línea 14) decía _"...their stored credential is not the live env token. Go straight to curl; don't probe the plugin config"_ — match `env token. Go straight to curl`. **Falso positivo claro**: la frase _desaconseja_ tocar credenciales y solo menciona env+curl en la misma línea; no hay instrucción de leer env ni enviarlo a ningún sitio. El contenido actual del skill (reescrito en los 5 patches del 13-nov 09:17) ya no dispara la regla y sigue documentando el mismo acceso con token vía curl. **Conclusión**: el guard funciona como debe (conservador ante skills ejecutables); el coste del falso positivo es reformular una frase. Mejora upstream opcional (NO aplicada): exigir patrón de exfil real (`env|curl`, `printenv`→red, `process.env.X` en body de fetch) en vez de co-ocurrencia — divergencia de fork no justificada por un FP de bajo impacto.
- **BUG-007 (RESUELTO 15-nov)**: `[memory] sync failed (watch)`: embedding provider `openai` usaba una API key stale del auth-profile store (401 en `text-embedding-3-small`) → sync abortaba y caía a keyword/FTS protegiendo el índice vectorial. **Fix aplicado**: `memory.search.remote.apiKey` = SecretRef `{source:"env", id:"OPENAI_API_KEY"}` en los 3 agentes (hot-reload, sin restart; backups `openclaw.json.bak-20261115-memembed`). Verificado end-to-end: chunk nuevo indexado 10:06 UTC con embedding 1536-dim real, 0 errores 401. **Auditoría posterior del auth store (15-nov tarde)**: la "clave stale" **no existe en ningún store** — `auth_profile_store.profiles` vacío en los 3 agentes, `secret_store_entries` solo tiene 3 secretos (ninguno OpenAI), `plugin_state_entries` sin namespaces auth/oauth, `models.providers.openai` sin campo `apiKey`, `auth.profiles` solo declara un perfil OAuth `openai:contacto@xtampa.es` sin tokens almacenados. El 401 original probablemente vino de resolución por profile-discovery (perfil OAuth ≠ API key) o de un env entonces stale; el SecretRef bypassa el discovery por completo. **No hay nada que limpiar** — pendiente cerrado. **Notas**: (a) ~~clave stale~~ → verificado: stores vacíos, nada que rotar; (b) `evo-embed` local (Qwen3-Embedding-0.6B, 1024-dim) NO es drop-in: el índice actual es 1536-dim (`text-embedding-3-small`), cambiar de modelo exigiría reindex completo (`memory_vector_rebuild_v1`); (c) los warnings `SECRETS_REF_IGNORED_INACTIVE_SURFACE` tras el patch son benignos — el agente `eval` tiene `memory.search.enabled=false` y hereda el default.
- **BUG-008 (INVESTIGADO 15-nov → no es bug, es ruido de observabilidad)**: `[prompt-cache] message differs ... history must be append-only` + `cache read dropped`. Diagnóstico: (a) el fingerprint de `prompt-cache-observability.ts` es transport-agnostic — hashea TODOS los campos del envelope (`__openclaw`, `timestamp`, `idempotencyKey`, `usage`, `stopReason`…), pero los transportes (`packages/ai/src/*-messages.ts`) solo serializan `role`+`content`+`toolCallId`/`toolName`/`isError`/`runtimeContext`/`operatorMessage`/`api`/`model`/`provider` → la mayoría de "historyRewrite" son mutaciones de metadata interna que nunca llegan al wire (falso positivo por diseño, testeado en `prompt-cache-observability.history.test.ts`); (b) el tracker agrupa por provider-affinity, no por sesión → comparaciones cross-session/contexto (p.ej. hermes `tools(6 -> 0)` = request de utilidad vs principal) inflan los "drops"; (c) drops en `request=1` tras gaps de horas = expiración TTL del provider, inevitable; (d) busts reales residuales: secciones dinámicas del system prompt (`Skills`, `Runtime Context`, `Conversation Context`) — inherente al diseño, mitigado por `contextPruning: cache-ttl`. Volumen 72h: kai 16, cangrejo 45, hermes 10 eventos — la mayoría ruido. **Mejora upstream posible** (no aplicada, divergencia de fork): tracker key por sesión + fingerprint solo de campos wire. Sin impacto en corrección.

_Regla: antes de documentar como bug upstream, verificar el contrato vivo del tool y separar error de input (modelo) vs error de output schema (tool) vs error de descubrimiento._
