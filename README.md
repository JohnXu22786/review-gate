# review-gate

[![npm version](https://img.shields.io/npm/v/review-gate)](https://www.npmjs.com/package/review-gate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[中文说明](./README.zh.md)

A **DeepSeek Harness (dsh) bundle** that turns code review into a hard gate.
Unlike read-only review/diff viewers, review-gate closes the loop: it produces
graded findings, blocks or passes merges deterministically, requires a team
approval quorum, and keeps a durable compliance audit trail — all wired to
`ctx.tools` and a standalone CLI for CI/hooks.

The gap it fills: in the ecosystem, review plugins observe a diff and add
annotations, but none of them **gate** the merge. review-gate makes review a
checkpoint that must pass before a PR/merge proceeds.

```
  git diff ──► run ──► findings
                        │  deterministic rules (severe/warning/suggestion)
                        ▼
                     gate ──► blocked / passed
                        │
                        ▼
                 team approval quorum ──► approved ⇢ merge unlocked
                        │
                        ▼
                 audit trail (time / person / conclusion / rules version)
```

---

## Features

1. **Review sessions** — review the working tree, staged changes, a single
   commit, or any `base..head` range. Findings are graded
   `severe` / `warning` / `suggestion`, produced per file/hunk by:
   - **deterministic static rules** (regex over added lines, never a model), and
   - **LLM-assisted findings** (optional). The model only ever *adds findings*;
     it can never bypass a threshold.
2. **Gate rules** — configurable thresholds (`severe = 0`, `warning ≤ N`,
   suggestions unlimited, manual-confirmation checklist). The pass/fail
   decision is computed by **deterministic rules** from the persisted round
   (findings + acknowledgements + votes) — fully reproducible, never a model
   judgment. If the auto-gate fails, no approval can unlock the merge.
3. **Team approval flow** — `approve` / `request_changes` / `reject` with a
   configurable quorum (N distinct approvals). Last-writer-wins per reviewer;
   a re-review (new round) invalidates stale approvals **and** stale
   acknowledgements.
4. **Compliance trail** — every run, vote, acknowledgement and export is
   appended to an immutable audit log (time, actor, conclusion, rules
   version), and can be exported as a JSON or Markdown report.
5. **CI collaboration** — every tool and CLI command emits machine-readable
   JSON and correct exit codes (`gate-check` exits non-zero until passable),
   ready for a GitHub Action / hook / branch protection.
6. **Lessons library** — optional: failed findings can be turned into reusable
   static rules by adding them to the rule set (see *Config*).
7. **Toolchain** — dsh tools `review_run`, `review_status`, `review_approve`,
   `review_request_changes`, `review_reject`, `review_acknowledge`,
   `gate_check`, `review_export`, plus a standalone `review-gate` CLI.

---

## How it works (short)

- A **session** is keyed by (stable repository identity, diff scope), so a
  committed trail keeps the same identity on any checkout or CI machine. A
  deterministic **fingerprint** of the diff + rules + policy identifies the
  reviewed content; running on unchanged content reuses the round (idempotent)
  and never duplicates audit entries.
- Findings have **stable ids** derived from their content, so acknowledgements
  and manual-confirmation lists survive identical re-runs. A *new* round
  (content or policy changed) requires fresh acknowledgements.
- The **gate** combines the auto-rules and the approval state into one status:

  | status | meaning |
  | --- | --- |
  | `open` | created, not yet reviewed (no round) |
  | `blocked` | auto-gate failed, or a `request_changes`/`reject` is active |
  | `passed` | auto-gate passed, approvals pending |
  | `approved` | auto-gate passed **and** quorum met, no blockers — merge unlocked |

- **Persistence** is a JSON file store with per-session atomic
  read-modify-write (in-process mutex + temp-write/fsync/rename), a
  cross-process lock file, and an append-only `audit.jsonl`.

---

## Project layout

```
review-gate/
├── package.json            # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml        # mounts the plugin row
├── tsconfig[.test].json
├── src/
│   ├── types.ts            # core domain types
│   ├── config.ts           # configuration, defaults, validation, rules
│   ├── git/diff.ts         # unified-diff parser (pure)
│   ├── git/runner.ts       # `git` interactions (injectable executor)
│   ├── analyzers/static.ts # deterministic regex analyzer
│   ├── analyzers/llm.ts    # optional LLM reviewer (lazy ctx.llm)
│   ├── gate/engine.ts      # deterministic auto-gate
│   ├── approval/flow.ts    # votes, quorum, last-writer-wins
│   ├── service/evaluate.ts # combined gate+approval verdict
│   ├── service/reviewGate.ts # the facade / public API
│   ├── store/              # durable + in-memory stores, file lock
│   ├── audit/report.ts     # compliance report rendering
│   ├── dsh/                # dsh adapter (tools, llm gateway, entry)
│   ├── cli.ts              # standalone CLI
│   └── index.ts            # programmatic API exports
├── test/                   # node:test suites (61 tests)
├── examples/
│   ├── review-gate.config.json   # full annotated config
│   └── github-action.yml         # CI gate workflow
├── README.md / README.zh.md
└── LICENSE
```

---

## Getting started

> Node.js ≥ 18 is enough for the standalone CLI and programmatic API. When
> running as a dsh bundle, the harness itself requires `^22.19.0 || >=24.0.0`
> (check the harness install docs). `git` must be on `PATH` and the target
> directory must be a git working tree.

### Install

```sh
npm install -g review-gate   # standalone CLI for any git repo
```

or install it as a dsh bundle (see below).

### Run the CLI

```sh
# from a git repo
review-gate run --json                 # review working tree vs HEAD
review-gate status --json
review-gate gate-check --mode merge    # exit 0 only when mergeable
```

Build & test locally:

```sh
npm install
npm run build          # → dist/
npm test               # → builds dist-test/ and runs node --test
node dist/cli.js run   # or: npm run cli -- run
```

### Install as a dsh bundle

`review-gate` follows the dsh bundle spec:

```js
// package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` inserts a `review-gate` row into the profile layer; override
its `config` per deployment (a patch replaces the whole row config; restate
every key). Install like any bundle:

```sh
dsh plugin --profile <name> add ./review-gate
dsh --profile <name> --patch ./review-gate/cordis.patch.yml
```

The plugin exports `name` / `inject` / `apply(ctx, config)` and registers the
tools on `ctx.tools` (see *dsh tools* below). LLM-assisted review is enabled
through `config.llm.enabled` and resolves `ctx.llm` lazily at call time, so a
later-mounted model layer is picked up automatically; when no model layer is
available the plugin records a `llm.warn` audit event and continues — findings
from the static rules still rule the gate.

### Configure

Place `<repo>/.review-gate.config.json` (used by the CLI) and/or the same
object in the plugin row's `config`:

```json
{
  "cwd": "/absolute/path/to/repo",
  "store": { "root": ".review-gate", "repoId": "github.com/acme/repo" },
  "gate": {
    "severe": 0,
    "warning": 0,
    "suggestion": -1,
    "requiredAcknowledge": []
  },
  "approvals": { "required": 2 },
  "llm": { "enabled": false },
  "onEmptyDiff": "pass",
  "maxFindings": 500,
  "rules": { /* custom static rules, merged over built-ins */ }
}
```

Run `review-gate init` to write an example file. See `examples/review-gate.config.json`.

`store.repoId` pins the stable identity used to key sessions so a committed
trail is readable from every checkout and CI. When unset it is derived from
`remote.origin.url`, then the git toplevel, then the working directory — see
*CI collaboration*.

**LLM-assisted review** is off by default. To enable it set `llm.enabled` and,
where your deployment does not route a default provider/model, `llm.provider`
and `llm.model`. LLM findings are counted by the same deterministic
thresholds; if the model is unavailable the run still completes.

**Gate thresholds** (`-1` = unlimited):

| field | default | meaning |
| --- | --- | --- |
| `gate.severe` | `0` | max unacknowledged severe findings allowed |
| `gate.warning` | `0` | max unacknowledged warnings allowed |
| `gate.suggestion` | `-1` | suggestions never block by default |
| `gate.requiredAcknowledge` | `[]` | finding ids that must be explicitly acknowledged; the token `"severe"` means *every* severe finding must be acknowledged |

**Acknowledging findings** moves them out of the failure set and is always
audited: `review-gate acknowledge <id> --reason "charted in CR-77"`.

**Built-in rules** (`src/config.ts::defaultRules`): `todo`, `debugger`,
`console-log`, `hardcoded-secret`, `long-line`, `merge-markers`. Each has a
`pattern`, `severity`, `message`, optional `files` path regex and `suggestion`.
Add or override entries under `rules` to encode lessons from past failures —
hundreds of matches are capped by `maxFindings`.

**Empty diff** — "empty" means git reported no changes at all. A binary-only,
pure-rename or mode-only change is a real diff: it produces no line-level
findings but still requires the approval quorum. `onEmptyDiff: "pass"`
(default) lets a genuinely empty diff through; `"fail"` requires an explicit
review: it inserts a `severe` finding that must be acknowledged, which is how
a "nothing changed but this still needs sign-off" policy is expressed.

---

## dsh tools

| tool | purpose |
| --- | --- |
| `review_run` | run the review of the current diff / commit / range |
| `review_status` | current findings, status, approval progress |
| `review_approve` | +1 toward the quorum (blocks if auto-gate fails) |
| `review_request_changes` | block until re-reviewed |
| `review_reject` | block until re-reviewed |
| `review_acknowledge` | acknowledge a finding with a reason (audited) |
| `gate_check` | deterministic verdict, machine-readable JSON, modes `gate`/`merge` |
| `review_export` | compliance report as JSON / Markdown |

Every tool returns a JSON value (CI-consumable) and renders a readable summary
for the model. You can also call the same logic programmatically:

```ts
import { ReviewGate, JsonFileStore, GitRunner, resolveConfig } from 'review-gate/core'

const config = resolveConfig({ cwd: '/path/to/repo' })
const gate = new ReviewGate({
  config,
  store: new JsonFileStore({ root: config.store.root }),
  git: new GitRunner({ cwd: config.cwd }),
})
const { verdict } = await gate.run({ scope: { kind: 'range', base: 'main', head: 'feature' } })
const check = await gate.gateCheck({ mode: 'merge' })
```

---

## CLI reference

```
review-gate <command> [scope] [options]

  run | status | approve | reject | request-changes | acknowledge
  gate-check | export | audit | init | version

Scope: working | staged | commit:<ref> | range:<base>..<head>   (default working)

  --dir <path>      repository to review            --config <file>
  --force           new round even if unchanged     --mode gate|merge
  --reviewer <r>    --comment <text>                --reason <text>
  --format json|markdown (export)                   --out <file>
  --actor <label>   --json
```

`gate-check` is the CI hook: it prints JSON and exits `0` on `--mode gate`
(when status is `passed`/`approved`) or `0` on `--mode merge` (only when
`approved`). All other commands exit `0` on success, `1` on a refused
operation, `2` on usage/config errors.

---

## CI collaboration

The gate's state + audit trail live in `<repo>/.review-gate/`. Because sessions
are keyed on a **stable repo identity** (`store.repoId`, or derived from the
remote URL), a trail recorded in one checkout is readable from any other
checkout of the same repository — including CI.

Two deployment models:

- **Committed trail (recommended for merge blocking)** — reviewers create and
  update the review state and approvals in their checkout, then **commit
  `.review-gate/`** to the repository. CI simply checks it out and verifies:
  `review-gate gate-check --mode merge` exits `0` only when the automatic
  thresholds *and* the approval quorum are satisfied. `examples/github-action.yml`
  shows a branch-protection job with this shape.
- **Pipeline-owned** — the harness / CLI is the reviewer and records state
  directly in the environment the merge gate reads.

Important: use **one consistent scope** for a given gate everywhere — the same
diff scope reviewers approve on must be the one CI checks (`working` by
default). `gate-check` itself never mutates state, so it is safe to run
repeatedly from hooks.

---

## Design notes / tradeoffs

- **Deterministic gate**: the pass/fail decision is a pure function of the
  round's persisted findings + acknowledgements + votes. Model output can only
  contribute findings — never bypass a threshold — and once a round is
  persisted any re-read yields the identical verdict.
- **Idempotent**: re-running `review_run` on unchanged content reuses the
  round; an identical vote/acknowledgement is a no-op; `gate_check` never
  mutates.
- **Concurrency**: sessions are serialized per key (in-process mutex +
  cross-process lock file with stale-breaking and owner tokens); writes are
  temp+fsync+rename so a crash never corrupts a document; the audit trail is
  append-only.
- **Scope boundaries**: combined (`--cc`) merge diffs are intentionally not
  line-reviewed (recorded as a placeholder). Empty diffs are governed by
  `onEmptyDiff`. Findings are capped by `maxFindings`.
- **Lessons library** is intentionally config-driven (add a rule) rather than
  an auto-mutating subsystem — deterministic and auditable.

## Security

- The gate reads the repository read-only (`git diff` / `git show`); it never
  modifies working trees.
- Secrets in findings: the `hardcoded-secret` rule echoes matched lines into
  findings/reports — restrict who may read the trail, and consider tighter
  rules in high-security repos.
- This is a review/compliance helper, not an authorization boundary. Anyone
  who can write to the store can edit approvals; protect `.review-gate/`
  accordingly.

## Testing

`npm test` runs the `node:test` suites: `git/diff` parsers, static analyzer,
gate engine, approval flow, JSON store (concurrency + durability + locks),
review runner E2E (incl. empty-diff + LLM fallback + round scoping + stable
identity), idempotency, reports, config validation, dsh tool registry, and a
full CLI round-trip against a real thrown-together git repository.

## License

MIT — see [LICENSE](LICENSE).
