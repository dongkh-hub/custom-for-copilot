/**
 * Endpoint SSE streaming, usage reporting and error mapping.
 *
 * Parses the endpoint's SSE stream and forwards every chunk to VS Code, wraps
 * usage numbers into the terminal data part Copilot Chat consumes, and maps
 * non-2xx responses / cancellation onto `LanguageModelError`.
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { reportThinking } from './thinking';
import { extractTextToolCalls, mayBeToolCallMarkup, MARKUP_BUFFER_LIMIT } from './toolCallText';

/**
 * Parse the gateway's SSE stream and forward every chunk to VS Code.
 *
 * SSE framing: `data: {json}` lines separated by `\n\n`; `data: [DONE]`
 * terminates. Deltas arrive as `choices[0].delta` with either `content`
 * (text) or `tool_calls` (incremental function-call fragments that must be
 * accumulated across chunks before they can be emitted — arguments stream
 * in pieces). The terminal usage-only chunk (`choices: []` + `usage`) is
 * captured instead of forwarded; the caller turns it into the `usage` data
 * part Copilot Chat's context-usage widget consumes.
 *
 * `onFirstChunk` fires exactly once, when the first body bytes arrive.
 */

/**
 * A tool call whose id is in the MODEL's own notation — `functions.edit:12` —
 * rather than one the gateway generated (`call_7edbe346b1164b09bd2ff1cc`).
 *
 * MEASURED (2026-11-05, Agents window, kimi-k2.6 behind a relay): the two id
 * shapes do not carry the same arguments. Structured calls arrived with all
 * 3-4 fields; every native-id call arrived with exactly ONE field — the first
 * — which is how `edit` failed 21 of 22 times with `old_str is required` and
 * the agent then repeated the identical call 20 times. Same model, same key:
 * which shape a turn gets is decided upstream, per turn.
 */
const NATIVE_TOOL_CALL_ID = /^functions\.[\w.-]+:\d+$/;

