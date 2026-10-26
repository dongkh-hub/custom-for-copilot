# Custom for Copilot

**No GitHub sign-in.** BYOK models for Copilot Chat & Agent Mode — just an OpenAI-compatible URL and key.

## Quick start

1. Install and enable the extension, then **Reload Window** (requires VS Code 1.109+ with GitHub Copilot Chat installed).
2. Run **Custom Mode: Manage Models…** from the Command Palette (or click the ✨ status bar icon). On first use you go straight into the add-model wizard:
   - ① API Base URL (OpenAI-compatible, e.g. `https://api.example.com/v1`)
   - ② Display alias (the name shown in the model picker; blank = show the model ID)
   - ③ Real model ID (the `model` parameter sent to the endpoint)
   - ④ **Context window**: tick the windows this model may be used at, then the one it DECLARES (the declaration is what Copilot sizes the session against; one tick = one window, no dropdown). Anything outside the named 128K/256K/512K/1M windows goes through "Custom…"
   - ⑤ **Effort levels**: tick the positions the gateway accepts, then the default one; none ticked = never send `reasoning_effort`
   - ⑥ API Key (leave blank for local/intranet gateways without auth)
3. Select it in the Copilot Chat model picker (BYOK group) and start chatting.

Model groups are stored in the **user-level credential store** (not `settings.json`): shared across profiles and windows, applied immediately, no reload required.

## Commands

- **Custom Mode: Manage Models** — one dialog to add / update model ID / change context windows / change effort levels / duplicate / delete model groups.
- **Custom Mode: Configure Agents Window Tools** — bring tools to the front in the Agents window (reversible).
- **Custom Mode: Reset Learned Reasoning Effort Limits** — clear the record of which reasoning levels each endpoint rejected.

## Troubleshooting

- **Model doesn't appear in the picker**: make sure Copilot Chat is enabled.
- **Gateway returns 400**: the extension falls back automatically through a four-level ladder; see the Output panel (Output → "Custom for Copilot").
- **"Request too long"**: start a new session, or pick a smaller window for that model (and declare it) in "Manage Models…".
- **Edits keep failing with `old_str is required`**: the gateway is returning tool calls as TEXT and keeping only their first argument. The extension rescues calls that still carry markup and drops the rest with one visible notice (instead of letting the agent retry an impossible call). Fix the gateway's tool-call parser, or pick another model — the log line `response.toolshape` names what happened.
- **Post-hoc debugging**: request logs are persisted to `custom-for-copilot-chat.log` in the extension's global storage (macOS: `~/Library/Application Support/Code/User/globalStorage/CustomforCopilot.custom-for-copilot/`).

## Development

```bash
npm install && npm run compile
npm run verify            # compile + i18n check + smoke tests
npm run package:next      # verify + auto-bump patch + package VSIX (--bump=minor|major to change level)
./scripts/dev-install.sh  # package and install into local VS Code (Reload Window after)
```

See `AIINDEX.md` for implementation details.

## Release

Publishing is fully automated by [`.github/workflows/release.yml`](.github/workflows/release.yml) (semantic-release):

1. Commit on `master` following conventional commits (`feat:` / `fix:` / `BREAKING CHANGE:` drive the version bump).
2. To release, open a PR on GitHub merging `master` into the `release` branch and merge it.
3. The workflow then: derives the version → updates `package.json` / `CHANGELOG.md` → tags `v<version>` → `vsce publish` (Azure WIF, no PAT) → creates a GitHub Release with the vsix → syncs the version back to `master`.

One-time setup: create a baseline tag (`git tag v0.1.0 && git push origin v0.1.0`), push the remote `release` branch, and configure `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` (see the workflow file header).

Local packaging is separate from publishing: `npm run package:next` bumps `package.json` / `package-lock.json` for a local VSIX without committing or tagging. Do not push that bump into the `master` → `release` flow — CI derives the version from release tags, so a locally advanced version can make the next release go backwards.

## License

MIT
