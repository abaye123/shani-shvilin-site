/**
 * Build-time access to release data. public/version.json is a placeholder in git and is
 * replaced by the deploy workflow (scripts/fetch-release.mjs) before `astro build`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apkPath,
  isRealRelease,
  normalizeVersionFile,
  resolveChannel,
  type Abi,
  type Channel,
  type ChannelInfo,
  type VersionFile,
} from "@shani/installer-core";

const root = process.cwd();

export function readVersionFile(): VersionFile {
  try {
    return normalizeVersionFile(JSON.parse(readFileSync(join(root, "public", "version.json"), "utf8")));
  } catch {
    return {};
  }
}

export const versionFile = readVersionFile();
export const stable = resolveChannel(versionFile, "stable");
export const beta = isRealRelease(versionFile.beta) ? { channel: "beta" as Channel, info: versionFile.beta } : null;
export const hasRelease = !!stable;

/** True when the APK file was actually fetched into public/ for this build. */
export function apkAvailable(channel: Channel, abi: Abi): boolean {
  return existsSync(join(root, "public", apkPath(channel, abi)));
}

export function installerAvailable(): boolean {
  const p = versionFile.installer?.path;
  return !!p && existsSync(join(root, "public", p));
}

export interface ReleaseEntry {
  tag: string;
  name: string;
  prerelease: boolean;
  publishedAt: string;
  body: string;
  url: string;
}

/** Release history for /changelog, written by scripts/fetch-release.mjs. */
export function readReleases(): ReleaseEntry[] {
  const p = join(root, "src", "generated", "releases.json");
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ReleaseEntry[];
  } catch {
    return [];
  }
}

const SITE_URL = process.env.SITE_URL ?? "https://shanishvilin.abaye.co";

/**
 * The download count, as the stats worker in front of the live site counts it (workers/stats):
 * downloads from the site and the PC installer, plus GitHub's count without the site's own
 * build fetches. Read at build time so the page has a number without script; the page then
 * refreshes it in the browser (components/DownloadCount.astro). Null when unreachable, so the
 * count is simply omitted.
 *
 * It used to be GitHub's raw count, which a build four times a day had inflated to three
 * times the real number, and which missed every download from the site.
 */
async function fetchApkDownloads(): Promise<number | null> {
  try {
    const res = await fetch(`${SITE_URL}/api/stats`, {
      headers: { "User-Agent": "shani-shvilin-site-build" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const n = ((await res.json()) as { downloads?: unknown }).downloads;
    return typeof n === "number" && n > 0 ? n : null;
  } catch (e) {
    console.warn(`download count unavailable: ${(e as Error).message}`);
    return null;
  }
}

export const apkDownloads = await fetchApkDownloads();

/** "143 הורדות", or null when there is no count to show. */
export function formatDownloads(n: number | null): string | null {
  if (!n) return null;
  return n === 1 ? "הורדה אחת" : `${n.toLocaleString("he-IL")} הורדות`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Jerusalem" });
}

export type { ChannelInfo };
