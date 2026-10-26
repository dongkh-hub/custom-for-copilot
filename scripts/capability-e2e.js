/**
 * End-to-end check of the learned-capability layer (run `npm run e2e`).
 *
 * A real HTTP server plays the gateway: it 400s `reasoning_effort: medium`
 * (once with a field-naming body, once with a generic one). The COMPILED
 * provider is loaded against a minimal `vscode` stub, so this exercises the
 * actual request path — the probe, the attribution, the learned substitution
 * on the next message, and the gear-panel note.
 *
 * Needs `out/` to be current: `npm run e2e` compiles first.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const assert = require('assert');

// The provider narrates every stage through console.log. Keep `npm run verify`
// readable; CAP_E2E_VERBOSE=1 shows the same lines for debugging.
const realLog = console.log;
if (!process.env.CAP_E2E_VERBOSE) {
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[CustomModel]')) {
      return;
    }
    realLog(...args);
  };
}

const ROOT = path.join(__dirname, '..');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? 'vscode-stub' : origResolve.call(this, request, ...rest);
};

class LanguageModelTextPart {
  constructor(value) { this.value = value; }
}
class LanguageModelDataPart {
  constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; }
}
class LanguageModelToolCallPart {
  constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
}
class LanguageModelToolResultPart {
  constructor(callId, content) { this.callId = callId; this.content = content; }
}
const settings = {};
const secrets = new Map();
const secretStorage = {
  get: async (k) => secrets.get(k),
  store: async (k, v) => { secrets.set(k, v); },
  delete: async (k) => { secrets.delete(k); },
  onDidChange: () => ({ dispose() {} }),
};
let captured;
/** Everything the extension would print in its visible Output channel. */
const channelLines = [];
const vscodeStub = {
  version: '1.999.0-e2e',
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelChatToolMode: { Auto: 0, Required: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ThemeIcon: class {},
  LanguageModelError: class extends Error {
    static NoPermissions(m) { return new Error(m); }
    static NotFound(m) { return new Error(m); }
  },
  EventEmitter: class {
    constructor() {
      this.listeners = new Set();
      this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    }
    fire() { for (const fn of this.listeners) fn(); }
  },
  window: {
    // Lines written to the visible channel are kept: a diagnostic the user is
    // told to look at ("Output → Custom for Copilot") has to be assertable.
    createOutputChannel: () => ({ appendLine: (line) => channelLines.push(line), append() {} }),
    showInformationMessage: () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : d),
      update: async (k, v) => { settings[k] = v; },
      inspect: () => ({}),
    }),
  },
  l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)] ?? '')) },
  lm: { registerLanguageModelChatProvider: (_vendor, provider) => { captured = provider; return { dispose() {} }; } },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

