# pro-website-builder

An AI-assisted local studio that compiles an original visual identity into an interactive prototype and a finished static website. The product treats the identity as a typed, captain-approved contract rather than asking a model to invent HTML or JSX.

## Workflow

1. Identity: a curator structures the briefing, three directors propose opposed typed identities in parallel, read-only critics score them, and the captain approves one at Gate 1.
2. Prototype: an information architect fixes the journey and the states, section composers fill disjoint windows of the page graph in parallel, and four critics review the result.
3. Finalization: a compiler proposal is validated, rendered, reviewed, and exported.

Each stage stops at a captain-only gate in v1. Agents return schema-validated JSON — a proposal or a typed contract, never markup — and deterministic code turns it into the patch. The immutable `DesignIR` is the source of truth, and the pure renderer produces the editor preview, isolated preview, screenshots, and static export.

## Stack and boundaries

- pnpm workspaces with strict TypeScript project references.
- Vite + React + TypeScript for `apps/studio`.
- Node HTTP + SQLite WAL + Drizzle for `apps/server`.
- `packages/domain` owns Zod contracts, DTCG-compatible tokens, JSON Schema, and immutable document fixtures.
- `packages/renderer` is pure TypeScript and emits semantic HTML/CSS with cascade layers, custom properties, container queries, and reduced-motion handling.
- `packages/stage-identity` owns the identity stage: the brief curator, the three opposed director seats, the divergence reducer, the read-only critics, the one-cycle refiner, the image art director and the Gate 1 record. It composes the existing `Scheduler`, `PatchGate` and `Applier` rather than adding an orchestrator of its own.
- `packages/orchestrator` owns the fixed stage DAG, semaphores, deadlines, cancellation, patch CAS, immutable versions, and events. `RunPlanner` emits the identity to prototype to finalization edges. Every captain start request submits exactly one stage to `Scheduler.run`, together with those edges and the set of stages the captain has already approved in this run; the scheduler admits the task only when each of its dependencies is in that completed set or succeeded in the same call, and fails it with a named-dependency error otherwise, so no stage can run ahead of the gate before it. Approving a gate never spends a model call on its own; a rejection returns the stage to a re-runnable state and the next start request re-runs it under a new attempt number.
- `packages/providers` isolates the owner's local Claude Code and Codex CLI binaries, optional Higgsfield MCP, and deterministic fakes.
- `packages/render-hub` uses Playwright Chromium to capture the full evidence matrix: 320/360/390/768/1024/1440 CSS px, every state fixture, light and dark when the identity declares one, reduced motion, screenshots, DOM and accessibility snapshots, per-node geometry, contrast and keyboard-focus samples, axe in each open state, console and network errors, and a content-addressed cache.
- `packages/qa-deterministic` owns the Tier 0/1 gate. It is pure: evidence in, findings out. Tier 0 vetoes a revision before any model runs; Tier 1 observes without blocking.
- `packages/stage-prototype` owns the prototype stage: the serial information architect, the parallel section composers, the four critics, the `PatchPlanner`, the refiner and the loop controller.
- `packages/export` is the deterministic release compiler: per-route metadata with Open Graph and canonical URLs, a sitemap and robots file, a Content-Security-Policy derived from what the bundle contains, inline styles lifted into a content-addressed stylesheet, self-hosted fonts when the licence permits, sRGB companions for wide-gamut colour tokens, a licence inventory, and an immutable content-addressed bundle. It collects deterministic release vetoes instead of throwing, and `writeReleaseBundle` refuses to touch disk while any veto stands.
- `packages/stage-finalization` owns the third stage: five release critics as separate read-only sessions, a patch-refiner capped at two cycles, a release-summarizer with no gate authority, the veto catalogue, preview/release parity, and the Gate 3 report.

## The identity stage

One briefing produces three directions, and they are made to disagree. Each director gets a seat with a fixed key on every one of the six divergence axes — composition, typography, materiality, colour, imagery, motion — and no two seats share a key on any axis. The three answers open three **alternative branches**: versions with the same parent that are never merged, so the captain compares whole documents instead of a blend nobody proposed. Each branch gets its own `PatchGate` over the shared `VersionStore`; only an `Applier` ever writes a version.

The matrix that says how far apart the directions are is not something a model asserts. The stage builds it as a deterministic fan-in: the axis keys come from the seat, the descriptors come from the director, and the palette fingerprint is measured from the direction's own colour tokens. That fingerprint records lightness and chroma and deliberately drops hue, which is how `DIV-030` enforces the plan's rule that swapping the hue is not a new direction.

Two rules join the linter registry:

- `ID-003` requires exactly one grounded decision record for every token and every governed contract field. A decision is grounded when it cites briefing evidence that exists, carries a written rationale, or names a divergence axis. An identity that justifies nothing fails it, which is the point.
- `DIV-030` requires every pair of directions to differ on at least four axes, refuses a colour difference that is only a hue rotation, and refuses a palette fingerprint that does not match the identity it is recorded on.

