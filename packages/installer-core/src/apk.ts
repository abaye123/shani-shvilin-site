/**
 * Minimal APK reader: enough to identify a file before installing it.
 *
 * - SHA-256 of the whole file.
 * - Signing certificate from the APK Signature Scheme v3 or v2 block.
 * - Package name, versionCode, versionName and minSdk from the binary AndroidManifest.xml.
 *
 * Works in browsers, WebView2 and Node 18+ (uses Web Crypto and DecompressionStream).
 */

export interface ApkSummary {
  size: number;
  sha256: string;
  packageName: string | null;
  versionCode: number | null;
  versionName: string | null;
  minSdk: number | null;
  /** SHA-256 of the first signer's certificate (DER), lower-case hex. */
  certSha256: string | null;
  certDer: Uint8Array | null;
  signatureScheme: "v3" | "v2" | null;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** True when the bytes start like a zip archive (an APK). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** True when the bytes look like an HTML page (a filter block page, for example). */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml") || head.includes("<head");
}

export async function inspectApk(bytes: Uint8Array): Promise<ApkSummary> {
  const summary: ApkSummary = {
    size: bytes.length,
    sha256: await sha256Hex(bytes),
    packageName: null,
    versionCode: null,
    versionName: null,
    minSdk: null,
    certSha256: null,
    certDer: null,
    signatureScheme: null,
  };
  if (!looksLikeZip(bytes)) return summary;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) return summary;
  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdEntries = dv.getUint16(eocd + 10, true);

  try {
    const sig = readSigningCert(dv, cdOffset);
    if (sig) {
      summary.certDer = sig.cert;
      summary.signatureScheme = sig.scheme;
      summary.certSha256 = await sha256Hex(sig.cert);
    }
  } catch {
    // Malformed signing block: leave the certificate unknown.
  }

  try {
    const manifest = await readEntry(bytes, dv, cdOffset, cdEntries, "AndroidManifest.xml");
    if (manifest) Object.assign(summary, parseManifest(manifest));
  } catch {
    // Malformed manifest: leave the fields unknown.
  }
  return summary;
}

function findEocd(dv: DataView): number {
  const min = Math.max(0, dv.byteLength - 22 - 65535);
  for (let i = dv.byteLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

const SIG_V2 = 0x7109871a;
const SIG_V3 = 0xf05368c0;

function readSigningCert(dv: DataView, cdOffset: number): { cert: Uint8Array; scheme: "v3" | "v2" } | null {
  if (cdOffset < 32) return null;
  const magic = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + cdOffset - 16, 16));
  if (magic !== "APK Sig Block 42") return null;
  const blockSize = Number(dv.getBigUint64(cdOffset - 24, true));
  const blockStart = cdOffset - blockSize - 8;
  if (blockStart < 0) return null;
  const pairs = new Map<number, [number, number]>();
  let p = blockStart + 8;
  const end = cdOffset - 24;
  while (p + 12 <= end) {
    const len = Number(dv.getBigUint64(p, true));
    const id = dv.getUint32(p + 8, true);
    pairs.set(id, [p + 12, len - 4]);
    p += 8 + len;
  }
  for (const [id, scheme] of [[SIG_V3, "v3"], [SIG_V2, "v2"]] as const) {
    const pair = pairs.get(id);
    if (!pair) continue;
    const [off] = pair;
    // value: signers(len-prefixed) > signer(len-prefixed) > signedData(len-prefixed)
    //        > digests(len-prefixed), certificates(len-prefixed) > cert(len-prefixed)
    let q = off + 4; // skip signers sequence length
    q += 4; // skip first signer length
    q += 4; // skip signed data length
    const digestsLen = dv.getUint32(q, true);
    q += 4 + digestsLen;
    q += 4; // skip certificates sequence length
    const certLen = dv.getUint32(q, true);
    q += 4;
    const cert = new Uint8Array(dv.buffer, dv.byteOffset + q, certLen).slice();
    return { cert, scheme };
  }
  return null;
}

