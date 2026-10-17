# ReachInbox Email Scheduler

A full-stack email scheduling demo built with TypeScript, Express, React, PostgreSQL, Redis, BullMQ, and Nodemailer. Users can sign in with Google, schedule a batch of emails from a lead file, and track each email's status in the dashboard. The default SMTP transport is Ethereal, so messages are captured for preview rather than delivered to real inboxes.

> **Demo limitations:** Email search is implemented with PostgreSQL, not Elasticsearch. The Figma file was not accessible during implementation, so the dashboard follows the requested product flow but has not been verified pixel-for-pixel against that design. Slack rate-limit notifications are implemented, but require a configured Slack app and connected workspace to demonstrate.

## Features

| Area | Implementation |
| --- | --- |
| Scheduling API | Authenticated `POST /api/emails` creates one PostgreSQL record and one delayed BullMQ job per recipient. |
| Persistence | PostgreSQL stores users, email records, and server-side login sessions. Redis persistence is enabled in the included Docker Compose configuration. |
| Restart recovery | BullMQ delayed jobs persist in Redis. The worker also scans for database records not yet published to the queue at startup and every 15 seconds. |
| Idempotency | Optional `Idempotency-Key` request header, deterministic per-recipient database keys, and BullMQ job IDs prevent duplicate scheduling for retried requests. |
| Delivery | Ethereal SMTP is the safe default. Gmail SMTP is available as an opt-in local demo transport. |
| Rate control | Atomic Redis Lua reservations enforce a minimum send interval and per-sender/per-batch hourly caps across worker instances. |
| Slack alerts | Optional Slack OAuth connects an incoming webhook; credentials are encrypted before storage. A rate-limit window triggers one notification when Slack is connected. |
| Dashboard | Google sign-in, compose from CSV/TXT leads, search, queue counts, and All / Scheduled / Sent views with status refresh. |
| Queue visibility | Bull Board is available at `/admin/queues` and requires an authenticated session. |
| Search | Recipient, sender, subject, and body are searched with PostgreSQL case-insensitive matching. Elasticsearch is not included. |

## Requirements

- Node.js 20 or later and npm
- Docker Desktop (recommended) or PostgreSQL and Redis running locally
- A Google OAuth application to use Google sign-in
- A Slack app with incoming webhooks if you want to test Slack alerts

## Run locally

