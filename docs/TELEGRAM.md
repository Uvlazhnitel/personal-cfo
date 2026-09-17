# Telegram Text Input

Stage 6 adds a single-owner Telegram text channel to the worker. It supports authorized private-chat cash expenses, side-hustle or other cash income, physical cash counts, future expenses, bounded clarification, and reply-based cash-flow corrections. It does not support salary creation, voice, general CFO chat, proactive notifications, non-EUR input, or live Telegram calls in tests.

## Configuration

Telegram is disabled when all three variables are absent:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_ID
TELEGRAM_OWNER_ID
```

Set all three or none. A partial or invalid configuration stops worker startup. `TELEGRAM_OWNER_ID` must identify an existing owner. The adapter derives a SHA-256 source key from the token's numeric bot-ID prefix; the token and full Bot API URL are never persisted or logged.

The owner must have exactly one active, ledger-authoritative, non-brokerage EUR Cash Account. Missing or ambiguous cash-account configuration produces no financial mutation.

## Supported text

Examples:

```text
€12 lunch paid in cash
12 евро наличкой обед
received €120 cash from side hustle
получил 120 евро наличными за подработку
cash count €125
наличных сейчас 125 евро
trip Japan €1500 by 2027-05-01
поездка Япония 1500 евро до 2027-05-01
```

`/start` and `/help` show these bounded examples. `/cancel` cancels an active clarification and never reverses a committed fact. Amounts are parsed exactly into integer EUR minor units. `today`/`сегодня`, `yesterday`/`вчера`, and one ISO date are supported; date-only activity uses Europe/Riga noon converted to UTC.

Unknown clear expenses use the standard `other` category. Side-hustle income is never treated as primary salary. A future expense creates an active committed Sinking Fund with manual allocation; Telegram does not calculate a required contribution.

The narrow future-expense keywords `future expense`, `trip`, `insurance`, `поездка`, and `страховка` preserve that intent when the amount or due date is missing. Clarification asks for amount first and then an ISO due date. Explicit current-spending language such as `paid cash` remains a cash expense.

## Durable inbox and replies

The worker starts Telegram only after PostgreSQL and pg-boss. It first drains persisted updates and deliveries, then calls `getUpdates` with a 25-second timeout and `allowed_updates=["message"]`. Each returned page and its next offset commit together before a higher offset is used. A restart therefore replays locally pending work without losing an update already acknowledged to Telegram.

Updates are unique by source key and update ID, with a second message-identity constraint. A claim creates a five-minute processing lease. A crashed worker may be reclaimed after that lease; an explicitly observed unexpected infrastructure/runtime failure instead enters `retryable` with a persisted retry time. Processing is limited to three total claims with one-second and two-second delays after the first two failures. The long-poll timeout is shortened when a local retry is due sooner than the normal 25 seconds.

After the third failure, the update becomes terminal, queues one independent resend instruction, and cannot be claimed again. Deterministic parser, user, invariant, and conflict errors do not enter this retry loop. Financial-command idempotency is unchanged across attempts.

Authorized text is retained only in `received`, `processing`, or `retryable`, for no more than 24 hours. It is cleared at every terminal or clarification state. Identifiers, text hashes, parser outcomes, attempt counts, safe error categories, and entity links remain for audit and correction.

Financial mutation, command/entity linking, update finalization, pending confirmation, audit, input-version increment, recalculation record, and pg-boss enqueue share the financial command transaction. An already-matching cash count is a completed no-change command: it creates no canonical mutation, audit event, version increment, or recalculation.

Replies are sent only after commit. Reply delivery has its own state machine: rate limits and server failures receive at most three delivery attempts. An indeterminate send outcome is recorded as `uncertain` and is not retried automatically, because duplicate Telegram delivery cannot be ruled out. Processing retry and delivery retry are independent; financial commands are never rerun to resend a reply.

## Clarification and correction

One clarification may be active for an owner/source/chat for 15 minutes. It stores structured known fields only, permits two invalid replies, and clears its payload when resolved, cancelled, superseded, or expired. A complete independent command supersedes the older clarification.

A correction must reply within 30 days to the recorded bot confirmation. Expense corrections support one amount, date, category, or cancellation change; income corrections support one amount, date, source, or cancellation change. Reconciliation and Sinking Fund replies are rejected safely.

Corrections preserve history. An expense receives a linked refund and, unless cancelled, a corrected consumption. Income receives a negative earned-income correction and, unless cancelled, a corrected positive income. The old Telegram link becomes superseded or cancelled, preventing repeated reversal through the old confirmation.

## Operations and privacy

`/debug` shows whether Telegram is enabled, the last durable update and time, active clarification and retryable-update counts, and safe recent update/delivery failures with processing attempt metadata. It never displays raw Telegram text, message descriptions, token data, full API URLs, or Telegram identifiers.

Shutdown aborts long polling, stops new claims, waits for the active loop and bounded database work, then permits the worker to stop pg-boss and PostgreSQL. Tests use fake Bot API boundaries and sanitized data only.
