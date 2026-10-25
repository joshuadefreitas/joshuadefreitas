#!/usr/bin/env node
/**
 * Generates the profile's local SVG assets and README.md from ONE source of truth: data/profile.json.
 *
 *   node scripts/generate-profile-assets.mjs            write everything
 *   node scripts/generate-profile-assets.mjs --check    exit 1 if any generated file differs from disk
 *
 * Deterministic: no network, no external fonts, no clock. Same JSON in, same bytes out.
 * The hero (assets/hero-*.svg|gif) is produced by generate-hero.mjs and is not touched here.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES = ["dark", "light"];

// ------------------------------------------------------------------------------------------------ text metrics
// Conservative width estimates (em fractions) so that wrapped text cannot overflow on any common system font.
// The render check (check-profile.mjs --render) verifies this against real layout in Chromium.
const SANS_NARROW = new Set("iljtfI.,:;'!|()[]/ ·");
const SANS_WIDE = new Set("mwMW@%");
function sansWidth(text, size) {
  let em = 0;
  for (const ch of text) {
    if (SANS_NARROW.has(ch)) em += 0.30;
    else if (SANS_WIDE.has(ch)) em += 0.88;
    else if (ch >= "A" && ch <= "Z") em += 0.70;
    else if (ch >= "0" && ch <= "9") em += 0.58;
    else em += 0.55;
  }
  return em * size * 1.08; // 8% safety margin on top of already generous per-glyph widths
}
function monoWidth(text, size, tracking = 0) {
  return [...text].length * (size * 0.62 + tracking);
}
function wrap(text, maxWidth, size, maxLines) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (sansWidth(candidate, size) <= maxWidth || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) throw new Error(`text needs ${lines.length} lines (max ${maxLines}): ${text}`);
  for (const line of lines) if (sansWidth(line, size) > maxWidth) throw new Error(`unbreakable line too wide: ${line}`);
  return lines;
}
function wrapMono(text, maxWidth, size, maxLines) {
  const per = size * 0.62, cap = Math.floor(maxWidth / per), words = text.split(" "), lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if ([...candidate].length <= cap || !current) current = candidate; else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) throw new Error(`mono text needs ${lines.length} lines (max ${maxLines}): ${text}`);
  return lines;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n) => Number(n.toFixed(2));

// ------------------------------------------------------------------------------------------------ seeded motif
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** A small deterministic node/edge field inside a box, in the hero's visual language. */
function motif(id, box, p, accent) {
  const rand = mulberry32(hashString(id));
  const cols = 3, rows = 4, nodes = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    nodes.push([box.x + (c + 0.2 + rand() * 0.6) * (box.w / cols), box.y + (r + 0.2 + rand() * 0.6) * (box.h / rows), 2 + Math.floor(rand() * 3)]);
  }
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    const right = (i % cols) < cols - 1 ? i + 1 : -1, down = i + cols < nodes.length ? i + cols : -1;
    if (right >= 0 && rand() < 0.7) edges.push([i, right]);
    if (down >= 0 && rand() < 0.7) edges.push([i, down]);
  }
  const lit = new Set([Math.floor(rand() * nodes.length), Math.floor(rand() * nodes.length)]);
  let out = `<g opacity=".55">`;
  for (const [a, b] of edges) out += `<path d="M${num(nodes[a][0])} ${num(nodes[a][1])} L${num(nodes[b][0])} ${num(nodes[b][1])}" stroke="${p.edge}" stroke-width="1" fill="none"/>`;
  nodes.forEach(([x, y, r], i) => {
    out += lit.has(i)
      ? `<circle cx="${num(x)}" cy="${num(y)}" r="${r + 1}" fill="${p.panel2}" stroke="${accent}" stroke-width="1.4"/>`
      : `<circle cx="${num(x)}" cy="${num(y)}" r="${r}" fill="${p.panel2}" stroke="${p.edge}" stroke-width="1"/>`;
  });
  return out + `</g>`;
}

