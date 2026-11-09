/**
 * shani-shvilin-stats: counts downloads and devices for shanishvilin.abaye.co.
 *
 * Runs on routes of the site's own hostname (see wrangler.toml), in front of
 * GitHub Pages. Nothing about the site changes: every request still goes to
 * the same path on the same domain, which matters because filters (NetFree)
 * have that domain and those paths approved. The worker passes each request
 * through untouched and, after the response is on its way, records it:
 *
 *   /apk/<channel>/ShaniShvilin-<abi>.apk    an app download. The app
 *                                            updating itself (User-Agent
 *                                            "ShaniShvilin/<version>") and
 *                                            the PC installer
 *                                            ("ShaniShvilinInstaller/...")
 *                                            are told apart from a download
 *                                            from the site. "?src=update" or
 *                                            "?src=installer" says the same.
 *   /downloads/ShaniShvilin-Installer.exe    a PC installer download.
 *   /update/<channel>.json                   an update check. From app
 *                                            0.2.16 it carries X-Install-Id,
 *                                            a random id per installation,
 *                                            stored here only as a hash.
 *
 * And it answers two paths of its own:
 *
 *   /api/stats        public: the download count the site shows.
 *   /api/stats/full   private, needs STATS_KEY: devices and downloads in
 *                     detail, as JSON, or as a page with ?format=html.
 *
 * If anything here fails, the request still reaches the site
 * (passThroughOnException), and recording happens after the response, so a
 * slow or broken database can never break a download.
 *
 * Bindings:
 *   DB          D1 database, schema in schema.sql
 *   STATS_KEY   secret, for /api/stats/full
 *   ID_SALT     secret, mixed into every hash of an id or address
 *   GITHUB_TOKEN  optional secret, raises the GitHub API limit for the cron
 *   RELEASES_REPO, GITHUB_EXCLUDE, GITHUB_CUTOVER_RELEASES,
 *   GITHUB_EXCLUDE_PER_RELEASE   variables, see wrangler.toml
 */

const APK_RE = /^\/apk\/(stable|beta)\/ShaniShvilin-([A-Za-z0-9_-]+)\.apk$/;
const INSTALLER_RE = /^\/downloads\/ShaniShvilin-Installer\.exe$/;
const UPDATE_RE = /^\/update\/(stable|beta)\.json$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = new Set(["update", "installer"]);

// Requests that are not people: crawlers, link previews, and the site's own
// build, which fetches the published files to compare them.
const NOT_PEOPLE_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|shani-shvilin-site-build/i;

const PUBLIC_CACHE_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/stats") return publicStats(request, env, ctx);
    if (url.pathname === "/api/stats/full") return fullStats(request, env, url);

    ctx.passThroughOnException();
    const response = await fetch(request);
    try {
      const event = classify(request, url, response);
      if (event) ctx.waitUntil(record(env, event, request).catch((e) => console.error("record", e)));
    } catch (e) {
      console.error("classify", e);
    }
    return response;
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshGithub(env));
  },
};

// ---------------------------------------------------------------------------
// Recording

/** What a request was, or null when it is not one we count. */
export function classify(request, url, response) {
  if (request.method !== "GET") return null;
  if (response.status !== 200 && response.status !== 206) return null;
  if (NOT_PEOPLE_RE.test(request.headers.get("user-agent") ?? "")) return null;
  // A resumed download is the same download; only its first piece counts.
  const range = request.headers.get("range");
  if (range && !/^bytes=0-/.test(range)) return null;

  let m = url.pathname.match(APK_RE);
  if (m) {
    return { type: "download", kind: "apk", channel: m[1], abi: m[2], source: sourceOf(request, url) };
  }
  if (INSTALLER_RE.test(url.pathname)) {
    return { type: "download", kind: "installer", channel: "", abi: "", source: "site" };
  }
  m = url.pathname.match(UPDATE_RE);
  if (m) return { type: "check", channel: m[1] };
  return null;
}

