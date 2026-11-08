# Hosting plan

Status: **a plan, nothing built yet.** Today the tracker runs on your own computer and listens on
`localhost` only. This is what it would take to put it on the internet for other people, in the order
to do it. Prices and plan names below are from general knowledge and change often: check them before
choosing.

## What is being hosted

One Node process (`src/main.ts`) serving the API and the web page, and one SQLite file (`tracker.db`,
plus a folder of backups). No build step, no separate database server. Only this is deployed. The old
Delta (`server.js`, `lib/`, `scripts/`) is **not** deployed: its endpoints have no login and some call
paid APIs (decision 43).

What that shape means for where it can live:

- **It needs a disk that survives restarts.** SQLite is a file. Serverless and "ephemeral filesystem"
  hosts (Vercel, Netlify, Cloudflare Workers, a plain container with no volume) lose it.
- **Exactly one running copy.** SQLite has one writer, so don't run two instances against one file.
  Fine: this app's load is tiny.
- **Small machine.** 256 to 512 MB of memory is plenty. Signing in uses about 32 MB briefly (scrypt) and
  blocks the process for roughly 0.1 s, which is fine for tens of people, not thousands.

## Where to run it

| Option | Good for | Cost (rough) | Catch |
|---|---|---|---|
| **A. Platform with a volume** (Fly.io, Railway, Render) | Least upkeep: https, deploys from git, a persistent volume | a few dollars a month | Check the volume is persistent and single-instance on the plan you pick; free tiers change |
| **B. Small VPS** (Hetzner, DigitalOcean, Vultr) + Caddy | Cheapest and most to learn: you run Linux, Caddy gets https automatically | about 4 to 6 dollars a month | You patch the server and set up the service yourself |
| **C. Your own computer + Cloudflare Tunnel** | A trial with a few friends, free, https included | free | Only up while your computer is awake and online |

**Recommendation:** try **C** with 3 to 5 friends to learn what they trip over (this also needs the
phase 1 work below), then move to **A**. Moving later is easy because everything is one process and one
file (copy the file, set the same environment variables). Choose **B** instead if you want to learn
servers, or to keep cost near the floor.

Also needed: a **domain name** (about 10 to 15 dollars a year), pointed at the host.

## The work, in order

### Phase 0, now (local only)
- Create your account at http://localhost:3001 so the existing data is yours before anything is exposed.
  Whoever signs up first on a fresh server takes the data, so never expose a server with unclaimed data.

### Phase 1, a private beta with a few people you know
Code to write first:

1. **https and proxy awareness.** Behind the host's proxy: `trust proxy`, `TRACKER_SECURE_COOKIES=1`, an
   HSTS header, and read `PORT` (hosts set it) in addition to `TRACKER_PORT`.
2. **Limits by address.** Wrong-password limiting is per email today and in memory. Add per-IP limits on
   sign-in and sign-up. Also move the 8 MB LinkedIn upload parser behind sign-in (it currently runs before it).
3. **Who can sign up.** After you claim your account set `TRACKER_ALLOW_SIGNUP=false`, then add **invite
   codes** (you make a code, a friend uses it once) so strangers can't create accounts but friends can.
4. **A stopgap password reset.** Until email exists: `npm run set-password -- <email>`, which you run on
   the server for a friend who is locked out. (A real reset by email is phase 2.)
5. **Off-machine backups.** Backups currently sit next to the database, so losing the disk loses both.
   Either continuous copying of the file to object storage (the tool for this is Litestream) or a
   scheduled verified snapshot uploaded to cheap storage (Backblaze B2, Cloudflare R2, S3). Encrypt them,
   and **practice a restore**: a backup you have never restored is a hope.
6. **A deploy routine.** CI already runs the tests. Add: on a green `main`, take a backup, deploy, and let
   the app run its migrations on start (it already backs up before migrating). Migrations only go forward,
   so rolling back code after a migration means restoring the pre-deploy backup.
7. **Monitoring.** A free uptime check on `/api/health`, and logs that never contain passwords or emails.

### Phase 2, anyone can use it
- **Email**: verification of addresses and a real password reset (needs an email service such as Resend,
  Postmark or SES, and SPF/DKIM records on your domain). Planned after you give the login wireframe.
- **Privacy**: a short privacy policy and terms. The app stores personal details about other people
  (your contacts, imported LinkedIn connections), so say what is kept, where, and how to delete it. Delete
  account and export already exist. Mention that backups hold deleted data until they age out. This is
  general guidance, not legal advice; if the app goes beyond friends, get it checked (Canadian privacy law
  applies to you).
- **Capacity**: if sign-ins ever queue up, hash passwords off the main thread.
- **Dependencies**: a regular `npm audit` and Node updates.

## Decisions I need from you
1. **Who is it for?** Just you, you plus a few friends (phase 1), or anyone (phase 2)?
2. **Budget ceiling** per month, and whether a domain name is fine.
3. **Platform:** C then A (my suggestion), A directly, or B.
4. **Do you want a name for it?** It decides the domain.
5. **The old Delta:** keep parked (current), or decide to delete or fold it in before hosting.

## Security checklist before any public address
- [ ] Your account is claimed; signups closed or invite-only
- [ ] https everywhere; Secure cookies; HSTS
- [ ] Per-IP limits on sign-in and sign-up
- [ ] Only `src/main.ts` is deployed (nothing from the old Delta)
- [ ] Off-machine, encrypted backups and a tested restore
- [ ] A way to reset a forgotten password
- [ ] Uptime check and logs free of secrets
