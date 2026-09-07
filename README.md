# pro-website-builder

An AI-assisted local studio that compiles an original visual identity into an interactive prototype and a finished static website. The product treats the identity as a typed, captain-approved contract rather than asking a model to invent HTML or JSX.

## Workflow

1. Identity: a director proposes a typed identity and token contract.
2. Prototype: a composer proposes page-graph changes for `/`, `/proof`, and `/contact`.
3. Finalization: a compiler proposal is validated, rendered, reviewed, and exported.

Each stage stops at a captain-only gate in v1. Agents return schema-validated JSON patches. The immutable `DesignIR` is the source of truth, and the pure renderer produces the editor preview, isolated preview, screenshots, and static export.

## Stack and boundaries

- pnpm workspaces with strict TypeScript project references.
- Vite + React + TypeScript for `apps/studio`.
- Node HTTP + SQLite WAL + Drizzle for `apps/server`.
- `packages/domain` owns Zod contracts, DTCG-compatible tokens, JSON Schema, and immutable document fixtures.
- `packages/renderer` is pure TypeScript and emits semantic HTML/CSS with cascade layers, custom properties, container queries, and reduced-motion handling.
- `packages/orchestrator` owns the fixed stage DAG, semaphores, deadlines, cancellation, patch CAS, immutable versions, and events. `RunPlanner` emits the identity to prototype to finalization edges. Every captain start request submits exactly one stage to `Scheduler.run`, together with those edges and the set of stages the captain has already approved in this run; the scheduler admits the task only when each of its dependencies is in that completed set or succeeded in the same call, and fails it with a named-dependency error otherwise, so no stage can run ahead of the gate before it. Approving a gate never spends a model call on its own; a rejection returns the stage to a re-runnable state and the next start request re-runs it under a new attempt number.
- `packages/providers` isolates the owner's local Claude Code binary, optional Higgsfield MCP, and deterministic fakes.
- `packages/render-hub` uses Playwright Chromium for responsive screenshots, DOM/accessibility data, and deterministic QA.
- `packages/export` writes content-addressed static routes and a license/provenance manifest.

The renderer refuses raw visual values. Colors, dimensions, font settings, radii, shadows, and motion must resolve through tokens, with no exception path in Fase 0. A page node's `semantic` is the tag it renders as, drawn from a closed vocabulary, so the schema refuses a landmark the renderer would silently drop; `body` carries the query container and `main` is the element the breakpoint restyles. Preview is served on port `4311`, separate from the Studio/API origin, and the Studio iframe uses `sandbox` without `allow-same-origin`.

## Run locally

Corepack supplies the pinned pnpm version; pnpm does not need to be installed globally.

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

Run the deterministic fixture without starting the UI:

```bash
corepack pnpm run:fixture
```

The command writes a local SQLite database under `.treehouse/` and a content-addressed export under `exports/`. The database carries a schema version in `PRAGMA user_version`; opening a file written by an older version drops and rebuilds the `tasks`, `runs` and `assets` tables, because this pre-release tool keeps no history worth backfilling. `projects`, `versions`, `patches`, `approvals` and `events` are left untouched, so rows from an upgraded file can name a run the `runs` table no longer has. Set `PWB_DB_PATH` and `PWB_EXPORT_ROOT` to use explicit locations, and `PWB_MODEL_PROVIDER` to choose the model provider. Add `--render` to also drive the approved home route through the Playwright `RenderHub` (screenshot, DOM, accessibility snapshot, hash cache under `PWB_RENDER_CACHE`).

Start the local API and preview, then the Studio in another terminal:

```bash
corepack pnpm --filter @pwb/server dev
corepack pnpm --filter @pwb/studio dev
```

The API is `http://127.0.0.1:4310`, the isolated preview is `http://127.0.0.1:4311`, and Vite serves the Studio on `http://127.0.0.1:5173`. That Studio origin is the only one allowed to send state-changing requests or frame the preview; `PWB_STUDIO_ORIGIN` overrides it for the Playwright run, which serves the built Studio on `4173`. The Studio copy is pt-BR; code and technical identifiers remain English.

## Real local Claude Code

CI and the fixture use `FakeModelProvider`. `PWB_MODEL_PROVIDER` selects the model provider for both `corepack pnpm --filter @pwb/server dev` and `corepack pnpm run:fixture`: `fake` (the default) or `claude-code`. To exercise the real adapter, install and log in to the unmodified Claude Code binary as its owner, verify `claude --version`, then start either entry point with `PWB_MODEL_PROVIDER=claude-code`. The runner uses `execFile` with no shell, a fresh session UUID, `--no-session-persistence`, structured JSON, schema validation, deadlines, abort signals, and a denied tool list, because a worker proposes JSON and never touches the filesystem. It never reads, stores, prints, forwards, or asks for tokens or credentials. No paid API is required by this repository.

