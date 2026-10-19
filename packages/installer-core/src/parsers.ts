/** Parsers for the text output of on-device shell commands. Pure functions, unit-testable. */

export interface OwnerInfo {
  /** Package of the device owner, if any. */
  deviceOwner: string | null;
  /** Full component as printed, if any. */
  component: string | null;
  profileOwners: string[];
}

/**
 * Parses `dpm list-owners` (Android 10+) or `dumpsys device_policy` (older).
 *
 * list-owners:  `User 0: admin=com.x/.Receiver,DeviceOwner,Affiliated`
 * device_policy: `Device Owner: \n admin=ComponentInfo{com.x/com.x.Receiver}\n name=...\n package=com.x`
 */
export function parseOwners(text: string): OwnerInfo {
  const out: OwnerInfo = { deviceOwner: null, component: null, profileOwners: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/admin=([\w.]+)\/([\w.$]+)(.*)$/);
    if (m && !line.includes("ComponentInfo")) {
      if (/DeviceOwner/i.test(m[3])) {
        out.deviceOwner = m[1];
        out.component = `${m[1]}/${m[2]}`;
      } else if (/ProfileOwner/i.test(m[3])) {
        out.profileOwners.push(m[1]);
      }
    }
  }
  if (!out.deviceOwner) {
    const dm = text.match(/Device Owner:?\s*\{?[\s\S]*?admin=ComponentInfo\{([\w.]+)\/([\w.$]+)\}/i);
    if (dm) {
      out.deviceOwner = dm[1];
      out.component = `${dm[1]}/${dm[2]}`;
    }
  }
  return out;
}

export interface AccountInfo {
  name: string;
  type: string;
}

/** Parses `dumpsys account`: lines like `Account {name=a@b.com, type=com.google}`. */
export function parseAccounts(text: string): AccountInfo[] {
  const seen = new Set<string>();
  const out: AccountInfo[] = [];
  // Only the "Accounts:" listing, not history sections that also mention accounts.
  for (const m of text.matchAll(/^\s*Account \{name=(.*?), type=([^}]+)\}/gm)) {
    const key = `${m[1]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: m[1], type: m[2].trim() });
  }
  return out;
}

/** Masks an account name: "moshe@gmail.com" -> "m***e@gmail.com". */
export function maskAccount(name: string): string {
  const at = name.indexOf("@");
  const local = at >= 0 ? name.slice(0, at) : name;
  const domain = at >= 0 ? name.slice(at) : "";
  if (local.length <= 2) return `${local[0] ?? ""}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

const ACCOUNT_TYPE_NAMES: Record<string, string> = {
  "com.google": "Google",
  "com.osp.app.signin": "Samsung",
  "com.samsung.android.mobileservice": "Samsung",
  "com.xiaomi": "Xiaomi (Mi)",
  "com.whatsapp": "WhatsApp",
  "com.whatsapp.w4b": "WhatsApp Business",
  "org.telegram.messenger": "Telegram",
  "com.microsoft.workaccount": "Microsoft",
  "com.huawei.hwid": "Huawei",
};

export function accountTypeName(type: string): string {
  return ACCOUNT_TYPE_NAMES[type] ?? type;
}

export interface UserInfo {
  id: number;
  name: string;
  flags: string;
}

/** Parses `pm list-users`: lines like `UserInfo{0:Owner:c13} running`. */
export function parseUsers(text: string): UserInfo[] {
  const out: UserInfo[] = [];
  for (const m of text.matchAll(/UserInfo\{(\d+):([^:}]*):?([0-9a-fA-F]*)\}/g)) {
    out.push({ id: parseInt(m[1], 10), name: m[2], flags: m[3] });
  }
  return out;
}

/**
 * Parses `df` output for /data and returns the available bytes, or null.
 * Handles toybox (`1K-blocks Used Available`) and old toolbox (`Size Used Free Blksize` with units).
 */
export function parseDfAvailable(text: string): number | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = lines[0].toLowerCase();
  const kBlocks = header.includes("1k-blocks");
  const cols = header.split(/\s+/);
  let availIdx = cols.findIndex((c) => c === "available" || c === "avail" || c === "free");
  if (availIdx < 0) availIdx = 3;
  for (const line of lines.slice(1)) {
    if (!/\/data\b/.test(line) && lines.length > 2) continue;
    const parts = line.trim().split(/\s+/);
    // A long filesystem name may wrap the line; take columns from the end in that case.
    const v = parts.length >= cols.length ? parts[availIdx] : parts[availIdx - (cols.length - parts.length)];
    if (!v) continue;
    const unit = v.match(/^([\d.]+)([KMGT]?)/i);
    if (!unit) continue;
    const n = parseFloat(unit[1]);
    const mult: Record<string, number> = { "": kBlocks ? 1024 : 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
    return Math.round(n * (mult[unit[2].toUpperCase()] ?? 1));
  }
  return null;
}

export interface PackageInfo {
  installed: boolean;
  versionCode: number | null;
  versionName: string | null;
  /** Hex hash codes from `signatures:[...]` (Java Arrays.hashCode of each cert). */
  signatureHashes: string[];
}

/** Parses `dumpsys package <pkg>` for one package. */
export function parsePackageInfo(text: string, pkg: string): PackageInfo {
  const out: PackageInfo = { installed: false, versionCode: null, versionName: null, signatureHashes: [] };
  const start = text.indexOf(`Package [${pkg}]`);
  if (start < 0) return out;
  // Limit to this package's block, up to the next "Package [" header.
  const next = text.indexOf("Package [", start + 9);
  const block = text.slice(start, next > 0 ? next : undefined);
  out.installed = true;
  const vc = block.match(/versionCode=(\d+)/);
  if (vc) out.versionCode = parseInt(vc[1], 10);
  const vn = block.match(/versionName=(\S+)/);
  if (vn) out.versionName = vn[1];
  const sig = block.match(/signatures=PackageSignatures\{[^}]*?\[([0-9a-fA-F, ]+)\]/);
  if (sig) out.signatureHashes = sig[1].split(/[, ]+/).filter(Boolean).map((s) => s.toLowerCase());
  return out;
}

/** True when `pm list packages <pkg>` lists exactly this package (the filter is a prefix match). */
export function hasPackage(listOutput: string, pkg: string): boolean {
  return listOutput.split(/\r?\n/).some((l) => l.trim() === `package:${pkg}`);
}

export function parseAbiList(text: string): string[] {
  return text.trim().split(/[,\s]+/).filter(Boolean);
}
