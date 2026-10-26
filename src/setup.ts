/**
 * The setup wizard: add ONE model profile, then hand the keyboard to Copilot
 * Chat. Also the one-time activation hint that leads a fresh install into the
 * wizard.
 *
 * A profile = endpoint + display alias + REAL model id + API key. Several
 * profiles coexist, each showing up in the picker under its own alias — that
 * is what makes "two gateways" or "same gateway, two keys" usable.
 *
 * The ONE model-management entry point is the `customModel.manageModels`
 * command — the `customModel.modelList` setting's description link and the
 * command palette both land there. Empty list → straight into the add wizard.
 * Otherwise it opens a read-only inventory of every group (the settings
 * mirror's rows), where picking a group offers update model ID / copy model
 * ID / remove, and the LAST row is always "add", so new groups are appended,
 * never spliced in. Host defaults written at the end are fill-only, so a save
 * never disturbs a slot the user chose themselves.
 */
import * as vscode from 'vscode';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_EFFORT,
  MODEL_WINDOW_TIERS,
  STATE_KEYS,
  THINKING_EFFORTS,
  customWindowTier,
  detectModelPreset,
  hostWindowLabel,
  newProfileKey,
  normalizeBaseURL,
  profileHasCredentials,
  readProfileApiKey,
  resolveProfileEntry,
  summaryInputTokens,
  summaryWindowLabel,
  tokenWindowLabel,
  windowCandidates,
  writeProfileApiKey,
  type ModelWindowTier,
  type Profile,
  type ThinkingEffort,
} from './config';
import { readProfiles, removeProfile, upsertProfile } from './profileStore';
import {
  isCopilotChatAvailable,
  openCopilotChatExtension,
  waitUntilCopilotChatAvailable,
} from './copilotChat';
import { effortDescription, effortLabel, notifyProviderChanged } from './provider';
import { defaultChatUtilitySettingsToOwnModel } from './hostDefaults';

/**
 * Reveal the Copilot Chat view and put keyboard focus into its input box, so
 * the user can start typing right after the setup wizard finishes.
 *
 * Two commands on purpose: `chat.open` reveals the view, and only
 * `chat.focusInput` puts the caret in its input box (opening the view can
 * leave focus on the view container or on the last focused editor).
 *
 * If either command is unavailable in a future/older build this fails
 * silently; setup itself has already succeeded.
 */
async function focusChatInput(): Promise<void> {
  for (const command of ['workbench.action.chat.open', 'workbench.action.chat.focusInput']) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      // Non-fatal: the chat view may be unavailable (e.g. chat setup hidden).
    }
  }
}

/** `host` of an endpoint, or the URL itself when it does not parse. */
function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}

/**
 * A base URL this provider can actually POST to: an http(s) scheme and a
 * host. Catching it here is the only place a typo can still be corrected —
 * once stored, a scheme-less URL fails inside `fetch` with an opaque error on
 * every message.
 */
function isUsableBaseURL(baseURL: string): boolean {
  try {
    const parsed = new URL(baseURL);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Limits half of a summary: `Beta V4 (1M/128K)` for a known preset, otherwise
 * `default 1M/128K`.
 */
function entryLimitsLabel(profile: Profile): string {
  const entry = resolveProfileEntry(profile);
  // The model's real ceiling — a preset label like "Beta V4 (1M/128K)"
  // describes what the model can do.
  const limits = `${summaryWindowLabel(summaryInputTokens(profile))}/${tokenWindowLabel(entry.maxOutputTokens)}`;
  return entry.presetLabel ?? vscode.l10n.t('default {0}', limits);
}

/**
 * One line of the post-save summary, e.g.
 * `my-gateway → Beta V4 (1M/128K)` or `my-model → default 1M/128K`.
 */
function entrySummaryLine(profile: Profile): string {
  return `${profile.name || profile.model} → ${entryLimitsLabel(profile)}`;
}

/**
 * Remove ONE profile (its SecretStorage key included). Two taps: the manager's
 * remove action, then a modal confirmation — deleting a credential by accident
 * is not recoverable. Returns whether the row was actually removed.
 */
async function confirmAndRemoveProfile(
  context: vscode.ExtensionContext,
  profile: Profile
): Promise<boolean> {
  const label = profile.name || profile.model;
  const remove = vscode.l10n.t('Remove');
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t('Remove "{0}"? Its API key is deleted too.', label),
    { modal: true },
    remove
  );
  if (confirmed !== remove) {
    return false;
  }
  await removeProfile(profile.key);
  await writeProfileApiKey(context, profile.key, '');
  notifyProviderChanged();
  // Host slots naming the removed profile are stale now; point them at the
  // first remaining one (fill-only otherwise).
  await defaultChatUtilitySettingsToOwnModel();
  void vscode.window.showInformationMessage(vscode.l10n.t('Removed {0}.', label));
  return true;
}

/**
 * Every list-editing flow needs Copilot Chat: the provider itself does not,
 * but the model picker that surfaces the groups lives there.
 */
async function ensureCopilotChat(): Promise<boolean> {
  if (isCopilotChatAvailable()) {
    return true;
  }
  const action = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'GitHub Copilot Chat is not enabled — the custom model picker lives there. Enable it first.'
    ),
    vscode.l10n.t('Open Extensions')
  );
  if (action) {
    await openCopilotChatExtension();
  }
  return false;
}

