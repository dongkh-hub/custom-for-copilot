/**
 * Configuration surface: the profile SHAPE, state keys, official model presets
 * and the thinking-effort gear.
 *
 * The configured list itself does NOT live here — `profileStore.ts` owns it,
 * in the user-level credential store (`customModel.profiles.v2`), so every VS
 * Code profile on this machine sees the same groups. This module owns what a
 * group IS ({ key, name, baseURL, model, noAuth?, maxInputTokens,
 * maxOutputTokens }) and everything derived from it: the official preset
 * chain, the picker id encoding and the thinking-effort gear. API keys stay in
 * SecretStorage too, under
 * `customModel.apiKey.<profileKey>`. The request path reads the list and the
 * key PER REQUEST — a swap takes effect on the next chat message with no
 * reload.
 *
 * Token limits follow a fixed chain:
 *
 *   explicit `maxInputTokens`/`maxOutputTokens` setting (> 0)
 *     > the preset detected from the model id (official vendor figures)
 *     > the 1M/128K mainstream default
 *
 * `0` (the default) means "auto": the preset chain rules. Everything else
 * this extension does (helper-request downgrade, tool-list stabilization,
 * thinking passthrough) is fixed behavior — there are no hidden switches.
 *
 * The window is a DECLARATION the host sizes on, and a rung set is a CHOICE on
 * top of it. A row may offer several windows (`Profile.windowInputs`); the
 * model panel then shows the `contextSize` dropdown, and whichever rung is
 * DECLARED (`maxInputTokens`) is what a harness without that panel applies.
 * Only one of the two harnesses renders the panel, which is why the declared
 * value — never the last panel pick — is what the session is sized against in
 * the other one, and why the panel default has to equal the declaration.
 *
 * The effort dimension works the same way: `Profile.reasoningIds` is the set
 * the panel offers, `defaultThinkingEffort` is the position a request uses
 * before anyone touches it. No rung set at all = one window and every effort
 * position, i.e. the behaviour of an install that never configured either.
 *
 * The preset REGEXES recognize the ids of mainstream models so their limits
 * apply automatically; the preset ids/labels stay neutral (alpha/beta/gamma)
 * so nothing vendor-specific surfaces in the wizard summary or docs. There
 * is NO universal input:output ratio — each model caps output per id, and
 * reasoning models keep their own (larger) output budget because reasoning
 * tokens count toward it. When a gateway serves ids no preset recognizes,
 * the mainstream default applies and the profile's limits can pin real numbers.
 */
import * as vscode from 'vscode';

/** LM provider vendor — MUST match `contributes.languageModelChatProviders[].vendor`. */
export const MODEL_PROVIDER_VENDOR = 'custommodel';

/** One-shot markers in globalState. */
export const STATE_KEYS = {
  AGENT_WINDOW_DEFAULTS: 'customModel.agentWindowDefaultsApplied',
  SETUP_HINT: 'customModel.setupHintShown',
  CHAT_HINT: 'customModel.copilotChatHintShown',
} as const;

/**
 * Mainstream default for ids no preset matches (flagship tier, 2026):
 * 1M window / 128K output. Overdeclaring the WINDOW makes the host send more
 * history than a smaller model supports — if a request 400s on long
 * conversations, pin the real numbers (or 0 = auto) in settings.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 1048576;
export const DEFAULT_MAX_OUTPUT_TOKENS = 131072;

/** Official input/output limits of one known model. */
export interface ModelLimits {
  /**
   * Declared prompt budget the HOST sizes the conversation history against.
   * The model's real window (preset figure or mainstream default) unless the
   * profile pins a number — there is no gear control for it any more (see the
   * module docblock).
   */
  readonly maxInputTokens: number;
  /** Declared output ceiling reserved for the answer. */
  readonly maxOutputTokens: number;
  /**
   * Thinking/reasoning model (from the preset detected for the model id).
   * Reported in the resolved entry so the picker and the request log can tell
   * a reasoning model apart; nothing clamps differently on it any more — the
   * thinking-effort gear is the user's call now.
   */
  readonly reasoning?: boolean;
}

