# Aavgo Hours API v1

The bot publishes snapshots to a partner HTTPS endpoint. It is disabled by default.

It can also serve a protected read link and accept tightly limited manual-hour corrections on its assigned SparkedHost port.

The raw SparkedHost IP-and-port allocation is HTTP only. Do not expose a tokenized read link on it directly. Put a trusted HTTPS reverse proxy or custom-domain TLS service in front of the allocation first, then explicitly enable the inbound service.

## Request

`POST` the configured `AAVGO_HOURS_API_V1_URL` with a JSON body and these headers:

- `X-Aavgo-Api-Version: v1`
- `X-Aavgo-Timestamp`: Unix seconds
- `X-Aavgo-Snapshot-Id`: unique snapshot ID
- `X-Aavgo-Signature: sha256=<hex>`

The signature is `HMAC-SHA256(shared_secret, "timestamp.body")`, where `body` is the exact raw JSON body.

## Partner requirements

- Accept HTTPS only.
- Reject timestamps older than five minutes and future timestamps more than five minutes ahead.
- Compute the signature from the raw body and compare it in constant time.
- Treat `snapshot_id` as an idempotency key for at least 24 hours.
- Do not log the signature or shared secret.

## Payload

The payload contains `api_version`, `snapshot_id`, `generated_at`, payroll rules, and an `agents` array. Each agent includes Discord ID, display name, role, current operational status, assigned hotel/team, active-session state, and weekly/monthly/all-time hour totals. PINs, phone numbers, emails, and tokens are never included.

Closed sessions are counted as completed full hours. Active sessions are reported as active but are excluded from finalized totals. Manual adjustments are included.

## Inbound read link

`GET /api/v1/hours?access_token=<read-token>` returns the current snapshot. The read token is view-only and must be at least 32 characters.

## Inbound correction route

`POST /api/v1/hours/adjustments` accepts only append-only manual adjustments. It requires the same timestamp/signature format described above, but uses the separate write secret.

Required JSON fields: `request_id`, `agent_discord_id`, `operation` (`add` or `remove`), `hours` (more than 0 and no more than 24), `mode` (`shift` or `training`), `shift_date` (`YYYY-MM-DD`), `reason`, and `requested_by`.

The API cannot edit raw sessions, roles, PINs, teams, hotels, or bot configuration. Duplicate request IDs are safely ignored and return the original adjustment ID.