/** Who downloaded: the app updating itself, the PC installer, or a person on the site. */
export function sourceOf(request, url) {
  const src = url.searchParams.get("src");
  if (SOURCES.has(src)) return src;
  const ua = request.headers.get("user-agent") ?? "";
  if (ua.startsWith("ShaniShvilinInstaller/")) return "installer";
  if (ua.startsWith("ShaniShvilin/")) return "update";
  return "site";
}

async function record(env, event, request) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (event.type === "download") {
    await env.DB.prepare(
      `INSERT INTO downloads (day, kind, channel, abi, source, count) VALUES (?1, ?2, ?3, ?4, ?5, 1)
       ON CONFLICT (day, kind, channel, abi, source) DO UPDATE SET count = count + 1`,
    ).bind(day, event.kind, event.channel, event.abi, event.source).run();
    return;
  }

  const headers = request.headers;
  const background = headers.get("x-update-check") === "background" ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO checks (day, channel, background, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (day, channel, background) DO UPDATE SET count = count + 1`,
  ).bind(day, event.channel, background).run();

  const id = headers.get("x-install-id") ?? "";
  if (ID_RE.test(id)) {
    const key = await hash(env, "id:" + id.toLowerCase());
    const version = clean(headers.get("x-app-version"), 40);
    const sdk = Number.parseInt(headers.get("x-android-sdk") ?? "", 10);
    await env.DB.prepare(
      `INSERT INTO devices (id, first_seen, last_seen, version, channel, sdk, checks)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, 1)
       ON CONFLICT (id) DO UPDATE SET last_seen = ?2, version = ?3, channel = ?4, sdk = ?5,
         checks = checks + 1`,
    ).bind(key, now.toISOString(), version, event.channel, Number.isFinite(sdk) ? sdk : null).run();
  } else {
    // Versions before 0.2.16 send no id, and check only from the update
    // screen. Counted once per address and user agent per day, which is the
    // best that can be done without one; the address itself is not kept.
    const ip = headers.get("cf-connecting-ip") ?? "";
    const key = await hash(env, `legacy:${day}:${ip}:${headers.get("user-agent") ?? ""}`);
    await env.DB.prepare(`INSERT OR IGNORE INTO legacy_checks (day, key) VALUES (?1, ?2)`).bind(day, key).run();
  }
}

async function hash(env, text) {
  const data = new TextEncoder().encode((env.ID_SALT ?? "") + "|" + text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(value, max) {
  return String(value ?? "").replace(/[^\w.+-]/g, "").slice(0, max);
}

// ---------------------------------------------------------------------------
// GitHub

/**
 * The .apk download counts of every release, read hourly by the cron.
 *
 * The raw total overstates people: until the cutover the site's build
 * downloaded the newest APKs from GitHub on every run, four times a day, and
 * each of those counted. GITHUB_EXCLUDE is the estimate of those fetches up
 * to the cutover (release by release: build runs while it was the newest,
 * times the ABIs fetched). From then on the build takes the files from the
 * site when they are unchanged and goes to GitHub once per ABI per new
 * release, which is GITHUB_EXCLUDE_PER_RELEASE for every release after
 * GITHUB_CUTOVER_RELEASES.
 */
async function refreshGithub(env) {
  const repo = env.RELEASES_REPO || "abaye123/shani-shvilin-releases";
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "shani-shvilin-stats" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  let total = 0;
  let releases = 0;
  for (let page = 1; page < 20; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) {
      console.error("github", res.status);
      return;
    }
    const list = await res.json();
    for (const r of list) {
      if (r.draft) continue;
      releases++;
      for (const a of r.assets ?? []) if (a.name.endsWith(".apk")) total += a.download_count ?? 0;
    }
    if (list.length < 100) break;
  }
  const at = new Date().toISOString();
  await env.DB.batch([
    setMeta(env, "github_total", String(total)),
    setMeta(env, "github_releases", String(releases)),
    setMeta(env, "github_at", at),
  ]);
}

function setMeta(env, key, value) {
  return env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2`,
  ).bind(key, value);
}