/** One vendor-preset: limits + how the model id is recognized. */
export interface ModelPreset extends ModelLimits {
  /** Preset id. */
  readonly id: string;
  /** Human label for the wizard summary / settings docs. */
  readonly label: string;
  /** Case-insensitive match against the model id. Order matters (first hit wins). */
  readonly match: RegExp;
}

/**
 * Official presets, checked in order. Narrow ids (thinking variants,
 * 4.6) MUST precede their family catch-alls.
 */
const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'alpha-4.1',
    label: 'Alpha 4.1 (1M/32K)',
    match: /^gpt-4\.1/i,
    maxInputTokens: 1047576,
    maxOutputTokens: 32768,
  },
  {
    id: 'alpha-5',
    label: 'Alpha 5 (272K/128K)',
    match: /^gpt-5/i,
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    id: 'alpha-4o',
    label: 'Alpha 4o (128K/16K)',
    match: /^gpt-4o/i,
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
  },
  {
    // Thinking mode: the reasoner/r1/thinking suffix routes to the thinking
    // preset; reasoning tokens count toward the output budget, so the entry
    // is flagged.
    id: 'beta-thinking',
    label: 'Beta thinking (1M/128K)',
    match: /deepseek[-_.]?(reasoner|r1|thinking)/i,
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
    reasoning: true,
  },
  {
    // deepseek-chat / deepseek / dsv4 / v4 / v4-flash / v4-pro …
    id: 'beta-v4',
    label: 'Beta V4 (1M/128K)',
    match: /deepseek|dsv4|^v4[-_.]?(flash|pro)?/i,
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
  },
  {
    id: 'gamma-5',
    label: 'Gamma 5 (1M/128K)',
    match: /glm[-_.]?5/i,
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
  },
  {
    id: 'gamma-4.6',
    label: 'Gamma 4.6 (200K/128K)',
    match: /glm[-_.]?4\.6/i,
    maxInputTokens: 200000,
    maxOutputTokens: 131072,
  },
];

/** The preset an id maps to (first hit), or `undefined`. */
export function detectModelPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.match.test(id));
}

/**
 * The model's REAL input ceiling: the preset figure, or the mainstream
 * default. This is what the entry declares.
 */
export function realInputCeiling(model: string): number {
  return detectModelPreset(model)?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
}

/**
 * The input figure the SUMMARY lines show (settings mirror, manager list):
 * the model's real ceiling until the user overrides it, then their number.
 *
 * Identical to the resolved value now that the ladder is gone — kept as a
 * separate name so the summary keeps its own meaning ("what this model is"),
 * independent of what the declaration happens to be.
 */
export function summaryInputTokens(profile: Pick<Profile, 'model' | 'maxInputTokens'>): number {
  return profile.maxInputTokens > 0 ? profile.maxInputTokens : realInputCeiling(profile.model);
}

/** The one configured model, limits resolved (what the picker and the request path see). */
export interface ModelEntry extends ModelLimits {
  /** Sent as `model` in the request body AND shown in the picker. */
  readonly id: string;
  /** The preset that supplied the limits, if any (wizard summary / docs). */
  readonly presetLabel?: string;
  /**
   * Effort positions this row may be used at, in table order. Empty = the row
   * offers no control at all (an upstream that rejects `reasoning_effort`).
   */
  readonly reasoningEfforts: readonly ThinkingEffort[];
  /**
   * Position applied when the host sends nothing — the one the panel
   * pre-selects. A member of `reasoningEfforts`; undefined only when empty.
   */
  readonly defaultThinkingEffort?: ThinkingEffort;
  /**
   * Windows this row may be used at, the DECLARED one included. Absent = the
   * declaration is the only window (no panel control, today's behaviour).
   */
  readonly contextTiers?: readonly ModelWindowTier[];
}

/** Shared output channel ("Custom for Copilot") for diagnostics that must survive without a debugger. */
let channel: vscode.OutputChannel | undefined;
export function modelOutput(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Custom for Copilot');
  return channel;
}

// --- Profiles: one entry = one endpoint + one model + one key -------------------
//
// A profile is the unit the wizard creates. Several can coexist — that is the
// whole point: two gateways, or the same gateway with two keys — and each one
// shows up in the model picker under its own ALIAS (`name`).
//
// The picker id MUST be unique per profile, not per model: two profiles may
// serve the same upstream model id, and VS Code indexes the model list BY ID
// (a duplicate id means the second row silently replaces the first). Hence
// `<profileKey>::<model>` on the wire, decoded back on every request.

