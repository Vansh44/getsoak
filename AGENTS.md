<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Codebase map — read first, keep updated

@CODEBASE.md

Before making ANY change, consult `CODEBASE.md` (imported above) — it describes the product (StoreMink multi-tenant SaaS), the host-based tenancy architecture, the directory structure, and the project conventions. After any change that adds/removes/moves routes, server actions, lib modules, or SQL files — or changes the architecture — update `CODEBASE.md` in the same commit so it never goes stale.

# Living docs — update in the SAME commit

Three docs are only useful if they are never behind the code. Treat updating
them as part of the change, not as follow-up work:

| Doc                      | Update it when                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEBASE.md`            | routes, actions, lib modules, SQL files or architecture change (rule above)                                                                                                           |
| `docs/roadmap.md`        | a step finishes, splits, is reordered, or a new one appears — it is the single ordered plan for POS/locations/fulfilment                                                              |
| `docs/pos-acceptance.md` | any POS, locations, inventory, fulfilment or pickup behaviour changes — **a phase is not done until its user stories are in here**, and a fixed gap must leave the "Known gaps" table |

A roadmap or test doc that lags the code is worse than none: it gets read once,
found wrong, and then quietly ignored — after which nobody can tell what is
built without reading every file.
