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
- `packages/orchestrator` owns the fixed stage DAG, semaphores, deadlines, cancellation, patch CAS, immutable versions, and events.
- `packages/providers` isolates the owner's local Claude Code binary, optional Higgsfield MCP, and deterministic fakes.
- `packages/render-hub` uses Playwright Chromium for responsive screenshots, DOM/accessibility data, and deterministic QA.
- `packages/export` writes content-addressed static routes and a license/provenance manifest.

The renderer refuses raw visual values. Colors, dimensions, font settings, radii, shadows, and motion must resolve through tokens unless a captain-signed node exception exists. Preview is served on port `4311`, separate from the Studio/API origin, and the Studio iframe uses `sandbox` without `allow-same-origin`.

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

The command writes a local SQLite database under `.treehouse/` and a content-addressed export under `exports/`. Set `PWB_DB_PATH` and `PWB_EXPORT_ROOT` to use explicit locations, and `PWB_MODEL_PROVIDER` to choose the model provider.

Start the local API and preview, then the Studio in another terminal:

```bash
corepack pnpm --filter @pwb/server dev
corepack pnpm --filter @pwb/studio dev
```

The API is `http://127.0.0.1:4310`, the isolated preview is `http://127.0.0.1:4311`, and Vite serves the Studio on its normal development port. The Studio copy is pt-BR; code and technical identifiers remain English.

## Real local Claude Code

CI and the fixture use `FakeModelProvider`. `PWB_MODEL_PROVIDER` selects the model provider for both `corepack pnpm --filter @pwb/server dev` and `corepack pnpm run:fixture`: `fake` (the default) or `claude-code`. To exercise the real adapter, install and log in to the unmodified Claude Code binary as its owner, verify `claude --version`, then start either entry point with `PWB_MODEL_PROVIDER=claude-code`. The runner uses `execFile` with no shell, a fresh session UUID, `--no-session-persistence`, structured JSON, schema validation, deadlines, and abort signals. It never reads, stores, prints, forwards, or asks for tokens or credentials. No paid API is required by this repository.

Higgsfield is an optional asynchronous raster boundary. If its MCP is not configured, the pipeline continues with a provenance-marked placeholder asset; credentials are never requested or persisted.

## Quality and security checks

The test suite covers schema validation, alias cycles/orphans, byte-stable rendering, token-only linting, forbidden defaults, CAS/overlap rejection, semaphore limits, immutable versioning, SQLite WAL, captain-only approvals, isolated preview headers, export licenses, the full fixture journey, cancellation/restart, and scans of database/log/export data for secret-like values.

Fase 0 intentionally does not include parallel identity directions, critic agents, the full linter catalog, Postgres, SaaS authentication, Yjs/CRDT collaboration, Astro output, or Lighthouse.