/** Separator inside a picker model id: `<profileKey>::<model>`. */
const PICKER_ID_SEPARATOR = '::';

/** One configured endpoint + model + (key stored in SecretStorage). */
export interface Profile {
  /** Internal, stable identifier — never shown, never reused. */
  readonly key: string;
  /** Display alias shown in the picker (empty = use the model id). */
  readonly name: string;
  /** API base URL, trailing slashes stripped. */
  readonly baseURL: string;
  /** The REAL `model` parameter sent in the request body. */
  readonly model: string;
  /**
   * This endpoint serves requests WITHOUT an API key.
   *
   * Self-hosted gateways are frequently keyless: a local inference server
   * started without an auth flag accepts — and ignores — whatever
   * Authorization header arrives. Requiring a key made those endpoints
   * impossible to add, so the wizard offers this as an explicit choice and no
   * Authorization header is sent at all (an empty `Bearer ` is accepted by
   * some of them but rejected by others, and it also trips auth middlewares
   * that treat the header's presence as a credential).
   */
  readonly noAuth?: boolean;
  /** Explicit input budget (`0` = auto: preset chain). */
  readonly maxInputTokens: number;
  /** Explicit output ceiling (`0` = auto: preset chain). */
  readonly maxOutputTokens: number;
  /**
   * Windows this row may be used at, as INPUT budgets, the declared one
   * (`maxInputTokens`) included. Two or more = the model panel shows a
   * `contextSize` dropdown and `maxInputTokens` is the pre-selected rung.
   *
   * Absent = one window, exactly the behaviour of every install that never
   * asked: the declared budget and no control for it.
   */
  readonly windowInputs?: readonly number[];
  /**
   * Effort positions this row offers, as `THINKING_EFFORTS` ids. Absent =
   * every position (the default), EMPTY = no control at all — the honest
   * answer for a gateway that rejects `reasoning_effort`, and the only way to
   * say so.
   */
  readonly reasoningIds?: readonly ThinkingEffort[];
  /** Position the panel pre-selects; MUST be a member of `reasoningIds`. */
  readonly defaultThinkingEffort?: ThinkingEffort;
}

/** Model id handed to VS Code: unique even when two profiles share a model. */
export function encodePickerId(profileKey: string, model: string): string {
  return `${profileKey}${PICKER_ID_SEPARATOR}${model}`;
}

/** Split a picker id back into its profile key and model. */
export function decodePickerId(
  pickerId: string
): { key: string; model: string } | undefined {
  const at = pickerId.indexOf(PICKER_ID_SEPARATOR);
  if (at <= 0 || at >= pickerId.length - PICKER_ID_SEPARATOR.length) {
    return undefined;
  }
  return {
    key: pickerId.slice(0, at),
    model: pickerId.slice(at + PICKER_ID_SEPARATOR.length),
  };
}