Critics are separate sessions that receive the rubric before the document, score 0–4 with 3 as the minimum, may answer `uncertain`, and cannot edit anything: a critic that returns a patch has that patch discarded and the attempt recorded. The refiner gets one cycle, may change what a token means but not which tokens exist, and never redraws the divergence matrix.

The image art director writes prompt plans for all three directions, with negatives and an expected licence per plan. Higgsfield generates for the approved direction only, after Gate 1. The identity stage's write boundary is `/identity` and `/reviewRecord`, so it does not touch `/assets`: each generated image travels on the handoff carrying its prompt, model, licence and terms, and the stage that owns page media places it in the ledger. With no Higgsfield MCP configured the pipeline still records a provenance-marked placeholder instead of a silent gap.

Every write this stage makes goes through the foundation's per-stage patch schema, which pins the stage and the role a proposal may declare and rejects any operation outside `/identity` and `/reviewRecord` — including one from the stage's own refiner or art director. The tests exercise that boundary rather than assuming it.

A Gate 1 the captain leaves open outlives the browser tab and the server process. `IdentityRun.restore` rebuilds a run from the versions, approvals, events and one checkpoint the ledger already holds, the identity routes resolve a run through it, and creating over an id that is only on disk answers `409` instead of handing back an empty run. One run object exists per id: an id is reserved while its run is being created, and two cold requests that arrive together share the one rebuild rather than each deciding from a ledger the other has already moved on from. A run whose stage was still in flight when the process ended comes back `interrupted` and can be started again. The Gate 1 screen remembers the last run id and reopens it on load, and its empty state takes an existing id, so the decision does not need a hand-written request.

The Gate 1 screen also accepts a written briefing for the identity run. The Studio requires a non-empty briefing; a supplied API briefing is trimmed and capped at 8,000 characters, stored with the run, and reused when a run is restored. Callers that omit the field keep the legacy briefing automatically. The briefing editor and its creation/replacement controls are composed by `packages/renderer`, so the Studio supplies only its UI element factory while the renderer remains framework independent.

Gate 1 is captain-only. A failing check does not silently pass and does not silently block: automatic selection is refused and the captain may proceed only with a written override, which is recorded. Approval produces an `IdentityHandoff` — the approved version id, the hash of the approved identity, and the generated imagery with its provenance — and the next stage plans against it: `RunPlanner` hands the prototype worker exactly that identity, and the test suite asserts the hash it receives is the one the captain approved.

Changing a token afterwards is checked before anything is committed: the token keeps its type, and the value has to be complete enough to stand alone in one CSS declaration — a hex colour of 3, 4, 6 or 8 digits, a closed colour function, a family whose quote closes — so a truncated paste is refused with the reason and the gate the captain closed stays closed. A value that passes goes through the same applier, produces a new immutable version, and the derived gate state turns to `reopened`: the handoff is marked stale and the RenderHub cache entries the approved identity produced are deleted. There is no second bookkeeping system — the gate state is derived from the approval record and the current identity hash.

```bash
corepack pnpm --filter @pwb/server dev   # then, in the Studio, open the "Gate 1 · identidade" tab
```

Creating an identity run costs nothing. `POST /api/identity/runs/<id>/start` is the only route that spends a model turn, and every state-changing identity route is captain-only and accepted from the Studio origin alone.

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

The command walks the three stages, closes the first two gates and stops at Gate 3 with the release prepared, printing the report. It publishes a content-addressed release under `releases/` only when the gate left nothing for a human to accept — no veto and no escalation — and records that publication under the `fixture` role, never as the captain; with anything open it prints the report and exits non-zero. It also writes a local SQLite database under `.treehouse/`. The database carries a schema version in `PRAGMA user_version`, and each upgrade step runs only for a file older than the version that introduced it. Version 2 dropped the `tasks`, `runs` and legacy `assets` tables and recreated the two it still uses, because this pre-release tool keeps no history worth backfilling; `projects`, `versions`, `patches`, `approvals` and `events` were left untouched, so rows from a file carried across that step can name a run the `runs` table no longer has. Version 3 closed the imagery vocabulary, so a file written by version 2 has every stored version document rewritten in place — the raster source keeps its meaning under its new name `higgsfield-mcp`, and a source this build cannot generate from becomes `manual` — and drops no row: an owner who ran the previous build keeps their runs, versions and decisions. Version 4 adds the `briefing` column to `runs` with the legacy briefing as its default, so existing identity runs remain restorable. Set `PWB_DB_PATH`, `PWB_RELEASE_ROOT` and `PWB_EVIDENCE_DIR` to use explicit locations, `PWB_MODEL_PROVIDER` to choose the model provider, and `PWB_STAGE_DEADLINE_MS` to give every stage the same deadline instead of the per-stage defaults. Add `--render` to also drive the approved document through the Playwright `RenderHub`: `createRenderMatrix` enumerates every route at the three representative widths — 390, 768 and 1440 CSS pixels — in every `stateFixtures` state and declared colour scheme, `--full-matrix` widens that to all six `RENDER_VIEWPORTS`, and each case is captured as a screenshot plus DOM and accessibility snapshot behind the hash cache under `PWB_RENDER_CACHE`.

