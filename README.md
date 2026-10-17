# Outbox email scheduler

A TypeScript email scheduling service with a React dashboard. PostgreSQL is the source of truth and handles email search, BullMQ delayed jobs are backed by persistent Redis, and Ethereal provides fake SMTP delivery. No cron process or cron library is used.

## Run locally

Requirements: Node.js 20+, PostgreSQL, Redis, and OAuth app credentials for Google/Slack if you want to test sign-in and notifications.

1. Copy `.env.example` to `.env` and set a random `SESSION_SECRET` (at least 24 characters). Set the OAuth values below to enable those flows.
2. Start your PostgreSQL and Redis services. To use Docker for these services:

   ```sh
   docker compose up -d
   ```

3. Install dependencies, create the database schema, and start the API, worker, and dashboard:

   ```sh
   npm install
   npm run db:generate
   npm run db:migrate
   npm run dev
   ```

   The dashboard is at <http://localhost:5173>, the API at <http://localhost:4000>, and the authenticated BullMQ dashboard at <http://localhost:4000/admin/queues>.

By default, the worker uses Ethereal: it creates a test account when `ETHEREAL_USER`/`ETHEREAL_PASS` are empty, prints its username, and logs a preview URL for each send. Ethereal messages are not delivered to real inboxes.

### Optional real delivery with Gmail SMTP

For a small, consent-based demo, you can opt in to real Gmail delivery:

1. Enable 2-Step Verification on the Google account you will send from, then create an **App Password** in your Google Account security settings. If Google does not offer App Passwords for the account, keep using Ethereal or use a supported mail provider.
2. In the root `.env`, set `EMAIL_TRANSPORT=gmail`, `SMTP_USER` to the Gmail address, and `SMTP_PASS` to the 16-character App Password. Do not use your regular Google password or share the App Password.
3. Schedule emails with `senderEmail` equal to that Gmail address. Restart the API and worker after changing `.env`. The worker will log each actual recipient, subject, and transport; Gmail sends do not have Ethereal preview links.

Gmail sends real email and is subject to Google's sending limits and account policies; it is intended only for a small demo, not bulk outreach. Only send to recipients who have agreed to receive your message. Leave `EMAIL_TRANSPORT=ethereal` for safe previews.

To build production bundles, run `npm run build`, then start the API and worker as separate processes with `npm run start:api` and `npm run start:worker`. Apply schema migrations before deployment using `npm run db:migrate`.

## OAuth setup

**Google:** Create a Google OAuth 2.0 web client. Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL`. In production, use the public HTTPS callback URL and set `API_URL` and `FRONTEND_URL` to the deployed origins. Login uses a server-side PostgreSQL session; sessions and user identity survive API restarts.

The frontend and API should be deployed on the same site (or behind a same-origin reverse proxy) so browsers can send the session cookie with dashboard API requests. Set `VITE_API_URL` at frontend build time to the public API origin.

**Slack:** Create a Slack app with the `incoming-webhook` OAuth bot scope and set the callback URL to `http://localhost:4000/auth/slack/callback`. Configure `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_CALLBACK_URL`. Generate a 32-byte encryption key with `openssl rand -hex 32` and set `SLACK_TOKEN_ENCRYPTION_KEY`. The OAuth exchange stores the returned webhook URL and bot token encrypted at rest. Connect/disconnect takes effect immediately without a redeploy. When a sender exhausts its hourly allowance, one Slack webhook message is sent for that sender and UTC hour; accounts without Slack connected are simply skipped.

## Scheduling API

`POST /api/emails` requires an authenticated Google session and accepts JSON:

```json
{
  "recipients": ["person@example.com", "another@example.com"],
  "senderEmail": "team@example.com",
  "subject": "A helpful update",
  "body": "Hello there",
  "startAt": "2026-11-01T15:00:00.000Z",
  "delayBetweenMs": 2000,
  "hourlyLimit": 200
}
```

Send a unique `Idempotency-Key` header when retrying a request. A batch is stored in PostgreSQL before jobs are published; deterministic per-recipient keys and BullMQ job IDs prevent duplicate enqueueing. If a process stops between the database write and queue publication, a worker startup scan and a 15-second outbox recovery loop publish the pending rows. Queue jobs retain their original scheduled timestamps. This is an outbox reconciliation loop, not a cron scheduler.

`GET /api/emails?view=scheduled|sent&page=1&pageSize=50&q=...` lists the user's scheduled/processing or sent/failed emails. Search uses PostgreSQL case-insensitive text matching; Elasticsearch is not used or required. `GET /api/queue/stats` provides queue counts. `GET /health` checks API/PostgreSQL/Redis connectivity.

## Throughput and restart behavior

- `WORKER_CONCURRENCY` configures BullMQ worker concurrency (default 10).
- Each sender is paced across all worker instances by an atomic Redis reservation. The enforced gap is the larger of the campaign's `delayBetweenMs` and `MIN_SEND_INTERVAL_MS` (default 2 seconds).
- The global sender cap is enforced by a Redis counter per user/sender and UTC hour using `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 200); each campaign's `hourlyLimit` is enforced with a separate Redis counter as well. Both counters are updated atomically with the sender's pacing reservation, so overlapping campaigns cannot bypass the configured sender cap and a lower campaign cap is respected without changing other campaigns. A full hour does not fail or discard jobs: the worker reserves capacity in the next available window and uses BullMQ's delayed-job state to defer delivery. Reservations serialize bursts and preserve queue order as work is claimed, but jobs at exactly the same time can be claimed concurrently.
- A 1,000-recipient burst is persisted as independent jobs and distributed over subsequent intervals/hour windows. Redis counters and delay reservations coordinate API worker replicas; PostgreSQL remains the durable record and the worker recovery loop reconciles unpublished rows back into BullMQ.
- SMTP errors are retried with exponential backoff up to `EMAIL_JOB_MAX_ATTEMPTS` (default 5) only when the SMTP command/response indicates the message was not accepted. An ambiguous or post-DATA failure is marked failed without a resend. Completed and failed queue records are retained for inspection.
- SMTP cannot participate in a PostgreSQL transaction or provide a universal idempotency key. The worker claims each row before sending and supplies a deterministic `Message-ID`. If a worker dies in the narrow interval after SMTP may have accepted the message but before PostgreSQL records success, recovery marks the ambiguous row failed rather than sending it a second time. This avoids duplicate sends but the remote SMTP outcome can be uncertain; strict exactly-once delivery is not technically guaranteeable over SMTP.

## Configuration

See `.env.example` for all supported variables. `DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CALLBACK_URL`, and `SLACK_CALLBACK_URL` must be valid values. Google and Slack credentials can be left unset for development, but the corresponding OAuth action will return a clear configuration error. Redis and PostgreSQL can be provisioned by Docker Compose with named data volumes.
