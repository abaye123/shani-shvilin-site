# shani-shvilin-site

Public distribution site and installers for **Shani Shvilin** (שני שבילין), the filtered Android
car launcher, app store and internal filter. Published at <https://shanishvilin.abaye.co>
(GitHub Pages, custom domain in `public/CNAME`).

The audience is mostly behind the NetFree filter, so the site makes **no runtime third-party
requests**: no CDNs, no web fonts from Google, no analytics. Fonts, images, the QR library and the
installer code are all bundled and served from the site's own domain.

## Structure

```
.
├── src/                      Astro site (static, Hebrew, RTL)
│   ├── pages/                /, /install, /install/{web,pc,qr,manual}, /car, /update-offline,
│   │                         /devices, /help, /guide, /download, /changelog, /terms, 404
│   │   └── qr/[name].png.ts  build-time QR image (/qr/device-owner.png)
│   ├── layouts/Base.astro    header, footer, theme toggle
│   ├── components/           download buttons, gallery, copyable commands, illustrations
│   ├── lib/site-data.ts      build-time access to public/version.json and the release list
│   ├── data/help-content.json  user guide, generated from the app's HelpContent.kt
│   ├── assets/               icons and screenshots (optimized to webp at build time)
│   └── styles/global.css
├── public/
│   ├── CNAME
│   ├── version.json          placeholder (no release); replaced at deploy time
│   ├── fonts/                IBM Plex Sans Hebrew woff2 (self-hosted)
│   └── icons/
├── packages/installer-core/  shared TypeScript installer (no framework)
│   └── src/
│       ├── constants.ts      package, admin component, paths, limits
│       ├── terms.ts          Hebrew terms of use, TERMS_VERSION
│       ├── version.ts        version.json types, channel resolution
│       ├── errors.ts         known errors with Hebrew explanations (also renders /help)
│       ├── oem.ts            per-OEM preparation notes (also renders /devices)
│       ├── parsers.ts        dpm / dumpsys / pm / df output parsers
│       ├── apk.ts            minimal APK reader: SHA-256, v2/v3 signing cert, manifest
│       ├── installer.ts      install flow operations over an abstract adb backend
│       ├── qr.ts             QR provisioning payload
│       ├── backend.ts        AdbBackend / AdbDevice / Fetcher interfaces
│       ├── backends/webusb.ts  WebUSB backend on Tango (@yume-chan/adb)
│       └── ui/               wizard (plain DOM), brand.css tokens, wizard.css
├── installer/                Tauri v2 PC installer (same wizard, adb.exe backend)
│   ├── index.html, src/      frontend (Vite)
│   └── src-tauri/            Rust: platform-tools download, adb runner, push, HTTPS GET
├── scripts/
│   ├── fetch-release.mjs     deploy-time download of APKs and update manifests
│   ├── sync-help.mjs         regenerate src/data/help-content.json from HelpContent.kt
│   └── convert-fonts.mjs     one-off TTF to woff2 conversion
└── .github/workflows/
    ├── pages.yml             build and deploy the site
    └── installer.yml         build the Windows installer exe on installer-v* tags
```

## Develop

Requirements: Node 24, npm 11. For the PC installer also Rust (stable, MSVC on Windows) and
WebView2 (built into Windows 10/11).

```sh
npm ci
npm run dev          # site at http://localhost:4321
npm run build        # static site in dist/
npm run preview      # serve dist/
npm run typecheck    # installer core and PC installer
```

`npm run dev` and `npm run build` use the placeholder `public/version.json`, so every page shows
its "no release yet" state. To build against the real releases locally, run
`npm run fetch-release` first (it overwrites `public/version.json`; do not commit that change).

### PC installer

```sh
npm run installer:dev                         # Tauri dev window
npm run build:exe -w shani-shvilin-installer  # portable exe, no installer package
# -> installer/src-tauri/target/release/shani-shvilin-installer.exe
```

The exe is a single portable file. On first connect it downloads Google's platform-tools zip
(`dl.google.com`) into `%LOCALAPPDATA%\co.abaye.shanishvilin.installer\platform-tools` and runs
the official `adb.exe` (platform-tools are not bundled, for licensing reasons). If `adb.exe`,
`AdbWinApi.dll` and `AdbWinUsbApi.dll` are placed next to the exe, those are used instead, which
helps when Google is blocked. HTTPS goes through the OS certificate store (native-tls), so a
filter's root certificate is honored. The app runs `adb kill-server` on exit to release USB.

