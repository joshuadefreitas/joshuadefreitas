#!/usr/bin/env node
/**
 * Profile checker.   node scripts/check-profile.mjs [--render] [--private-denylist <file outside the repo>]
 *
 * Static checks (always): stale generated files, broken local paths, external image hosts, alt text, <script> and other
 * active SVG content, oversized SVGs, missing dark/light pairs, text contrast, vendored icons and notice, private-card
 * disclosure rules.  --render additionally lays every text element out in headless Chromium and fails if any text
 * overflows its header/strip (needs a `chromium` binary; skipped with a clear message if absent).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build, loadProfile } from "./generate-profile-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = loadProfile();
const results = [];
const check = (label, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`); };

const read = (p) => readFileSync(resolve(root, p), "utf8");
const walk = (dir) => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

// ------------------------------------------------------------------------------------------------ stale generated files
const generated = build(profile);
const stale = [...generated].filter(([p, t]) => !existsSync(resolve(root, p)) || read(p) !== t).map(([p]) => p);
check("generated assets and README are current (not stale)", stale.length === 0, stale.length ? stale.slice(0, 4).join(", ") : `${generated.size} files`);
const generatedDirs = ["assets/cards", "assets/tiles"];
const extra = [...generatedDirs.flatMap(walk), ...readdirSync(resolve(root, "assets")).filter((f) => /^(focus|tech)-strip-.*\.svg$/.test(f)).map((f) => `assets/${f}`)].filter((p) => !generated.has(p));
check("no orphaned generated SVGs (everything on disk is produced from data/profile.json)", extra.length === 0, extra.join(", "));

// ------------------------------------------------------------------------------------------------ README references
const readme = read("README.md");
const imgTags = [...readme.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const urls = [...readme.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
const allowedPrefix = (u) => u.startsWith(`https://raw.githubusercontent.com/${profile.repo}/`);
const externalImages = urls.filter((u) => !allowedPrefix(u));
check("every image/srcset URL is our own GitHub-hosted asset (no external image hosts)", externalImages.length === 0, externalImages.join(", "));
const localOf = (u) => u.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, "");
const missing = urls.filter(allowedPrefix).map(localOf).filter((p) => !existsSync(resolve(root, p)));
check("every referenced asset exists locally (no broken paths)", missing.length === 0, missing.slice(0, 4).join(", "));
const refs = urls.filter(allowedPrefix).map((u) => u.split("/")[5]);
check("generated assets are referenced at the configured ref; the hero stays on main", refs.every((r) => r === profile.asset_ref || r === "main"), [...new Set(refs)].join(", "));
check("every <img> has non-empty alt text", imgTags.length > 0 && imgTags.every((t) => /\balt="[^"]+"/.test(t)), `${imgTags.length} images`);
const bannedHosts = ["shields.io", "komarev", "vercel.app", "github-readme-stats", "trophy", "streak-stats", "capsule-render", "readme-typing-svg", "activity-graph"];
check("no badge, stats, trophy or activity services referenced", !bannedHosts.some((h) => readme.includes(h)), bannedHosts.filter((h) => readme.includes(h)).join(", "));
check("no <script>, <iframe>, inline style or event handlers in the README", !/<script|<iframe|\sstyle=|\son[a-z]+=/i.test(readme));

// dark/light pairs
const pictures = [...readme.matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((m) => m[1]);
const pairProblems = [];
for (const body of pictures) {
  const dark = body.match(/media="\(prefers-color-scheme: dark\)"\s+srcset="([^"]+)"/), light = body.match(/media="\(prefers-color-scheme: light\)"\s+srcset="([^"]+)"/);
  if (!dark || !light) pairProblems.push("picture without both dark and light sources");
  else if (/hero/.test(dark[1])) continue;
  else if (dark[1].replace("-dark.svg", "") !== light[1].replace("-light.svg", "")) pairProblems.push(`mismatched pair ${dark[1]}`);
}
check("every picture has a matching dark and light source", pictures.length > 0 && pairProblems.length === 0, pairProblems[0] || `${pictures.length} pictures`);
const svgNames = new Set(walk("assets").filter((p) => p.endsWith(".svg") && !p.includes("/icons/") && !p.includes("hero-")));
const unpaired = [...svgNames].filter((p) => !svgNames.has(p.replace(/-(dark|light)\.svg$/, (m, t) => (t === "dark" ? "-light.svg" : "-dark.svg"))));
check("every generated SVG has its dark/light counterpart on disk", unpaired.length === 0, unpaired.slice(0, 3).join(", "));

// ------------------------------------------------------------------------------------------------ SVG hygiene
const svgFiles = walk("assets").filter((p) => p.endsWith(".svg") && !p.includes("/icons/"));
const activePattern = /<script|javascript:|\son[a-z]+\s*=|<foreignObject|@import|<image\b|url\(\s*["']?https?:|(?:xlink:)?href\s*=\s*["']https?:|<iframe|@font-face/i;
const svgActive = svgFiles.filter((p) => activePattern.test(read(p)));
check("no <script>, event handler, foreignObject, @import, embedded or remote resource in any SVG", svgActive.length === 0, svgActive.slice(0, 3).join(", "));
const svgLimit = (p) => p === "assets/hero-dark.svg" ? 70000 : p === "assets/hero-light.svg" ? 40000 : profile.limits.max_svg_bytes;
const oversized = svgFiles.filter((p) => statSync(resolve(root, p)).size > svgLimit(p));
check(`no SVG larger than ${profile.limits.max_svg_bytes} bytes (hero 70/40 KB)`, oversized.length === 0, oversized.map((p) => `${p} ${statSync(resolve(root, p)).size}`).join(", "));
const noTitle = svgFiles.filter((p) => !/role="img"/.test(read(p)) || !/<title[^>]*>[^<]+<\/title>/.test(read(p)) || !/aria-label(?:ledby)?="[^"]+"/.test(read(p)));
check("every SVG has role=img, a <title> and an accessible label", noTitle.length === 0, noTitle.slice(0, 3).join(", "));
const fontFamilies = new Set(svgFiles.flatMap((p) => [...read(p).matchAll(/font-family="([^"]+)"/g)].map((m) => m[1])));
const webFonts = [...fontFamilies].filter((f) => /\b(roboto|inter|poppins|montserrat|open sans|fira|jetbrains|google)\b/i.test(f));
check("only system font stacks (no external or web fonts)", webFonts.length === 0, [...fontFamilies].length + " stacks");

// ------------------------------------------------------------------------------------------------ contrast
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
for (const theme of ["dark", "light"]) {
  const p = profile.palette[theme];
  const rows = ["text", "muted", "faint", "blue", "copper"].map((k) => [k, contrast(p[k], p.panel)]);
  const bad = rows.filter(([, r]) => r < profile.limits.min_contrast);
  check(`${theme}: all text colours reach ${profile.limits.min_contrast}:1 contrast on the panel`, bad.length === 0, rows.map(([k, r]) => `${k} ${r.toFixed(1)}`).join(" "));
}

// ------------------------------------------------------------------------------------------------ icons
const iconFiles = profile.tech.map((t) => `assets/icons/${t.slug}.svg`).concat(profile.cards.map((c) => `assets/icons/${c.tech.icon}.svg`));
check("every technology icon used is vendored under assets/icons", iconFiles.every((f) => existsSync(resolve(root, f))), iconFiles.filter((f) => !existsSync(resolve(root, f))).join(", "));
const notice = existsSync(resolve(root, "assets/ICONS-NOTICE.md")) ? read("assets/ICONS-NOTICE.md") : "";
check("ICONS-NOTICE.md records the source, exact version, CC0 licence and the trademark disclaimer", /simple-icons/i.test(notice) && /\d+\.\d+\.\d+/.test(notice) && /CC0/.test(notice) && /trademark/i.test(notice));

// ------------------------------------------------------------------------------------------------ disclosure
const privateCards = profile.cards.filter((c) => c.visibility === "PRIVATE");
check("private cards carry no link and no repo URL", privateCards.every((c) => c.href === null) && privateCards.every((c) => !JSON.stringify(c).includes("github.com")));
// Public layer: generic rules only. Project-specific and sensitive terms are NOT kept in this repository; see the private layer below.
const deny = [/\/home\//, /\.local\//, /\bEY\b/, /ernst/i, /client/i, /tailscale/i, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /\b[a-z0-9-]+\.(?:local|lan|internal|ts\.net)\b/i];
const surface = [readme, ...[...generated].filter(([p]) => p.endsWith(".svg")).map(([, t]) => t.replace(/<path d="[^"]+"/g, "<path"))].join("\n");
const leaks = deny.filter((re) => re.test(surface)).map(String);
check("no local paths, hostnames, IP addresses, or employer/client terms anywhere in the README or SVG text", leaks.length === 0, leaks.join(" "));
const allowedHosts = new Set(["github.com", "raw.githubusercontent.com", "joshuadefreitas.github.io", "sekiyalab.github.io", "www.linkedin.com", "www.npmjs.com"]);
const allUrls = [...(readme + JSON.stringify(profile)).matchAll(/https?:\/\/[^\s"')<>\]]+/g)].map((m) => m[0]);
const badHosts = allUrls.filter((u) => !allowedHosts.has(new URL(u).host));
check("every URL points at an allowed public host", badHosts.length === 0, badHosts.slice(0, 3).join(", "));
const publicRepos = new Set([profile.repo.toLowerCase(), ...[...profile.public_work.map((w) => w.url), ...profile.cards.map((c) => c.href).filter(Boolean)].map((u) => (u.match(/github\.com\/([^/]+\/[^/]+)/) || [])[1]?.toLowerCase()).filter(Boolean)]);
const repoUrls = allUrls.map((u) => (u.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+)/) || [])[1]).filter(Boolean).map((r) => r.toLowerCase());
const stray = repoUrls.filter((r) => !publicRepos.has(r));
check("every GitHub repository URL is one of the listed public repositories (no private repo URLs)", stray.length === 0, stray.slice(0, 3).join(", "));

// Private layer: sensitive denylist lives OUTSIDE this repository. Supply it with --private-denylist <file> or PROFILE_PRIVATE_DENYLIST.
// One case-insensitive extended regex per line, '#' comments. Scans every file that could become public (tracked or not ignored),
// including this script and data/profile.json. Only pattern numbers and file paths are ever printed, never the patterns.
const argIdx = process.argv.indexOf("--private-denylist");
const privateList = argIdx > 0 ? process.argv[argIdx + 1] : process.env.PROFILE_PRIVATE_DENYLIST;
if (!privateList) {
  console.log("SKIP  private disclosure gate not run (no --private-denylist / PROFILE_PRIVATE_DENYLIST); required before merge");
} else {
  const patterns = readFileSync(privateList, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "i"));
  const listed = spawnSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).stdout.split("\n").filter((f) => f && existsSync(resolve(root, f)));
  const hits = [];
  for (const f of listed) {
    if (/\.(gif|png|jpe?g|webp|ico)$/i.test(f)) continue;
    const text = readFileSync(resolve(root, f), "utf8");
    patterns.forEach((re, i) => { if (re.test(text)) hits.push(`#${i + 1}@${f}`); });
  }
  check(`private disclosure gate: ${patterns.length} private patterns over ${listed.length} publishable files`, hits.length === 0, hits.slice(0, 6).join(" "));
}
const parityCard = profile.cards.find((c) => c.id === "parity");
check("parity card states no backend results (no pass/fail/result wording)", !/\b(pass|fail|result|verdict|nvidia|intel)\b/i.test(parityCard.evidence + parityCard.thesis));
check("as_of provenance date is present in data/profile.json", /^\d{4}-\d{2}-\d{2}$/.test(profile.as_of));
check("the positioning sentence comes from data/profile.json and appears in the README", profile.positioning.length > 20 && readme.includes(profile.positioning));

// ------------------------------------------------------------------------------------------------ render: text overflow
if (process.argv.includes("--render")) {
  const chromium = ["chromium", "chromium-browser", "google-chrome"].find((b) => spawnSync("which", [b]).status === 0);
  if (!chromium) check("render overflow check", false, "no chromium binary found");
  else {
    const tmp = mkdtempSync(join(tmpdir(), "profile-render-"));
    const svgs = [...generated].filter(([p]) => p.endsWith(".svg"));
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0">${svgs.map(([p, t], i) => `<div data-n="${p}" style="display:block">${t.replace("<svg ", `<svg id="s${i}" `)}</div>`).join("")}<pre id="out"></pre><script>
      const bad=[];
      for (const d of document.querySelectorAll('[data-n]')) {
        const svg=d.querySelector('svg'), vb=svg.viewBox.baseVal, name=d.dataset.n, isCard=name.includes('/cards/');
        for (const t of svg.querySelectorAll('text')) {
          const b=t.getBBox(), pad=isCard||name.includes('/tiles/')?1:6;
          if (b.x<pad-0.5||b.x+b.width>vb.width-pad+0.5) bad.push(name+': "'+t.textContent.slice(0,40)+'" x '+b.x.toFixed(1)+'..'+(b.x+b.width).toFixed(1)+' of '+vb.width);
          if (b.y<2||b.y+b.height>vb.height-2) bad.push(name+': "'+t.textContent.slice(0,40)+'" y out of bounds');
          if (isCard && t.getAttribute('font-size')==='14.5' && b.x+b.width>356) bad.push(name+': thesis runs into the motif');
        }
      }
      document.getElementById('out').textContent=JSON.stringify({count:document.querySelectorAll('svg').length,bad});
    </script>`;
    const file = join(tmp, "render.html");
    writeFileSync(file, html);
    const run = spawnSync(chromium, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 60000 });
    rmSync(tmp, { recursive: true, force: true });
    const m = (run.stdout || "").match(/<pre id="out">([^<]*)<\/pre>/);
    if (!m) check("render overflow check", false, "chromium produced no result: " + (run.stderr || "").slice(0, 120));
    else {
      const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      check(`no text overflows its header or strip when laid out in Chromium (${out.count} SVGs, system fonts)`, out.bad.length === 0, out.bad.slice(0, 3).join(" | "));
    }
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${failed ? `${failed} CHECK(S) FAILED` : `ALL ${results.length} CHECKS PASSED`}`);
process.exit(failed ? 1 : 0);
