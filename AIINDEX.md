# AIINDEX — 代码索引（给 AI 代理 / 新接手的人）

> 人类使用者请读 [README.md](README.md)。本文件只回答三件事：**在哪、为什么这样、什么不能碰**。
> 改代码时同步改这里对应的一行，不要把它写成第二份 README。

## 0. 一句话定位

一个 VS Code 扩展：向宿主注册 `LanguageModelChatProvider`（vendor `custommodel`），把任意 **OpenAI 兼容**端点接进 Copilot Chat 与 Agents 窗口。**一组模型 = Base URL + 显示别名 + 真实 model id + API Key**，可并存多组，全部存在本机用户级凭据存储里。

## 1. 事实速查

| 项 | 值 |
| --- | --- |
| 版本 | `package.json` → `version`；本地打包用 `npm run package:next` 自动 patch +1（同步改 `package-lock.json` 两处，不提交、不打 tag），正式发版由 semantic-release 从 `release` tag 决定 |
| 引擎 | `^1.109.0`（Agents 窗口相关 API 需要） |
| 激活 | `onStartupFinished` → `src/extension.ts` `activate()` |
| 入口产物 | `out/extension.js`（`tsc -p ./`，ES2022 / Node16 / strict） |
| Provider vendor | `custommodel`（必须与 `contributes.languageModelChatProviders[].vendor` 一致） |
| 自有设置项 | **1 个**：`customModel.modelList`（只读镜像，扩展写、从不读回） |
| 编译期依赖 | 只有 `vscode` / `fs` / `path` / `crypto`；无运行时 npm 依赖 |
| 验证门槛 | `npm run verify`（compile + i18n:check + smoke） |
| 打包 | `npm run package:next`（verify → 自动升 patch → 出 vsix；`--bump=minor` / `--bump=major` 换档）、`npm run package`（不升版本）、`./scripts/dev-install.sh`（打包 + `--install-extension --force`），之后必须 Reload Window |

**别读**：`node_modules/`、`out/`（编译产物与其 sourcemap）、`package-lock.json`。

## 2. 目录地图

| 路径 | 作用 |
| --- | --- |
| `src/` | 全部源码（17 个模块，约 5100 行），编译到 `out/` |
| `l10n/bundle.l10n.zh-cn.json` | 运行期文案（`vscode.l10n.t` 的中文译文） |
| `package.nls.json` / `package.nls.zh-cn.json` | 清单文案（`package.json` 里的 `%key%`） |
| `scripts/i18n-check.js` | 国际化硬门槛（`npm run i18n:check`） |
| `scripts/smoke.js` | 用 `vscode` stub 跑的纯逻辑测试（无宿主） |
| `scripts/dev-install.sh` | 打包 + 本机安装（macOS，自动找 `code` CLI） |
| `.vscodeignore` | 打包排除清单（`src`、`scripts`、`*.map`、`.workbuddy`、`*.vsix`） |
| `.workbuddy/memory/` | 历次改动的决策记录（含「当时为什么这么改」），排查历史问题时值得先读 |

## 3. 模块索引