export async function streamSseToProgress(
  body: ReadableStream<Uint8Array>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  onFirstChunk?: () => void,
  /**
   * Required arguments per tool, straight from `LanguageModelChatTool
   * .inputSchema.required`. A call missing one of them cannot succeed, so it is
   * dropped rather than dispatched — see the `incomplete` branch in flushToolCall.
   */
  requiredByTool?: ReadonlyMap<string, readonly string[]>
): Promise<{
  usage?: GatewayUsage;
  completionChars: number;
  thinkingChars: number;
  thinkingReported: boolean;
  /** Full reasoning text of this turn — replayed on the next one (replay.ts). */
  reasoning: string;
  /**
   * Health of the tool-call channel for this turn. `textParsed` counts the calls
   * that did NOT arrive through the structured `tool_calls` field: either the
   * gateway recovered them from the model's raw TEXT (native id, arguments
   * usually cut to their first key) or the arguments were not valid JSON at all.
   * Neither can be repaired here — the missing fields are simply absent — but
   * one logged line per request is what separates "the model keeps botching
   * edits" from "this gateway is not parsing tool calls".
   */
  toolCalls: {
    total: number;
    textParsed: number;
    /** Calls rescued from markup that arrived as text (toolCallText.ts). */
    recovered: number;
    /** Calls dropped because the gateway cut their arguments (name + missing fields). */
    incomplete: { name: string; missing: string[] }[];
    samples: string[];
  };
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Gateway-reported usage (final SSE chunk) and streamed completion
  // characters for the length/4 fallback estimate.
  let usage: GatewayUsage | undefined;
  let completionChars = 0;
  // Reasoning text, counted whether or not it can be shown — the count is how
  // we learn that this gateway reasons at all. The TEXT is kept as well: it is
  // replayed to the gateway on the next turn (see replay.ts).
  let thinkingChars = 0;
  let thinkingReported = false;
  let reasoningSoFar = '';
  // Identity of the reasoning run being streamed right now. The chat model
  // groups thinking deltas into one "Thought for Ns" block per part id, so the
  // id must span a whole contiguous burst and must be dropped as soon as text
  // or a tool call ends that burst — a fresh id per delta renders one block per
  // delta instead of one block per burst.
  let thinkingRunId: string | undefined;
  // Accumulating tool calls: chunks arrive as indexed fragments
  // ({index, id?, function: {name?, arguments-fragment}}).
  const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
  // Channel health, handed back to provider.ts and logged there (one line per
  // request). `samples` is capped: a looping agent can produce dozens.
  const toolCalls = {
    total: 0,
    textParsed: 0,
    recovered: 0,
    incomplete: [] as { name: string; missing: string[] }[],
    samples: [] as string[],
  };
  // Text held back because it may be a tool-call block in the model's own
  // markup (a relay that cannot map native calls leaves it in `content`).
  // Cleared on the first character that proves the answer is prose.
  let heldText = '';
  let textDecided = false;

  /** Forward model text to the host, counting it for the usage estimate. */
  const emitText = (text: string): void => {
    if (!text) {
      return;
    }
    completionChars += text.length;
    progress.report(new vscode.LanguageModelTextPart(text));
  };

  /**
   * Text goes straight through UNLESS the answer opens with tool-call markup —
   * the case where the gateway lost the call entirely. Only the opening
   * characters are ever held, so streaming latency for prose is unchanged.
   */
  const reportText = (chunk: string): void => {
    thinkingRunId = undefined;
    if (textDecided) {
      emitText(chunk);
      return;
    }
    heldText += chunk;
    if (!mayBeToolCallMarkup(heldText.trimStart())) {
      textDecided = true;
      const text = heldText;
      heldText = '';
      emitText(text);
      return;
    }
    if (heldText.includes('</tool_call>')) {
      const { calls, rest } = extractTextToolCalls(heldText);
      if (calls.length > 0) {
        textDecided = true;
        heldText = '';
        for (const call of calls) {
          toolCalls.recovered += 1;
          progress.report(
            new vscode.LanguageModelToolCallPart(`call_${randomUUID()}`, call.name, call.args)
          );
        }
        emitText(rest.trim());
        return;
      }
    }
    if (heldText.length > MARKUP_BUFFER_LIMIT) {
      textDecided = true;
      const text = heldText;
      heldText = '';
      emitText(text);
    }
  };

  const flushToolCall = (index: number): void => {
    const pending = pendingToolCalls.get(index);
    if (!pending) {
      return;
    }
    pendingToolCalls.delete(index);
    let input: unknown;
    let malformed = false;
    try {
      input = pending.args.trim() ? JSON.parse(pending.args) : {};
    } catch {
      // Malformed arguments: hand the raw string over rather than dropping
      // the call — the tool layer will surface the schema error.
      input = { _raw: pending.args };
      malformed = true;
    }
    toolCalls.total += 1;
    if (malformed || NATIVE_TOOL_CALL_ID.test(pending.id)) {
      toolCalls.textParsed += 1;
      if (toolCalls.samples.length < 3) {
        const keys =
          !malformed && input !== null && typeof input === 'object'
            ? Object.keys(input as Record<string, unknown>).join('|') || '-'
            : 'raw';
        toolCalls.samples.push(`${pending.name || '?'}(${keys})`);
      }
    }
    // A call that cannot satisfy its own schema is a guaranteed failure. The
    // host would dispatch it, get `old_str is required`, feed that back, and
    // the model — seeing its own truncated call in the transcript — repeats it
    // verbatim (measured: 20 identical attempts, four minutes, no edit). Drop
    // it instead: the turn ends, and the notice below tells the user why.
    const required = requiredByTool?.get(pending.name);
    if (required && required.length > 0) {
      const present = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const missing = required.filter((field) => !(field in present));
      if (missing.length > 0) {
        toolCalls.incomplete.push({ name: pending.name, missing });
        return;
      }
    }
    progress.report(new vscode.LanguageModelToolCallPart(pending.id, pending.name, input as object));
  };

  /** One SSE event: every `data:` line it carries. */
  const handleEvent = (rawEvent: string): void => {
    for (const line of rawEvent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            // Reasoning text. `reasoning_content` is one common spelling;
            // `reasoning` is what several OpenAI-compatible proxies emit.
            // Both are read; neither is required.
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: GatewayUsage;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // Keep-alive comments / partial frames — skip.
      }
      if (chunk.usage) {
        // Terminal usage-only chunk (stream_options.include_usage) — the
        // most faithful numbers we can get; last one wins.
        usage = chunk.usage;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }
      const reasoning = reasoningText(delta);
      if (reasoning) {
        thinkingChars += reasoning.length;
        reasoningSoFar += reasoning;
        thinkingRunId ??= randomUUID();
        thinkingReported = reportThinking(reasoning, progress, thinkingRunId) || thinkingReported;
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        reportText(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        thinkingRunId = undefined;
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          const pending =
            pendingToolCalls.get(index) ??
            { id: call.id ?? `call_${index}`, name: '', args: '' };
          if (call.id) {
            pending.id = call.id;
          }
          if (call.function?.name) {
            pending.name += call.function.name;
          }
          if (call.function?.arguments) {
            pending.args += call.function.arguments;
          }
          pendingToolCalls.set(index, pending);
          // A tool call is complete when the NEXT index starts or the
          // stream ends; flush opportunistically on id/name/args end is
          // not reliable, so completion happens at stream end (below)
          // or when a new index arrives.
        }
      }
    }
  };

  /**
   * Consume every COMPLETE event in `buffer` (blank-line terminated).
   *
   * Events are framed by `\n\n`, so a stream that ends without a trailing
   * blank line leaves its last event — frequently the terminal usage chunk or
   * the final tool-call fragment — unread. The caller drains once more after
   * EOF (see below), which is why this is a function rather than an inline
   * loop.
   */
  const drainEvents = (): void => {
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const rawEvent = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
      handleEvent(rawEvent);
    }
  };

  try {
    for (;;) {
      if (token.isCancellationRequested) {
        await reader.cancel();
        // `toolCalls` is a live object: the flush below still runs and its
        // counters must reach the caller.
        return {
          usage,
          completionChars,
          thinkingChars,
          thinkingReported,
          reasoning: reasoningSoFar,
          toolCalls,
        };
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && onFirstChunk) {
        onFirstChunk(); // exactly once: first body bytes off the wire
        onFirstChunk = undefined;
      }
      buffer += decoder.decode(value, { stream: true });
      drainEvents();
    }
    // EOF: flush the unterminated tail event, if any.
    if (buffer.trim().length > 0) {
      buffer += '\n\n';
      drainEvents();
    }
  } finally {
    reader.releaseLock();
    // Stream over: flush every accumulated tool call in index order.
    for (const index of [...pendingToolCalls.keys()].sort((a, b) => a - b)) {
      flushToolCall(index);
    }
    // Anything still held back was markup we could not parse — show it rather
    // than swallowing the answer.
    if (heldText) {
      const text = heldText;
      heldText = '';
      try {
        emitText(text);
      } catch {
        // A dead progress sink must not mask the real error.
      }
    }
    if (toolCalls.incomplete.length > 0) {
      const detail = toolCalls.incomplete
        .map((call) => `${call.name} (missing ${call.missing.join(', ')})`)
        .join('; ');
      try {
        progress.report(
          new vscode.LanguageModelTextPart(
            vscode.l10n.t(
              'Dropped an incomplete tool call from the gateway: {0}. Retry, or pick another model — the gateway is truncating tool arguments.',
              detail
            )
          )
        );
      } catch {
        // As above: the diagnostic is not worth failing the turn over.
      }
    }
  }
  return { usage, completionChars, thinkingChars, thinkingReported, reasoning: reasoningSoFar, toolCalls };
}