The observed render-matrix command and output are recorded in [Verified runs](docs/verified-runs.md).

Start the local API and preview, then the Studio in another terminal:

```bash
corepack pnpm --filter @pwb/server dev
corepack pnpm --filter @pwb/studio dev
```

The server command builds its workspace dependencies before starting, so it also
works immediately after `corepack pnpm install`, when package `dist/` folders do
not exist yet.

The API is `http://127.0.0.1:4310`, the isolated preview is `http://127.0.0.1:4311`, and Vite serves the Studio on `http://127.0.0.1:5173`. `PWB_PORT` and `PWB_PREVIEW_PORT` move this server's API and preview ports — the `run:fixture` and `run:prototype` CLIs bind an ephemeral preview port instead, so several checkouts can render at once — and `VITE_API_ORIGIN` and `VITE_PREVIEW_ORIGIN` point the Studio at the moved origins. That Studio origin is the only one allowed to send state-changing requests or frame the preview; `PWB_STUDIO_ORIGIN` overrides it for the Playwright run, which serves the built Studio on `4173`. The Studio copy is pt-BR; code and technical identifiers remain English.

## Real local model providers

CI and runs without `PWB_MODEL_PROVIDER` use `FakeModelProvider`. `PWB_MODEL_PROVIDER` selects the model provider for both `corepack pnpm --filter @pwb/server dev` and `corepack pnpm run:fixture`: `fake` (the default), `claude-code`, or `codex`. To exercise the Claude adapter, install and log in to the unmodified Claude Code binary as its owner, verify `claude --version`, then start either entry point with `PWB_MODEL_PROVIDER=claude-code`. The runner uses `execFile` with no shell, a fresh session UUID, `--no-session-persistence`, structured JSON, schema validation, deadlines, abort signals, and a denied tool list, because a worker proposes JSON and never touches the filesystem. By default, each general `claude` invocation is capped at 7 minutes; the identity stage is capped at 119 minutes for the full supported path, including one corrective re-invocation for every correctable worker and five minutes of bounded persistence/render/matrix/gate headroom: 8 minutes of curation, 14 minutes of parallel directors, a 32-minute initial critic lane, three serial 8-minute refinements, a 26-minute second critic lane for three repaired directions, and 10 minutes of imagery planning. The server derives its outer identity deadline from the same resolved `IdentityStageDeadlines` and Claude lane capacity used by `IdentityStage`, so explicit critic deadlines and a lower scheduler capacity expand the budget with the actual critical path; prototype and finalization remain capped at 15 and 20 minutes. `PWB_STAGE_DEADLINE_MS` replaces all three stage deadlines and leaves the invocation cap alone. On the server's Gate 1 path, the whole identity stage is also bounded by its stage deadline; if a turn is stuck, the deadline abort is carried through the stage's phase boundaries, so the run returns a failed snapshot with a clear deadline error instead of staying `running`, opening Gate 1, or starting later identity phases. Identity critics keep a 3-minute default deadline, except `system-a11y-critic`, which has a 10-minute default because the accessibility rubric needs the larger context window observed in the local smoke. A global `PWB_IDENTITY_CRITIC_DEADLINE_MS` replaces the role default for every critic, and the critic-specific `PWB_IDENTITY_CRITIC_<CRITIC_ID>_DEADLINE_MS` variable overrides that value for one critic (for example, `PWB_IDENTITY_CRITIC_SYSTEM_A11Y_CRITIC_DEADLINE_MS=600000`). The selected identity provider receives the largest effective critic deadline as its invocation cap; the scheduler still enforces each critic's own deadline. Values must be positive integer milliseconds; a malformed value fails server startup. It never reads, stores, prints, forwards, or asks for tokens or credentials. No paid API is required by this repository.