| 文件 | 行 | 职责 | 关键导出 |
| --- | --- | --- | --- |
| `extension.ts` | 212 | 激活编排：建 store → 挂设置镜像 → 修宿主槽位 → 注册 provider → 跨窗口监听 → Agents 默认值 → 命令（4 个）→ 一次性提示 | `activate` / `deactivate` |
| `provider.ts` | 1028 | Provider 实现：模型发现（含**双通道声明**：`configurationSchema` 给 VS Code picker —— `navigation` 思考档 + `tokens` 窗口档；`supportsReasoningEffort`/`defaultReasoningEffort` 给 Copilot）、请求主循环（档位收窄到该组声明的子集）、400 阶梯、上下文溢出分支、诊断日志（只写文件，无打开入口） | `registerModelProvider` `notifyProviderChanged` `setDiagnosticLogDir` `effortLabel` `effortDescription` |
| `config.ts` | 739 | **形状与派生**：`Profile`（含 `windowInputs` / `reasoningIds` / `defaultThinkingEffort`）、`parseProfile`、内置限额预设链、**窗口档位**（具名表 + 按行重推 + label）、picker id 编解码、思考档位、输出通道 | `MODEL_PROVIDER_VENDOR` `STATE_KEYS` `detectModelPreset` `resolveProfileEntry` `realInputCeiling` `summaryInputTokens` `tokenWindowLabel` `summaryWindowLabel` `THINKING_EFFORTS` `DEFAULT_THINKING_EFFORT` `resolveThinkingEffort` `thinkingEffortParam` `MODEL_WINDOW_TIERS` `windowCandidates` `normalizeWindowInputs` `hostWindowLabel` `resolveReasoningIds` `resolveDefaultThinking` `encodePickerId` `decodePickerId` `modelOutput` `readProfileApiKey` `writeProfileApiKey` |
| `profileStore.ts` | 262 | **唯一真相源**：模型组列表（SecretStorage `customModel.profiles.v2`）+ 同步缓存 + 跨窗口 reload + 限额覆写 | `initProfileStore` `readProfiles` `readProfile` `firstProfile` `writeProfiles` `upsertProfile` `removeProfile` `reloadProfiles` `applyProfileLimitOverrides` `onProfilesChanged` `resetProfileStoreForTests` |
| `message.ts` | 668 | 请求体构造与消息映射：tool/图片拆分、思考回放、辅助请求降级、400 阶梯、结构指纹 | `buildRequestBody` `convertMessage` `applyCompatibilityFallback` `dropRejectedParams` `bodyDigest` `readThinkingEffortChoice` `readModelLimitOverrides` `applyLimitOverrides` `estimatePromptTokens` `safeJsonStringify` |
| `stream.ts` | 459 | SSE 解析、tool call 增量拼接、**降级通道兜底**（标记回填、缺必填字段的调用丢弃）、usage 数据部件、错误脱敏与映射 | `streamSseToProgress` `usageDataPart` `sanitizeDetail` `readErrorDetail` `responseErrorWithDetail` |
| `toolCallText.ts` | 129 | 把「以文本形式泄漏的工具调用」解析回结构化调用：`<tool_call><function=NAME><parameter=K>V</parameter>` 全取、按 serving stack 的惯例还原类型；附带判断「这段文本还有没有可能是标记」 | `extractTextToolCalls` `mayBeToolCallMarkup` `MARKUP_BUFFER_LIMIT` |
| `harnessSync.ts` | 234 | 命令「重新同步到 Copilot」：重发 provider 变更 → 修 `chat.*` 槽位 → 清掉上几个扩展 id 的白名单键 → 清掉 `chatLanguageModels.json` 里无法解析的 per-model 设置（宿主文件，只在显式命令里写，临时文件 + rename） | `syncToCopilot` `pruneAllowList` `pruneModelSettings` |
| `replay.ts` | 162 | 思考回放标记（宿主不透明 data part）的写与读 | `REPLAY_MARKER_MIME` `createReasoningMarker` `readReasoningMarker` |
| `requestKind.ts` | 215 | 「谁在问？」分类 + 辅助请求降级策略 | `classifyProviderRequest` `classifyRequestShape` `utilityDowngrade` `isUtilityKind` |
| `toolPreflight.ts` | 291 | `activate_*` 工具激活握手（零 token 往返）+ 合成控制流清理 | `inspectActivatePreflight` `pickActivatorToCall` `filterPreflightControlFlow` `createPreflightToolCallId` `summarizeToolSurface` `countRealTools` `MAX_PREFLIGHT_ROUNDS` |
| `hostDefaults.ts` | 175 | 把 `chat.defaultModel` / 两个 utility 槽位 / `byokUtilityModelDefault` 指向本插件（fill-only + stale 自愈，无强制覆盖路径） | `defaultChatUtilitySettingsToOwnModel` |
| `agentWindow.ts` | 152 | Agents 窗口三个兼容开关，一次性写入 | `applyAgentWindowDefaults` `applyAgentWindowDefaultsOnce` |
| `agentWindowTools.ts` | 234 | Agents 窗口工具可见性开关（关 tool search + 通配 capability）及其撤销 | `readAgentWindowToolState` `applyFullToolVisibility` `restoreAgentWindowToolDefaults` `showAgentWindowToolsMenu` |
| `modelListSetting.ts` | 138 | 设置镜像：把模型组渲染成 `customModel.modelList` 多行文本（只读，Settings UI 唯一能看到清单的地方） | `modelListLines` `modelListText` `syncModelListSetting` `registerModelListMirror` |
| `statusBar.ts` | 44 | 状态栏 ✨ 计数入口：显示本机模型组数量，点击执行 `customModel.manageModels`，随 `onProfilesChanged` 重绘 | `registerModelStatusBar` |
| `modelCapability.ts` | 382 | 学到的端点能力：某个 `(端点, 模型)` 到底接受哪些 `reasoning_effort` 值（存 SecretStorage，跨 VS Code 配置文件共享） | `initCapabilityStore` `effortVerdict` `fallbackEffort` `recordEffortVerdict` `parseSupportedFromDetail` `clearCapabilities` |
| `setup.ts` | 984 | 统一管理弹窗 `manageModels`（空列表→添加向导；选组→更新 ID/上下文窗口/思考档位/复制整组/删除，末行固定添加；**添加成功即结束访问**）+ 六步向导（URL→别名→model→窗口档→思考档→Key）+ 一次性配置提示 | `manageModels` `addModelProfile` `maybeShowSetupHint` |
| `copilotChat.ts` | 79 | Copilot Chat 可用性探测（纯查询，无编排） | `isCopilotChatAvailable` `waitUntilCopilotChatAvailable` `openCopilotChatExtension` |
| `thinking.ts` | 46 | proposed API `LanguageModelThinkingPart` 的运行时探测与转发 | `isThinkingPart` `thinkingPartText` `reportThinking` |

