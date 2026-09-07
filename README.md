# pro-website-builder

An AI-assisted local studio that compiles an original visual identity into an interactive prototype and a finished static website. The product treats the identity as a typed, captain-approved contract rather than asking a model to invent HTML or JSX.

## Workflow

1. Identity: a director proposes a typed identity and token contract.
2. Prototype: an information architect fixes the journey and the states, section composers fill disjoint windows of the page graph in parallel, and four critics review the result.
3. Finalization: a compiler proposal is validated, rendered, reviewed, and exported.

Each stage stops at a captain-only gate in v1. Agents return schema-validated JSON — a proposal or a typed contract, never markup — and deterministic code turns it into the patch. The immutable `DesignIR` is the source of truth, and the pure renderer produces the editor preview, isolated preview, screenshots, and static export.

## Stack and boundaries

- pnpm workspaces with strict TypeScript project references.
- Vite + React + TypeScript for `apps/studio`.
- Node HTTP + SQLite WAL + Drizzle for `apps/server`.
- `packages/domain` owns Zod contracts, DTCG-compatible tokens, JSON Schema, and immutable document fixtures.
- `packages/renderer` is pure TypeScript and emits semantic HTML/CSS with cascade layers, custom properties, container queries, and reduced-motion handling.
- `packages/orchestrator` owns the fixed stage DAG, semaphores, deadlines, cancellation, patch CAS, immutable versions, and events. `RunPlanner` emits the identity to prototype to finalization edges. Every captain start request submits exactly one stage to `Scheduler.run`, together with those edges and the set of stages the captain has already approved in this run; the scheduler admits the task only when each of its dependencies is in that completed set or succeeded in the same call, and fails it with a named-dependency error otherwise, so no stage can run ahead of the gate before it. Approving a gate never spends a model call on its own; a rejection returns the stage to a re-runnable state and the next start request re-runs it under a new attempt number.
- `packages/providers` isolates the owner's local Claude Code binary, optional Higgsfield MCP, and deterministic fakes.
- `packages/render-hub` uses Playwright Chromium to capture the full evidence matrix: 320/360/390/768/1024/1440 CSS px, every state fixture, light and dark when the identity declares one, reduced motion, screenshots, DOM and accessibility snapshots, per-node geometry, contrast and keyboard-focus samples, axe in each open state, console and network errors, and a content-addressed cache.
- `packages/qa-deterministic` owns the Tier 0/1 gate. It is pure: evidence in, findings out. Tier 0 vetoes a revision before any model runs; Tier 1 observes without blocking.
- `packages/stage-prototype` owns the prototype stage: the serial information architect, the parallel section composers, the four critics, the `PatchPlanner`, the refiner and the loop controller.
- `packages/export` writes content-addressed static routes and a license/provenance manifest.

The renderer refuses raw visual values. Colors, dimensions, font settings, radii, shadows, and motion must resolve through tokens, with no exception path in Fase 0. A page node's `semantic` is the tag it renders as, drawn from a closed vocabulary, so the schema refuses a landmark the renderer would silently drop; `body` carries the query container and `main` is the element the breakpoint restyles. Preview is served on port `4311`, separate from the Studio/API origin, and the Studio iframe uses `sandbox` without `allow-same-origin`.

## Run locally

Corepack supplies the pinned pnpm version; pnpm does not need to be installed globally.