/** A fresh, collision-resistant profile key (`p` + timestamp + random). */
export function newProfileKey(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Normalise what the user typed as a base URL.
 *
 * Two things bite on a self-hosted / hosted OpenAI-compatible endpoint:
 *
 *   1. a FULL endpoint pasted in (`https://x/v1/chat/completions`) instead of
 *      its base — the request path appends `/chat/completions`, so that URL
 *      becomes `.../chat/completions/chat/completions` and answers 404, which
 *      the 400-only recovery ladder never retries;
 *   2. trailing slashes, which produce `//chat/completions` (accepted by most
 *      gateways, rejected by a few strict routers).
 *
 * `/v1` is deliberately NOT appended or verified: the correct prefix differs
 * per gateway (`/v1`, `/v1/openai`, `/openai/v1`, a deployment path, …) and
 * guessing it would break the ones that do not use `/v1`. Stripping only a
 * well-known SUFFIX is safe in both directions.
 */
export function normalizeBaseURL(input: string): string {
  let url = input.trim();
  // `.../chat/completions` is the endpoint, not the base — drop it. Case and
  // trailing slashes are tolerated because the two forms arrive from copied
  // curl snippets and docs pages.
  url = url.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return url.replace(/\/+$/, '');
}

/** A profile is usable when its endpoint needs no key, or its key is stored. */
export function profileHasCredentials(profile: Profile, apiKey: string): boolean {
  return profile.noAuth === true || apiKey.length > 0;
}

/**
 * Validate ONE stored row into a Profile. Unknown fields are dropped, empty
 * `key`/`model`/`baseURL` invalidate the row, and the two limits collapse to
 * `0` (= auto) unless they are positive finite numbers.
 *
 * Exported because the list lives in the user-level credential store
 * (`profileStore.ts`) and the stored payload is the single shape this parser
 * serves.
 */
export function parseProfile(raw: unknown): Profile | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const key = text(record.key);
  const model = text(record.model);
  const baseURL = normalizeBaseURL(text(record.baseURL));
  if (!key || !model || !baseURL) {
    return undefined;
  }
  const limit = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const maxInputTokens = limit(record.maxInputTokens);
  // Rung sets are re-checked against what this row can actually declare: a
  // window above the model's ceiling, or an effort id a later build retired,
  // would otherwise reach the panel as an option it can never honour.
  const windowInputs = normalizeWindowInputs(
    record.windowInputs,
    maxInputTokens > 0 ? maxInputTokens : realInputCeiling(model)
  );
  // An ARRAY is taken literally (an empty one means "no control"); an absent
  // field stays absent so `resolveReasoningIds` can read it as "every rung".
  const reasoningIds = Array.isArray(record.reasoningIds)
    ? resolveReasoningIds(record.reasoningIds)
    : undefined;
  return {
    key,
    name: text(record.name),
    baseURL,
    model,
    // Only the explicit `true` counts: a hand-edited payload saying
    // `"noAuth": "false"` must not silently disable authentication.
    ...(record.noAuth === true ? { noAuth: true } : {}),
    maxInputTokens,
    maxOutputTokens: limit(record.maxOutputTokens),
    ...(windowInputs.length > 1 ? { windowInputs } : {}),
    ...(reasoningIds ? { reasoningIds } : {}),
    ...(reasoningIds?.length
      ? { defaultThinkingEffort: resolveDefaultThinking(record.defaultThinkingEffort, reasoningIds) }
      : {}),
  };
}

// The list itself (read/write/upsert/remove + cross-window reload) lives in
// `profileStore.ts`: it is stored in the user-level credential store so every
// VS Code profile on the machine shares one set of groups.

// --- Window rungs and effort rungs -------------------------------------------
//
// A row may offer SEVERAL windows and SEVERAL effort positions; the model
// panel then shows one dropdown per dimension. The DECLARED window and the
// DEFAULT effort are what a harness without that panel (Copilot) applies, so
// asking for both keeps the two hosts describing the same model.

/** One rung of the model panel's `contextSize` control. */
export interface ModelWindowTier {
  /** Stable id (wizard pick payload; never a picker id). */
  readonly id: string;
  /** The TOTAL window the host shows: `maxInputTokens + maxOutputTokens`. */
  readonly label: string;
  /** Declared prompt budget of this rung. */
  readonly maxInputTokens: number;
  /** Answer reserve of this rung — the ROW's ceiling for every rung. */
  readonly maxOutputTokens: number;
}

/**
 * The named windows a row may offer, ascending.
 *
 * Each carries the output it was named against, so the total is the round
 * number on its label (`256K` = 223232 + 32768). A row REBASES them onto its
 * own output — see {@link windowCandidates} — because the host adds that
 * output to whichever input is selected, and a label that stopped matching
 * that sum would describe a window nobody can pick.
 */
export const MODEL_WINDOW_TIERS: readonly ModelWindowTier[] = [
  { id: 'tier-128k', label: '128K', maxInputTokens: 111616, maxOutputTokens: 16384 },
  { id: 'tier-256k', label: '256K', maxInputTokens: 223232, maxOutputTokens: 32768 },
  { id: 'tier-512k', label: '512K', maxInputTokens: 446464, maxOutputTokens: 65536 },
  { id: 'tier-1m', label: '1M', maxInputTokens: 934464, maxOutputTokens: 65536 },
];

