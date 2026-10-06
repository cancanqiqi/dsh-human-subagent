/**
 * Standalone Host-half check for @local/ask-user-subagent.
 *
 * Loads the real `index.js` with a minimal fake Cordis context, serves the
 * registered task route over a real HTTP server, and drives one delegated task
 * through the answer path and one through the cancel path.
 *
 * Run: node dev/verify-host.mjs
 */

import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, biasGuidance, Config, delegateFirstContext } from '../index.js';

/** A profile patch document with comments and a second row, for the fallback write. */
const SAMPLE_PATCH = `# Your patch layer for this dsh profile.
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
# Local plugin: hands a task to the user.
- id: ask-user-subagent
  name: "@local/ask-user-subagent"
  config:
    delegationBias: 80
    timeoutSeconds: 0
`;

const patchDir = await mkdtemp(join(tmpdir(), 'aus-patch-'));
const patchFile = join(patchDir, 'cordis.patch.yml');
await writeFile(patchFile, SAMPLE_PATCH, 'utf8');

/** Capture everything `apply` registers. */
const fake = {
  tool: undefined,
  section: undefined,
  context: undefined,
  route: undefined,
  configRoute: undefined,
};

/** Stateful stand-in for the Host settings service; `namespace: null` means it serves no namespace for this row. */
const settingsState = {
  namespace: null,
  value: { delegationBias: 80, timeoutSeconds: 0 },
  revision: 1,
  updates: [],
};

const rootAgent = { id: 'session-root' };
const ctx = {
  effect: (callback) => {
    callback();
    return () => {};
  },
  tools: {
    register: (definition) => {
      fake.tool = definition;
      return () => {};
    },
  },
  systemPrompt: {
    section: (section) => {
      fake.section = section;
      return () => {};
    },
    context: (context) => {
      fake.context = context;
      return () => {};
    },
    getContextOrder: () => 120,
  },
  agents: {
    roots: () => [rootAgent],
  },
  settings: {
    // Serve no namespace on the first pass so the profile-patch fallback runs;
    // the settings-service path is exercised afterwards.
    describe: () =>
      settingsState.namespace === null
        ? []
        : [{ ns: settingsState.namespace, value: { ...settingsState.value }, revision: settingsState.revision }],
    prepareDocument: async () => patchFile,
    update: async (ns, patch, expectedRevision) => {
      settingsState.updates.push({ ns, patch, expectedRevision });
      settingsState.value = { ...settingsState.value, ...patch };
      settingsState.revision += 1;
    },
  },
  fs: {
    resolve: async (path) => ({ path }),
    readText: async (target) => readFile(target.path, 'utf8'),
    writeText: async () => {
      throw new Error('the settings route must not write through the sandboxed fs service');
    },
  },
  connection: {
    fetch: {
      register: (route) => {
        if (route.path.endsWith('/config')) fake.configRoute = route;
        else fake.route = route;
        return () => {};
      },
    },
  },
};

// Resolve the row config exactly as cordis does before `apply` sees it.
const resolved = Config['~standard'].validate({ delegationBias: 80, timeoutSeconds: 0 });
if (resolved.issues !== undefined) throw new Error(`Config refused the sample config: ${JSON.stringify(resolved.issues)}`);
apply(ctx, resolved.value);

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

console.log('registration:');
check('tool registered', fake.tool?.name === 'ask_user_as_subagent');
check('prompt section registered', typeof fake.section?.text === 'string');
check('bias rendered into the section', /80\/100 \(high\)/.test(fake.section?.text ?? ''));
check(
  'the high band asks for a check before answering',
  /Before you finish your answer/.test(fake.section?.text ?? '') && /ask_user_as_subagent/.test(fake.section?.text ?? ''),
  fake.section?.text,
);
check(
  'the high band names what the subagent is there for',
  /better placed with the subagent/.test(fake.section?.text ?? '') &&
    /material, the access, or the judgement/.test(fake.section?.text ?? ''),
  fake.section?.text,
);
check('route registered', fake.route?.path === '/api/local/ask-user-subagent/tasks');
check('route methods', fake.route?.methods.includes('GET') && fake.route.methods.includes('POST'));
check('settings route registered', fake.configRoute?.path === '/api/local/ask-user-subagent/config');