```bash
corepack pnpm install
corepack pnpm exec playwright install chromium
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

Playwright ships no browser of its own and `pnpm install` does not fetch one. Every measured path opens its browser through `RenderHub`, which refuses without that binary and names the command that installs it — the server, the fixture CLI and the e2e harnesses all get the same sentence.

Run the deterministic fixture without starting the UI:

```bash
corepack pnpm run:fixture
```

The command writes a local SQLite database under `.treehouse/` and a content-addressed export under `exports/`. The database carries a schema version in `PRAGMA user_version`; opening a file written by an older version drops the `tasks`, `runs` and legacy `assets` tables and recreates the two it still uses, because this pre-release tool keeps no history worth backfilling. `projects`, `versions`, `patches`, `approvals` and `events` are left untouched, so rows from an upgraded file can name a run the `runs` table no longer has. Set `PWB_DB_PATH` and `PWB_EXPORT_ROOT` to use explicit locations, `PWB_MODEL_PROVIDER` to choose the model provider, and `PWB_STAGE_DEADLINE_MS` to give every stage the same deadline instead of the per-stage defaults. Add `--render` to also drive the approved document through the Playwright `RenderHub`: `createRenderMatrix` enumerates every route at the three representative widths — 390, 768 and 1440 CSS pixels — in every `stateFixtures` state and declared colour scheme, `--full-matrix` widens that to all six `RENDER_VIEWPORTS`, and each case is captured as a screenshot plus DOM and accessibility snapshot behind the hash cache under `PWB_RENDER_CACHE`. Observed on 2026-09-07 at this head, with the default `fake` provider and scratch paths so the recorded `claude-code` run above stayed intact — `PWB_PREVIEW_PORT=4319 PWB_DB_PATH=.treehouse/render-matrix.sqlite PWB_EXPORT_ROOT=.treehouse/render-matrix-exports PWB_RENDER_CACHE=.treehouse/render-matrix-cache corepack pnpm run:fixture --render` — the run printed `"render": {"cases": 18, "passed": 18, "cached": 0, "failed": []}` for the fixture's three routes, and repeating the same command against the warm cache printed `"cached": 18`. When `--render` is passed, any failed render case makes the command exit `1` after printing the JSON, so a caller sees a failed matrix without comparing `passed` against `cases` itself.

Start the local API and preview, then the Studio in another terminal:

```bash
corepack pnpm --filter @pwb/server dev
corepack pnpm --filter @pwb/studio dev
```

The API is `http://127.0.0.1:4310`, the isolated preview is `http://127.0.0.1:4311`, and Vite serves the Studio on `http://127.0.0.1:5173`. `PWB_PORT` and `PWB_PREVIEW_PORT` move the API and preview ports (`corepack pnpm run:fixture --render` reads `PWB_PREVIEW_PORT` as well), and `VITE_API_ORIGIN` and `VITE_PREVIEW_ORIGIN` point the Studio at the moved origins. That Studio origin is the only one allowed to send state-changing requests or frame the preview; `PWB_STUDIO_ORIGIN` overrides it for the Playwright run, which serves the built Studio on `4173`. The Studio copy is pt-BR; code and technical identifiers remain English.

## Real local Claude Code

CI and the fixture use `FakeModelProvider`. `PWB_MODEL_PROVIDER` selects the model provider for both `corepack pnpm --filter @pwb/server dev` and `corepack pnpm run:fixture`: `fake` (the default) or `claude-code`. To exercise the real adapter, install and log in to the unmodified Claude Code binary as its owner, verify `claude --version`, then start either entry point with `PWB_MODEL_PROVIDER=claude-code`. The runner uses `execFile` with no shell, a fresh session UUID, `--no-session-persistence`, structured JSON, schema validation, deadlines, abort signals, and a denied tool list, because a worker proposes JSON and never touches the filesystem. Each `claude` invocation is capped at 7 minutes and each stage at 15 minutes (20 for finalization), so one stage can spend a first answer and a schema correction inside its budget; `PWB_STAGE_DEADLINE_MS` replaces all three stage deadlines and leaves the invocation cap alone. It never reads, stores, prints, forwards, or asks for tokens or credentials. No paid API is required by this repository.

Exercised against the owner's signed-in `claude 2.1.263`. What each run confirmed is recorded below; the flag and envelope contract has held since 2026-09-06, and the paragraphs after the command say which runs completed the whole journey and which did not:

```bash
PWB_MODEL_PROVIDER=claude-code corepack pnpm run:fixture
```

