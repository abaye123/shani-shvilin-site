# stats worker

`shani-shvilin-stats` counts downloads and devices for `shanishvilin.abaye.co`. It runs on
routes of the site's own hostname, in front of GitHub Pages, and passes every request through
unchanged: the APK, installer and update file addresses stay exactly what network filters
(NetFree) approved. See the comment at the top of `worker.js` for what is counted and how.

| Path | What |
|---|---|
| `/apk/*`, `/downloads/*` | counted as downloads, by file and source (site, PC installer, app update) |
| `/update/*` | counted as update checks; devices by a hash of the app's `X-Install-Id` |
| `/api/stats` | public, `{ "downloads": n }`, what the site shows |
| `/api/stats/full?key=...` | private, JSON; add `&format=html` for a page |

## Setup (once)

```sh
cd workers/stats
npx wrangler d1 create shani-shvilin-stats      # put the id in wrangler.toml
npx wrangler d1 execute shani-shvilin-stats --remote --file=schema.sql
npx wrangler secret put STATS_KEY               # any long random string
npx wrangler secret put ID_SALT                 # another one; never change it, or every device counts again
npx wrangler deploy
```

`GITHUB_TOKEN` is optional (`npx wrangler secret put GITHUB_TOKEN`, read-only public access is
enough); without it the hourly cron uses the anonymous GitHub API limit, which is plenty.

## Deploying a change

```sh
cd workers/stats && npx wrangler deploy
```

If the worker fails, requests still reach the site (`passThroughOnException`), and recording
happens after the response is sent.
