// One-off helper: converts the IBM Plex Sans Hebrew TTFs from the app repo into
// self-hosted woff2 files under public/fonts. The output is committed, so this only
// needs to run again if the fonts change.
import { readFile, writeFile } from "node:fs/promises";
import { compress } from "wawoff2";

const SRC = process.argv[2] ?? "../shani-shvilin/core/designsystem/src/main/res/font";
const WEIGHTS = ["regular", "medium", "semibold", "bold"];

for (const w of WEIGHTS) {
  const ttf = await readFile(`${SRC}/plex_sans_hebrew_${w}.ttf`);
  const out = await compress(ttf);
  await writeFile(`public/fonts/plex-sans-hebrew-${w}.woff2`, out);
  console.log(`${w}: ${ttf.length} -> ${out.length} bytes`);
}
