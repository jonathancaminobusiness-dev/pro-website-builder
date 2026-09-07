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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
