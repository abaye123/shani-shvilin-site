/**
 * The installation wizard UI, shared by the web installer (/install/web) and the PC installer.
 * Plain DOM, no framework. All user-facing text is Hebrew.
 */
import type { AdbBackend, AdbDevice, ConnectStatus, Fetcher } from "../backend.js";
import { APP_PACKAGE, MIN_FREE_BYTES, MIN_SDK, androidVersionName, type Abi } from "../constants.js";
import { describeError, InstallerError, type ErrorDescription } from "../errors.js";
import { androidSignatureHash } from "../apk.js";
import {
  cleanupTemp,
  downloadApk,
  inspectLocalApk,
  installApk,
  launchApp,
  loadVersionFile,
  openAccountSettings,
  readAccounts,
  readDeviceInfo,
  readFreeBytes,
  readOwners,
  readPackage,
  readUsers,
  setDeviceOwner,
  uninstallApp,
  wait,
  type ApkCandidate,
  type DeviceInfo,
  type LogLevel,
} from "../installer.js";
import { GENERIC_PREPARE, OEM_NOTES } from "../oem.js";
import { accountTypeName, maskAccount, type AccountInfo, type PackageInfo, type UserInfo } from "../parsers.js";
import { TERMS, TERMS_VERSION } from "../terms.js";
import { fingerprint, formatBytes, pickAbi, resolveChannel, type Channel, type VersionFile } from "../version.js";
import { commandLine, copyText, h, type Child } from "./dom.js";

export interface WizardOptions {
  root: HTMLElement;
  backend: AdbBackend;
  fetcher: Fetcher;
  /** Base URL for version.json and APKs: "" on the site itself, the site URL in the PC app. */
  dataBase: string;
  /** Base URL for links to site pages. */
  linkBase: string;
  platform: "web" | "pc";
  /** Shown in the log header. */
  appVersion?: string;
}

type StepId = "terms" | "type" | "prepare" | "connect" | "checks" | "plan" | "install" | "owner" | "done";

const STEPS: { id: StepId; label: string }[] = [
  { id: "terms", label: "תנאים" },
  { id: "type", label: "סוג מכשיר" },
  { id: "prepare", label: "הכנה" },
  { id: "connect", label: "חיבור" },
  { id: "checks", label: "בדיקות" },
  { id: "plan", label: "סיכום" },
  { id: "install", label: "התקנה" },
  { id: "owner", label: "ניהול" },
  { id: "done", label: "סיום" },
];

type CheckId = "device" | "owner" | "users" | "accounts" | "space" | "apk" | "signer";
type CheckStatus = "pending" | "running" | "ok" | "warn" | "fail" | "skip";

interface CheckState {
  status: CheckStatus;
  summary?: string;
  error?: ErrorDescription;
}

const CHECK_TITLES: Record<CheckId, string> = {
  device: "גרסת אנדרואיד וסוג מעבד",
  owner: "מנהל מכשיר קיים",
  users: "משתמשים ופרופילים נוספים",
  accounts: "חשבונות במכשיר",
  space: "מקום פנוי",
  apk: "קובץ ההתקנה",
  signer: "גרסה מותקנת",
};
const CHECK_ORDER: CheckId[] = ["device", "owner", "users", "accounts", "space", "apk", "signer"];

const ACCOUNTS_TIMEOUT_MS = 10 * 60 * 1000;

export class Wizard {
  private step: StepId = "terms";
  private termsAccepted = false;
  private deviceType: "phone" | "tablet" | "car" | null = null;
  private oem = "samsung";
  private device: AdbDevice | null = null;
  private info: DeviceInfo | null = null;
  private connectStatus: ConnectStatus | null = null;
  private connectError: ErrorDescription | null = null;
  private connectAbort: AbortController | null = null;
  private versionFile: VersionFile | null = null;
  private channel: Channel = "stable";
  private advancedOpen = false;
  private checks: Record<CheckId, CheckState> = freshChecks();
  private mode: "install" | "update" = "install";
  private abi: Abi | null = null;
  private accounts: AccountInfo[] = [];
  private accountsDeadline = 0;
  private accountsPoll: AbortController | null = null;
  private users: UserInfo[] = [];
  private pkg: PackageInfo | null = null;
  private ownerPackage: string | null = null;
  private freeBytes: number | null = null;
  private apk: ApkCandidate | null = null;
  private apkProgress: { received: number; total: number } | null = null;
  private installProgress: { sent: number; total: number } | null = null;
  private phase: "idle" | "running" | "ok" | "fail" = "idle";
  private phaseText = "";
  private stepError: ErrorDescription | null = null;
  private installedFresh = false;
  private uninstallResult: string | null = null;
  private busy = false;

  private readonly body: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly logPre: HTMLElement;
  private readonly logLines: string[] = [];

