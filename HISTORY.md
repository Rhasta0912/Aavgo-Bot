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
- Fix profiles interaction timeout + UI consistency
  - Summary: Fixed profiles panel interaction expiry by acknowledging component interactions before heavy DB/member fetch work, then responding through safe edit/follow-up paths. Also refreshed profiles embeds to match kiosk/approval styling and added SOP rules for interaction reliability and no PIN exposure.
  - Files touched:
    - src/profilePanel.js
    - SOP.md
  - Notes:
    - Prevents DiscordAPIError 10062 in team/profile selection flows
    - No raw PIN should appear in DM/reply/log surfaces
- Polish profiles panel UI and harden PIN privacy
  - Summary: Redesigned the profiles dashboard/profile cards to match the kiosk and approval style, fixed team member discovery to use effective team fallback (team/hotel/paired hotels), added in-panel team reload/switch navigation, expanded misc actions, removed set-ready/set-standby/reset-pin from the panel, and removed PIN exposure text from promotion/admin responses.
  - Files touched:
    - src/profilePanel.js
    - src/auth.js
  - Notes:
    - None
- Add profiles dashboard workflow
  - Summary: Implemented a profiles panel in channel 1485256962617643098 with team pick, member profile cards, misc developer actions, and promote/demote/kick/ban controls (kick/ban require confirmation). Added /setup-profiles and startup auto-restore for the panel.
  - Files touched:
    - src/profilePanel.js
    - src/index.js
    - src/commands.js
    - src/auth.js
  - Notes:
    - None
- Polish update log presentation
  - Summary: Changed the update-log helper so Discord posts use a cleaner embed card with a title, summary, file list, notes, and footer instead of plain text.
  - Files touched:
    - scripts/log-update.js
  - Notes:
    - None
- Restore missing developer routes
  - Summary: Added routing for /db-add-developer and /db-set-phone in the interaction router, and updated the staff help text so the documented command surface matches the handlers.
  - Files touched:
    - src/index.js
    - src/auth.js
  - Notes:
    - None
- Added a shared update-log workflow so Alpha and Astra can see plain-English change notes even when one person is offline. The new `npm run log:update -- --title ... --summary ... --files ...` helper appends the same note to `HISTORY.md`, the desktop `History.md`, and Discord update log channel `1485584578927132863`.
- Fixed standby setup regression: hotel dropdown (`handleHotelSelectMenu`) no longer blocks standby-linked users with “Hotel Already Linked.” Standby agents can now re-pick hotel during setup as intended.
- Updated standby wording from “Standby Training” to **Standby Agent**.
- Updated standby flow behavior so agents in standby can still use setup selection (team/hotel picking) while live hotel login remains blocked until `/db-agent-ready`.
- Relaxed lock-in guard for standby state so assignment setup can be changed before ready clearance.
- Adjusted standby behavior to match operations flow:
  - Standby users can still open **Initialize Shift** and complete setup screens.
  - Live hotel login is blocked only at final login stage (not at initial portal click).
  - Updated standby message copy to clarify it is a **live shift lock**, not a full access lock.
- Added `/assign-hotel` as a clean alias to hotel assignment flow (routes to the same assign handler as `/db-assign-hotel`) for faster operations usage.
- Updated Initialize Shift user-facing placeholder and invalid-hotel validation text to use the new hotel names (no legacy code-style placeholder hints shown to agents).
- Updated `/help-dev` copy to document both `/db-assign-hotel` and `/assign-hotel`.
- Added a hardened override for `/db-remove-user` to eliminate timeout/no-response behavior:
  - immediate ack path (`deferReply`) before heavy DB/role purge
  - consistent `editReply` completion and robust fallback error response handling
  - designed to prevent repeated “The application did not respond” on long purge operations
- Reintroduced standby readiness controls for launch/training flow:
  - Added `/db-agent-ready` and `/db-agent-standby` back to slash commands and routing.
  - Restored DB-backed status handlers (`agent_status`) with audit logging.
  - Restored shift-entry gate so standby agents cannot start live shifts.
  - Kept assignment capture behavior: standby agents can still save team/hotel via init flow, then get prompted to be marked ready.
- Hardened interaction reliability to reduce “The application did not respond” failures:
  - Added a global try/catch fallback in `interactionCreate` so unexpected handler crashes now return a user-visible error response instead of timing out silently.
  - Patched `/db-add-developer` catch path to always send a fallback reply/editReply when request creation fails.