**分层**：`config`（形状/派生，无状态）→ `profileStore`（唯一的可变状态）→ `provider`（编排）→ `message`/`stream`/`replay`/`requestKind`/`toolPreflight`（纯函数为主，最易测）→ `hostDefaults`/`agentWindow*`/`setup`/`copilotChat`（宿主设置与 UI 边缘）。

## 4. 一次聊天请求的数据流

```
VS Code / Copilot Chat
  └─ provideLanguageModelChatResponse(model, messages, options, progress, token)   [provider.ts]
       1. rid + t0；decodePickerId(model.id) → profile（裸 id 退回第一组）
       2. readProfileApiKey(profile) → 无 key 抛 NoPermissions
       3. resolveProfileEntry → 限额（显式 > 预设 > 默认 1M/128K）
       4. classifyProviderRequest → RequestKind（辅助请求降级用）
       5. runToolPreflight → 需要激活则只 report 一个 activate_* 调用并 return（不发请求）
       6. readModelLimitOverrides → 面板改数：本请求生效 + 持久化进该组
       7. resolveThinkingEffort（默认 auto）+ 已学到的降级（learnedEffortFor）+ buildRequestBody（映射消息、工具、reasoning_effort）
       8. fetch POST {baseURL}/chat/completions   （有 Key 才带 Bearer，无鉴权端点不带 Authorization，SSE）
       9. 非 2xx：context overflow → 删 max_tokens 重试一次；400 → 先做单参数探测（body 带
          reasoning_effort 就只删它重发，成功即归因并写入能力库）；失败再走四级阶梯；其余直接报错
      10. streamSseToProgress → 文本 / tool call / 思考 / usage
      11. progress.report(createReasoningMarker(reasoning))   （未取消时）
      12. progress.report(usageDataPart(usage))               （网关没给就用估算）
```