  constructor(private readonly o: WizardOptions) {
    o.root.classList.add("sw");
    o.root.replaceChildren();
    this.progress = h("ol", { class: "sw-steps", "aria-label": "שלבי ההתקנה" });
    this.body = h("div", { class: "sw-body", "aria-live": "polite" });
    this.logPre = h("pre", { class: "sw-log-text", dir: "ltr" });
    const copyBtn = h("button", { type: "button", class: "sw-btn sw-btn-ghost" }, "העתקת יומן");
    copyBtn.addEventListener("click", async () => {
      if (await copyText(this.logLines.join("\n"))) {
        copyBtn.textContent = "היומן הועתק";
        setTimeout(() => (copyBtn.textContent = "העתקת יומן"), 1500);
      }
    });
    const log = h("details", { class: "sw-log" }, h("summary", null, "יומן פעולות"), this.logPre, h("div", { class: "sw-log-actions" }, copyBtn));
    o.root.append(this.progress, this.body, log);

    this.log("info", `Shani Shvilin installer (${o.platform}${o.appVersion ? ` ${o.appVersion}` : ""})`);
    this.log("info", navigator.userAgent);
    window.addEventListener("beforeunload", (e) => {
      if (this.busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    const reason = o.backend.unsupportedReason();
    if (reason) {
      this.renderUnsupported(reason);
      return;
    }
    void this.loadVersions();
    this.render();
  }

  // ---------------------------------------------------------------- infra

  private log = (level: LogLevel, message: string): void => {
    const t = new Date().toTimeString().slice(0, 8);
    const line = `[${t}] ${level === "out" ? "  " : `${level.toUpperCase()} `}${message}`;
    this.logLines.push(line);
    this.logPre.textContent += `${line}\n`;
    this.logPre.scrollTop = this.logPre.scrollHeight;
  };

  private link(path: string, text: string): HTMLAnchorElement {
    return h("a", { href: `${this.o.linkBase}${path}`, target: this.o.platform === "pc" ? "_blank" : null }, text);
  }

  private async loadVersions(): Promise<void> {
    this.versionFile = await loadVersionFile(this.o.fetcher, this.o.dataBase, this.log);
    const r = resolveChannel(this.versionFile, "stable");
    this.log("info", r ? `Latest release: ${r.info.versionName} (${r.channel})` : "No published release found");
  }

  private go(step: StepId): void {
    if (this.step === "checks" && step !== "checks") this.stopAccountsPoll();
    this.step = step;
    this.stepError = null;
    this.phase = "idle";
    this.render();
    this.o.root.scrollIntoView({ behavior: "smooth", block: "start" });
    if (step === "install") void this.runInstall();
    if (step === "owner") void this.runOwner();
    if (step === "done") void this.runDone();
  }

  private render(): void {
    const idx = STEPS.findIndex((s) => s.id === this.step);
    this.progress.replaceChildren(
      ...STEPS.map((s, i) =>
        h(
          "li",
          { class: i < idx ? "done" : i === idx ? "current" : "", "aria-current": i === idx ? "step" : null },
          h("span", { class: "sw-step-num" }, String(i + 1)),
          h("span", { class: "sw-step-label" }, s.label),
        ),
      ),
    );
    const view = {
      terms: () => this.viewTerms(),
      type: () => this.viewType(),
      prepare: () => this.viewPrepare(),
      connect: () => this.viewConnect(),
      checks: () => this.viewChecks(),
      plan: () => this.viewPlan(),
      install: () => this.viewInstall(),
      owner: () => this.viewOwner(),
      done: () => this.viewDone(),
    }[this.step]();
    this.body.replaceChildren(view);
  }

  private card(title: string, ...children: Child[]): HTMLElement {
    return h("section", { class: "sw-card" }, h("h2", { class: "sw-title" }, title), ...children);
  }

  private nav(opts: { back?: StepId; next?: { label: string; onClick: () => void; disabled?: boolean } }): HTMLElement {
    return h(
      "div",
      { class: "sw-nav" },
      opts.next
        ? h("button", { type: "button", class: "sw-btn sw-btn-primary", disabled: !!opts.next.disabled || this.busy, onclick: opts.next.onClick }, opts.next.label)
        : null,
      opts.back ? h("button", { type: "button", class: "sw-btn sw-btn-ghost", disabled: this.busy, onclick: () => this.go(opts.back!) }, "חזרה") : null,
    );
  }

  private errorBox(e: ErrorDescription, ...actions: Child[]): HTMLElement {
    return h(
      "div",
      { class: "sw-error", role: "alert" },
      h("strong", null, e.title),
      h("p", null, e.explanation),
      e.fix.length ? h("ol", { class: "sw-fix" }, e.fix.map((f) => h("li", null, f))) : null,
      e.commands?.map((c) => commandLine(c)),
      e.detail ? h("details", { class: "sw-detail" }, h("summary", null, "פרטים טכניים"), h("pre", { dir: "ltr" }, e.detail)) : null,
      actions.length ? h("div", { class: "sw-actions" }, actions) : null,
    );
  }

  // ---------------------------------------------------------------- unsupported

  private renderUnsupported(reason: "no-webusb" | "mobile" | "insecure"): void {
    this.progress.remove();
    const text =
      reason === "mobile"
        ? "ההתקנה מהדפדפן פועלת רק במחשב. בטלפון או ביחידת מולטימדיה אפשר להתקין בלי מחשב:"
        : "הדפדפן הזה לא תומך בחיבור למכשיר דרך USB. ההתקנה מהדפדפן פועלת ב-Google Chrome או ב-Microsoft Edge במחשב.";
    this.body.replaceChildren(
      this.card(
        "הדפדפן לא מתאים להתקנה",
        h("p", null, text),
        h(
          "ul",
          { class: "sw-list" },
          reason !== "mobile" ? h("li", null, "פותחים את הדף הזה ב-Chrome או ב-Edge במחשב, או") : null,
          h("li", null, "מורידים את ", this.link("/install/pc/", "תוכנת ההתקנה למחשב"), ", או"),
          h("li", null, "מתקינים ישירות מהמכשיר עם אשף \"בלי מחשב\" (אנדרואיד 11 ומעלה): ", this.link("/install/#no-computer", "הסבר"), "."),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- step 1: terms

  private viewTerms(): HTMLElement {
    const box = h(
      "div",
      { class: "sw-terms", tabindex: "0" },
      h("ol", null, TERMS.map((t) => h("li", null, h("strong", null, `${t.title}. `), t.body))),
    );
    const cb = h("input", { type: "checkbox", id: "sw-terms-cb", checked: this.termsAccepted }) as HTMLInputElement;
    cb.addEventListener("change", () => {
      this.termsAccepted = cb.checked;
      this.render();
    });
    return this.card(
      "תנאי שימוש",
      h("p", null, "לפני ההתקנה יש לקרוא ולאשר את תנאי השימוש. הנוסח המלא נמצא גם ב", this.link("/terms/", "עמוד תנאי השימוש"), "."),
      box,
      h("label", { class: "sw-check", for: "sw-terms-cb" }, cb, h("span", null, "קראתי את תנאי השימוש ואני מסכים/ה להם")),
      this.nav({
        next: {
          label: "המשך",
          disabled: !this.termsAccepted,
          onClick: () => {
            this.log("info", `Terms v${TERMS_VERSION} accepted`);
            this.go("type");
          },
        },
      }),
    );
  }

  // ---------------------------------------------------------------- step 2: device type

  private viewType(): HTMLElement {
    const opt = (id: "phone" | "tablet" | "car", title: string, desc: string) =>
      h(
        "button",
        {
          type: "button",
          class: `sw-option${this.deviceType === id ? " selected" : ""}`,
          "aria-pressed": this.deviceType === id ? "true" : "false",
          onclick: () => {
            this.deviceType = id;
            this.render();
          },
        },
        h("strong", null, title),
        h("span", null, desc),
      );
    return this.card(
      "על איזה מכשיר מתקינים?",
      h("div", { class: "sw-options" }, opt("phone", "טלפון", "טלפון אנדרואיד 7 ומעלה"), opt("tablet", "טאבלט", "טאבלט אנדרואיד 7 ומעלה"), opt("car", "מולטימדיה לרכב", "יחידת אנדרואיד ברכב")),
      this.deviceType === "car"
        ? h(
            "div",
            { class: "sw-note" },
            "ברוב יחידות המולטימדיה אין אפשרות לחבר את היחידה למחשב. מומלץ לפתוח בדפדפן של היחידה את ",
            this.link("/car/", "shanishvilin.abaye.co/car"),
            " ולהתקין משם. אם ליחידה שלכם יש חיבור למחשב, אפשר להמשיך כאן.",
          )
        : null,
      h(
        "div",
        { class: "sw-note sw-note-soft" },
        "באנדרואיד 11 ומעלה אפשר גם להתקין בלי מחשב: מתקינים את האפליקציה במכשיר ומשתמשים באשף \"בלי מחשב\" שבתוכה. ",
        this.link("/install/#no-computer", "איך עושים את זה"),
      ),
      this.nav({ back: "terms", next: { label: "המשך", disabled: !this.deviceType, onClick: () => this.go("prepare") } }),
    );
  }

  // ---------------------------------------------------------------- step 3: prepare

  private viewPrepare(): HTMLElement {
    const oem = OEM_NOTES.find((x) => x.id === this.oem);
    const tabs = h(
      "div",
      { class: "sw-tabs", role: "tablist" },
      OEM_NOTES.map((x) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            class: `sw-tab${x.id === this.oem ? " selected" : ""}`,
            "aria-selected": x.id === this.oem ? "true" : "false",
            onclick: () => {
              this.oem = x.id;
              this.render();
            },
          },
          x.name,
        ),
      ),
    );
    return this.card(
      "הכנת המכשיר",
      h("ol", { class: "sw-list" }, GENERIC_PREPARE.map((s) => h("li", null, s))),
      h("h3", { class: "sw-sub" }, "הערות לפי יצרן"),
      tabs,
      oem
        ? h(
            "div",
            { class: "sw-tabpanel", role: "tabpanel" },
            h("ul", { class: "sw-list" }, oem.steps.map((s) => h("li", null, s))),
            oem.warnings?.map((w) => h("div", { class: "sw-note" }, w)),
          )
        : null,
      h("p", { class: "sw-muted" }, "פירוט נוסף: ", this.link("/devices/", "הערות למכשירים"), "."),
      this.nav({ back: "type", next: { label: "המכשיר מוכן, להמשך", onClick: () => this.go("connect") } }),
    );
  }

  // ---------------------------------------------------------------- step 4: connect

  private viewConnect(): HTMLElement {
    const s = this.connectStatus;
    let status: Child = null;
    if (this.busy && s) {
      if (s.kind === "preparing") {
        status = h("div", { class: "sw-status" }, spinner(), h("span", null, s.message), s.progress !== undefined ? progressBar(s.progress) : null);
      } else if (s.kind === "waiting-device") {
        status = h("div", { class: "sw-status" }, spinner(), h("span", null, "מחפשים מכשיר מחובר... מחברים את הכבל ומוודאים שניפוי באגים ב-USB מופעל."));
      } else if (s.kind === "authorize") {
        status = h(
          "div",
          { class: "sw-status sw-status-attn" },
          spinner(),
          h("div", null, h("strong", null, "אשרו במכשיר"), h("p", null, "במסך המכשיר מופיע החלון \"לאפשר ניפוי באגים ב-USB?\". מסמנים \"אפשר תמיד מהמחשב הזה\" ולוחצים \"אישור\".")),
        );
      } else if (s.kind === "multiple-devices") {
        status = h("div", { class: "sw-status sw-status-attn" }, spinner(), h("span", null, `מחוברים ${s.count} מכשירים. משאירים מחובר מכשיר אחד בלבד.`));
      }
    }
    const connectBtn = h(
      "button",
      { type: "button", class: "sw-btn sw-btn-primary", disabled: this.busy, onclick: () => void this.connect() },
      this.o.platform === "web" ? "בחירת המכשיר וחיבור" : "חיבור למכשיר",
    );
    return this.card(
      "חיבור המכשיר",
      h(
        "ol",
        { class: "sw-list" },
        h("li", null, "מחברים את המכשיר למחשב בכבל USB שמעביר נתונים."),
        this.o.platform === "web"
          ? h("li", null, "לוחצים \"בחירת המכשיר וחיבור\", בוחרים את המכשיר ברשימה שהדפדפן מציג ולוחצים \"התחברות\".")
          : h("li", null, "לוחצים \"חיבור למכשיר\". בפעם הראשונה התוכנה מורידה את כלי החיבור של גוגל (כ-10 MB)."),
        h("li", null, "במסך המכשיר מאשרים \"לאפשר ניפוי באגים ב-USB\"."),
      ),
      status,
      this.connectError ? this.errorBox(this.connectError) : null,
      h("div", { class: "sw-nav" }, connectBtn, this.busy ? h("button", { type: "button", class: "sw-btn sw-btn-ghost", onclick: () => this.connectAbort?.abort() }, "ביטול") : h("button", { type: "button", class: "sw-btn sw-btn-ghost", onclick: () => this.go("prepare") }, "חזרה")),
    );
  }

  private async connect(): Promise<void> {
    if (this.busy) return;
    this.connectError = null;
    this.busy = true;
    this.connectAbort = new AbortController();
    this.connectStatus = { kind: "waiting-device" };
    this.render();
    try {
      if (this.device) {
        await this.device.close().catch(() => undefined);
        this.device = null;
      }
      const dev = await this.o.backend.connect({
        signal: this.connectAbort.signal,
        onStatus: (st) => {
          this.connectStatus = st;
          if (st.kind !== "preparing") this.log("info", `connect: ${st.kind}`);
          this.render();
        },
      });
      this.device = dev;
      this.log("info", `Connected to ${dev.serial}`);
      this.info = await readDeviceInfo(dev, this.log);
      this.busy = false;
      this.checks = freshChecks();
      this.apk = null;
      this.go("checks");
      void this.runAllChecks();
    } catch (e) {
      this.busy = false;
      if ((e as Error).name === "AbortError") {
        this.log("info", "Connect cancelled");
      } else {
        this.log("error", `Connect failed: ${(e as Error).message}`);
        this.connectError = describeError(e);
      }
      this.render();
    }
  }

  // ---------------------------------------------------------------- step 5: checks

  private setCheck(id: CheckId, st: CheckState): void {
    this.checks[id] = st;
    if (this.step === "checks") this.render();
  }

  private async runAllChecks(): Promise<void> {
    // "apk" runs "signer" itself once the file is known.
    for (const id of CHECK_ORDER) if (id !== "signer") await this.runCheck(id);
  }

  private async runCheck(id: CheckId): Promise<void> {
    const dev = this.device;
    if (!dev || !this.info) return;
    this.setCheck(id, { status: "running" });
    try {
      switch (id) {
        case "device":
          return this.checkDevice();
        case "owner":
          return await this.checkOwner(dev);
        case "users":
          return await this.checkUsers(dev);
        case "accounts":
          return await this.checkAccounts(dev);
        case "space":
          return await this.checkSpace(dev);
        case "apk":
          try {
            await this.checkApk();
          } finally {
            // Re-evaluate the installed version against the (new or missing) file.
            void this.runCheck("signer");
          }
          return;
        case "signer":
          return await this.checkSigner(dev);
      }
    } catch (e) {
      this.log("error", `${id}: ${(e as Error).message}`);
      this.setCheck(id, { status: "fail", error: describeError(e) });
    }
  }

  private checkDevice(): void {
    const info = this.info!;
    this.info = info;
    const model = [info.manufacturer, info.model].filter(Boolean).join(" ");
    const summary = `${model}, אנדרואיד ${info.release || androidVersionName(info.sdk)} (SDK ${info.sdk}), מעבד ${info.abis.join(", ") || "לא ידוע"}`;
    this.abi = pickAbi(info.abis);
    if (info.sdk < MIN_SDK) {
      this.setCheck("device", { status: "fail", summary, error: { ...describeError(new InstallerError("older-sdk")), detail: undefined } });
      return;
    }
    if (!this.abi) {
      this.setCheck("device", {
        status: "fail",
        summary,
        error: {
          id: "abi",
          title: "סוג המעבד לא נתמך בהתקנה האוטומטית",
          explanation: "ההתקנה האוטומטית תומכת במעבדי ARM. למכשירים אחרים יש קובץ אוניברסלי בעמוד ההורדות.",
          fix: ["מורידים את הקובץ האוניברסלי מעמוד ההורדות ומתקינים לפי ההוראות בעמוד ההתקנה הידנית."],
        },
      });
      return;
    }
    this.setCheck("device", { status: "ok", summary });
  }

  private async checkOwner(dev: AdbDevice): Promise<void> {
    const owners = await readOwners(dev, this.log);
    this.ownerPackage = owners.deviceOwner;
    if (!owners.deviceOwner) {
      this.mode = "install";
      this.setCheck("owner", { status: "ok", summary: "אין מנהל מכשיר. אפשר להמשיך." });
    } else if (owners.deviceOwner === APP_PACKAGE) {
      this.mode = "update";
      this.setCheck("owner", { status: "ok", summary: "שני שבילין כבר מנהלת את המכשיר. יבוצע עדכון בלבד, בלי לשנות את ההגדרות." });
    } else {
      this.mode = "install";
      this.setCheck("owner", {
        status: "fail",
        summary: `מנהל המכשיר הנוכחי: ${owners.deviceOwner}`,
        error: describeError(new InstallerError("already-owner")),
      });
    }
    // Owner decides whether users/accounts matter; refresh their state when re-run alone.
    if (this.checks.users.status !== "pending") await this.runCheck("users");
    if (this.checks.accounts.status !== "pending") await this.runCheck("accounts");
  }

  private async checkUsers(dev: AdbDevice): Promise<void> {
    if (this.mode === "update") {
      this.setCheck("users", { status: "skip", summary: "לא נדרש בעדכון." });
      return;
    }
    this.users = await readUsers(dev, this.log);
    if (this.users.length <= 1) {
      this.setCheck("users", { status: "ok", summary: "יש משתמש אחד בלבד." });
    } else {
      const others = this.users.filter((u) => u.id !== 0).map((u) => `${u.name || "ללא שם"} (${u.id})`);
      this.setCheck("users", { status: "fail", summary: `נמצאו משתמשים נוספים: ${others.join(", ")}`, error: describeError(new InstallerError("users")) });
    }
  }

  private async checkAccounts(dev: AdbDevice): Promise<void> {
    if (this.mode === "update") {
      this.stopAccountsPoll();
      this.setCheck("accounts", { status: "skip", summary: "לא נדרש בעדכון." });
      return;
    }
    this.accounts = await readAccounts(dev, this.log);
    if (this.accounts.length === 0) {
      this.stopAccountsPoll();
      this.setCheck("accounts", { status: "ok", summary: "אין חשבונות במכשיר." });
      return;
    }
    this.setCheck("accounts", { status: "fail", summary: `נמצאו ${this.accounts.length} חשבונות.`, error: describeError(new InstallerError("accounts")) });
    this.startAccountsPoll(dev);
  }

  private startAccountsPoll(dev: AdbDevice): void {
    if (this.accountsPoll) return;
    const ctl = new AbortController();
    this.accountsPoll = ctl;
    this.accountsDeadline = Date.now() + ACCOUNTS_TIMEOUT_MS;
    this.log("info", "Waiting for accounts to be removed");
    void (async () => {
      try {
        while (!ctl.signal.aborted && Date.now() < this.accountsDeadline) {
          await wait(3000, ctl.signal);
          const list = await readAccounts(dev, () => undefined);
          if (list.length !== this.accounts.length) this.log("info", `Accounts left: ${list.length}`);
          this.accounts = list;
          if (list.length === 0) {
            this.accountsPoll = null;
            this.setCheck("accounts", { status: "ok", summary: "כל החשבונות הוסרו." });
            return;
          }
          this.setCheck("accounts", { ...this.checks.accounts, summary: `נמצאו ${list.length} חשבונות.` });
        }
        if (!ctl.signal.aborted) {
          this.accountsPoll = null;
          this.log("warn", "Stopped waiting for accounts (10 minutes)");
          this.render();
        }
      } catch {
        this.accountsPoll = null;
      }
    })();
  }

  private stopAccountsPoll(): void {
    this.accountsPoll?.abort();
    this.accountsPoll = null;
  }

  private async checkSpace(dev: AdbDevice): Promise<void> {
    this.freeBytes = await readFreeBytes(dev, this.log);
    if (this.freeBytes === null) {
      this.setCheck("space", { status: "warn", summary: "לא הצלחנו לבדוק את המקום הפנוי. אפשר להמשיך." });
    } else if (this.freeBytes < MIN_FREE_BYTES) {
      this.setCheck("space", {
        status: "fail",
        summary: `פנויים ${formatBytes(this.freeBytes)}, נדרשים לפחות ${formatBytes(MIN_FREE_BYTES)}.`,
        error: describeError(new InstallerError("insufficient-storage")),
      });
    } else {
      this.setCheck("space", { status: "ok", summary: `פנויים ${formatBytes(this.freeBytes)}.` });
    }
  }

  private async checkApk(): Promise<void> {
    if (this.apk?.source === "local") {
      this.setCheck("apk", { status: "ok", summary: this.apkSummaryText(this.apk) });
      return;
    }
    if (!this.versionFile) await this.loadVersions();
    const resolved = resolveChannel(this.versionFile, this.channel);
    if (!resolved) {
      this.setCheck("apk", {
        status: "fail",
        summary: "לא נמצאה גרסה להורדה.",
        error: {
          id: "no-release",
          title: "אין גרסה זמינה להורדה",
          explanation: "לא הצלחנו לקבל מהאתר את פרטי הגרסה האחרונה. ייתכן שעדיין לא פורסמה גרסה, שאין חיבור לאינטרנט או שהאתר חסום.",
          fix: ["אם יש לכם קובץ התקנה שהורד מראש, בוחרים אותו ב\"בחירת קובץ מהמחשב\".", "אחרת בודקים את החיבור ולוחצים \"בדיקה מחדש\"."],
        },
      });
      return;
    }
    if (!this.abi) {
      this.setCheck("apk", { status: "pending", summary: "ממתין לבדיקת סוג המעבד." });
      return;
    }
    // The stable paths hold the beta build while there is no stable release.
    this.apkProgress = { received: 0, total: resolved.info.apks[this.abi]?.size ?? 0 };
    this.busy = true;
    try {
      this.apk = await downloadApk(this.o.fetcher, this.o.dataBase, this.channel, resolved.info, this.abi, this.log, (received, total) => {
        this.apkProgress = { received, total: total || this.apkProgress?.total || 0 };
        if (this.step === "checks") this.render();
      });
    } finally {
      this.busy = false;
      this.apkProgress = null;
    }
    // Label by the release actually served (stable paths carry the beta until a stable exists).
    this.apk.channel = resolved.channel;
    this.setCheck("apk", { status: "ok", summary: this.apkSummaryText(this.apk) });
  }

  private apkSummaryText(apk: ApkCandidate): string {
    const src = apk.source === "local" ? `קובץ מהמחשב: ${ltr(apk.fileName)}` : `הורדה מהאתר (${apk.channel === "beta" ? "בטא" : "יציבה"})`;
    return `גרסה ${ltr(apk.summary.versionName ?? "?")}, ${formatBytes(apk.summary.size)}, ${src}`;
  }

  private async pickLocalFile(file: File): Promise<void> {
    this.setCheck("apk", { status: "running" });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const release = resolveChannel(this.versionFile, this.channel)?.info;
      this.apk = await inspectLocalApk(bytes, file.name, release, this.log);
      this.setCheck("apk", { status: "ok", summary: this.apkSummaryText(this.apk) });
    } catch (e) {
      this.apk = null;
      this.setCheck("apk", { status: "fail", error: describeError(e) });
    }
    await this.runCheck("signer");
  }


  private async checkSigner(dev: AdbDevice): Promise<void> {
    this.pkg = await readPackage(dev, this.log);
    if (!this.pkg.installed) {
      this.setCheck("signer", { status: "ok", summary: "שני שבילין לא מותקנת עדיין." });
      return;
    }
    const current = `מותקנת גרסה ${ltr(this.pkg.versionName ?? "?")}`;
    if (!this.apk) {
      this.setCheck("signer", { status: "pending", summary: `${current}. ממתין לקובץ ההתקנה.` });
      return;
    }
    if (this.apk.summary.certDer && this.pkg.signatureHashes.length) {
      const ours = androidSignatureHash(this.apk.summary.certDer);
      if (!this.pkg.signatureHashes.includes(ours)) {
        this.log("warn", `Installed signer hash ${this.pkg.signatureHashes.join(",")} != ${ours}`);
        this.setCheck("signer", { status: "fail", summary: `${current}, בחתימה אחרת.`, error: describeError(new InstallerError("update-incompatible")) });
        return;
      }
    }
    if (this.pkg.versionCode !== null && this.apk.summary.versionCode !== null && this.pkg.versionCode > this.apk.summary.versionCode) {
      this.setCheck("signer", { status: "fail", summary: `${current}, חדשה מהקובץ.`, error: describeError(new InstallerError("version-downgrade")) });
      return;
    }
    this.setCheck("signer", { status: "ok", summary: `${current}. היא תעודכן לגרסה ${ltr(this.apk.summary.versionName ?? "?")}.` });
  }

  private viewChecks(): HTMLElement {
    const rows = CHECK_ORDER.map((id) => this.viewCheck(id));
    const blocking = CHECK_ORDER.some((id) => ["fail", "running", "pending"].includes(this.checks[id].status));
    return this.card(
      "בדיקות לפני ההתקנה",
      h("p", { class: "sw-muted" }, "כל בדיקה שנכשלה מסבירה מה לעשות. אחרי התיקון לוחצים \"בדיקה מחדש\"."),
      h("ul", { class: "sw-checks" }, rows),
      this.nav({
        back: "connect",
        next: { label: "המשך לסיכום", disabled: blocking, onClick: () => this.go("plan") },
      }),
    );
  }

  private viewCheck(id: CheckId): HTMLElement {
    const c = this.checks[id];
    const retry = h("button", { type: "button", class: "sw-btn sw-btn-small", disabled: c.status === "running", onclick: () => void this.runCheck(id) }, "בדיקה מחדש");
    const extra: Child[] = [];

    if (id === "accounts" && c.status === "fail" && this.accounts.length) {
      extra.push(
        h("ul", { class: "sw-accounts", dir: "auto" }, this.accounts.map((a) => h("li", null, `${maskAccount(a.name)} (${accountTypeName(a.type)})`))),
        h(
          "div",
          { class: "sw-actions" },
          h("button", { type: "button", class: "sw-btn sw-btn-small sw-btn-primary", onclick: () => this.device && void openAccountSettings(this.device, this.log) }, "פתיחת הגדרות החשבונות במכשיר"),
        ),
        this.accountsPoll
          ? h("p", { class: "sw-status" }, spinner(), h("span", null, `ממתינים להסרת החשבונות. הבדיקה מתעדכנת לבד (עוד ${Math.max(0, Math.ceil((this.accountsDeadline - Date.now()) / 60000))} דקות).`))
          : null,
      );
    }

    if (id === "apk") {
      if (c.status === "running" && this.apkProgress) {
        const { received, total } = this.apkProgress;
        extra.push(h("div", { class: "sw-status" }, h("span", null, `מוריד... ${formatBytes(received)}${total ? ` מתוך ${formatBytes(total)}` : ""}`), progressBar(total ? received / total : undefined)));
      }
      if (this.apk && c.status === "ok") {
        extra.push(
          h(
            "dl",
            { class: "sw-kv" },
            h("dt", null, "SHA-256"),
            h("dd", { dir: "ltr" }, this.apk.summary.sha256),
            this.apk.summary.certSha256 ? [h("dt", null, "חתימה"), h("dd", { dir: "ltr" }, fingerprint(this.apk.summary.certSha256))] : null,
          ),
        );
        if (this.apk.source === "local" && !this.apk.release?.certSha256) {
          extra.push(h("div", { class: "sw-note" }, "לא ניתן היה לוודא מול האתר שהחתימה רשמית. השוו את טביעת האצבע של החתימה לזו שמופיעה בעמוד ההורדות."));
        }
      }
      const input = h("input", { type: "file", accept: ".apk,application/vnd.android.package-archive", class: "sw-hidden" }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const f = input.files?.[0];
        if (f) void this.pickLocalFile(f);
      });
      const pick = h("button", { type: "button", class: "sw-btn sw-btn-small", onclick: () => input.click() }, "בחירת קובץ מהמחשב");
      const adv = h(
        "details",
        { class: "sw-advanced", open: this.advancedOpen },
        h("summary", null, "מתקדם"),
        h(
          "div",
          { class: "sw-radio" },
          h("span", null, "מסלול גרסאות:"),
          radio("sw-channel", "stable", "יציבה (מומלץ)", this.channel === "stable", () => this.setChannel("stable")),
          radio("sw-channel", "beta", "בטא", this.channel === "beta", () => this.setChannel("beta")),
        ),
      );
      adv.addEventListener("toggle", () => (this.advancedOpen = (adv as HTMLDetailsElement).open));
      extra.push(h("div", { class: "sw-actions" }, pick, input), adv);
    }

    return h(
      "li",
      { class: `sw-check-row ${c.status}` },
      h("span", { class: "sw-check-icon", "aria-hidden": "true" }, statusIcon(c.status)),
      h(
        "div",
        { class: "sw-check-main" },
        h("div", { class: "sw-check-head" }, h("strong", null, CHECK_TITLES[id]), h("span", { class: "sw-visually-hidden" }, statusLabel(c.status))),
        c.summary ? h("p", { class: "sw-check-summary", dir: "auto" }, c.summary) : null,
        c.status === "fail" && c.error ? this.errorBox(c.error, retry) : null,
        ...extra,
        c.status === "warn" ? h("div", { class: "sw-actions" }, retry) : null,
      ),
    );
  }

  private setChannel(ch: Channel): void {
    if (this.channel === ch) return;
    this.channel = ch;
    this.log("info", `Channel: ${ch}`);
    if (this.apk?.source !== "local") {
      this.apk = null;
      void this.runCheck("apk");
    } else {
      this.render();
    }
  }

  // ---------------------------------------------------------------- step 6: plan

  private viewPlan(): HTMLElement {
    const info = this.info!;
    const apk = this.apk!;
    const update = this.mode === "update";
    const actions = update
      ? ["העתקת קובץ ההתקנה למכשיר.", "עדכון האפליקציה (בלי למחוק אותה ובלי לשנות את ההגדרות).", "פתיחת האפליקציה."]
      : ["העתקת קובץ ההתקנה למכשיר.", "התקנת האפליקציה.", "הגדרת שני שבילין כמנהלת המכשיר.", "פתיחת האפליקציה להמשך ההגדרה במכשיר."];
    return this.card(
      update ? "סיכום: עדכון" : "סיכום: התקנה חדשה",
      h(
        "dl",
        { class: "sw-kv" },
        h("dt", null, "מכשיר"),
        h("dd", { dir: "auto" }, `${info.manufacturer} ${info.model}`),
        h("dt", null, "אנדרואיד"),
        h("dd", null, `${info.release} (SDK ${info.sdk})`),
        h("dt", null, "גרסה להתקנה"),
        h("dd", null, `${ltr(apk.summary.versionName ?? "?")}${apk.channel === "beta" ? " (בטא)" : ""}`),
        h("dt", null, "קובץ"),
        h("dd", { dir: "auto" }, `${ltr(apk.fileName)}, ${formatBytes(apk.summary.size)}`),
        this.pkg?.installed ? [h("dt", null, "מותקנת כעת"), h("dd", null, ltr(this.pkg.versionName ?? "?"))] : null,
      ),
      h("h3", { class: "sw-sub" }, "מה יתבצע"),
      h("ol", { class: "sw-list" }, actions.map((a) => h("li", null, a))),
      h("div", { class: "sw-note" }, "אין לנתק את הכבל עד סיום ההתקנה. אם המכשיר שואל אם לאשר את ההתקנה, מאשרים."),
      this.nav({ back: "checks", next: { label: update ? "התחלת העדכון" : "התחלת ההתקנה", onClick: () => this.go("install") } }),
    );
  }

  // ---------------------------------------------------------------- step 7: install

  private async runInstall(): Promise<void> {
    const dev = this.device;
    if (!dev || !this.apk) return;
    this.busy = true;
    this.phase = "running";
    this.phaseText = "מעתיקים את הקובץ למכשיר...";
    this.installProgress = { sent: 0, total: this.apk.bytes.length };
    this.render();
    const wasInstalled = !!this.pkg?.installed;
    try {
      await installApk(dev, this.apk, this.log, (sent, total) => {
        this.installProgress = { sent, total };
        if (sent >= total) this.phaseText = "מתקינים...";
        this.render();
      });
      this.installedFresh = !wasInstalled;
      this.log("info", "Install OK");
      this.busy = false;
      this.go(this.mode === "update" ? "done" : "owner");
    } catch (e) {
      this.busy = false;
      this.phase = "fail";
      this.log("error", `Install failed: ${(e as Error).message}`);
      this.stepError = describeError(e);
      await cleanupTemp(dev, this.log).catch(() => undefined);
      this.render();
    }
  }

  private viewInstall(): HTMLElement {
    const p = this.installProgress;
    return this.card(
      this.mode === "update" ? "עדכון" : "התקנה",
      this.phase === "running"
        ? h(
            "div",
            { class: "sw-status" },
            spinner(),
            h("span", null, this.phaseText),
            p && p.sent < p.total ? progressBar(p.total ? p.sent / p.total : undefined) : progressBar(undefined),
          )
        : null,
      this.phase === "running" ? h("p", { class: "sw-muted" }, "אם המכשיר שואל אם לאשר את ההתקנה, מאשרים.") : null,
      this.stepError
        ? this.errorBox(
            this.stepError,
            h("button", { type: "button", class: "sw-btn sw-btn-small sw-btn-primary", onclick: () => this.go("install") }, "ניסיון חוזר"),
            h("button", { type: "button", class: "sw-btn sw-btn-small", onclick: () => this.go("checks") }, "חזרה לבדיקות"),
          )
        : null,
    );
  }

  // ---------------------------------------------------------------- step 8: device owner

  private async runOwner(): Promise<void> {
    const dev = this.device;
    if (!dev) return;
    this.busy = true;
    this.phase = "running";
    this.uninstallResult = null;
    this.render();
    try {
      await setDeviceOwner(dev, this.log);
      this.log("info", "Device owner set");
      this.busy = false;
      this.go("done");
    } catch (e) {
      this.busy = false;
      this.phase = "fail";
      this.log("error", `Device owner failed: ${(e as Error).message}`);
      this.stepError = describeError(e);
      this.render();
    }
  }

  private async uninstallHalf(): Promise<void> {
    if (!this.device) return;
    this.busy = true;
    this.render();
    try {
      const ok = await uninstallApp(this.device, this.log);
      this.uninstallResult = ok ? "האפליקציה הוסרה מהמכשיר." : "ההסרה נכשלה. הפרטים ביומן.";
      if (ok) this.installedFresh = false;
    } catch (e) {
      this.uninstallResult = `ההסרה נכשלה: ${(e as Error).message}`;
    }
    await cleanupTemp(this.device, this.log).catch(() => undefined);
    this.busy = false;
    this.render();
  }

  private viewOwner(): HTMLElement {
    return this.card(
      "הגדרת מנהל המכשיר",
      this.phase === "running" ? h("div", { class: "sw-status" }, spinner(), h("span", null, "מגדירים את שני שבילין כמנהלת המכשיר...")) : null,
      this.stepError
        ? this.errorBox(
            this.stepError,
            h("button", { type: "button", class: "sw-btn sw-btn-small sw-btn-primary", disabled: this.busy, onclick: () => this.go("owner") }, "ניסיון חוזר"),
            h("button", { type: "button", class: "sw-btn sw-btn-small", disabled: this.busy, onclick: () => this.go("checks") }, "חזרה לבדיקות"),
            this.installedFresh
              ? h("button", { type: "button", class: "sw-btn sw-btn-small sw-btn-danger", disabled: this.busy, onclick: () => void this.uninstallHalf() }, "הסרת האפליקציה שהותקנה")
              : null,
          )
        : null,
      this.stepError && this.installedFresh
        ? h("p", { class: "sw-muted" }, "האפליקציה הותקנה אבל אינה מנהלת את המכשיר. אפשר לתקן את הבעיה ולנסות שוב, או להסיר אותה.")
        : null,
      this.uninstallResult ? h("div", { class: "sw-note" }, this.uninstallResult) : null,
    );
  }

  // ---------------------------------------------------------------- step 9: done

  private async runDone(): Promise<void> {
    const dev = this.device;
    if (!dev) return;
    this.busy = true;
    try {
      await launchApp(dev, this.log);
    } catch (e) {
      this.log("warn", `Launch failed: ${(e as Error).message}`);
    }
    await cleanupTemp(dev, this.log);
    this.busy = false;
    this.log("info", "Done");
    this.render();
  }

  private viewDone(): HTMLElement {
    const update = this.mode === "update";
    return this.card(
      update ? "העדכון הושלם" : "ההתקנה הושלמה",
      h("div", { class: "sw-success" }, statusIcon("ok"), h("strong", null, update ? "שני שבילין עודכנה בהצלחה." : "שני שבילין הותקנה והוגדרה כמנהלת המכשיר.")),
      update
        ? h("p", null, "האפליקציה נפתחה במכשיר. כל ההגדרות נשמרו.")
        : h(
            "div",
            null,
            h("p", null, "ממשיכים את ההגדרה במכשיר עצמו:"),
            h("ol", { class: "sw-list" }, h("li", null, "בוחרים מסלול סינון."), h("li", null, "קובעים סיסמת הסרה ושומרים אותה במקום בטוח. אין דרך לשחזר אותה."), h("li", null, "לוחצים \"החל הגדרות\".")),
          ),
      h("p", { class: "sw-muted" }, "אפשר לנתק את הכבל. מומלץ לכבות את ניפוי הבאגים ב-USB באפשרויות המפתחים."),
      h("p", null, "מדריך שימוש: ", this.link("/guide/", "מדריך"), ". תקלה? ", this.link("/help/", "פתרון בעיות"), "."),
    );
  }
}

// ---------------------------------------------------------------- helpers

/** Isolates a left-to-right token (version, file name) inside Hebrew text. */
function ltr(s: string): string {
  return `⁦${s}⁩`;
}

function freshChecks(): Record<CheckId, CheckState> {
  return Object.fromEntries(CHECK_ORDER.map((id) => [id, { status: "pending" }])) as Record<CheckId, CheckState>;
}

function spinner(): HTMLElement {
  return h("span", { class: "sw-spinner", "aria-hidden": "true" });
}

function progressBar(fraction: number | undefined): HTMLElement {
  const el = h("div", { class: `sw-progress${fraction === undefined ? " indeterminate" : ""}`, role: "progressbar" });
  if (fraction !== undefined) {
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    el.setAttribute("aria-valuenow", String(pct));
    el.append(h("span", { style: `width:${pct}%` }));
  } else {
    el.append(h("span"));
  }
  return el;
}

function radio(name: string, value: string, label: string, checked: boolean, onChange: () => void): HTMLElement {
  const input = h("input", { type: "radio", name, value, checked }) as HTMLInputElement;
  input.addEventListener("change", () => input.checked && onChange());
  return h("label", null, input, h("span", null, label));
}

function statusIcon(s: CheckStatus): string {
  return { pending: "○", running: "◌", ok: "✓", warn: "!", fail: "✕", skip: "-" }[s];
}

function statusLabel(s: CheckStatus): string {
  return { pending: "ממתין", running: "בבדיקה", ok: "תקין", warn: "אזהרה", fail: "נכשל", skip: "לא נדרש" }[s];
}

export function mountWizard(options: WizardOptions): Wizard {
  return new Wizard(options);
}

