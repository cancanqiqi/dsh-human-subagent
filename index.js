/**
 * Host half of the "delegate to the user" bundle.
 *
 * Registers one model-facing delegation tool that, from the calling agent's
 * point of view, is an ordinary subagent: it takes a task and returns a result.
 * What actually happens is a card in the Web UI, answered by the person at the
 * keyboard — a fact the model-facing text never states.
 *
 * The call does not return until that card is submitted (or the call times out /
 * the turn is cancelled), so the answer arrives as the ordinary tool result.
 *
 * Transport: authenticated `ctx.connection.fetch` routes under `/api`.
 * The card polls one for the pending task and submits the answer to it.
 *
 * @module @local/ask-user-subagent
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';

/** Route path shared with the Client half; it keeps the `/api` prefix so the authenticated carrier serves it. */
const ROUTE_PATH = '/api/local/ask-user-subagent/tasks';

/** Route path of the settings-page read/write pair. */
const CONFIG_PATH = '/api/local/ask-user-subagent/config';

/** Every pending call, keyed by the tool call id that owns it. */
const pendingCalls = new Map();

/** Format a millisecond duration as `1m 04s` / `12s`. */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/** Serialize one pending record into the shape the card renders. */
function taskPayload(record) {
  return {
    callId: record.callId,
    task: record.task,
    context: record.context ?? '',
    startedAt: record.createdAt,
  };
}

/** One JSON response. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Settle one pending call exactly once. */
function settle(record, outcome) {
  if (record.settled) return false;
  record.settled = true;
  pendingCalls.delete(record.callId);
  record.resolve(outcome);
  return true;
}

/**
 * Build the system-prompt section that turns the numeric bias into model
 * guidance.
 *
 * The knob decides how the work is split. The top band inverts the default: the
 * caller must hand nearly everything to the subagent, including work it could do
 * itself, and keep only what physically has to happen in this environment. That
 * band names the smallest tasks too (arithmetic, writing a file), so "delegate
 * the work" cannot be read as "delegate only the awkward parts".
 *
 * The subagent framing is deliberate and consistent: the model sees a delegation
 * target with knowledge and access this environment lacks, never a person at a
 * keyboard.
 *
 * @param bias - 0–100 delegation bias.
 * @returns The prompt text for this bias.
 */
function biasGuidance(bias) {
  const shared =
    'A subagent on this deployment answers through ask_user_as_subagent: the call hands it one task, waits while it works, and returns its answer as this call\'s result. It holds knowledge, access, and material this environment does not, it works one task at a time, and the wait is expected — that is how a delegation returns.';
  if (bias < 25) {
    return `${shared} Delegation bias: ${bias}/100 (low). Complete the work yourself; delegate only what is genuinely blocked without what this subagent holds, never as a shortcut or as a way to work in parallel.`;
  }
  if (bias < 60) {
    return `${shared} Delegation bias: ${bias}/100 (balanced). Complete the work yourself, and delegate the part that needs what the subagent holds: knowledge or access outside this environment, a judgement only it can make, or material it must supply before you can continue.`;
  }
  if (bias < 85) {
    return `${shared} Delegation bias: ${bias}/100 (high). Before you finish your answer, check whether part of this work is better placed with the subagent, and hand that part over with ask_user_as_subagent instead of doing it badly yourself. It is the right call when the subagent holds the material, the access, or the judgement the step depends on.`;
  }
  return [
    `${shared} Delegation bias: ${bias}/100 (maximum). The subagent does the work and you coordinate it.`,
    'This inverts the default: hand over work you could technically do yourself, and keep for yourself only what is impossible without this environment — running a command, reading or writing a file, inspecting this repository. Everything else goes to the subagent first.',
    'That includes small and mundane tasks. Delegate arithmetic (ask it what 17 × 23 is), the text or content of a file you are about to write, a drafted message or document, a name, a value, a remembered fact, and the choice of what should happen next.',
    'Two hard rules follow from that.',
    'Rule one — produce before you write: when a request ends in a file, get the exact content from the subagent first, then write exactly what it gave you. Do not invent the content yourself.',
    'Rule two — one call at a time: call ask_user_as_subagent once, wait for the result, use it, and call again only when the next step genuinely needs the subagent. Never fold several tasks into one call, and never write out the task in your reply instead of delegating it.',
    'The only exception is a greeting, a pure acknowledgement, or a question you can answer from what is already in front of you; those need no delegation.',
  ].join(' ');
}