// ------------------------------------------------------------------------------------------------ glyphs (44x44 box)
function glyph(kind, p) {
  const e = p.edge, n = p.panel2, g = p.muted, b = p.blue, c = p.copper;
  const node = (x, y, r, col = g) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${n}" stroke="${col}" stroke-width="1.6"/>`;
  const line = (d, col = e) => `<path d="${d}" stroke="${col}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  switch (kind) {
    case "terminal": return line("M6 12 L22 22 L6 32") + line("M26 34 H40") + node(34, 12, 4, b) + line("M30 15 L24 20", e);
    case "loop": return line("M22 6 A16 16 0 0 1 38 22") + line("M38 22 A16 16 0 0 1 22 38") + line("M22 38 A16 16 0 0 1 6 22") + line("M6 22 A16 16 0 0 1 22 6") +
      node(22, 6, 4) + node(38, 22, 4, b) + node(22, 38, 4) + node(6, 22, 4) + node(22, 22, 3, c);
    case "lattice": {
      let s = "";
      for (let i = 0; i < 3; i++) { s += line(`M8 ${10 + i * 12} H36`) + line(`M${10 + i * 12} 8 V36`); }
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += node(10 + i * 12, 10 + j * 12, i === 1 && j === 1 ? 4 : 3, i === 1 && j === 1 ? b : g);
      return s;
    }
    case "series": return line("M4 38 H40") + line("M6 30 L14 22 L22 26 L30 12 L38 16", g) + node(6, 30, 3) + node(14, 22, 3) + node(22, 26, 3) + node(30, 12, 4, b) + node(38, 16, 3);
    case "layers": return line("M8 12 H36") + line("M8 22 H36") + line("M8 32 H36") + line("M22 12 V32", e) + node(22, 12, 4) + node(22, 22, 4, b) + node(22, 32, 4);
    case "boundary": return `<rect x="6" y="8" width="32" height="28" rx="3" fill="none" stroke="${e}" stroke-width="1.6" stroke-dasharray="3 3"/>` +
      line("M2 22 H15") + line("M29 22 H42") + node(22, 22, 6, c) + node(22, 22, 2, c);
    default: throw new Error("unknown glyph " + kind);
  }
}

// ------------------------------------------------------------------------------------------------ svg shells
function svg(width, height, title, body, extraDefs = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>${extraDefs}${body}</svg>\n`;
}
const F = (profile) => ({ sans: profile.fonts.sans.replace(/"/g, "'"), mono: profile.fonts.mono.replace(/"/g, "'") });

function pill(x, y, text, color, fonts) {
  const w = monoWidth(text, 10.5, 0.9) + 14;
  return { w, svg: `<rect x="${num(x)}" y="${y}" width="${num(w)}" height="20" rx="10" fill="none" stroke="${color}" stroke-width="1.1"/>` +
    `<text x="${num(x + w / 2)}" y="${y + 14}" text-anchor="middle" font-family="${fonts.mono}" font-size="10.5" letter-spacing=".9" fill="${color}">${esc(text)}</text>` };
}

// ------------------------------------------------------------------------------------------------ components
const iconCache = new Map();
function iconPath(slug) {
  if (!iconCache.has(slug)) {
    const file = resolve(root, "assets/icons", `${slug}.svg`);
    const m = readFileSync(file, "utf8").match(/<path d="([^"]+)"\/?>/);
    if (!m) throw new Error(`no single path in ${file}`);
    iconCache.set(slug, m[1]);
  }
  return iconCache.get(slug);
}

// One panel per strip; items flow left to right and wrap inside the panel, so GitHub never re-wraps them.
const STRIP_W = 480, STRIP_PAD = 16;
function flow(items, innerWidth, gap, rowHeight) {
  const rows = [[]]; let x = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > innerWidth) { rows.push([]); x = 0; }
    rows[rows.length - 1].push({ ...it, x }); x += it.w + gap;
  }
  return rows.map((r, i) => r.map((it) => ({ ...it, y: i * rowHeight })));
}

function focusStrip(profile, theme) {
  const p = profile.palette[theme], f = F(profile);
  const items = profile.focus.map((label) => ({ label, text: label.toUpperCase(), w: Math.ceil(monoWidth(label.toUpperCase(), 11, 0.8)) + 20 }));
  const rows = flow(items, STRIP_W - 2 * STRIP_PAD, 18, 26);
  const h = STRIP_PAD * 2 - 4 + rows.length * 26;
  let body = `<rect x=".5" y=".5" width="${STRIP_W - 1}" height="${h - 1}" rx="10" fill="${p.panel}" stroke="${p.border}"/>`;
  for (const it of rows.flat()) {
    const x = STRIP_PAD + it.x, y = STRIP_PAD + it.y;
    body += `<circle cx="${x + 4}" cy="${y + 10}" r="3.2" fill="${p.panel2}" stroke="${p.blue}" stroke-width="1.3"/>` +
      `<text x="${x + 16}" y="${y + 14}" font-family="${f.mono}" font-size="11" letter-spacing=".8" fill="${p.muted}">${esc(it.text)}</text>`;
  }
  return { w: STRIP_W, h, svg: svg(STRIP_W, h, `Focus: ${profile.focus.join(", ")}`, body) };
}