- Elevated `operations_manager` to full developer-equivalent authority by updating the shared `isDeveloper()` gate. Result: all dev-gated commands now allow Operations Manager automatically (including DB/admin surfaces and RAC generation flows).
- Fixed `/add-agent` `InteractionAlreadyReplied` crash path by hardening response flow to deferred-mode semantics (`deferReply` + `editReply`) in all success/deny/error branches.
- Temporarily disabled WhatsApp bridge sends across live bot flows by replacing direct WhatsApp module imports in `src/auth.js` and `src/tools.js` with a no-op async bridge. Result: operational commands still complete normally in Discord, but no WhatsApp messages are sent.
- Fixed `/db-remove-user` interaction timeout crash (`DiscordAPIError 10062: Unknown interaction`) by acknowledging early with `deferReply({ ephemeral: true })`, then completing with `editReply`, plus safe fallback reply logic inside catch. This prevents 3-second interaction expiry during heavy DB+role purge work.
- Redesigned shift activity log embeds (`check-in`, `check-out`, `call`, `maintenance`, `handover`) into a cleaner dashboard card style with:
  - stronger visual headers per activity type
  - consistent summary chips (Agent, Hotel, Guest/Ref)
  - cleaner detail section formatting
  - improved footer labeling for the activity feed channel
- Wired the new activity card template through maintenance/handover/general logging so all operational activity entries use the same polished layout.
- Removed training lock controls from the live command surface and shift flow. `/training-mode`, `/db-agent-ready`, and `/db-agent-standby` were removed from slash-command registration, interaction routing, and developer help docs, and the remaining standby/training gate checks were stripped from `Initialize Shift` handling.
- Updated Team 1 hotel mapping to the new live set and IDs across auth + command surfaces:
  - `BW_TO` Indianhead IronWood
  - `BRNT` Magnuson
  - `VALS` Value Suites
  - `GICP` The Garden Inn At Campsite
  - `QI_RV` Russelville
  - `SUP8` Super8
  - `RMDA` Ramada
  - `AD1` AD1