## 5. 不变量（改代码前必读）

1. **picker id 是 `<profile.key>::<model>`**；请求体 `model` 永远是 `profile.model`，**别名只用于显示**，绝不入库。
2. 两组即使用同一个上游 model id，picker id 也必须不同 —— VS Code 按 id 索引模型表，重复即静默覆盖。
3. 宿主槽位（`chat.defaultModel` 等）存的是**同一套编码 id**，编码不一致 → 解析不到模型。
4. assistant 消息 `content` 用 `''` 不用 `null`；无文本/无 tool_calls/无 reasoning 的空 assistant 轮**整条不发**。
5. **tool result 必须先于用户文本输出**：顺过来会把 `assistant(tool_calls) → tool(...)` 配对中间塞进一个空 user 消息，严格网关直接 400。
6. 思考回放的来源优先级：**marker > thinking part**；marker 只在流正常结束、且 token 未取消时写（半截思维链比没有更糟）。
7. 400 阶梯是**累积修改同一个 body**、每级重试一次、最多 `MAX_COMPATIBILITY_LEVEL = 4`；`401/403/404/5xx` 永不重试。
8. 上下文溢出**不进阶梯**：阶梯不减少 token，只会白白发四次请求。先删 `max_tokens` 重试，再给可执行报错。
9. 模型组只在 SecretStorage（application 级 `customModel.profiles.v2`）；`settings.json` 里不落任何模型组数据 —— 唯一写进设置的是只读镜像 `customModel.modelList`，且镜像里没有端点与密钥。
10. `await initProfileStore(context)` 必须排在**任何读 profile 之前**；SecretStorage 不可用时降级为**仅内存**（当前会话可用，不持久化，输出通道记一行 `[profiles] credential store unavailable`）。
11. `getConfiguration(section)` 的 key 一律**段内相对**（`chat.*`、`github.copilot.chat.*`、`chat.agentHost.*`、`extensions.*`）；传全名会变成 `chat.chat.*`，`update()` 直接抛错。
12. 宿主设置写入是 **fill-only**（只填空位）+ 只修自家命名空间的 stale 值；**没有任何代码路径会覆盖用户自己填的值**。
13. 限额覆写三态：`undefined` = 本次没动 · `>0` = 自定义（并持久化进模型组） · `<=0`（`Number('')===0`）= 清空，恢复自动。这三个值只在「宿主把原始字段名下发」时出现；**窗口/思考档位不走这条路**，它们是模型组自己的字段（`windowInputs` / `reasoningIds`，见第 26 条），由向导与管理菜单写入。
14. 思考档位**四个位置就是宿主能标注的那四个词**：`none` / `low` / `medium` / `high`。一个模型组可以只声明其中**一个子集**（`Profile.reasoningIds`，空数组 = 完全不提供控件）；`none` **不发送任何思考参数**；其余原样发 `reasoning_effort`，默认 `high`。未知值、以及**该组没声明过的位置**都回落到该组自己的默认；退役 id `auto` 也映射到 `none`（老存储值不失效）。辅助请求（utility 降级命中）一律不带该参数。`reasoning_effort` 已在 `OPTIONAL_BODY_PARAMS` 里，被网关拒绝时 400 阶梯会自动摘掉。**id 不能随便命名**：Copilot 侧用固定表（`none/minimal/low/medium/high/xhigh/max`）逐项生成标签，表外的值被**直接丢弃** —— 曾用 `auto` 导致同一模型在一侧 5 档、另一侧 4 档。
15. 辅助请求降级恒定生效：文本类 helper 去 `tools` + `max_tokens=2048`；`todo-tracker` / `prompt-categorizer` 保留唯一工具；`main-agent` / `terminal-steering` 绝不降级。
16. preflight 每轮**只发一个** activator（宿主的分组互斥），最多 3 轮；合成 call id 前缀 `cm_preflight_activate_`，发真实请求前会被 `filterPreflightControlFlow` 摘掉。
17. `l10n.t()` 的参数必须是**字符串字面量**；清单文案走 `%key%`，en/zh 两份都要有（缺键不会回退，会原样显示 `%key%`）。
18. 诊断日志（`fs.appendFileSync`）全部包在 try/catch 内 —— 日志失败绝不能让请求失败。
19. **`customModel.modelList` 是镜像，不是输入**：只写不读，`onProfilesChanged` 触发重绘；手改会在下次变更时被覆盖。镜像里**不得出现端点与密钥**（凭据存储的全部意义就是不落盘这两样），`scope: machine` 保证设置同步不带走它。
20. 镜像用**多行字符串**（`editPresentation: multilineText`）而不是字符串数组 —— 数组会被设置 UI 渲染成可编辑列表（每行的编辑/删除 ✕ + 「添加项」按钮），在只读镜像上等于给出一堆点了没用的控件。
21. **能力学习只认「单参数探测」的成功**：400 后先只删 `reasoning_effort` 重发一次，成功才归因并记账（有无网关点名字段都成立 —— 差别只在能否顺带解析出白名单）。阶梯那次重试可能一次删掉六个参数，成功不证明是档位的问题，所以**阶梯永不学习**。成功（200）会撤销该值的拒绝记录。
22. 学到的结论按 `端点(host+path) | model` 存 SecretStorage，最多 64 条（LRU 淘汰），**不存任何密钥**；没有 TTL，只能由 `customModel.resetCapabilities` 清除 —— 网关升级可能放宽值域，靠过期同样会误伤。
23. gear 面板**不从 enum 里删除**被拒档位：VS Code 把选择存在自己的 per-model 存储里，抽掉 enum 成员会让面板显示空值。改为在 `enumDescriptions` 里标注「会改用 X」，请求路径提前替换，不再花那一趟往返。
24. **「已配置」由 `noAuth` 或非空 Key 决定**（`profileHasCredentials`），不是只看 Key：自建推理服务（本地或内网、未开鉴权）没有密钥，若把空 Key 一律当未配置，这些端点永远加不进来。`noAuth` 只认字面量 `true`（手改 payload 写 `"true"` 不生效）；无鉴权请求**完全不发 Authorization 头**（空 `Bearer ` 会被把「头存在」当凭据的代理判 401）。
25. base URL 只做**后缀归一**：去尾斜杠、把误粘的 `…/chat/completions` 折回 base。**不补 `/v1`、不改前缀** —— 各家根路径不同（`/v1`、`/v1/openai`、`/openai/v1`、带 deployment 的路径），猜错就是把可用的换成 404；而 404 不在重试阶梯里。
26. **上下文窗口：声明 + 可选的档位集合**。`maxInputTokens` 永远是**声明**——两个 harness 都按它算预算，Copilot 侧没有面板，只有这个数；`Profile.windowInputs` 是**可选**的档位集合，声明的那一档必须是集合成员，面板（`contextSize`，`tokens` 组）只在成员 >1 且默认在 enum 里时下发。
    - **为什么不能只靠面板**：只有 VS Code 自己的 picker 渲染 `tokens` 组，Copilot / Agents 侧整块丢 schema。所以「面板选了什么」只影响那个窗口，另一个窗口永远按声明走 —— 声明必须等于面板默认，否则两个窗口对同一个模型有两种说法。
    - **档位按行重推**：`windowCandidates(模型, 输出上限)` = 具名窗口（`MODEL_WINDOW_TIERS`：128K/256K/512K/1M，每个都带自己的输出预留）减去本行输出后的输入预算；重推后 `input <= 0` 或超过模型上限的档丢弃 —— 128K 的窗口装不下 128K 的回答。
    - **模型真实上限不是档位**：把它当候选会得到 `1.1M` 这种没人要的数字（1M 输入 + 128K 回答）。具名档之外的窗口走向导的**「自定义…」**（`customWindowTier`，用户自己填输入预算，label 仍按环上总数）。新建行默认落在**最大的具名档**上。
    - **label 是环上的总数**（`hostWindowLabel(input + output)`，宿主同款：1000 进制、M 段一位、>900K 显示 `1M`）。这是本模块**第三个**标签函数，也是唯一允许出现在窗口档位上的：`tokenWindowLabel` 是二进制、`summaryWindowLabel` 是厂商十进制，用错就出现「选 256K、环上 393K」。
    - **两个 harness 的落点**：面板那侧切档只影响它自己；Copilot 那侧恒用声明。想让 Copilot 用更小的窗口，就在向导里把那一档选成**默认**（即声明）。
    - 旧安装：以前在 gear 里选过的值被写进了 `profile.maxInputTokens`，升级后仍是声明值；要恢复自动就把它改回 0，或在管理里重新走一遍「上下文窗口…」。