/**
 * Straight into the wizard for a NEW group — the manager's empty-list entry,
 * its trailing "add" row and the one-time setup hint's button all land here
 * (there is nothing to pick when the intent is to add).
 *
 * Returns whether a group was actually SAVED, so the manager can tell a
 * finished add (leave — the user is done managing) from a declined one
 * (return to the list).
 */
export async function addModelProfile(context: vscode.ExtensionContext): Promise<boolean> {
  if (!(await ensureCopilotChat())) {
    return false;
  }
  return modelWizard(context);
}

/** What picking a group in the manager offers. */
type ManageAction = 'update' | 'window' | 'effort' | 'duplicate' | 'remove';

/** One row of the manager list: a configured group, or the trailing "add". */
type ManageItem = vscode.QuickPickItem & { profile?: Profile; add?: boolean };

/**
 * `customModel.manageModels` — the ONE management surface (settings link +
 * command palette).
 *
 * Empty list → the add wizard directly: an empty picker has nothing to pick.
 * Otherwise the picker is a READ-ONLY inventory of every group — the same
 * facts the settings mirror shows (alias, model id, limits, ⚠ key state) —
 * and the affordances live one level down: picking a group opens the action
 * menu (update model ID / duplicate / remove), Esc there falls back to the
 * list, and a COMPLETED action closes the manager outright — the user came
 * to tend one group, and re-opening the list would only cover the toast they
 * are reading. A cancelled or failed action falls back to the list, where
 * the group can be picked again. The LAST row is always "add", pinned with
 * `alwaysShow`, so the list only ever grows by appending.
 *
 * ADDING is the one action that ENDS the visit: the wizard hands focus to
 * Copilot Chat, and re-opening the list afterwards would put the picker back
 * in front of the input the user is about to type in. A declined add (Esc
 * anywhere in the wizard) comes back here — the user never left.
 */
export async function manageModels(context: vscode.ExtensionContext): Promise<void> {
  if (readProfiles().length === 0) {
    // Nothing to inventory: the wizard IS the manager here, and a saved
    // group ends the visit. A declined one falls through to the loop, which
    // exits on the still-empty list.
    if (await addModelProfile(context)) {
      return;
    }
  }
  for (;;) {
    const profiles = readProfiles();
    if (profiles.length === 0) {
      // The wizard was declined (first entry), or the last group was just
      // removed. Re-triggering the wizard here would loop on a declined
      // intent, and an empty manager has nothing to offer.
      return;
    }
    const present = new Set<string>();
    for (const profile of profiles) {
      // Same fact the settings mirror shows: a keyless endpoint is
      // configured, not "missing a key", and gets no ⚠.
      if (profileHasCredentials(profile, await readProfileApiKey(context, profile))) {
        present.add(profile.key);
      }
    }
    const items: ManageItem[] = profiles.map((profile) => {
      const entry = resolveProfileEntry(profile);
      // Same figure the settings mirror shows (the real ceiling).
      const limits = `${summaryWindowLabel(summaryInputTokens(profile))}/${tokenWindowLabel(entry.maxOutputTokens)}`;
      return {
        label: profile.name || profile.model,
        description: `${profile.model} · ${limits}`,
        detail:
          hostOf(profile.baseURL) +
          (present.has(profile.key) ? '' : ` · ⚠ ${vscode.l10n.t('no API key')}`),
        profile,
      };
    });
    items.push({ label: vscode.l10n.t('$(add) Add model…'), alwaysShow: true, add: true });
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Manage models'),
      placeHolder: vscode.l10n.t('Pick a group to manage, or add a new one'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    if (picked.add || !picked.profile) {
      if (picked.add) {
        // A SAVED group ends the visit: the wizard already handed focus to
        // Copilot Chat, and re-opening the list would only put the picker
        // back in front of the input the user is about to type in. A
        // DECLINED add (Esc anywhere in the wizard) returns to the list —
        // the user never left, so there is nothing to conclude.
        if (await addModelProfile(context)) {
          return;
        }
      }
      continue;
    }
    const action = await pickManageAction(picked.profile);
    if (!action) {
      continue; // Esc at the action menu → back to the list
    }
    let done: boolean;
    if (action === 'update') {
      done = await updateModelIdFlow(picked.profile);
    } else if (action === 'window') {
      done = await editWindowFlow(picked.profile);
    } else if (action === 'effort') {
      done = await editEffortFlow(picked.profile);
    } else if (action === 'duplicate') {
      done = await duplicateModelFlow(context, picked.profile);
    } else {
      done = await confirmAndRemoveProfile(context, picked.profile);
    }
    if (done) {
      // A COMPLETED action ends the visit: the change is stored and its toast
      // is up — re-opening the list would only cover it. A cancelled or
      // failed one loops back to the list instead.
      return;
    }
  }
}

/**
 * The manager's second screen: what to do with the picked group. Esc returns
 * `undefined` and the caller re-opens the list.
 */
async function pickManageAction(profile: Profile): Promise<ManageAction | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: vscode.l10n.t('$(edit) Update model ID…'),
        description: vscode.l10n.t('The endpoint, alias and API key are kept.'),
        value: 'update' as const,
      },
      {
        label: vscode.l10n.t('$(symbol-ruler) Context window…'),
        description: windowDetail(profile),
        detail: vscode.l10n.t(
          'Tick the windows this model may be used at, then the one it declares.'
        ),
        value: 'window' as const,
      },
      {
        label: vscode.l10n.t('$(lightbulb) Effort levels…'),
        description: effortDetail(profile),
        detail: vscode.l10n.t(
          'Tick the positions this gateway accepts, then the one it defaults to.'
        ),
        value: 'effort' as const,
      },
      {
        label: vscode.l10n.t('$(copy) Duplicate model…'),
        description: vscode.l10n.t(
          'The base URL and API key are copied; the alias and model ID are new.'
        ),
        value: 'duplicate' as const,
      },
      {
        label: vscode.l10n.t('$(trash) Remove model…'),
        description: vscode.l10n.t('Its API key is deleted too.'),
        value: 'remove' as const,
      },
    ],
    {
      title: profile.name || profile.model,
      placeHolder: vscode.l10n.t('Pick an action'),
    }
  );
  return picked?.value;
}