console.log('bias bands:');
{
  // The maximum band must invert the default and name the mundane work, since
  // that is what stops "delegate the work" from meaning "delegate the odd bits".
  const max = biasGuidance(100);
  check('maximum band delegates work the agent could do itself', /could technically do yourself/.test(max), max);
  check('maximum band names arithmetic', /arithmetic/i.test(max), max);
  check('maximum band names file content', /content of a file/i.test(max), max);
  check('maximum band names drafting text', /drafted message or document/.test(max), max);
  check('maximum band keeps the environment work', /reading or writing a file, inspecting this repository/.test(max), max);
  check('maximum band demands content before a write', /produce before you write/.test(max), max);
  check('maximum band forbids batching delegations', /one call at a time/.test(max), max);
  check('maximum band still exempts idle chat', /need no delegation/.test(max), max);
  check('maximum band is labelled maximum', /100\/100 \(maximum\)/.test(max), max);

  // The other bands must not have been flattened by the strong one.
  check('low band stays self-reliant', /Complete the work yourself/.test(biasGuidance(10)) && !/arithmetic/i.test(biasGuidance(10)));
  check('balanced band stays self-reliant', /Complete the work yourself/.test(biasGuidance(50)) && !/arithmetic/i.test(biasGuidance(50)));
  check('high band keeps its pre-answer check', /Before you finish your answer/.test(biasGuidance(80)));
  check('high band does not demand arithmetic', !/arithmetic/i.test(biasGuidance(80)));

  // The runtime-context tier is what carries the maximum band into the decision.
  // It is asserted through its builder: `apply` registers it only at bias >= 85,
  // and this harness applies the high band to exercise the other paths.
  const context = delegateFirstContext(100);
  check('the runtime context gives the work to the subagent', /the subagent does the work in this turn/.test(context), context);
  check('the runtime context names arithmetic as the subagent\'s', /Arithmetic/.test(context), context);
  check('the runtime context keeps the exception', /Skip the delegation only for a greeting/.test(context), context);
  check('the runtime context quotes the bias', /maximum \(100\/100\)/.test(context), context);
}

console.log('model-facing framing:');
{
  // The caller must read this as an ordinary subagent, never as a person at a keyboard.
  const toolText = JSON.stringify({ description: fake.tool?.description, parameters: fake.tool?.parameters });
  check('the tool description says subagent', /subagent/i.test(fake.tool?.description ?? ''), fake.tool?.description);
  check('the tool text never says user, person, human, or card', !/\buser\b|\bperson\b|\bhuman\b|\bcard\b/i.test(toolText), toolText);
  check(
    'the task parameter is phrased for a subagent',
    /hand to the subagent/.test(fake.tool?.parameters?.properties?.task?.description ?? ''),
    fake.tool?.parameters?.properties?.task?.description,
  );
  check('the prompt section never says user, person, human, or card', !/\buser\b|\bperson\b|\bhuman\b|\bcard\b/i.test(biasGuidance(100)), biasGuidance(100));
  check(
    'the runtime context never says user, person, human, or card',
    !/\buser\b|\bperson\b|\bhuman\b|\bcard\b/i.test(delegateFirstContext(100)),
    delegateFirstContext(100),
  );

  const answered = fake.tool.output.render({}, { status: 'answered', answer: '391', elapsedMs: 4000 });
  check('the result reads as a subagent return', /The subagent answered the delegated task/.test(answered[0]?.text ?? ''), answered[0]?.text);
  const timedOut = fake.tool.output.render({}, { status: 'timeout' });
  check('the timeout result reads as a subagent return', /The subagent did not return a result/.test(timedOut[0]?.text ?? ''), timedOut[0]?.text);
}

console.log('row config schema:');
{
  const defaults = Config['~standard'].validate({});
  check('declares both defaults', defaults.value?.delegationBias === 50 && defaults.value?.timeoutSeconds === 0, JSON.stringify(defaults));
  const tooHigh = Config['~standard'].validate({ delegationBias: 500 });
  check('rejects an out-of-range bias', (tooHigh.issues?.length ?? 0) > 0, JSON.stringify(tooHigh));
  const projected = Config.toJSON();
  check('projects a JSON schema for the settings form', typeof projected === 'object' && projected.uid !== undefined);
}

