# 2026-03-04 Modernization Checklist

Goal: finish the 12-item modernization/refactor sweep for `notify-url-proxy` and keep each change independently verifiable with tests and CI checks.

Context:
- Branch: `chore/modernize-node24-ts-esm`
- Node runtime target: `>=24`
- Existing known gap: `http-proxy` still present and causing `util._extend` deprecation warnings.
- Existing real API e2e exists and must remain opt-in and secret-gated.

Checklist:
- [x] 1. Replace `http-proxy` with native `fetch`-based forwarding.
- [x] 2. Exclude real e2e from default `yarn test`.
- [x] 3. Add polling dedupe + max in-flight concurrency guard.
- [x] 4. Add cancellation plumbing for pollers (`AbortController`, cancel on `close()`).
- [x] 5. Switch retry behavior to exponential backoff + jitter.
- [x] 6. Add `notifyOnTerminalError` option and behavior.
- [x] 7. Harden CLI config validation for `notifyUrl` and `target`.
- [x] 8. Keep structured logging hooks/injection (`@transloadit/sev-logger`).
- [x] 9. Add GitHub Actions workflow concurrency cancellation.
- [x] 10. Add CI changeset policy check (changeset or explicit bypass label).
- [x] 11. Add regression tests:
  - [x] duplicate assembly URL dedupe behavior
  - [x] poll cancellation on `close()`
  - [x] terminal error behavior path
- [x] 12. Add publish hardening (`publishConfig` intent/registry/provenance).

Verification plan:
1. `yarn format`
2. `yarn check`
3. `yarn test:real` (when env/secrets are present)
4. push branch, confirm GitHub Actions run status

## Phase 2 (Requested Follow-up)

Scope requested:
- [x] 2. Stream upstream responses instead of buffering them fully.
- [x] 3. Add per-request timeout policy with distinct forward/poll/notify error codes.
- [x] 7. Add lightweight metrics hooks (counters/timers/gauges) for integration.
- [x] 9. Add proxy/network behavior tests:
  - [x] large body response
  - [x] redirect passthrough
  - [x] multiple `set-cookie` passthrough
  - [x] upstream timeout/failure path
- [x] 10. Add chaos retry tests for flaky polling + flaky notify.
- [x] Build reactive `--ui` mode with live logs + metrics graphs (TUI).