// --- Rung pickers: what a row may be used at, and what it declares ------------
//
// Two dimensions, one shape: tick the rungs the model may be used at, then pick
// the one it DECLARES. The declaration is what a harness without the model
// panel applies, so it can never be implied by the ticks alone — and the panel
// default has to equal it (the host drops a stored value equal to the default).

/** The windows picked for one row. */
interface WindowPicked {
  /** Input budgets offered, ascending. Empty = one window, no control. */
  readonly inputs: number[];
  /** The rung the row DECLARES (0 = let the preset chain decide). */
  readonly declared: number;
}

/** The effort positions picked for one row. */
interface EffortPicked {
  /** Empty = this gateway takes no `reasoning_effort` at all. */
  readonly ids: ThinkingEffort[];
  readonly defaultId?: ThinkingEffort;
}

/** One selectable rung. */
interface RungItem<T> extends vscode.QuickPickItem {
  readonly value: T;
}

/**
 * Multi-select rung picker.
 *
 * `createQuickPick` (not `showQuickPick`) because pre-checking the current set
 * needs the handle. `onDidAccept` fires before the closing `onDidHide`, so an
 * accept wins over the dismiss; Esc resolves `undefined` and the caller treats
 * it as "no change".
 */
async function pickRungs<T>(
  items: RungItem<T>[],
  title: string,
  placeHolder: string,
  preselected: readonly RungItem<T>[]
): Promise<T[] | undefined> {
  const quickPick = vscode.window.createQuickPick<RungItem<T>>();
  quickPick.items = items;
  quickPick.canSelectMany = true;
  quickPick.title = title;
  quickPick.placeholder = placeHolder;
  quickPick.ignoreFocusOut = true;
  quickPick.selectedItems = items.filter((item) => preselected.includes(item));
  quickPick.show();
  const picked = await new Promise<RungItem<T>[] | undefined>((resolve) => {
    quickPick.onDidAccept(() => resolve([...quickPick.selectedItems]));
    quickPick.onDidHide(() => resolve(undefined));
  });
  quickPick.dispose();
  return picked?.map((item) => item.value);
}

/** Single-select rung picker (the "which one is the default" step). */
async function pickRung<T>(
  items: RungItem<T>[],
  title: string,
  placeHolder: string,
  active: RungItem<T> | undefined
): Promise<T | undefined> {
  const quickPick = vscode.window.createQuickPick<RungItem<T>>();
  quickPick.items = items;
  quickPick.canSelectMany = false;
  quickPick.title = title;
  quickPick.placeholder = placeHolder;
  quickPick.ignoreFocusOut = true;
  quickPick.activeItems = active ? [active] : [];
  quickPick.show();
  const picked = await new Promise<RungItem<T>[] | undefined>((resolve) => {
    quickPick.onDidAccept(() => resolve([...quickPick.activeItems]));
    quickPick.onDidHide(() => resolve(undefined));
  });
  quickPick.dispose();
  return picked?.[0]?.value;
}

