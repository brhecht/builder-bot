---
name: "comms"
description: "Send messages between Brian and Nico via Email, Slack DM, or Brain Inbox ping. Use when the user says 'email', 'DM', 'ping', 'send to', 'message', 'notify', 'draft' or 'tell' followed by Nico or Brian."
---

# Comms Skill

Route messages between Brian and Nico through the right channel. This skill works for **both users** — it detects who the current user is from the account email in the session context (the `userEmail` line Claude is given about the signed-in account), then routes to the other person accordingly.

Three channels: Email (longer, structured — auto-sends within ~5 minutes), DM (short Slack direct message — sends immediately), and Ping (Brain Inbox notification, posts via the "Nico Brain Inbox" Slack app — sends immediately).

## Rule 1: Send by default. The word "draft" means send.

Brian often says "draft" when he means send. Set by Brian on Oct 9 and again on Oct 21, 2026, after a dinner SOP email to Nico sat unsent for about four hours and Nico acted without it.

- **Every message is sent** unless Brian clearly asks to hold it. Phrases that mean hold: "draft for my approval", "show me before you send", "let me review it first", "don't send yet".
- The bare word "draft", and "write", "explain to him", "tell him", "let him know" all mean send.
- If you honestly cannot tell whether he wants it held, ask ONE line before creating anything: "Send now, or hold for your review?" Do not guess toward holding.

## Rule 2: Never downgrade silently

If the route you chose is blocked or fails (the permissions check refuses the send, the auto-send token is rejected, the network call errors), do NOT fall back to leaving an unsent draft and mention it at the bottom of a long reply.

1. Try the next route that still delivers. For email, send the same content as a Slack DM to the recipient (the handoff-notify API accepts up to 3000 characters; if the email is longer, DM the key ask and say the full email is coming).
2. If no route can deliver, the FIRST line of your reply says: "NOT SENT: <what>, <why>." Then say what Brian can do in one step.
3. Brian is often away from his laptop (driving, traveling). An undelivered message is reported immediately, in the first line, not as a note at the end.

## Rule 3: Confirm delivery for email

After creating an auto-send email, schedule a check about 10 minutes later (send_later). The check looks in Gmail Sent for the message. If it is still a draft, apply Rule 2 (DM Nico the content or the key ask) and tell Brian in the first line. Brian does not want to be the one who remembers to check.

## Rule 4: Tag every Claude-written message with {Claude}

Set by Brian on Oct 30, 2026. He wants to know at a glance whether a message from Nico, or one going to Nico, was written by Claude. This applies in both directions, whoever the sender is.

- **DM and Ping:** start the `summary` with `{Claude} ` (curly braces, the word Claude, one space). Example: `{Claude} Deploy is done, PR is ready.`
- **Email:** start the `subject` with `{Claude} ` and make the first line of the body `{Claude}`. The auto-send token stays at the END of the subject, so it does not conflict. Example subject: `{Claude} Weekly digest is ready [[CLAUDE-AUTO-SEND-V1]]`.
- **Hold mode:** keep the tag. Brian deletes it if he rewrites the message and sends it as his own.
- **Rule 2 fallbacks:** when an email is re-sent as a DM, the DM carries the tag too.
- **Experiment:** this rule lives only in `comms`. Messages sent outside this skill (a direct Gmail reply, a direct Slack post) will not carry the tag. Note any untagged Claude message you notice, to measure the gap.

## Sender Detection

**Always check the signed-in account's email in the session context first.** This tells you who is using the skill right now.

- If the email is `brhnyc1970@gmail.com` → sender is Brian, default recipient is Nico
- If the email is `nico@thenewbuilder.ai`, `nmejiawork@gmail.com`, or the legacy `nico@humbleconviction.com` → sender is Nico, default recipient is Brian

Never send email to the legacy HC address. Its only remaining use is the `recipient` field in DM and Ping requests (see `brainInboxEmail` in the Contact Registry).

The user can override the recipient explicitly (e.g., Brian saying "email myself" or Nico saying "ping Nico" for a self-reminder).

## Channel Selection