function techStrip(profile, theme) {
  const p = profile.palette[theme], f = F(profile);
  const items = profile.tech.map((t) => ({ ...t, w: Math.ceil(sansWidth(t.label, 12.5) + 38) }));
  const rows = flow(items, STRIP_W - 2 * STRIP_PAD, 10, 34);
  const h = STRIP_PAD * 2 - 6 + rows.length * 34;
  let body = `<rect x=".5" y=".5" width="${STRIP_W - 1}" height="${h - 1}" rx="10" fill="${p.panel}" stroke="${p.border}"/>`;
  for (const it of rows.flat()) {
    const x = STRIP_PAD + it.x, y = STRIP_PAD + it.y;
    body += `<g transform="translate(${x} ${y + 4}) scale(${num(16 / 24)})"><path d="${iconPath(it.slug)}" fill="${p.muted}"/></g>` +
      `<text x="${x + 24}" y="${y + 17}" font-family="${f.sans}" font-size="12.5" fill="${p.text}">${esc(it.label)}</text>`;
  }
  return { w: STRIP_W, h, svg: svg(STRIP_W, h, `Tools: ${profile.tech.map((t) => t.label).join(", ")}`, body) };
}

const TILE = { w: 200, h: 100 };
function tile(item, theme, profile) {
  const p = profile.palette[theme], f = F(profile);
  const lines = wrap(item.title, TILE.w - 60, 15, 2);
  let body = `<rect x=".5" y=".5" width="${TILE.w - 1}" height="${TILE.h - 1}" rx="10" fill="${p.panel}" stroke="${p.border}"/>` +
    `<g transform="translate(14 12) scale(.82)">${glyph(item.glyph, p)}</g>`;
  lines.forEach((l, i) => { body += `<text x="14" y="${lines.length === 1 ? 74 : 66 + i * 18}" font-family="${f.sans}" font-size="15" font-weight="650" fill="${p.text}">${esc(l)}</text>`; });
  return svg(TILE.w, TILE.h, item.title, body);
}

const CARD = { w: 280, h: 112 };
function card(item, theme, profile) {
  const p = profile.palette[theme], f = F(profile);
  const accent = item.visibility === "PRIVATE" ? p.copper : p.blue;
  let body = `<rect x=".5" y=".5" width="${CARD.w - 1}" height="${CARD.h - 1}" rx="12" fill="${p.panel}" stroke="${p.border}"/>` +
    motif(item.id, { x: 196, y: 8, w: 70, h: 44 }, p, accent);
  const a = pill(16, 14, item.visibility, accent, f), b = pill(16 + a.w + 8, 14, item.maturity, p.muted, f);
  body += a.svg + b.svg;
  body += `<text x="16" y="70" font-family="${f.sans}" font-size="19" font-weight="650" fill="${p.text}">${esc(item.title)}</text>`;
  body += `<g transform="translate(16 ${CARD.h - 24}) scale(${num(13 / 24)})"><path d="${iconPath(item.tech.icon)}" fill="${p.muted}"/></g>` +
    `<text x="34" y="${CARD.h - 13}" font-family="${f.mono}" font-size="10.5" fill="${p.muted}">${esc(item.tech.label)}</text>` +
    `<text x="${CARD.w - 16}" y="${CARD.h - 13}" text-anchor="end" font-family="${f.mono}" font-size="9.5" fill="${p.faint}">as of ${esc(profile.as_of)}</text>`;
  if (sansWidth(item.title, 19) > CARD.w - 32) throw new Error("card title too wide: " + item.title);
  return svg(CARD.w, CARD.h, `${item.title}, ${item.visibility.toLowerCase()}, ${item.maturity.toLowerCase()}, as of ${profile.as_of}`, body);
}

