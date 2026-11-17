/**
 * `activate_*` tool preflight — finish VS Code's tool-activation handshake.
 *
 * Newer Copilot Chat builds (and the Agents window's Copilot SDK runtime) do
 * not hand every tool to the model at once. Instead the tool list contains
 * `activate_<group>` entries and the model is expected to CALL them; only then
 * does VS Code expand the real tools into the next round. Two things go wrong
 * on a third-party provider:
 *
 *   1. the model never calls them, so the agent silently runs with no tools;
 *   2. the calls land in the transcript, and on the next round our own
 *      synthetic call/result pairs are still there — dead control flow that
 *      confuses the model and inflates every subsequent prompt.
 *
 * So this module:
 *
 *   - inspects the transcript for how many activation rounds already ran and
 *     which activators are still uncalled,
 *   - lets the provider emit the missing `activate_*` calls itself and return
 *     WITHOUT spending a single token (the biggest win: no request is sent),
 *   - strips its own synthetic call/result parts back out before a real
 *     request goes to the gateway.
 *
 * MEASURED HOST SEMANTICS: activator groups are MUTUALLY EXCLUSIVE, not
 * additive. Activating one group revokes the previously active one. Two
 * consequences drive the design:
 *
 *   - emitting every activator in one round leaves only the LAST group alive;
 *     we therefore emit exactly ONE per turn (pickActivatorToCall) and stop as
 *     soon as any activator was called,
 *   - `activate_*` entries never disappear from an expanded list, so their
 *     continued presence is the normal state, NOT an instability signal.
 *
 * The same exclusivity has a mid-turn consequence: a tool from a group we did
 * not arm is answered with "Tool X is currently disabled by the user" — a
 * sentence that blames the user, while the real fix is an `activate_*` call.
 * So a refusal that lands AFTER our last activation re-arms the group serving
 * the refused tool, and every refusal is rewritten into that actionable form
 * before the request leaves the provider (see rewriteDisabledToolResults).
 *
 * The synthetic call ids are recognisable (`cm_preflight_activate_<round>_…`)
 * so we can tell our own control flow apart from VS Code's.
 *
 * ALWAYS ON (fixed behavior — no switch): the handshake
 * costs no gateway request, and without it a folded list leaves the agent
 * with zero tools.
 */
import { createHash } from 'crypto';
import * as vscode from 'vscode';

/** Copilot Chat's tool-activation prefix. */
export const ACTIVATE_TOOL_PREFIX = 'activate_';

/** Marks a call/result part as OUR synthetic activation handshake. */
const PREFLIGHT_CALL_ID_PREFIX = 'cm_preflight_activate_';

/**
 * The host's refusal when the refusing tool's group is not the live one.
 * Anchored on the tool name so the rewrite can name the tool back to the
 * model. The host's trailing clause ("and cannot be called. Please check your
 * input and try again.") is matched whole — replacing only the first sentence
 * would leave that one dangling after the new advice.
 */
const HOST_REFUSAL_PATTERN =
  /Tool ([\w.]+) is currently disabled by the user(?:[^.]*\.)?(?:\s*Please[^.]*\.)?/g;

/**
 * Every failed tool invocation's result is prefixed with this by the host.
 * Requiring it keeps quoted documentation ("... `Tool X is currently disabled
 * by the user` ...") from being mistaken for a refusal.
 */
const HOST_TOOL_ERROR_PREFIX = 'ERROR while calling tool:';
const CALL_ID_SEPARATOR = '_';
const TOOL_NAME_HASH_LENGTH = 32;

/**
 * Give up after this many activation rounds for one user turn. Without a cap a
 * list that never stabilizes would ping-pong forever — each round a full-price
 * gateway request.
 */
export const MAX_PREFLIGHT_ROUNDS = 3;

export interface ActivatePreflight {
  /** Rounds already completed for the current user turn (0 = none). */
  rounds: number;
  /** Activators called (by us or by the model) — before any of these the
   *  tool surface holds no real tools at all. */
  calledActivatorNames: string[];
  /** Activators advertised in this round but not called yet. */
  remainingActivatorNames: string[];
  /** Every activator advertised in this round, called or not. */
  activatorNames: string[];
  /**
   * Activation already happened and `activate_*` entries are STILL in the tool
   * list. Under the measured mutually-exclusive semantics this is the NORMAL
   * state (the host keeps the switches, only one group is live), so it is
   * reported for diagnostics and never retried.
   */
  activatorsStillAdvertised: boolean;
  /**
   * Tools the host refused with "currently disabled by the user" since the
   * last human message (empty = no refusal in this turn).
   */
  refusedToolNames: string[];
  /**
   * A refusal landed AFTER our last activation — the live group was revoked
   * (another group took over, or the activation expired with the round), so
   * the handshake has to re-arm the switch serving that tool's group. A
   * refusal that sits BEFORE the activation is old news and must not re-arm.
   */
  refusedAfterActivation: boolean;
}

