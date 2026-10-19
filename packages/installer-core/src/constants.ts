/** Identifiers of the released app. Shared by the site, the web installer and the PC installer. */
export const APP_PACKAGE = "com.abaye.shanishvilin";
export const ADMIN_COMPONENT = `${APP_PACKAGE}/${APP_PACKAGE}.feature.admin.AdminReceiver`;
export const MAIN_ACTIVITY = `${APP_PACKAGE}/${APP_PACKAGE}.MainActivity`;
export const DEBUG_PACKAGE = `${APP_PACKAGE}.debug`;

/** Where the APK is pushed on the device before `pm install`. */
export const REMOTE_APK_PATH = "/data/local/tmp/shanishvilin.apk";

export const SITE_URL = "https://shanishvilin.abaye.co";
export const CONTACT_EMAIL = "shanishvilin@abaye.co";
export const DEVELOPER_URL = "https://abaye.co";

export const MIN_SDK = 24;
/** Wireless self-provisioning inside the app ("no computer" path) needs Android 11. */
export const NO_COMPUTER_MIN_SDK = 30;

/** Any APK smaller than this is treated as a filter block page, not a real build. */
export const MIN_APK_BYTES = 1024 * 1024;

/** Free space required on /data before installing. */
export const MIN_FREE_BYTES = 300 * 1024 * 1024;

export const SUPPORTED_ABIS = ["arm64-v8a", "armeabi-v7a"] as const;
export type Abi = (typeof SUPPORTED_ABIS)[number];

export const ANDROID_VERSION_NAMES: Record<number, string> = {
  24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12",
  32: "12L", 33: "13", 34: "14", 35: "15", 36: "16", 37: "17",
};

export function androidVersionName(sdk: number): string {
  return ANDROID_VERSION_NAMES[sdk] ?? `SDK ${sdk}`;
}
