import "@shani/installer-core/ui/brand.css";
import "@shani/installer-core/ui/wizard.css";
import "./app.css";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { COPYRIGHT_LINE, SITE_URL, compareVersions, loadVersionFile, mountWizard } from "@shani/installer-core";
import { AdbExeBackend, tauriFetcher } from "./tauri-backend";

// Links open in the default browser, never inside the installer window.
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (/^(https:|mailto:)/.test(href)) {
    e.preventDefault();
    void invoke("open_external", { url: href });
  }
});

// Follow the OS theme; no stored preference in the installer.
document.getElementById("copyright")!.textContent = COPYRIGHT_LINE;

const appVersion = await getVersion().catch(() => "");
document.getElementById("app-version")!.textContent = appVersion ? `גרסה ${appVersion}` : "";

mountWizard({
  root: document.getElementById("wizard")!,
  backend: new AdbExeBackend(),
  fetcher: tauriFetcher,
  dataBase: SITE_URL,
  linkBase: SITE_URL,
  platform: "pc",
  appVersion,
});

// Suggest a newer installer when the site lists one. Silent when offline.
void (async () => {
  const v = await loadVersionFile(tauriFetcher, SITE_URL, () => undefined);
  const latest = v.installerVersion ?? v.installer?.version;
  if (!latest || !appVersion || compareVersions(latest, appVersion) <= 0) return;
  const banner = document.getElementById("update-banner")!;
  banner.hidden = false;
  banner.querySelector("[data-version]")!.textContent = latest;
})();