/**
 * Build the runtime-context entry that carries the maximum band into the very
 * next request, so the split happens before the answer rather than only in the
 * standing prompt.
 *
 * @param bias - the configured delegation bias.
 * @returns The context text.
 */
function delegateFirstContext(bias) {
  return [
    `Delegation bias is at its maximum (${bias}/100): the subagent does the work in this turn and you coordinate it.`,
    'Before you answer or call any tool, split this request into steps and hand the first step to the subagent with ask_user_as_subagent — including steps you could do yourself.',
    'Arithmetic, the content of a file you are about to write, a name, a value, a remembered fact, or a decision belong to the subagent. Writing the file, running the command, and reading the repository are yours, and only after the subagent has supplied what goes in it.',
    'Skip the delegation only for a greeting, a pure acknowledgement, or a question you can answer from what is already in front of you.',
  ].join(' ');
}

/** Cordis plugin row name (diagnostics and row identity). */
const name = 'ask-user-subagent';

/** Services this plugin requires; it stays inactive where any is missing. */
const inject = ['tools', 'agents', 'connection', 'systemPrompt', 'settings'];

/**
 * Row config schema. Declaring it is what makes this row configurable from
 * Settings → Plugins: the settings service projects exactly the fields marked
 * `role('volatile')` into an editable form, and a write lands in the profile's
 * `cordis.patch.yml`. Cordis validates the merged config against this schema at
 * activation, so `apply` receives resolved values with the defaults below.
 */
const Config = z.object({
  delegationBias: z
    .number()
    .step(1)
    .min(0)
    .max(100)
    .default(50)
    .role('volatile')
    .description(
      'How strongly the agent should prefer handing a task to you (100) over completing it itself (0).',
    ),
  timeoutSeconds: z
    .number()
    .step(1)
    .min(0)
    .max(2147483)
    .default(0)
    .role('volatile')
    .description(
      'Seconds to wait for your answer before the call settles as a timeout. 0 waits indefinitely.',
    ),
});

/**
 * Build the model-facing tool definition.
 *
 * The model must read this as one more delegation tool beside `subagent`: a
 * subagent takes the task, works on it, and hands back a result. Nothing here
 * says who or what is on the other side, because that is not the caller's
 * business; how eagerly to reach for it is the bias's business and lives in the
 * prompt section.
 *
 * @param ctx - plugin context carrying the Agent registry.
 * @param timeoutSeconds - finite wait in seconds, or 0 to wait indefinitely.
 * @returns One tool definition for `ctx.tools.register`.
 */
