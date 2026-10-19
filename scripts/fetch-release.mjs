#!/usr/bin/env node
// Fetches the published release data into public/ before `astro build`. Runs in the Pages
// workflow; APKs and update files are never committed to this repository.
//
//   update/version.json, update/stable.json, update/beta.json  (releases repo, main branch)
//     -> public/version.json, public/update/stable.json, public/update/beta.json
//   APKs of the latest stable release and the latest pre-release
//     -> public/apk/stable/ShaniShvilin-<abi>.apk, public/apk/beta/ShaniShvilin-<abi>.apk
//      (no stable release yet: the beta files are served on the stable paths too)
//   release list -> src/generated/releases.json (for /changelog)
//   latest PC installer (this repo's releases, tag installer-v*) -> public/downloads/
//
// Env: GITHUB_TOKEN (optional, raises API limits), FETCH_STRICT=1 (fail on any problem),
//      RELEASES_REPO / SITE_REPO to override the repositories.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RELEASES_REPO = process.env.RELEASES_REPO ?? "abaye123/shani-shvilin-releases";
const SITE_REPO = process.env.SITE_REPO ?? "abaye123/shani-shvilin-site";
const STRICT = process.env.FETCH_STRICT === "1";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const ABIS = ["arm64-v8a", "armeabi-v7a"];
const PUBLIC = "public";
const INSTALLER_PATH = "/downloads/ShaniShvilin-Installer.exe";

const problems = [];
const warn = (msg) => {
  problems.push(msg);
  console.warn(`WARN ${msg}`);
};
const log = (msg) => console.log(msg);

function headers(api) {
  const h = { "User-Agent": "shani-shvilin-site-build" };
  if (api) h.Accept = "application/vnd.github+json";
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function get(url, { api = false, optional = false } = {}) {
  const res = await fetch(url, { headers: headers(api), redirect: "follow" });
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function writeOut(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchUpdateFiles() {
  const raw = `https://raw.githubusercontent.com/${RELEASES_REPO}/main/update`;
  let version = null;
  for (const name of ["version.json", "stable.json", "beta.json"]) {
    try {
      const res = await get(`${raw}/${name}`, { optional: true });
      if (!res) {
        log(`update/${name}: not published yet`);
        continue;
      }
      const text = await res.text();
      const json = JSON.parse(text); // validate before publishing
      if (name === "version.json") version = json;
      else await writeOut(join(PUBLIC, "update", name), text);
      log(`update/${name}: ok`);
    } catch (e) {
      warn(`update/${name}: ${e.message}`);
    }
  }
  return version;
}

async function listReleases(repo) {
  const res = await get(`https://api.github.com/repos/${repo}/releases?per_page=50`, { api: true, optional: true });
  if (!res) return [];
  const list = await res.json();
  return list.filter((r) => !r.draft).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

async function downloadAsset(asset) {
  const res = await get(asset.browser_download_url);
  return Buffer.from(await res.arrayBuffer());
}

/** Parses a `sha256sum` style file: "<hex>  <name>". */
function parseSums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

async function fetchChannelApks(release, channel, versionInfo) {
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
  const sums = sumsAsset ? parseSums((await downloadAsset(sumsAsset)).toString("utf8")) : new Map();
  if (!sumsAsset) warn(`${release.tag_name}: no SHA256SUMS asset`);
  const info = versionInfo?.[channel];
  if (info && info.tag && info.tag !== release.tag_name) {
    warn(`version.json ${channel} is ${info.tag} but the latest ${channel} release is ${release.tag_name}`);
  }
  const files = {};
  for (const abi of ABIS) {
    const asset = release.assets.find((a) => a.name.endsWith(`-${abi}.apk`));
    if (!asset) {
      warn(`${release.tag_name}: no ${abi} APK`);
      continue;
    }
    const buf = await downloadAsset(asset);
    const hex = sha256(buf);
    const expected = sums.get(asset.name) ?? (info?.tag === release.tag_name ? info?.apks?.[abi]?.sha256 : undefined);
    if (expected && expected.toLowerCase() !== hex) throw new Error(`${asset.name}: SHA-256 mismatch (${hex} != ${expected})`);
    const out = join(PUBLIC, "apk", channel, `ShaniShvilin-${abi}.apk`);
    await writeOut(out, buf);
    files[abi] = { path: `/apk/${channel}/ShaniShvilin-${abi}.apk`, sha256: hex, size: buf.length };
    log(`${channel}/${abi}: ${asset.name} (${buf.length} bytes)`);
  }
  return files;
}

async function fetchInstaller(versionFile) {
  const releases = (await listReleases(SITE_REPO)).filter((r) => r.tag_name.startsWith("installer-v"));
  for (const r of releases) {
    const asset = r.assets.find((a) => /ShaniShvilin-Installer.*\.exe$/i.test(a.name));
    if (!asset) continue;
    const buf = await downloadAsset(asset);
    await writeOut(join(PUBLIC, INSTALLER_PATH), buf);
    const version = r.tag_name.replace(/^installer-v/, "");
    versionFile.installerVersion = version;
    versionFile.installer = { version, path: INSTALLER_PATH, size: buf.length, sha256: sha256(buf) };
    log(`installer: ${asset.name} ${version}`);
    return;
  }
  log("installer: no release yet");
}

async function main() {
  await rm(join(PUBLIC, "apk"), { recursive: true, force: true });
  await rm(join(PUBLIC, "downloads"), { recursive: true, force: true });

  const remoteVersion = await fetchUpdateFiles();
  const versionFile = remoteVersion ?? JSON.parse(await readFile(join(PUBLIC, "version.json"), "utf8"));

  let releases = [];
  try {
    releases = await listReleases(RELEASES_REPO);
  } catch (e) {
    warn(`release list: ${e.message}`);
  }
  const latestStable = releases.find((r) => !r.prerelease);
  const latestBeta = releases.find((r) => r.prerelease);

  if (latestBeta) {
    const files = await fetchChannelApks(latestBeta, "beta", versionFile);
    if (versionFile.beta?.apks) Object.assign(versionFile.beta.apks, files);
  }
  if (latestStable) {
    const files = await fetchChannelApks(latestStable, "stable", versionFile);
    if (versionFile.stable?.apks) Object.assign(versionFile.stable.apks, files);
  } else if (latestBeta) {
    // No stable release yet: serve the beta on the stable paths so stable links and the QR work.
    for (const abi of ABIS) {
      const from = join(PUBLIC, "apk", "beta", `ShaniShvilin-${abi}.apk`);
      const to = join(PUBLIC, "apk", "stable", `ShaniShvilin-${abi}.apk`);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to).catch(() => warn(`stable/${abi}: no beta file to copy`));
    }
    log("stable: no stable release, serving the beta on the stable paths");
  }

  try {
    await fetchInstaller(versionFile);
  } catch (e) {
    warn(`installer: ${e.message}`);
  }

  await writeOut(join(PUBLIC, "version.json"), JSON.stringify(versionFile, null, 2) + "\n");
  await writeOut(
    join("src", "generated", "releases.json"),
    JSON.stringify(
      releases.map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        prerelease: r.prerelease,
        publishedAt: r.published_at,
        body: r.body ?? "",
        url: r.html_url,
      })),
      null,
      2,
    ) + "\n",
  );

  if (problems.length && STRICT) {
    console.error(`${problems.length} problem(s), failing because FETCH_STRICT=1`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