async function readEntry(
  bytes: Uint8Array,
  dv: DataView,
  cdOffset: number,
  count: number,
  wanted: string,
): Promise<Uint8Array | null> {
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return data.slice();
      if (method === 8) return inflateRaw(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;
const ATTR_MIN_SDK = 0x0101020c;
const TYPE_STRING = 0x03;

/** Parses the binary XML manifest just far enough to read the identity fields. */
export function parseManifest(xml: Uint8Array): Pick<ApkSummary, "packageName" | "versionCode" | "versionName" | "minSdk"> {
  const dv = new DataView(xml.buffer, xml.byteOffset, xml.byteLength);
  const out = { packageName: null as string | null, versionCode: null as number | null, versionName: null as string | null, minSdk: null as number | null };
  let strings: string[] = [];
  let resIds: number[] = [];
  let p = dv.getUint16(2, true); // skip the XML header
  while (p + 8 <= dv.byteLength) {
    const type = dv.getUint16(p, true);
    const headerSize = dv.getUint16(p + 2, true);
    const size = dv.getUint32(p + 4, true);
    if (size === 0) break;
    if (type === 0x0001) {
      strings = readStringPool(xml, dv, p, headerSize);
    } else if (type === 0x0180) {
      resIds = [];
      for (let i = p + headerSize; i < p + size; i += 4) resIds.push(dv.getUint32(i, true));
    } else if (type === 0x0102) {
      const nameIdx = dv.getUint32(p + 20, true);
      const attrStart = dv.getUint16(p + 24, true);
      const attrSize = dv.getUint16(p + 26, true);
      const attrCount = dv.getUint16(p + 28, true);
      const tag = strings[nameIdx];
      if (tag === "manifest" || tag === "uses-sdk") {
        for (let i = 0; i < attrCount; i++) {
          const a = p + 16 + attrStart + i * attrSize;
          const aName = dv.getUint32(a + 4, true);
          const raw = dv.getUint32(a + 8, true);
          const dataType = dv.getUint8(a + 15);
          const data = dv.getUint32(a + 16, true);
          const name = strings[aName] ?? "";
          const resId = resIds[aName] ?? 0;
          const str = raw !== 0xffffffff ? strings[raw] : dataType === TYPE_STRING ? strings[data] : undefined;
          if (tag === "manifest") {
            if (name === "package") out.packageName = str ?? null;
            else if (resId === ATTR_VERSION_CODE || name === "versionCode") out.versionCode = str !== undefined ? parseInt(str, 10) : data;
            else if (resId === ATTR_VERSION_NAME || name === "versionName") out.versionName = str ?? String(data);
          } else if (resId === ATTR_MIN_SDK || name === "minSdkVersion") {
            out.minSdk = str !== undefined ? parseInt(str, 10) : data;
          }
        }
        if (tag === "uses-sdk") break;
      }
    }
    p += size;
  }
  return out;
}

function readStringPool(xml: Uint8Array, dv: DataView, start: number, headerSize: number): string[] {
  const count = dv.getUint32(start + 8, true);
  const flags = dv.getUint32(start + 16, true);
  const stringsStart = dv.getUint32(start + 20, true);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  const u8 = new TextDecoder("utf-8");
  const u16 = new TextDecoder("utf-16le");
  for (let i = 0; i < count; i++) {
    const off = dv.getUint32(start + headerSize + i * 4, true);
    let p = start + stringsStart + off;
    if (utf8) {
      // utf16 length, then utf8 length, each 1 or 2 bytes
      p += (dv.getUint8(p) & 0x80) ? 2 : 1;
      let len = dv.getUint8(p);
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | dv.getUint8(p + 1);
        p += 2;
      } else p += 1;
      out.push(u8.decode(xml.subarray(p, p + len)));
    } else {
      let len = dv.getUint16(p, true);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | dv.getUint16(p + 2, true);
        p += 4;
      } else p += 2;
      out.push(u16.decode(xml.subarray(p, p + len * 2)));
    }
  }
  return out;
}

/**
 * Java's Arrays.hashCode(byte[]) of the certificate, as `dumpsys package` prints it in
 * `signatures:[...]`. Lets us compare the installed app's signer without pulling its APK.
 */
export function androidSignatureHash(certDer: Uint8Array): string {
  let h = 1;
  for (const b of certDer) {
    const signed = b > 127 ? b - 256 : b;
    h = (Math.imul(31, h) + signed) | 0;
  }
  return (h >>> 0).toString(16);
}