/** `input + output` — the number the host's context ring shows. */
export function windowTierTotal(
  tier: Pick<ModelWindowTier, 'maxInputTokens' | 'maxOutputTokens'>
): number {
  return tier.maxInputTokens + tier.maxOutputTokens;
}

/**
 * The host's own abbreviation of a TOTAL window (its `$E` helper): base-1000,
 * one decimal in the M band, everything above 900K read as `1M`.
 *
 * The THIRD label function in this module, and the only one allowed on a
 * window rung. `tokenWindowLabel` is binary (an output of 131072 is `128K`)
 * and `summaryWindowLabel` is the vendor's decimal figure; a rung label has to
 * be the number the context ring will show, or the panel and the ring
 * disagree about the very choice the user just made.
 */
export function hostWindowLabel(totalTokens: number): string {
  if (totalTokens >= 1_000_000) {
    const millions = Math.floor((totalTokens / 1_000_000) * 10) / 10;
    return millions % 1 === 0 ? `${millions.toFixed(0)}M` : `${millions.toFixed(1)}M`;
  }
  if (totalTokens > 900_000) {
    return '1M';
  }
  if (totalTokens >= 1_000) {
    return `${Math.round(totalTokens / 1_000)}K`;
  }
  return String(totalTokens);
}

/**
 * The NAMED windows one row may offer, rebased onto its own output.
 *
 * Only the table's windows — the model's own ceiling is NOT one of them. A
 * ceiling-derived rung reads as a number nobody asked for (`1.1M` for a 1M
 * model, because the ring adds the answer reserve), and a list is supposed to
 * offer the windows people name. A window outside this set is the wizard's
 * 「自定义…」 rung, which the user types themselves (see
 * {@link customWindowTier}).
 *
 * A tier whose input goes non-positive after the rebase, or that would exceed
 * the model's ceiling, is dropped: a 128K window cannot also reserve a 128K
 * answer.
 */
export function windowCandidates(model: string, outputTokens: number): ModelWindowTier[] {
  const ceiling = realInputCeiling(model);
  const inputs = new Set<number>();
  for (const tier of MODEL_WINDOW_TIERS) {
    const input = windowTierTotal(tier) - outputTokens;
    if (input > 0 && input < ceiling) {
      inputs.add(input);
    }
  }
  return [...inputs]
    .sort((a, b) => a - b)
    .map((input) => customWindowTier(input, outputTokens));
}

/**
 * One rung from a raw INPUT budget — what 「自定义…」 produces.
 *
 * Same labelling rule as the named tiers (the total the ring will show), so a
 * typed window sits in the dropdown next to the others without a second
 * convention.
 */
export function customWindowTier(inputTokens: number, outputTokens: number): ModelWindowTier {
  return {
    id: `w${inputTokens}`,
    label: hostWindowLabel(inputTokens + outputTokens),
    maxInputTokens: inputTokens,
    maxOutputTokens: outputTokens,
  };
}

/**
 * Keep only real input budgets, ascending, with the DECLARED one included.
 *
 * The declared window must be in the set: the panel's `default` has to be a
 * member of its own `enum` — the host deletes a stored value that equals the
 * default, and a default outside the enum leaves the control showing a value
 * it cannot select.
 */
export function normalizeWindowInputs(value: unknown, declared: number): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept = new Set<number>();
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      continue;
    }
    const input = Math.floor(item);
    if (input > 0) {
      kept.add(input);
    }
  }
  if (kept.size === 0) {
    return [];
  }
  if (declared > 0) {
    kept.add(declared);
  }
  return [...kept].sort((a, b) => a - b);
}

/**
 * The effort positions a stored row offers, in TABLE order.
 *
 * `undefined` (never chosen) means every position — the behaviour every
 * existing install has. An ARRAY is taken literally, including an empty one:
 * "this gateway takes no `reasoning_effort`" is a real answer, and the only
 * way to keep the control off a row that would otherwise get it back through
 * the default.
 */
export function resolveReasoningIds(value: unknown): ThinkingEffort[] {
  if (!Array.isArray(value)) {
    return [...THINKING_EFFORTS];
  }
  return THINKING_EFFORTS.filter((effort) => value.includes(effort));
}

/**
 * The position the panel pre-selects: the stored pick when it is still
 * offered, else the shared default when offered, else the first one. A
 * non-member would be ignored by the host silently.
 */
