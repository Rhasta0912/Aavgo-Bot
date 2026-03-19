# Aavgo Bot History

This is the GitHub-side continuity file for the live bot repo.

Primary local ops archive:
- `C:\Users\chugc\Desktop\Aavgo Bot\History.md`

Working rules:
- Keep this history append-only.
- Log meaningful fixes, feature work, deployment changes, and mistakes/fixes.
- Treat the live workspace as source of truth for code.
- Treat database permissions as the real authority, with Discord roles mostly used for channel access and presentation.

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
