# Phase 0 Foundation Design

> **Historical record.** This is the Fase 0 design as written on 2026-09-05, and it describes only that foundation. Later phases moved past several of its statements — Fase 2 added `packages/qa-deterministic` and `packages/stage-prototype`, the critics and the prototype linter rules; Fase 3 added the release critics, the independent evidence runners and Lighthouse, and its release compiler now derives a Content-Security-Policy from what the bundle contains. `README.md` and the schemas in `packages/domain` own the delivered contracts; read them instead of this file.

## Context and goal

pro-website-builder is a local, personal tool that compiles a visual identity into a reviewable prototype and a static production site. Phase 0 establishes the contracts that make later visual exploration safe: the identity is an approved input, the document is versioned, agents propose typed changes, one deterministic renderer produces every surface, and the orchestrator pauses at three captain-only gates.

The implementation is deliberately smaller than the future product. It proves the complete path with one deterministic fake worker per stage, while leaving extension points for parallel directions, critics, richer linting, and additional providers.

## Architecture

The repository is a pnpm workspace with two applications and seven packages. `packages/domain` owns all schemas and document invariants. `packages/renderer` is pure TypeScript and produces byte-stable HTML/CSS from a `DesignIR`; it has no DOM, React, or provider dependency. `packages/orchestrator` owns the fixed stage DAG, scheduling, compare-and-swap patch application, immutable versions, events, and approvals. Providers can only return validated proposals or asynchronous asset jobs. `apps/server` is the local API/SQLite/preview host, and `apps/studio` is a plain React editor that uses API responses and opens a sandboxed preview on another origin.

The main flow is:

```text
brief -> identity proposal -> captain gate 1 -> prototype proposal
      -> captain gate 2 -> deterministic finalization -> captain gate 3
      -> content-addressed static export
```

Only the `Applier` creates a new document version. A patch carries its base version, allowed paths, touched paths, rationale, confidence, and an idempotency digest. A stale or overlapping patch is rejected without mutating storage. A rejected gate rewinds to the parent version and returns the stage to a re-runnable state; the identity itself is frozen once the captain approves Gate 1, so no later stage may rewrite it.

## Domain contracts

`DesignIR` contains metadata, an `IdentitySpec`, DTCG-compatible tokens, a page graph, an asset ledger, state fixtures, and review data. Pages are composed from stable primitive nodes (`stack`, `grid`, `cluster`, `media`, `type`, `surface`, `ornament`) and approved components. `IdentitySpec` stores strategy, direction, grid grammar, imagery, iconography, content/voice, do/don't rules, forbidden defaults, governance, and provenance.

Runtime validation uses Zod. The same schemas expose JSON Schema for Claude Code calls. Token aliases are resolved with explicit circular/orphan errors. Renderer values must be token references, with no exception path in Phase 0; the gate refuses a reference the identity does not define, and raw colors, dimensions, font values, radii, shadows, and motion values are rejected by the linter and the renderer.

## Runtime boundaries and safety

`ClaudeRunner` invokes the locally installed `claude` with `execFile`, no shell, one-shot session UUIDs, `--no-session-persistence`, structured JSON output, schema validation, abort support, and timeouts. It never probes the binary, reads credentials, or persists them; the owner verifies `claude --version` before starting a run, as `README.md` describes. `FakeModelProvider` is used by all CI tests. `HiggsfieldMcpProvider` is optional and reports `not configured` without asking for credentials; placeholder assets remain visibly flagged in provenance.

Preview is served from a separate server port/origin and embedded with `<iframe sandbox>` without `allow-same-origin`, so the studio and the preview share no same-origin channel and exchange no postMessage values at all; the studio reaches the API only over `fetch`. CSP forbids inline script and eval on the preview response; the static export is written as bare files meant to be opened from disk and carries no CSP of its own. Database, logs, and export scanning tests fail on secret-like strings.

SQLite uses WAL and a single-writer queue. Versions and events are append-only; the initial persistence implementation stores JSON snapshots in Drizzle-declared relational tables for projects, versions, runs, tasks, patches, approvals, and events, created on open by one idempotent SQL bootstrap guarded by a `PRAGMA user_version` schema number rather than by a migration tool.

## Verification

Vitest covers schemas, token resolution, deterministic rendering, linter rules, scheduler/patch semantics, fake providers, persistence, and export. Playwright covers the studio flow, the separate-origin preview, the responsive render cases, and the captain-only gates. The end-to-end fixture completes identity, prototype, finalization, approval, and export using fakes. A cancellation/restart test proves no partially applied revision is visible, and a repository scan proves no credential-like string enters persistence, logs, or the export bundle.

## Intentional Phase 0 limits

There are no parallel identity directions, critic agents, full genericness catalog, Postgres, authentication/SaaS, Yjs/CRDT, Astro target, or Lighthouse integration. The package interfaces and event model are designed so those capabilities can be added without bypassing the renderer, patch gate, or approval gates.
