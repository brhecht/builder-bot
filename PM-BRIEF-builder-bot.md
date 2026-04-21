# PM Brief — Builder Bot (Daily Recap)
**App:** builder-bot (new repo)
**Status:** DRAFT
**Created:** April 21, 2026
**Approved:** —

## What We're Building
A scheduled Slack bot that posts a daily weekday recap to The New Builder
Slack workspace at 9:30am ET. It reads activity across 4 channels since
the last time each channel was reported on (cumulative, not a fixed 24h
window), fetches linked content, uses Claude to curate and summarize the
most engaging and substantive moments, and posts a clean bulleted digest
as "Builder Bot" in #daily-recap. Goal: re-engage members daily and drive
click-throughs into active threads.

## Acceptance Criteria
- [ ] Builder Bot posts to #daily-recap at 9:30am ET, weekdays only
- [ ] Each channel's lookback window is cumulative — starts from its own
      last-reported timestamp stored in Vercel KV, not a fixed 24h window
- [ ] New member intros (from #introduce-yourself) are included in the
      post only when there is also at least one conversation item; if intros
      are the only activity, they are held in Vercel KV and carried forward
      to the next post-worthy day
- [ ] Post includes 2+ "Top Builder Conversations" items selected by Claude
      based on substantive relevance — not reply count
- [ ] Bot fetches and reads linked URLs to inform summaries; falls back to
      Slack link preview metadata on fetch failure; drops URL gracefully
      if neither is available
- [ ] Same URL appearing in multiple channels is deduplicated — highest
      substantive-conversation thread wins
- [ ] If total meaningful activity across all channels falls below threshold
      (fewer than 2 conversation items AND no pending intros to carry) —
      bot skips that day silently
- [ ] Bot posts as "Builder Bot" identity, not as a generic Slack app

## Scope Boundaries
**In scope:**
- New standalone repo: builder-bot
- Vercel deployment + Vercel KV (state storage)
- Vercel cron: weekdays 9:30am ET (DST-aware via luxon)
- Slack API: read 4 source channels + post to #daily-recap
- Claude API: relevance evaluation + summarization
- URL fetching with graceful fallback
- Deduplication logic
- Carry-forward logic for pending intros
- Skip logic when below threshold

**Out of scope:**
- Nothing touches brain-inbox repo — builder-bot is fully standalone
- No slash commands, no reply handling, no interactive features
- No member DMs
- No analytics or click tracking
- No admin dashboard

## Channel Routing
| Source Channel | Purpose |
|----------------|---------|
| #introduce-yourself | New member section (carry-forward logic applies) |
| #share-and-discuss | Primary conversation source |
| #what-im-building | Primary conversation source |
| #general | Supplemental — only if Claude scores item as notable |
| #daily-recap | Output only — Builder Bot posts here |

## Post Format (exact — no variations)

```
*Top Builder Conversations — [Weekday, Month Date]*

👋 *New to the community*
• *[Name]* — [1-2 lines: referrer's words about them + their own description of what they're building]

💬 *Top Builder Conversations*
• *[Person]* ([#channel]) — [2-3 line tease with enough specificity to make someone want to click. End with a Slack deep-link to the thread.]
• *[Person]* ([#channel]) — [same format]
```

Rules:
- If no pending or new intros: omit the 👋 section entirely
- If fewer than 2 conversation items meet threshold: skip the entire post
- Never more than 2 items from the same channel in one post
- 2-3 items total in the conversations section — never more than 3

## Relevance & Curation Logic

### What Claude evaluates (no numeric formula — Claude's holistic judgment)
For each candidate item from any channel, Claude assesses:

1. **Substantive content** — Is the thing being shared genuinely interesting,
   novel, or useful to a founder/builder audience? A specific tool someone
   built scores high. A vague question scores low. A link to a thoughtful
   essay scores high. A meme scores low.

2. **Quality of conversation** — Are replies (if any) adding insight, context,
   or real reactions? Banter, +1s, and emoji pile-ons do not count. A single
   reply that adds a sharp counterpoint counts more than 10 laugh reactions.

3. **Specificity** — "I built a CLI that deploys artifacts from your terminal"
   beats "anyone tried AI coding tools lately?" Every time.

### Claude system prompt (exact — Nico uses this verbatim)
```
You are the editorial voice of The New Builder — a community of founders and
builders who use AI seriously in their work. These are not hobbyists. They are
people building real products and companies.

Your job is to select and summarize the most substantive, interesting activity
from the past period in The New Builder Slack. You are curating, not logging.
You have editorial judgment. Use it.

A good item: someone shipped something specific, shared an insight that
challenges an assumption, or sparked a conversation where people actually
disagreed or built on each other's ideas.

A bad item: banter, generic enthusiasm, vague questions with no follow-up,
or link drops with no context or reaction.

When writing summaries: be specific. Name what the person built or said.
Name what made it interesting. Write to make someone curious enough to click.
No hype. No filler. Max 2-3 lines per item.

For new member intros: draw from both the referrer's introduction and the
member's own words. Make them sound like someone worth knowing.
```

### Per-item input to Claude
For each candidate, pass:
- Original post text (full)
- Up to 10 replies, ordered by character length descending (most substantive first)
- Fetched URL content (first 2000 chars) or link preview fallback
- Channel name
- Number of total replies (for context, not scoring)

Ask Claude to: (a) score each item as Include / Skip with a one-line reason,
then (b) write the final summary for all Include items.

## State Management (Vercel KV)

### Keys
| Key | Value | Purpose |
|-----|-------|---------|
| `last_reported_{channel_id}` | Unix timestamp | Last message timestamp included in any recap, per channel |
| `pending_intros` | JSON array of intro objects | Intros held from days with no conversation content |

### Intro object shape
```json
{
  "name": "Jeff Latz",
  "summary": "Brian welcomed Jeff — musician-turned-ecommerce founder who quit engineering to go all-in on music, set up a Shopify store and sold 1000+ units in merch, and just launched fridaymusic.shop last month.",
  "collected_date": "2026-04-21"
}
```

### Run logic (exact sequence)
1. Read `last_reported_{channel_id}` per channel from KV (default: 24h ago if no key exists)
2. Read `pending_intros` from KV (default: empty array)
3. Fetch all messages since each channel's timestamp (paginate via cursor)
4. Extract intro candidates from #introduce-yourself messages
5. Extract conversation candidates from all other channels
6. Deduplicate by URL across channels
7. Pass conversation candidates to Claude for relevance scoring
8. Determine post decision:
   - If Claude returns ≥2 Include items: proceed to post
   - If Claude returns <2 Include items AND pending_intros is empty: skip, update timestamps, done
   - If Claude returns <2 Include items AND pending_intros has entries: skip, add today's intros to pending, update timestamps, done
9. If posting:
   - Combine pending_intros + today's intros into the 👋 section (if any)
   - Combine Claude's Include items into the 💬 section
   - Post to #daily-recap
   - Update all `last_reported_{channel_id}` timestamps to now
   - Clear `pending_intros` from KV
10. If skipping:
   - Append today's new intros to `pending_intros` in KV
   - Update all `last_reported_{channel_id}` timestamps to now

## Error Handling (exact — no improvisation)
| Error | Behavior |
|-------|---------|
| `not_in_channel` on any source channel | Log channel name, skip that channel, continue run |
| URL fetch fails (timeout, 4xx, 5xx) | Use Slack link preview title+description. If no preview, omit URL from summary but keep thread if it has replies |
| URL is paywalled (detect via paywall signals) | Use link preview only |
| Claude API timeout | Retry once with truncated input (5 replies max, 1000 char URL excerpt). If still fails, skip that item |
| KV write fails after successful post | Log error, do not retry post. Better to lose state than double-post |
| KV read fails | Default to 24h lookback for affected channels, log warning |
| Vercel function timeout | Set `maxDuration: 60` in vercel.json |
| Monday after quiet weekend | Handled automatically by cumulative timestamp logic |
| Multiple days of silence in one channel | Cumulative window expands — Claude receives older content scored against recency |

## DST Handling
Use `luxon` to target "9:30 America/New_York" regardless of DST.
Cron expression in vercel.json uses UTC and must be updated twice per year
OR Nico implements a single cron at 14:30 UTC with a luxon check inside
the function to abort if local NY time is not between 9:00-10:00am.
Recommend: luxon time-check inside function + single UTC cron. Cleaner
than two cron entries.

## Environment Variables
| Variable | Source |
|----------|--------|
| `SLACK_BOT_TOKEN` | Brian provides to Nico directly — never committed to repo |
| `ANTHROPIC_API_KEY` | Same key used across B-Suite — Brian provides |
| `SLACK_DAILY_RECAP_CHANNEL_ID` | Channel ID for #daily-recap (not the name — the ID) |
| `KV_REST_API_URL` | Auto-injected by Vercel when KV store is created |
| `KV_REST_API_TOKEN` | Auto-injected by Vercel when KV store is created |

## Risk Assessment
**Complexity:** Medium
**Cross-app impact:** None — fully standalone, no shared Firestore, no B-Suite dependencies
**Risk areas:**
- Claude prompt quality is the whole product — first 5 days of output
  need Brian's review before this is considered done
- Slack API pagination: long lookback windows (e.g., Monday after a quiet
  week) may require cursor-based pagination — must be implemented, not assumed
- Vercel KV cold-start on first deploy: Nico must initialize all channel
  timestamp keys manually before first cron fires

## Estimated Effort
Small-Medium: 1 dedicated session (2-3 hours)

## Milestones & Check-ins

### Milestone 1: Scaffolding + Slack Read + KV State
**What:** Repo created, Vercel deployed, KV store initialized with all
channel timestamp keys, bot authenticates and reads messages from all 4
channels using cumulative timestamp logic, pagination handled.
**Verify:** Console log / JSON dump of raw messages pulled per channel
with timestamps and message counts.
**→ Contact Brian via Slack DM with screenshot before proceeding.**

### Milestone 2: Claude Scoring + URL Fetch + Post
**What:** Claude API wired with exact prompt spec above. URL fetching
implemented with fallback chain. Deduplication working. Carry-forward
intro logic working. Bot posts a test message to #daily-recap using
exact post format.
**Verify:** Test post visible in #daily-recap with correct format and
genuine Claude-generated summaries (not placeholder text).
**→ Contact Brian via Slack DM with screenshot. Wait for Brian's OK
before proceeding.**

### Milestone 3: Cron + Skip Logic + Error Handling + DST
**What:** Vercel cron live (test with 2-min cron, then reset to 9:30am
ET via luxon logic). Skip logic implemented and tested. All error
handling table above implemented. maxDuration: 60 set. DST logic in place.
**Verify:** Trigger cron manually. Confirm it fires. Confirm skip fires
correctly on a simulated empty-channel run.
**→ Contact Brian via Slack DM confirming cron is live and skip logic
verified. Wait for Brian's OK before marking complete.**

### Final Delivery
**What:** Bot runs live for 5 consecutive weekdays. Brian reviews each
post for editorial quality. Prompt tuning if needed.
**→ Email Brian a report with screenshots of all 5 posts + pass/fail
on each acceptance criterion above. Brief is not COMPLETE until
Brian explicitly accepts.**