const seen = [];
// Authorization header per request — a keyless gateway must receive NONE.
const authSeen = [];
let genericBody = false;
// Terminal answer for the SUCCESS branch, when a case needs a shape other than
// a plain "ok" text delta (a tool call, a reasoning-only turn…).
let sseBody = null;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push(body.reasoning_effort);
    authSeen.push(req.headers.authorization ?? null);
    const refuses = genericBody
      ? body.reasoning_effort !== undefined
      : body.reasoning_effort === 'medium';
    if (refuses) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: genericBody
            ? 'the request was rejected by an internal gateway component, please check the request body'
            : 'Invalid reasoning_effort: must be one of low, high, max',
        },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (sseBody) {
      res.write(sseBody);
      res.end();
      return;
    }
    res.write('data: {"id":"x","choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: {"id":"x","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-e2e-'));

  const store = require(`${ROOT}/out/profileStore.js`);
  const cap = require(`${ROOT}/out/modelCapability.js`);
  const cfg = require(`${ROOT}/out/config.js`);
  const providerMod = require(`${ROOT}/out/provider.js`);

  const context = { secrets: secretStorage, globalStorageUri: { fsPath: tmp }, subscriptions: [] };
  await store.initProfileStore(context);
  await cap.initCapabilityStore(context);
  const baseURL = `http://127.0.0.1:${port}/v1`;
  await store.writeProfiles([
    { key: 'p1', name: '本地测试', baseURL, model: 'm1', maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  secrets.set(cfg.apiKeySecretKey('p1'), 'sk-test');
  providerMod.registerModelProvider(context);

  const messages = [{ role: 1, content: [new LanguageModelTextPart('hi')] }];
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const ask = async (effort) => {
    const parts = [];
    await captured.provideLanguageModelChatResponse(
      { id: 'p1::m1' },
      messages,
      { modelOptions: { reasoningEffort: effort }, tools: [] },
      { report: (part) => parts.push(part) },
      token
    );
    return parts;
  };

  // 1) First attempt with `medium`: 400 → probe without it → learned.
  await ask('medium');
  assert.deepStrictEqual(seen, ['medium', undefined], `expected medium then a probe without it, got ${JSON.stringify(seen)}`);
  assert.strictEqual(cap.effortVerdict(baseURL, 'm1', 'medium'), 'rejected', 'refusal remembered');
  assert.deepStrictEqual(cap.parseSupportedFromDetail(
    'Invalid reasoning_effort: must be one of low, high, max', 'medium'
  ), ['low', 'high', 'max'], 'enumerated set learned from the same error');
  console.log('PASS 1 — first failure probed, remembered:', cap.describeVerdict(baseURL, 'm1'));

  // 2) Second attempt: the learned value is replaced BEFORE the request.
  seen.length = 0;
  await ask('medium');
  assert.deepStrictEqual(seen, ['high'], `second attempt must send the fallback, got ${JSON.stringify(seen)}`);
  console.log('PASS 2 — second attempt never re-probed, sent:', seen[0]);

  // 3) The gear panel annotates the refused position instead of hiding it.
  const infos = await captured.provideLanguageModelChatInformation({}, token);
  const schema = infos[0].configurationSchema.properties.reasoningEffort;
  const mediumIndex = schema.enum.indexOf('medium');
  assert.ok(mediumIndex >= 0, 'refused value stays in the enum');
  assert.ok(/refused/i.test(schema.enumDescriptions[mediumIndex]), `description: ${schema.enumDescriptions[mediumIndex]}`);
  assert.ok(/"high"/.test(schema.enumDescriptions[mediumIndex]), 'description names the substitute');
  console.log('PASS 3 — panel note:', schema.enumDescriptions[mediumIndex]);

  // 3b) BOTH harnesses must read the SAME positions. VS Code's picker renders
  //     `configurationSchema`; Copilot ignores it and rebuilds the dropdown from
  //     `supportsReasoningEffort` / `defaultReasoningEffort`, labelling only the
  //     words it knows. A window control is absent because only one of the two
  //     harnesses renders the `tokens` group.
  const positions = ['none', 'low', 'medium', 'high'];
  assert.deepStrictEqual([...schema.enum], positions, `schema enum: ${schema.enum}`);
  assert.strictEqual(schema.default, 'high', 'the default is the highest effort');
  assert.deepStrictEqual([...infos[0].supportsReasoningEffort], positions, 'Copilot gets the same four');
  assert.strictEqual(infos[0].defaultReasoningEffort, 'high');
  assert.strictEqual(
    infos[0].configurationSchema.properties.contextSize,
    undefined,
    'a row with ONE window has no context control'
  );
  console.log('PASS 3b — both harnesses get the same four positions and the high default');

  // 4) The no-parameter position reaches the wire as NOTHING — it is the one
  //    position no gateway can reject.
  seen.length = 0;
  await ask('none');
  assert.deepStrictEqual(seen, [undefined], `none must send no reasoning_effort, got ${JSON.stringify(seen)}`);
  console.log('PASS 4 — the no-parameter position sends nothing on the wire');

  // 5) A GENERIC error body (no field named) is still attributable: the probe
  //    differs by one parameter, so the conclusion holds without the body's
  //    cooperation — it just cannot enumerate the accepted set.
  await store.writeProfiles([
    { key: 'p1', name: '本地测试', baseURL, model: 'm1', maxInputTokens: 0, maxOutputTokens: 0 },
    { key: 'p2', name: '通用错误', baseURL, model: 'm2', maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  secrets.set(cfg.apiKeySecretKey('p2'), 'sk-test');
  genericBody = true;
  seen.length = 0;
  await captured.provideLanguageModelChatResponse(
    { id: 'p2::m2' },
    messages,
    { modelOptions: { reasoningEffort: 'low' }, tools: [] },
    { report: () => undefined },
    token
  );
  assert.deepStrictEqual(seen, ['low', undefined], `generic body: probe still fires, got ${JSON.stringify(seen)}`);
  assert.strictEqual(cap.effortVerdict(baseURL, 'm2', 'low'), 'rejected', 'learned from a generic body');
  assert.strictEqual(
    cap.describeVerdict(baseURL, 'm2'),
    `127.0.0.1:${port}/v1: m2 → rejected=low`,
    'no accepted set is invented'
  );
  console.log('PASS 5 — generic body, no invented accepted set:', cap.describeVerdict(baseURL, 'm2'));


  // 6) A KEYLESS endpoint: no secret stored, `noAuth` set, and the request must
  //    carry no Authorization header at all — a bare `Bearer ` is rejected by
  //    proxies that treat the header's presence as a credential.
  await store.writeProfiles([
    { key: 'p3', name: '本地无鉴权', baseURL, model: 'm3', noAuth: true, maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  authSeen.length = 0;
  await captured.provideLanguageModelChatResponse(
    { id: 'p3::m3' },
    messages,
    { modelOptions: { reasoningEffort: 'auto' }, tools: [] },
    { report: () => undefined },
    token
  );
  assert.deepStrictEqual(authSeen, [null], `keyless request must send no Authorization header, got ${JSON.stringify(authSeen)}`);
  const keyless = (await captured.provideLanguageModelChatInformation({}, token))[0];
  assert.strictEqual(keyless.statusIcon, undefined, 'keyless endpoint is configured, not flagged');
  console.log('PASS 6 — keyless endpoint served with no Authorization header');

  // 7) A row that offers SEVERAL windows and a SUBSET of effort positions: the
  //    model panel gets BOTH controls, the declared window is pre-selected, and
  //    neither host is offered a position the row never declared.
  genericBody = false;
  await store.writeProfiles([
    {
      key: 'p5',
      name: '分档',
      baseURL,
      model: 'm5',
      maxInputTokens: 380928,
      maxOutputTokens: 131072,
      windowInputs: [124928, 380928, 868928],
      reasoningIds: ['low', 'high'],
      defaultThinkingEffort: 'high',
    },
  ]);
  secrets.set(cfg.apiKeySecretKey('p5'), 'sk-test');
  const wide = (await captured.provideLanguageModelChatInformation({}, token))[0];
  const props = wide.configurationSchema.properties;
  assert.deepStrictEqual(props.contextSize.enum, [124928, 380928, 868928], 'the rungs are the input budgets');
  assert.deepStrictEqual(
    props.contextSize.enumItemLabels,
    ['256K', '512K', '1M'],
    'each label is the TOTAL window the host ring will show'
  );
  assert.strictEqual(props.contextSize.default, 380928, 'the declaration is pre-selected');
  assert.strictEqual(props.contextSize.group, 'tokens');
  assert.deepStrictEqual(props.reasoningEffort.enum, ['low', 'high'], 'the panel shows the declared subset');
  assert.strictEqual(props.reasoningEffort.default, 'high');
  assert.deepStrictEqual([...wide.supportsReasoningEffort], ['low', 'high'], 'Copilot gets the same subset');
  assert.strictEqual(wide.defaultReasoningEffort, 'high');
  assert.strictEqual(wide.maxInputTokens, 380928, 'the declaration is still the one number every harness reads');

  // A position the row never declared must not reach the wire — the host can
  // still hold an older pick in its per-model storage.
  seen.length = 0;
  await captured.provideLanguageModelChatResponse(
    { id: 'p5::m5' },
    messages,
    { modelOptions: { reasoningEffort: 'medium' }, tools: [] },
    { report: () => undefined },
    token
  );
  assert.deepStrictEqual(seen, ['high'], `undeclared position replaced by the row default, got ${JSON.stringify(seen)}`);
  console.log('PASS 7 — window rungs + effort subset:', JSON.stringify(props.contextSize.enumItemLabels), props.reasoningEffort.enum.join('/'));

  // A row that declares NO effort position (a gateway that rejects the
  // parameter) must offer no control at all — not a one-item dropdown.
  await store.writeProfiles([
    {
      key: 'p6',
      name: '无档',
      baseURL,
      model: 'm6',
      maxInputTokens: 0,
      maxOutputTokens: 0,
      reasoningIds: [],
    },
  ]);
  secrets.set(cfg.apiKeySecretKey('p6'), 'sk-test');
  const bare = (await captured.provideLanguageModelChatInformation({}, token))[0];
  assert.strictEqual(bare.configurationSchema, undefined, 'no control to render');
  assert.strictEqual(bare.supportsReasoningEffort, undefined, 'Copilot gets no dropdown either');
  console.log('PASS 8 — no effort rung = no control anywhere');

  // 9) A gateway that recovers tool calls from the model's TEXT: the id stays in
  //    the model's own notation (`functions.edit:12`) and the arguments kept
  //    only their FIRST key. The call must still be forwarded — nothing here can
  //    invent the missing fields — and the turn must be reported on the visible
  //    channel, which is what turns "the agent keeps failing at edit" into
  //    "this gateway is not parsing tool calls".
  await store.writeProfiles([
    { key: 'p7', name: '降级通道', baseURL, model: 'm7', maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  secrets.set(cfg.apiKeySecretKey('p7'), 'sk-test');
  sseBody = `${[
    {
      id: 'x',
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'functions.edit:12',
                type: 'function',
                function: { name: 'edit', arguments: '{"path":"/tmp/a.json"}' },
              },
            ],
          },
        },
      ],
    },
    { id: 'x', choices: [{ finish_reason: 'tool_calls', delta: {} }] },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}`)
    .join('\n\n')}\n\ndata: [DONE]\n\n`;
  channelLines.length = 0;
  const parts = [];
  await captured.provideLanguageModelChatResponse(
    { id: 'p7::m7' },
    messages,
    { modelOptions: {}, tools: [] },
    { report: (part) => parts.push(part) },
    token
  );
  sseBody = null;
  const degradedCall = parts.find((part) => part instanceof LanguageModelToolCallPart);
  assert.ok(degradedCall, 'the degraded call is still handed to the host');
  assert.deepStrictEqual(degradedCall.input, { path: '/tmp/a.json' }, 'arguments pass through untouched');
  assert.ok(
    channelLines.some(
      (line) =>
        line.includes('response.toolshape') &&
        line.includes('degraded=1/1') &&
        line.includes('edit(path)')
    ),
    `degraded channel must reach the visible output: ${JSON.stringify(channelLines.slice(-2))}`
  );
  console.log('PASS 9 — text-parsed tool call flagged as degraded: edit(path)');

  // 10) A call that arrived as MARKUP in `content` (the gateway lost the
  //     structured field entirely). The extension parses the blocks back into a
  //     real tool call — the alternative is a wasted turn: the host runs
  //     nothing, the model sees no result, the user sees raw tags.
  await store.writeProfiles([
    { key: 'p8', name: '标记回填', baseURL, model: 'm8', maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  secrets.set(cfg.apiKeySecretKey('p8'), 'sk-test');
  const markup =
    '\n\n<tool_call>\n<function=edit>\n<parameter=path>\n/tmp/a.json\n</parameter>\n' +
    '<parameter=old_str>\n"a"\n</parameter>\n<parameter=new_str>\n"b"\n</parameter>\n</function>\n</tool_call>';
  sseBody = `data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: markup } }] })}\n\ndata: [DONE]\n\n`;
  channelLines.length = 0;
  const markupParts = [];
  await captured.provideLanguageModelChatResponse(
    { id: 'p8::m8' },
    messages,
    { modelOptions: {}, tools: [] },
    { report: (part) => markupParts.push(part) },
    token
  );
  sseBody = null;
  const rescued = markupParts.find((part) => part instanceof LanguageModelToolCallPart);
  assert.ok(rescued, 'markup is turned back into a tool call');
  assert.strictEqual(rescued.name, 'edit');
  assert.deepStrictEqual(
    rescued.input,
    { path: '/tmp/a.json', old_str: '"a"', new_str: '"b"' },
    'every <parameter> is kept, values unwrapped from the tag layout'
  );
  assert.ok(
    !markupParts.some((part) => part instanceof LanguageModelTextPart && part.value.includes('<tool_call')),
    'the raw markup never reaches the user'
  );
  assert.ok(
    channelLines.some((line) => line.includes('response.toolshape') && line.includes('recovered=1')),
    `recovery reported: ${JSON.stringify(channelLines.slice(-2))}`
  );
  console.log('PASS 10 — markup in content rescued into a complete edit call');

  // 11) A call the gateway cut down to ONE argument. It can never satisfy its
  //     schema, so dispatching it only buys a failure the model then repeats.
  //     Dropped, with one visible line instead of a silent loop.
  const editTool = {
    name: 'edit',
    description: 'Replace a string in a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } },
      required: ['path', 'old_str', 'new_str'],
    },
  };
  sseBody = `data: ${JSON.stringify({
    id: 'x',
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'functions.edit:12',
              type: 'function',
              function: { name: 'edit', arguments: '{"path":"/tmp/a.json"}' },
            },
          ],
        },
      },
    ],
  })}\n\ndata: [DONE]\n\n`;
  channelLines.length = 0;
  const droppedParts = [];
  await captured.provideLanguageModelChatResponse(
    { id: 'p8::m8' },
    messages,
    { modelOptions: {}, tools: [editTool] },
    { report: (part) => droppedParts.push(part) },
    token
  );
  sseBody = null;
  assert.ok(
    !droppedParts.some((part) => part instanceof LanguageModelToolCallPart),
    'an impossible call is never dispatched'
  );
  assert.ok(
    droppedParts.some(
      (part) =>
        part instanceof LanguageModelTextPart &&
        part.value.includes('Dropped an incomplete tool call') &&
        part.value.includes('old_str')
    ),
    `the user is told what happened: ${JSON.stringify(droppedParts.map((p) => p.value).filter(Boolean))}`
  );
  assert.ok(
    channelLines.some(
      (line) => line.includes('response.toolshape') && line.includes('dropped=edit(old_str|new_str)')
    ),
    `drop reported: ${JSON.stringify(channelLines.slice(-2))}`
  );
  console.log('PASS 11 — incomplete call dropped with one visible notice, not a retry loop');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('E2E OK');
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