/**
 * Reasoning text in a delta, or `''`. `reasoning_content` wins — it is the
 * field gateways that actually reason emit, and `reasoning` on several proxies
 * carries the same thing.
 */
function reasoningText(delta: { reasoning_content?: string | null; reasoning?: string | null }): string {
  const value = delta.reasoning_content ?? delta.reasoning;
  return typeof value === 'string' && value.length > 0 ? value : '';
}

// --- Usage reporting -----------------------------------------------------------

/**
 * mimeType Copilot Chat's BYOK request path listens for on the provider
 * stream's `LanguageModelDataPart`s. The JSON payload is validated host-side:
 * `prompt_tokens`, `completion_tokens` and `total_tokens` must all be numbers,
 * otherwise the part is dropped and the chat context-usage widget stays at 0%.
 */
const USAGE_MIME_TYPE = 'usage';

/** Usage numbers in the OpenAI-compatible wire shape. */
export type GatewayUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

/** Wrap usage numbers into the terminal data part Copilot Chat consumes. */
export function usageDataPart(usage: GatewayUsage): vscode.LanguageModelDataPart {
  const promptTokens = Math.max(0, Math.floor(usage.prompt_tokens ?? 0));
  const completionTokens = Math.max(0, Math.floor(usage.completion_tokens ?? 0));
  const totalTokens = Math.max(0, Math.floor(usage.total_tokens ?? promptTokens + completionTokens));
  const payload = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_tokens_details: {
      cached_tokens: Math.max(0, Math.floor(usage.prompt_tokens_details?.cached_tokens ?? 0)),
    },
  };
  return new vscode.LanguageModelDataPart(Buffer.from(JSON.stringify(payload), 'utf8'), USAGE_MIME_TYPE);
}

// --- Errors / cancellation -----------------------------------------------------

/** Sanitized gateway error text: no keys/tokens, single line, bounded length. */
export function sanitizeDetail(text: string, limit = 300): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***')
    .slice(0, limit);
}

/**
 * Read a non-2xx body ONCE and sanitize it. A second `.text()` on an already
 * consumed body throws, silently stripping the detail and leaving only the
 * bare status message.
 *
 * `limit` bounds the string: the CHAT-visible message wants it short, the
 * output channel wants enough of it to diagnose. The caller reads once at the
 * larger limit and truncates for the UI (sanitizeDetail is idempotent).
 */
export async function readErrorDetail(response: Response, limit = 300): Promise<string> {
  try {
    return sanitizeDetail(await response.text(), limit);
  } catch {
    // Body already consumed or unreadable — the status code is the message.
    return '';
  }
}

/** Map a non-2xx status + sanitized detail onto a LanguageModelError. */
export function responseErrorWithDetail(status: number, detail: string): vscode.LanguageModelError {
  const message = `Custom for Copilot gateway HTTP ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) {
    return vscode.LanguageModelError.NoPermissions(message);
  }
  if (status === 404) {
    return vscode.LanguageModelError.NotFound(message);
  }
  return new vscode.LanguageModelError(message);
}
