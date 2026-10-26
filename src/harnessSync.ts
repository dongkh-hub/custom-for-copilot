/**
 * "Re-sync to Copilot" — one pass that repairs everything the HOST remembers
 * about our models.
 *
 * The provider itself needs no syncing: `registerLanguageModelChatProvider` is a
 * live query, so both harnesses (VS Code's own picker and Copilot/agent host)
 * ask again every time they open a model list. What goes stale is the state
 * they keep ON TOP of that list, and none of it is refreshed by announcing a
 * model change alone:
 *
 *  1. `extensions.supportAgentsWindow` — an allow-list keyed by
 *     `publisher.name`. The host only ever ADDS to it, so every rename of this
 *     extension leaves the previous id behind, forever. A dead key is harmless
 *     but looks exactly like "this install is still allowed", which is how a
 *     renamed build ends up invisible in the Agents window.
 *  2. `chat.defaultModel` / `chat.utilityModel` / `chat.utilitySmallModel` —
 *     slots naming a picker id that no group provides any more; they make every
 *     helper request fail with "No model matched … override". hostDefaults owns
 *     the repair, this command just runs it on demand.
 *  3. `chatLanguageModels.json` — the host's per-model settings (thinking level,
 *     window…), keyed by model id and kept FOREVER, per vendor. Deleting a group
 *     leaves its entries behind: they cannot resolve, and they are invisible
 *     outside that file.
 *
 * (3) is the only one with no API. It is a user-level file the host owns, so it
 * is rewritten ONLY on this explicit command, ONLY for entries that cannot
 * resolve to a configured group, and ONLY when the text really changed (temp
 * file + rename, so a crash cannot leave half a file). The host keeps its own
 * in-memory copy and may write it back later — our pruning is then simply lost,
 * which is cosmetic, never data loss.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MODEL_PROVIDER_VENDOR, encodePickerId } from './config';
import { readProfiles } from './profileStore';
import { applyAgentWindowDefaults } from './agentWindow';
import { defaultChatUtilitySettingsToOwnModel } from './hostDefaults';
import { notifyProviderChanged } from './provider';

/** One `vendor` group of the host's per-model settings file. */
export interface ModelSettingsGroup {
  name?: string;
  vendor?: string;
  settings?: Record<string, unknown>;
}

const MODEL_SETTINGS_FILE = 'chatLanguageModels.json';
const EXTENSIONS_SECTION = 'extensions';
const AGENTS_ALLOW_LIST_KEY = 'supportAgentsWindow';
/**
 * Every `name` this extension has ever shipped under. Only these are pruned:
 * the allow-list is shared with every other extension, so the rule has to be
 * "an id whose name half is one of ours", never "anything that looks similar".
 */
const OWN_EXTENSION_NAMES = ['custom-for-copilot', 'custom-for-copilot-chat'];

/**
 * Drop allow-list entries that name a PREVIOUS id of this extension.
 *
 * `currentId` (and its case variants) always survives — the caller re-adds it
 * through applyAgentWindowDefaults right after.
 */
export function pruneAllowList(
  entries: Record<string, boolean>,
  currentId: string
): { next: Record<string, boolean>; removed: string[] } {
  const keep = currentId.toLowerCase();
  const next: Record<string, boolean> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const lower = key.toLowerCase();
    const dot = lower.indexOf('.');
    const name = dot >= 0 ? lower.slice(dot + 1) : lower;
    if (lower !== keep && OWN_EXTENSION_NAMES.includes(name)) {
      removed.push(key);
    } else {
      next[key] = value;
    }
  }
  return { next, removed };
}

/**
 * Drop per-model settings that cannot resolve to a configured group.
 *
 * The two shapes in the file, both seen on this machine:
 *
 *   { vendor: "custommodel", settings: { "pmw3knhmdkydk::kimi-k3.1-pro": … } }
 *   { vendor: "agent-host-copilotcli",
 *     settings: { "custommodel/pmw3…::kimi-k2.6": … } }
 *
 * A group whose vendor IS our provider only ever holds our models, so every key
 * there is judged. Any other vendor's group may hold unrelated models
 * (`copilot/…`, `customendpoint/…`), so only keys carrying our `custommodel/`
 * prefix are touched.
 */
