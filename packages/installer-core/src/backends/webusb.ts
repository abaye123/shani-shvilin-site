/**
 * WebUSB backend (Chromium desktop) on Tango: talks to adbd on the device directly,
 * no adb.exe needed.
 */
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { ReadableStream } from "@yume-chan/stream-extra";
import type { AdbBackend, AdbDevice, ConnectOptions } from "../backend.js";
import { InstallerError } from "../errors.js";

const PUSH_CHUNK = 64 * 1024;

class WebUsbDevice implements AdbDevice {
  constructor(private readonly adb: Adb) {}

  get serial(): string {
    return this.adb.serial;
  }

  async shell(command: string): Promise<string> {
    // The "none" protocol works on every Android version and merges stdout and stderr.
    return this.adb.subprocess.noneProtocol.spawnWaitText(command);
  }

  async push(data: Uint8Array, remotePath: string, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const sync = await this.adb.sync();
    try {
      let offset = 0;
      const file = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= data.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + PUSH_CHUNK, data.length);
          controller.enqueue(data.subarray(offset, end));
          offset = end;
          onProgress?.(offset, data.length);
        },
      });
      await sync.write({ filename: remotePath, file, permission: 0o644, mtime: Math.floor(Date.now() / 1000) });
    } finally {
      await sync.dispose();
    }
  }

  async close(): Promise<void> {
    await this.adb.close();
  }
}

function isMobile(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export class WebUsbBackend implements AdbBackend {
  readonly kind = "webusb" as const;
  private readonly credentials = new AdbWebCredentialStore("Shani Shvilin installer");

  unsupportedReason(): "no-webusb" | "mobile" | "insecure" | null {
    if (isMobile()) return "mobile";
    if (!window.isSecureContext) return "insecure";
    if (!AdbDaemonWebUsbDeviceManager.BROWSER) return "no-webusb";
    return null;
  }

  async connect({ onStatus, signal }: ConnectOptions): Promise<AdbDevice> {
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager) throw new InstallerError("no-webusb");
    let device: AdbDaemonWebUsbDevice | undefined;
    try {
      device = await manager.requestDevice();
    } catch (e) {
      throw new InstallerError("no-devices", (e as Error).message);
    }
    if (!device) throw new InstallerError("no-devices", "No device selected");
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    let connection;
    try {
      connection = await device.connect();
    } catch (e) {
      if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) throw new InstallerError("usb-busy", (e as Error).message);
      const msg = (e as Error).message ?? String(e);
      if (/claim|in use|busy|Access denied/i.test(msg)) throw new InstallerError("usb-busy", msg);
      throw e;
    }

    // authenticate() waits until the user accepts the RSA prompt on the device.
    onStatus({ kind: "authorize" });
    const transport = await Promise.race([
      AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore: this.credentials }),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    ]);
    const adb = new Adb(transport);
    onStatus({ kind: "connected", serial: adb.serial });
    return new WebUsbDevice(adb);
  }
}
