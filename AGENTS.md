# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

- Use Corepack commands from `README.md` because pnpm is not assumed to be globally installed.
- Keep generated sites flowing through `packages/domain` → `packages/orchestrator` → `packages/renderer`; agents must not write HTML/JSX directly.
- The server/API and isolated preview ports, provider safety boundary, and fixture CLI are documented in `README.md` and `apps/server/src/index.ts`.
- Several checkouts of this repo run side by side. Never kill a process you did not start, bind every server a test or a script opens to port 0, and run the Playwright suite with `PWB_E2E_PORT_BASE` set — without it the harness reuses whatever already listens on the developer ports, which silently tests another checkout's build.
- An agent proposes domain-typed JSON validated by a Zod schema — a `RouteManifest`, a `SectionComposition`, a `CritiqueReport` — never a JSON Patch and never markup. Deterministic code compiles that JSON into the patch; see `packages/stage-prototype`.
- Parallel workers stay disjoint by contract, not by locking: each section composer owns a contiguous window of node slots and the `PatchGate` refuses any overlap before the merged patch reaches the applier.
- The preview origin serves `script-src 'none'`. Anything that has to run in a previewed page goes through `page.evaluate`, never `addScriptTag`; `packages/render-hub/src/hub.ts` shows both that and the `__name` shim a transpiler forces on serialized browser functions.
- Deterministic checks that a browser measures live in `packages/qa-deterministic`; checks the typed document can decide live in the linter. Keep new rules on the side that can actually answer them.
- The node prop and semantic vocabularies are closed on purpose. Widening either means teaching the renderer to read the new field in the same change, the way `responsive` is read as a container query — a field nothing reads is the reason the earlier one was removed.
- Release vetoes, the evidence runners and the Gate 3 commands are described under "Finalization stage and Gate 3" in `README.md`; the veto catalogue itself is `packages/stage-finalization/src/veto-catalog.ts`.
- A veto is objective and blocking, and a critic can raise none: critic tasks carry an empty `allowedPaths`, `ReleaseFinding` has no veto severity, and `evaluateReleaseGate` recomputes every veto from the compiled bundle and the raw artifacts. Keep it that way when extending the stage.
- There is one publish path: `ReleaseRun.publish`. Publishing the Gate 3 bundle *is* the finalization approval — `FixtureRun.approve` refuses that stage, `publishRelease` refuses a bundle prepared for another proposal and claims the gate before its first await — so vetoes, the acceptance of open escalations, the `release.published` event and the single bundle root all live in one place. Nothing else calls `writeReleaseBundle`.
- Only `approverRole: 'captain'` may accept an open escalation. A script publishes as `'fixture'` and only when the report has no veto and no escalation, so no scripted run ever signs for the captain; `run:fixture` and `run:release` stop at Gate 3 and exit non-zero when anything is open.
- A bundle's `manifest.json` is a pure function of the compiled bytes and the toolchain and names no document, version, publication or host path; the bundle is a public artifact. Provenance and acceptance go to `<releaseRoot>/<digest>.publications.json` (`appendReleasePublication`) and the run's event log, so republishing identical bytes stays idempotent.
- Evidence counts only when its `releaseDigest` matches the bundle being evaluated, for the five critics as much as for the gate: `FinalizationStage` credits with `partitionEvidence` before it builds a critic slice, so a stale artifact never scores a rubric. A gap is an escalation the captain accepts in writing, never a silent pass.
- A face reaches a release only through the project's fonts manifest (`PWB_FONTS_DIR`, default `fonts/`, documented in `README.md`); the compiler never downloads one. Every compile site must load it — Gate 3, `run:release`, `run:evidence`, `run:lighthouse` and `tests/release/global-setup.ts` — or the evidence names a digest the gate does not credit. The bundle is public, so only a face the release ships publishes its declared provenance.
- Every runner under `tests/release/` writes a typed artifact from its teardown, pass or fail — including a run the per-test timeout aborts — because the gate reads artifacts and nothing else. A body that never started writes none: an engine that cannot launch on a host is a missing engine the captain accepts in writing, never a failed measurement.
- `designIRSchema.parse` normalizes the document, so a version from the Applier can compile to a different digest than the same fixture compiled directly. Derive an expected digest from the version, not from `createFixtureIR()`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
