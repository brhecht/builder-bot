# Brain Intake — setup (Humble Conviction workspace)

**Qué es:** pipeline Slack → Claude → approval → Brain Inbox. Nico pega material crudo (burst de Brian, notas de reunión, transcript, idea dump) en su DM con el bot **Brain Intake** del workspace **Humble Conviction**; Claude lo desmenuza en items estructurados (prompt destilado de translate-brian); Nico revisa (`ok` / `edit <nota>` / `skip`); el aprobador recibe la propuesta comprimida en inglés y con una reacción ✅ todos los items caen en el Brain Inbox de Nico.

**Dónde corre:** el endpoint vive en este repo (`/api/intake`, deploy de builder-bot en Vercel) pero atiende a una **app de Slack separada instalada en el workspace HC** — los crons del recap (workspace TNB) no se tocan y usan su propio token. `GET /api/intake` = health check.

## Estado actual

- ✅ Código deployado e inerte hasta conectar la app de Slack (sin signing secret → 503 para eventos no-test).
- 🧪 **TRIAL MODE:** mientras `INTAKE_APPROVER_ID` no esté seteado, los mensajes de aprobación le llegan al propio Nico (probar el flujo completo sin molestar a Brian). Para ir live: `INTAKE_APPROVER_ID` = user ID de Brian en el workspace HC.
- ⚠️ **Ir live con Brian requiere su OK previo** (regla Jun 8: proponer antes de meterle flujos nuevos). Draft del one-tap en el HANDOFF.

## Setup (una vez, ~5 min)

1. **Crear la app:** [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From a manifest* → workspace **Humble Conviction** → pegar el JSON de abajo → *Create*. (La URL de eventos se verifica sola — el endpoint ya responde el challenge.)
2. **Instalar:** *Install to Workspace* → Allow.
3. **Copiar 2 valores a Vercel** (proyecto `builder-bot` → Settings → Environment Variables → Production):
   - *Basic Information → Signing Secret* → `INTAKE_SLACK_SIGNING_SECRET`
   - *OAuth & Permissions → Bot User OAuth Token* (`xoxb-…`) → `INTAKE_SLACK_BOT_TOKEN`
4. **Redeploy** (Deployments → ⋯ → Redeploy) para hornear los envs.
5. **Bind del submitter:** mándale cualquier DM al bot — te responde con tu user ID del workspace HC → ponlo en `INTAKE_SUBMITTER_ID` → redeploy. (Hoy está seteado al ID de TNB para los tests E2E; cámbialo por el que te diga el bot.)
6. **Probar:** pégale un burst de Brian → desmenuce → `ok` → te llega la propuesta (trial) → reacciona ✅ → items en Brain Inbox.
7. **Ir live (después del OK de Brian):** `INTAKE_APPROVER_ID` = user ID de Brian en HC → redeploy.

## Manifest (pegar tal cual)

```json
{
  "display_information": {
    "name": "Brain Intake",
    "description": "Paste raw material, get structured work items, one-tap approval, straight to Brain Inbox.",
    "background_color": "#1F3A5F"
  },
  "features": {
    "bot_user": { "display_name": "brain-intake", "always_online": true },
    "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false }
  },
  "oauth_config": {
    "scopes": { "bot": ["chat:write", "im:history", "im:write", "reactions:read", "users:read"] }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://builder-bot-nine.vercel.app/api/intake",
      "bot_events": ["message.im", "reaction_added"]
    },
    "interactivity": { "is_enabled": false },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

## Env vars (Vercel · production)

| Var | Qué | Estado |
|---|---|---|
| `INTAKE_SLACK_SIGNING_SECRET` | Signing secret de la app HC (verifica eventos) | ⬜ Nico (paso 3) |
| `INTAKE_SLACK_BOT_TOKEN` | Bot token de la app HC (enviar DMs) | ⬜ Nico (paso 3) |
| `INTAKE_SUBMITTER_ID` | User ID de Nico en el workspace HC | 🔶 seteado al ID TNB (tests) — cambiar en paso 5 |
| `INTAKE_APPROVER_ID` | User ID de Brian en HC (unset = 🧪 trial → Nico) | ⬜ tras OK de Brian |
| `BRAIN_INBOX_API_KEY` | Key del API de Brain Inbox | ✅ seteado |
| `BRAIN_INBOX_URL` | Override del endpoint (default brain-inbox-six) | opcional |

## Comandos del DM

`<cualquier paste>` desmenuzar · `ok` mandar a aprobación · `edit <nota>` rehacer · `skip` descartar · `status` estado · `help` ayuda

## Debug

- Health: `GET https://builder-bot-nine.vercel.app/api/intake` (muestra qué está configurado, modo trial y workspace).
- Último error runtime sin entrar a logs: key `intake_debug_last` en el KV (Upstash) del proyecto.
- Simular eventos sin Slack: `POST /api/intake?test=true&secret=<CRON_SECRET>` con el JSON del evento (misma convención test del repo).