The adapter's contract with the binary holds: `--json-schema`, `--session-id`, `--no-session-persistence`, `--max-turns`, `--disallowed-tools` and `--output-format json` are accepted, and the proposal arrives in the envelope's top-level `structured_output`. Earlier runs corrected three things. The schema handed to `--json-schema` must be a self-contained object schema: a `$ref` root is rejected by the API (`tools.custom.input_schema.type: Field required`) and `type: [...]` unions are rejected by the CLI's strict validator, so every generated schema is emitted with `anyOf` and with `$refStrategy: 'none'`, leaving no pointer for the binary to resolve. One turn is not enough for a structured answer. A headless worker with tools enabled spends its turns exploring the filesystem instead of answering, so the runner denies them.

Each stage writes only its own part of the document: the identity director writes `/identity` and `/reviewRecord`; the prototype composer writes `/pages`, `/assets` and `/reviewRecord`; the finalization compiler writes `/pages`, `/assets` and `/reviewRecord`. The identity is frozen once the captain approves Gate 1, so no later stage may write `/identity`. Every stage reads the whole document; only writing is narrowed. `RunPlanner` takes each task's `allowedPaths` from that same table, so `PatchGate` refuses an out-of-stage path before anything else runs.

`--json-schema` carries a per-stage `AgentResult` schema built from that table: `operations` is a union in which replacing one of the stage's writable roots types `value` with the inlined subtree schema, and any other operation must address a path beneath one of those roots. `PatchGate` validates every proposal against the same per-stage Zod schema before the applier reads the document, so a wrong-shaped whole-subtree replacement is refused at the gate; a deeper write (`/identity/meta/version`, `/assets/items/0/id`) is constrained only in its path there, and its value is still validated by `designIRSchema` in the applier's dry run. The recursive DTCG token group is the one shape that cannot be inlined; `zod-to-json-schema` degrades it to `any` and says so on stderr.

Two 2026-09-06 runs failed at the identity stage. Before the task carried its `documentSlice`, the applier's dry run rejected the proposal with `identity.meta: Required`; later the same day, with the slice but without the document shapes, it rejected `Expected string, received object` at `reviewRecord.findings.0` through `.3` and `reviewRecord.approvals.0`, because nothing in the contract told the worker that `designIRSchema` declares those as arrays of strings.

A 2026-09-07 run against the closed `semantic` vocabulary failed at the prototype stage: the composer proposed `semantic: 'section'` on a `grid` node and on a `component` node, and a per-kind rule that pinned every non-`type` kind to `div` rejected it. The renderer emits whatever `semantic` declares, so that rule refused a document it would have rendered exactly as written; only `figure` is tied to a kind, because that is the one branch the renderer hard-codes. The rule was narrowed to that, and the command was run again. A later change pinned each stage's `stage` and `role` as constants in the schema and made a phrasing node (`h1`, `h2`, `h3`, `p`) a leaf, and the command was run once more against that contract.

The last complete 2026-09-07 run of that command was against that contract, before the structural rules below were added to the prompt. Claude produced a proposal for each of the three stages, all three passed the patch gate and the applier's dry run on attempt 1, and the captain gate approved each one: the event log holds `task.queued`, `task.started`, `patch.applied`, `version.created`, `task.succeeded` and `approval.recorded` for `identity`, `prototype` and `finalization`, with no `task.failed`, and ends at `run.finished` carrying the export digest. The database holds 3 patches, 3 tasks, 3 approvals and 4 versions (root plus one per stage), each task at attempt 1, and each patch declares the stage and role of the task that produced it (`identity/director`, `prototype/composer`, `finalization/compiler`). The command exited 0 and wrote `index.html`, `proof/index.html`, `contact/index.html` and `manifest.json` under `exports/<digest>/`. That run's identity stage replaced `/reviewRecord`, the prototype stage replaced `/pages` as a whole subtree, and the finalization stage appended a node at `/pages/routes/0/nodes/-`.

