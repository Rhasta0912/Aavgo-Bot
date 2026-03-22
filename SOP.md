# Aavgo Bot SOP

## Purpose
This SOP defines the standard way to operate, change, and deploy Aavgo Bot with minimal downtime and clear accountability.

## Source of Truth
- Live code repo: `https://github.com/Rhasta0912/Aavgo-Bot`
- Runtime host: Apollo Panel / SparkedHost
- Local workspace: `C:\Users\chugc\.gemini\antigravity\playground\distant-solstice`
- Long-form ops memory: `C:\Users\chugc\Desktop\Aavgo Bot\History.md`
- Repo memory mirror: `HISTORY.md`

## Pre-Change Review
- This is mandatory for every bug fix, new feature, and update before touching code.
- Before making any code, documentation, or deployment changes, read:
  - this `SOP.md`
  - repo `HISTORY.md`
  - desktop `History.md`
  - the latest Git updates / `Brief` summary
- Do not edit until the current repo state and recent updates are confirmed.

## Team Workflow
- `Alpha`: main developer
- `Astra`: second developer
- `Brief` protocol:
  - Check Git for new updates first.
  - Re-read SOP and both history files before making changes.
  - Summarize new commits on `origin/main`.
  - Summarize local-only changes if any.
  - If none, respond `No updates`.

## Permission Model (DB-First)
- Do not use Discord role visibility as authority for sensitive actions.
- Authority is determined by database role/status:
  - `agent`
  - `sme`
  - `team_leader`
  - `operations_manager`
  - `developer` (developers table)
- Agent readiness status is separate:
  - `standby`
  - `ready`

## Command Governance
- New command additions must be reflected in:
  - slash command registration (`src/commands.js`)
  - command routing (`src/index.js`)
  - command handler + permission checks (`src/auth.js` or `src/tools.js`)
  - `/help-dev` or matching role help command
  - `HISTORY.md` and desktop `History.md`

## Deployment SOP
1. Implement and verify changes locally.
2. Run syntax checks (`node --check`) for changed files.
3. Commit and push to `main`.
4. Restart hosted server.
5. Confirm host startup log shows `git pull` and bot ready state.
6. Validate affected commands/features in Discord.

## Shift Safety SOP
- Use `/training-mode action:on` during training blocks.
- With training mode ON:
  - regular agents are blocked from Initialize Shift
  - management/developer pathways remain available
- Use `/training-mode action:off` before live shift windows.
- Per-agent readiness remains controlled by:
  - `/db-agent-ready`
  - `/db-agent-standby`

## AD1 Calls-Only SOP
- AD1 is calls-only operations.
- Allowed in AD1 live activity UI:
  - `Call Log`
  - `Handover`
  - `End Shift`
- AD1 should not run check-in/check-out/maintenance workflows.

## Recruitment SOP
- `/rac-send` issues one-time RAC (24h expiry) by DM.
- DM must include:
  - RAC code
  - registration tutorial steps
  - one-time/expiry warning
- Do not share RAC publicly.

## Hotel Naming SOP
- Keep IDs stable for logic and database joins.
- Update only display placeholders/labels when branding changes.
- Current display set:
  - `BW_TO`: Indianhead IronWood
  - `BRNT`: Magnuson
  - `QI_RV`: Value Suites
  - `SUP8`: Super8
  - `RMDA`: Ramada
  - `AD1`: AD1 (EST)

## Logging SOP
- Every meaningful feature/fix must be appended to:
  - `HISTORY.md` (repo)
  - `C:\Users\chugc\Desktop\Aavgo Bot\History.md` (desktop archive)
- Include:
  - what changed
  - why it changed
  - behavior impact

## Incident SOP
1. Capture error/log evidence.
2. Reproduce issue.
3. Patch with minimal blast radius.
4. Verify with live-safe checks.
5. Deploy and confirm.
6. Log root cause + fix in both history files.

## Change Freeze Guidance (Launch Week)
- Prioritize reliability and workflow clarity over large refactors.
- Avoid broad architecture changes unless they fix production blockers.
- Favor reversible, auditable updates.