/**
 * How far the handshake has got, and what is still owed.
 *
 * Only parts AFTER the last genuine user message are inspected: activation
 * belongs to the current turn, and an older round's ids must not count.
 */
export function inspectActivatePreflight(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): ActivatePreflight {
  const activatorNames = collectActivateToolNames(tools);
  // callId → tool name: a refusal only counts for the call it answers (see
  // refusalToolNames). Built over the WHOLE transcript because the call we are
  // looking for may sit anywhere before its result.
  const toolNameByCallId = collectToolCallNames(messages);
  const calledActivatorNames = new Set<string>();
  let rounds = 0;
  // Transcript order decides whether a refusal is old news or a live problem:
  // both counters advance per part, so comparing them needs no timestamps.
  let order = 0;
  let lastActivationOrder = -1;
  let lastRefusalOrder = -1;
  let refusedToolNames: string[] = [];

  const latestUserIndex = findLatestHumanUserMessageIndex(messages);
  for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
    for (const part of messages[index].content) {
      order += 1;
      const parsed = parsePreflightPart(part);
      if (parsed) {
        rounds = Math.max(rounds, parsed.round);
        if (parsed.toolName?.startsWith(ACTIVATE_TOOL_PREFIX)) {
          calledActivatorNames.add(parsed.toolName);
          lastActivationOrder = order;
        }
        continue;
      }
      const activationName = activationCallName(part);
      if (activationName) {
        // The model's own activator call carries a host-generated id, so it
        // never parses above — but it still means "we activated here", which
        // is what a later refusal has to be compared against. It also counts
        // as called: otherwise the next round would pick the SAME group again
        // and revoke the one the model just brought in.
        calledActivatorNames.add(activationName);
        lastActivationOrder = order;
        continue;
      }
      const refused = refusalToolNames(
        part,
        part instanceof vscode.LanguageModelToolResultPart
          ? toolNameByCallId.get(part.callId)
          : undefined
      );
      if (refused.length > 0) {
        refusedToolNames = refused;
        lastRefusalOrder = order;
      }
    }
  }

  const remainingActivatorNames = activatorNames.filter((name) => !calledActivatorNames.has(name));
  return {
    rounds,
    calledActivatorNames: [...calledActivatorNames],
    remainingActivatorNames,
    activatorNames,
    // Only meaningful AFTER a call: before that the switches are expected to
    // sit there waiting. See the header note on exclusive groups.
    activatorsStillAdvertised:
      rounds > 0 && activatorNames.length > 0 && Boolean(tools?.length),
    refusedToolNames,
    refusedAfterActivation: lastRefusalOrder > lastActivationOrder,
  };
}

/**
 * Which activator to call next — `undefined` once the handshake is done.
 *
 * Exactly ONE per turn, by design: groups are mutually exclusive on the host,
 * so a second call would revoke the group the first one just brought in. The
 * choice is made here (deterministic, first advertised) rather than left to the
 * host's execution order, so the resulting capability set is predictable and
 * can be logged.
 *
 * Two exceptions, both bounded by MAX_PREFLIGHT_ROUNDS:
 *
 *   - a refusal that landed AFTER our activation means the live group was
 *     revoked, so a switch has to be brought back. The switch to bring back is
 *     the one serving the REFUSED tool's capability group — re-arming whatever
 *     ran last cannot help when the refused tool belongs to another group, and
 *     that mismatch turns a one-round recovery into a ping-pong that burns the
 *     whole budget;
 *   - if no advertised activator names that group (the host is free to name
 *     switches differently), fall back to the last armed switch — but only
 *     while the host still advertises it. Calling one that is gone answers
 *     `The tool "..." does not exist` and cannot change anything.
 *
 * The budget check lives here as well as in the caller: this is the function
 * that could loop, so it must be unable to.
 */
export function pickActivatorToCall(preflight: ActivatePreflight): string | undefined {
  if (preflightBudgetExhausted(preflight)) {
    return undefined;
  }
  if (preflight.calledActivatorNames.length === 0) {
    return preflight.remainingActivatorNames[0];
  }
  if (!preflight.refusedAfterActivation) {
    return undefined;
  }
  return reArmActivatorFor(preflight);
}

/** True once this turn has spent its activation rounds — emit nothing more. */
export function preflightBudgetExhausted(preflight: ActivatePreflight): boolean {
  return preflight.rounds >= MAX_PREFLIGHT_ROUNDS;
}

