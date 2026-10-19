/**
 * The installer talks to the device only through these interfaces. The web installer
 * implements them on WebUSB (Tango), the PC installer on the official adb.exe.
 */

export type ConnectStatus =
  | { kind: "preparing"; message: string; progress?: number }
  | { kind: "waiting-device" }
  | { kind: "authorize" }
  | { kind: "multiple-devices"; count: number }
  | { kind: "connected"; serial: string };

export interface ConnectOptions {
  onStatus(status: ConnectStatus): void;
  signal: AbortSignal;
}

export interface AdbDevice {
  readonly serial: string;
  /** Runs a shell command and returns stdout and stderr combined. */
  shell(command: string): Promise<string>;
  /** Writes a file to the device. */
  push(data: Uint8Array, remotePath: string, onProgress?: (sent: number, total: number) => void): Promise<void>;
  close(): Promise<void>;
}

export interface AdbBackend {
  readonly kind: "webusb" | "adb-exe";
  /** Null when usable, otherwise the id of the reason (see the wizard's unsupported view). */
  unsupportedReason(): "no-webusb" | "mobile" | "insecure" | null;
  /**
   * Connects to one device. For WebUSB this must be called from a user gesture,
   * since it opens the browser's device chooser.
   */
  connect(options: ConnectOptions): Promise<AdbDevice>;
}

/** HTTP GET used to fetch version.json and APKs. */
export interface FetchResult {
  status: number;
  contentType: string;
  bytes: Uint8Array;
}

export type Fetcher = (url: string, onProgress?: (received: number, total: number) => void) => Promise<FetchResult>;

/** Fetcher on top of window.fetch, with download progress. */
export const browserFetcher: Fetcher = async (url, onProgress) => {
  const res = await fetch(url, { cache: "no-store" });
  const total = Number(res.headers.get("content-length") ?? 0);
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, contentType, bytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  const bytes = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { status: res.status, contentType, bytes };
};