27. **「添加模型」是唯一会结束管理器访问的动作**：`addModelProfile` / `modelWizard` 返回 `saved: boolean`，管理器（`manageModels` 的 `for(;;)` 与空列表分支）在 `true` 时 `return` —— 向导已把焦点交给 Copilot Chat，再弹回列表只会挡住用户正要打字的输入框。`false`（向导任意一步 Esc / 空必填 / 写盘失败）才 `continue` 回列表。更新 ID / 复制 / 删除**照旧回到列表**（那仍处于「我在管理」的意图里）。
28. 焦点交回 Chat 要**两条命令**：`workbench.action.chat.open`（显示视图）+ `workbench.action.chat.focusInput`（把光标放进输入框，实测命令存在）。只有前者时焦点会停在视图容器或上次聚焦的编辑器里。两条都包 try/catch —— 版本没有该命令时静默失败，配置本身已成功。
29. **摘要（设置镜像 / 管理列表 / 添加向导）显示的就是声明值**：`summaryInputTokens()` = 手填值优先，否则 `realInputCeiling()`；档位阶梯删掉后它与 `resolveProfileEntry().maxInputTokens` 恒等（保留独立函数名是为了表达「这个模型本身多大」）。两个标签函数口径不同、不要合并：`tokenWindowLabel`（二进制：131072 → `128K`）与 `summaryWindowLabel`（十进制厂商口径：200000 → `200K`），合并会把 200K 印成 `195K`。

