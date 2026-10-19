/**
 * Installer operations on a connected device. UI agnostic: the wizard calls these and
 * renders their results.
 */
import type { AdbDevice, Fetcher } from "./backend.js";
import {
  ADMIN_COMPONENT,
  APP_PACKAGE,
  MAIN_ACTIVITY,
  MIN_APK_BYTES,
  REMOTE_APK_PATH,
  type Abi,
} from "./constants.js";
import { InstallerError, findKnownError } from "./errors.js";
import { inspectApk, looksLikeHtml, looksLikeZip, type ApkSummary } from "./apk.js";
import {
  hasPackage,
  parseAbiList,
  parseAccounts,
  parseDfAvailable,
  parseOwners,
  parsePackageInfo,
  parseUsers,
  type AccountInfo,
  type OwnerInfo,
  type PackageInfo,
  type UserInfo,
} from "./parsers.js";
import { apkPath, normalizeHex, normalizeVersionFile, type Channel, type ChannelInfo, type VersionFile } from "./version.js";

export type LogLevel = "info" | "cmd" | "out" | "warn" | "error";
export type Logger = (level: LogLevel, message: string) => void;

/** Runs a shell command with logging. */
export async function sh(dev: AdbDevice, log: Logger, command: string): Promise<string> {
  log("cmd", `$ ${command}`);
  const out = await dev.shell(command);
  const trimmed = out.trim();
  if (trimmed) log("out", trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n...` : trimmed);
  return out;
}

export interface DeviceInfo {
  sdk: number;
  release: string;
  manufacturer: string;
  brand: string;
  model: string;
  abis: string[];
}

export async function readDeviceInfo(dev: AdbDevice, log: Logger): Promise<DeviceInfo> {
  // One round trip; each value on its own line.
  const out = await sh(
    dev,
    log,
    "getprop ro.build.version.sdk; getprop ro.build.version.release; getprop ro.product.manufacturer; getprop ro.product.brand; getprop ro.product.model; getprop ro.product.cpu.abilist; getprop ro.product.cpu.abi",
  );
  const [sdk, release, manufacturer, brand, model, abilist, abi] = out.split(/\r?\n/).map((s) => s.trim());
  const abis = parseAbiList(abilist || abi || "");
  return {
    sdk: parseInt(sdk, 10) || 0,
    release: release ?? "",
    manufacturer: manufacturer ?? "",
    brand: brand ?? "",
    model: model ?? "",
    abis,
  };
}

export async function readOwners(dev: AdbDevice, log: Logger): Promise<OwnerInfo> {
  const out = await sh(dev, log, "dpm list-owners 2>&1");
  if (/admin=/.test(out) || /no owners/i.test(out)) return parseOwners(out);
  // Older Android versions have no list-owners.
  const dp = await dev.shell("dumpsys device_policy");
  log("cmd", "$ dumpsys device_policy");
  return parseOwners(dp);
}

export async function readAccounts(dev: AdbDevice, log: Logger): Promise<AccountInfo[]> {
  log("cmd", "$ dumpsys account");
  const out = await dev.shell("dumpsys account");
  const accounts = parseAccounts(out);
  log("out", `${accounts.length} accounts`);
  return accounts;
}

export async function readUsers(dev: AdbDevice, log: Logger): Promise<UserInfo[]> {
  return parseUsers(await sh(dev, log, "pm list-users"));
}

export async function readFreeBytes(dev: AdbDevice, log: Logger): Promise<number | null> {
  let n = parseDfAvailable(await sh(dev, log, "df -k /data 2>&1"));
  if (n === null) n = parseDfAvailable(await sh(dev, log, "df /data 2>&1"));
  return n;
}

export async function readPackage(dev: AdbDevice, log: Logger, pkg = APP_PACKAGE): Promise<PackageInfo> {
  const list = await sh(dev, log, `pm list packages ${pkg}`);
  if (!hasPackage(list, pkg)) return { installed: false, versionCode: null, versionName: null, signatureHashes: [] };
  log("cmd", `$ dumpsys package ${pkg}`);
  const info = parsePackageInfo(await dev.shell(`dumpsys package ${pkg}`), pkg);
  info.installed = true;
  log("out", `versionCode=${info.versionCode} versionName=${info.versionName} signatures=[${info.signatureHashes.join(",")}]`);
  return info;
}

export async function openAccountSettings(dev: AdbDevice, log: Logger): Promise<void> {
  await sh(dev, log, "am start -a android.settings.SYNC_SETTINGS");
}

/** Loads /version.json from the site. Returns an empty file (no releases) on any failure. */
export async function loadVersionFile(fetcher: Fetcher, siteBase: string, log: Logger): Promise<VersionFile> {
  try {
    const res = await fetcher(`${siteBase}/version.json?t=${Date.now()}`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return normalizeVersionFile(JSON.parse(new TextDecoder().decode(res.bytes)));
  } catch (e) {
    log("warn", `version.json: ${(e as Error).message}`);
    return {};
  }
}

export interface ApkCandidate {
  bytes: Uint8Array;
  summary: ApkSummary;
  source: "download" | "local";
  fileName: string;
  channel?: Channel;
  /** Release info the file was checked against, when known. */
  release?: ChannelInfo;
}

/**
 * Downloads the APK for an ABI and verifies it. Throws InstallerError("filter-blocked") when the
 * response is an HTML page or too small, which almost always means the filter blocked it.
 */
export async function downloadApk(
  fetcher: Fetcher,
  siteBase: string,
  channel: Channel,
  release: ChannelInfo,
  abi: Abi,
  log: Logger,
  onProgress?: (received: number, total: number) => void,
): Promise<ApkCandidate> {
  const url = `${siteBase}${apkPath(channel, abi)}`;
  log("info", `Downloading ${url}`);
  let res;
  try {
    res = await fetcher(url, onProgress);
  } catch (e) {
    log("error", `Download failed: ${(e as Error).message}`);
    throw new InstallerError("download-failed", (e as Error).message);
  }
  log("info", `HTTP ${res.status}, ${res.contentType || "no content-type"}, ${res.bytes.length} bytes`);
  if (/text\/html/i.test(res.contentType) || looksLikeHtml(res.bytes) || res.bytes.length < MIN_APK_BYTES || !looksLikeZip(res.bytes)) {
    throw new InstallerError("filter-blocked", `status ${res.status}, ${res.bytes.length} bytes`);
  }
  if (res.status !== 200) throw new InstallerError("download-failed", `HTTP ${res.status}`);
  const summary = await inspectApk(res.bytes);
  log("info", `sha256=${summary.sha256} package=${summary.packageName} versionCode=${summary.versionCode} cert=${summary.certSha256}`);
  const expected = release.apks[abi]?.sha256;
  if (expected && normalizeHex(expected) !== summary.sha256) {
    throw new InstallerError("sha-mismatch", `expected ${expected}, got ${summary.sha256}`);
  }
  verifyIdentity(summary, release);
  return { bytes: res.bytes, summary, source: "download", fileName: `ShaniShvilin-${abi}.apk`, channel, release };
}

/** Inspects a user-picked local APK file. Throws when it is not our app or is signed by someone else. */
export async function inspectLocalApk(bytes: Uint8Array, fileName: string, knownRelease: ChannelInfo | undefined, log: Logger): Promise<ApkCandidate> {
  if (!looksLikeZip(bytes)) throw new InstallerError("not-apk");
  const summary = await inspectApk(bytes);
  log("info", `Local file ${fileName}: sha256=${summary.sha256} package=${summary.packageName} versionCode=${summary.versionCode} cert=${summary.certSha256}`);
  verifyIdentity(summary, knownRelease);
  return { bytes, summary, source: "local", fileName, release: knownRelease };
}

function verifyIdentity(summary: ApkSummary, release: ChannelInfo | undefined): void {
  if (summary.packageName !== APP_PACKAGE) {
    throw new InstallerError("wrong-package", `package ${summary.packageName}`);
  }
  const cert = release?.certSha256;
  if (cert && summary.certSha256 && normalizeHex(cert) !== summary.certSha256) {
    throw new InstallerError("wrong-cert", `expected ${cert}, got ${summary.certSha256}`);
  }
}

/** Pushes the APK, installs it with `pm install -r` and verifies the installed versionCode. */
export async function installApk(
  dev: AdbDevice,
  apk: ApkCandidate,
  log: Logger,
  onProgress?: (sent: number, total: number) => void,
): Promise<PackageInfo> {
  log("info", `Pushing ${apk.bytes.length} bytes to ${REMOTE_APK_PATH}`);
  await dev.push(apk.bytes, REMOTE_APK_PATH, onProgress);
  const out = await sh(dev, log, `pm install -r ${REMOTE_APK_PATH} 2>&1`);
  if (!/\bSuccess\b/.test(out)) {
    const known = findKnownError(out);
    throw new InstallerError(known?.id ?? "install-failed", out.trim());
  }
  const info = await readPackage(dev, log);
  if (!info.installed) throw new InstallerError("install-failed", "package not found after install");
  if (apk.summary.versionCode !== null && info.versionCode !== null && info.versionCode !== apk.summary.versionCode) {
    throw new InstallerError("install-failed", `installed versionCode ${info.versionCode}, expected ${apk.summary.versionCode}`);
  }
  return info;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sets our app as device owner, retrying while the admin component is not registered yet. */
export async function setDeviceOwner(dev: AdbDevice, log: Logger, attempts = 5): Promise<void> {
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    last = await sh(dev, log, `dpm set-device-owner ${ADMIN_COMPONENT} 2>&1`);
    if (/Success/i.test(last) && !/Exception|Error/i.test(last)) return;
    // Some builds print the "Active admin set" line only.
    if (/Active admin (?:set|component)/i.test(last) && !/Exception/i.test(last)) return;
    if (/Unknown admin/i.test(last) && i < attempts) {
      log("warn", `Admin component not registered yet, retry ${i}/${attempts - 1}`);
      await sleep(2000);
      continue;
    }
    break;
  }
  // Confirm: some devices print warnings but still succeed.
  const owners = await readOwners(dev, log);
  if (owners.deviceOwner === APP_PACKAGE) return;
  const known = findKnownError(last);
  throw new InstallerError(known?.id ?? "owner-failed", last.trim());
}

export async function launchApp(dev: AdbDevice, log: Logger): Promise<void> {
  await sh(dev, log, `am start -n ${MAIN_ACTIVITY} 2>&1`);
}

export async function cleanupTemp(dev: AdbDevice, log: Logger): Promise<void> {
  try {
    await sh(dev, log, `rm -f ${REMOTE_APK_PATH}`);
  } catch {
    // Best effort.
  }
}

export async function uninstallApp(dev: AdbDevice, log: Logger): Promise<boolean> {
  const out = await sh(dev, log, `pm uninstall ${APP_PACKAGE} 2>&1`);
  return /Success/.test(out);
}

/** Simple promise-based wait that can be aborted. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}
