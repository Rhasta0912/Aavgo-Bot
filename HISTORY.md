# Aavgo Bot History

This is the GitHub-side continuity file for the live bot repo.

Primary local ops archive:
- `C:\Users\chugc\Desktop\Aavgo Bot\History.md`

Working rules:
- Keep this history append-only.
- Log meaningful fixes, feature work, deployment changes, and mistakes/fixes.
- Before making changes, read `SOP.md`, this `HISTORY.md`, the desktop `History.md`, and the latest Git updates / `Brief` summary first.
- Treat the live workspace as source of truth for code.
- Treat database permissions as the real authority, with Discord roles mostly used for channel access and presentation.
- Shared shorthand: when the user says `Brief`, check Git for new updates first and summarize:
  - new commits from the other PC / GitHub
  - local-only commits or meaningful working changes on the current PC
  - if there is nothing new on either side, reply with `No updates`
- Current developer workflow:
  - `Alpha` = main developer / this user
  - `Astra` = second developer / second PC
- From this point forward, every meaningful GitHub push should be logged in enough detail that `Alpha` and `Astra` can understand what changed without depending on chat history.

## Current Infrastructure
- Hosted live on SparkedHost / Apollo Panel.
- Startup file: `src/index.js`
- Deploy flow: `git push` then hosted restart, with host-side `git pull` on boot.
- Repo: `https://github.com/Rhasta0912/Aavgo-Bot`

## Recent Milestones
- Hosted the bot successfully and verified the live startup flow on SparkedHost.
- Connected the repo to GitHub and proved restart-based Git deploys work end to end.
- Added and polished the onboarding DM, including yellow Aavgo styling and the onboarding channel reminder.
- Moved onboarding tutorial images into the repo so hosted DMs no longer depend on a local Windows path.
- Hardened registration validation for real email formatting and Philippines phone formatting (`63...` or `09...`).
- Added `/rac-send` to generate and DM one-time recruitment access codes.
- Added 24-hour expiry for recruitment access codes with DB-backed `expires_at`.
- Hardened `/db-remove-user` so it wipes deeper DB identity state and removes every manageable Discord role.
- Fixed duplicate hotel status posting by preserving `hotel_status` rows and reclaiming existing status messages.
- Added automatic DB cleanup when members leave the server.
- Hardened bot lifecycle visibility with a dedicated developer bot-status surface.
- Normalized the DB-first permission hierarchy around:
  - `agent`
  - `sme`
  - `team_leader`
  - `developer`
  - `operations_manager`
- Added centralized role normalization/rank helpers and moved management-gated features to shared DB permission checks.
- Expanded `/add-agent` so developers can assign `operations_manager`.
- Cleaned up the log presentation baseline by structuring audit embeds into clearer fields and refreshing the `dev-bot` status card labels into a more readable operations-health layout.

## Notes
- Desktop `History.md` still contains the long-form archive and older architectural history.
- This repo copy exists so another PC can recover context directly from GitHub even if the desktop archive is unavailable.

## Latest Changes
- Tightened the trainee cleanup flow so `/register`, `/add-agent`, and registration approval now remove the `Trainees` role even when the user is already in DB or already has the base `Agents` role, preventing stale trainee badges after promotion.
- Updated agent promotion flows so when a trainee becomes a real agent through `/register`, `/add-agent`, or registration approval, the bot now removes the `Trainees` role automatically after granting `Agents`/`Logged Out`.
- Fixed `/select-trainee` so it now defers immediately, uses ephemeral flags instead of deprecated `ephemeral` replies, and edits the deferred response after role assignment. This prevents the `Unknown interaction` crash when management marks a trainee.
- Added a pre-change review rule to `SOP.md` and both history files requiring SOP, repo history, desktop history, and the latest Git/`Brief` updates to be read before making changes.
- Updated help docs so `/select-trainee` appears in the developer reference and the management guide.
- Added `/help-agent` so registered agents can open a yellow Aavgo quick-reference for daily commands, shift workflow, and their current DB-backed access state.
- Relocated live in-shift outputs for check-ins, check-outs, call logs, maintenance reports, and handover notes into Discord channel `1484192529485140099`, while keeping handover note delivery to the next overtaking agent through DM.
- Fixed mojibake / broken success lettering in activity replies on Astra so check-in, checkout, handover, and maintenance confirmations render readable text again.
- Fixed duplicate active-agent hotel cards during login/takeover. Root cause was twofold: linked-hotel logins were bypassing the takeover confirmation path, and takeover cleanup was happening after the hotel status embed refresh. The login flow now prompts for takeover even for already linked agents, and conflicting hotel sessions are closed before the new session is inserted and the hotel status card is redrawn.
- Added `/db-set-operation-manager` (Developer-only) to promote agents directly to the DB role `operations_manager`, with Discord role sync for `Operations Manager` when available. Also updated demotion cleanup to remove `Operations Manager` Discord roles and refreshed `/help-dev` role-control docs to include the new command.
- Updated `/db-set-operation-manager` to auto-provision non-registered users as agents instead of rejecting them. When missing, it now creates the DB record with role `operations_manager`, status `ready`, auto-generates a PIN, and syncs baseline Discord roles (`Agents`, `Logged Out`, plus `Operations Manager` if present).
- Upgraded `/rac-send` DM messaging from code-only to a guided onboarding tutorial. The DM now includes clear step-by-step registration instructions (join onboarding channel, open register/apply form, paste RAC, submit real details, wait for approval) plus the one-time/24-hour security reminder.
- Added `/training-mode action:on|off|status` as a global DB-backed safety lock for shift initialization. When ON, standard agent `Initialize Shift` clicks are blocked to prevent accidental live logins during training sessions, while management/developer access and per-agent `db-agent-ready` / `db-agent-standby` controls remain intact.
- Updated hotel naming placeholders across auth views, command choice labels, and DB seed names to the new branding while preserving existing hotel IDs/channels: `BW_TO -> Indianhead IronWood`, `BRNT -> Magnuson`, `QI_RV -> Value Suites`, `SUP8 -> Super8`, `AD1 -> AD1 (EST)`. Existing legacy aliases were kept so old text inputs still normalize correctly.
- Refined `/rac-send` onboarding DM by removing the onboarding-channel line per operations preference. Tutorial still includes clear registration steps and 24-hour one-time RAC safety guidance.
- Updated AD1 (calls-only) activity controls in hotel status cards: AD1 now shows only End Shift, Call Log, and Handover actions (with break-end button when applicable), and blocks check-in/check-out/maintenance modal actions if triggered from stale messages.
- Added `SOP.md` to the repo as the operational standard for Alpha/Astra workflow, DB-first permissions, command-governance requirements, training-mode policy, AD1 calls-only behavior, deployment checklist, and incident handling.
- Added `/select-trainee` for developers and management to assign the `1484705126026449029` Trainees role to a chosen user.