## 6. 日志 stage 对照（`console.log` + `<globalStorage>/custom-for-copilot-chat.log`）

| stage | 含义 / 读法 |
| --- | --- |
| `response.enter` | 请求进入 provider（带 `model=` 编码 id） |
| `request.start` | body 已构造：`kind= effort= messages= tools= max_tokens= stream_options= adjusted=` |
| `response.headers` | 收到响应头（含 status）；`status>=400` 也会进可见输出通道 |
| `response.firstChunk` | 首个 body 字节到达（推理耗时 = headers→firstChunk 的间隔） |
| `response.thinking` | 本轮有思维链：`chars= shown=`（`shown=false` 说明宿主没有 thinking part） |
| `response.toolshape` | 工具调用没走结构化通道：`degraded=2/3 recovered=1 dropped=edit(old_str\|new_str) edit(path), grep(raw)` —— `degraded` 原生 id/参数非 JSON、`recovered` 从文本标记里救回、`dropped` 缺必填字段被丢弃（见 §7） |
| `response.replay` | marker 是否写入成功（`skipped:` 说明宿主拒收） |
| `request.fallback` | 阶梯降级：`level= dropped=` + 结构指纹 |
| `request.overflow` | 上下文溢出分支：是否已去掉 `max_tokens` 重试 |
| `response.rejected` | 最终被拒：status + 结构指纹 + 完整错误体（脱敏后 2000 字） |
| `preflight.activate/ready/drift/abort` | 激活握手进度、当前工具面 `real= activators= groups=`、未展开、超过轮数上限 |

