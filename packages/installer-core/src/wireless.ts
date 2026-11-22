/**
 * Connecting to a device over Wi-Fi, for units the computer cannot see over USB.
 *
 * A car "AI Box" shows up on a PC as an Apple device, because its USB port is in
 * CarPlay mode, and the forum's working guide (VicoVation AI BOX GT5S, Android 13)
 * went around that with wireless debugging: `adb pair` with the code from the
 * pairing dialog, then `adb connect` to the address on the main wireless debugging
 * screen. The step people got wrong was the second one: the main screen shows a
 * different port from the pairing dialog, and connecting to the pairing port fails.
 *
 * Pure, so the parsing and the advice can be checked without a device.
 */

/** "192.168.1.100:37123", from whatever the person typed. Null when it is not an address. */
export function normalizeAddress(text: string): string | null {
  const cleaned = text
    .trim()
    // People copy what the screen shows, spaces and all, and Hebrew keyboards
    // sometimes give a different colon.
    .replace(/\s+/g, "")
    .replace(/[׃︓]/g, ":");
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(cleaned);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const port = Number(m[5]);
  if (octets.some((o) => o > 255) || port < 1 || port > 65535) return null;
  return `${octets.join(".")}:${port}`;
}

/** The six digits of the pairing dialog, or null. */
export function normalizePairingCode(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}

export type PairOutcome = "paired" | "wrong-code" | "unreachable" | "failed";

/** Reads `adb pair` output. adb exits 0 on some failures, so the text decides. */
export function pairOutcome(output: string): PairOutcome {
  if (/Successfully paired/i.test(output)) return "paired";
  if (/wrong password|protocol fault|failed to pair|pairing code/i.test(output) && /wrong|incorrect|fault/i.test(output)) return "wrong-code";
  if (/unable to connect|connection refused|no route|timed out|failed to connect/i.test(output)) return "unreachable";
  return "failed";
}

export type ConnectOutcome = "connected" | "refused" | "failed";

/** Reads `adb connect` output; "already connected" counts as connected. */
export function connectOutcome(output: string): ConnectOutcome {
  if (/^(connected to|already connected to)/im.test(output)) return "connected";
  if (/failed to connect|connection refused|unable to connect|cannot connect|no route|timed out/i.test(output)) return "refused";
  return "failed";
}

/**
 * The address to connect to must not be the pairing address. Both share the IP;
 * only the port tells them apart, and the pairing port closes with its dialog.
 */
export function isPairingAddressReused(pairAddress: string | null, connectAddress: string): boolean {
  return pairAddress !== null && pairAddress === connectAddress;
}
