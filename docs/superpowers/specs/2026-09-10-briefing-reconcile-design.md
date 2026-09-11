# Free Briefing Reconciliation Design

## Goal

Keep the existing Portuguese Gate 1 free-briefing flow, while making the
server's persisted execution value obey one validation contract regardless of
whether it arrives through HTTP or an in-process server caller.

## Design

`apps/server/src/identity-briefing.ts` owns the compatibility fallback, the
8,000-character maximum, and a single-argument normalization function,
`normalizeIdentityBriefing(value: unknown)`. `undefined` is the only input that
returns the legacy briefing. Any other input must be a string, is trimmed, and
must be non-empty and no longer than the limit. The HTTP route uses that
function for its 4xx response and `IdentityRun` uses it before saving an
execution, so the value persisted in `runs.briefing` and later restored into the
curator is always the same normalized string.

Restart restoration canonicalizes as it reads: `IdentityRun.restore()` writes a
briefing back to `runs.briefing` when normalization changed it, and a legacy row
whose stored briefing cannot be normalized — blank, whitespace-only, or over the
limit — ends the execution as `unrecoverable` rather than throwing. Such a run
restores with the explicit `INVALID_IDENTITY_BRIEFING` placeholder and a clear
user-facing message; the compatibility briefing is never shown for it, the raw
row is preserved, and no fallback value is migrated in.

The Studio editor, renderer boundary, snapshot field, and migration remain
unchanged, except that the replacement confirmation now carries its own briefing
editor seeded empty, so a new run is never created from text the captain did not
write. Tests cover the lower server boundary's normalization and rejection,
while the API, migration/restart, curator-propagation, renderer, and Playwright
tests prove the six requested behaviors and the legacy policy.

## Scope

Only briefing validation/normalization and its focused regression tests are
changed. Provider transport, deadlines, failure reconstruction, prototype
behavior, and security controls are out of scope.
