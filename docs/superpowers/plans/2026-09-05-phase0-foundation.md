# Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested local-first monorepo that carries one fixed briefing through identity, prototype, finalization, captain approvals, deterministic preview, and static export.

**Architecture:** Domain schemas and immutable document versions are the center of the system. Providers return typed proposals only; the orchestrator validates and applies patches; one pure renderer serves the studio, isolated preview, and export. The server owns SQLite WAL and the fixed stage DAG, while the Vite studio remains a thin review client.

**Tech Stack:** pnpm workspaces, TypeScript project references, Vite, React, Node HTTP, Zod, Drizzle ORM with better-sqlite3, Vitest, Playwright Chromium, CSS custom properties, and local Claude Code/Higgsfield adapters.

**Spec:** `docs/superpowers/specs/2026-09-05-phase0-foundation-design.md`

## Global Constraints

- Code, identifiers, commit messages, and technical docs are English; studio copy is pt-BR.
- Local personal tool only; never collect, store, print, or forward credentials or tokens.
- Renderer is pure TypeScript with no DOM or React dependency.
- Agents return schema-validated JSON proposals and patches, never HTML or JSX.
- Only the patch applier writes immutable document versions.
- Studio and preview are separate origins; preview uses sandboxed iframe and strict CSP.
- Default concurrency is three Claude processes and one raster job; all limits are configurable.
- The v1 approver role is only `captain`.
- Fase 0 excludes parallel directions, critics, full linter catalog, Postgres, SaaS auth, Yjs, Astro, and Lighthouse.

---

### Task 1: Workspace and project boundaries

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `.npmrc`, `vitest.config.ts`, `playwright.config.ts`
- Create: package manifests and `tsconfig.json` files for `packages/*` and `apps/*`
- Modify: `.gitignore`, `README.md`
- Create: `AGENTS.md` and `CLAUDE.md` pointer through `fm-ensure-agents-md.sh`

**Interfaces:**
- Produces workspace scripts `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:e2e`.
- Produces project-reference packages with no circular dependencies.

- [ ] Add the workspace manifests and strict compiler settings.
- [ ] Add `.treehouse/`, SQLite files, Playwright output, and generated export paths to `.gitignore`.
- [ ] Update README with architecture, local fake-provider flow, Claude Code prerequisites, and security boundaries.
- [ ] Run `pnpm install`, `pnpm typecheck`, and `pnpm test` after the empty workspace is valid.
- [ ] Commit `chore: scaffold phase 0 workspace`.

### Task 2: Domain schemas and token resolver

**Files:**
- Create: `packages/domain/src/identity.ts`, `packages/domain/src/tokens.ts`, `packages/domain/src/ir.ts`, `packages/domain/src/agent.ts`, `packages/domain/src/approval.ts`, `packages/domain/src/schema-json.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/src/*.test.ts`
- Create: `fixtures/brief.json`, `fixtures/proposals/*.json`

**Interfaces:**
- `DesignIRSchema`, `IdentitySpecSchema`, `PatchSchema`, `AgentTaskSchema`, `ApprovalSchema`.
- `resolveTokens(tokens): ResolvedTokenSet` and `tokenRef(path): string`.
- `createFixtureIR(): DesignIR`.

- [ ] Write failing schema tests for a valid fixture, rejected raw token values, alias cycles, and orphan aliases.
- [ ] Run the focused Vitest tests and observe the missing-schema failures.
- [ ] Implement strict Zod schemas with DTCG `$value`, `$type`, `$description`, aliases, and organization-only groups.
- [ ] Implement token resolution and stable canonical hashing.
- [ ] Run the focused tests and commit `feat: add domain contracts and token resolver`.

### Task 3: Pure deterministic renderer

**Files:**
- Create: `packages/renderer/src/render.ts`, `packages/renderer/src/css.ts`, `packages/renderer/src/html.ts`, `packages/renderer/src/index.ts`
- Test: `packages/renderer/src/renderer.test.ts`

