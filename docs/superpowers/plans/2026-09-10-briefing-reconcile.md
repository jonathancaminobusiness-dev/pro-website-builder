# Free Briefing Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one server-owned briefing normalization contract for every identity execution while preserving the existing Studio and persistence behavior.

**Architecture:** The server briefing module will expose a typed single-argument normalizer that returns the legacy briefing only for omitted input. The HTTP API and `IdentityRun` will use the same function before execution creation, so SQLite, snapshots, restart restoration, and curator prompts all consume the normalized value.

**Tech Stack:** Node HTTP, TypeScript, Vitest, SQLite-backed repository, existing `@pwb/domain` briefing constants.

**Spec:** `docs/superpowers/specs/2026-09-10-briefing-reconcile-design.md`

## Global Constraints

- Omitted briefing is the only compatibility path and returns `IDENTITY_BRIEFING`.
- Supplied briefing is a string, trimmed, non-empty, and at most `IDENTITY_BRIEFING_MAX_LENGTH` characters.
- The maximum is defined once and reused by server validation and the Studio contract.
- No provider, deadline, failure-reconstruction, prototype, or security changes.
- Tests use ephemeral ports and preserve the existing project test commands.

---

### Task 1: Prove the server normalizer contract

**Files:**
- Modify: `apps/server/src/identity-briefing.test.ts`

**Interfaces:**
- Consumes: the existing `IDENTITY_BRIEFING` and `IDENTITY_BRIEFING_MAX_LENGTH` exports.
- Produces: failing coverage for `normalizeIdentityBriefing(value)` and its `BriefingValidationError` messages.

- [ ] **Step 1: Write the failing test**

```ts
import { BriefingValidationError, normalizeIdentityBriefing } from './identity-briefing.js';

it('normalizes supplied values and rejects invalid server-layer input', () => {
  expect(normalizeIdentityBriefing('  Nicho editorial.  ', true)).toBe('Nicho editorial.');
  expect(normalizeIdentityBriefing(undefined, false)).toBe(IDENTITY_BRIEFING);
  expect(() => normalizeIdentityBriefing(' \n\t ', true)).toThrow(BriefingValidationError);
  expect(() => normalizeIdentityBriefing('a'.repeat(IDENTITY_BRIEFING_MAX_LENGTH + 1), true)).toThrow(BriefingValidationError);
  expect(() => normalizeIdentityBriefing(42, true)).toThrow(BriefingValidationError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run apps/server/src/identity-briefing.test.ts`

Expected: FAIL because the normalizer and validation error do not yet exist.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/identity-briefing.test.ts
git commit -m "test(server): define briefing normalization contract"
```

### Task 2: Centralize and enforce briefing normalization

**Files:**
- Modify: `apps/server/src/identity-briefing.ts`
- Modify: `apps/server/src/identity-api.ts`
- Modify: `apps/server/src/identity-run.ts`
- Modify: `apps/server/src/db/repository.ts`
- Modify: `apps/server/src/identity-api.test.ts`
- Modify: `apps/server/src/identity-run.test.ts`

**Interfaces:**
- Consumes: `normalizeIdentityBriefing(value: unknown): string` and `BriefingValidationError` from `identity-briefing.ts`.
- Produces: API 400 validation through the shared normalizer and normalized values for direct `IdentityRun` construction and persistence.

- [ ] **Step 1: Write the failing direct-construction test**

```ts
it('normalizes a direct execution briefing before persistence and curator use', async () => {
  const repository = new ProjectRepository(database);
  const run = new IdentityRun({
    runId: 'identity-normalized-direct',
    repository,
    provider: new FakeIdentityProvider(),
    briefing: '  Nicho de cerâmica autoral.  ',
  });

  await run.initialize();

  expect((await repository.getRun('identity-normalized-direct'))?.briefing).toBe('Nicho de cerâmica autoral.');
  expect(run.snapshot().briefing).toBe('Nicho de cerâmica autoral.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run apps/server/src/identity-run.test.ts -t "normalizes a direct execution briefing"`

Expected: FAIL because direct construction currently stores the surrounding whitespace.

- [ ] **Step 3: Write minimal implementation**

Use `normalizeIdentityBriefing(options.briefing, options.briefing !== undefined)` in `IdentityRun` construction, call the same normalizer for the HTTP `briefing` property-presence branch, and pass the normalized value to `createRun`. Keep the omitted-field fallback explicit and keep the existing Portuguese error payloads.

- [ ] **Step 4: Run focused tests to verify it passes**

Run: `corepack pnpm exec vitest run apps/server/src/identity-api.test.ts apps/server/src/identity-briefing.test.ts apps/server/src/identity-run.test.ts`

Expected: PASS, including API rejection, migration default, restart restoration, and curator propagation.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/identity-briefing.ts apps/server/src/identity-api.ts apps/server/src/identity-run.ts apps/server/src/db/repository.ts apps/server/src/identity-api.test.ts apps/server/src/identity-run.test.ts
git commit -m "fix(server): centralize identity briefing validation"
```

### Task 3: Verify the complete feature surface

**Files:**
- No production changes expected.

**Interfaces:**
- Consumes: the normalized server contract and existing Studio renderer API.
- Produces: build, typecheck, focused test, and relevant E2E evidence.

- [ ] **Step 1: Run typecheck and build**

Run: `corepack pnpm typecheck && corepack pnpm build`

Expected: PASS for all workspace projects.

- [ ] **Step 2: Run the complete relevant unit tests**

Run: `corepack pnpm exec vitest run apps/server/src/identity-api.test.ts apps/server/src/identity-briefing.test.ts apps/server/src/identity-run.test.ts apps/studio/src/gate1/IdentityGate.test.ts packages/renderer/src/briefing-editor.test.ts`

Expected: PASS for API, persistence/restart, curator, Studio, and renderer coverage.

- [ ] **Step 3: Run the briefing E2E suite with an isolated port base**

Run: `PWB_E2E_PORT_BASE=4890 corepack pnpm exec playwright test tests/e2e/identity-briefing.spec.ts --reporter=line`

Expected: PASS for initial input, replacement reuse, reload hydration, and max-length behavior.

- [ ] **Step 4: Commit any test-only cleanup**

```bash
git status --short
```

Expected: only intentional source/test/docs changes are present; no generated `dist/` or test artifacts are committed.