`zod-to-json-schema` cannot express a `superRefine`, so the structural rules in `documentRules` — the media/figure pairing, the phrasing leaf rule, page-graph reachability and node id uniqueness, page id/route uniqueness, the token role and CSS-emittable token rules, the rule that every token alias and every visual prop reference names a token path the identity defines, and the asset rules (only a media node declares `assetId`, it names an asset the document lists, and a ready asset carries alt text and a `data:` URI) — reach the worker as prompt text built from that same object the gate quotes in its rejection messages. The one visual-prop rule a JSON Schema can carry is machine-enforced instead: a node prop is typed as a token reference (`"type": "string"` with `"pattern": "^\\{[^}]+\\}$"`), so the constraint now travels to the binary in the schema itself rather than only as prose, and the gate refuses a raw literal such as `700` or `#d86445` quoting that same rule. What the binary does with a `pattern` while decoding has not been observed here and is not claimed; the run recorded below says what was seen. Three runs of the command on 2026-09-07 after that line was added were aborted by the then 5-minute per-stage deadline rather than reaching a gate: the first after the identity stage was approved and while the prototype stage was running, the other two during the identity stage, each leaving `task.started` as the last event and no patch committed. The cause was local, not the contract: `claude -p 'Reply with the single word: ok' --output-format json --max-turns 1` reported `duration_ms: 3390` for the API call and took 1m47s of wall clock, so roughly 100s of per-invocation process overhead was consuming the budget. The stage deadlines were then sized to hold two full runner invocations (15/15/20 minutes against a 7-minute runner timeout).

The next 2026-09-07 run of the command, with those deadlines and the contract as of commit `018ec55`, completed the whole journey. Every stage passed on attempt 1: the event log runs `task.queued`, `task.started`, `patch.applied`, `version.created`, `task.succeeded` and `approval.recorded` for `identity`, `prototype` and `finalization` with no `task.failed`, and ends at `run.finished`. The database holds 3 patches, 3 tasks, 3 approvals and 4 versions, and each patch declares its own task's stage and role (`identity/director` writing `/reviewRecord`, `prototype/composer` replacing `/pages`, `finalization/compiler` writing `/pages/routes/0/nodes/44/id`). The command exited 0. The composer proposed a fourth page, so the export under `exports/<digest>/` carries `index.html`, `process/index.html`, `proof/index.html`, `contact/index.html` and `manifest.json` — the route list the run printed was `/`, `/process`, `/proof`, `/contact`.

The same command was run again on 2026-09-07 at commit `c067ebe`, the first head that hands the binary a `pattern` for every visual prop:

```bash
PWB_MODEL_PROVIDER=claude-code corepack pnpm run:fixture
```

It completed the whole journey and exited 0, printing `"status": "succeeded"` with the route list `/`, `/proof`, `/contact`; wall clock was 11m43s (18:48:24Z to 19:00:07Z), split 1m58s for identity, 6m54s for prototype and 2m50s for finalization, all inside the 15/15/20-minute stage deadlines. Every stage passed on attempt 1: the database holds 3 tasks each at attempt 1, 3 patches, 3 approvals and 4 versions, and the 22-event log runs `task.queued`, `task.started`, `patch.applied`, `version.created`, `task.succeeded` and `approval.recorded` for `identity`, `prototype` and `finalization` with no `task.failed`, ending at `run.finished`. Each patch declared its own task's stage and role — `identity/director` touching `/reviewRecord`, `prototype/composer` and `finalization/compiler` touching `/pages`, `/assets` and `/reviewRecord`. The export under `exports/1cc32d2d.../` carries `index.html`, `proof/index.html`, `contact/index.html` and `manifest.json`.

That run is what the `pattern` claim rests on, and no more: the binary's strict schema validator accepted the per-stage schema carrying it (all sixteen visual props emitted as `"type": "string"` with `"pattern": "^\{[^}]+\}$"`), and the approved document holds 174 visual props, every one of them a token reference, so the gate had no raw literal to refuse. Whether the API constrained decoding by that `pattern` or the worker simply followed the contract was not distinguished; no run has been observed in which the two disagree.