**Interfaces:**
- `renderDesign(ir, options): RenderedDocument` returning `{ html, css, routes, irHash, rendererVersion }`.
- `RenderedDocument` contains no executable model output and uses semantic HTML/CSS layers, custom properties, and container queries.

- [ ] Write failing tests for token-only output, stable bytes for repeated renders, mobile-first CSS, and route generation.
- [ ] Run them red.
- [ ] Implement a small renderer for fixture primitives and page graph nodes; encode all visual values as token references.
- [ ] Reject unresolved token refs and unsigned raw visual values before output.
- [ ] Run renderer tests and commit `feat: add deterministic token renderer`.

### Task 4: Linter and static export

**Files:**
- Create: `packages/linter/src/rules.ts`, `packages/linter/src/index.ts`, `packages/linter/src/linter.test.ts`
- Create: `packages/export/src/export.ts`, `packages/export/src/index.ts`, `packages/export/src/export.test.ts`

**Interfaces:**
- `LintRule`, `Finding`, `lintDesign(ir): LintReport` with `TOK-001`, `TOK-002`, `DEF-010` and registry stubs for `STR`, `DIV`, `GRID`, `TYPE`, `MEDIA`, `COH`, `MOTION`, `A11Y`, `SIM`, `COPY`.
- `exportStatic(rendered, ir, outDir): ExportManifest` and `exportDigest(...)`.

- [ ] Write failing tests for token/default findings, registry stubs, deterministic content-addressed output, and license refusal.
- [ ] Run them red.
- [ ] Implement linter rules and export manifest with asset provenance/licenses.
- [ ] Verify exported route bytes equal the renderer output and commit `feat: add lint and deterministic export`.

### Task 5: Providers and orchestration semantics

**Files:**
- Create: `packages/providers/src/model.ts`, `packages/providers/src/fake-model.ts`, `packages/providers/src/claude-runner.ts`, `packages/providers/src/raster.ts`, `packages/providers/src/fake-raster.ts`, `packages/providers/src/higgsfield.ts`, `packages/providers/src/index.ts`
- Create: `packages/orchestrator/src/planner.ts`, `packages/orchestrator/src/scheduler.ts`, `packages/orchestrator/src/patch-gate.ts`, `packages/orchestrator/src/applier.ts`, `packages/orchestrator/src/events.ts`, `packages/orchestrator/src/index.ts`
- Test: `packages/providers/src/*.test.ts`, `packages/orchestrator/src/*.test.ts`

**Interfaces:**
- `ModelProvider.propose(task): Promise<AgentResult>` and `RasterProvider.submit(job): Promise<RasterJob>`.
- `RunPlanner.plan()`, `Scheduler.run()`, `PatchGate.validate()`, `Applier.dryRun()` and `Applier.apply()`.
- States: `queued`, `running`, `cancel_requested`, `cancelled`, `succeeded`, `failed`, `needs_review`.

- [ ] Write failing tests for fixed DAG, semaphore caps, timeout/cancel cascade, idempotency, stale-base and overlap rejection, inverse patches, and fake provider output.
- [ ] Run the focused tests red.
- [ ] Implement provider interfaces, fake fixtures, Claude `execFile` invocation, optional Higgsfield `not configured`, and deterministic orchestration.
- [ ] Implement retry classification and one schema-correction attempt without logging subprocess secrets.
- [ ] Run focused tests and commit `feat: add typed providers and orchestration`.

### Task 6: SQLite persistence

**Files:**
- Create: `apps/server/src/db/schema.ts`, `apps/server/src/db/migrations/*`, `apps/server/src/db/repository.ts`, `apps/server/src/db/writer.ts`, `apps/server/src/db/db.test.ts`

