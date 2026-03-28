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
  - `/help-staff` or matching role help command
  - `HISTORY.md` and desktop `History.md`
- When a command changes, update every affected help command in the same change set so help text stays aligned with the live command surface.

## Deployment SOP
1. Implement and verify changes locally.
2. Run syntax checks (`node --check`) for changed files.
3. Commit and push to `main`.
4. Restart hosted server.
5. Confirm host startup log shows `git pull` and bot ready state.
6. Validate affected commands/features in Discord.

## Shift Safety SOP
- Training is controlled through the login flow and the training status board, not by a separate manual toggle.
- Trainees should be routed into Training only and should never appear on the live hotel board.
- Live hotel sessions still keep takeover/conflict protection.
- Multiple trainees may be active at the same time without blocking each other.
- The login flow should keep management/developer paths available while still enforcing PIN-first entry.

## Login Flow SOP
- The first thing the bot checks on any shift/login entry is whether the user has a security PIN set.
- If the PIN is missing, show the PIN setup prompt first and do not route them deeper into the login flow yet.
- For `agent` hotel-shift entry, team must already be assigned manually by a Team Leader or Operations Manager.
- Do not show agent self-team selection during live shift initialization.
- After PIN confirmation, detect the user role automatically from DB/Discord state:
  - `agent` opens the Agent Route
  - `team_leader` / `sme` opens the Management Route
  - `trainee` opens the Training Route
- Training sessions must stay in the training board only.
- Training must not assign the live `On-Shift` role or any hotel permission / ghost roles.
- Keep every login card UI-friendly and beginner-friendly:
  - use plain language
  - avoid Discord jargon
  - use labels like `Live -> Hotel Shift` and `Practice -> Training`
  - keep the route cards short, scannable, and clearly separated
  - each temporary login step should replace the previous temporary step when possible (avoid stacked ephemeral flow cards)

## AD1 Calls-Only SOP
- AD1 is calls-only operations.
- Allowed in AD1 live activity UI:
  - `Call Log`
  - `Handover`
  - `End Shift`
- AD1 should not run check-in/check-out/maintenance workflows.

## Recruitment SOP
- Self-registration is disabled.
- Do not use recruitment/register kiosk flow for onboarding.
- New onboarding path:
  - Operations Manager or Developer runs `/add-agent`.
  - Agents set PIN + phone through the built-in secure prompt when they initialize shift (no separate security kiosk command).
  - Agents can also use `/reset-pin` for direct PIN changes after onboarding.

## Hotel Naming SOP
- Keep IDs stable for logic and database joins.
- Update only display placeholders/labels when branding changes.
- Current display set:
  - `BW_TO`: Indianhead/Magnuson
  - `GICP`: The Garden Inn At Campsite
  - `RMDA` / `SUP8`: Ramada / Super 8
  - `AD1`: AD1
- Ramada and Super 8 share the same live login/status channel: `1483417977859870881`
- Team Leader status board lives in `1486347360417349682`
- Training status board lives in `1486623221225750660`

## Logging SOP
- Every meaningful feature/fix must be appended to:
  - `HISTORY.md` (repo)
  - `C:\Users\chugc\Desktop\Aavgo Bot\History.md` (desktop archive)
- Include:
  - what changed
  - why it changed
  - behavior impact

## Update Log SOP
- Every meaningful GitHub push must also be summarized in plain English in the Discord update log channel:
  - `1485584578927132863`
- Use the same wording across:
  - the Discord update log channel
  - `HISTORY.md`
  - `C:\Users\chugc\Desktop\Aavgo Bot\History.md`
- Keep the note short and readable for the other developer:
  - what was updated
  - why it was updated
  - any risk or follow-up they should know
- Recommended command for future updates:
  - `npm run log:update -- --title "Short title" --summary "Plain English summary" --files "file1,file2"`

## Interaction Reliability SOP
- For button/select menu handlers that read DB data or fetch guild members:
  - acknowledge fast with `deferUpdate()` before heavy work
  - finish with `editReply()` or `followUp()` after processing
- This prevents Discord `10062 Unknown interaction` expiry on slower operations.

## PIN Privacy SOP
- Never expose raw PIN values in:
  - DMs
  - slash command replies
  - channel messages
  - logs/history/update notes
- Admin/developer flows may set/reset PINs, but user-facing responses must not display the PIN string.

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
