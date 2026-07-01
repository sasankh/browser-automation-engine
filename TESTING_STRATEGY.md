# Testing Strategy

> Expands `PROJECT_SPEC.md` §15. Defines the test architecture, the fixture harness, how the LLM provider API is handled deterministically, and the two permanent release-blocking tests.

## 1. Pyramid for this system

```
        /  chaos / load  \      few — kill browser, storage loss, burst backpressure
       /   integration     \    some — full run against the offline fixture site
      /      unit            \   many — resolver, validator, interpreter, compiler, provenance
```

Most confidence comes from the **integration** layer here, because the system's value is end-to-end behavior (learn → compile → replay → heal) against a real browser. Unit tests guard the pure logic; integration tests guard the contract and the mechanism.

## 2. The offline guarantee

Integration tests run against a **bundled express fixture site** (`test/fixtures/site`), fully offline. The only thing that may reach the network is the configured LLM provider's API, and only in agent-mode tests (a local provider like Ollama reaches nothing external). Everything else — target site, storage, queue — is local. CI must be able to run the whole non-agent suite with no external dependencies.

### Faking the LLM provider API deterministically

Agent-mode tests can't depend on live, non-deterministic model output for assertions. Two-tier approach:

- **Recorded-interaction tests (default in CI):** capture a real Stagehand/agent session once against the fixture, record the action stream, and replay it so the compiler/provenance/heal logic is tested deterministically without live calls. Assert on the *compiled playbook* and the *replay*, which are deterministic.
- **Live smoke tests (opt-in, not in the blocking CI gate):** a small number of real agent runs against the fixture, run on demand, to catch Stagehand/API drift. Tagged so they don't block PRs.

This keeps the two thesis tests (below) deterministic while still catching real-world drift on a cadence.

## 3. Layer-by-layer

**Unit**
- `ConfigResolver` — all three precedence levels; env-only keys reject payload overrides.
- Payload validator (Zod) — accept/reject matrix incl. the resolution precondition.
- Envelope builder — `result` is only ever caller-shape-or-null; `meta` completeness.
- Step interpreter — each op against a fixture DOM; primary→fallback→`step_failed`.
- Structural extractor — per-field success/miss.
- **Provenance/compiler** — value-identity templating; the coincidental value-equals-page-text case must NOT mis-template.
- Heal classifier — every §7 error code maps to the correct policy (table-driven test).
- Playbook JSON Schema validation — malformed bodies rejected.

**Integration (offline fixture)**
- Replay happy path / action-only / partial-extraction.
- `422` before browser on missing required keys.
- Versioning: create → activate → rollback → pinned-version replay.
- Agent learn → compile → **replay with different data** (the round-trip).
- Mutate fixture (renamed selector) → runner fails → heal → v2 replays.
- LLM fallback surfacing (on and off).
- Webhook delivery + retry (unsigned — signing descoped, DECISIONS #32).
- SQS path identical to HTTP path; redelivery idempotency; DLQ.
- Storage backend swap (local ↔ S3) — same suite passes.

**Chaos / load**
- Kill browser mid-run → clean failure + slot reclaimed.
- Storage unavailable → graceful degradation.
- SQS visibility expiry → safe redelivery.
- Sustained burst → `429` backpressure, stable memory.

## 4. The two release-blocking tests

Once their phase lands, these must pass and stay green in **every** later phase. A regression blocks release regardless of active phase.

1. **Phase 3 — isolation cross-contamination.** N concurrent runs each set a distinct cookie/localStorage value on the fixture and read it back; every run sees only its own value, across high repetition. The single most important test in the project. Must run in the blocking CI gate at meaningful repetition (not N=2).

2. **Phase 4 — learn→replay round-trip.** A freshly compiled playbook replays with *different* `data` and **no LLM**, producing the correct result. This is the two-speed thesis; if it regresses, the economic model is broken.

## 5. Coverage posture

Cover: the contract surface, the mechanism (provenance/compile/replay/heal), concurrency isolation, error handling, security boundaries (SSRF, redaction), data integrity (idempotency, transactional pointer). Skip: framework glue, trivial accessors, one-off scripts. Don't chase a coverage percentage — chase the behaviors above.

## 6. Discipline (from EXECUTION_STANDARDS §5)

- `tsc --noEmit` clean before every commit.
- Each phase's gate re-runs key scenarios **cold** (fresh `docker compose down && up`), not against a warm dev server.
- Never assert a concurrency property from a single-request run — fire a burst.
- A verify-item's "done means" is an observed outcome, not a passing assertion alone.
