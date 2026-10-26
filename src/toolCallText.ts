/**
 * Tool calls that arrive as TEXT, not as `tool_calls`.
 *
 * WHY. A gateway that cannot map the model's native tool-call tokens onto the
 * OpenAI `tool_calls` field leaves the raw markup in `content`. MEASURED
 * (2026-11-05, Agents window, kimi-k2.6 behind a relay): two turns came back as
 *
 *     <tool_call><function=grep><parameter=pattern>…</parameter>…</function></tool_call>
 *
 * with `content` holding the markup and NO tool call at all — the host ran
 * nothing, the model saw no result, and the whole turn was wasted.
 *
 * The same relay has a second, worse failure: it DOES emit a `tool_calls` entry
 * but keeps only the first `<parameter>` block, so `edit` arrives as
 * `{ path }` and can never succeed. Nothing here can recover those missing
 * fields — this module only rescues the markup that is still on the wire.
 *
 * The format is the Qwen/Kimi chat-template one: one `<tool_call>` block per
 * call, `<function=NAME>` then `<parameter=KEY>VALUE</parameter>` per argument.
 * Values are untyped text, so they are coerced (the template carries no types)
 * exactly the way the serving stacks' own parsers do.
 */

/** One call recovered from markup. */
export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Wall clock guard: a model that starts a block and never closes it must not
 * swallow the rest of the answer.
 */
export const MARKUP_BUFFER_LIMIT = 8_000;

/** Openers a helper tag can begin with, in the templates seen in the wild. */
const MARKUP_STARTS = ['<tool_call>', '<tool_call', '<|tool_call', '<function='];

/**
 * Could `text` still turn into tool-call markup?
 *
 * `false` means "this is ordinary prose, show it now" — the caller uses that to
 * get text out of the buffer on the very first real character, so streaming
 * latency is unchanged for every answer that is not markup.
 */
export function mayBeToolCallMarkup(text: string): boolean {
  if (!text) {
    return true; // Nothing to judge yet — keep waiting.
  }
  return MARKUP_STARTS.some((start) => start.startsWith(text) || text.startsWith(start));
}

/** `<tool_call>` … `<function=NAME>` … `<parameter=K>V</parameter>` … `</function>` … `</tool_call>` */
const CALL_BLOCK = /<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
const PARAMETER = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

/**
 * Pull every COMPLETE call out of `text`.
 *
 * `rest` is everything that was not part of a complete block — including a
 * trailing block still waiting for its `</tool_call>`. The caller keeps that
 * buffered instead of showing half a tag to the user.
 */
export function extractTextToolCalls(text: string): { calls: TextToolCall[]; rest: string } {
  const calls: TextToolCall[] = [];
  let rest = '';
  let cursor = 0;
  CALL_BLOCK.lastIndex = 0;
  for (let match = CALL_BLOCK.exec(text); match; match = CALL_BLOCK.exec(text)) {
    rest += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const name = match[1].trim();
    if (name) {
      calls.push({ name, args: parseParameters(match[2]) });
    }
  }
  rest += text.slice(cursor);
  return { calls, rest };
}

/** Every `<parameter=…>` under one `<function=…>`, with the values typed. */
function parseParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  PARAMETER.lastIndex = 0;
  for (let match = PARAMETER.exec(body); match; match = PARAMETER.exec(body)) {
    const key = match[1].trim();
    if (key) {
      args[key] = coerce(match[2]);
    }
  }
  return args;
}

/**
 * The template carries no types, so a `-n: true` or `offset: 20` arrives as
 * text. Without this the host rejects the call for a type mismatch — the same
 * dead end as a truncated payload, one layer later.
 *
 * Strings are trimmed at the edges only: the template puts a newline after the
 * opening tag and before the closing one, which is never part of the value.
 */
function coerce(raw: string): unknown {
  const value = raw.trim();
  if (value === '') {
    return '';
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
    return null;
  }
  if (/^-?\d+$/.test(value) || /^-?\d*\.\d+$/.test(value)) {
    return Number(value);
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    try {
      return JSON.parse(value);
    } catch {
      return value; // Not JSON after all — keep the text, let the tool decide.
    }
  }
  return value;
}