/** The multi-select sentinel of the「自定义…」row (real budgets are > 0). */
const CUSTOM_WINDOW = -1;

/**
 * Ask which WINDOWS the row may be used at, then which one it declares.
 *
 * The list is the NAMED windows rebased onto this row's answer reserve (see
 * `windowCandidates`) plus the rungs the row already carries, so an edit never
 * silently drops a budget that was typed in earlier. Anything else is the
 * 「自定义…」 row: one raw input budget, labelled by the total the ring will
 * show — the same rule as the named rungs, and the reason the list carries no
 * ceiling-derived entry like `1.1M` for a 1M model.
 *
 * The declared window is the row's `maxInputTokens`, so the pre-selection is
 * the rung it already declares; a NEW row starts on the largest named window,
 * i.e. the one that fills the model as far as its answer reserve allows.
 *
 * Unticking everything is a valid answer: one window, no control. Esc is not.
 */
async function pickWindowTiers(
  model: string,
  outputTokens: number,
  prefill?: { inputs?: readonly number[]; declared?: number }
): Promise<WindowPicked | undefined> {
  const known = new Map<number, ModelWindowTier>();
  for (const tier of windowCandidates(model, outputTokens)) {
    known.set(tier.maxInputTokens, tier);
  }
  for (const input of prefill?.inputs ?? []) {
    if (!known.has(input)) {
      known.set(input, customWindowTier(input, outputTokens));
    }
  }
  const tiers = [...known.values()].sort((a, b) => a.maxInputTokens - b.maxInputTokens);
  const checked = new Set<number>(
    prefill?.inputs ??
      [prefill?.declared ?? tiers[tiers.length - 1]?.maxInputTokens].filter(
        (input): input is number => typeof input === 'number' && input > 0
      )
  );
  const label = (input: number): string =>
    known.get(input)?.label ?? hostWindowLabel(input + outputTokens);
  const rungDescription = (input: number): string =>
    vscode.l10n.t(
      'declares {0} input tokens · {1} reserved for the answer',
      String(input),
      String(outputTokens)
    );
  const items: RungItem<number>[] = tiers.map((tier) => ({
    label: tier.label,
    description: rungDescription(tier.maxInputTokens),
    value: tier.maxInputTokens,
  }));
  items.push({
    label: vscode.l10n.t('Custom…'),
    description: vscode.l10n.t('Type an input budget in tokens'),
    value: CUSTOM_WINDOW,
  });
  const picked = await pickRungs(
    items,
    vscode.l10n.t('Context window — which windows may this model be used at?'),
    vscode.l10n.t('Tick the windows to offer in the model panel — none = one window only'),
    items.filter((item) => checked.has(item.value))
  );
  if (!picked) {
    return undefined;
  }
  const inputs = new Set<number>(picked.filter((value) => value > 0));
  if (picked.includes(CUSTOM_WINDOW)) {
    const typed = await promptForCustomWindow(outputTokens, prefill?.declared);
    if (typed === undefined) {
      return undefined;
    }
    inputs.add(typed);
  }
  if (inputs.size === 0) {
    return { inputs: [], declared: prefill?.declared ?? 0 };
  }
  const budgets = [...inputs].sort((a, b) => a - b);
  if (budgets.length === 1) {
    return { inputs: budgets, declared: budgets[0] };
  }
  const wanted = prefill?.declared;
  const defaultItems: RungItem<number>[] = budgets.map((input) => ({
    label: label(input),
    description: rungDescription(input),
    value: input,
  }));
  const active = defaultItems.find((item) => item.value === wanted) ?? defaultItems[defaultItems.length - 1];
  const declared = await pickRung(
    defaultItems,
    vscode.l10n.t('Context window — which one does the model declare?'),
    vscode.l10n.t('The declared window is what Copilot sizes the session against'),
    active
  );
  if (declared === undefined) {
    return undefined;
  }
  return { inputs: budgets, declared };
}

/**
 * The 「自定义…」 box: one raw INPUT budget.
 *
 * The prompt states the total the ring will show for what is being typed, so
 * the number on the panel never comes as a surprise — the label is the total,
 * and the total is input + the row's answer reserve.
 */