Pick the channel based on what the user says, or infer from content length and intent:

| Signal | Channel |
|--------|---------|
| User says "email" | Email |
| User says "DM" or "message" | DM |
| User says "ping", "notify", "send to Brain Inbox" | Ping |
| Content is >500 chars or has structure (headers, lists, instructions) | Suggest Email |
| Content is a quick status update, question, or "hey check this" | DM |
| Content is task-oriented ("deploy is done", "PR is ready", "check this issue") | Ping |

If ambiguous, default to DM for short content and Email for long content. Always tell the user which channel you chose and why.

## Contact Registry

```
Brian:
  email: brhnyc1970@gmail.com
  slackId: U096WPV71KK   # HC Slack workspace

Nico:
  email: nico@thenewbuilder.ai          # use for Email channel
  brainInboxEmail: nico@humbleconviction.com  # use ONLY as `recipient` in DM/Ping bodies, until Nico confirms Brain Inbox accepts the new address
  altEmail: nmejiawork@gmail.com
  slackId: U09GRAMET4H   # HC Slack workspace, not TNB Slack
```

## Channel: Email

The Gmail MCP only exposes draft creation (not direct send), but the comms infrastructure includes a **Gmail Apps Script auto-sender** that watches for drafts flagged with a specific token and sends them automatically. So "email mode" in this skill has two sub-modes:

1. **Send mode (default)** — email is delivered within ~5 min, no manual send step required
2. **Hold mode** — only when Brian clearly asks to hold (see Rule 1); email sits in Drafts for him to review and send manually

### Default: Send mode

Use the Gmail MCP's draft-creation tool to create a draft in the **current user's** Gmail, and flag it with the auto-send token in the **subject line**.

**Tool name:** The draft-creation tool is currently exposed as `create_draft` (previously `gmail_create_draft`). If the expected name doesn't resolve, use `ToolSearch` with `select:` or a keyword query (e.g., `gmail draft`) to find the currently registered tool.

**The token:** Append this exact string to the END of the `subject`, after a single space:

```
[[CLAUDE-AUTO-SEND-V1]]
```

Example `subject` (with the Rule 4 tag):
```
{Claude} Weekly digest is ready [[CLAUDE-AUTO-SEND-V1]]
```

**Why the subject, not the body (important — do NOT revert to a body marker):** Gmail strips HTML comments (`<!-- ... -->`) out of the body when it saves a draft, so the old body marker silently vanished and nothing ever auto-sent. The subject line is the one field Gmail never rewrites. The Apps Script (runs in Brian's Gmail every 5 minutes) finds the token in the subject, **strips it back out**, and sends — so the recipient's delivered subject is clean and the token is never visible. No marker in the `htmlBody` is needed anymore. See `bhub/apps-script/claude-auto-send.gs` for the script; note the live script must be pasted into Apps Script manually — editing the repo file alone does not update the running script.

**If the draft call is refused** (on Oct 21, 2026 the permissions check blocked the token form): apply Rule 2. Do not retry the same call, and do not leave a tokenless draft as the outcome.

After creating the draft, tell the user: "Sent to [name] — will deliver within ~5 minutes via auto-send pipeline." Then apply Rule 3.

### Hold mode (only when Brian clearly asks to hold)

Use this only for the hold phrases in Rule 1. In this mode:

- Create the draft **without** the subject token
- Open your reply with: "HELD, not sent. Draft is in your Gmail Drafts — review and hit send when ready."

### Routing based on sender

- **Brian sending to Nico:** Draft in Brian's Gmail → To: nico@thenewbuilder.ai
- **Nico sending to Brian:** Draft in Nico's Gmail → To: brhnyc1970@gmail.com
- **Self-send:** Draft to sender's own email (useful for notes-to-self, cross-device references, instructions to pull up later)

Note: The Gmail MCP tool drafts in whichever Gmail account is connected to the current user's Cowork session. Each user must have Gmail connected in their own Cowork setup. The Apps Script auto-sender is currently deployed in Brian's Gmail only — Nico's drafts won't auto-send until/unless the script is deployed in his account too.

### Tone

Write the email in a professional but casual tone matching Brian and Nico's working relationship. No corporate fluff. Clear, direct, actionable.

### Plain language when the recipient is Brian (MANDATORY)

Brian is non-technical — AI-conversant, but not an engineer. Any message to Brian (email, DM, or ping, **from either side**) must be understandable to a smart non-engineer. The binding factor is the recipient, not the author — this applies to Nico's outgoing messages too.

- **No naked jargon.** If a technical term is unavoidable, explain it in plain words the first time. Not "gate it with Next middleware on /projects/songwriters-lab/*" — instead "add a 'check if you're logged in' step at the app's web address, without moving the app."
- **Lead with the decision or the ask**, not the mechanism. Brian needs to know what to decide and why it matters to him, not how it's wired.
- **Never hand Brian a raw technical fork to adjudicate.** If a decision is needed, give him the plain-English choice plus your recommendation. If it's a technical-method call Nico can make himself, Nico makes it — it never reaches Brian (see the pm skill's Decision Map).
- **The test:** could Brian's smart, non-technical friend read this and know what's being asked? If not, rewrite it.