// ------------------------------------------------------------------------------------------------ README
function picture(profile, kind, stem, alt, width, height) {
  const base = `https://raw.githubusercontent.com/${profile.repo}/${profile.asset_ref}/assets` + (kind ? `/${kind}` : "");
  const dims = ` width="${width}"` + (height ? ` height="${height}"` : "");
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${base}/${stem}-dark.svg"><source media="(prefers-color-scheme: light)" srcset="${base}/${stem}-light.svg"><img src="${base}/${stem}-light.svg" alt="${esc(alt)}"${dims}></picture>`;
}
const slug = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function grid(cells, cols) {
  const pct = Math.floor(100 / cols);
  const rows = [];
  for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));
  return `<table width="100%">\n` + rows.map((r) => `<tr>\n` + r.map((c) => `<td width="${pct}%" valign="top">\n\n${c}\n\n</td>`).join("\n") + `\n</tr>`).join("\n") + `\n</table>`;
}

function readme(profile) {
  const hero = (name, ext) => `https://raw.githubusercontent.com/${profile.repo}/main/assets/${name}.${ext}`;
  const out = [];
  out.push(`<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${hero("hero-dark", "gif")}">
  <source media="(prefers-color-scheme: light)" srcset="${hero("hero-light", "svg")}">
  <img alt="Abstract computational topology: systems, evidence routes, and state nodes" src="${hero("hero-light", "svg")}">
</picture>
`);
  out.push(`# ${profile.name}\n`);
  out.push(`${profile.positioning}\n`);
  out.push(picture(profile, "", "focus-strip", `Focus: ${profile.focus.join(", ")}`, STRIP_W) + "\n");
  out.push(`### What I build\n`);
  out.push(grid(profile.tiles.map((t) => `${picture(profile, "tiles", `tile-${t.id}`, t.title, TILE.w)}\n\n<sub>${esc(t.text)}</sub>`), 3) + "\n");
  out.push(`### Current systems\n`);
  out.push(`<sub>${esc(profile.private_note)}</sub>\n`);
  out.push(grid(profile.cards.map((c) => {
    const pic = picture(profile, "cards", `card-${c.id}`, `${c.title}, ${c.visibility.toLowerCase()}, ${c.maturity.toLowerCase()}`, CARD.w);
    const head = c.href ? `<a href="${c.href}">${pic}</a>` : pic;
    return `${head}\n\n${esc(c.thesis)}\n\n<sub><code>${esc(c.evidence)}</code>${c.aside ? ` · <i>${esc(c.aside)}</i>` : ""}</sub>`;
  }), 2) + "\n");
  out.push(`### Selected public work\n`);
  out.push(profile.public_work.map((w) => `- [**${w.name}**](${w.url}) — ${w.text} <sub>${w.stack}</sub>`).join("\n") + "\n");
  out.push(`### Tools\n`);
  out.push(picture(profile, "", "tech-strip", `Tools: ${profile.tech.map((t) => t.label).join(", ")}`, STRIP_W) + "\n");
  out.push(profile.links.map((l) => `[${l.label}](${l.url})`).join(" · ") + "\n");
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------ build
export function build(profile) {
  const files = new Map();
  for (const theme of THEMES) {
    files.set(`assets/focus-strip-${theme}.svg`, focusStrip(profile, theme).svg);
    files.set(`assets/tech-strip-${theme}.svg`, techStrip(profile, theme).svg);
    for (const t of profile.tiles) files.set(`assets/tiles/tile-${t.id}-${theme}.svg`, tile(t, theme, profile));
    for (const c of profile.cards) files.set(`assets/cards/card-${c.id}-${theme}.svg`, card(c, theme, profile));
  }
  files.set("README.md", readme(profile));
  return files;
}

export function loadProfile() {
  return JSON.parse(readFileSync(resolve(root, "data/profile.json"), "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = build(loadProfile());
  if (process.argv.includes("--check")) {
    const stale = [...files].filter(([path, text]) => !existsSync(resolve(root, path)) || readFileSync(resolve(root, path), "utf8") !== text).map(([p]) => p);
    if (stale.length) { console.error("STALE generated files:\n  " + stale.join("\n  ")); process.exit(1); }
    console.log(`generated assets are current (${files.size} files)`);
  } else {
    for (const [path, text] of files) { const full = resolve(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); }
    console.log(`wrote ${files.size} files`);
  }
}