async function promptForCustomWindow(
  outputTokens: number,
  declared?: number
): Promise<number | undefined> {
  const typed = await vscode.window.showInputBox({
    title: vscode.l10n.t('Custom context window — input budget'),
    value: declared && declared > 0 ? String(declared) : '',
    placeHolder: String(MODEL_WINDOW_TIERS[MODEL_WINDOW_TIERS.length - 1].maxInputTokens),
    ignoreFocusOut: true,
    prompt: vscode.l10n.t(
      'Prompt budget in tokens. The context ring will show this plus the {0} reserved for the answer.',
      String(outputTokens)
    ),
    validateInput: (value) => {
      const tokens = Number(value);
      if (!Number.isInteger(tokens) || tokens <= 0) {
        return vscode.l10n.t('Whole tokens only — a positive number.');
      }
      return undefined;
    },
  });
  if (typed === undefined) {
    return undefined;
  }
  const tokens = Number(typed);
  return Number.isInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/**
 * Ask which EFFORT positions the row offers, then which one it pre-selects.
 *
 * Same reason for two steps as the window: the panel's dropdown lists what the
 * row declares, and the pre-selected position is what a request uses before
 * anyone touches it. Every id stays a word both hosts can label (see
 * THINKING_EFFORTS).
 *
 * Nothing ticked is a real answer — the gateway rejects `reasoning_effort`, so
 * the row offers no control at all.
 */
async function pickEffortTiers(prefill?: {
  ids?: readonly ThinkingEffort[];
  defaultId?: ThinkingEffort;
}): Promise<EffortPicked | undefined> {
  const checked = new Set<ThinkingEffort>(prefill?.ids ?? THINKING_EFFORTS);
  const items: RungItem<ThinkingEffort>[] = THINKING_EFFORTS.map((effort) => ({
    label: effortLabel(effort),
    description: effortDescription(effort),
    value: effort,
  }));
  const picked = await pickRungs(
    items,
    vscode.l10n.t('Effort levels — which positions does this gateway accept?'),
    vscode.l10n.t(
      'Tick the positions to offer in the model panel — none = never send reasoning_effort'
    ),
    items.filter((item) => checked.has(item.value))
  );
  if (!picked) {
    return undefined;
  }
  if (picked.length === 0) {
    return { ids: [] };
  }
  // Table order, not click order: the dropdown has to read like every other
  // row's.
  const ids = THINKING_EFFORTS.filter((effort) => picked.includes(effort));
  if (ids.length === 1) {
    return { ids, defaultId: ids[0] };
  }
  const wanted = prefill?.defaultId ?? DEFAULT_THINKING_EFFORT;
  const activeId = ids.includes(wanted) ? wanted : ids[ids.length - 1];
  const active = items.find((item) => item.value === activeId);
  const chosen = await pickRung(
    items.filter((item) => ids.includes(item.value)),
    vscode.l10n.t('Effort levels — which one is the default?'),
    vscode.l10n.t('A request with no pick from the panel sends this position'),
    active
  );
  if (!chosen) {
    return undefined;
  }
  return { ids, defaultId: chosen };
}

/** Persist one row's rung sets and tell the host to re-query the picker. */
async function persistTiers(
  profile: Profile,
  patch: Partial<
    Pick<Profile, 'maxInputTokens' | 'windowInputs' | 'reasoningIds' | 'defaultThinkingEffort'>
  >,
  message: string
): Promise<void> {
  // A field set to `undefined` is DROPPED by the stored JSON, which is exactly
  // how a retracted rung set goes back to "one window" / "every position".
  await upsertProfile({ ...profile, ...patch });
  notifyProviderChanged();
  void vscode.window.showInformationMessage(message);
}

/** `修改上下文窗口`: same two-step picker, on an existing row. */
async function editWindowFlow(profile: Profile): Promise<boolean> {
  const entry = resolveProfileEntry(profile);
  const picked = await pickWindowTiers(profile.model, entry.maxOutputTokens, {
    inputs: profile.windowInputs ?? [entry.maxInputTokens],
    declared: entry.maxInputTokens,
  });
  if (!picked) {
    return false;
  }
  const label = profile.name || profile.model;
  // Labels are TOTALS (input + the row's answer reserve) — the same arithmetic
  // the panel and the context ring use, never the raw input budget.
  const total = (input: number): string => hostWindowLabel(input + entry.maxOutputTokens);
  await persistTiers(
    profile,
    {
      maxInputTokens: picked.declared,
      windowInputs: picked.inputs.length > 1 ? picked.inputs : undefined,
    },
    picked.inputs.length > 1
      ? vscode.l10n.t(
          '{0}: windows {1}, declaring {2}.',
          label,
          picked.inputs.map(total).join(' / '),
          total(picked.declared)
        )
      : vscode.l10n.t('{0}: one window ({1}).', label, total(picked.declared))
  );
  return true;
}

/** `修改思考档位`: same two-step picker, on an existing row. */
async function editEffortFlow(profile: Profile): Promise<boolean> {
  const entry = resolveProfileEntry(profile);
  const picked = await pickEffortTiers({
    ids: entry.reasoningEfforts,
    defaultId: entry.defaultThinkingEffort,
  });
  if (!picked) {
    return false;
  }
  const label = profile.name || profile.model;
  await persistTiers(
    profile,
    {
      reasoningIds: picked.ids,
      defaultThinkingEffort: picked.defaultId,
    },
    picked.ids.length
      ? vscode.l10n.t(
          '{0}: effort {1}, default {2}.',
          label,
          picked.ids.map((id) => effortLabel(id)).join(' / '),
          effortLabel(picked.defaultId ?? picked.ids[0])
        )
      : vscode.l10n.t('{0}: no effort control (the gateway decides).', label)
  );
  return true;
}

/** One line for the manager: the windows a row offers, or just its window. */
function windowDetail(profile: Profile): string {
  const entry = resolveProfileEntry(profile);
  return entry.contextTiers?.length
    ? entry.contextTiers.map((tier) => tier.label).join(' · ')
    : hostWindowLabel(entry.maxInputTokens + entry.maxOutputTokens);
}

/** One line for the manager: the effort positions a row offers. */
function effortDetail(profile: Profile): string {
  const efforts = resolveProfileEntry(profile).reasoningEfforts;
  return efforts.length
    ? efforts.map((effort) => effortLabel(effort)).join(' · ')
    : vscode.l10n.t('None — the gateway decides');
}

/**
 * Duplicate ONE group onto a fresh row: the base URL and the API key are
 * copied, the alias and the model ID are asked for. The case is the provider
 * whose single endpoint serves several models — cloning the group beats
 * re-running the wizard (re-pasting the same URL and key) for each model the
 * user wants in the picker, and a keyless source stays keyless (`noAuth`
 * rides along; the secret, when there is one, is copied to the NEW profile
 * key, so the two groups' keys live and die independently). The alias is
 * prefilled with the source's; the model ID starts EMPTY, because a carbon
 * copy of both would render two indistinguishable rows. The new row lands at
 * the END of the list, like every add. Explicit limits ride along, for the
 * same reason they survive an ID update: they are the user's explicit choice.
 */
async function duplicateModelFlow(
  context: vscode.ExtensionContext,
  profile: Profile
): Promise<boolean> {
  const alias = await vscode.window.showInputBox({
    title: vscode.l10n.t('Display alias — shown in the model picker'),
    value: profile.name,
    placeHolder: vscode.l10n.t('e.g. My gateway · My model'),
    ignoreFocusOut: true,
    prompt: vscode.l10n.t(
      'Leave empty to show the model id. The alias never goes into the request.'
    ),
  });
  if (alias === undefined) {
    return false;
  }
  const entered = await vscode.window.showInputBox({
    title: vscode.l10n.t('API model ID'),
    value: '',
    placeHolder: profile.model,
    ignoreFocusOut: true,
    prompt: `${vscode.l10n.t(
      'Sent as the `model` parameter in the request body; token limits are detected from the id.'
    )} ${vscode.l10n.t('The base URL and API key are copied from "{0}".', profile.name || profile.model)}`,
  });
  if (entered === undefined) {
    return false;
  }
  const model = entered.trim();
  if (model.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('A model ID is required.'));
    return false;
  }
  try {
    const key = newProfileKey();
    const clone: Profile = {
      key,
      name: alias.trim(),
      baseURL: profile.baseURL,
      model,
      ...(profile.noAuth ? { noAuth: true } : {}),
      maxInputTokens: profile.maxInputTokens,
      maxOutputTokens: profile.maxOutputTokens,
    };
    const apiKey = await readProfileApiKey(context, profile);
    if (apiKey) {
      await writeProfileApiKey(context, key, apiKey);
    }
    await upsertProfile(clone);
    notifyProviderChanged();
    // Fill-only: slots the user pointed elsewhere are never touched; an
    // appended row never invalidates an existing one.
    await defaultChatUtilitySettingsToOwnModel();
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Duplicated model group: {0}', entrySummaryLine(clone))
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Duplicating the model failed: {0}', message)
    );
    return false;
  }
}

