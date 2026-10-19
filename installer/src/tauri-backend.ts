/**
 * PC backend: the official adb binary, driven from Rust (src-tauri/src/lib.rs).
 * Same AdbBackend interface as the WebUSB backend, so the wizard is identical.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { InstallerError, type AdbBackend, type AdbDevice, type ConnectOptions, type Fetcher } from "@shani/installer-core";

interface AdbOutput {
  code: number;
  stdout: string;
  stderr: string;
}

async function adb(args: string[]): Promise<AdbOutput> {
  try {
    return await invoke<AdbOutput>("adb", { args });
  } catch (e) {
    throw new InstallerError(String(e) === "adb-missing" ? "adb-missing" : "unknown", String(e));
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

/** Parses `adb devices` into serial/state pairs. */
function parseDevices(text: string): { serial: string; state: string }[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, ...rest] = l.split(/\s+/);
      return { serial, state: rest.join(" ") };
    });
}

/** adb's own failures (not the device command's) start with "error:". */
const ADB_ERROR = /^(error|adb: error):/m;

class AdbExeDevice implements AdbDevice {
  constructor(readonly serial: string) {}

  async shell(command: string): Promise<string> {
    const out = await adb(["-s", this.serial, "shell", command]);
    if (out.code !== 0 && ADB_ERROR.test(out.stderr)) {
      throw new InstallerError(/not found|offline|no devices/i.test(out.stderr) ? "disconnected" : "unknown", out.stderr.trim());
    }
    return out.stdout + out.stderr;
  }

  async push(data: Uint8Array, remotePath: string, onProgress?: (sent: number, total: number) => void): Promise<void> {
    onProgress?.(0, data.length);
    try {
      await invoke("adb_push", data, { headers: { "x-serial": this.serial, "x-remote": remotePath } });
    } catch (e) {
      throw new InstallerError(/not found|offline|no devices/i.test(String(e)) ? "disconnected" : "unknown", String(e));
    }
    onProgress?.(data.length, data.length);
  }

  async close(): Promise<void> {
    // The adb server keeps running until the app exits.
  }
}

export class AdbExeBackend implements AdbBackend {
  readonly kind = "adb-exe" as const;

  unsupportedReason(): null {
    return null;
  }

  private async ensureTools(onStatus: ConnectOptions["onStatus"]): Promise<void> {
    const status = await invoke<{ ready: boolean; path: string | null }>("tools_status");
    if (status.ready) return;
    onStatus({ kind: "preparing", message: "מורידים מגוגל את כלי החיבור (platform-tools, פעם אחת בלבד)...", progress: 0 });
    const unlisten = await listen<{ received: number; total: number }>("tools-progress", (e) => {
      const { received, total } = e.payload;
      onStatus({
        kind: "preparing",
        message: `מורידים מגוגל את כלי החיבור (platform-tools, פעם אחת בלבד)... ${(received / 1024 / 1024).toFixed(1)} MB`,
        progress: total ? received / total : undefined,
      });
    });
    try {
      await invoke<string>("install_tools");
    } catch (e) {
      const msg = String(e);
      throw new InstallerError(msg.includes("filter-blocked") || msg.includes("download-failed") ? "tools-download" : "unknown", msg);
    } finally {
      unlisten();
    }
  }

  async connect({ onStatus, signal }: ConnectOptions): Promise<AdbDevice> {
    await this.ensureTools(onStatus);
    onStatus({ kind: "preparing", message: "מפעילים את כלי החיבור..." });
    await adb(["start-server"]);
    onStatus({ kind: "waiting-device" });
    let last = "";
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const out = await adb(["devices"]);
      const devices = parseDevices(out.stdout);
      const ready = devices.filter((d) => d.state === "device");
      const key = devices.map((d) => `${d.serial}:${d.state}`).join(",");
      if (ready.length === 1 && devices.length === 1) {
        onStatus({ kind: "connected", serial: ready[0].serial });
        return new AdbExeDevice(ready[0].serial);
      }
      if (key !== last) {
        last = key;
        if (devices.length > 1) onStatus({ kind: "multiple-devices", count: devices.length });
        else if (devices.some((d) => d.state === "unauthorized" || d.state === "authorizing")) onStatus({ kind: "authorize" });
        else onStatus({ kind: "waiting-device" });
      }
      await sleep(1000, signal);
    }
  }
}

/** HTTPS GET through Rust (OS certificate store, no CORS). See http_get in lib.rs. */
export const tauriFetcher: Fetcher = async (url, onProgress) => {
  const unlisten = onProgress
    ? await listen<{ received: number; total: number }>("http-progress", (e) => onProgress(e.payload.received, e.payload.total))
    : null;
  try {
    const buf = await invoke<ArrayBuffer>("http_get", { url });
    const bytes = new Uint8Array(buf);
    const status = (bytes[0] << 8) | bytes[1];
    const ctLen = (bytes[2] << 8) | bytes[3];
    const contentType = new TextDecoder().decode(bytes.subarray(4, 4 + ctLen));
    return { status, contentType, bytes: bytes.subarray(4 + ctLen) };
  } catch (e) {
    throw new Error(String(e));
  } finally {
    unlisten?.();
  }
};