## Channel: DM (Slack Direct Message)

Send a short Slack DM **as the sender, from the sender's own Slack account**, through the Composio Slack connection (HC Community workspace). The message appears in the normal Brian <-> Nicolás DM conversation, exactly as if the sender typed it, with the `{Claude}` tag at the front.

Changed Oct 31, 2026. Until then DMs went through the Brain Inbox handoff-notify API with `dmOnly`, which posted as the "Nico Brain Inbox" app, not as the sender. Brian never saw those in his conversation with Nico. Do not use handoff-notify for DMs anymore; it is still the route for Pings.

**Steps:**

1. Call `COMPOSIO_SEARCH_TOOLS` with use case "send a direct message to a slack user" and `known_fields` set to the recipient's Slack ID (from the Contact Registry). Confirm the `slack` toolkit shows an ACTIVE connection whose `team` is **HC Community** (`T096WPV6QAD`) and whose `user_id` is the sender's own ID. If the active account is a different workspace, stop and apply Rule 2.
2. Call `SLACK_OPEN_DM` with `users` set to the recipient's Slack ID. Use the returned `channel.id` (starts with `D`). `already_open=true` is success.
3. Call `SLACK_SEND_MESSAGE` with `channel` set to that `D...` id and `text` set to `{Claude} <the message content>`.
4. Confirm the response has `ok: true` and a `ts`. Tell the user: "DM sent to [name] on Slack."

**Character guidance:** Keep DMs under ~500 chars. If the content is longer, use email.

**If the Composio Slack tools are missing or the connection is not active:** apply Rule 2. The fallback that still delivers is the Ping channel (which posts via the Nico Brain Inbox app). Use it, keep the `{Claude}` tag, and say in the first line of your reply that the DM went out through Brain Inbox instead of as a normal message.

## Channel: Ping (Brain Inbox)

Send a task-oriented notification that lands in the recipient's triage queue. This is the standard handoff-notify path — writes to Firestore (if recipient has a UID) and posts to the appropriate Slack channel/DM.

**Endpoint:** `https://brain-inbox-six.vercel.app/api/handoff-notify`

**Method:** POST with `Content-Type: text/plain` (avoids CORS preflight). Do NOT set `dmOnly`.

**Body (JSON stringified):**
```json
{
  "project": "<project name>",
  "summary": "{Claude} <notification content — include context, what happened, what's needed>",
  "recipient": "<recipient email; for Nico use brainInboxEmail>",
  "recipientSlackId": "<recipient slack ID>"
}
```

**Routing:**
- **To Nico:** Writes to Brain Inbox Firestore + posts to Brain Inbox Slack channel
- **To Brian:** Sends Slack DM directly (no Firestore). Brain Inbox is Nico's internal tool; Brian has no Brain Inbox account.

**Execution:** Use the Network Resilience Protocol below. Pings send immediately with no approval step. Tell the user: "Pinged [name] via Brain Inbox."

## Network Resilience Protocol (Ping channel)