/**
 * Change ONE group's model ID in place, leaving endpoint, alias, API key and
 * explicit limits exactly as they are.
 *
 * The use case is the provider whose URL and key are stable while the served
 * model id moves (a dated snapshot like `…-1017`, a family bump): re-running
 * the wizard would re-paste the same endpoint and key just to change one
 * string, and remove-and-readd would burn the stored key. The input is
 * PREFILLED with the current id, so a version bump is an edit, not a retyping.
 * Token limits re-detect from the new id unless the group carries explicit
 * ones (a gear choice made for the old model is still the user's explicit
 * choice, and is never silently reset).
 *
 * Returns whether the input was CONCLUDED (an ID entered — changed or
 * confirmed unchanged), so the manager can end the visit instead of
 * re-opening the list; Esc or an invalid entry falls back to it.
 */
async function updateModelIdFlow(profile: Profile): Promise<boolean> {
  const entered = await vscode.window.showInputBox({
    title: vscode.l10n.t('API model ID'),
    value: profile.model,
    ignoreFocusOut: true,
    prompt: `${vscode.l10n.t(
      'Sent as the `model` parameter in the request body; token limits are detected from the id.'
    )} ${vscode.l10n.t('The endpoint, alias and API key are kept.')}`,
  });
  if (entered === undefined) {
    return false;
  }
  const model = entered.trim();
  if (model.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('A model ID is required.'));
    return false;
  }
  if (model === profile.model) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('"{0}" already uses this model ID — nothing changed.', profile.model)
    );
    return true; // Entered and concluded — nothing more to tend here.
  }
  const next: Profile = { ...profile, model };
  try {
    await upsertProfile(next);
    // Make VS Code re-query the provider's model list — the picker id
    // (`<profileKey>::<model>`) changed with the id.
    notifyProviderChanged();
    // Host slots may name the OLD picker id; the repair is stale-only, so a
    // slot the user pointed somewhere else is never touched.
    await defaultChatUtilitySettingsToOwnModel();
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Model updated: {0} → {1} · {2}',
        profile.model,
        model,
        entryLimitsLabel(next)
      )
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Updating the model failed: {0}', message)
    );
    return false;
  }
}

