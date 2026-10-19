import { SUPPORTED_ABIS, type Abi } from "./constants.js";

/** One APK of a release, as listed in the site's /version.json. */
export interface ApkInfo {
  path: string;
  sha256: string;
  size: number;
}

/** Per-channel release info. */
export interface ChannelInfo {
  versionName: string;
  versionCode: number;
  tag: string;
  publishedAt: string;
  notes?: string;
  certSha256?: string;
  apks: Partial<Record<Abi, ApkInfo>>;
  universalUrl?: string;
}

export interface InstallerInfo {
  version: string;
  path: string;
  size?: number;
  sha256?: string;
}

export interface VersionFile {
  stable?: ChannelInfo | null;
  beta?: ChannelInfo | null;
  /** Latest PC installer version, used by the PC installer to suggest an update. */
  installerVersion?: string;
  installer?: InstallerInfo | null;
}

export type Channel = "stable" | "beta";

/** True when the channel describes a real published release (not the placeholder). */
export function isRealRelease(ch: ChannelInfo | null | undefined): ch is ChannelInfo {
  return !!ch && typeof ch.versionName === "string" && ch.versionName !== "0.0.0" && ch.versionCode > 0;
}

/**
 * Picks the release to use for a channel. While there is no stable release the beta files
 * are served on the stable paths too, so stable falls back to beta (and vice versa).
 */
export function resolveChannel(
  v: VersionFile | null | undefined,
  wanted: Channel,
): { channel: Channel; info: ChannelInfo } | null {
  if (!v) return null;
  const want = v[wanted];
  if (isRealRelease(want)) return { channel: wanted, info: want };
  const other: Channel = wanted === "stable" ? "beta" : "stable";
  const alt = v[other];
  if (isRealRelease(alt)) return { channel: other, info: alt };
  return null;
}

/** Accepts both the per-channel layout and a flat single-release layout of version.json. */
export function normalizeVersionFile(raw: unknown): VersionFile {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  if ("stable" in r || "beta" in r) return r as VersionFile;
  if ("versionName" in r) {
    const flat = r as unknown as ChannelInfo & { channel?: Channel; installerVersion?: string };
    const ch: Channel = flat.channel === "beta" ? "beta" : "stable";
    return { [ch]: flat, installerVersion: flat.installerVersion } as VersionFile;
  }
  return r as VersionFile;
}

/**
 * Site-relative path of the APK for a channel and ABI. The stable paths may hold the beta
 * build while there is no stable release, which is why the channel of the path is the one
 * asked for, not the one the info came from.
 */
export function apkPath(channel: Channel, abi: Abi): string {
  return `/apk/${channel}/ShaniShvilin-${abi}.apk`;
}

/** Picks the best APK for a device ABI list (ro.product.cpu.abilist). */
export function pickAbi(abilist: string[]): Abi | null {
  for (const abi of abilist) {
    if ((SUPPORTED_ABIS as readonly string[]).includes(abi)) return abi as Abi;
  }
  return null;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Hex SHA-256 to url-safe base64 without padding, as the QR provisioning extra requires. */
export function hexToUrlSafeBase64(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  let bin = "";
  for (let i = 0; i < clean.length; i += 2) bin += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s.replace(/:/g, ""));
}

export function normalizeHex(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** Formats a hex digest as colon separated upper-case pairs, like apksigner prints it. */
export function fingerprint(hex: string): string {
  return normalizeHex(hex).toUpperCase().match(/.{2}/g)?.join(":") ?? hex;
}

/** Compares dotted version strings like "1.2.3"; returns >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
