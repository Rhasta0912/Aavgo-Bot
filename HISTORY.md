# Aavgo Bot History

This is the GitHub-side continuity file for the live bot repo.

Primary local ops archive:
- `C:\Users\chugc\Desktop\Aavgo Bot\History.md`

Working rules:
- Keep this history append-only.
- Log meaningful fixes, feature work, deployment changes, and mistakes/fixes.
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
- Added `/help-agent` so registered agents can open a yellow Aavgo quick-reference for daily commands, shift workflow, and their current DB-backed access state.
- Relocated live in-shift outputs for check-ins, check-outs, call logs, maintenance reports, and handover notes into Discord channel `1484192529485140099`, while keeping handover note delivery to the next overtaking agent through DM.
- Fixed mojibake / broken success lettering in activity replies on Astra so check-in, checkout, handover, and maintenance confirmations render readable text again.
- Fixed duplicate active-agent hotel cards during login/takeover. Root cause was twofold: linked-hotel logins were bypassing the takeover confirmation path, and takeover cleanup was happening after the hotel status embed refresh. The login flow now prompts for takeover even for already linked agents, and conflicting hotel sessions are closed before the new session is inserted and the hotel status card is redrawn.
- Added `/db-set-operation-manager` (Developer-only) to promote agents directly to the DB role `operations_manager`, with Discord role sync for `Operations Manager` when available. Also updated demotion cleanup to remove `Operations Manager` Discord roles and refreshed `/help-dev` role-control docs to include the new command.