## 7. 已知故障 → 对应机制

| 现象 | 机制位置 |
| --- | --- |
| 第一轮正常、第二轮起 400 | `convertMessage` 的 tool 输出顺序 + `replay.ts` 的 marker + `applyCompatibilityFallback` |
| 聊久了报「请求超长」 | `isContextOverflow` → 删 `max_tokens` 重试 → 提示调小「最大输入 tokens」 |
| helper 请求报 `No utility model is configured` | `hostDefaults.defaultChatUtilitySettingsToOwnModel`（四槽位） |
| 换一个 VS Code 配置文件后「有 Key 没模型」 | `profileStore`（列表与 Key 同在 application 级存储） |
| Agents 窗口模型在、工具几乎没有 | `toolPreflight` + 命令 `customModel.configureAgentWindowTools` |
| 改名/删组后 Copilot 侧列表不刷新、`chat.*` 槽位指向已删模型、白名单里堆着旧 id | 命令 `customModel.syncToCopilot`（`harnessSync.ts`）：重发 `onDidChangeLanguageModelChatInformation` + 修槽位 + 清白名单 + 清 `chatLanguageModels.json` 死条目。**无 profile 时跳过设置清理**（否则“解析不了”等于“全删”） |
| `edit` 反复报 `old_str is required`，同一调用重发十几次 | 网关把工具调用从**文本**回填：id 是模型原生的 `functions.edit:12` 而参数只剩第一个 key。扩展侧的兜底在 `stream.ts`：文本标记能救回就救（`toolCallText.ts`），缺必填字段的调用**直接丢弃**并给一行可见提示（`requiredByTool` 来自宿主传的 `inputSchema.required`），不再让宿主把注定失败的调用跑一遍。根治仍在中继的解析器 |
| 上下文用量小部件一直 0% | `stream.usageDataPart`（mime `usage`，三个字段必须是数字） |
| 模型选择器条目消失 | `provider.modelInformation` 始终列出每组（未配置加 ⚠），不会隐藏 |
| `chat.defaultModel` 指向已删组 | `hostDefaults.isStalePickerId`（只改带 `::` 的自有值） |
| 设置里的模型清单对不上 | `modelListSetting.syncModelListSetting`（镜像只在列表变更时重绘；手改会被覆盖） |

## 8. 常见改动配方

