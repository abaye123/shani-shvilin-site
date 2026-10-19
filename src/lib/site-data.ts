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

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Jerusalem" });
}

export type { ChannelInfo };