/** The switch to bring back after a refusal that followed our last activation. */
function reArmActivatorFor(preflight: ActivatePreflight): string | undefined {
  const refused = preflight.refusedToolNames[preflight.refusedToolNames.length - 1];
  if (refused !== undefined) {
    const group = capabilityGroupOf(refused);
    const serving = preflight.activatorNames.find((name) => activatorServesGroup(name, group));
    if (serving !== undefined) {
      return serving;
    }
  }
  const lastCalled = preflight.calledActivatorNames[preflight.calledActivatorNames.length - 1];
  return preflight.activatorNames.includes(lastCalled) ? lastCalled : undefined;
}

/**
 * Does this switch advertise a tool of `group`? Token match on the switch name:
 * `activate_gitlab` and `activate_fallback_gitlab_compare_1` both serve
 * `gitlab`, while `activate_gitlab` does NOT serve `git` — a substring match
 * would pick the wrong group, and the wrong group is what the re-arm exists to
 * avoid.
 */
function activatorServesGroup(activatorName: string, group: string): boolean {
  const needle = group.toLowerCase();
  return activatorName
    .slice(ACTIVATE_TOOL_PREFIX.length)
    .split(CALL_ID_SEPARATOR)
    .some((token) => token.toLowerCase() === needle);
}

/** Capability bucket for one real tool name (`read_file` → `read`). */
function capabilityGroupOf(name: string): string {
  const separator = name.indexOf('_');
  return separator > 0 ? name.slice(0, separator) : name;
}

/** Real (non-activator) tools currently on the surface. */
export function countRealTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): number {
  return (tools ?? []).filter((tool) => !tool.name.startsWith(ACTIVATE_TOOL_PREFIX)).length;
}

/**
 * One-line description of the live tool surface, e.g.
 * `real=12 activators=3 groups=edit:4,terminal:3`.
 *
 * This is the only way to tell a working activation from a silent no-op: the
 * host gives no other feedback.
 */
export function summarizeToolSurface(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  maxGroups = 6
): string {
  const counts = new Map<string, number>();
  let activators = 0;
  for (const tool of tools ?? []) {
    if (tool.name.startsWith(ACTIVATE_TOOL_PREFIX)) {
      activators += 1;
      continue;
    }
    const group = capabilityGroupOf(tool.name);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxGroups)
    .map(([group, count]) => `${group}:${count}`)
    .join(',');
  const real = countRealTools(tools);
  return `real=${real} activators=${activators}${groups ? ` groups=${groups}` : ''}`;
}

/**
 * Remove OUR control flow from the transcript before the real request.
 *
 * Returns the SAME array reference when nothing matched — callers compare by
 * identity to decide whether the payload has to be rebuilt. A message left
 * with no parts is dropped entirely (an empty assistant turn is worse than no
 * turn at all).
 */
export function filterPreflightControlFlow(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): readonly vscode.LanguageModelChatRequestMessage[] {
  let changed = false;
  const filtered: vscode.LanguageModelChatRequestMessage[] = [];

  for (const message of messages) {
    const hasPreflightPart = message.content.some(isPreflightPart);
    const content = message.content.filter(
      (part) => !isPreflightPart(part) && !(hasPreflightPart && isEmptyTextPart(part))
    );
    if (content.length === message.content.length) {
      filtered.push(message);
      continue;
    }
    changed = true;
    if (content.length > 0) {
      filtered.push({ ...message, content });
    }
  }

  return changed ? filtered : messages;
}

/**
 * Rewrite the host's refusal into an actionable one before the request leaves
 * the provider.
 *
 * The host text blames the user ("disabled by the user") and ends in "Please
 * check your input and try again", which reads as a dead end: the model has no
 * way to learn that the fix is an `activate_*` call. Same identity contract as
 * `filterPreflightControlFlow` — the SAME array reference comes back when
 * nothing matched, so callers can skip rebuilding the payload.
 */
export function rewriteDisabledToolResults(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): readonly vscode.LanguageModelChatRequestMessage[] {
  let changed = false;
  const rewritten: vscode.LanguageModelChatRequestMessage[] = [];
  const toolNameByCallId = collectToolCallNames(messages);

  for (const message of messages) {
    let touched = false;
    const content = message.content.map((part) => {
      const replacement = rewrittenRefusalPart(
        part,
        part instanceof vscode.LanguageModelToolResultPart
          ? toolNameByCallId.get(part.callId)
          : undefined
      );
      if (!replacement) {
        return part;
      }
      touched = true;
      return replacement;
    });
    if (!touched) {
      rewritten.push(message);
      continue;
    }
    changed = true;
    rewritten.push({ ...message, content });
  }

  return changed ? rewritten : messages;
}