- Synced new channel bindings for initialize/login routing (`HOTEL_LOGIN_CHANNELS`) and role map IDs for both permission (green) and assignment/ghost (grey) roles, including new `VALS` and `GICP` entries.
- Polished Initialize Shift copy and kiosk/service-location text so agents see the updated hotel set in prompts/placeholders.
- Fixed `/db-assign-hotel` role sync to compare by role **IDs** (not names), preventing mismatched cleanup/add behavior when assigning a new permanent hotel.
- Updated DB seeds to include `VALS` and `GICP` as live hotels plus `hotel_status` seed rows, and updated legacy `QI_RV` display name to Russelville for continuity.
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
- Moved the Team Leader login/status log channel from `1482516531505266770` to `1484878480046031099` so TL-related login portal activity now routes to `tl-logs`.
- Moved management `TEAM_SHIFT` audit cards for login and shift analytics out of the general audit channel and into `tl-logs`, so the image-style login cards shown for Team Leaders/management now land in the dedicated TL log channel.
- Removed the standby-agent gate from the live shift flow so freshly registered agents now behave as normal agents right away, and `/db-agent-ready` / `/db-agent-standby` were removed from the bot surface.
- Added automatic `Applicants` role assignment on server join, and added promotion sync so `Applicants` is removed whenever a user gains `Trainees` or `Agents` through either the command flow or a direct Discord role update.
- Added `/assign-team` for developers and management so they can reassign an agent between Team 1 and Team 2, and the bot now removes the old team role when the new one is applied.
- Added a newcomer announcement embed in the newcomers channel so each join/rejoin shows the member profile card, avatar, username, and join details, plus manager/developer buttons to promote the member to `Trainees` or `Agents`.
- Updated the newcomer announcement to ping Operations Manager instead of the joiner, and made the newcomer agent button open a PIN modal that creates the agent record, DMs the PIN plus congratulations, and clears the announcement buttons after submission. `/add-agent` now DM’s the PIN too.
- Fixed the newcomer agent PIN modal submit flow so it uses deferred interaction replies correctly and no longer trips the generic "Command failed while processing" error after the PIN is entered.
- Simplified the newcomer Agent promotion path so it reuses the same add-agent logic instead of carrying a separate promotion rule set.
- Hardened the shared agent promotion helper so role sync and PIN DM failures are non-blocking, preventing the newcomer add-agent flow from aborting with the generic processing error when Discord refuses a role change or DM.
- Fixed newcomer PIN modal crash: `handleNewcomerAgentPinSubmit` was implemented but missing from `module.exports`, causing `TypeError: auth.handleNewcomerAgentPinSubmit is not a function` in interaction routing. The handler is now exported so `newcomer_agent_pin_modal:*` submits process correctly.
- Removed `/assign-hotel` alias from command registration, routing, and developer help text. `/db-assign-hotel` is now the single supported hotel-assignment command.
- Strengthened SOP wording: before any bug fix, new feature, or update, read `SOP.md`, repo `HISTORY.md`, desktop `History.md`, and latest Git/Brief context before editing code.
- Merged the Magnuson (`BRNT`) login-channel routing into Indianhead IronWood (`BW_TO`) by pointing both hotel IDs at `1482303551614095441`, so the old Magnuson channel can be removed without breaking login post routing.
- Fixed `/add-agent` agent-role assignment to resolve the `Agents` role by the exact Discord role ID `1482227287159078964` first, so the command reliably restores the role again even if role-name lookup is inconsistent.
- Collapsed the Magnuson merge into Indianhead/Magnuson by renaming BW_TO display text to `Indianhead/Magnuson`, removing Magnuson from visible hotel choices/channel routing, and adding a DB migration that folds old `BRNT` hotel records into `BW_TO`.
- Added a multi-hotel confirmation step in shift start flow: if an agent already has an active session, the bot now prompts **“Are you handling multiple hotels?”** with continue/cancel buttons before allowing another shift login.
- Added `/db-assign-hotel` optional `sync` mode (`permission`, `ghost`, `both`) so management can choose which role family gets synced during assignment.
- Updated add-agent promotion messaging to stop displaying PIN values in `/add-agent` DM notices and success confirmations.
- Removed self-registration command surface from slash commands (`/register`, `/setup-register`).
- Added `/reset-pin` for agent self-service security PIN rotation (current PIN + new PIN + confirm PIN).
- Added `/setup-security` as a management-posted security kiosk (embed + button + modal) where registered agents can submit PIN + phone updates.
- Updated interaction routing so legacy register modal/button paths now return a clear "registration disabled" response instead of continuing old onboarding flow.
- Updated SOP onboarding policy: Operations Manager/Developer-only onboarding via `/add-agent`, then agent-side PIN rotation via `/reset-pin`.
- Restyled `/setup-security` output into kiosk-style embed UI (matching the `/setup-login` visual language) with protocol steps, validation rules, and a cleaner security action button.


- Updated newcomer **Promote to Agent** flow to skip PIN modal and assign only Agents (1482227287159078964) + Unverified (1485275671797436620). The button now removes applicant/trainee/logged-out roles, promotes directly, and DMs a 3-step setup tutorial for #register-set-pin (1482255690054762646) so the user creates their own PIN in Security Setup.

- Reworked join/rejoin onboarding DM tutorial to use the 3-step nickname guide images in ordered embeds (Step 1, Step 2, Step 3) inside one DM message, so instructions stay visual while avoiding loose attachment spam in applicant DMs.

- Updated security setup submission so when an agent saves a new PIN, the bot now removes the Unverified role (1485275671797436620) automatically after the PIN/phone update succeeds.

- Removed the public PIN field from /add-agent so management only passes the user now. The command generates its own internal temporary PIN, grants Agents plus Unverified for normal agent promotions, and keeps the new self-service PIN setup rule consistent.

- Updated /add-agent agent promotions so they DM the same security-setup embed used by the newcomer Agent button: welcome message plus the 1-2-3 
egister-set-pin tutorial, instead of a separate PIN-centric prompt.

- Fixed a server startup crash caused by a malformed duplicate 
eturn member; block left behind in pplyAgentPromotion. The extra lines made src/auth.js invalid JavaScript and prevented the bot from booting until the duplicate was removed.

- Removed /generate-rac and /rac-send from the live command surface and routing, and deleted the unused RAC handler code. Recruitment access is now intended to stay manual through the new agent promotion and security setup flow.

- Renamed /help-dev to /help-staff, removed the old RAC references from the staff guide, and kept the staff help surface available to both Developers and Operations Manager. Added a workflow rule to keep help commands updated whenever command surfaces change.

- Renamed /help-dev to /help-staff, removed RAC references from the live staff guide, and kept the staff help surface available to both Developers and Operations Manager. Added the rule that when a command changes, the affected help commands must be updated in the same change set.