Higgsfield is an optional asynchronous raster boundary, delivered as `HiggsfieldMcpProvider` in `packages/providers`: when its MCP is not configured, `submit` returns a `not_configured` job whose provenance records `pending provider terms` and a placeholder note, and it never requests or persists credentials. Phase 0 does not submit a raster job from the three-stage journey — `RunPlanner` emits three `claude`-lane tasks and nothing writes an asset from a `RasterJob` — so a fixture run's asset ledger is the same whether or not Higgsfield is configured. Wiring the raster lane into the run is later-phase work.

## The prototype stage

An information architect runs first and alone. It proposes a typed `RouteManifest`: the routes, the order a visitor walks them, the sections of each route with plausible copy, the states the prototype must survive, and the node ids. Every route reserves slot 0 for a shell the architect owns; each section is then given a contiguous, disjoint window of node slots.

Section composers run in parallel under the scheduler, one per section, each allowed to write only its own window. A composer proposes a typed `SectionComposition`, never a patch and never HTML; deterministic code checks that it filled exactly its window with a connected subtree inside the token system, compiles it into JSON Pointer operations, and the real `PatchGate` refuses any overlap between two windows before the merged patch reaches the applier. A call to action is a real anchor: the semantic vocabulary carries `link` and `button` as `component` nodes whose text is the label, and a link's `href` must be one of the routes the same document declares, which the manifest, the composition check and the document schema each refuse to accept otherwise. The renderer takes a `routePrefix`, so the same document links inside `/preview/<versionId>` while it is under review and at the site root once it is exported. A section declares its layout change as a `responsive` rule, whose width and props are tokens the renderer reads back out as a container query. A rule may only open at one of `gridGrammar.breakpointTokens`, the ascending container widths the identity declares as its breakpoints; the schema refuses a breakpoint at or below the narrowest supported viewport, because a condition every viewport already satisfies transforms nothing.

The revision is then rendered across the representative capture matrix — every declared route, state and colour scheme at the three widths — and handed to the deterministic gate. A Tier 0 veto stops the stage before a single model call. Only if it passes do four critics run, each in its own session, each seeing the identity contract and the rubric before the screenshots, each returning a `CritiqueReport` that moves from perception to comprehension to projection. A finding names its nodes, says why it matters against the contract, and carries at most one repair drawn from `set_token`, `set_constraint`, `set_crop`, `replace_copy` and `reorder_node`. A critic that cannot tell answers `uncertain`, which escalates instead of inventing precision.

The `PatchPlanner` compiles at most three causal repairs per cycle, guards every write with a `test` against the value the critic saw, and rejects anything else with a stated reason. The prototype stage writes `/pages`, `/assets`, `/stateFixtures` and `/reviewRecord` and nothing else; `/stateFixtures` is on that list because the architect declares the states, and the gate refuses any operation outside it. The loop then stops, always for a named reason: `clean`, `tier0_veto`, `uncertain`, `max_cycles`, `repeated_issue`, `improvement_below_noise`, `no_actionable_patch` or `budget_exhausted`.

Run the stage without the UI:

```bash
corepack pnpm run:prototype                            # deterministic evidence, no browser
corepack pnpm run:prototype -- --render                # the real Playwright RenderHub
corepack pnpm run:prototype -- --render --full-matrix  # the finalist sweep, all six widths
```

Both bind an ephemeral port, so several checkouts can run them at the same time.

The Gate 2 screen is at `http://127.0.0.1:5173/#/gate-2`. It compares the composed revision with the refined one on the same route at the same width, offers an overlay and a difference blend, keeps the deterministic gate and the critics' opinion in separate panels, and records accept, reject or defer with a reason for each issue before the captain settles the gate. Both sides are always shown: when the loop applied no repair the two are the same revision and the difference blend is empty, which is itself the answer.

