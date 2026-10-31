# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-31

### Added

- `subagentDescription` setting: free text (≤ 2000 characters) on the plugin's
  settings page that tells the main agent what this subagent is — what it is
  good at, and what kind of task to hand it. It is injected into the agent's
  system prompt as its own section (`tool:ask_user_as_subagent:brief`, order
  2802) and is flattened to a single line before it reaches the prompt, so a
  newline or heading in the text cannot become prompt structure.
- The description is written back to the profile patch as a double-quoted
  single-line YAML scalar, so `:`, `#`, or quotes inside it cannot break the
  document.
- `.gitattributes` normalizing line endings to LF in the repository.

### Changed

- The settings page gained a textarea for the description, a character counter,
  and the description's opening text in the row summary.

### Unchanged

- Existing config keys keep their meaning and defaults; an empty
  `subagentDescription` registers no extra prompt section at all, so a
  deployment that never touches the setting reads exactly as before.

## [1.0.0] - 2026-10-06

### Added

- `ask_user_as_subagent` Host tool: the agent delegates a task to the user.
- Timed task card in the Harness Web UI (`shell.overlay`).
- `delegationBias` (0–100) live setting that reshapes the agent's prompt section.
- `timeoutSeconds` wait limit; `0` waits indefinitely.
- Settings page at Settings → Plugins, persisting through the settings service
  when it serves a namespace and through the profile patch otherwise.
- Localized card and metadata in English and Chinese.
