# Keeping the tracker running

`npm run tracker` is a plain foreground process: if it stops, or the computer restarts, the site is down until
someone starts it again. A supervisor fixes that.

## Health check

`GET /api/health` is public and returns `200 {"ok":true}` only while the database answers a query, otherwise
`503 {"ok":false,"error":"database_unavailable"}`. Point a supervisor, hosting platform or uptime monitor at it.

```bash
curl -fsS http://localhost:3001/api/health
```

## On a Mac (launchd)

`com.delta.tracker.plist` starts the tracker at login and restarts it if it crashes. Edit the two
`/ABSOLUTE/PATH/TO/...` placeholders, then:

```bash
cp deploy/com.delta.tracker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.delta.tracker.plist
```

Stop and remove it with `launchctl unload ~/Library/LaunchAgents/com.delta.tracker.plist`.

If macOS blocks a background process from reading `~/Downloads` or `~/Documents` (it did once: `EPERM` on the web
files), move the project somewhere outside those folders, for example `~/code/delta`.

## On a server or a hosting platform

Use the platform's own restart policy (systemd `Restart=always`, a container `restart: always`, and so on) and set
its health check to `/api/health`. See `docs/hosting.md`.