The server measures that verdict rather than assuming it. `startServer` hands the run registry a `RenderHubEvidenceSource` pointed at the isolated preview origin, so a Gate 2 run drives the real capture matrix through Playwright — contrast, focus, axe, overflow, clipping and stability are observed on a live page before any critic runs, and a Tier 0 veto blocks approval. The browser cache lives in `PWB_RENDER_CACHE` (default `.treehouse/render-cache`), so an unchanged revision is never recaptured. The synthesized `DerivedEvidenceSource` is a test-only stand-in; no server path can reach it.

Both deterministic tiers measure every declared route, state and colour scheme at the three representative widths — 390, 768 and 1440 — because a revision under review is not worth six widths of browser time. The full `RENDER_VIEWPORTS` sweep (320/360/390/768/1024/1440) is for a finalist and is asked for explicitly: `corepack pnpm run:prototype -- --render --full-matrix`.

Measuring takes minutes, so a run is asynchronous and recoverable. `POST /api/prototype/runs` records the run and answers at once with its id and a `queued` status; the stage then executes as one `Scheduler` task on the raster lane, which gives it the stage deadline and the abort signal that enforces it. Only one browser matrix runs at a time — a second request queues behind the first and says so — and the Studio's start button stays disabled while any run is queued or measuring. `GET /api/prototype/runs/<id>` returns that progress and, once the stage settles, the whole review; `GET /api/prototype/runs` lists every run this server holds.

Each transition is written to a `prototype_runs` row together with the outcome and the two revisions the review compares, and `startServer` reads them back, so a settled review survives a restart and can be reopened without measuring anything again; a run that was still measuring when the process stopped comes back marked `interrupted` instead of disappearing. The Studio keeps the id in the address (`#/gate-2/<runId>`) and polls it, so a reload, a closed tab or a restart all find the same review.

The review only offers what the run measured: `result.viewports` is the set of widths the evidence actually carried, so the A/B comparison cannot be opened at a width the deterministic gate never looked at.

## Real local Claude Code in the prototype stage

`PWB_MODEL_PROVIDER=claude-code` swaps all four prototype workers at once: `ClaudeInformationArchitect`, `ClaudeSectionComposer` and `ClaudeCritiqueRunner` replace their deterministic counterparts, for both `corepack pnpm run:prototype` and `corepack pnpm --filter @pwb/server dev`. Each is a separate session with a fresh id, `--no-session-persistence`, a closed JSON schema, a deadline, an abort signal and a denied tool list. A critic keeps `Read` so it can open the screenshots it was handed; every other worker is denied the filesystem and the network entirely. No credential is read, requested, logged or stored, and no paid API is involved. CI never runs this path: it uses the deterministic providers, which produce the same typed contracts.

## Quality and security checks

The test suite covers schema validation, page-graph integrity, alias cycles/orphans, byte-stable rendering, token-only linting, identity token roles, CSS-emittable tokens, forbidden defaults, CAS/overlap rejection, semaphore limits and deadlines, immutable versioning, SQLite WAL, captain-only approvals, isolated preview headers, export licenses, the full fixture journey, cancellation/restart, and scans of database/log/export data for secret-like values. The prototype stage adds the section-window contracts, the closed critic vocabulary, the guarded compilation of every allowlisted repair, each of the loop's stop conditions observed through the stage itself, and the seven prototype linter rules. `corepack pnpm test:e2e` additionally drives the Studio through all three gates and through the Gate 2 review, and exercises `RenderHub` against a live browser, both for a single cached case and for the whole route x viewport x state matrix served by the isolated preview server; run `corepack pnpm build` first so `vite preview` has a bundle to serve. Several checkouts of this repo share one machine, so set `PWB_E2E_PORT_BASE` to give a run its own API, preview and Studio ports instead of reusing whatever already listens on the developer ones: `PWB_E2E_PORT_BASE=4520 corepack pnpm test:e2e`.

Fase 0 intentionally does not include parallel identity directions, Postgres, SaaS authentication, Yjs/CRDT collaboration, Astro output, or Lighthouse. Fase 2 adds the prototype stage, its critics and the prototype half of the linter catalogue; the identity and release halves stay with their own phases.
