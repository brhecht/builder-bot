# Builder Bot — Handoff (May 5, 2026)

**Status:** Code complete and deployed. Awaiting Brian's review of post quality before activating the production cron.

---

## What's been built

A Slack bot that posts a daily weekday recap to `#daily-recap-bot` at 9:30am ET (Mon-Fri). Reads activity from 4 source channels since each channel's last reported timestamp (cumulative window stored in Vercel KV), uses Claude Sonnet to curate and summarize, and posts the digest as "Builder Bot" with the exact format from the PM brief.

**Source channels:**
- `#introduce-yourself` — new member intros (carry-forward logic)
- `#share-and-discuss` — primary conversation
- `#what-im-building` — primary conversation
- `#general` — supplemental, only if Claude scores items as notable

**Post target:** `#daily-recap-bot` (channel ID `C0AUS1Q7917`)

**Stack:** Next.js 14 App Router + Vercel + Vercel Cron + Upstash Redis (KV) + Anthropic SDK + Slack Web API + luxon for DST handling.

---

## What's verified

- Build passes clean.
- All env vars present in Vercel production: `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `CRON_SECRET`, all 4 `SLACK_CHANNEL_*` IDs, `SLACK_DAILY_RECAP_CHANNEL_ID`.
- Slack app scopes: `channels:history`, `channels:read`, `users:read`, `chat:write`, `chat:write.customize`, `channels:join`.
- Bot has access to all 4 source channels (verified via auto-join — no manual invite needed).
- Live test posted successfully to a private DM with `items: 3, intros: 6` — formatting and curation rendered correctly.

---

## What Brian needs to do

### 1. Run a test post to your own DM
This sends a real Builder Bot post to your DM (not to the public `#daily-recap-bot` channel) so you can review without the community seeing it.

```bash
# Get your TNB Slack member ID:
# In Slack: click your avatar → View profile → ⋮ menu → Copy member ID
# Format: U0...

# Get the CRON_SECRET from Vercel:
# Dashboard → builder-bot → Settings → Environment Variables → CRON_SECRET → Reveal & copy

# Run the test (replace <YOUR_MEMBER_ID> and <CRON_SECRET>):
npx vercel curl "/api/cron?test=true&channel=<YOUR_MEMBER_ID>&lookback_hours=168" \
  --deployment "https://builder-bot.vercel.app" \
  -- -H "Authorization: Bearer <CRON_SECRET>"
```

`lookback_hours=168` = look back 7 days. Adjust if you want a shorter/longer window.

The response will be JSON like:
```json
{"status":"posted","items":3,"intros":6,"date":"...","target":"<YOUR_ID>","test_override":true}
```

`test_override: true` confirms production state was NOT mutated — the regular cron remains unaffected.

### 2. Review the DM that arrives in Slack
Check that:
- [ ] Voice/tone of the summaries matches what you want for TNB (substantive, no hype, specific)
- [ ] Intro summaries draw from both the referrer's words and the new member's own description
- [ ] Conversation items have enough specificity to make someone want to click
- [ ] Slack deep-links work (clicking takes you straight to the thread)
- [ ] Format matches the PM brief exactly (bold header, 👋 section, 💬 section, max 2-3 conversation items)

### 3. Iterate on the prompt if needed
The Claude system prompt lives in `lib/claude.ts` as `SYSTEM_PROMPT`. The exact wording from the PM brief is what's deployed today. If the curation needs adjustment:
- Voice/style → edit `SYSTEM_PROMPT`
- Item selection rules → edit the user prompt template inside `callClaude()`
- Post format → edit the `lines.push(...)` block in `app/api/cron/route.ts`

After any change: `git push` — Vercel auto-deploys.

### 4. Approve to activate
Once you're satisfied with the output, no code change is needed to "activate" — the cron is already live (`30 14 * * 1-5`). Just confirm with Nico:
- "OK to let it run on Monday at 9:30am ET to `#daily-recap-bot`?"

The first real run will fire at the next weekday 9:30am ET in New York time.

---

## Test query parameters reference

All require `Authorization: Bearer <CRON_SECRET>` and only work when `test=true`:

| Parameter | Effect |
|-----------|--------|
| `?test=true` | Bypass the 9:00–10:59 AM NY time gate and weekday check. Required for any manual test. |
| `?dry_run=true` | Run all logic but don't post to Slack. Returns the preview JSON. |
| `?channel=<id>` | Override the post target (e.g. your DM). When set, KV state is NOT mutated. |
| `?lookback_hours=<N>` | Override the KV lookback with `now - N*3600` seconds. Useful for backfilling content for a test post. |

**Example combinations:**
- Pure preview, no post: `?test=true&dry_run=true&lookback_hours=72`
- Real post to your DM, 7-day lookback: `?test=true&channel=U0...&lookback_hours=168`
- Real post to your DM, default 24h state-aware lookback: `?test=true&channel=U0...`

---

## Architecture notes

- **DST handling:** Single cron at `30 14 * * 1-5` UTC. Inside the handler, luxon checks `America/New_York` time and aborts if not in the 9:00–10:59 AM window. This means the post fires at 9:30 AM EST in winter and 10:30 AM EDT in summer — wait, that's wrong for EDT. For now, the handler runs but the time gate accepts both 9 AM and 10 AM windows so a single UTC cron covers both halves of the year. Will need to adjust to two crons (or a different gate) if Brian wants exactly 9:30 AM year-round.
- **Skip logic:** If Claude returns fewer than 2 Include items, the bot skips posting and adds today's intros to `pending_intros` in KV (carry-forward).
- **Dedup:** Same URL across multiple channels keeps only the highest-scoring thread.
- **Auto-join:** On `not_in_channel` error, the bot calls `conversations.join` once and retries. Requires `channels:join` scope (already added).
- **Error handling:** All errors per the PM brief table — `not_in_channel` skips the channel, URL fetch failures fall back to Slack preview, Claude timeout retries with truncated input, KV write failures after a successful post are logged but don't trigger a retry (better to lose state than double-post).

---

## Files

| File | Purpose |
|------|---------|
| `app/api/cron/route.ts` | Main handler — DST gate, KV state, Slack reads, Claude scoring, dedup, post |
| `lib/slack.ts` | `getChannelMessages` (paginated), `getThreadReplies`, `getUserName`, `postMessage`, `makeDeepLink`, `joinChannel` |
| `lib/claude.ts` | `SYSTEM_PROMPT` + `scoreAndSummarize` + `processIntro` |
| `lib/kv.ts` | Upstash Redis wrappers — `last_reported_*` and `pending_intros` |
| `lib/url-fetch.ts` | Fetch URL with paywall detection + Slack preview fallback |
| `lib/types.ts` | All TypeScript interfaces |
| `vercel.json` | Cron config |
| `PM-BRIEF-builder-bot.md` | Original product brief, APPROVED Apr 21 |

---

## Open questions for Brian

1. The DST handling (single UTC cron + 9-11 AM NY gate) means the post fires anywhere from 9:30 to 10:30 AM ET depending on the season. If you want exact 9:30 AM ET year-round, I can switch to a 2-cron setup (one for EST, one for EDT) — let me know.
2. The current `SYSTEM_PROMPT` is verbatim from the PM brief. After your test, tell me if anything in the curation logic should change.
3. Once approved, do you want the cron live on the next weekday or do you want to schedule a specific start day?

— Nico