/**
 * ④ API key — or an explicit "this gateway needs none".
 *
 * Self-hosted gateways are often keyless (a local inference server started
 * without an auth flag). Empty input therefore does NOT abort: it asks
 * whether the endpoint really needs no key, because the alternative readings
 * — "I forgot to paste it" and "the key is empty" — are indistinguishable from
 * the text. Answering "No key" is an explicit, stored decision
 * (`Profile.noAuth`), not an empty secret, so a gateway that DOES need a key
 * still shows its ⚠ and reports a clear error instead of silently sending
 * unauthenticated requests.
 */
async function promptApiKey(): Promise<{ apiKey: string } | undefined> {
  for (;;) {
    const entered = await vscode.window.showInputBox({
      title: vscode.l10n.t('④ API key'),
      password: true,
      ignoreFocusOut: true,
      prompt: vscode.l10n.t(
        'Stored in this machine’s SecretStorage, never in settings. Leave empty if this gateway needs no key.'
      ),
    });
    if (entered === undefined) {
      return undefined;
    }
    if (entered.trim().length > 0) {
      return { apiKey: entered.trim() };
    }
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: vscode.l10n.t('No key — this gateway does not require one'),
          description: vscode.l10n.t(
            'A self-hosted inference server started without an auth flag'
          ),
          value: 'none' as const,
        },
        {
          label: vscode.l10n.t('Enter a key'),
          description: '',
          value: 'retry' as const,
        },
      ],
      {
        title: vscode.l10n.t('This endpoint needs no API key?'),
        placeHolder: vscode.l10n.t('Pick one'),
        ignoreFocusOut: true,
      }
    );
    if (!choice) {
      return undefined;
    }
    if (choice.value === 'none') {
      return { apiKey: '' };
    }
  }
}

/**
 * ① URL ② alias ③ model id ④ API key, then persist — ONE NEW GROUP per run.
 *
 * There is deliberately no "pick an existing group to edit" here: running the
 * wizard always creates a new group; swapping just the model id of an
 * existing one is `updateModelIdFlow`'s job, and anything else still means
 * removing the group and adding it again. The key goes to SecretStorage
 * under the profile key; nothing credential-like is written into settings —
 * the only setting this extension writes is the READ-ONLY model-list mirror
 * (see modelListSetting.ts). `notifyProviderChanged()` makes VS Code re-query
 * the model list — no window reload needed.
 *
 * Returns `true` only when a group was SAVED — `false` for every abandoned
 * step (Esc, an empty required field, a failed write), so the caller can tell
 * "done" from "changed my mind".
 */
