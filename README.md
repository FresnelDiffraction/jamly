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

Recommended values for your current provider:

- `AI_BASE_URL=http://156.238.235.172:8317/v1`
- `AI_MODEL=gpt-5.4-mini`
- `AI_TRANSCRIPTION_MODEL=gpt-5.4-mini`

Use your own purchased API key as `AI_API_KEY`.

## Project layout

- `index.html` - page structure
- `styles.css` - desktop and mobile layout
- `script.js` - browser logic and local storage state
- `api/parse.js` - secure server-side availability parser
- `api/transcribe.js` - secure server-side speech-to-text proxy
