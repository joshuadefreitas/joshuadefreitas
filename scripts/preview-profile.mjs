#!/usr/bin/env node
/**
 * Renders a local preview of README.md at a given width and colour scheme with headless Chromium (needs a `chromium` binary).
 *   node scripts/preview-profile.mjs --theme dark --width 830 --out /tmp/profile-dark.png
 * The page imitates GitHub's markdown column (system font, same type scale, table borders) and swaps every <picture> for the
 * matching local asset, so it previews our SVGs, not GitHub's sanitiser. Final verification should still be done on github.com.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const theme = arg("theme", "dark"), width = Number(arg("width", "830")), out = arg("out", `/tmp/profile-${theme}-${width}.png`);
const dark = theme === "dark";
const profile = JSON.parse(readFileSync(resolve(root, "data/profile.json"), "utf8"));
let md = readFileSync(resolve(root, "README.md"), "utf8");
const local = (u) => "file://" + resolve(root, u.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
md = md.replace(/<picture>[\s\S]*?<\/picture>/g, (block) => {
  const pick = block.match(new RegExp(`media="\\(prefers-color-scheme: ${theme}\\)"\\s+srcset="([^"]+)"`))[1];
  const alt = block.match(/alt="([^"]*)"/)[1], w = block.match(/\swidth="([\d%]+)"/);
  return `<img src="${local(pick)}" alt="${alt}"${w ? ` width="${w[1]}"` : ""}>`;
});
const inline = (t) => t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
const blocks = md.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
  if (b.startsWith("# ")) return `<h1>${b.slice(2)}</h1>`;
  if (b.startsWith("### ")) return `<h3>${b.slice(4)}</h3>`;
  if (b.startsWith("- ")) return `<ul>${b.split("\n").map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
  if (b.startsWith("|")) {
    const rows = b.split("\n").filter((r, i) => i !== 1).map((r) => r.split("|").slice(1, -1).map((c) => c.trim()));
    return `<table><thead><tr>${rows[0].map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  return `<p>${inline(b)}</p>`;
});
const c = dark ? { bg: "#0d1117", fg: "#e6edf3", muted: "#8d96a0", border: "#30363d", link: "#4493f8", row: "#151b23" } : { bg: "#ffffff", fg: "#1f2328", muted: "#59636e", border: "#d1d9e0", link: "#0969da", row: "#f6f8fa" };
const html = `<!doctype html><meta charset="utf-8"><style>
html{background:${c.bg}} body{margin:0;padding:24px 0;background:${c.bg}}
.markdown-body{box-sizing:border-box;width:${width}px;margin:0 auto;padding:0 ${width > 600 ? 32 : 16}px;color:${c.fg};font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;word-wrap:break-word}
.markdown-body img{max-width:100%;height:auto;box-sizing:content-box;vertical-align:middle;border-style:none}
h1{font-size:2em;margin:.67em 0;padding-bottom:.3em;border-bottom:1px solid ${c.border};font-weight:600}
ul{padding-left:2em;margin:0 0 16px} li{margin-top:.25em} h3{font-size:1.25em;margin:24px 0 16px;font-weight:600} p{margin:0 0 16px} a{color:${c.link};text-decoration:none} sub{font-size:75%;color:${c.muted}}
table{border-spacing:0;border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;margin:0 0 16px} th,td{padding:6px 13px;border:1px solid ${c.border}} th{font-weight:600} tr:nth-child(2n){background:${c.row}}
</style><body><div class="markdown-body" id="page">${blocks.join("\n")}</div><script>addEventListener("load",()=>setTimeout(()=>document.body.setAttribute("data-h",String(document.documentElement.scrollHeight+24)),300))</script>`;
const tmp = mkdtempSync(join(tmpdir(), "profile-preview-"));
const file = join(tmp, "preview.html");
writeFileSync(file, html);
const chromium = ["chromium", "chromium-browser", "google-chrome"].find((b) => spawnSync("which", [b]).status === 0);
if (!chromium) { console.error("no chromium binary found"); process.exit(2); }
const probe = spawnSync(chromium, ["--headless", "--no-sandbox", "--disable-gpu", "--allow-file-access-from-files", `--window-size=${width + 48},800`, "--virtual-time-budget=4000", "--dump-dom", `file://${file}`.replace(".html", ".html")], { encoding: "utf8" });
const height = Math.max(600, Math.ceil((probe.stdout.match(/data-h="(\d+)"/) || [0, 1400])[1]));
spawnSync(chromium, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", `--window-size=${width + 48},${height}`, "--virtual-time-budget=4000", `--screenshot=${out}`, `file://${file}`], { encoding: "utf8" });
rmSync(tmp, { recursive: true, force: true });
console.log(`${out} (${width + 48}x${height})`);