export function resolveDefaultThinking(
  value: unknown,
  allowed: readonly ThinkingEffort[]
): ThinkingEffort | undefined {
  if (allowed.length === 0) {
    return undefined;
  }
  const wanted = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const member = allowed.find((effort) => effort === wanted);
  if (member) {
    return member;
  }
  return allowed.includes(DEFAULT_THINKING_EFFORT) ? DEFAULT_THINKING_EFFORT : allowed[0];
}

/** Limits of one profile, resolved through the preset chain. */
export function resolveProfileEntry(profile: Profile): ModelEntry {
  const preset = detectModelPreset(profile.model);
  const maxOutputTokens =
    profile.maxOutputTokens > 0
      ? profile.maxOutputTokens
      : preset?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  // A hand-set value is kept verbatim; otherwise the model's real window is
  // declared as-is. Both harnesses read this one number — a rung set only
  // changes what the panel may switch TO, never what the row declares.
  const maxInputTokens =
    profile.maxInputTokens > 0 ? profile.maxInputTokens : realInputCeiling(profile.model);
  const reasoningEfforts = resolveReasoningIds(profile.reasoningIds);
  const windowInputs = normalizeWindowInputs(profile.windowInputs, maxInputTokens);
  return {
    id: profile.model,
    maxInputTokens,
    maxOutputTokens,
    reasoning: preset?.reasoning ?? false,
    ...(preset ? { presetLabel: preset.label } : {}),
    reasoningEfforts,
    ...(reasoningEfforts.length > 0
      ? { defaultThinkingEffort: resolveDefaultThinking(profile.defaultThinkingEffort, reasoningEfforts) }
      : {}),
    // ONE rung is the declaration restated — a one-item dropdown would claim
    // otherwise, so the control is only carried when there is a choice.
    ...(windowInputs.length > 1
      ? {
          contextTiers: windowInputs.map((input) => ({
            id: `w${input}`,
            label: hostWindowLabel(input + maxOutputTokens),
            maxInputTokens: input,
            maxOutputTokens,
          })),
        }
      : {}),
  };
}

/** SecretStorage key holding one profile's API key. */
export function apiKeySecretKey(profileKey: string): string {
  return `customModel.apiKey.${profileKey}`;
}

/** The API key of ONE profile; empty = that profile is not configured. */
export async function readProfileApiKey(
  context: vscode.ExtensionContext,
  profile: Profile
): Promise<string> {
  return (await context.secrets.get(apiKeySecretKey(profile.key)))?.trim() ?? '';
}

/** Store (or clear) one profile's API key in SecretStorage. */
export async function writeProfileApiKey(
  context: vscode.ExtensionContext,
  profileKey: string,
  value: string
): Promise<void> {
  const key = apiKeySecretKey(profileKey);
  const trimmed = value.trim();
  if (trimmed) {
    await context.secrets.store(key, trimmed);
  } else {
    await context.secrets.delete(key);
  }
}

/**
 * Rough token figure for a label: 96000 → `94K`, 65536 → `64K`,
 * 1048576 → `1M`. The M step matters — "1024K" is not what anyone picks a
 * window by, and the summary lines that print an output ceiling use this.
 *
 * Binary on purpose: the figures this labels ARE binary (65536 is 64K).
 */
export function tokenWindowLabel(tokens: number): string {
  return tokens >= 1048576 ? `${Math.round(tokens / 1048576)}M` : `${Math.round(tokens / 1024)}K`;
}

/**
 * Label for a SUMMARIZED figure, in the vendor's decimal notation:
 * 200000 → `200K`, 128000 → `128K`, 1048576 → `1M`.
 *
 * Not {@link tokenWindowLabel}: preset ceilings are quoted in decimal (a
 * 200K window), and dividing them by 1024 prints 195K — a number that
 * matches nothing the user has read anywhere.
 */
export function summaryWindowLabel(tokens: number): string {
  return tokens >= 1000000 ? `${Math.round(tokens / 1000000)}M` : `${Math.round(tokens / 1000)}K`;
}



// --- Fixed behavior (no settings — behavior lives in code, not options) ---------

