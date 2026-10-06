/**
 * Client half of the "delegate to the user" bundle.
 *
 * Renders the task card the user answers on: it shows the task the agent
 * handed over, counts how long the task has been waiting, and submits the typed
 * answer back to the Host. The entry lives in `shell.overlay` so the card is
 * visible from any Session while the agent blocks on it.
 *
 * @module @local/ask-user-subagent/client
 */

window.__ModuleLoader__.load({
  id: '@local/ask-user-subagent',
  factory(require) {
    const React = require('react');

    /** Authenticated Host route that owns the pending-task state. */
    const ROUTE = '/api/local/ask-user-subagent/tasks';

    /** Authenticated Host route that reads and writes the row config. */
    const CONFIG_ROUTE = '/api/local/ask-user-subagent/config';

    /** Card copy, keyed by interface language. */
    const STRINGS = {
      en: {
        header: 'Task delegated to you',
        hint: 'The agent is waiting for your answer.',
        task: 'Task',
        context: 'Context',
        placeholder: 'Type your answer, then submit it to the agent…',
        submit: 'Submit to agent',
        busy: 'Sending…',
        handBack: 'Hand back',
        empty: 'Type an answer before submitting.',
        failed: 'Could not reach the agent. Keep this card open and try again.',
      },
      zh: {
        header: '主 Agent 派发给你的任务',
        hint: '主 Agent 正在等待你的回复。',
        task: '任务',
        context: '背景',
        placeholder: '输入你的回复，然后提交给主 Agent…',
        submit: '提交给主 Agent',
        busy: '提交中…',
        handBack: '交回任务',
        empty: '请先输入内容再提交。',
        failed: '无法连接主 Agent，请保留此卡片后重试。',
      },
    };

    /** Resolve the dictionary for the current interface language. */
    function strings() {
      const language = typeof navigator === 'object' && typeof navigator.language === 'string' ? navigator.language : 'en';
      return language.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;
    }

    /** Pick one of two texts for the current interface language. */
    function pick(en, zh) {
      return strings() === STRINGS.zh ? zh : en;
    }

    /** The bias band's meaning, phrased for the settings form. */
    function biasBand(bias) {
      if (bias < 25) return pick('Low — the agent works alone unless it is blocked.', '低 —— 除非真的卡住，否则自己做完。');
      if (bias < 60) return pick('Balanced — delegates when human input is needed.', '平衡 —— 需要人类输入时才派发。');
      if (bias < 85) return pick('High — prefers delegating to you.', '偏高 —— 倾向于派发给你。');
      return pick('Very high — delegates whenever you could help.', '很高 —— 只要你能帮上就派发。');
    }

    /** `mm:ss`, or `h:mm:ss` past an hour. */
    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const pad = (value) => String(value).padStart(2, '0');
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    }

    /** Poll interval while a card is open. */
    const POLL_MS = 1500;

    /**
     * The frame-wide task card. Renders nothing while no task is pending.
     * @returns The card element, or null.
     */
    function TaskCard() {
      const [task, setTask] = React.useState(null);
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [now, setNow] = React.useState(() => Date.now());

      // Poll the Host for the pending task. One task is pending at a time: the
      // agent's tool call blocks until this card submits an answer.
      React.useEffect(() => {
        let live = true;
        let timer;
        const poll = async () => {
          try {
            const response = await fetch(ROUTE, { credentials: 'include' });
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
            const body = await response.json();
            const first = Array.isArray(body.tasks) && body.tasks.length > 0 ? body.tasks[0] : null;
            if (live) {
              setTask((current) => (current?.callId === first?.callId ? current : first));
              setNow(typeof body.now === 'number' ? body.now : Date.now());
            }
          } catch {
            // A transient transport failure keeps the last card; the next poll retries.
          } finally {
            if (live) timer = window.setTimeout(poll, POLL_MS);
          }
        };
        void poll();
        return () => {
          live = false;
          window.clearTimeout(timer);
        };
      }, []);

      const callId = task?.callId ?? null;

      // A new task starts from an empty answer.
      React.useEffect(() => {
        setText('');
        setError('');
      }, [callId]);

      // Isolated from the poll so the countdown ticks every second.
      const waiting = callId !== null;
      React.useEffect(() => {
        if (!waiting) return undefined;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
      }, [waiting]);

      if (task === null) return null;

      const copy = strings();
      const elapsed = now - (typeof task.startedAt === 'number' ? task.startedAt : now);

      const send = async (op, extra) => {
        setBusy(true);
        setError('');
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op, callId: task.callId, ...extra }),
          });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const body = await response.json();
          if (body.ok !== true) throw new Error('the task is no longer pending');
          setTask(null);
          return true;
        } catch {
          setError(copy.failed);
          return false;
        } finally {
          setBusy(false);
        }
      };

      const submit = async () => {
        if (text.trim().length === 0) {
          setError(copy.empty);
          return;
        }
        await send('answer', { text });
      };

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void submit();
        }
      };

      return React.createElement(
        'div',
        { className: 'aus-backdrop' },
        React.createElement(
          'section',
          {
            className: 'aus-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': copy.header,
          },
          React.createElement(
            'header',
            { className: 'aus-header' },
            React.createElement('span', { className: 'aus-dot', 'aria-hidden': 'true' }),
            React.createElement(
              'div',
              { className: 'aus-heading' },
              React.createElement('h2', { className: 'aus-title' }, copy.header),
              React.createElement('p', { className: 'aus-hint' }, copy.hint),
            ),
            React.createElement(
              'span',
              { className: 'aus-timer', title: 'time since the agent asked', role: 'timer' },
              formatElapsed(elapsed),
            ),
          ),
          React.createElement(
            'div',
            { className: 'aus-body' },
            React.createElement('p', { className: 'aus-label' }, copy.task),
            React.createElement('p', { className: 'aus-task' }, task.task),
            task.context.length > 0
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement('p', { className: 'aus-label' }, copy.context),
                  React.createElement('p', { className: 'aus-context' }, task.context),
                )
              : null,
            React.createElement('textarea', {
              className: 'aus-input',
              value: text,
              autoFocus: true,
              rows: 5,
              placeholder: copy.placeholder,
              disabled: busy,
              onChange: (event) => setText(event.target.value),
              onKeyDown,
            }),
            error.length > 0 ? React.createElement('p', { className: 'aus-error', role: 'alert' }, error) : null,
          ),
          React.createElement(
            'footer',
            { className: 'aus-footer' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'aus-button aus-button-quiet',
                disabled: busy,
                onClick: () => void send('cancel', {}),
              },
              copy.handBack,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'aus-button aus-button-primary',
                disabled: busy,
                onClick: () => void submit(),
              },
              busy ? copy.busy : copy.submit,
            ),
          ),
        ),
      );
    }

    /** Card styles. Only `--dsw-alias-*` theme tokens are referenced. */
    const CSS = `
.aus-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  pointer-events: auto;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);
}
.aus-card {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: calc(100vh - 96px);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 12px 40px color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.55;
}
.aus-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.aus-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
  animation: aus-pulse 1.4s ease-in-out infinite;
}
@keyframes aus-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.aus-heading { min-width: 0; flex: 1; }
.aus-title { margin: 0; font-size: 15px; font-weight: 600; }
.aus-hint { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.aus-timer {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.aus-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px;
}
.aus-label {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.aus-task {
  margin: 0 0 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.aus-context {
  margin: 0 0 6px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.aus-input {
  width: 100%;
  min-height: 96px;
  margin-top: 4px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  resize: vertical;
}
.aus-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.aus-input::placeholder { color: var(--dsw-alias-label-secondary); }
.aus-error {
  margin: 4px 0 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.aus-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.aus-button {
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid transparent;
  font: inherit;
  cursor: pointer;
}
.aus-button:disabled { cursor: default; opacity: 0.6; }
.aus-button-quiet {
  border-color: var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.aus-button-primary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 600;
}
.aus-config {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 520px;
  font-size: 14px;
}
.aus-summary {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}
.aus-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.aus-field-label { font-weight: 600; }
.aus-field-help {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.aus-field-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aus-number {
  width: 96px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.aus-number:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.aus-band {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.aus-config-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aus-status { font-size: 12px; }
.aus-status-ok { color: var(--dsw-alias-state-success-primary); }
.aus-status-error { color: var(--dsw-alias-state-error-primary); }
`;

    /**
     * One editable field of the settings page.
     * @returns The field's element.
     */
    function ConfigNumber(props) {
      return React.createElement(
        'label',
        { className: 'aus-field' },
        React.createElement('span', { className: 'aus-field-label' }, props.label),
        React.createElement(
          'span',
          { className: 'aus-field-row' },
          React.createElement('input', {
            className: 'aus-number',
            type: 'number',
            min: props.min,
            max: props.max,
            step: 1,
            value: props.value,
            disabled: props.disabled,
            onChange: (event) => props.onChange(event.target.value),
          }),
          React.createElement('span', { className: 'aus-field-help' }, props.unit),
        ),
        props.help === undefined ? null : React.createElement('p', { className: 'aus-field-help' }, props.help),
      );
    }

    /**
     * The row's configuration page, shown from Settings → Plugins.
     *
     * It owns its own reader and writer over the plugin's Host route instead of
     * the page's `form` share, because the settings page is dispatched the
     * `form` only for namespaces its own projection lists; owning the round trip
     * keeps this page working regardless of that share.
     *
     * @returns The form in `view: 'page'`, or the one-line summary.
     */
    function SettingsPage(props) {
      const [live, setLive] = React.useState(null);
      const [bias, setBias] = React.useState('50');
      const [limit, setLimit] = React.useState('0');
      const [status, setStatus] = React.useState('idle');
      const [reason, setReason] = React.useState('');
      const [firstLoad, setFirstLoad] = React.useState(true);
      const [dirty, setDirty] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(CONFIG_ROUTE, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const body = await response.json();
          setLive(body);
          setStatus('idle');
        } catch {
          setStatus('failed');
        } finally {
          setFirstLoad(false);
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      // Seed the drafts from the Host reading, and re-seed after a save.
      React.useEffect(() => {
        if (live === null || dirty) return;
        setBias(String(live.delegationBias));
        setLimit(String(live.timeoutSeconds));
      }, [live, dirty]);

      if (props.view === 'summary') {
        return live === null
          ? pick('Bias and wait limit for handing tasks to you.', '把任务派发给你的倾向值与等待上限。')
          : pick(
              `Delegation bias ${String(live.delegationBias)}/100 · ${biasBand(Number(live.delegationBias))}`,
              `派发倾向 ${String(live.delegationBias)}/100 · ${biasBand(Number(live.delegationBias))}`,
            );
      }

      const biasValue = Number(bias);
      const limitValue = Number(limit);
      const valid =
        Number.isInteger(biasValue) &&
        biasValue >= 0 &&
        biasValue <= 100 &&
        Number.isInteger(limitValue) &&
        limitValue >= 0;

      const save = async () => {
        if (!valid) return;
        setStatus('saving');
        setReason('');
        try {
          const response = await fetch(CONFIG_ROUTE, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delegationBias: biasValue, timeoutSeconds: limitValue }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.ok !== true) {
            setStatus('refused');
            // The Host's own wording plus the namespaces it does serve, so a
            // refusal is diagnosable from the page alone.
            const detail = typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`;
            const known = Array.isArray(body.availableNamespaces) ? ` [${body.availableNamespaces.join(', ')}]` : '';
            setReason(`${detail}${known}`);
            return;
          }
          setDirty(false);
          setLive({
            delegationBias: body.delegationBias ?? biasValue,
            timeoutSeconds: body.timeoutSeconds ?? limitValue,
          });
          setStatus('saved');
        } catch (error) {
          setStatus('failed');
          setReason(String(error?.message ?? error));
        }
      };

      const statusText =
        status === 'saved'
          ? pick('Saved. It applies to the next step.', '已保存，下一步生效。')
          : status === 'refused'
            ? pick(`The Host refused the change: ${reason}`, `Host 拒绝了这次修改：${reason}`)
            : status === 'failed'
              ? pick(`Could not reach the Host: ${reason}`, `无法连接 Host：${reason}`)
              : !valid
                ? pick('Bias is 0–100 and the limit is a whole number.', '倾向值为 0–100，等待上限为整数。')
                : dirty
                  ? pick('Unsaved changes.', '有未保存的修改。')
                  : '';

      const disabled = status === 'saving' || firstLoad;
      const field = (key) => ({
        disabled,
        onChange: (next) => {
          if (key === 'bias') setBias(next);
          else setLimit(next);
          setDirty(true);
          setStatus('idle');
        },
      });
      const biasField = field('bias');
      const limitField = field('limit');

      return React.createElement(
        'div',
        { className: 'aus-config', 'data-plugin-config-form': 'ask-user-subagent' },
        React.createElement(ConfigNumber, {
          label: pick('Delegation bias', '派发倾向'),
          value: bias,
          min: 0,
          max: 100,
          unit: '/ 100',
          help: Number.isFinite(biasValue) ? biasBand(biasValue) : undefined,
          disabled: biasField.disabled,
          onChange: biasField.onChange,
        }),
        React.createElement(ConfigNumber, {
          label: pick('Wait limit (seconds)', '等待上限（秒）'),
          value: limit,
          min: 0,
          max: 2147483,
          unit: pick('0 = wait indefinitely', '0 = 一直等待'),
          help: pick(
            'How long the agent waits for your answer before the call settles as a timeout.',
            'Agent 等待你回答的最长时间，超时后该次调用以超时结束。',
          ),
          disabled: limitField.disabled,
          onChange: limitField.onChange,
        }),
        React.createElement(
          'p',
          { className: 'aus-field-help' },
          pick(
            'This is a tendency, not a guarantee: it raises or lowers how readily the agent reaches for the task card. A request the agent can finish on its own — a greeting, a question about this machine — still gets no card.',
            '这是一个倾向值，不是强制开关：它决定 Agent 多愿意弹出任务卡片。它自己能完成的事（打招呼、问本机上的事）依然不会弹卡片。',
          ),
        ),
        React.createElement(
          'div',
          { className: 'aus-config-actions' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'aus-button aus-button-primary',
              disabled: !valid || disabled,
              onClick: () => void save(),
            },
            status === 'saving' ? pick('Saving…', '保存中…') : pick('Save', '保存'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'aus-button aus-button-quiet',
              disabled: disabled,
              onClick: () => {
                setDirty(false);
                void load();
              },
            },
            pick('Reload', '重新读取'),
          ),
          statusText.length === 0
            ? null
            : React.createElement(
                'span',
                {
                  className: `aus-status ${status === 'saved' ? 'aus-status-ok' : status === 'idle' ? '' : 'aus-status-error'}`,
                  role: 'status',
                },
                statusText,
              ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The overlay layer is click-through, so the card opts back in.
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'ask-user-subagent';
          tag.textContent = CSS;
          document.head.append(tag);
          return () => tag.remove();
        }, 'ask-user-subagent: styles');

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'ask-user-subagent', order: 60 }, TaskCard),
        );

        // Settings → Plugins: the bundle's row gains a configure control that
        // opens this page. The key is `<package name>#<row id>`.
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: '@local/ask-user-subagent#ask-user-subagent' },
            SettingsPage,
          ),
        );
      },
    };
  },
});
