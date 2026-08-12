**`search_reference_library`/`add_reference` were removed as of 2026-08-12** — use
`knowledge-mcp`'s copies instead. This server's own copies were an unhardened
duplicate of the same underlying Hindsight bank. `src/library.ts` is left in
place but unregistered (rollback safety net); it is no longer reachable from
`src/index.ts`.

> # FROZEN — do not extend
>
> **Status: still the only implementation. Do not build new dependencies on it.**
>
> This is deliberately *not* marked DNU: nothing has replaced it yet, and the
> playbooks, the provenance rule in `evaluate_measure` ("every economic field
> requires engine or cited source provenance — LLM-computed numbers are
> rejected") and the three screening tests are the best prior art Soapbox has for
> measure evaluation.
>
> It cannot move to `soapbox-tools` as it stands. `src/index.ts` opens a Supabase
> client and `src/register.ts` persists an asset-scoped measure register;
> `src/hindsight.ts` retains and recalls the reference library from an external
> memory bank. `agent-tooling/CLAUDE.md` requires every MCP server to be
> stateless and compute-only, with no datastores and no customer-data
> persistence. Porting this whole would break that charter immediately.
>
> **The replacement splits it in two, along the line the architecture already
> draws:**
>
> | Moving to `measure-mcp` (stateless compute, `soapbox-tools`) | Moving to app CRUD (state) |
> |---|---|
> | `get_retrofit_playbook` + the six playbooks (hvac, envelope, dhw, controls-rcx, electrification-staging, baseline-discipline) | `get_measure_state`, `update_measure_state`, `delete_measure` → a `measure_instance` table |
> | `propose_candidates` (`candidates.ts`) | ~~`add_reference` → admin write to a shared library~~ **already removed as of 2026-08-12, not pending** — superseded by `knowledge-mcp`'s copy; nothing to port |
> | `evaluate_measure`'s validation + exit math (`evaluation.ts`) | ~~`search_reference_library` → the hindsight bank is a datastore~~ **already removed as of 2026-08-12, not pending** — superseded by `knowledge-mcp`'s copy; nothing to port |
> | `screen_measures` and the three tests (`screening.ts`) | the persistence half of `evaluate_measure` |
>
> Note for whoever does the port: `add_reference`/`search_reference_library` (right-hand column, above) are already gone as of 2026-08-12 — see the removal note at the top of this file — so there's nothing left to port for them. Also, the playbooks are doctrine and feasibility
> checks, not savings calculators. There is no deemed-savings arithmetic anywhere
> in this repo, so the savings-method tier (TRM-cited deemed savings for lighting
> and VFDs, bin method for heat pumps and fuel switching) is new code regardless.
>
> Until `measure-mcp` ships and the register lands in app CRUD, this keeps
> running. Add nothing to it.

---

## Historical README

Kept for provenance. Everything below describes the deprecated implementation.

# retrofit-mcp

Soapbox Retrofit Specialist — governance MCP worker (playbooks, provenance-enforced measure evaluation, three-test screening, per-asset measure register, shared reference library). Judgment lives in the platform's RETROFIT_SPECIALIST_PROMPT; discipline lives here. Deployed to Railway project soapbox-mcps. Spec + plan: soapbox-agent/docs/superpowers/{specs,plans}/2026-07-02-retrofit-specialist-*.

## Env

| Var | Purpose |
|---|---|
| MCP_SERVER_SECRET | Bearer auth for /mcp — MUST equal soapbox-api's value (proxy forwards it; /internal/index-file checks it) |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY | register storage + files rows, asset-scope validation |
| HINDSIGHT_API_URL | no longer read by the running server as of 2026-08-12 — was only reachable via `search_reference_library`/`add_reference` in `src/library.ts`, which is now unregistered (see note at top of this file) |
| HINDSIGHT_API_KEY | no longer read by the running server as of 2026-08-12 — same reason as HINDSIGHT_API_URL above |
| SOAPBOX_API_URL | POST /internal/index-file after register md writes |
| RETROFIT_LIBRARY_ADMIN_KEY | no longer read by the running server as of 2026-08-12 — gated `add_reference` in `src/library.ts`, which is now unregistered (see note at top of this file) |
| PORT | default 8080 |

Build `npm run build` → `node dist/src/index.js`. Tests `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`.

Notes: normalizeCandidates is exercised via evaluate_measure's schema rather than exposed as a tool; screen labels are advisory metadata — economics provenance is the hard gate.