/** The refusal part with an actionable sentence, or `undefined` when it is not one. */
function rewrittenRefusalPart(
  part: unknown,
  callName: string | undefined
): vscode.LanguageModelToolResultPart | undefined {
  if (!(part instanceof vscode.LanguageModelToolResultPart)) {
    return undefined;
  }
  let touched = false;
  const content = part.content.map((inner) => {
    if (!(inner instanceof vscode.LanguageModelTextPart) || !isHostToolError(inner.value)) {
      return inner;
    }
    const value = inner.value.replace(HOST_REFUSAL_PATTERN, (match, toolName: string) =>
      // A result can quote the sentence (docs, skills, a grep hit). Only the
      // refused call's own result is the host talking.
      callName !== undefined && toolName !== callName ? match : refusalGuidance(toolName)
    );
    if (value === inner.value) {
      return inner;
    }
    touched = true;
    return new vscode.LanguageModelTextPart(value);
  });
  return touched ? new vscode.LanguageModelToolResultPart(part.callId, content) : undefined;
}

/** Every tool name the refusal in `part` mentions (empty when it is not one). */
function refusalToolNames(part: unknown, callName: string | undefined): string[] {
  if (!(part instanceof vscode.LanguageModelToolResultPart)) {
    return [];
  }
  const names: string[] = [];
  for (const inner of part.content) {
    if (!(inner instanceof vscode.LanguageModelTextPart) || !isHostToolError(inner.value)) {
      continue;
    }
    for (const match of inner.value.matchAll(HOST_REFUSAL_PATTERN)) {
      if (callName !== undefined && match[1] !== callName) {
        continue;
      }
      names.push(match[1]);
    }
  }
  return names;
}

/** A tool result the host itself marked as a failed invocation. */
function isHostToolError(value: string): boolean {
  return value.includes(HOST_TOOL_ERROR_PREFIX);
}

function refusalGuidance(toolName: string): string {
  return (
    `Tool ${toolName} is not available right now: another tool-activation group is live, ` +
    `so ${toolName} is not on the surface (the user disabled nothing). ` +
    `Call the \`${ACTIVATE_TOOL_PREFIX}*\` tool that advertises ${toolName}, then retry the same call.`
  );
}

/** The activator name of a (host-id) activation call, or `undefined`. */
function activationCallName(part: unknown): string | undefined {
  if (!(part instanceof vscode.LanguageModelToolCallPart)) {
    return undefined;
  }
  return part.name.startsWith(ACTIVATE_TOOL_PREFIX) ? part.name : undefined;
}

/** callId → tool name for every tool call in the transcript. */
function collectToolCallNames(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        names.set(part.callId, part.name);
      }
    }
  }
  return names;
}

/**
 * Id for a synthetic activation call: short, `[\w]`-only, and round-tagged so
 * `inspectActivatePreflight` can count rounds straight off the transcript.
 */
export function createPreflightToolCallId(round: number, toolName: string): string {
  const hash = createHash('sha256').update(toolName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
  return `${PREFLIGHT_CALL_ID_PREFIX}${round}${CALL_ID_SEPARATOR}${hash}`;
}

function collectActivateToolNames(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    if (!tool.name.startsWith(ACTIVATE_TOOL_PREFIX) || seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    names.push(tool.name);
  }
  return names;
}

/**
 * The last user message the HUMAN wrote. Preceding turns carry tool results
 * masquerading as user messages, and an activation round only ever follows the
 * real prompt — so counting rounds before that index would over-count.
 */
function findLatestHumanUserMessageIndex(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }
    if (message.content.some(isHumanUserMessagePart)) {
      return index;
    }
  }
  return -1;
}

function isHumanUserMessagePart(part: unknown): boolean {
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return false;
  }
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value.length > 0;
  }
  return true;
}

function parsePreflightPart(part: unknown): { round: number; toolName?: string } | undefined {
  if (part instanceof vscode.LanguageModelToolCallPart) {
    const round = parsePreflightToolCallId(part.callId);
    return round === undefined ? undefined : { round, toolName: part.name };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    const round = parsePreflightToolCallId(part.callId);
    return round === undefined ? undefined : { round };
  }
  return undefined;
}

function isPreflightPart(part: unknown): boolean {
  return (
    (part instanceof vscode.LanguageModelToolCallPart ||
      part instanceof vscode.LanguageModelToolResultPart) &&
    part.callId.startsWith(PREFLIGHT_CALL_ID_PREFIX)
  );
}

function isEmptyTextPart(part: unknown): boolean {
  return part instanceof vscode.LanguageModelTextPart && part.value.length === 0;
}

function parsePreflightToolCallId(callId: string): number | undefined {
  if (!callId.startsWith(PREFLIGHT_CALL_ID_PREFIX)) {
    return undefined;
  }
  const value = callId.slice(PREFLIGHT_CALL_ID_PREFIX.length);
  const separator = value.indexOf(CALL_ID_SEPARATOR);
  if (separator < 0) {
    return undefined;
  }
  const round = Number.parseInt(value.slice(0, separator), 10);
  return Number.isSafeInteger(round) && round >= 1 ? round : undefined;
}
