/** Tiny DOM builder. Children that are strings become text nodes, so nothing is parsed as HTML. */
export type Child = Node | string | number | null | undefined | false | Child[];

export type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" }, text);
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** A command line with a copy button. */
export function commandLine(cmd: string): HTMLElement {
  const btn = h("button", { type: "button", class: "sw-copy", "aria-label": "העתקה" }, "העתקה");
  btn.addEventListener("click", async () => {
    if (await copyText(cmd)) {
      btn.textContent = "הועתק";
      setTimeout(() => (btn.textContent = "העתקה"), 1500);
    }
  });
  return h("div", { class: "sw-cmd", dir: "ltr" }, h("code", null, cmd), btn);
}
