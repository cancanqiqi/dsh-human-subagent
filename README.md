# dsh-human-subagent

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that lets the **agent hand a task to you, the user**, instead of doing it itself.

It registers a Host tool, `ask_user_as_subagent`. When the agent calls it, the Web UI shows a **timed task card** with the delegated task; you type an answer, hand it back, or let the timer run out. The answer becomes the tool result.

这是一个 dsh 插件：主 Agent 将任务委派给该工具后，Web UI 会显示用户任务卡片；用户提交的内容作为调用结果返回，在 Agent 看来就像普通子 Agent 的回复。

How readily the agent delegates is controlled by a single **delegation bias** setting, which is injected into the agent's system prompt.

## Features

- `ask_user_as_subagent` Host tool — the agent delegates a task to the user.
- Timed task card rendered in the Harness Web UI (`shell.overlay`).
- Live `delegationBias` knob (0–100) that reshapes the agent's prompt section at runtime.
- Optional `timeoutSeconds` wait limit; `0` waits indefinitely.
- Localized card/metadata in English and Chinese (`locale/en.json`, `locale/zh.json`).

## Requirements

- A working DSH installation with the Web UI (`dsh web`).
- The plugin's client half targets the Web platform only.

## Install

### 1. Install the package into your profile

The package is published here as a GitHub repository, and DSH installs bundles through the Plugin Manager.

**From the Web UI:** open the Plugin Manager panel and install the bundle from the repository spec:

```
github:cancanqiqi/dsh-human-subagent
```

**From the CLI**, using the profile you actually boot:

```bash
dsh plugin --profile <your-profile> install github:cancanqiqi/dsh-human-subagent
```

Either way, DSH runs pnpm for you, adds the package to the profile's dependencies, and selects it as a bundle. Do not hand-edit the profile's `package.json` for this.

### 2. Enable it

If it does not activate immediately, enable the row in the Plugin Manager. A newly installed bundle usually activates through HMR; replacing an already-installed package needs a `dsh web` restart before the fresh JavaScript module generation loads.

### 3. Configure (optional)

The profile's `cordis.patch.yml` holds this row's live config, and **that layer replaces the bundle's `config` wholesale**. Repeat every key you want to keep:

```yaml
- id: ask-user-subagent
  config:
    delegationBias: 80
    timeoutSeconds: 0
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `delegationBias` | number, 0–100 | `50` | `0` — the agent almost always does the work itself. `50` — balanced. `100` — it looks for every reasonable chance to hand a task to you. |
| `timeoutSeconds` | number | `0` | Seconds the agent waits for your answer before the call settles as a timeout. `0` waits indefinitely. |

Both keys are validated by the plugin itself. A change to `delegationBias` takes effect without a restart.

## Usage

Once active, the agent gains the `ask_user_as_subagent` tool. There is nothing to call by hand — the agent decides when to delegate, guided by `delegationBias`. When it does, a card appears over the Web UI:

- **Submit** — your answer is returned to the agent as the tool result.
- **Hand back** — the call settles as `cancelled`.
- The timer — the call settles as a timeout once `timeoutSeconds` elapses.

## Develop

```bash
pnpm install          # or npm install
npm run verify        # 24-check Host harness over real HTTP
npm run verify:config # config/shape checks
```

`dev/verify-host.mjs` exercises the real Host module over real HTTP: registration, prompt-section rendering per bias band, pending-task visibility, answer/cancel/abort settlement, empty-input rejection, subagent refusal, and unknown-op handling.

Host-side changes require a `dsh web` restart (a plugin module loads once per process). Client-side changes are served fresh.

## Notes

- The client half is plain JavaScript in the module table: no JSX and no Harness Client package imports. The card builds its DOM with `React.createElement` and styles itself using `--dsw-alias-*` theme tokens only.
- The client half polls the Host route every 1.5 s while mounted; there is no push channel.
- The transport keeps its `/api` prefix (`/api/local/ask-user-subagent/tasks`): the Connection carrier only serves exact fetch routes under that prefix.

## License

[MIT](./LICENSE) © 2025 惨戚 (cancanqiqi)