async function modelWizard(context: vscode.ExtensionContext): Promise<boolean> {
  const url = await vscode.window.showInputBox({
    title: vscode.l10n.t('① API base URL — OpenAI-compatible'),
    value: '',
    placeHolder: 'https://api.example.com/v1',
    ignoreFocusOut: true,
    prompt: vscode.l10n.t('e.g. https://api.example.com/v1'),
  });
  if (!url || url.trim().length === 0) {
    return false;
  }
  // Accept a pasted ENDPOINT too (`https://x/v1/chat/completions`): the
  // request path appends the suffix itself, so storing it verbatim would
  // double it and answer 404 — which no recovery step retries.
  const baseURL = normalizeBaseURL(url);
  if (!isUsableBaseURL(baseURL)) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The base URL must start with http:// or https:// and include a host.')
    );
    return false;
  }

  // The ALIAS is display-only. It is what the picker shows; the request body
  // still carries the model id asked for next.
  const alias = await vscode.window.showInputBox({
    title: vscode.l10n.t('② Display alias — shown in the model picker'),
    value: '',
    placeHolder: vscode.l10n.t('e.g. My gateway · My model'),
    ignoreFocusOut: true,
    prompt: vscode.l10n.t(
      'Leave empty to show the model id. The alias never goes into the request.'
    ),
  });
  if (alias === undefined) {
    return false;
  }

  const modelIdRaw = await vscode.window.showInputBox({
    title: vscode.l10n.t('③ API model ID'),
    value: '',
    placeHolder: 'my-model-v1, another-model, chat-model, reasoning-model …',
    ignoreFocusOut: true,
    prompt: vscode.l10n.t(
      'Sent as the `model` parameter in the request body; token limits are detected from the id.'
    ),
  });
  if (modelIdRaw === undefined) {
    return false;
  }
  const model = modelIdRaw.trim();
  if (model.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('A model ID is required.'));
    return false;
  }

  // Two rung steps: which windows and which effort positions this model may be
  // used at, then which one it DECLARES. The window candidates are computed
  // against the output ceiling the row is about to inherit, so the labels are
  // the totals the context ring will show. Accepting both defaults reproduces
  // the old single-window / all-positions row exactly.
  const outputTokens =
    detectModelPreset(model)?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const window = await pickWindowTiers(model, outputTokens);
  if (!window) {
    return false;
  }
  const effort = await pickEffortTiers();
  if (!effort) {
    return false;
  }

  const answer = await promptApiKey();
  if (!answer) {
    return false;
  }
  const apiKey = answer.apiKey;

  try {
    const key = newProfileKey();
    const profile: Profile = {
      key,
      name: alias.trim(),
      baseURL,
      model,
      // Only a keyless endpoint carries the flag; a keyed one must never
      // inherit it, or a later "key removed" would read as "no auth needed".
      ...(apiKey ? {} : { noAuth: true }),
      // The DECLARED window (0 = the preset chain decides) and the rungs it may
      // be switched between; a single rung is the declaration restated, so only
      // a real choice is stored.
      maxInputTokens: window.declared,
      maxOutputTokens: 0,
      ...(window.inputs.length > 1 ? { windowInputs: window.inputs } : {}),
      // The effort positions this gateway accepts (empty = none) and the one a
      // request uses before the panel is touched.
      reasoningIds: effort.ids,
      ...(effort.defaultId ? { defaultThinkingEffort: effort.defaultId } : {}),
    };
    if (apiKey) {
      await writeProfileApiKey(context, key, apiKey);
    }
    await upsertProfile(profile);
    // Make VS Code re-query the provider's model list.
    notifyProviderChanged();
    // Point VS Code's background utility flows (which otherwise fail or burn
    // Copilot quota under a BYOK main model) at the first profile. User-set
    // values are never overwritten.
    await defaultChatUtilitySettingsToOwnModel();
    // The applied limits (official preset vs default) are the one thing the
    // user cannot see in the chat input they land on — one toast, then focus.
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Model limits applied: {0}', entrySummaryLine(profile))
    );
    await focusChatInput();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Custom for Copilot setup failed: {0}', message)
    );
    return false;
  }
}

/**
 * One-time setup hint shown once Copilot Chat is available.
 *
 * Button semantics:
 *   "Add Model…" / "Skip" — both permanent: the hint never shows again.
 *   Esc / closing the notification sets NOTHING, so it returns on the next
 *   activation — that is the only "remind me later" path.
 */
export async function maybeShowSetupHint(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(STATE_KEYS.SETUP_HINT)) {
    return;
  }
  if (!(await waitUntilCopilotChatAvailable())) {
    return;
  }
  // A profile is stored — nothing to hint about (e.g. after restoring a
  // profile or reinstalling the extension).
  if (readProfiles().length > 0) {
    await context.globalState.update(STATE_KEYS.SETUP_HINT, true);
    return;
  }
  const setUp = vscode.l10n.t('Add Model…');
  const skip = vscode.l10n.t('Skip');
  const action = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Configure the API URL and key to use a custom model in Copilot Chat.'
    ),
    setUp,
    skip
  );
  if (action === setUp) {
    await context.globalState.update(STATE_KEYS.SETUP_HINT, true);
    await addModelProfile(context);
  } else if (action === skip) {
    await context.globalState.update(STATE_KEYS.SETUP_HINT, true);
  }
  // Esc / closed: set NOTHING — the hint shows again next activation.
}