- Added /add-hotel-shifts so management can store two approved hotel shift options for one agent without touching permanent hotel linkage. The command uses a new DB-backed paired-shift table, and the staff help guide now documents it alongside the schedule tools.

- Renamed /add-hotel-shifts to /set-hotel-shifts across slash registration, routing, and staff help so the command appears under the final name in Discord command options.
- Updated /set-hotel-shifts so it now also syncs hotel assignment roles for both selected hotels, removing old hotel roles not in the selected pair and adding the new pair roles automatically.
- Updated /set-hotel-shifts role sync rule to grey-only hotel roles: it now assigns only the selected offline/ghost roles and removes green hotel roles from that command sync path.
- Fixed /db-remove-user FOREIGN KEY purge failure by deleting hotel_shift_assignments rows before deleting the agent record, matching the new paired-hotel assignment table dependencies.
- Added multi-assigned hotel login picker: when an agent has multiple grey hotel roles, Initialize Shift now prompts them to choose which assigned hotel to handle for this shift before PIN verification.
- Fixed multi-hotel shift picker interaction failure: PIN modal handler now accepts select-menu interactions (not only buttons), so choosing a hotel from the picker opens PIN verification correctly.
- Added automatic deployment update logs to channel 1485584578927132863: on bot startup, if the deployed commit changed, the bot posts commit summary lines (feature/fix/remove updates) and stores the last posted commit in config to avoid duplicate posts.

## Latest Changes
- Added a training path to `/setup-login` with a new Training button, tracked training sessions separately in the database, and posted a dedicated training status board in channel `1486623221225750660` so management can see which hotel each agent is training for.
  - Files touched:
    - src/auth.js
    - src/commands.js
    - src/database.js
    - src/index.js
  - Notes:
    - Training sessions are now stored separately from normal shifts
    - Training status groups Ramada and Super 8 together
- Added a dedicated Team Leader login status board in channel `1486347360417349682` that shows Team 1 hotel coverage and a Team 2 placeholder section, so it is easier to tell who is logged in or offline.
  - Files touched:
    - src/auth.js
    - SOP.md
  - Notes:
    - Team 1 now lists its hotels directly on the board
    - Team 2 is intentionally kept as a future placeholder
- Removed the dormant WhatsApp bridge from the live bot codebase by deleting `src/whatsapp.js`, removing all bridge calls from `auth.js` and `tools.js`, and clearing the empty `messageCreate` placeholder in `index.js`.
  - Files touched:
    - src/auth.js
    - src/index.js
    - src/tools.js
    - src/whatsapp.js
  - Notes:
    - Live bot now runs Discord-only
    - No WhatsApp bridge calls remain in the active source path
- Removed retired `Value Suites` and `Russelville` hotel placeholders from the live hotel map, unified `Ramada` and `Super 8` to the shared login channel `1483417977859870881`, and updated the hotel seeds/migration so old hotel references are redirected into `Indianhead/Magnuson` instead of lingering in the active roster.
  - Files touched:
    - src/auth.js
    - src/commands.js
    - src/database.js
    - src/whatsapp.js
    - SOP.md
  - Notes:
    - Live hotel selections now only show current hotels
    - Ramada and Super 8 now share the combined channel
    - Legacy WhatsApp bridge references no longer mention Russellville
- Simplify profiles panel layout
  - Summary: Reduced clutter in the profiles panel by keeping the team browser separate from the profile card, shrinking roster previews, and moving advanced actions like kick, ban, and admin utilities behind a single More menu. The profile view now shows only the core actions plus a Back to Team button, making the workflow easier to read and easier to revert as one change set if needed.
  - Files touched:
    - src/profilePanel.js
    - HISTORY.md
  - Notes:
    - Profile card is now less crowded
    - More actions are hidden behind a single menu
    - Back to Team returns to the roster view
- Harden interaction reliability and bot-status retries
  - Summary: Removed PIN data from registration approval component IDs, hardened hotel-link confirmations with early component acknowledgement and safe update replies, suppressed noisy 10062 fallback replies in the global interaction handler, and made bot-status upserts resilient with retry/backoff plus cached message patching for transient Discord 503 failures.
  - Files touched:
    - src/auth.js
    - src/index.js
    - src/botStatus.js
  - Notes:
    - Fixes Unknown interaction spikes in confirm_hotel flow
    - Reduces bot-status 503 spam and retries transient network errors
