# Aavgo Hours API v1

The bot publishes snapshots to a partner HTTPS endpoint. It is disabled by default.

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
