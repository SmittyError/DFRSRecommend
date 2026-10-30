# DFRSRecommend: Project Context

## What this project is
A forked GitHub Pages web tool that recommends emergency-response units. It is built on CAD-derived response plans, unit assignments, out-of-county resources, unit statuses, and Public Safety GIS mapping.

Goals:
1. Improve the existing code and the underlying data.
2. Add a local incident-board simulator for dispatch training and fallback reference.

**This is NOT a CAD replacement.** Do not present it, label it, or build it as if it were a live dispatch system. It is a training and reference aid.

## Hard rules
- **Local-only operation.** No server calls, no external services, no analytics, nothing sent off the user's machine.
- **No timestamps and no logs.** Do not record when anything happens. Do not add logging of incidents, units, addresses, or user actions.
- **No persistence of incident state.** Keep incident and unit-status state in memory only. Do not use localStorage, sessionStorage, IndexedDB, or cookies. A page refresh should clear everything.
- Do not add real personal or caller information. Use fictional or generic data for any examples and tests.
- Keep it deployable as a static GitHub Pages site unless I say otherwise (plain HTML, CSS, JavaScript; no build step unless I approve one).

## Planned simulator workflow
1. Select an incident type and an address.
2. The tool recommends units based on the response plans.
3. Create an incident.
4. Mark the responding units unavailable.
5. When the call clears, restore the units to available.

## Unit status codes
| Code | Meaning |
|------|---------|
| AQ | Available Quarters |
| PA | Pending Available (treated as unavailable) |
| CALL | Unresolved (confirm exact meaning with me before relying on it) |
| OOS | Out of Service |

## How to work with me
- I have a background in 911 dispatch and Linux administration, and I know dispatch operations and GIS well. I am newer to web development, so explain code changes briefly and plainly.
- Make small, reviewable changes, and explain what you changed and why.
- Before big refactors or changes to the response-plan data, tell me the plan and wait for my approval.
- Never overwrite or silently change response-plan or unit data. Show me the diff.
- If you are unsure how a dispatch rule or status code should behave, ask me instead of guessing.

## Notes to fill in
- Main files and what each does: (add after first look at the repo)
- Where the response-plan and unit data live: (add)
- How the GIS map is loaded: (add)