The exe is not code-signed; `/install/pc` explains how to pass the SmartScreen warning.

## How releases reach the site

APKs and update files are **never committed** here (they would grow the repository by about
100 MB per release). On every deploy, `.github/workflows/pages.yml` runs
`scripts/fetch-release.mjs` before `astro build`:

| Source (abaye123/shani-shvilin-releases) | Published at |
| --- | --- |
| `main:update/version.json` | `/version.json` |
| `main:update/stable.json`, `main:update/beta.json` (signed envelopes) | `/update/stable.json`, `/update/beta.json` |
| latest stable release, `ShaniShvilin-<v>-{arm64-v8a,armeabi-v7a}.apk` | `/apk/stable/ShaniShvilin-<abi>.apk` |
| latest pre-release, same assets | `/apk/beta/ShaniShvilin-<abi>.apk` |
| release list | `src/generated/releases.json` (for /changelog) |
| this repo's latest `installer-v*` release, `ShaniShvilin-Installer*.exe` | `/downloads/ShaniShvilin-Installer.exe` |

While there is no stable release, the beta APKs are also served on the stable paths, so stable
links and the QR code work. Each APK is checked against the release's `SHA256SUMS`; with
`FETCH_STRICT=1` (set in CI) any inconsistency fails the build and the previous deployment stays
live.

`version.json` has one entry per channel:

```json
{
  "stable": { "versionName": "2.0.0", "versionCode": 3, "tag": "v2.0.0", "publishedAt": "2026-11-01",
              "notes": "...", "certSha256": "<hex>", "universalUrl": "https://github.com/...",
              "apks": { "arm64-v8a": { "path": "/apk/stable/ShaniShvilin-arm64-v8a.apk", "sha256": "<hex>", "size": 123 },
                        "armeabi-v7a": { "path": "/apk/stable/ShaniShvilin-armeabi-v7a.apk", "sha256": "<hex>", "size": 123 } } },
  "beta": { "...": "same fields" },
  "installerVersion": "1.0.0"
}
```

Missing channels (`null` or absent) are handled everywhere. The deploy adds `installer` and
`installerVersion` from the installer release.

**Release script contract.** After publishing a release and updating `update/*.json` in the
releases repo, the app's release script triggers a deploy:

```sh
gh api repos/abaye123/shani-shvilin-site/dispatches -f event_type=release-published
```

The workflow also runs on push to `main`, on manual dispatch and every 6 hours as a safety net.

**Publishing a new PC installer.** Bump `version` in `installer/src-tauri/tauri.conf.json`,
`installer/src-tauri/Cargo.toml` and `installer/package.json`, then push a tag
`installer-vX.Y.Z`. `installer.yml` builds the exe, attaches it to a release and redeploys the
site.

## QR provisioning

`/qr/device-owner.png` is generated at build time (only when `version.json` has a valid
`certSha256`) from the payload in `packages/installer-core/src/qr.ts`. It points at
`/apk/stable/ShaniShvilin-armeabi-v7a.apk`, which runs on both 32 and 64 bit ARM. `/install/qr`
also renders a Wi-Fi variant locally in the browser; the password never leaves the page.

## Content sources

- Terms: `packages/installer-core/src/terms.ts` (bump `TERMS_VERSION` on substantive changes).
- User guide: run `node scripts/sync-help.mjs` after the app's `HelpContent.kt` changes.
- Error explanations: `packages/installer-core/src/errors.ts` feeds both installers and `/help`.
- Device notes: `packages/installer-core/src/oem.ts` feeds the wizard and `/devices`.

Writing rules: user-facing text in Hebrew; no em or en dashes anywhere; the app's filter is
"סינון פנימי".

## Licenses

© abaye. All rights reserved. Third-party components keep their own licenses: IBM Plex Sans
Hebrew (SIL OFL 1.1), Tango / `@yume-chan/*` (MIT), `qrcode` (MIT), Astro (MIT), Tauri (MIT or
Apache-2.0). Android platform-tools are downloaded from Google at runtime under Google's terms.