The Codex adapter uses the local `codex` CLI in read-only, ephemeral mode with the exact `gpt-5.6-sol` model, `high` reasoning effort, and normal service explicitly pinned (`service_tier="standard"` plus `features.fast_mode=false`). Install Codex CLI and sign in with ChatGPT before selecting it. For stage workers, the adapter supplies the required AgentResult envelope in the prompt, closes the unused stdin stream, and validates that envelope after the final JSONL message returns. A non-zero Codex process exit always fails the turn, even when captured stdout contains a parseable answer; terminal stream failures are still classified for actionable diagnostics. Codex's strict response-schema validator rejects the stage envelope because read-only artifacts are intentionally open JSON records, so `CodexRunner` does not pass `--output-schema`; one schema correction is still retried through the provider's Zod validation. The finalization runner uses `CodexJsonRunner` directly and does pass its closed schema with `--output-schema`; that schema file is written inside the session workspace, so no temporary directory is ever left inside the repository. A missing CLI or ChatGPT sign-in produces an actionable error instead of falling back to another provider. The model supports `high` reasoning effort according to [OpenAI's GPT-5.6 Sol documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

```bash
PWB_MODEL_PROVIDER=codex corepack pnpm --filter @pwb/server dev
```

Observed real-Claude runs and their outcomes are recorded in [Verified runs](docs/verified-runs.md).

The identity stage uses a fixture of its own, `FakeIdentityProvider`, because its workers answer with role-specific artefacts rather than the phase 0 patch. `PWB_MODEL_PROVIDER=claude-code` swaps in the same `ClaudeRunner`, while `PWB_MODEL_PROVIDER=codex` uses the Codex adapter with the same role-specific prompts and closed schemas. Each path validates the returned artefact, retries one schema correction, and surfaces a failure when the worker still does not succeed. To exercise Claude manually:

```bash
PWB_MODEL_PROVIDER=claude-code corepack pnpm --filter @pwb/server dev
# then open the Studio, choose "Gate 1 · identidade" and press "Executar etapa de identidade"
```

That run spends up to fourteen local Claude turns — one curator, three directors, seven critics and one art director per direction whose contract admits the Higgsfield source — plus, per direction that needs the single refinement cycle, one refiner turn and the two direction critics read again so the blockers at Gate 1 describe the repaired version, and one corrective re-invocation for any worker whose artefact missed its schema; three at a time under the scheduler's `maxActiveClaude` limit. The `artifact` envelope this stage added to `AgentResult` has not been re-verified against the live binary in this phase; the phase 0 note above records the last verified contract. CI never runs the real binary; the whole journey there runs on the fakes.

To run Gate 1 with Codex instead:

```bash
PWB_MODEL_PROVIDER=codex corepack pnpm --filter @pwb/server dev
```

Higgsfield is an optional asynchronous raster boundary, delivered as `HiggsfieldMcpProvider` in `packages/providers`: when its MCP is not configured, `submit` returns a `not_configured` job whose provenance records `pending provider terms` and a placeholder note, and it never requests or persists credentials. The phase 0 three-stage journey submits no raster job — `RunPlanner` emits three `claude`-lane tasks and nothing writes an asset from a `RasterJob` — so a fixture run's asset ledger is the same whether or not Higgsfield is configured. The identity stage is the one that submits imagery, and only for the approved direction; when the MCP is not configured the pipeline continues with a provenance-marked placeholder asset.

Generation is off until the owner names an MCP server, so a fresh checkout and the test suite never reach the network. `McpToolTransport` in `packages/providers` is the client: it starts the server, opens a session, calls one tool and closes again, over JSON-RPC on stdio. One environment variable reaches it, read by `createRasterProvider`:

```bash
PWB_HIGGSFIELD_MCP_COMMAND=/path/to/server   # PWB_HIGGSFIELD_MCP_ARGS holds space-separated arguments
```

There is no remote-endpoint mode and no token to configure, because the product never collects, stores or routes a credential. The hosted Higgsfield MCP requires OAuth, so it is reached through an owner-run stdio bridge — `mcp-remote` and its kind — which performs that authentication itself and is spoken to like any other local server; no token ever passes through this product. An in-product OAuth flow is deliberately not built here; it is the captain's decision to make. The server process owns its own authentication, and its stderr is discarded rather than logged, because it may print that state.

A server that refuses, errors or cannot start makes that one image a `failed` asset with the reason on its provenance, never a silent placeholder. The same holds for an answer this client recognises no image in: the asset fails and its provenance names the shape the tool returned (its keys, never their values) so an unanticipated shape is visible rather than looking unfinished. The image itself is read from a structured field, a linked resource, or the text block a tool without `structuredContent` returns — a text block that is itself JSON is parsed and read, never scanned, and a prose block is scanned only as far as the punctuation that ends the sentence, so a url can never arrive carrying the quote or full stop that followed it. What a tool volunteers about price is not read: nothing on this path records a cost. No generation has been observed against the live server; every path above is covered against a fake MCP server.

Generation runs on the `raster` lane the foundation reserved for it, not inside the approve call. Gate 1 closes on the plan — the captain gets the decision back immediately, holding one `generating` asset per planned image, each already carrying its prompt, digest and licence expectation — and the `Scheduler` then shoots them one at a time (`maxActiveRaster`), each under its own deadline. Nothing on that lane is ever on the captain's path: a re-approval made while an earlier batch is still shooting queues behind it and returns at once, and what that batch finishes is not shot again, because the work is chosen only once it has settled. The signal reaches the MCP client, so a stalled endpoint is dropped instead of held open, and the Gate 1 screen's `Cancelar execução` — offered while a start request is pending or while the stage or raster lane is working — stops imagery still in flight: what it did not finish is recorded as a `failed` asset with the reason, and the decision it was shot for stands. A stage that failed is not the end of the run: asking again clears the failure and runs it on a fresh stage, exactly as a restarted process already did, and the button says `Tentar novamente`; a retry the process ended reads back as interrupted rather than as the failure it was asked after. Replacing the run this browser remembers always takes a second yes that names the run being replaced, the field that reopens any earlier run by id sits beside it, and while a run is working neither is offered — the stop is the only way out. The screen learns that a run is working from the server, not from the click that started it: a reloaded tab, or a second one, reads `running` and is offered the same stop, cannot ask for the stage twice, and follows queued and running progress until the run settles. The status badge and state-dependent actions come from those server snapshots; while a local start request is pending, the queued badge remains visible, the button says `Iniciando…`, and cancellation remains available. If that start response is ambiguous, the screen shows `Verificando execução…`, checks the same run for a bounded number of readings, and then requires an explicit retry or refresh if no later status appears. Stopping a run the captain never decided is different: that run is `cancelled`, and it can be neither started nor decided again — approve and reject refuse it alike, and its cards stay on screen for reading with both actions disabled and the reason on each one. What decides between the two is whether the fan-out had produced its candidates when the stop was asked for, sampled before anything is awaited — a stop that arrives while the last versions are being written keeps the directions it already paid for. The stop is written to the ledger, so a restarted process reads a stopped run back as stopped rather than offering to run it again. The run writes its checkpoint again when the lane settles, so a restart reads what was actually produced; an image the ended process was still shooting has no task behind it any more, so it comes back `failed` saying so rather than generating forever, and its unchanged digest makes it eligible to be asked for again. The Gate 1 screen follows queued or working runs until the stage and any asset generation have settled.

One rule decides whether an image already exists — a `ready` asset whose provenance digest matches the plan item — and one guard decides whether a direction may be generated for at all, both at the site that performs the call, so a contract admitting no raster source cannot be submitted for by any path.

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

Each binds an ephemeral preview port, so several checkouts can run them at the same time.

The Gate 2 screen is at `http://127.0.0.1:5173/#/gate-2`. It compares the composed revision with the refined one on the same route at the same width, offers an overlay and a difference blend, keeps the deterministic gate and the critics' opinion in separate panels, and records accept, reject or defer with a reason for each issue before the captain settles the gate. Both sides are always shown: when the loop applied no repair the two are the same revision and the difference blend is empty, which is itself the answer.

The server measures that verdict rather than assuming it. `startServer` hands the run registry a `RenderHubEvidenceSource` pointed at the isolated preview origin, so a Gate 2 run drives the real capture matrix through Playwright — contrast, focus, axe, overflow, clipping and stability are observed on a live page before any critic runs, and a Tier 0 veto blocks approval. The browser cache lives in `PWB_RENDER_CACHE` (default `.treehouse/render-cache`), so an unchanged revision is never recaptured. The synthesized `DerivedEvidenceSource` is a test-only stand-in; no server path can reach it.

Both deterministic tiers measure every declared route, state and colour scheme at the three representative widths — 390, 768 and 1440 — because a revision under review is not worth six widths of browser time. The full `RENDER_VIEWPORTS` sweep (320/360/390/768/1024/1440) is for a finalist and is asked for explicitly: `corepack pnpm run:prototype -- --render --full-matrix`.

Measuring takes minutes, so a run is asynchronous and recoverable. `POST /api/prototype/runs` records the run and answers at once with its id and a `queued` status; the stage then executes as one `Scheduler` task on the raster lane, which gives it the stage deadline and the abort signal that enforces it. Only one browser matrix runs at a time — a second request queues behind the first and says so — and the Studio's start button stays disabled while any run is queued or measuring. `GET /api/prototype/runs/<id>` returns that progress and, once the stage settles, the whole review; `GET /api/prototype/runs` lists every run this server holds.

Each transition is written to a `prototype_runs` row together with the outcome and the two revisions the review compares, and `startServer` reads them back, so a settled review survives a restart and can be reopened without measuring anything again; a run that was still measuring when the process stopped comes back marked `interrupted` instead of disappearing. The Studio keeps the id in the address (`#/gate-2/<runId>`) and polls it, so a reload, a closed tab or a restart all find the same review.

The review only offers what the run measured: `result.viewports` is the set of widths the evidence actually carried, so the A/B comparison cannot be opened at a width the deterministic gate never looked at.

## Real local model providers in the prototype stage

`PWB_MODEL_PROVIDER=claude-code` swaps all three prototype workers at once: `ClaudeInformationArchitect`, `ClaudeSectionComposer` and `ClaudeCritiqueRunner` replace their deterministic counterparts, for both `corepack pnpm run:prototype` and `corepack pnpm --filter @pwb/server dev`. `PWB_MODEL_PROVIDER=codex` selects the same three workers through the read-only, ephemeral Codex adapter, with the model and normal service settings documented above. Each is a separate session with a fresh id, a closed JSON schema, a deadline and an abort signal. The two adapters draw their filesystem boundary differently, and the difference is worth knowing before choosing one. A Claude session adds `--no-session-persistence` and a denied tool list: a critic keeps `Read` so it can open the screenshots it was handed, and every other Claude worker is denied the filesystem and the network entirely. A Codex session is confined by the CLI's `--sandbox read-only` and `--ephemeral` instead of a tool list. That sandbox stops writes, not reads, `-C` is a working directory and not a read ACL, and a prompt is not an ACL either, so the CLI enforces no read boundary at all. What the runner enforces is narrower and worth stating plainly: no session is ever *pointed at* the checkout. Every Codex session runs in a dedicated workspace created under the OS temporary directory, holding only the request's `allowlist` — each entry one regular file copied in under `allowlist/<n>/`, with the prompt rewritten to name the copies, so two entries sharing a basename cannot collide and none can shadow the schema; a directory is refused rather than copied in as a tree — plus the closed schema it must answer with, and removed when the session ends. That workspace is outside every checkout, so the session also passes `--skip-git-repo-check`, which the CLI requires before it will start anywhere no git repository contains. The allowlist is empty by default, because a worker is answered from its prompt; the prototype critic allowlists exactly its own screenshots, the images its prompt tells it to read last. A model that ignores the workspace and opens an absolute path elsewhere is not stopped by any of this; that is a mitigation of accidental repository reads, and OS-level read confinement is a separate captain's decision. No credential is read, requested, logged or stored, and no paid API is involved. CI and runs without `PWB_MODEL_PROVIDER` use the deterministic providers, which produce the same typed contracts.

## Finalization stage and Gate 3

The third stage compiles the approved document into an immutable release, has it
reviewed, and stops at the captain.

```bash
corepack pnpm run:release          # compile, critique, evaluate Gate 3, publish only a clean report
corepack pnpm run:evidence         # Vitest, Playwright on three engines, axe and Lighthouse
corepack pnpm test:e2e:release     # only the browser evidence
corepack pnpm run:lighthouse       # only the Lighthouse artifacts
```

Everything binds an ephemeral port the operating system chooses, so an evidence
run never contends with the studio on `5173`, the preview on `4311`, or another
worktree. `PWB_SITE_URL` and `PWB_SITE_NAME` set the origin and site name the
canonical URLs, the sitemap and Open Graph use; `PWB_RELEASE_ROOT`,
`PWB_EVIDENCE_DIR` and `PWB_FONTS_DIR` move the bundle, the artifacts and the
fonts. Preparing a release writes
the document it compiled to `<PWB_EVIDENCE_DIR>/release-document.json`, and every
runner reads it back from there. With no run to read, the fixture stands in.

**One document, one publish, gates in order.** Gate 3 refuses to prepare or
publish until the captain has approved identity and prototype on that run and the
finalization stage has produced the version they are looking at — rejecting that
proposal closes Gate 3 again until the stage runs anew, and rewinds to what the
prototype gate approved whether or not Gate 3 refined it. That version, plus the
review record the refiner writes onto it, is the run's release. A prepared
release belongs to that one proposal: rejecting it, or running the stage again,
discards it, and publishing a bundle prepared for another proposal is refused
rather than writing bytes the captain never approved.

Publishing the bundle *is* the finalization approval: there is no second action
that could close the gate, so nothing can write a release with a veto standing or
with the gate's open points unaccepted. The approve route refuses `finalization`
and the studio's finalization row points at the Gate 3 panel. One code path owns
the vetoes, the written acceptance, the `release.published` event, the release
record and the single bundle root, and it claims the gate before its first
await, so two publishes that race cannot both close it. A closed gate does not
reopen either: once the bundle is published the run has finished, so preparing
again is refused rather than moving a finished run's document.

Only the captain may accept an open escalation in writing. A scripted run —
`run:fixture` and `run:release` alike — goes through that same publish path
under the `fixture` role and only when the report is clean; with a veto or an
open point it prints the report and exits non-zero without writing, so the
release record never carries an acceptance no human wrote.

The finalization stage writes through the same boundary as every other stage:
its proposals declare the stage and the role the foundation pins to it, the
PatchGate validates them against the finalization patch schema, and only the
Applier writes a version. A critic proposes nothing at all, and the refiner
writes `/reviewRecord` and nothing else, because the bytes the release publishes
have to be the bytes the captain approved. A refinement becomes a real version of
the run: it is saved through the run's applier and repository, so the manifest
names a version that can be retrieved and a second Gate 3 run builds on the
first instead of redoing it. A patch that rewrites what the review record already
says is recognised on the dry run, so it neither mints a version nor spends its
idempotency key; it escalates instead. A model session that fails — the refiner,
the summarizer — escalates and the report still reaches the captain with every
veto and every artifact already computed.

**Self-hosted fonts.** The compiler never downloads a face. The owner puts the
files in the project's fonts directory (`PWB_FONTS_DIR`, default `fonts/`) with a
`manifest.json` beside them that names each one and the terms it came with:

```json
{
  "faces": [{
    "family": "Iosevka Etoile", "weight": "400", "style": "normal",
    "format": "woff2", "file": "iosevka-etoile-400.woff2",
    "license": "ofl-1.1", "licenseUrl": "https://openfontlicense.org",
    "source": "https://typeof.net/Iosevka/", "author": "Renzhi Li", "date": "2026-09-07"
  }]
}
```

One face is one file, in `woff2`, which every engine the release is measured on
reads. A face is self-hosted only when its licence clearly permits redistributing
the file with the site (`OFL-1.1`, `Apache-2.0`, `MIT`, `CC0-1.0`, `UFL-1.0`,
`CC-BY-4.0`); anything else stays unhosted and the stack falls back, so an
ambiguous licence degrades the typography instead of shipping a file the owner
may not redistribute. Either way the face gets a row in `licenses.json`, but the
bundle is a public artifact, so only a face the release actually ships publishes
the author, source, date, licence URL and hash the manifest declared; a face that
stays out is named with its licence and the reason it stays out, and what the
owner wrote about it — an invoice, a private note — never leaves the project's
own manifest. No manifest means no self-hosted face, which is the default; a
manifest that exists but cannot be read is an error, never silently no faces.

Every compile site reads the same directory — the studio's Gate 3, `run:release`,
`run:evidence`, `run:lighthouse` and the release harness — so the evidence
runners measure the bundle the gate credits. The preview serves those same faces
from its own origin under `font-src 'self'`, reading them again whenever the
manifest or any file it declares changes rather than once at start, so a face
added or re-exported while the studio runs reaches the captain's iframe and an
unreadable manifest fails that request rather than the studio. Gate 3 then
compares the faces the preview actually served against the ones the bundle ships,
so a face replaced after the captain looked at it is a divergence and not an
identical route, and `tests/release/parity.spec.ts` asks both sides what they
actually loaded rather than comparing two fallbacks.

So that this last check measures a face instead of an empty `document.fonts`,
installing seeds `fonts/` with one real face — Fraunces 400 normal, under the
OFL, taken from the `@fontsource/fraunces` dev dependency rather than from a
binary in this repository or a download at compile time
(`scripts/seed-fixture-fonts.ts`, run by `prepare`; `corepack pnpm prepare`
seeds it again). It is the family the fixture identity already names in its
display stack, so text on every route loads it. The seeding happens once, at
install, because every compile site reads that directory: seeding it later would
move the digest between the gate and the runners meant to measure the gate's
bundle. A `manifest.json` already there is left untouched — the faces an owner
put in their own project are theirs — and a checkout installed with
`--ignore-scripts` simply has no face, which is the default this repository
shipped before. The observed parity counts are recorded in [Verified runs](docs/verified-runs.md).

**Release vetoes.** Eight objective stop conditions, catalogued in
`packages/stage-finalization/src/veto-catalog.ts`: a secret in the bundle, an
XSS or `javascript:` URL, unsanitized HTML, a bundled asset without a licence, a
build failure, a broken primary link, a critical AA regression, and a release
that diverges from the approved one. Whether an asset is bundled is read back
out of the documents the compiler wrote, never from its lifecycle status: only a
`data:` asset a compiled page references travels inside the bundle. Only what
the bundle ships can be published without terms, so an asset the release never
carries — one no page references, or one pointing at a remote URI — escalates to
the captain instead of blocking, and its `licenses.json` row names its licence
and the reason it stays out and nothing the owner declared about it, exactly as
for a face the release does not redistribute. A veto is never scored or averaged: one veto
blocks Gate 3, and the single publish path refuses to write. Only the compiler,
the evidence runners and the gate may raise one — a critic cannot raise or clear a veto, its
tasks carry no writable path, and its findings have no veto severity.

**Independent evidence.** Four runners that do not know what the gate wants to
hear write typed artifacts into `artifacts/release/`, and the gate reads those
files. `evidenceVetoes` derives every veto the evidence can raise from what the
runners measured — axe's raw violation counts, a failed Vitest or Playwright run
— and never from a field a runner chose to set, because an artifact has no such
field to set; and
`sealSummary` overwrites the summarizer's veto count with the authoritative one,
so no summary can hide a veto. What the gate did — each refinement cycle, a
critic or a model session that failed, the verdict itself — is written to the
run's event log as it happens, so a blocked Gate 3 leaves a durable trace. A runner that did not run leaves no artifact, and
the gate reports the gap as an escalation instead of treating silence as a pass.

Every artifact names the release it measured — the bundle digest and the
document hash — and only the artifacts that measured this bundle are credited,
by the gate and by the five critics alike, so a stale measurement can neither
block a release nor score a rubric. Anything else is set aside and reported as coverage the gate does not
have, so a run never inherits an earlier run's evidence in silence. An artifact
that measured the same bytes from a different document is credited and the
difference is named, because that is what the refiner recording a finding does.

The observed release-engine evidence is recorded in [Verified runs](docs/verified-runs.md).

Publishing over an open escalation takes a written reason from the captain, recorded in the run's log as `release.published` and in the release record beside the bundle. The manifest inside the bundle is a pure
function of the compiled bytes and the toolchain — it names no document, no
version, no publication and no path on the machine that compiled it — so writing
the same bytes again is an idempotent success that appends a second entry to
`<digest>.publications.json`, where the approved version, the released version,
the document hash and the acceptance live. That record is the only durable home
for them, so a damaged one refuses the next append instead of being replaced.

Lighthouse is a laboratory run. It measures one machine and one network, does
not observe a visitor, and does not measure INP without interaction; the
artifacts say so rather than implying field data. axe finds part of what WCAG
requires and returns `incomplete` where a human must look, which the artifacts
also record.

**Reproducibility and parity.** The bundle directory is the digest of every file
it contains, the manifest carries no timestamp, and the same document and
toolchain produce byte-identical bundles. Parity is proven twice: Vitest fixtures
read the compiled stylesheet back with a parser that shares no code with the
compiler that wrote it, and `tests/release/parity.spec.ts` compares computed
styles, text and the faces each side actually loaded, between the preview and the
release in every engine. Both release runners write their typed artifacts from
their teardown, so a run the per-test timeout aborts still leaves one — naming
the routes and widths it never measured — and a divergence a browser sees
reaches Gate 3 as a failed measurement, a `BUILD_FAILED` veto, instead of only
turning a test red. Each of those artifacts keeps the same id whether the run
passed or failed, so a clean re-run replaces the verdict of the aborted one
rather than leaving it standing. An engine that never launches still leaves no artifact at
all, so it stays the missing engine the captain accepts in writing.

**Gate 3.** The studio panel shows the digest, the standing vetoes, the rubric
each critic gave on the 0–4 scale with a minimum of 3, parity per route, which
runners produced evidence, and what escalates. Publishing sends the digest the
captain is looking at, so a release that moved since the report cannot be
published by mistake, and an open escalation takes a written acceptance the run's
log and the release record keep. Only the captain publishes.

### Real critic sessions

CI and runs without `PWB_MODEL_PROVIDER` use the deterministic providers. `PWB_MODEL_PROVIDER=claude-code`
switches the five critics, the patch-refiner and the release-summarizer to the
owner's local Claude Code binary through `ClaudeJsonRunner`, which uses the same
boundary as `ClaudeRunner`: `execFile` with no shell, a fresh session that is
never persisted, tools denied, a deadline and an abort signal. It never reads,
stores, prints, forwards or asks for a credential, and no paid API is involved.

```bash
corepack pnpm run:evidence
PWB_MODEL_PROVIDER=claude-code corepack pnpm run:release
```

The same variable switches the studio's Gate 3 routes when the server starts.

Set `PWB_MODEL_PROVIDER=codex` to use the same critics, refiner and summarizer
through the Codex adapter documented above:

```bash
PWB_MODEL_PROVIDER=codex corepack pnpm run:release
```

## Quality and security checks

The test suite covers schema validation, page-graph integrity, alias cycles/orphans, byte-stable rendering, token-only linting, identity token roles, CSS-emittable tokens, forbidden defaults, CAS/overlap rejection, semaphore limits and deadlines, immutable versioning, SQLite WAL, captain-only approvals, isolated preview headers, the licence inventory the release compiler writes, the full fixture journey, cancellation/restart, and scans of database, log and compiled-bundle data for secret-like values. The identity stage adds hue-invariant palette comparison, `ID-003` and `DIV-030` against tampered documents, sibling branches that share one parent, the scheduler lane limit during the fan-out, a critic whose patch is discarded, a single refinement cycle whose repair is read again by the critics, the single corrective re-invocation of a schema-invalid artefact, one worker's malformed answer costing only its own branch, imagery generated only after approval and only for a direction that admits the raster source, a re-approval that reuses the image it already has instead of shooting it again, captain-only Gate 1 with a written override, the token change that reopens the gate, re-closes it and drops the render cache entries the hub wrote for the approved version, a restarted server that serves and decides an open gate and refuses to create over it, imagery that is shot on the raster lane after the gate closes and lands as a failed asset when the run is cancelled, a re-approval that returns while an earlier batch is still shooting, an image the ended process was shooting coming back settled rather than generating, a direction admitting no raster source that cannot be submitted for, two cold requests deciding one restored run at once and building a single run between them, a captain-only stop that leaves an undecided run cancelled and neither startable nor approvable — still cancelled after a restart — while a stop arriving after the fan-out finished keeps its candidates decidable, and the MCP client against a fake stdio server — session handshake, a url returned as prose or as a JSON text block, an unrecognised answer shape named on the provenance, and a refusal or an abort recorded as a failed asset rather than a failed gate. The prototype stage adds the section-window contracts, the closed critic vocabulary, the guarded compilation of every allowlisted repair, each of the loop's stop conditions observed through the stage itself, and the seven prototype linter rules. `corepack pnpm test:e2e` additionally drives the Studio through all three gates and through the Gate 1 and Gate 2 reviews, checks the three-card Gate 1 layout for sideways scroll at 1440, 768 and 390 px, and exercises `RenderHub` against a live browser, both for a single cached case and for the whole route x viewport x state matrix served by the isolated preview server. Several checkouts of this repo share one machine, so set `PWB_E2E_PORT_BASE` to give a run its own API, preview and Studio ports instead of reusing whatever already listens on the developer ones: `PWB_E2E_PORT_BASE=4520 corepack pnpm test:e2e`. With that block the harness serves the Studio from Vite's dev server; on the default ports it serves the built bundle instead, so run `corepack pnpm build` first.

Fase 1 adds parallel identity directions, the identity critics and the `ID-003` and `DIV-030` rules. Fase 2 adds the prototype stage, its critics and the prototype half of the linter catalogue. Fase 3 adds the release compiler, the release critics, the evidence runners and Lighthouse. Still absent: Postgres, SaaS authentication, Yjs/CRDT collaboration, and Astro output.