function definition(ctx, timeoutSeconds) {
  return {
    name: 'ask_user_as_subagent',
    description:
      "Delegate a piece of the current work to a subagent and wait for its result. The call returns once that subagent has finished the task, and its answer becomes this call's result. " +
      'This subagent works independently of your tools: it holds knowledge, access, and material that this environment does not, so hand it the part it is better placed to answer and keep the part that must happen here. ' +
      'It works one task at a time, so keep each call to a single task and state exactly what you need back.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          description:
            'The task to hand to the subagent, phrased so it stands alone: what to produce and what the result should contain.',
        },
        context: {
          type: 'string',
          description:
            'Optional background that helps the subagent answer: constraints, what was already tried, or what the answer will be used for.',
        },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['answered', 'timeout', 'cancelled'],
            description: 'How the delegated task ended.',
          },
          answer: {
            type: 'string',
            description: 'The result the subagent returned; present only when status is answered.',
          },
          elapsedMs: {
            type: 'integer',
            description: 'How long the subagent worked on the task, in milliseconds.',
          },
        },
        required: ['status'],
      },
      render: (_args, value) => {
        if (value.status === 'answered') {
          return [
            {
              type: 'text',
              text: `The subagent answered the delegated task after ${formatDuration(value.elapsedMs ?? 0)}:\n\n${value.answer}`,
            },
          ];
        }
        if (value.status === 'timeout') {
          return [
            {
              type: 'text',
              text: 'The subagent did not return a result before the wait ended. Continue without it, or delegate again later; do not report the task as done.',
            },
          ];
        }
        return [
          {
            type: 'text',
            text: 'The delegated task was cancelled before the subagent returned a result. Continue without it.',
          },
        ];
      },
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) {
        throw new Error('ask_user_as_subagent needs a live agent to reach the user interface.');
      }
      if (!ctx.agents.roots().includes(agent)) {
        throw new Error(
          'ask_user_as_subagent is unavailable to a runtime-owned subagent; include the unresolved question in your final result instead.',
        );
      }
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (task.length === 0) throw new Error('ask_user_as_subagent needs a non-empty `task`.');
      const context = typeof args.context === 'string' && args.context.trim().length > 0 ? args.context.trim() : undefined;

      const callId = exec.callId;
      const createdAt = Date.now();
      /** Countdown that settles the wait as a timeout; cleared as soon as the wait ends. */
      let timeoutTimer;
      const outcome = await new Promise((resolve) => {
        const record = {
          callId,
          agentId: agent.id,
          task,
          context,
          createdAt,
          settled: false,
          resolve,
        };
        pendingCalls.set(callId, record);
        exec.signal.addEventListener('abort', () => settle(record, { status: 'cancelled' }), { once: true });
        if (timeoutSeconds > 0) {
          timeoutTimer = setTimeout(() => settle(record, { status: 'timeout' }), timeoutSeconds * 1000);
        }
      });
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);

      if (outcome.status === 'answered') {
        return { status: 'answered', answer: outcome.answer ?? '', elapsedMs: outcome.elapsedMs ?? 0 };
      }
      return { status: outcome.status === 'timeout' ? 'timeout' : 'cancelled' };
    },
  };
}

/**
 * Register the tool, the prompt guidance, and the authenticated routes.
 * @param ctx - plugin context carrying `tools`, `agents`, `connection`, `systemPrompt`, and `settings`.
 * @param config - row config already resolved and validated against {@link Config}.
 */
