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

const RELEASES_REPO = process.env.RELEASES_REPO ?? "abaye123/shani-shvilin-releases";

/**
 * Total download count of every .apk asset across all releases, read from the GitHub API at
 * build time. Null when the API is unreachable or rate limited, so the count is simply omitted.
 */
async function fetchApkDownloads(): Promise<number | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "shani-shvilin-site-build",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    let total = 0;
    for (let page = 1; ; page++) {
      const url = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100&page=${page}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as { assets?: { name: string; download_count: number }[] }[];
      for (const r of list) {
        for (const a of r.assets ?? []) if (a.name.endsWith(".apk")) total += a.download_count ?? 0;
      }
      if (list.length < 100) return total;
    }
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
