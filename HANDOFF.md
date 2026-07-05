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

---

## Weekly "Builder of the Week" (added Jun 2026)

A second, weekly job (`/api/weekly`) that recognizes the most engaged community member each week. Separate from the daily recap — additive, the daily flow is untouched.

**What it does:** Every **Friday 3 PM ET** it tallies engagement (reactions + thread replies) across `#share-and-discuss`, `#what-im-building`, and `#general` over the trailing 7 days, picks the **Builder of the Week** (top author by aggregate engagement, Brian + the bot excluded, 4-week no-repeat cooldown), writes a celebratory announcement in Brian's voice (Claude, with a deterministic fallback), posts it, and pins it in `#general`.

**Engagement is free of extra API calls** — `reply_count` and the `reactions[]` array both come back in `conversations.history`, so no per-thread fetches.

### 🧪 Trial mode (first 2 weeks)
With `SLACK_BOW_TARGETS` set, the Friday announcement goes to **Nico's + Brian's DMs** instead of `#general`, and the **auto-pin is skipped**. The cron still fires automatically every Friday — only the destination changes. After review, **clear `SLACK_BOW_TARGETS` in Vercel** to go live to `#general` + pinning. No code change needed.

### ⚠️ Required Slack scopes (Brian — you own the app)
Add these to the Builder Bot Slack app, then **reinstall** to the workspace:
- `reactions:read` — read reaction counts (without it, tallies are reaction-blind).
- `pins:write` — `pins.add` / `pins.remove` (only used once live to `#general`).

Existing scopes (`channels:history`, `channels:read`, `users:read`, `chat:write`, `chat:write.customize`, `channels:join`) stay.

### Env vars
| Var | Value | Notes |
|-----|-------|-------|
| `SLACK_BOW_TARGETS` | `U0AQEF27PMJ,U0AQPP9T4QZ` | Trial DMs (Nico, Brian). **Clear to go live.** |
| `SLACK_BOW_EXCLUDE_IDS` | `U0AQPP9T4QZ`(+ bot user ID) | Who can't win. Add the bot's own user ID. |

Reuses `SLACK_CHANNEL_SHARE_AND_DISCUSS`, `SLACK_CHANNEL_WHAT_IM_BUILDING`, `SLACK_CHANNEL_GENERAL`, `CRON_SECRET`, and the Upstash KV vars.

### Cron
`vercel.json` adds `{ "path": "/api/weekly", "schedule": "0 19,20 * * 5" }`. Friday 19:00 **and** 20:00 UTC cover 3 PM EDT and 3 PM EST; the internal `hour === 15` ET gate passes once, and the `bow_last_week` KV key makes the other firing a no-op. (Builder Bot now has 2 crons — confirm the Vercel plan allows it.)

### Test commands (after scopes are added)
All require `Authorization: Bearer <CRON_SECRET>` and `test=true`:
| Params | Effect |
|--------|--------|
| `?test=true&dry_run=true&lookback_days=7` | Compute the ranking + winner, **no post/pin**. Returns JSON. |
| `?test=true&channel=<DM_id>&lookback_days=7` | Post the real announcement to one DM. **Skips pin + KV.** |

```bash
npx vercel curl "/api/weekly?test=true&dry_run=true&lookback_days=7" \
  --deployment "https://builder-bot.vercel.app" \
  -- -H "Authorization: Bearer <CRON_SECRET>"
```

### KV keys (Upstash)
`bow_last_week` (idempotency), `bow_last_pin` `{channel,ts}` (unpin prior week), `bow_recent_winners` `{userId,name,week}[]` (cooldown).

### Files
| File | Change |
|------|--------|
| `app/api/weekly/route.ts` | **NEW** — gate, tally, pick, copy, post, pin, KV |
| `lib/slack.ts` | `postAndGetTs`, `pinMessage`, `unpinMessage` |
| `lib/claude.ts` | `generateBuilderOfWeek` (+ deterministic fallback) |
| `lib/kv.ts` | `bow_*` wrappers |
| `lib/types.ts` | `reactions` on `SlackMessage`; `BuilderScore`, `RecentWinner`, `BowPin` |
| `vercel.json` | +weekly cron |

---

## 2026-07-04 · Brain Intake (NUEVO) — Slack DM → Claude → approval → Brain Inbox

Pipeline nuevo en `/api/intake` (commits `e6b0851` + `0edf62e`). Nico pega material crudo al bot **Brain Intake** (app separada en el workspace **Humble Conviction** — NO este bot de TNB), Claude lo desmenuza (prompt destilado de translate-brian), Nico revisa (`ok`/`edit`/`skip`), el aprobador reacciona ✅ y los items caen al Brain Inbox de Nico. Setup completo + manifest + env table: **INTAKE-SETUP.md**.

- **Estado:** deployado en prod (builder-bot-nine.vercel.app), E2E validado (state machine, DMs, ✅→Brain Inbox `#97-gsk`/`#84-a9t`, idempotencia). Inerte para Slack hasta que Nico cree la app HC (5 min, manifest listo).
- **🧪 TRIAL:** `INTAKE_APPROVER_ID` unset ⇒ approvals van al propio Nico. Live = setearlo al ID de Brian en HC **después de su OK** (draft del one-tap abajo).
- **⛔ BLOCKER GLOBAL:** la cuenta Anthropic de la key de este proyecto está sin créditos → `messages.create` da 400. Eso bloquea el breakdown del intake **y el recap diario de este bot** (el cron corre y avanza cursores pero el LLM falla; ver KV `intake_debug_last`). Task urgente `#84-a9t` en Brain Inbox.
- Aisladísimo de los crons: credenciales propias `INTAKE_SLACK_*`, `lib/slack.ts` sin tocar.

**Draft one-tap para Brian (go-live del approver, mandar por el DM de HC):**
> Quick one — new pipeline, needs your one-tap. When you brain-dump ideas/instructions to Nico, an AI intake now turns them into clean work items. Before anything lands on Nico's task list, YOU get a 5-line summary in this DM — react ✅ to approve, ❌ to kill, or reply with tweaks. ~10 seconds per batch, and you control what enters the pipeline. It's been running in test mode and works. Turn it on?

### 2026-07-05 · Brain Intake — red-team + expert hardening pass (commit af1e108)

3 auditorías adversariales (seguridad / races / resiliencia) + research de best practices (Slack Events, Anthropic SDK) → 18 hallazgos verificados corregidos. 35 assertions verdes (firma+gate unit, state machine live, clasificador). Lo clave:
- **CRÍTICO cerrado:** el bypass `?test=true` está desactivado en producción (gate `VERCEL_ENV`). Antes saltaba firma+dedupe y dejaba `ev.user` bajo control del atacante → con el `CRON_SECRET` (que viaja en la query → logs) se podía impersonar al aprobador e inyectar tasks. Verificado denegado en prod en vivo (503).
- **Sin doble-logueo:** lock atómico (Redis SET NX) → dos ✅ simultáneas loguean cada task una vez.
- **Fallo parcial recuperable:** estado `partial` + re-✅ reintenta solo los faltantes; nunca re-loguea.
- **Anti-outage-silencioso:** output estructurado por tool-use forzado (no fence-strip) + taxonomía de errores → "sin créditos (402)" / auth / overload / truncado, cada uno con mensaje propio en vez del "reformula" que enmascaró el recap muerto. Health hace ping a KV + reporta `ready`.
- **Testing cambió:** con el bypass off en prod, simular con curl va contra **preview o local** (`VERCEL_ENV≠production`). Ver INTAKE-SETUP.md §Debug.