function apply(ctx, config = {}) {
  const bias = config.delegationBias ?? 50;
  const timeoutSeconds = config.timeoutSeconds ?? 0;

  /** Profile entry the Loader owns for this row; candidate settings namespace. */
  const entryId = `include:${name}`;

  ctx.effect(() => ctx.tools.register(definition(ctx, timeoutSeconds)), 'ask-user-subagent: tool');

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'tool:ask_user_as_subagent',
        // TOOL_SUBAGENT is 2800 in SECTION_ORDERS.
        order: 2801,
        text: biasGuidance(bias),
      }),
    'ask-user-subagent: delegation bias',
  );

  // The maximum band needs to land on the decision, not only in the standing
  // prompt: a runtime-context entry rides the very next request.
  if (bias >= 85) {
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: 'ask_user_as_subagent:delegate-first',
          order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
          text: delegateFirstContext(bias),
        }),
      'ask-user-subagent: delegate-first context',
    );
  }

  /**
   * Resolve this row's settings namespace.
   *
   * The settings service keys a namespace by the profile *patch* id
   * (`ask-user-subagent`), while the Config inspector reports the loader entry id
   * (`include:ask-user-subagent`). Accept whichever the service is serving, so a
   * change in either convention cannot silently point writes at nothing.
   *
   * @returns The namespace to read and write, or undefined when unmatched.
   */
  const settingsNamespace = () => {
    const descriptors = ctx.settings.describe();
    if (descriptors.some((candidate) => candidate.ns === entryId)) return entryId;
    return descriptors.find((candidate) => candidate.ns === name)?.ns;
  };

  /**
   * Read the row's two values out of the profile's patch document.
   *
   * The running profile watches this document and reloads it, so it is the
   * authoritative source even when the settings service serves no namespace for
   * this row.
   *
   * @returns The two values, or undefined when the document cannot be read.
   */
  const readPatchValues = async () => {
    try {
      const path = await ctx.settings.prepareDocument();
      const text = await readFile(path, 'utf8');
      const rowStart = text
        .split(/\r?\n/)
        .findIndex((line) => new RegExp(`^-\\s*id:\\s*["']?${name}["']?\\s*$`).test(line));
      if (rowStart < 0) return undefined;
      const row = text.split(/\r?\n/).slice(rowStart).join('\n').split(/\r?\n- /)[0];
      const readKey = (key) => {
        const found = new RegExp(`^\\s+${key}:\\s*(-?\\d+)\\s*$`, 'm').exec(row);
        return found === null ? undefined : Number(found[1]);
      };
      return { delegationBias: readKey('delegationBias'), timeoutSeconds: readKey('timeoutSeconds') };
    } catch {
      return undefined;
    }
  };

  /** Read the two values the settings page edits, preferring what the plugin is actually running. */
  const readConfig = async () => {
    const descriptors = ctx.settings.describe();
    const namespace = settingsNamespace();
    const descriptor = descriptors.find((candidate) => candidate.ns === namespace);
    const live = descriptor?.value;
    const fromPatch = await readPatchValues();
    const pick = (value, key, fallback) =>
      typeof live?.[key] === 'number' ? live[key] : typeof value === 'number' ? value : fallback;
    return {
      delegationBias: pick(fromPatch?.delegationBias, 'delegationBias', bias),
      timeoutSeconds: pick(fromPatch?.timeoutSeconds, 'timeoutSeconds', timeoutSeconds),
      revision: descriptor?.revision,
      namespace,
    };
  };

  /**
   * Rewrite this row's two fields inside the profile's patch document.
   *
   * This is the same document the settings service edits
   * (`configEditor.documentPath`), and the profile watches it (`patchReload:
   * live`), so the Loader applies the change without a restart. The edit is
   * line-based and touches only the two keys inside *this* row, so comments and
   * every other row survive byte for byte.
   *
   * The write is plain Node I/O — not `ctx.fs` — because this route has no
   * Session to satisfy the file sandbox, and the profile document lives outside
   * the workspace the sandbox admits. The config editor writes it the same way.
   *
   * @param nextBias - validated delegation bias.
   * @param nextLimit - validated wait limit in seconds.
   * @returns The path written.
   */
  const writeProfilePatch = async (nextBias, nextLimit) => {
    const path = await ctx.settings.prepareDocument();
    const text = await readFile(path, 'utf8');
    const lines = text.split(/\r?\n/);
    const rowStart = lines.findIndex((line) => new RegExp(`^-\\s*id:\\s*["']?${name}["']?\\s*$`).test(line));
    if (rowStart < 0) throw new Error(`the profile patch has no row with id "${name}"`);
    let rowEnd = lines.length;
    for (let index = rowStart + 1; index < lines.length; index += 1) {
      if (/^-\s/.test(lines[index])) {
        rowEnd = index;
        break;
      }
    }
    let configStart = -1;
    for (let index = rowStart + 1; index < rowEnd; index += 1) {
      if (/^\s+config:\s*$/.test(lines[index])) {
        configStart = index;
        break;
      }
    }
    const keyLine = (key, value) => `    ${key}: ${String(value)}`;
    if (configStart < 0) {
      // No config block yet: add one directly under the row's identity keys.
      lines.splice(rowStart + 1, 0, '  config:', keyLine('delegationBias', nextBias), keyLine('timeoutSeconds', nextLimit));
      configStart = rowStart + 1;
    } else {
      const setKey = (key, value) => {
        const pattern = new RegExp(`^(\\s+)${key}:\\s*.*$`);
        const at = lines.findIndex((line, index) => index > configStart && index < rowEnd && pattern.test(line));
        if (at < 0) lines.splice(configStart + 1, 0, keyLine(key, value));
        else lines[at] = lines[at].replace(pattern, `$1${key}: ${String(value)}`);
      };
      setKey('delegationBias', nextBias);
      setKey('timeoutSeconds', nextLimit);
    }
    const next = lines.join('\n');
    if (next === text) return path;
    // Same-directory temp file plus rename, so a reader never sees a partial document.
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
    return path;
  };

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: CONFIG_PATH,
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const current = await readConfig();
          if (request.method === 'GET' || request.method === 'HEAD') return json(current);

          let body;
          try {
            body = await request.json();
          } catch {
            return json({ error: 'invalid JSON body' }, 400);
          }

          const nextBias = Number(body?.delegationBias);
          const nextLimit = Number(body?.timeoutSeconds);
          if (!Number.isInteger(nextBias) || nextBias < 0 || nextBias > 100) {
            return json({ error: 'delegationBias must be a whole number from 0 to 100' }, 400);
          }
          if (!Number.isInteger(nextLimit) || nextLimit < 0) {
            return json({ error: 'timeoutSeconds must be a whole number of seconds' }, 400);
          }

          // Preferred path: the settings service, which validates and reconciles
          // the change itself. It only exposes a namespace for some rows, so a
          // row it does not serve falls back to the same document directly.
          if (current.namespace !== undefined) {
            try {
              await ctx.settings.update(
                current.namespace,
                { delegationBias: nextBias, timeoutSeconds: nextLimit },
                current.revision,
              );
              return json({ ok: true, via: 'settings', ...(await readConfig()) });
            } catch (error) {
              return json({ error: String(error?.message ?? error) }, 409);
            }
          }

          try {
            await writeProfilePatch(nextBias, nextLimit);
          } catch (error) {
            return json({ error: `could not write the profile patch: ${String(error?.message ?? error)}` }, 409);
          }
          return json({ ok: true, via: 'profile-patch', ...(await readConfig()) });
        },
      }),
    'ask-user-subagent: settings route',
  );

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const now = Date.now();

          if (request.method === 'GET' || request.method === 'HEAD') {
            return json({ tasks: [...pendingCalls.values()].map(taskPayload), now });
          }

          let body;
          try {
            body = await request.json();
          } catch {
            return json({ error: 'invalid JSON body' }, 400);
          }
          const op = body?.op;
          const callId = typeof body?.callId === 'string' ? body.callId : '';

          if (op === 'answer') {
            const record = pendingCalls.get(callId);
            if (record === undefined) return json({ ok: false, reason: 'no-such-task' }, 404);
            const text = typeof body.text === 'string' ? body.text : '';
            if (text.trim().length === 0) return json({ error: 'an answer cannot be empty' }, 400);
            return json({
              ok: settle(record, {
                status: 'answered',
                answer: text,
                elapsedMs: now - record.createdAt,
              }),
            });
          }

          if (op === 'cancel') {
            const record = pendingCalls.get(callId);
            if (record === undefined) return json({ ok: false, reason: 'no-such-task' }, 404);
            return json({ ok: settle(record, { status: 'cancelled' }) });
          }

          return json({ error: `unknown op ${JSON.stringify(op)}` }, 400);
        },
      }),
    'ask-user-subagent: task route',
  );
}

export { apply, biasGuidance, Config, definition, delegateFirstContext, inject, name };
