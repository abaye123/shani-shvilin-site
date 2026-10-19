import { ADMIN_COMPONENT, SITE_URL } from "./constants.js";
import { hexToUrlSafeBase64 } from "./version.js";

/** armeabi-v7a runs on both 32 and 64 bit ARM devices, so it is the safe single URL for QR. */
export const QR_APK_URL = `${SITE_URL}/apk/stable/ShaniShvilin-armeabi-v7a.apk`;

export interface WifiExtras {
  ssid: string;
  password?: string;
  /** "WPA", "WEP", "NONE" (and "SAE" on newer devices). */
  security: "WPA" | "WEP" | "NONE" | "SAE";
  hidden?: boolean;
}

/** The Android QR provisioning payload for making our app the device owner. */
export function buildProvisioningPayload(certSha256Hex: string, wifi?: WifiExtras): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": ADMIN_COMPONENT,
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": QR_APK_URL,
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": hexToUrlSafeBase64(certSha256Hex),
    "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
    "android.app.extra.PROVISIONING_LOCALE": "he_IL",
    "android.app.extra.PROVISIONING_TIME_ZONE": "Asia/Jerusalem",
  };
  if (wifi?.ssid) {
    payload["android.app.extra.PROVISIONING_WIFI_SSID"] = wifi.ssid;
    payload["android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE"] = wifi.security;
    if (wifi.password && wifi.security !== "NONE") payload["android.app.extra.PROVISIONING_WIFI_PASSWORD"] = wifi.password;
    if (wifi.hidden) payload["android.app.extra.PROVISIONING_WIFI_HIDDEN"] = true;
  }
  return payload;
}
