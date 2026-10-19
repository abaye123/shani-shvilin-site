// Regenerates src/data/help-content.json from the app's in-app help (HelpContent.kt).
// Run manually when the app's help text changes: node scripts/sync-help.mjs [path-to-HelpContent.kt]
import { readFileSync, writeFileSync } from "node:fs";

const src =
  process.argv[2] ??
  "../shani-shvilin/feature/launcher/src/main/kotlin/com/abaye/shanishvilin/feature/launcher/info/HelpContent.kt";
const kt = readFileSync(src, "utf8");
const start = kt.indexOf("listOf(", kt.indexOf("val sections"));
const end = kt.lastIndexOf(")");
// Kotlin string literals and JS string literals share the escapes used in that file.
const expr = kt.slice(start, end + 1).replace(/listOf\(/g, "L(").replace(/HelpSection\(/g, "S(").replace(/HelpTopic\(/g, "T(");
const L = (...items) => items;
const S = (title, topics) => ({ title, topics });
const T = (title, body) => ({ title, body });
const sections = new Function("L", "S", "T", `return ${expr};`)(L, S, T);
writeFileSync("src/data/help-content.json", JSON.stringify(sections, null, 2) + "\n");
console.log(`${sections.length} sections, ${sections.reduce((n, s) => n + s.topics.length, 0)} topics`);