/**
 * `max_tokens` cap for Copilot helper requests (chat titles, commit messages,
 * todo tracking…): a helper answers in a sentence, and without the cap it
 * would generate up to the model's full output ceiling on every title.
 */
export const UTILITY_MAX_OUTPUT_TOKENS = 2048;

export type ThinkingDisableStyle = 'none' | 'thinking-disabled' | 'chat_template_kwargs' | 'enable_thinking' | 'openai';

/**
 * Fixed at `none`: helper requests are NOT asked to stop thinking. There is
 * no cross-vendor spelling for "do not think", and sending a parameter the
 * gateway does not know costs a wasted round-trip (the 400-retry ladder then
 * strips it anyway).
 */
export const THINKING_DISABLE_STYLE: ThinkingDisableStyle = 'none';

/**
 * One position of the THINKING-EFFORT gear — the dropdown the model picker
 * renders in its configuration panel.
 *
 * TWO harnesses read this dropdown, and they do NOT read it the same way:
 *
 *   - VS Code's own picker renders `configurationSchema` (group `navigation`);
 *   - Copilot's harness ignores that schema and builds its own dropdown from
 *     the TOP-LEVEL `supportsReasoningEffort` / `defaultReasoningEffort`
 *     fields — and it labels every entry through a FIXED table
 *     (`none / minimal / low / medium / high / xhigh / max`). A value outside
 *     that table is DROPPED silently, which is how this extension ended up
 *     showing five positions in one window and four in the other.
 *
 * So the ids ARE the host's words, and both windows then show the same list.
 * `none` is the position that sends NOTHING: an arbitrary OpenAI-compatible
 * gateway has no single spelling for "how hard to think" — or even for "do not
 * think" (see {@link THINKING_DISABLE_STYLE}) — so that position lets the
 * gateway's own rule stand. `low` / `medium` / `high` go out verbatim as
 * `reasoning_effort`; `high` is the default. A gateway that rejects the
 * parameter has it removed by the 400 ladder (`reasoning_effort` is already
 * one of the optional body params) instead of failing the request.
 *
 * Localised wording lives in the panel's `enumItemLabels` (which only VS Code's
 * picker reads) — NEVER in the id, because the id is what Copilot filters on.
 *
 * Deliberate trade-off: `reasoning_effort: "none"` is no longer ever sent. One
 * of the four visible positions had to carry "send nothing" (the host has no
 * word for it), and putting it on `none` is the only mapping where the label
 * still tells the truth. A gateway that needs the literal value to stop
 * thinking is better served by `low`.
 */
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high';

/** Gear positions in dropdown order, from no parameter to highest effort. */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['none', 'low', 'medium', 'high'];

/** Position applied when the host sends no (or an unknown) choice. */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

/**
 * The RETIRED id of the no-parameter position: builds before the rungs were
 * named after the host's words offered `auto`. VS Code keeps the value it
 * stored, so `auto` has to keep meaning "send nothing" rather than degrading
 * to whatever the default happens to be.
 */
const RETIRED_NO_PARAM_EFFORT = 'auto';

/**
 * Narrow a gear value: an unknown id (a stale stored value, an older host, a
 * position this row does not offer) falls back to the row's default instead of
 * failing the request.
 *
 * `allowed` is the ROW's rung set (see {@link resolveReasoningIds}): a value
 * the row does not declare must not be sent, because the panel never offered
 * it and the label the user saw could not have meant it.
 */
export function resolveThinkingEffort(
  value: string | undefined,
  allowed: readonly ThinkingEffort[] = THINKING_EFFORTS
): ThinkingEffort {
  if (allowed.length === 0) {
    return 'none';
  }
  const normalized = value?.trim().toLowerCase();
  if (normalized === RETIRED_NO_PARAM_EFFORT) {
    return allowed.includes('none') ? 'none' : allowed[0];
  }
  const member = allowed.find((effort) => effort === normalized);
  return member ?? (allowed.includes(DEFAULT_THINKING_EFFORT) ? DEFAULT_THINKING_EFFORT : allowed[0]);
}

/**
 * The `reasoning_effort` value for the wire, or `undefined` for the position
 * that asks for nothing.
 */
export function thinkingEffortParam(effort: ThinkingEffort): string | undefined {
  return effort === 'none' ? undefined : effort;
}
