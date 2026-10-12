#!/usr/bin/env node

/**
 * Generates the theme-aware profile hero from deterministic geometry.
 * No external data, fonts, or runtime services are used.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, "assets");
mkdirSync(assets, { recursive: true });

const topology = {
  nodes: [
    [102, 88, 4], [206, 60, 3], [330, 102, 5], [449, 53, 3],
    [565, 123, 4], [690, 70, 5], [815, 101, 3], [938, 52, 4],
    [1066, 112, 5], [1215, 66, 3], [1337, 100, 4], [276, 209, 3],
    [465, 243, 4], [654, 197, 3], [812, 239, 4], [996, 201, 3],
    [1172, 233, 5], [1339, 194, 3],
  ],
  edges: [
    [0, 1], [0, 2], [1, 3], [2, 3], [2, 4], [3, 5], [4, 5],
    [4, 13], [5, 6], [5, 7], [6, 8], [7, 8], [7, 9], [8, 9],
    [8, 15], [9, 10], [10, 17], [11, 2], [11, 12], [12, 4],
    [12, 13], [13, 14], [14, 15], [15, 16], [16, 17], [9, 15],
  ],
  routes: [
    [[102, 88], [330, 102], [565, 123], [690, 70], [938, 52], [1215, 66]],
    [[276, 209], [465, 243], [654, 197], [812, 239], [996, 201], [1172, 233]],
  ],
};

function line([[x1, y1], [x2, y2]], style) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${style}/>`;
}

function pointOnRoute(route, progress) {
  const lengths = route.slice(1).map(([x, y], index) => {
    const [previousX, previousY] = route[index];
    return Math.hypot(x - previousX, y - previousY);
  });
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let remaining = (progress % 1) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index]) {
      const [x1, y1] = route[index];
      const [x2, y2] = route[index + 1];
      const ratio = remaining / lengths[index];
      return [x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio];
    }
    remaining -= lengths[index];
  }
  return route.at(-1);
}

function pingPong(progress) {
  const position = ((progress % 1) + 1) % 1;
  return position <= .5 ? position * 2 : (1 - position) * 2;
}

function hero(theme, phase = null) {
  const c = theme === "dark" ? {
    base: "#0d1117", panel: "#111820", grid: "#27313a", edge: "#425160",
    node: "#9aa9b8", nodeFill: "#18232e", text: "#93a1ae", quiet: "#667788",
    blue: "#6ba7d6", ember: "#c7784e", haze: "#1b2732",
  } : {
    base: "#f6f8fa", panel: "#ffffff", grid: "#d9e0e6", edge: "#9aabb9",
    node: "#40515f", nodeFill: "#edf2f6", text: "#344452", quiet: "#687988",
    blue: "#2b6f9f", ember: "#a64d2a", haze: "#e7eef4",
  };

  const grid = Array.from({ length: 20 }, (_, i) => {
    const x = 36 + i * 72;
    return `<path d="M ${x} 0 V 300" stroke="${c.grid}" stroke-opacity=".26" stroke-width="1"/>`;
  }).join("") + Array.from({ length: 5 }, (_, i) => {
    const y = 30 + i * 60;
    return `<path d="M 0 ${y} H 1440" stroke="${c.grid}" stroke-opacity=".26" stroke-width="1"/>`;
  }).join("");

  const edges = topology.edges.map(([a, b]) => {
    const [x1, y1] = topology.nodes[a];
    const [x2, y2] = topology.nodes[b];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c.edge}" stroke-opacity=".72" stroke-width="1.25"/>`;
  }).join("");

  const traces = topology.routes.map((route, index) => {
    const points = route.map(([x, y]) => `${x},${y}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="${index ? c.ember : c.blue}" stroke-opacity=".72" stroke-width="1.6" stroke-dasharray="2 10"/>`;
  }).join("");

  const nodes = topology.nodes.map(([x, y, r], index) => {
    const accent = [2, 5, 8, 16].includes(index) ? c.blue : [4, 14].includes(index) ? c.ember : c.node;
    return `<circle cx="${x}" cy="${y}" r="${r + 4}" fill="${accent}" fill-opacity=".08"/><circle cx="${x}" cy="${y}" r="${r}" fill="${c.nodeFill}" stroke="${accent}" stroke-width="1.5"/>`;
  }).join("");

  const packetPositions = phase === null
    ? [[473, 116, c.blue], [888, 58, c.blue], [889, 217, c.ember], [1080, 210, c.ember]]
    : [
      [...pointOnRoute(topology.routes[0], pingPong(phase)), c.blue],
      [...pointOnRoute(topology.routes[0], pingPong(phase + .47)), c.blue],
      [...pointOnRoute(topology.routes[1], pingPong(phase + .18)), c.ember],
      [...pointOnRoute(topology.routes[1], pingPong(phase + .66)), c.ember],
    ];
  const packets = packetPositions.map(([x, y, color]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${color}"/><circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="7" fill="none" stroke="${color}" stroke-opacity=".35"/>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 300" role="img" aria-labelledby="title desc">
  <title id="title">Computational topology</title>
  <desc id="desc">An abstract network of systems, evidence routes, and state nodes.</desc>
  <defs>
    <linearGradient id="field" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${c.base}"/><stop offset=".55" stop-color="${c.panel}"/><stop offset="1" stop-color="${c.base}"/></linearGradient>
    <radialGradient id="haze" cx="52%" cy="46%" r="62%"><stop stop-color="${c.haze}" stop-opacity=".72"/><stop offset="1" stop-color="${c.base}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1440" height="300" fill="url(#field)"/>
  <rect width="1440" height="300" fill="url(#haze)"/>
  <g shape-rendering="crispEdges">${grid}</g>
  <rect x="24" y="18" width="1392" height="264" rx="3" fill="none" stroke="${c.grid}" stroke-opacity=".75"/>
  <g>${edges}</g>
  <g>${traces}</g>
  <g>${nodes}</g>
  <g>${packets}</g>
  <g fill="${c.text}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" letter-spacing="1.8">
    <text x="49" y="45">SYSTEM TOPOLOGY / PUBLIC EDGE</text>
    <text x="49" y="264" fill="${c.quiet}">EVIDENCE ROUTES</text>
  </g>
</svg>`;
}

for (const theme of ["dark", "light"]) {
  writeFileSync(resolve(assets, `hero-${theme}.svg`), hero(theme));
}

const framesArgument = process.argv.indexOf("--frames");
if (framesArgument !== -1) {
  const destination = resolve(process.argv[framesArgument + 1]);
  mkdirSync(destination, { recursive: true });
  for (let index = 0; index < 48; index += 1) {
    writeFileSync(resolve(destination, `frame-${String(index).padStart(2, "0")}.svg`), hero("dark", index / 48));
  }
}