Verified against the owner's signed-in `claude 2.1.263`, most recently on 2026-09-07 with the current prompt:

```bash
PWB_MODEL_PROVIDER=claude-code corepack pnpm run:fixture
```

The adapter's contract with the binary holds: `--json-schema`, `--session-id`, `--no-session-persistence`, `--max-turns`, `--disallowed-tools` and `--output-format json` are accepted, and the proposal arrives in the envelope's top-level `structured_output`. Earlier runs corrected three things. The schema handed to `--json-schema` must be a self-contained object schema: a `$ref` root is rejected by the API (`tools.custom.input_schema.type: Field required`) and `type: [...]` unions are rejected by the CLI's strict validator, so every generated schema is emitted with `anyOf` and with `$refStrategy: 'none'`, leaving no pointer for the binary to resolve. One turn is not enough for a structured answer. A headless worker with tools enabled spends its turns exploring the filesystem instead of answering, so the runner denies them.

Each stage writes only its own part of the document: the identity director writes `/identity` and `/reviewRecord`; the prototype composer writes `/pages`, `/assets` and `/reviewRecord`; the finalization compiler writes `/pages`, `/assets` and `/reviewRecord`. The identity is frozen once the captain approves Gate 1, so no later stage may write `/identity`. Every stage reads the whole document; only writing is narrowed. `RunPlanner` takes each task's `allowedPaths` from that same table, so `PatchGate` refuses an out-of-stage path before anything else runs.

`--json-schema` carries a per-stage `AgentResult` schema built from that table: `operations` is a union in which replacing one of the stage's writable roots types `value` with the inlined subtree schema, and any other operation must address a path beneath one of those roots. `PatchGate` validates every proposal against the same per-stage Zod schema before the applier reads the document, so a wrong-shaped whole-subtree replacement is refused at the gate; a deeper write (`/identity/meta/version`, `/assets/items/0/id`) is constrained only in its path there, and its value is still validated by `designIRSchema` in the applier's dry run. The recursive DTCG token group is the one shape that cannot be inlined; `zod-to-json-schema` degrades it to `any` and says so on stderr.

Two 2026-09-06 runs failed at the identity stage. Before the task carried its `documentSlice`, the applier's dry run rejected the proposal with `identity.meta: Required`; later the same day, with the slice but without the document shapes, it rejected `Expected string, received object` at `reviewRecord.findings.0` through `.3` and `reviewRecord.approvals.0`, because nothing in the contract told the worker that `designIRSchema` declares those as arrays of strings.

A 2026-09-07 run against the closed `semantic` vocabulary failed at the prototype stage: the composer proposed `semantic: 'section'` on a `grid` node and on a `component` node, and a per-kind rule that pinned every non-`type` kind to `div` rejected it. The renderer emits whatever `semantic` declares, so that rule refused a document it would have rendered exactly as written; only `figure` is tied to a kind, because that is the one branch the renderer hard-codes. The rule was narrowed to that, and the command was run again.

The last 2026-09-07 run of that command completed the whole journey. Claude produced a proposal for each of the three stages, all three passed the patch gate and the applier's dry run on attempt 1, and the captain gate approved each one: the event log holds `task.queued`, `task.started`, `patch.applied`, `version.created`, `task.succeeded` and `approval.recorded` for `identity`, `prototype` and `finalization`, with no `task.failed`, and ends at `run.finished` carrying the export digest. The database holds 3 patches, 3 tasks, 3 approvals and 4 versions (root plus one per stage), each task at attempt 1. The command exited 0 and wrote `index.html`, `proof/index.html`, `contact/index.html` and `manifest.json` under `exports/<digest>/`. That run's identity stage replaced `/reviewRecord/findings`, the prototype stage replaced `/pages` as a whole subtree, and the finalization stage replaced `/pages/routes/0/nodes/3/id`.

Higgsfield is an optional asynchronous raster boundary. If its MCP is not configured, the pipeline continues with a provenance-marked placeholder asset; credentials are never requested or persisted.

## Quality and security checks

The test suite covers schema validation, page-graph integrity, alias cycles/orphans, byte-stable rendering, token-only linting, identity token roles, CSS-emittable tokens, forbidden defaults, CAS/overlap rejection, semaphore limits and deadlines, immutable versioning, SQLite WAL, captain-only approvals, isolated preview headers, export licenses, the full fixture journey, cancellation/restart, and scans of database/log/export data for secret-like values. `corepack pnpm test:e2e` additionally drives the Studio through all three gates and exercises `RenderHub` against a live browser; run `corepack pnpm build` first so `vite preview` has a bundle to serve.

Fase 0 intentionally does not include parallel identity directions, critic agents, the full linter catalog, Postgres, SaaS authentication, Yjs/CRDT collaboration, Astro output, or Lighthouse.
