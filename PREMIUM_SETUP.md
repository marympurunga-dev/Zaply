# Zanply Premium: what to set up

## Vercel environment variables
| Name | Needed for |
|---|---|
| PAYSTACK_SECRET_KEY | Taking payments (already used) |
| PAYSTACK_CALLBACK | Your app link, e.g. https://zanply.app/ (Paystack sends people back here with ?reference=...) |
| CRON_SECRET | Any long random text. Protects the scheduled-message / renewal job |
| ANTHROPIC_API_KEY | Translate, Catch me up, Ask Zanply AI |
| OPENAI_API_KEY or GROQ_API_KEY | Voice-to-text (Transcribe) |
| AI_MODEL (optional) | Defaults to claude-haiku-5-5 |

## Paystack dashboard
Settings > API Keys & Webhooks > Webhook URL: https://YOUR-DOMAIN/api/chat
(The server never trusts the webhook body. It asks Paystack if the reference was really paid.)

## Cron (scheduled messages + auto-renewal)
Call GET https://YOUR-DOMAIN/api/chat?cron=1 with header  Authorization: Bearer <CRON_SECRET>  every minute.
- Vercel Pro: add to vercel.json  {"crons":[{"path":"/api/chat?cron=1","schedule":"* * * * *"}]}
- Vercel Hobby only allows daily crons. Use a free pinger (e.g. cron-job.org) with the header above.
Without a cron, scheduled messages still go out while anyone is using the app, but renewals will not run.

## Test list
1. Subscribe with a test card, come back to the app: Premium unlocks by itself.
2. Schedule a message 2 minutes ahead, close the app: it still arrives.
3. Turn on Stealth, check the other phone sees no Online / Typing / blue ticks.
4. Long-press a voice note > Transcribe. Long-press a text > Translate.
