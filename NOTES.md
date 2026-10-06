# ask-user-subagent — living notes

## Bundle facts

- Package: `@local/ask-user-subagent`, installed into the profile from this repository directory
  (`link:` dependency).
- Row id: `ask-user-subagent`, config `delegationBias` (0–100, default 50) and `timeoutSeconds` (0 = wait forever).
- Tool: `ask_user_as_subagent` (Host half, `index.js`).
- Client entry: `shell.overlay` id `ask-user-subagent` (Client half, `client.js`).
- Transport: authenticated `ctx.connection.fetch` route `/api/local/ask-user-subagent/tasks`
  (GET = pending tasks, POST = `answer` / `cancel`). It must keep the `/api` prefix: the
  Connection carrier only serves exact fetch routes under that prefix.

## Verified

- `node dev/verify-host.mjs` — 24 checks against the real Host module over real HTTP:
  registration, prompt-section rendering per bias band, pending-task visibility,
  answer / cancel / abort settlement, empty-input rejection, subagent refusal, unknown-op handling.
- Live Host inspection: `ask_user_as_subagent` is in the Agent's tool list.
- Live Client inspection: slot `shell.overlay` occupant `ask-user-subagent` is `active`.
- Live end-to-end through the GUI: the card rendered the task, the timer ran, and a submitted
  answer came back as the tool result (`The user answered the delegated task after 22s: 测试通过`).
- Live cancel path: the card's "hand back" action returned `cancelled`.
- Live bias change: setting `delegationBias: 80` in the profile patch layer replaced the running
  Agent's prompt section (`Delegation bias: 80/100 (high)`) without a restart, so the knob is
  tunable at runtime.

## Not yet verified

- The `timeoutSeconds` path live (this profile sets 0 = wait forever); the host harness covers
  that same code path with a real timer.
- The card's appearance in light and dark themes: registration and the round trip were observed,
  but not a screenshot of either theme.

## Environment note

The profile's own `cordis.patch.yml` holds this row's live config (currently `delegationBias: 80`).
That layer replaces the bundle's `config` whole, so any key the bundle declares must be repeated
there — `timeoutSeconds` is repeated for exactly that reason.

## Gotchas

- Host `apply()` receives the raw row config; cordis only accepts a schemastery
  Standard Schema for `Config`, so this bundle declares none and validates its two
  keys itself. A plain JSON Schema in `Config` would throw `ValidationError` at activation.
- An installed bundle's client half is plain JavaScript in the module table: no JSX and
  no Harness Client package imports. The task card therefore builds its DOM with
  `React.createElement` and styles itself with `--dsw-alias-*` tokens only.
- The client half polls the Host route every 1.5 s while mounted; there is no push channel.
- `plugin_manager` needs a working `pnpm` on the PATH. If a Corepack-managed pnpm is not
  exposed globally, add a shim that delegates to it; without one every install fails with
  exit code 1.
- The Host loads a plugin module once per process. Editing `index.js` does not affect a running
  Host — restart `dsh web` after a Host-half change (a client-half change is served fresh).
