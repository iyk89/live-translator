// Copies the PDF.js runtime assets (character maps, standard fonts, image
// decoders, colour profiles) into public/pdfjs so they are served locally.
import fs from "node:fs";
import path from "node:path";

const source = path.resolve("node_modules/pdfjs-dist");
const target = path.resolve("public/pdfjs");
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const from = path.join(source, dir);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(target, dir), { recursive: true });
}
const version = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(target, "VERSION"), `${version}\n`);
console.log(`pdf.js ${version} assets copied to public/pdfjs`);
