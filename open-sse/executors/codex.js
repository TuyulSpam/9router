import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/formats/responsesApi.js";
import { fetchImageAsBase64 } from "../translator/concerns/image.js";
import { resolveOpenAiEffort } from "../translator/concerns/thinkingUnified.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { DEFAULT_RETRY_CONFIG, HTTP_STATUS, STREAM_FIRST_CHUNK_TIMEOUT_MS, resolveRetryEntry } from "../config/runtimeConfig.js";
import { dbg } from "../utils/debugLog.js";
import { resolveSessionId } from "../utils/sessionManager.js";

// SSE error patterns inside 200-OK bodies. Some retry same account first; capacity rotates accounts.
const CODEX_SSE_RETRY_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS = ["selected model is at capacity", "model_at_capacity"];
const CODEX_SSE_USER_OUTPUT_PATTERNS = [
  "event: response.output_text.delta",
  "event: response.function_call_arguments.delta",
  "event: response.custom_tool_call_input.delta",
  "event: response.reasoning_summary_text.delta",
  '"type":"response.output_text.delta"',
  '"type":"response.function_call_arguments.delta"',
  '"type":"response.custom_tool_call_input.delta"',
  '"type":"response.reasoning_summary_text.delta"',
];
// Terminal SSE events mean the upstream stream finished intentionally. Metadata
// prefixes without one of these (or user output) are incomplete and retryable.
const CODEX_SSE_TERMINAL_PATTERNS = [
  "event: response.completed",
  "event: response.done",
  "event: response.failed",
  "event: error",
  '"type":"response.completed"',
  '"type":"response.done"',
  '"type":"response.failed"',
  '"type":"error"',
];
const CODEX_PRE_USER_OUTPUT_TRANSPORT_MESSAGE = "upstream body terminated before first user output";
const CODEX_SSE_PEEK_BYTES = 256 * 1024;
const CODEX_MODEL_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

// Body transport failures that happen before any user-visible SSE output are
// still recoverable while we are peeking. After output_text / tool deltas are
// seen we fail-fast to avoid duplicating client-visible tokens.
function isPreFirstByteTransportError(error) {
  if (!error) return false;
  if (
    error.code === "STREAM_FIRST_CHUNK_TIMEOUT"
    || error.code === "EMPTY_SSE_BODY"
    || error.code === "INCOMPLETE_SSE_BODY"
  ) return true;
  if (error.name === "TimeoutError" && /first[- ]byte|first[- ]chunk/i.test(String(error.message || ""))) return true;
  const msg = String(error.message || "").toLowerCase();
  const code = String(error.code || error.cause?.code || "");
  if (error.name === "TypeError" && msg.includes("terminated")) return true;
  if (code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT") return true;
  if (msg.includes("other side closed") || msg.includes("socket hang up") || msg.includes("econnreset") || msg.includes("epipe")) return true;
  return false;
}

function makeFirstChunkTimeoutError(timeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS) {
  const err = new Error(`stream first-byte timeout after ${timeoutMs}ms`);
  err.code = "STREAM_FIRST_CHUNK_TIMEOUT";
  err.name = "TimeoutError";
  return err;
}

// Stable transport codes only for logs/debug. Never echo raw undici messages —
// intermediate proxies have been observed to embed host/credential fragments.
function stableTransportCode(error, fallback = "terminated") {
  return error?.code || error?.cause?.code || error?.name || error?.cause?.name || fallback;
}

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search"
]);

// Responses-native freeform tools carry a name plus format payload and must pass through intact.
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
  "text"
]);

// Apply Codex transport-level effort aliases after model-aware semantic resolution.
// Official openai/codex serializes semantic Ultra as Max for requests; other efforts identity-map.
function resolveCodexWireEffort(effort, config) {
  const aliases = config?.quirks?.reasoningEffortAliases;
  if (!aliases || effort == null) return effort;
  return aliases[effort] ?? effort;
}

// Convert role=system → role=developer in body.input (keeps content in cacheable prefix)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

// Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false
function stripStoredItemReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) delete item.id;
    }
    return true;
  });
}

// Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools
function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    const parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(name);
    return true;
  });
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Resolve prompt-cache session id: client session → assistant-text-hash → workspaceId → connection
function resolveCacheSessionId(body, credentials) {
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "codex"
  });
}

function findNestedMessage(value, depth = 0) {
  if (!value || depth > 6 || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
  if (typeof value.response?.error?.message === "string" && value.response.error.message.trim()) return value.response.error.message;
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractSseErrorMessage(text, fallback) {
  const exact = text?.match(/Selected model is at capacity\. Please try a different model\./i)?.[0];
  if (exact) return exact;

  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const message = findNestedMessage(JSON.parse(data));
      if (message) return message;
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }

  return fallback || CODEX_MODEL_CAPACITY_MESSAGE;
}

function codexSseErrorResponse(status, message) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error",
    }
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
    this._currentSessionId = null;
  }

  /**
   * Override headers to add codex-specific identity headers.
   * transformRequest runs BEFORE buildHeaders, sets this._currentSessionId.
   */
  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    headers["session_id"] = this._currentSessionId || credentials?.connectionId || "default";
    // Identify client type to Codex backend (matches official codex CLI)
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";
    // Account/workspace binding header — required when multiple Codex accounts
    // are configured. OAuth import stores ChatGPT account ID as chatgptAccountId;
    // older/custom rows may use workspaceId/accountId. Prefer explicit workspaceId
    // but fall back to chatgptAccountId so requests don't cross-bind to the wrong
    // OpenAI account and surface as token_invalid after adding another account.
    const accountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (typeof accountId === "string" && accountId && !headers["ChatGPT-Account-ID"]) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return this._isCompact ? `${base}/compact` : base;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  async execute(args) {
    const imgCount = Array.isArray(args.body?.input) ? args.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0) : 0;
    const inputLen = Array.isArray(args.body?.input) ? args.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${this._currentSessionId || "pending"}`);
    if (imgCount > 0) {
      const t0 = Date.now();
      await this.prefetchImages(args.body);
      dbg("CODEX", `prefetchImages done | ${Date.now() - t0}ms`);
    } else {
      await this.prefetchImages(args.body);
    }

    // Retry loop for:
    // 1) SSE-level overloaded errors (200 OK body contains event: error) → 503 config
    // 2) pre-user-output body transport death/empty body during peek → 502 config
    // Once user-visible output is observed we do not auto-retry.
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const overloadRetry = resolveRetryEntry(retryConfig[503]);
    const transportRetry = resolveRetryEntry(retryConfig[502]);
    let overloadAttempt = 0;
    let transportAttempt = 0;
    while (true) {
      const result = await super.execute(args);
      const peek = await this._peekSseTransientError(result.response);
      if (!peek.matched) {
        // Replace body with re-assembled stream (prefix bytes already read + rest)
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      if (peek.accountFallback) {
        args.log?.warn?.("RETRY", `CODEX | SSE account fallback "${peek.message}"`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || CODEX_MODEL_CAPACITY_MESSAGE);
        return result;
      }

      // Pre-user-output transport death/empty body: recoverable only before user output.
      if (peek.transportError) {
        const { attempts, delayMs } = transportRetry;
        if (transportAttempt >= attempts) {
          // Log only a stable transport code/name — never raw undici messages that may
          // embed host/credential fragments from intermediate proxy layers.
          const code = peek.matched || stableTransportCode(peek.transportError);
          args.log?.warn?.("RETRY", `CODEX | pre-user-output transport code=${code} — retries exhausted (${transportAttempt}/${attempts})`);
          // Keep client-facing body generic; detailed transport cause stays in logs/DB via observability path.
          result.response = codexSseErrorResponse(HTTP_STATUS.BAD_GATEWAY, CODEX_PRE_USER_OUTPUT_TRANSPORT_MESSAGE);
          return result;
        }
        transportAttempt++;
        const code = peek.matched || stableTransportCode(peek.transportError);
        args.log?.debug?.("RETRY", `CODEX | pre-user-output transport code=${code} retry ${transportAttempt}/${attempts} after ${delayMs / 1000}s`);
        dbg("CODEX", `pre-user-output transport code=${code} → retry ${transportAttempt}/${attempts} in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      const { attempts, delayMs } = overloadRetry;
      if (overloadAttempt >= attempts) {
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${overloadAttempt}/${attempts})`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
        return result;
      }
      overloadAttempt++;
      args.log?.debug?.("RETRY", `CODEX | SSE "${peek.matched}" retry ${overloadAttempt}/${attempts} after ${delayMs / 1000}s`);
      dbg("CODEX", `SSE overloaded "${peek.matched}" → retry ${overloadAttempt}/${attempts} in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Peek first N bytes of SSE body to detect upstream transient errors / pre-user-output
  // transport death. Returns {
  //   matched, message, accountFallback, transportError, replacementBody
  // }. Caller must use replacementBody when no error matched (original body has been read).
  async _peekSseTransientError(response) {
    if (!response || !response.ok || !response.body) {
      return { matched: null, message: null, accountFallback: false, transportError: null, replacementBody: null };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let matched = null;
    let accountFallback = false;
    let transportError = null;
    let firstChunkTimer = null;
    let sawFirstChunk = false;
    let sawUserOutput = false;
    // First-output deadline covers the whole pre-user-output phase, including
    // metadata-only prefixes. Stopping the timer on the first byte would leave
    // hung "response.created then silence" streams unrecoverable.
    const firstOutputDeadlineAt = STREAM_FIRST_CHUNK_TIMEOUT_MS > 0
      ? Date.now() + STREAM_FIRST_CHUNK_TIMEOUT_MS
      : null;
    const clearFirstChunkTimer = () => {
      if (firstChunkTimer) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = null;
      }
    };
    try {
      while (text.length < CODEX_SSE_PEEK_BYTES) {
        // First-output watchdog must live in peek: this path drains body bytes
        // before pipeWithDisconnect can arm its own timer.
        let value;
        let done = false;
        const remainingMs = firstOutputDeadlineAt == null
          ? null
          : firstOutputDeadlineAt - Date.now();
        if (remainingMs != null && remainingMs <= 0) {
          throw makeFirstChunkTimeoutError(STREAM_FIRST_CHUNK_TIMEOUT_MS);
        }
        if (remainingMs != null) {
          let timedOut = false;
          // Settle late reader.read() after cancel so Promise.race cannot leave
          // an unhandled rejection behind the timeout winner.
          const readPromise = reader.read().then(
            (result) => ({ ok: true, result }),
            (error) => ({ ok: false, error }),
          );
          const timeoutPromise = new Promise((resolve) => {
            firstChunkTimer = setTimeout(() => {
              timedOut = true;
              resolve({ ok: false, error: makeFirstChunkTimeoutError(STREAM_FIRST_CHUNK_TIMEOUT_MS) });
            }, remainingMs);
          });
          try {
            const raced = await Promise.race([readPromise, timeoutPromise]);
            if (!raced.ok) {
              if (timedOut || raced.error?.code === "STREAM_FIRST_CHUNK_TIMEOUT") {
                try { await reader.cancel(raced.error); } catch { /* noop */ }
                await readPromise;
              }
              throw raced.error;
            }
            ({ done, value } = raced.result);
          } finally {
            clearFirstChunkTimer();
          }
        } else {
          ({ done, value } = await reader.read());
        }
        if (done) break;
        if (!sawFirstChunk) {
          sawFirstChunk = true;
        }
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        const lowerText = text.toLowerCase();
        const accountHit = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.find(p => lowerText.includes(p));
        if (accountHit) { matched = accountHit; accountFallback = true; break; }
        const retryHit = CODEX_SSE_RETRY_PATTERNS.find(p => lowerText.includes(p));
        if (retryHit) { matched = retryHit; break; }
        if (CODEX_SSE_TERMINAL_PATTERNS.some(p => lowerText.includes(p))) {
          break;
        }
        if (CODEX_SSE_USER_OUTPUT_PATTERNS.some(p => lowerText.includes(p))) {
          sawUserOutput = true;
          break;
        }
      }

      // Incomplete 200-SSE bodies (empty, or metadata-only without a terminal event)
      // are not successful streams. Treat them as pre-user-output transport failures
      // so the outer loop can retry via 502. Terminal-only streams still release.
      if (!matched && !sawUserOutput) {
        const lowerText = text.toLowerCase();
        const sawTerminal = CODEX_SSE_TERMINAL_PATTERNS.some((p) => lowerText.includes(p));
        if (!sawTerminal) {
          const incomplete = chunks.length === 0 && text.trim() === "";
          const emptyErr = new Error(
            incomplete
              ? "upstream returned empty SSE body before first byte"
              : "upstream closed SSE body before terminal event or user output"
          );
          emptyErr.code = incomplete ? "EMPTY_SSE_BODY" : "INCOMPLETE_SSE_BODY";
          emptyErr.name = "TypeError";
          matched = emptyErr.code;
          transportError = emptyErr;
        }
      }
    } catch (e) {
      clearFirstChunkTimer();
      dbg("CODEX", `peek read error: code=${stableTransportCode(e)}`);
      // Recoverable while no user-visible output has been observed yet.
      // Metadata-only prefixes are still safe to discard and retry.
      if (!sawUserOutput && isPreFirstByteTransportError(e)) {
        matched = e.code || e.name || "terminated";
        transportError = e;
      }
    } finally {
      clearFirstChunkTimer();
    }

    if (matched) {
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      return {
        matched,
        message: transportError
          ? (transportError.message || matched)
          : extractSseErrorMessage(text, matched),
        accountFallback,
        transportError,
        replacementBody: null,
      };
    }

    reader.releaseLock();

    // Re-assemble stream: prefix chunks + remaining upstream body
    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) {
        try { upstreamReader?.cancel(reason); } catch { /* noop */ }
      },
    });
    return { matched: null, message: null, accountFallback: false, transportError: null, replacementBody };
  }

  // Parse Codex usage_limit_reached to extract precise resetsAtMs; fallback to default otherwise
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return { status: 429, message: err.message || bodyText, resetsAtMs };
          }
        }
      } catch { /* fall through to default */ }
    }
    return super.parseError(response, bodyText);
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    this._isCompact = !!body._compact;
    delete body._compact;
    // Resolve conversation-stable session_id (priority: body → assistant-text → workspace → machine)
    this._currentSessionId = resolveCacheSessionId(body, credentials);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }

    // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
    convertSystemToDeveloperRole(body);
    // Strip server-generated item IDs (rs_/fc_/resp_/msg_) — Codex /responses can't resolve when store=false
    stripStoredItemReferences(body);
    // Flatten function tools + drop unsupported types
    normalizeCodexTools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!body.instructions || body.instructions.trim() === "") {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Inject prompt_cache_key for stable Codex prompt caching
    if (!body.prompt_cache_key && this._currentSessionId) {
      body.prompt_cache_key = this._currentSessionId;
    }

    // Map virtual Codex review models to the upstream Codex model before suffix parsing.
    body.model = getModelUpstreamId("cx", body.model || model);

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → low (default)
    const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    let modelEffort = null;
    for (const level of effortLevels) {
      if (body.model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, '');
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (low)
    // resolveOpenAiEffort keeps model-aware semantic support; resolveCodexWireEffort maps Ultra→Max for wire.
    if (!body.reasoning) {
      const semantic = resolveOpenAiEffort(body.reasoning_effort || modelEffort || 'low', "codex", body.model);
      const effort = resolveCodexWireEffort(semantic, this.config);
      body.reasoning = { effort, summary: "auto" };
    } else {
      const semantic = resolveOpenAiEffort(body.reasoning.effort, "codex", body.model);
      body.reasoning.effort = resolveCodexWireEffort(semantic, this.config);
      if (!body.reasoning.summary) body.reasoning.summary = "auto";
    }
    delete body.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens; // Responses API clients send this but Codex rejects it
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // store=false → backend can't resolve previous resp; avoid 404

    if (body.service_tier === "fast") body.service_tier = "priority";
    if (body.service_tier && body.service_tier !== "priority") delete body.service_tier;

    // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }
}
