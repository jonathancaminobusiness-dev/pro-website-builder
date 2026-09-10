# Free Briefing Reconciliation Design

## Goal

Keep the existing Portuguese Gate 1 free-briefing flow, while making the
server's persisted execution value obey one validation contract regardless of
whether it arrives through HTTP or an in-process server caller.

## Design

`apps/server/src/identity-briefing.ts` owns the compatibility fallback, the
8,000-character maximum, and a single normalization function. Omitted input is
the only path that returns the legacy briefing. Supplied input must be a string,
is trimmed, and must be non-empty and no longer than the limit. The HTTP route
uses that function for its 4xx response and `IdentityRun` uses it before saving
an execution, so the value persisted in `runs.briefing` and later restored into
the curator is always the same normalized string.

The existing Studio editor, renderer boundary, snapshot field, migration, and
restart behavior remain unchanged. Tests cover the lower server boundary's
normalization and rejection, while the existing API, migration/restart,
curator-propagation, renderer, and Playwright tests continue to prove the six
requested behaviors.

## Scope

Only briefing validation/normalization and its focused regression tests are
changed. Provider transport, deadlines, failure reconstruction, prototype
behavior, and security controls are out of scope.