**Interfaces:**
- `ProjectRepository`, `VersionRepository`, `RunRepository`, `PatchRepository`, `ApprovalRepository`, `AssetRepository`, `EventRepository`.
- All writes pass through one serialized writer queue; version snapshots are immutable.

- [ ] Write failing tests for WAL mode, immutable parent/version rows, append-only events, approval freeze, and token-change invalidation.
- [ ] Run red.
- [ ] Implement Drizzle schema/migrations, repository adapters, and serialized writes.
- [ ] Add a dump scanner that rejects secret-like values and run the persistence tests.
- [ ] Commit `feat: persist immutable runs and approvals in sqlite`.

### Task 7: RenderHub and isolated preview

**Files:**
- Create: `packages/render-hub/src/cases.ts`, `packages/render-hub/src/hub.ts`, `packages/render-hub/src/cache.ts`, `packages/render-hub/src/index.ts`, `packages/render-hub/src/hub.test.ts`
- Create: `apps/server/src/preview.ts`, `apps/server/src/security.ts`, `apps/server/src/index.ts`

**Interfaces:**
- `RenderHub.render(version, cases): Promise<RenderCaseResult[]>` for 360/768/1440, light/dark, and reduced-motion.
- `createPreviewServer(rendered): PreviewServer` on a separate port with strict CSP.

- [ ] Write failing Playwright/unit tests for route screenshots, DOM/AX data, overflow/console checks, content-addressed cache, CSP, and sandbox attributes.
- [ ] Run red.
- [ ] Implement Chromium RenderHub using readiness signals rather than sleeps and expose QA results to gates.
- [ ] Implement preview origin and exact-origin postMessage protocol.
- [ ] Run focused tests and commit `feat: add render hub and isolated preview`.

### Task 8: Local API and plain studio flow

**Files:**
- Create: `apps/server/src/api.ts`, `apps/server/src/fixture-run.ts`, `apps/server/src/server.test.ts`
- Create: `apps/studio/index.html`, `apps/studio/src/main.tsx`, `apps/studio/src/App.tsx`, `apps/studio/src/styles.css`, `apps/studio/src/studio.test.tsx`

**Interfaces:**
- API endpoints `GET /api/projects/:id`, `POST /api/runs`, `POST /api/runs/:id/approve`, `POST /api/runs/:id/cancel`, `GET /api/preview/:version/:route`.
- Studio actions are labeled in pt-BR: carregar projeto, executar etapa, revisar proposta, aprovar/rejeitar gate, abrir preview, exportar.

- [ ] Write failing tests for the fixture journey and captain-only approval role.
- [ ] Run red.
- [ ] Implement the API using fake providers by default and connect the React review UI.
- [ ] Add the sandboxed iframe with a separate preview origin and a visible QA summary.
- [ ] Run the focused UI tests and commit `feat: add studio and local api`.

### Task 9: End-to-end proof and documentation

**Files:**
- Create: `scripts/run-fixture.ts`, `tests/e2e/phase0.spec.ts`, `tests/security/no-secrets.test.ts`
- Modify: `README.md`

**Interfaces:**
- CLI exits non-zero on any failed gate, lint finding, missing license, or export mismatch.
- E2E writes an export directory with a manifest and three routes.

- [ ] Write the failing end-to-end and cancellation/restart tests.
- [ ] Run the red tests.
- [ ] Implement the CLI and complete fake-provider fixture journey.
- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e` from a clean generated database/export directory.
- [ ] Scan database dump, logs, and bundle for secret-like strings.
- [ ] Commit `test: prove phase 0 fixture journey`.

### Task 10: Final review and handoff

**Files:**
- Modify: any files required by fresh verification only.

- [ ] Review the spec against the implementation and check that every Phase 0 acceptance item has evidence.
- [ ] Run `git diff --check`, `git status --short`, and the full test/build suite again.
- [ ] Commit only if the review found a real scoped correction.
- [ ] Append the required `done:` status line after the branch contains the committed delivery.