// Serve the registered handlers the way the authenticated carrier does.
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1${req.url}`, {
    method: req.method,
    headers: req.headers,
    ...req.method === 'POST' || req.method === 'PUT' ? { body } : {},
  });
  const route = new URL(req.url, 'http://127.0.0.1').pathname.endsWith('/config') ? fake.configRoute : fake.route;
  const response = await route.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async () => {
  const response = await fetch(`${base}/api/local/ask-user-subagent/tasks`);
  return response.json();
};
const post = async (payload) => {
  const response = await fetch(`${base}/api/local/ask-user-subagent/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
};

console.log('settings route:');
{
  const read = await (await fetch(`${base}/api/local/ask-user-subagent/config`)).json();
  check('reads the live values', read.delegationBias === 80 && read.timeoutSeconds === 0, JSON.stringify(read));
  check('reports no settings namespace for this row', read.namespace === undefined, JSON.stringify(read));

  const refuseBias = await fetch(`${base}/api/local/ask-user-subagent/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delegationBias: 500, timeoutSeconds: 0 }),
  });
  check('refuses an out-of-range bias', refuseBias.status === 400, `HTTP ${String(refuseBias.status)}`);

  const refuseLimit = await fetch(`${base}/api/local/ask-user-subagent/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delegationBias: 30, timeoutSeconds: -5 }),
  });
  check('refuses a negative wait limit', refuseLimit.status === 400, `HTTP ${String(refuseLimit.status)}`);

  const accepted = await fetch(`${base}/api/local/ask-user-subagent/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delegationBias: 20, timeoutSeconds: 90 }),
  });
  const saved = await accepted.json();
  check('accepts a valid change without a settings namespace', accepted.status === 200 && saved.ok === true, JSON.stringify(saved));
  check('uses the profile-patch fallback', saved.via === 'profile-patch', String(saved.via));
  check('leaves the settings service untouched', settingsState.updates.length === 0, JSON.stringify(settingsState.updates));

  const rewritten = await readFile(patchFile, 'utf8');
  check('rewrites the bias in place', /^ {4}delegationBias: 20$/m.test(rewritten), rewritten);
  check('rewrites the wait limit in place', /^ {4}timeoutSeconds: 90$/m.test(rewritten), rewritten);
  check('keeps the other row untouched', rewritten.includes('reasoningEffort') === false && rewritten.includes('model: deepseek-flash'), rewritten);
  check('keeps the file comments', rewritten.includes('# Local plugin: hands a task to the user.'), rewritten);
  check('keeps the row identity', /^- id: ask-user-subagent$/m.test(rewritten) && /^ {2}name: "@local\/ask-user-subagent"$/m.test(rewritten), rewritten);
  // The running profile re-reads the document it watches, so the next GET sees the write.
  const afterWrite = await (await fetch(`${base}/api/local/ask-user-subagent/config`)).json();
  check('the change is visible on the next read', afterWrite.delegationBias === 20 && afterWrite.timeoutSeconds === 90, JSON.stringify(afterWrite));

  // A row the settings service does serve must go through it instead.
  settingsState.namespace = 'ask-user-subagent';
  const viaSettings = await fetch(`${base}/api/local/ask-user-subagent/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delegationBias: 35, timeoutSeconds: 0 }),
  });
  const viaSettingsBody = await viaSettings.json();
  check('prefers the settings service when it serves the row', viaSettings.status === 200 && viaSettingsBody.via === 'settings', JSON.stringify(viaSettingsBody));
  check('writes through the settings service', settingsState.updates.length === 1, JSON.stringify(settingsState.updates));
  check('writes the exact fields', settingsState.updates[0]?.patch?.delegationBias === 35 && settingsState.updates[0]?.patch?.timeoutSeconds === 0, JSON.stringify(settingsState.updates[0]));
  check('addresses the row entry', settingsState.updates[0]?.ns === 'ask-user-subagent', String(settingsState.updates[0]?.ns));
  check('fences the write with the read revision', settingsState.updates[0]?.expectedRevision === 1, String(settingsState.updates[0]?.expectedRevision));

  // The loader-id convention must resolve too, so the route keeps working if the
  // service ever reports the `include:` id instead of the patch id.
  settingsState.namespace = 'include:ask-user-subagent';
  const viaLoaderId = await fetch(`${base}/api/local/ask-user-subagent/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delegationBias: 40, timeoutSeconds: 0 }),
  });
  const viaLoaderIdBody = await viaLoaderId.json();
  check('resolves the loader entry id as well', viaLoaderId.status === 200 && settingsState.updates[1]?.ns === 'include:ask-user-subagent', JSON.stringify(viaLoaderIdBody));
  settingsState.namespace = 'ask-user-subagent';
}

// Drive one call the way the tool registry would.
const run = (callId, args) => {
  const controller = new AbortController();
  const promise = fake.tool.execute(args, {
    callId,
    agent: rootAgent,
    signal: controller.signal,
  });
  return { controller, promise };
};

console.log('answer path:');
{
  const { promise } = run('call-answer', { task: 'Write one sentence about timers.', context: 'Verification run.' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const listed = await get();
  check('pending task is visible to the client', listed.tasks.length === 1 && listed.tasks[0].callId === 'call-answer');
  check('task text survives the round trip', listed.tasks[0]?.task === 'Write one sentence about timers.');
  check('context survives the round trip', listed.tasks[0]?.context === 'Verification run.');
  check('startedAt is a timestamp', typeof listed.tasks[0]?.startedAt === 'number');

  const rejected = await post({ op: 'answer', callId: 'call-answer', text: '   ' });
  check('empty answer is refused', typeof rejected.error === 'string', JSON.stringify(rejected));
  check('refused answer keeps the task pending', (await get()).tasks.length === 1);

  const accepted = await post({ op: 'answer', callId: 'call-answer', text: 'Timers measure elapsed time.' });
  check('answer accepted', accepted.ok === true, JSON.stringify(accepted));
  const value = await promise;
  check('tool returns the answer', value.status === 'answered' && value.answer === 'Timers measure elapsed time.', JSON.stringify(value));
  check('tool reports elapsed time', typeof value.elapsedMs === 'number' && value.elapsedMs >= 0);
  check('task leaves the pending list', (await get()).tasks.length === 0);

  const rendered = fake.tool.output.render({}, value);
  check('result renders as text', rendered[0]?.type === 'text' && rendered[0].text.includes('Timers measure elapsed time.'));
}

console.log('cancel path:');
{
  const { promise } = run('call-cancel', { task: 'Anything.' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const cancelled = await post({ op: 'cancel', callId: 'call-cancel' });
  check('cancel accepted', cancelled.ok === true, JSON.stringify(cancelled));
  const value = await promise;
  check('tool reports cancellation', value.status === 'cancelled', JSON.stringify(value));
}

console.log('abort path:');
{
  const { controller, promise } = run('call-abort', { task: 'Anything.' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  const value = await promise;
  check('aborted wait settles as cancelled', value.status === 'cancelled', JSON.stringify(value));
  check('aborted task leaves the pending list', (await get()).tasks.length === 0);
}

console.log('input guard:');
{
  let threw = false;
  try {
    await fake.tool.execute({ task: '   ' }, { callId: 'call-empty', agent: rootAgent, signal: new AbortController().signal });
  } catch (error) {
    threw = /non-empty/.test(String(error));
  }
  check('empty task is rejected', threw);

  let delegated = false;
  try {
    await fake.tool.execute({ task: 'x' }, { callId: 'call-child', agent: { id: 'child' }, signal: new AbortController().signal });
  } catch (error) {
    delegated = /runtime-owned subagent/.test(String(error));
  }
  check('runtime-owned subagent is refused', delegated);
}

console.log('unknown operations:');
{
  const unknown = await post({ op: 'nonsense' });
  check('unknown op is refused', typeof unknown.error === 'string', JSON.stringify(unknown));
  const missing = await post({ op: 'answer', callId: 'nope', text: 'hi' });
  check('unknown call is reported', missing.ok === false && missing.reason === 'no-such-task', JSON.stringify(missing));
}

server.close();

console.log('');
if (failures.length === 0) {
  console.log('all checks passed');
} else {
  console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
