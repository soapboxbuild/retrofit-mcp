# retrofit-mcp

Soapbox Retrofit Specialist — governance MCP worker (playbooks, provenance-enforced measure evaluation, three-test screening, per-asset measure register, shared reference library). Judgment lives in the platform's RETROFIT_SPECIALIST_PROMPT; discipline lives here. Deployed to Railway project soapbox-mcps. Spec + plan: soapbox-agent/docs/superpowers/{specs,plans}/2026-07-02-retrofit-specialist-*.

## Env

| Var | Purpose |
|---|---|
| MCP_SERVER_SECRET | Bearer auth for /mcp — MUST equal soapbox-api's value (proxy forwards it; /internal/index-file checks it) |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY | register storage + files rows, asset-scope validation |
| HINDSIGHT_API_URL | hindsight REST base (https://agent-memory.soapbox.build — NO /mcp suffix) |
| HINDSIGHT_API_KEY | hindsight tenant bearer (bank: retrofit-library) |
| SOAPBOX_API_URL | POST /internal/index-file after register md writes |
| RETROFIT_LIBRARY_ADMIN_KEY | gates add_reference (>=32 chars; vault: "Retrofit Library Admin Key") |
| PORT | default 8080 |

Build `npm run build` → `node dist/src/index.js`. Tests `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`.

Notes: normalizeCandidates is exercised via evaluate_measure's schema rather than exposed as a tool; screen labels are advisory metadata — economics provenance is the hard gate.