async function github(env) {
  const rows = (await env.DB.prepare(`SELECT key, value FROM meta WHERE key LIKE 'github_%'`).all()).results;
  const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const total = Number(meta.github_total ?? 0);
  const releases = Number(meta.github_releases ?? 0);
  const exclude = Number(env.GITHUB_EXCLUDE ?? 0)
    + Math.max(0, releases - Number(env.GITHUB_CUTOVER_RELEASES ?? releases))
      * Number(env.GITHUB_EXCLUDE_PER_RELEASE ?? 0);
  return { total, releases, exclude, people: Math.max(0, total - exclude), at: meta.github_at ?? null };
}

// ---------------------------------------------------------------------------
// Answers

/**
 * The count the site shows: APKs downloaded from the site or through the PC
 * installer, plus what people downloaded from GitHub. Updates are left out,
 * so the number says how many times the app was fetched to be installed.
 */
async function publicStats(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL("/api/stats", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(count), 0) AS n FROM downloads WHERE kind = 'apk' AND source IN ('site', 'installer')`,
  ).first();
  const gh = await github(env);
  const body = JSON.stringify({ downloads: Number(row.n) + gh.people });
  const response = new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${PUBLIC_CACHE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function fullStats(request, env, url) {
  const given = url.searchParams.get("key") ?? (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.STATS_KEY || !(await sameSecret(env, given, env.STATS_KEY))) {
    return new Response("Not found", { status: 404 });
  }
  const data = await collect(env);
  if (url.searchParams.get("format") === "html") {
    return new Response(page(data), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  }
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Compares through a hash, so the time taken says nothing about the key. */
async function sameSecret(env, a, b) {
  return (await hash(env, "key:" + a)) === (await hash(env, "key:" + b));
}

async function collect(env) {
  const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();
  const all = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
  const one = async (sql, ...args) => await env.DB.prepare(sql).bind(...args).first();

  const active = {};
  for (const d of [1, 7, 30]) {
    active[`${d}d`] = Number((await one(`SELECT COUNT(*) AS n FROM devices WHERE last_seen >= ?1`, daysAgo(d))).n);
  }
  const since30 = daysAgo(30);
  const since60day = daysAgo(60).slice(0, 10);
  const downloadsBySource = await all(
    `SELECT kind, source, SUM(count) AS count FROM downloads GROUP BY kind, source ORDER BY kind, source`,
  );
  const gh = await github(env);
  const site = downloadsBySource
    .filter((r) => r.kind === "apk" && (r.source === "site" || r.source === "installer"))
    .reduce((s, r) => s + Number(r.count), 0);

  return {
    generatedAt: new Date().toISOString(),
    shownOnSite: site + gh.people,
    devices: {
      active,
      ever: Number((await one(`SELECT COUNT(*) AS n FROM devices`)).n),
      byVersion: await all(
        `SELECT version, COUNT(*) AS devices FROM devices WHERE last_seen >= ?1 GROUP BY version ORDER BY devices DESC`, since30),
      byChannel: await all(
        `SELECT channel, COUNT(*) AS devices FROM devices WHERE last_seen >= ?1 GROUP BY channel ORDER BY devices DESC`, since30),
      bySdk: await all(
        `SELECT sdk, COUNT(*) AS devices FROM devices WHERE last_seen >= ?1 GROUP BY sdk ORDER BY sdk DESC`, since30),
      newPerDay: await all(
        `SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS devices FROM devices WHERE first_seen >= ?1
         GROUP BY day ORDER BY day DESC`, since30),
      legacyPerDay: await all(
        `SELECT day, COUNT(*) AS devices FROM legacy_checks WHERE day >= ?1 GROUP BY day ORDER BY day DESC`,
        since60day),
    },
    checksPerDay: await all(
      `SELECT day, SUM(CASE WHEN background = 1 THEN count ELSE 0 END) AS background,
              SUM(CASE WHEN background = 0 THEN count ELSE 0 END) AS manual
       FROM checks WHERE day >= ?1 GROUP BY day ORDER BY day DESC`, since60day),
    downloads: {
      bySource: downloadsBySource,
      perDay: await all(
        `SELECT day, kind, source, SUM(count) AS count FROM downloads WHERE day >= ?1
         GROUP BY day, kind, source ORDER BY day DESC, kind, source`, since60day),
      github: gh,
    },
  };
}

// ---------------------------------------------------------------------------
// The private page

function page(d) {
  const esc = (v) => String(v ?? "-").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const table = (title, rows, cols) => `
    <section><h2>${esc(title)}</h2>${rows.length === 0 ? "<p class=muted>אין נתונים עדיין</p>" : `
      <table><thead><tr>${cols.map(([, h]) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map(([k]) => `<td>${esc(r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table>`}
    </section>`;
  const tile = (label, value) => `<div class=tile><div class=num>${esc(value)}</div><div class=label>${esc(label)}</div></div>`;
  const sourceName = { site: "האתר", installer: "המתקין למחשב", update: "עדכון באפליקציה" };
  const kindName = { apk: "אפליקציה", installer: "מתקין למחשב" };
  const named = (rows) => rows.map((r) => ({ ...r, kind: kindName[r.kind] ?? r.kind, source: sourceName[r.source] ?? r.source }));
  const gh = d.downloads.github;
  return `<!doctype html><html lang=he dir=rtl><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex>
<title>סטטיסטיקה - שני שבילין</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3df;--accent:#2f6f4f}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--muted:#9a9a94;--card:#1f1f1d;--line:#33332f;--accent:#7cc39c}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,"Segoe UI",Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}
.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.num{font-size:26px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}
.label{color:var(--muted);font-size:13px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:500}
</style></head><body><main>
<h1>שני שבילין: סטטיסטיקה</h1>
<p class=muted>עודכן ${esc(d.generatedAt.replace("T", " ").slice(0, 16))} UTC</p>
<div class=tiles>
${tile("מכשירים פעילים, 30 יום", d.devices.active["30d"])}
${tile("פעילים, 7 ימים", d.devices.active["7d"])}
${tile("פעילים, יום אחרון", d.devices.active["1d"])}
${tile("הורדות שמוצגות באתר", d.shownOnSite)}
</div>
<p class=muted>מכשיר פעיל: בדק עדכונים בתקופה הזו. נספרים רק מכשירים עם גרסה 0.2.16 ומעלה, שבודקות עדכונים פעם ביום. התקנה מחדש או איפוס נספרים כמכשיר חדש, והמכשיר הקודם יוצא מהספירה אחרי 30 יום.</p>
${table("לפי גרסה (30 יום)", d.devices.byVersion, [["version", "גרסה"], ["devices", "מכשירים"]])}
${table("לפי ערוץ (30 יום)", d.devices.byChannel, [["channel", "ערוץ"], ["devices", "מכשירים"]])}
${table("לפי גרסת אנדרואיד (30 יום)", d.devices.bySdk, [["sdk", "SDK"], ["devices", "מכשירים"]])}
${table("מכשירים חדשים לפי יום", d.devices.newPerDay, [["day", "יום"], ["devices", "מכשירים"]])}
${table("גרסאות ישנות (לפני 0.2.16), הערכה לפי יום", d.devices.legacyPerDay, [["day", "יום"], ["devices", "מכשירים"]])}
${table("בדיקות עדכון לפי יום", d.checksPerDay, [["day", "יום"], ["background", "אוטומטיות"], ["manual", "ידניות"]])}
${table("הורדות מהאתר, מאז שהמונה פועל", named(d.downloads.bySource), [["kind", "קובץ"], ["source", "מקור"], ["count", "הורדות"]])}
${table("הורדות לפי יום", named(d.downloads.perDay), [["day", "יום"], ["kind", "קובץ"], ["source", "מקור"], ["count", "הורדות"]])}
<section><h2>GitHub</h2>
<p>סך הכול ${esc(gh.total)} הורדות APK ב-${esc(gh.releases)} גרסאות. מתוכן ${esc(gh.exclude)} הן הערכה של הורדות בזמן בניית האתר, ולכן נספרות ${esc(gh.people)}.</p>
<p class=muted>נקרא מ-GitHub ${esc(gh.at ? gh.at.replace("T", " ").slice(0, 16) + " UTC" : "עדיין לא")}</p>
</section>
</main></body></html>`;
}
