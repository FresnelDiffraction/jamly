# Jamly

Jamly is a small band rehearsal availability web app.

## What it does

- Lets band members submit weekly availability with free-form text.
- Lets members hold-to-record voice input, then transcribes it on the server.
- Summarizes each member's parsed result instead of showing the raw message.
- Shows full-group overlap and best partial overlap by one-hour slots.
- Includes a simple checklist for rehearsals, performances, and other band events.

## Deploy on Vercel

Set these environment variables in Vercel:

- `AI_BASE_URL`
- `AI_API_KEY`
- `AI_MODEL`
- `AI_TRANSCRIPTION_MODEL`
- `KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL`
- `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_TOKEN`

Recommended values for your current provider:

- `AI_BASE_URL=http://156.238.235.172:8317/v1`
- `AI_MODEL=gpt-5.4-mini`
- `AI_TRANSCRIPTION_MODEL=gpt-5.4-mini`

Use your own purchased API key as `AI_API_KEY`.

## Shared sync across phone and desktop

Phone and desktop sync now uses a shared KV store through `/api/state`.

If you want all devices to see the same submissions and todo list, add one of these pairs in Vercel:

- `KV_REST_API_URL` + `KV_REST_API_TOKEN`
- or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

Optional:

- `JAMLY_STATE_KEY=jamly:shared-state`

## Project layout

- `index.html` - page structure
- `styles.css` - desktop and mobile layout
- `script.js` - browser logic, shared sync, and overlap formatting
- `api/parse.js` - secure server-side availability parser
- `api/state.js` - shared phone/desktop state sync
- `api/transcribe.js` - secure server-side speech-to-text proxy