- **加运行期文案**：源码写 `vscode.l10n.t('English literal')` → `npm run i18n:check` 报缺键与行号 → 补 `l10n/bundle.l10n.zh-cn.json` → 重跑。
- **加清单文案**：`package.json` 写 `%key%` → 两份 `package.nls*.json` 各加一条（同名同占位符）。
- **加命令**：`contributes.commands`（`title` 走 `%cmd.xxx.title%`）+ 两份 nls + `extension.ts` 里 `registerCommand` + 任何弹窗文案补 l10n。
- **在设置项里放可点链接**：`markdownDescription` 写 `[文本](command:命令id)`（命令必须先注册）；这就是设置页「管理模型」统一入口的实现方式。链接文本里**不要写 `$(codicon)`** —— 设置 UI 不渲染图标，会原样显示成 `$(add)`（QuickPick 的 label 里则可以正常用）。
- **加模型限额预设**：`config.ts` 的 `MODEL_PRESETS` 插入（**窄 id 必须排在同族通配之前**）→ `smoke.js` 补断言。README 不再列逐条限额表（预设是示例性质，随网关而异），只保留「默认 1M/128K + 管理里可覆盖」的说法。
- **改思考强度档位**：`config.ts` 的 `THINKING_EFFORTS` / `DEFAULT_THINKING_EFFORT` / `resolveThinkingEffort` / `thinkingEffortParam` + `provider.ts` 的 `thinkingEffortProperty`（`enumItemLabels` / `enumDescriptions` 与 `THINKING_EFFORTS` 必须同序）+ `modelInformation` 里的 `supportsReasoningEffort` / `defaultReasoningEffort`。**新档位 id 必须是 `none/minimal/low/medium/high/xhigh/max` 之一**，否则 Copilot 侧直接丢弃（见第 14 条）；改完跑 `npm run e2e`，PASS 3b 会核对两侧枚举一致。
- **调模型窗口/档位**：具名档位只改 `config.ts` 的 `MODEL_WINDOW_TIERS`（每个都带自己的输入+输出预留）；每个模型真实上限改 `MODEL_PRESETS`。向导与管理里的「上下文窗口…」复用 `pickWindowTiers`，**两步不可合并**：先勾集合、再选声明（声明就是 Copilot 侧生效的那一档）。
- **改思考档位**：`config.ts` 的 `THINKING_EFFORTS` / `DEFAULT_THINKING_EFFORT`；每个模型组的子集是 `Profile.reasoningIds`（空 = 不提供控件），向导与管理里的「思考档位…」复用 `pickEffortTiers`。新 id 必须落在宿主能标注的那七个词里（见第 14 条）。
- **改面板字段**：`provider.modelConfigurationSchema`（`navigation` = 思考档位，`tokens` = 窗口档位，都是枚举→下拉）+ `message.readThinkingEffortChoice` 读回。**思考档位必须同时在 `supportsReasoningEffort`/`defaultReasoningEffort` 一侧声明**，否则只有 VS Code 自己那个窗口看得到它；窗口档位没有顶层等价物，所以 Copilot 侧恒用声明（第 26 条）。
- **打包安装**：`npm run package:next`（内含 verify，先自动升 patch 再打包）/ `npm run package`（不升版本）/ `./scripts/dev-install.sh`（打包并装进本机）→ **Reload Window**（VS Code 不热替换已安装扩展）。`package:next` 只改两个清单的 version 字段，不提交、不打 tag；**别把本地 bump 推到 `master` → `release` 发布链**（CI 版本号来自 tag，本地领先会让下次发版版本倒退）。

## 9. 验证门槛

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | `tsc -p ./`，strict，零错是底线 |
| `npm run i18n:check` | 清单 `%key%` 双向齐全、重复键、占位符一致、源语言不得含中文、`l10n.t` 必须字面量、`show*Message` 不许裸字符串；缺条=错误，过期=告警（`--strict` 转错误） |
| `node scripts/smoke.js` | `vscode` stub 下跑纯逻辑：SSE（含无尾空行）、消息映射形状、400 阶梯、分类器、picker id 往返、限额解析、store 初始化/二次激活/跨窗口 reload |
| `npm run verify` | 上面三个串起来，改文案或源码后必跑 |
| `npm run package:next` | verify + `npm version <档位> --no-git-tag-version` + `vsce package`；默认 patch，`--bump=minor` / `--bump=major` 换档 |

## 10. 硬性禁止

- 不要新增 `customModel.*` 设置 —— 唯一例外是那个只读镜像；需要新行为就走「常量 + 代码」。
- 不要在模型发现（`provideLanguageModelChatInformation`）里弹任何 UI —— 静默枚举也会调用它。
- 不要把 API Key 写进 `settings.json`、日志或错误文案（`sanitizeDetail` 会打码，但源头不该出现）。
- 不要给 400 以外的状态码加重试阶梯（重试治不了凭证/路由/上游问题）。
- 不要直接 `instanceof vscode.LanguageModelDataPart`（旧宿主上是 `undefined`，会抛错）；用 `isDataPart` / `replay.dataPartClass`。
- 不要删除 `.workbuddy/`（项目决策记录，不进 vsix）。
