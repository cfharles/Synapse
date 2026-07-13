# Google Calendar setup (one time, ~5 minutes)

Synapse books events directly in your Google Calendar. It needs an OAuth client
of your own (free, and your data never touches anyone else's server).

1. Go to https://console.cloud.google.com and create a project (name: Synapse).
2. **APIs & Services → Library** → search "Google Calendar API" → Enable.
3. **APIs & Services → OAuth consent screen** → External → fill the two required
   fields → add your own email as a Test user. No verification needed.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type: **Desktop app**.
5. Copy the Client ID and Client Secret into your `.env`:

```
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
```

6. Authorize once (`.env` is loaded automatically):

```bash
node src/index.js auth-gcal
```

A browser tab opens, you approve, done. The token is saved as `token-gcal.json`
(gitignored, chmod 600) and refreshes itself from then on.

Try it:

```bash
node src/index.js "coffee with sam tomorrow 10am"
node src/index.js agenda
```

Scope used: `calendar.events` only (create/read events). Synapse cannot touch
your other Google data.