The session's own workspace usually cannot reach arbitrary websites (outbound traffic goes through an allowlist), so a direct request from it often fails. Because the handoff-notify API must be reachable to send Pings, this skill uses a tiered fallback to ensure delivery regardless of network state.

**Try these in order. Move to the next tier only when the current one fails.**

### Tier 1: Chrome JavaScript execution (preferred — always has network)

The user's browser runs on their Mac, which always has internet. Use the `mcp__claude-in-chrome__javascript_tool` to execute the fetch from any open browser tab. This is the most reliable path.

If the Chrome tools are deferred, load them in one call: `ToolSearch` with `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__javascript_tool`. Then get available tabs via `mcp__claude-in-chrome__tabs_context_mcp` and execute on any tab:

```javascript
// Execute via mcp__claude-in-chrome__javascript_tool
fetch('https://brain-inbox-six.vercel.app/api/handoff-notify', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({
    project: '<project>',
    summary: '{Claude} <message>',
    recipient: '<email>',
    recipientSlackId: '<slackId>',
  })
}).then(r => r.json()).then(d => JSON.stringify(d))
```

If Chrome tools are connected, this will work every time. If Chrome returns an error about not being connected or no tabs available, move to Tier 2.

### Tier 2: Shell request (linked computer first, then the workspace)

If the session is linked to the user's computer and a `mcp__remote-devices__device_bash` tool is present, run the request there first: the Mac has normal internet. Otherwise try the session's own Bash (this worked from the Cowork workspace on Oct 21, 2026). Either way:

```bash
node -e "
fetch('https://brain-inbox-six.vercel.app/api/handoff-notify', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({
    project: '<project>',
    summary: '{Claude} <message>',
    recipient: '<email>',
    recipientSlackId: '<slackId>'
  })
}).then(r => r.text()).then(console.log).catch(e => { console.error(e.message); process.exit(1) })
"
```

If this fails with DNS/network errors (`EAI_AGAIN`, `ENOTFOUND`, `ETIMEDOUT`) or a proxy refusal (403), move to Tier 3. Do not retry the same request through another command; every route from the workspace shell uses the same allowlist.

### Tier 3: User paste (last resort)

Only reach this if both Chrome and every shell route are unavailable — a rare double-fault. Give the user a single-line JS snippet to paste into any browser console (Option+Cmd+J on Mac), with brief instructions:

1. Tell them: "Chrome extension is disconnected and I can't reach the internet from here right now. Paste this into any browser console (Option+Cmd+J):"
2. Provide the fetch one-liner (single line, no line breaks)
3. Tell them they'll see a JSON response with `ok: true` when it works

This should almost never happen — it requires Chrome disconnected AND no working shell route at the same time. Open the reply with "NOT SENT" per Rule 2.

## Content Resolution

The user may reference content by context rather than writing it out. Resolve these references:

- **"Email the device setup instructions to Nico"** → Pull from the handoff skill's Device Setup Protocol section, format for email
- **"DM Brian about the deploy"** → Compose from current session context, send to Brian
- **"Ping Brian that the deploy is done"** → Short notification with project name and what deployed
- **"Email Nico the content calendar handoff"** → Read the latest Content Calendar handoff file, format as email body or reference
- **"Tell [name] [anything from conversation]"** → Compose from current conversation context, route to named recipient

If the reference is ambiguous, ask the user to clarify what content they mean.

## Setup Requirements

Each user needs the following in their Cowork session for full functionality:

1. **Gmail MCP connected** — required for email drafts. Each user connects their own Gmail account.
1b. **Composio Slack connected to HC Community** — required for the DM channel. Each user connects their own Slack account (Brian's is connected as of Oct 23, 2026; Nico's is unverified).
2. **Skill enabled on their Claude account** — skills sync to every session automatically; no file to install.
3. **Signed in with a known email** — sender detection reads the signed-in account's email, so it must be one listed under Sender Detection.

## What This Skill Does NOT Do

- Does not create B Things tasks (that's the `--notes` Slack flow, separate system)
- Does not handle group messages or Slack channels
- Does not handle recipients outside Brian and Nico (extend the contact registry to add more)