export function pruneModelSettings(
  groups: ModelSettingsGroup[],
  livePickerIds: ReadonlySet<string>
): { next: ModelSettingsGroup[]; removed: string[] } {
  const live = new Set([...livePickerIds].map((id) => id.toLowerCase()));
  const removed: string[] = [];
  const next = groups.map((group) => {
    const vendor = (group.vendor ?? '').toLowerCase();
    const settings = group.settings;
    if (!settings || typeof settings !== 'object') {
      return group;
    }
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings)) {
      const lower = key.toLowerCase();
      const prefixed = lower.startsWith(`${MODEL_PROVIDER_VENDOR}/`);
      const bare = prefixed ? lower.slice(MODEL_PROVIDER_VENDOR.length + 1) : lower;
      const ours = vendor === MODEL_PROVIDER_VENDOR || prefixed;
      if (ours && !live.has(bare)) {
        removed.push(`${group.vendor ?? '?'}: ${key}`);
        continue;
      }
      kept[key] = value;
    }
    return { ...group, settings: kept };
  });
  return { next, removed };
}

/** Picker ids every configured group currently provides. */
function livePickerIds(): Set<string> {
  return new Set(readProfiles().map((profile) => encodePickerId(profile.key, profile.model)));
}

/**
 * `<userDataDir>/chatLanguageModels.json`, derived from the one directory this
 * extension is given (`globalStorageUri` = `<userDataDir>/globalStorage/<id>`).
 */
function modelSettingsPath(storageUri: vscode.Uri | undefined): string | undefined {
  return storageUri
    ? path.join(path.dirname(path.dirname(storageUri.fsPath)), MODEL_SETTINGS_FILE)
    : undefined;
}

/** Prune (1). Returns the removed keys. */
async function pruneAgentsAllowList(currentId: string): Promise<string[]> {
  const config = vscode.workspace.getConfiguration(EXTENSIONS_SECTION);
  const current = config.inspect<Record<string, boolean>>(AGENTS_ALLOW_LIST_KEY);
  // A registered object setting carries `{}` as its manifest default; an
  // unknown key inspects without one — writing it would leave an orphan entry.
  if (typeof current?.defaultValue !== 'object' || current.defaultValue === null) {
    return [];
  }
  const stored = current.globalValue;
  if (!stored || typeof stored !== 'object') {
    return [];
  }
  const { next, removed } = pruneAllowList(stored, currentId);
  if (removed.length === 0) {
    return [];
  }
  try {
    await config.update(AGENTS_ALLOW_LIST_KEY, next, vscode.ConfigurationTarget.Global);
    return removed;
  } catch {
    return [];
  }
}

/** Prune (3). Returns the removed entries. */
function pruneModelSettingsFile(
  storageUri: vscode.Uri | undefined,
  live: ReadonlySet<string>
): string[] {
  const file = modelSettingsPath(storageUri);
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const { next, removed } = pruneModelSettings(parsed as ModelSettingsGroup[], live);
    if (removed.length === 0) {
      return [];
    }
    const text = `${JSON.stringify(next, null, '\t')}\n`;
    if (text === raw) {
      return [];
    }
    // Temp + rename: a crash mid-write leaves the original intact.
    const temp = `${file}.customModel.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
    return removed;
  } catch {
    return [];
  }
}

/**
 * Run every repair pass and report what it found.
 *
 * Deliberately explicit (a command, not something that runs on activation):
 * step (3) writes a file the host owns, and silence is the right default for
 * state that is merely cosmetic.
 */
export async function syncToCopilot(context: vscode.ExtensionContext): Promise<void> {
  const live = livePickerIds();
  // 1) Let both harnesses know the catalog may have changed.
  notifyProviderChanged();
  // 2) Point the host's own slots at a model that exists (no-op when the user
  //    already chose one, or when nothing is configured).
  await defaultChatUtilitySettingsToOwnModel();
  // 3) Allow-list: drop previous ids, then make sure THIS install is on it.
  const prunedKeys = await pruneAgentsAllowList(context.extension.id);
  await applyAgentWindowDefaults(context.extension.id);
  // 4) Per-model settings. Skipped when nothing is configured: with no group to
  //    judge against, "cannot resolve" would mean "delete everything".
  const prunedSettings = live.size > 0 ? pruneModelSettingsFile(context.globalStorageUri, live) : [];

  const message =
    live.size === 0
      ? vscode.l10n.t(
          'Re-synced to Copilot — no model configured yet, so only the Agents-window allow-list was cleaned ({0} key(s)).',
          String(prunedKeys.length)
        )
      : vscode.l10n.t(
          'Re-synced to Copilot — {0} model(s) announced, {1} stale allow-list key(s) and {2} stale model-setting entry(ies) removed.',
          String(live.size),
          String(prunedKeys.length),
          String(prunedSettings.length)
        );
  void vscode.window.showInformationMessage(message);
}