1. In the repository root, create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Edit `.env`. At minimum, set:

   - `DATABASE_URL` to your PostgreSQL connection URL. For the included Docker Compose database, use:

     ```text
     postgresql://scheduler:scheduler@localhost:5432/scheduler?schema=public
     ```

   - `SESSION_SECRET` to a private random string at least 24 characters long
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for sign-in
   - `GOOGLE_CALLBACK_URL=http://localhost:4000/auth/google/callback`

   Leave `.env` on your machine; it is excluded from Git. See [Configuration](#configuration) and [Google sign-in](#google-sign-in) for details.

3. Start PostgreSQL and Redis. To use the included Docker Compose services:

   ```powershell
   docker compose up -d
   ```

   The included local PostgreSQL service uses database `scheduler`, user `scheduler`, and password `scheduler`. Its named Docker volume preserves database data when containers are restarted. These credentials are for local development only.

4. Install dependencies, generate the Prisma client, and apply migrations:

   ```powershell
   npm install
   npm run db:generate
   npm run db:migrate
   ```

5. Start the API, worker, and frontend:

   ```powershell
   npm run dev
   ```

   Open:

   - Dashboard: <http://localhost:5173>
   - API health: <http://localhost:4000/health>
   - Bull Board: <http://localhost:4000/admin/queues> (sign in first)

The development command starts three processes: the Express API, BullMQ worker, and Vite frontend.

## Configuration

The complete variable list and development defaults are in `.env.example`. Important variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `REDIS_URL` | Redis connection string used by BullMQ and distributed rate controls. |
| `SESSION_SECRET` | Secret used to sign the server-side session cookie; use a unique secret in production. |
| `FRONTEND_URL`, `API_URL`, `VITE_API_URL` | Frontend/API origins. `VITE_API_URL` is read when building the frontend. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth credentials and callback. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_CALLBACK_URL` | Slack OAuth credentials and callback. |
| `SLACK_TOKEN_ENCRYPTION_KEY` | 32-byte key encoded as 64 hexadecimal characters for encrypting stored Slack credentials. |
| `EMAIL_TRANSPORT` | `ethereal` by default; set to `gmail` only for an explicitly intended real-send test. |
| `ETHEREAL_USER`, `ETHEREAL_PASS` | Optional fixed Ethereal SMTP credentials. If omitted, the worker creates a test account at startup. |
| `SMTP_USER`, `SMTP_PASS` | Gmail address and Google App Password when `EMAIL_TRANSPORT=gmail`. |
| `WORKER_CONCURRENCY` | Number of jobs a worker may process concurrently (default `10`). |
| `MIN_SEND_INTERVAL_MS` | Minimum interval between sends for a sender across workers (default `2000`, or 2 seconds). |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Global per-user/sender hourly cap (default `200`). |
| `EMAIL_JOB_MAX_ATTEMPTS` | BullMQ retry limit for safely retryable SMTP failures (default `5`). |

Generate a random session secret in PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Generate the Slack encryption key with OpenSSL:

```sh
openssl rand -hex 32
```

Never commit `.env`, OAuth secrets, SMTP App Passwords, encryption keys, or real lead lists.

## Google sign-in

Create a Google OAuth 2.0 web client and add this authorized redirect URI:

```text
http://localhost:4000/auth/google/callback
```

Set the client ID and secret in `.env`, then restart the API. Login creates or updates the user in PostgreSQL and uses a PostgreSQL-backed server session. The dashboard obtains the signed-in user's profile from `GET /auth/me`.

## Slack notifications

Create a Slack app with the `incoming-webhook` OAuth scope and configure the redirect URI to match `SLACK_CALLBACK_URL` (locally, `http://localhost:4000/auth/slack/callback`). Set the Slack client ID, client secret, callback, and a 64-character hexadecimal `SLACK_TOKEN_ENCRYPTION_KEY` in `.env`, then restart the API.

After Google sign-in, use **Connect Slack** in the dashboard. The OAuth callback stores the webhook credentials encrypted in the user's PostgreSQL record; disconnecting clears them. When an hourly cap is first reached for a sender and UTC hour, the worker posts a Slack message if a webhook is connected. No Slack connection is required for scheduling or sending. Verify the OAuth callback and notification in the target Slack workspace before claiming a live Slack demo.

## Email transport and safety

The default `EMAIL_TRANSPORT=ethereal` sends to a fake SMTP service. Ethereal messages do **not** arrive in real recipients' inboxes. When a generated Ethereal account is used, the worker prints its username; after sending, it prints a preview URL that can be opened to inspect the message.

For a small, consent-based real-send demo only, Gmail SMTP can be enabled with a Gmail App Password:

1. Enable 2-Step Verification on the sending Google account and create an App Password.
2. Set `EMAIL_TRANSPORT=gmail`, `SMTP_USER` to that Gmail address, and `SMTP_PASS` to the App Password.
3. Schedule with `senderEmail` matching `SMTP_USER`.

Restart the worker after changing `.env`. Do not use a regular Google password. Gmail sends real mail and is subject to provider policies and limits. Keep Ethereal enabled unless real delivery is specifically intended; only message recipients who have agreed to receive the email.

## Scheduling API

Scheduling requires a valid Google-authenticated session cookie. The API accepts a JSON batch of up to 5,000 unique recipients:

```http
POST /api/emails
Content-Type: application/json
Idempotency-Key: campaign-2026-11-01
```

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

`startAt` is an ISO 8601 timestamp with a timezone. The per-request `hourlyLimit` is an additional batch cap; it does not override the configured global per-sender cap. If retrying a schedule request, reuse the same `Idempotency-Key` and identical request body. A reused key with different data returns a conflict. Without a key, each request is treated as a new batch.

The server persists email rows before publishing jobs. Each email receives its own delayed BullMQ job whose due time is based on `startAt` and `delayBetweenMs`. If queue publication fails after persistence, the worker recovery scan retries publishing; the API returns an error that explains the emails were saved.

### Other endpoints

| Endpoint | Description |
| --- | --- |
| `GET /health` | Checks PostgreSQL and Redis connectivity. |
| `GET /auth/me` | Returns the current user, or `null` when signed out. |
| `POST /auth/logout` | Ends the current session. |
| `GET /api/emails?view=all&page=1&pageSize=50&q=...` | Lists all email statuses for the signed-in user. |
| `GET /api/emails?view=scheduled&page=1&pageSize=50&q=...` | Lists `SCHEDULED` and `PROCESSING` emails. |
| `GET /api/emails?view=sent&page=1&pageSize=50&q=...` | Lists `SENT` and `FAILED` emails. |
| `GET /api/queue/stats` | Returns BullMQ queue counts for the signed-in user. |
| `GET /admin/queues` | Authenticated Bull Board UI. |
| `GET /auth/slack/status` | Reports whether the signed-in user has connected Slack. |
| `GET /auth/slack` / `DELETE /auth/slack` | Starts Slack OAuth / disconnects Slack. |

Email list responses contain `emails`, `total`, `page`, and `pageSize`. Search currently uses PostgreSQL case-insensitive matching over recipient, sender, subject, and body; it is not Elasticsearch-backed.

## Reliability, throughput, and trade-offs

- **Delayed scheduling, no cron:** BullMQ delayed jobs are stored in Redis. No cron service or cron library is used.
- **Durable records and recovery:** PostgreSQL is the source of truth for email status. Redis is configured with AOF persistence in Docker Compose. On worker startup and every 15 seconds, a recovery loop finds scheduled rows that have not been marked as published and adds them to BullMQ using the email ID as job ID.
- **Concurrency:** Configure worker parallelism with `WORKER_CONCURRENCY`.
- **Send pacing:** An atomic Redis Lua script reserves the next send time for each user/sender. It enforces the larger of the campaign's `delayBetweenMs` and `MIN_SEND_INTERVAL_MS`, across worker instances.
- **Hourly caps:** The same atomic reservation tracks hourly counts by user/sender and by batch. Reaching either cap defers jobs into the next available UTC-hour window rather than dropping them. The default sender cap is 200 per hour and the dashboard request can specify a lower batch cap.
- **Slack alert deduplication:** Redis records one notification reservation per user/sender/hour. If Slack is disconnected, the email scheduling path continues without a notification. Slack delivery failures are logged by the worker.
- **Large batches:** Requests are limited to 5,000 unique recipients and become individual database rows and queue jobs. BullMQ concurrency and Redis pacing spread the resulting work over time; recipient count does not bypass hourly caps.
- **SMTP retry behavior:** Only failures classified as safely retryable are retried with BullMQ exponential backoff. Ambiguous SMTP outcomes are marked failed rather than retried to reduce the risk of duplicate delivery.
- **Exactly-once limitation:** SMTP and PostgreSQL cannot share a transaction, and SMTP does not provide a universal idempotency key. If a process stops after a server may have accepted a message but before success is stored, the final remote outcome can be uncertain. The implementation favors avoiding duplicate sends over automatically retrying an ambiguous send.
- **Queue retention:** Completed BullMQ jobs are retained for up to 14 days (or 10,000 jobs); failed jobs are retained for up to 30 days. PostgreSQL email records remain the dashboard's durable history.

## Build and run production processes

Build both workspaces:

```powershell
npm run build
```

Apply migrations before starting the services:

```powershell
npm run db:migrate
```

Run the API and worker as separate processes:

```powershell
npm run start:api
npm run start:worker
```

Deploy the frontend static build from `frontend/dist`. Set `VITE_API_URL` to the deployed API origin **at build time**. In production, use HTTPS, a durable managed PostgreSQL and Redis, strong private secrets, and a same-site deployment or reverse proxy that supports the session cookie. The included Docker credentials and localhost OAuth callback URLs are development-only.

## Project layout

```text
backend/
  prisma/       Prisma schema and SQL migrations
  src/
    app.ts      Express app, sessions, API and Bull Board routes
    auth.ts     Google and Slack OAuth flows
    emails.ts   Authenticated scheduling and email listing APIs
    worker.ts   BullMQ worker, SMTP delivery, rate controls, recovery
frontend/
  src/          React dashboard and styles
docker-compose.yml
.env.example
```

## Assumptions and known gaps

- The requirement mentions Elasticsearch; this implementation deliberately uses PostgreSQL search instead. Elasticsearch indexing and reindex/recovery behavior would need to be added to fully meet that requirement.
- Slack OAuth and webhook delivery code are present, but the integration cannot be exercised without valid app credentials and an authorized Slack workspace.
- The Figma design was unavailable for inspection during implementation.
- Gmail SMTP is an optional demonstration path, not a production bulk-mail provider integration.
- This repository is a hiring-assignment demo, not a complete multi-tenant production outreach platform.
