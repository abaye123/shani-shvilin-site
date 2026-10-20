#!/usr/bin/env node
// Fetches the app catalog into the site before `astro build`, for the /apps page.
//
//   catalog.json + policies.json (catalog repo, main branch)
//     -> src/generated/catalog.json   (what the page lists)
//   Play's icon for every PLAY entry, from its public page
//     -> public/app-icons/<package>.png  (served from this site: Play's image
//        host is one more address a filtered user may not reach)
//
// An icon that cannot be fetched costs that icon only; the page draws a letter.
// Env: CATALOG_REPO to override the repository, FETCH_STRICT=1 to fail when the
// catalog itself cannot be read.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CATALOG_REPO = process.env.CATALOG_REPO ?? "abaye123/shani-shvilin-catalog";
const STRICT = process.env.FETCH_STRICT === "1";
const RAW = `https://raw.githubusercontent.com/${CATALOG_REPO}/main`;
const ICONS = join("public", "app-icons");
const OUT = join("src", "generated", "catalog.json");
const UA = { "User-Agent": "Mozilla/5.0 (shani-shvilin-site-build)", "Accept-Language": "he-IL,he;q=0.9" };

async function json(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** The icon URL Play's public page advertises, or null. */
async function playIconUrl(pkg) {
  const res = await fetch(`https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=iw&gl=il`, {
    headers: UA,
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<meta property="og:image" content="([^"]+)"/);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

async function saveIcon(pkg, url) {
  // Play's image host sizes on request; 128px is plenty for a 48px tile on a sharp screen.
  const sized = url.replace(/=[swh]\d+.*$/, "") + "=s128";
  const res = await fetch(sized, { headers: UA });
  if (!res.ok) throw new Error(`icon HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(join(ICONS, `${pkg}.png`), buf);
}

/** What the tunnel does with this app's traffic, in a word the page can label. */
function networkLabel(entry, policy) {
  if (!entry.grantsNetworkAccess) return "offline";
  if (!policy) return "open";
  if (policy.type !== "Fixed") return "by-mode";
  switch (policy.networkPolicy?.mode) {
    case "FULL_OPEN":
      return "open";
    case "WHITELIST":
      return "whitelist";
    case "BLACKLIST":
      return "blacklist";
    case "OFFLINE":
    case "LOCAL_ONLY":
      return "offline";
    default:
      return "by-mode";
  }
}

async function main() {
  let catalog, policies;
  try {
    [catalog, policies] = await Promise.all([json(`${RAW}/catalog.json`), json(`${RAW}/policies.json`)]);
  } catch (e) {
    console.error(`catalog: ${e.message}`);
    if (STRICT) process.exit(1);
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify({ generatedAt: null, apps: [] }, null, 2) + "\n");
    return;
  }

  const byPackage = new Map((policies.policies ?? []).map((p) => [p.packageName, p]));
  await rm(ICONS, { recursive: true, force: true });
  await mkdir(ICONS, { recursive: true });

  const apps = [];
  for (const e of catalog.entries ?? []) {
    if (!e.availableInStore) continue;
    let icon = null;
    if (e.source?.type === "PLAY") {
      try {
        const url = await playIconUrl(e.source.id ?? e.packageName);
        if (url) {
          await saveIcon(e.packageName, url);
          icon = `/app-icons/${e.packageName}.png`;
        }
      } catch (err) {
        console.warn(`WARN icon ${e.packageName}: ${err.message}`);
      }
    }
    apps.push({
      packageName: e.packageName,
      nameHe: e.displayName?.he ?? e.displayName?.en ?? e.packageName,
      nameEn: e.displayName?.en ?? "",
      category: e.category,
      minUserMode: e.minUserMode ?? "MOST_OPEN",
      sha256: [e.sha256, ...(e.additionalSha256 ?? [])].filter(Boolean).map((s) => s.toLowerCase()),
      source: e.source?.type ?? null,
      sourceId: e.source?.id ?? null,
      recommended: !!e.flags?.isRecommendedInStore,
      needsAcceptance: !!e.flags?.requiresExplicitAcceptance,
      excludedFromReducedRisk: !!e.flags?.excludedFromReducedRisk,
      network: networkLabel(e, byPackage.get(e.packageName)),
      icon,
    });
    console.log(`${e.packageName}: ${icon ? "icon" : "no icon"}`);
  }
  apps.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.nameHe.localeCompare(b.nameHe, "he"));

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: catalog.generatedAt ?? null, apps }, null, 2) + "\n");
  console.log(`catalog: ${apps.length} apps`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
