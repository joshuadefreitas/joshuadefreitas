#!/usr/bin/env node
import { closeSync, cpSync, fsyncSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, "assets");
mkdirSync(assets, { recursive: true });

// This reference file pins independently reviewed pixels. Changing the design
// is a deliberate, reviewed act and requires --update-golden.
const heroFiles = Object.freeze(["assets/hero-dark.svg", "assets/hero-light.svg"]);
const goldenPath = resolve(assets, "hero.sha256");
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
function goldenText(hashes) {
  return heroFiles.map((file) => `${hashes.get(file)}  ${file}`).join("\n") + "\n";
}
function parseGolden(text) {
  if (!text.endsWith("\n") || text.endsWith("\n\n")) throw new Error("hero reference file must contain exactly two nonblank lines followed by one newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== heroFiles.length) throw new Error("hero reference file must contain exactly two hashes");
  const hashes = new Map();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (assets\/hero-(?:dark|light)\.svg)$/);
    if (!match || !heroFiles.includes(match[2]) || hashes.has(match[2])) throw new Error("hero reference file has an invalid entry");
    hashes.set(match[2], match[1]);
  }
  if (hashes.size !== heroFiles.length) throw new Error("hero reference file is incomplete");
  return hashes;
}
function readGolden() {
  try {
    return parseGolden(readFileSync(goldenPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("hero reference file is missing");
    throw error;
  }
}
function generatedHashes(dark, light) {
  return new Map([[heroFiles[0], digest(dark)], [heroFiles[1], digest(light)]]);
}
function assertGolden(dark, light, expected) {
  const actual = generatedHashes(dark, light);
  for (const file of heroFiles) if (actual.get(file) !== expected.get(file)) throw new Error(`hero reference mismatch: ${file}`);
}
function writeAtomically(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      rmSync(temporary, { force: true });
    }
    throw error;
  }
}

function temporaryPath(path, index) {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${index}.tmp`);
}
function syncDirectory(path) {
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function faultAt(point, file) {
  const fault = process.env.HERO_TEST_FAULT;
  if ((fault === "manifest-write-failure" && point === "write" && file.name === "manifest") ||
      (fault === "second-rename-failure" && point === "rename" && file.name === "light") ||
      (fault === "temp-reread-failure" && point === "reread" && file.name === "dark")) {
    throw new Error(`injected ${fault}`);
  }
}
function writeTemporary(file, index) {
  const temporary = temporaryPath(file.path, index);
  let descriptor;
  try {
    faultAt("write", file);
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, file.text, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      rmSync(temporary, { force: true });
    }
    throw error;
  }
}
function publish(files, validate) {
  const originals = new Map(files.map((file) => [file.path, readFileSync(file.path, "utf8")]));
  const temporaries = new Map();
  const replaced = [];
  try {
    files.forEach((file, index) => temporaries.set(file.path, writeTemporary(file, index)));
    const staged = new Map(files.map((file) => {
      faultAt("reread", file);
      const text = readFileSync(temporaries.get(file.path), "utf8");
      if (text !== file.text) throw new Error(`temporary output differs after write: ${file.name}`);
      return [file.path, text];
    }));
    validate(staged);
    for (const file of files) {
      faultAt("rename", file);
      renameSync(temporaries.get(file.path), file.path);
      temporaries.delete(file.path);
      replaced.push(file);
      syncDirectory(file.path);
    }
    const published = new Map(files.map((file) => [file.path, readFileSync(file.path, "utf8")]));
    validate(published);
  } catch (error) {
    const rollbackErrors = [];
    for (const file of replaced.reverse()) {
      try {
        writeAtomically(file.path, originals.get(file.path));
      } catch (rollbackError) {
        rollbackErrors.push(`${file.name}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) throw new Error(`${error.message}; rollback failed: ${rollbackErrors.join(", ")}`);
    throw error;
  } finally {
    for (const temporary of temporaries.values()) rmSync(temporary, { force: true });
  }
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (value) => Number(value.toFixed(1));
const phase = Object.freeze({
  loop: 28,
  outwardEnd: 12,
  reset: 14,
  returnStart: 16,
});
const POP_BOUND = .03;
// Source times are rounded to 10 decimal seconds, then key() truncates their
// normalized form to 12 decimals. Together they move an emitted instant by
// less than 8e-11 s; 1e-10 s is the conservative bound used below. Boundary
// probes use 1e-6 s, safely beyond that serialization quantization.
const SERIALIZED_KEY_TIME_QUANTIZATION_SECONDS = 1e-10;
const SERIALIZED_BOUNDARY_PROBE_SECONDS = 1e-6;
const SERIALIZED_NUMERIC_TOLERANCE = 1e-8;
const keyNumber = (time) => time === phase.loop ? 1 : Math.floor((time / phase.loop) * 1e12) / 1e12;
const key = (time) => String(keyNumber(time));
const rail = { left: 62, right: 1378, top: 84, bottom: 216, rest: 900 };
const random = mulberry32(0x5eeda11);
const events = [];
let x = 94;
for (let i = 0; i < 48; i += 1) {
  x += 17 + random() * 10;
  const long = [7, 16, 27, 38].includes(i);
  const lag = 28 + random() * 62 + (long ? 76 + random() * 40 : 0);
  const available = Math.min(rail.right - 13, x + lag);
  events.push({ x: n(x), available: n(available), bow: n(18 + random() * 26 + (i % 2 ? 6 : 0)) });
}
const revisions = [
  { event: 6, delay: 106 }, { event: 15, delay: 119 },
  { event: 25, delay: 92 }, { event: 36, delay: 104 },
].map((revision) => {
  const item = events[revision.event];
  return { ...item, available: n(Math.min(rail.right - 7, item.available + revision.delay)), revision: true };
});

const palettes = {
  dark: { base: "#0d1117", panel: "#111820", grid: "#27313a", edge: "#425160", node: "#9aa9b8", text: "#93a1ae", quiet: "#667788", blue: "#6ba7d6", ember: "#c7784e", ghostMark: ".15", ghostLine: ".4" },
  light: { base: "#f6f8fa", panel: "#ffffff", grid: "#d9e0e6", edge: "#9aabb9", node: "#40515f", text: "#344452", quiet: "#687988", blue: "#2b6f9f", ember: "#a64d2a", ghostMark: ".22", ghostLine: ".409091" },
};

const records = [
  ...events.map((item, i) => ({ ...item, id: `e${i}` })),
  ...revisions.map((item, i) => ({ ...item, id: `r${i}`, revision: true })),
];
const opacity = { ghost: ".15", flight: ".54", resolved: ".82" };
const fadeSpline = ".42 0 .58 1";
const linearSpline = "0 0 1 1";
const sharedTimes = [0, phase.outwardEnd, phase.reset, phase.returnStart, phase.loop];
const sharedOpacity = { times: sharedTimes, values: [1, 1, 0, 1, 1], mode: "spline", splines: [linearSpline, fadeSpline, fadeSpline, linearSpline] };
const cutoffTracks = Object.freeze({
  outer: { times: sharedTimes, values: [rail.rest, rail.right, rail.right, rail.right, rail.right], mode: "linear" },
  reset: { times: sharedTimes, values: [0, 0, rail.left - rail.right, rail.left - rail.right, rail.left - rail.right], mode: "discrete" },
  returning: { times: sharedTimes, values: [0, 0, 0, 0, rail.rest - rail.left], mode: "linear" },
});
const washTracks = Object.freeze({
  forward: {
    width: { times: sharedTimes, values: cutoffTracks.outer.values.map((position) => position - rail.left), mode: "linear" },
    visible: { times: sharedTimes, values: [1, 1, 0, 0, 0], mode: "discrete" },
  },
  returning: {
    width: { times: sharedTimes, values: cutoffTracks.returning.values.map((offset) => Math.max(0, offset)), mode: "linear" },
    visible: { times: sharedTimes, values: [0, 0, 0, 1, 1], mode: "discrete" },
  },
});
const WASH_EDGE_TOLERANCE = .001;
const WASH_OPACITY = .035;
function stateAt(item, cutoff) {
  if (cutoff + .001 < item.x) return "ghost";
  return cutoff + .001 < item.available ? "flight" : "resolved";
}
function timeFirst(position) { return phase.outwardEnd * (position - rail.rest) / (rail.right - rail.rest); }
function timeSecond(position) { return phase.returnStart + (phase.loop - phase.returnStart) * (position - rail.left) / (rail.rest - rail.left); }
function timesFor(item) {
  const times = [0];
  if (item.x > rail.rest) times.push(timeFirst(item.x));
  if (item.available > rail.rest) times.push(timeFirst(item.available));
  times.push(phase.outwardEnd, phase.reset, phase.returnStart);
  if (item.x <= rail.rest) times.push(timeSecond(item.x));
  if (item.available <= rail.rest) times.push(timeSecond(item.available));
  times.push(phase.loop);
  return [...new Set(times.map((time) => Number(time.toFixed(10))))].sort((a, b) => a - b);
}
function cutoffAt(time) {
  if (time <= phase.outwardEnd) return rail.rest + (rail.right - rail.rest) * time / phase.outwardEnd;
  if (time < phase.reset) return rail.right;
  if (time <= phase.returnStart) return rail.left;
  return rail.left + (rail.rest - rail.left) * (time - phase.returnStart) / (phase.loop - phase.returnStart);
}
function stateForTime(item, time) {
  return stateAt(item, cutoffAt(time));
}
// The emission model keeps a small floating-point guard above. The serialized
// check uses the mathematical cutoff instead, so its +/- 1e-6 s probes test
// the old and new discrete states on either side of every emitted key time.
function pureStatusForTime(item, time) {
  const cutoff = cutoffAt(time);
  if (cutoff < item.x) return "ghost";
  return cutoff < item.available ? "flight" : "resolved";
}
function stateFrames(item, which) {
  const times = timesFor(item);
  const values = times.map((time) => stateForTime(item, time) === which ? opacity[which] : "0");
  return { item, which, times, values };
}
function motion(item, which, tracks) {
  const frame = stateFrames(item, which);
  frame.mode = "discrete";
  frame.keyTimes = frame.times.map(key);
  tracks.push(frame);
  return `<animate attributeName="opacity" calcMode="discrete" dur="${phase.loop}s" repeatCount="indefinite" values="${frame.values.join(";")}" keyTimes="${frame.keyTimes.join(";")}"/>`;
}
function path(item) {
  if (item.revision) {
    const span = item.available - item.x;
    return `M${item.x} ${rail.top} C${n(item.x + span * .1)} ${rail.top + 74} ${n(item.available - span * .1)} ${rail.bottom - 74} ${item.available} ${rail.bottom}`;
  }
  const bow = item.bow;
  return `M${item.x} ${rail.top} C${n(item.x + bow)} ${n(rail.top + 31)} ${n(item.available - bow)} ${n(rail.bottom - 31)} ${item.available} ${rail.bottom}`;
}
function shape(item, p) {
  return `<path id="${item.id}-line" d="${path(item)}" fill="none" stroke-linecap="round"/><g id="${item.id}-marks"><circle cx="${item.x}" cy="${rail.top}" r="3.35" fill="${p.panel}"/><circle cx="${item.available}" cy="${rail.bottom}" r="3.35" fill="${p.panel}"/></g>`;
}
function stateGroup(item, state, p, tracks, revision = false, animate = false) {
  const color = state === "resolved" ? (revision ? p.ember : p.blue) : state === "flight" ? p.node : p.edge;
  const dash = state === "flight" ? " stroke-dasharray=\"5 4\"" : "";
  const width = state === "resolved" ? "1.8" : state === "flight" ? "1.55" : "1.35";
  const stateOpacity = state === "ghost" ? p.ghostMark : opacity[state];
  const base = stateAt(item, rail.rest) === state ? stateOpacity : "0";
  const ring = revision && state === "resolved" ? `<circle cx="${item.available}" cy="${rail.bottom}" r="7.2" fill="none" stroke="${color}" stroke-opacity=".34" stroke-width="1.25"/>` : "";
  const lineOpacity = state === "ghost" ? ` stroke-opacity="${p.ghostLine}"` : "";
  return `<g opacity="${base}"><use href="#${item.id}-line" stroke="${color}" stroke-width="${width}"${dash}${lineOpacity}/><use href="#${item.id}-marks"/>${ring}${animate ? motion(item, state, tracks) : ""}</g>`;
}
function eventGroups(item, p, tracks, animated, revision = false) {
  return ["ghost", "flight", "resolved"].map((state) => stateGroup(item, state, p, tracks, revision, animated)).join("");
}
function flare(item, p) {
  const moments = [];
  if (item.available > rail.rest) moments.push(timeFirst(item.available));
  if (item.available <= rail.rest) moments.push(timeSecond(item.available));
  const times = [0];
  for (const at of moments) times.push(Math.max(0, at - .08), at, Math.min(phase.loop, at + .26));
  times.push(phase.loop);
  const unique = [...new Set(times.map((time) => Number(time.toFixed(10))))].sort((a, b) => a - b);
  const values = unique.map((time) => moments.some((at) => Math.abs(time - at) < .001) ? ".86" : "0");
  return `<g opacity="0"><circle cx="${item.available}" cy="${rail.bottom}" r="10" fill="none" stroke="${p.ember}" stroke-width="1.35"/><circle cx="${item.available}" cy="${rail.bottom}" r="15" fill="none" stroke="${p.ember}" stroke-opacity=".42" stroke-width="1"/><animate attributeName="opacity" dur="${phase.loop}s" repeatCount="indefinite" values="${values.join(";")}" keyTimes="${unique.map(key).join(";")}"/></g>`;
}
function animatedOpacity(track) {
  return `<animate attributeName="opacity" calcMode="${track.mode}" dur="${phase.loop}s" repeatCount="indefinite" values="${track.values.join(";")}" keyTimes="${track.times.map(key).join(";")}"${track.mode === "spline" ? ` keySplines="${track.splines.join(";")}"` : ""}/>`;
}
function animatedNumber(attribute, track) {
  return `<animate attributeName="${attribute}"${track.mode === "discrete" ? ' calcMode="discrete"' : ""} dur="${phase.loop}s" repeatCount="indefinite" values="${track.values.join(";")}" keyTimes="${track.times.map(key).join(";")}"/>`;
}
function animatedTranslate(track) {
  return `<animateTransform attributeName="transform" type="translate"${track.mode === "discrete" ? ' calcMode="discrete"' : ""} dur="${phase.loop}s" repeatCount="indefinite" values="${track.values.map((value) => `${value} 0`).join(";")}" keyTimes="${track.times.map(key).join(";")}"/>`;
}
function hero(theme, tracks = []) {
  const p = palettes[theme];
  const animated = theme === "dark";
  const ticks = Array.from({ length: 34 }, (_, i) => {
    const x = rail.left + i * (rail.right - rail.left) / 33;
    const size = i % 5 === 0 ? 10 : 6;
    return `<path d="M${n(x)} ${rail.top - size / 2}v${size}M${n(x)} ${rail.bottom - size / 2}v${size}"/>`;
  }).join("");
  const guides = [48, rail.top, 150, rail.bottom, 252].map((y) => `<path d="M${rail.left} ${y}H${rail.right}"/>`).join("");
  const data = records.filter((item) => !item.revision).map((item) => eventGroups(item, p, tracks, animated)).join("");
  const corrections = records.filter((item) => item.revision).map((item) => eventGroups(item, p, tracks, animated, true)).join("");
  const flares = animated ? revisions.map((item) => flare(item, p)).join("") : "";
  const outerCutoffMotion = animated ? animatedTranslate(cutoffTracks.outer) : "";
  const resetCutoffMotion = animated ? animatedTranslate(cutoffTracks.reset) : "";
  const returnCutoffMotion = animated ? animatedTranslate(cutoffTracks.returning) : "";
  const wash = animated
    ? `<g opacity="${WASH_OPACITY}"><g opacity="1">${animatedOpacity(sharedOpacity)}<g opacity="1">${animatedNumber("opacity", washTracks.forward.visible)}<rect x="${rail.left}" y="41" width="${rail.rest - rail.left}" height="218" fill="${p.blue}">${animatedNumber("width", washTracks.forward.width)}</rect></g><g opacity="0">${animatedNumber("opacity", washTracks.returning.visible)}<rect x="${rail.left}" y="41" width="0" height="218" fill="${p.blue}">${animatedNumber("width", washTracks.returning.width)}</rect></g></g></g>`
    : `<g opacity="${WASH_OPACITY}"><g opacity="1"><rect x="${rail.left}" y="41" width="${rail.rest - rail.left}" height="218" fill="${p.blue}"/></g></g>`;
  const masterMotion = animated ? animatedOpacity(sharedOpacity) : "";
  const labelClear = 150;
  const labelResume = timeSecond(labelClear);
  const labelMotion = animated ? `<animate attributeName="opacity" calcMode="discrete" dur="${phase.loop}s" repeatCount="indefinite" values="1;0;0;1;1" keyTimes="${[0, phase.reset, phase.returnStart, labelResume, phase.loop].map(key).join(";")}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 300" role="img" aria-labelledby="title desc">
  <title id="title">Two clocks</title>
  <desc id="desc">Paired rails show when observations happened and when they became available, with delayed corrections and a moving information cutoff.</desc>
  <defs>
    <linearGradient id="field" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${p.base}"/><stop offset=".5" stop-color="${p.panel}"/><stop offset="1" stop-color="${p.base}"/></linearGradient>
    <linearGradient id="halo" x1="0" x2="1"><stop stop-color="${p.blue}" stop-opacity="0"/><stop offset=".5" stop-color="${p.blue}" stop-opacity=".16"/><stop offset="1" stop-color="${p.blue}" stop-opacity="0"/></linearGradient>
    <clipPath id="plot"><rect x="${rail.left}" y="40" width="${rail.right - rail.left}" height="220"/></clipPath>${records.map((item) => shape(item, p)).join("")}
  </defs>
  <rect width="1440" height="300" fill="url(#field)"/>
  <rect x="32" y="28" width="1376" height="244" rx="4" fill="none" stroke="${p.grid}" stroke-opacity=".9" stroke-width="1.35"/>
  <g fill="none" stroke="${p.grid}" stroke-opacity=".56" stroke-width="1.1" shape-rendering="crispEdges">${guides}${ticks}</g>
  <g clip-path="url(#plot)">${wash}<g opacity="1">${data}${corrections}${flares}${masterMotion}</g></g>
  <g clip-path="url(#plot)"><g transform="translate(${rail.rest} 0)">${outerCutoffMotion}<g transform="translate(0 0)">${resetCutoffMotion}<g transform="translate(0 0)" opacity="1">${returnCutoffMotion}<rect x="-92" y="42" width="184" height="216" fill="url(#halo)"/><path d="M0 43V257" stroke="${p.blue}" stroke-opacity=".92" stroke-width="2.4"/><path d="M-8 58H8M-8 242H8" stroke="${p.blue}" stroke-width="1.7" stroke-linecap="round"/>${animated ? animatedOpacity(sharedOpacity) : ""}</g></g></g></g>
  <g fill="${p.quiet}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="10" letter-spacing="1.65"><text x="${rail.left}" y="66">EVENT TIME</text><text x="${rail.left}" y="242">AVAILABLE</text>${labelMotion}</g>
</svg>
`;
}

function bezier(a, b, c, d, t) {
  const q = 1 - t;
  return q ** 3 * a + 3 * q ** 2 * t * b + 3 * q * t ** 2 * c + t ** 3 * d;
}
function splineAt(spline, progress) {
  const [x1, y1, x2, y2] = spline.split(" ").map(Number);
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step += 1) {
    const middle = (low + high) / 2;
    if (bezier(0, x1, x2, 1, middle) < progress) low = middle;
    else high = middle;
  }
  return bezier(0, y1, y2, 1, (low + high) / 2);
}
function valueAt(frame, time) {
  const point = time / phase.loop;
  const times = (frame.keyTimes || frame.times.map(key)).map(Number);
  if (point <= times[0]) return Number(frame.values[0]);
  let index = times.length - 2;
  for (let i = 1; i < times.length; i += 1) {
    if (point < times[i]) { index = i - 1; break; }
  }
  if (frame.mode === "discrete") return Number(frame.values[index]);
  const span = times[index + 1] - times[index];
  const progress = span === 0 ? 1 : (point - times[index]) / span;
  const eased = frame.mode === "spline" ? splineAt(frame.splines[index], progress) : progress;
  return Number(frame.values[index]) + (Number(frame.values[index + 1]) - Number(frame.values[index])) * eased;
}
function sampleTimes(tracks) {
  const samples = [];
  for (let time = 0; time <= phase.loop + 1e-9; time += .1) samples.push(Number(Math.min(phase.loop, time).toFixed(4)));
  for (const boundary of Object.values(phase)) {
    samples.push(Math.max(0, boundary - .001), boundary, Math.min(phase.loop, boundary + .001));
  }
  for (const track of tracks) for (const boundary of track.times) {
    samples.push(Math.max(0, boundary - .001), boundary, Math.min(phase.loop, boundary + .001));
  }
  return [...new Set(samples.map((time) => time.toFixed(10)))].map(Number).sort((a, b) => a - b);
}
function verifyTracks(tracks, expectedState = stateForTime) {
  const samples = sampleTimes(tracks);
  for (const time of samples) {
    const master = valueAt(sharedOpacity, time);
    for (const item of records) {
      const expected = expectedState(item, time);
      const groups = tracks.filter((track) => track.item.id === item.id);
      if (groups.length !== 3) throw new Error(`missing state groups for ${item.id}`);
      for (const group of groups) {
        if (group.times.some((at) => at < 0 || at > phase.loop)) throw new Error(`invalid key time for ${item.id}`);
        const actual = valueAt(group, time) * master;
        const wanted = group.which === expected ? Number(opacity[group.which]) * master : 0;
        if (Math.abs(actual - wanted) > 1e-8) {
          throw new Error(`state track mismatch for ${item.id} at ${time}s: expected ${expected}, got ${group.which}=${valueAt(group, time)}`);
        }
      }
    }
  }
  return samples.length;
}
function cutoffFromTracks(time, tracks = cutoffTracks) {
  return valueAt(tracks.outer, time) + valueAt(tracks.reset, time) + valueAt(tracks.returning, time);
}
function washWeight(time, tracks = washTracks) {
  const master = valueAt(sharedOpacity, time);
  return Object.values(tracks).reduce((total, section) => total + WASH_OPACITY * master * valueAt(section.visible, time) * valueAt(section.width, time) / (rail.right - rail.left), 0);
}
function verifyCutoffAndWash(tracks = cutoffTracks, wash = washTracks) {
  const samples = sampleTimes([]);
  for (const time of samples) {
    const cutoff = cutoffFromTracks(time, tracks);
    const expectedCutoff = cutoffAt(time);
    if (Math.abs(cutoff - expectedCutoff) > WASH_EDGE_TOLERANCE) {
      throw new Error(`cutoff track mismatch at ${time}s: expected ${expectedCutoff}, got ${cutoff}`);
    }
    const master = valueAt(sharedOpacity, time);
    for (const [name, section] of Object.entries(wash)) {
      const effectiveOpacity = WASH_OPACITY * master * valueAt(section.visible, time);
      if (master <= 1e-8 && effectiveOpacity > 1e-8) {
        throw new Error(`wash ${name} is visible while the cutoff is hidden at ${time}s`);
      }
      if (effectiveOpacity > 1e-8) {
        const edge = rail.left + valueAt(section.width, time);
        if (Math.abs(edge - cutoff) > WASH_EDGE_TOLERANCE) {
          throw new Error(`wash ${name} soft edge mismatch at ${time}s: expected ${cutoff}, got ${edge}`);
        }
      }
    }
  }
  return samples.length;
}
function popWeight(tracks, wash) {
  let peak = 0;
  const frame = 1 / 60;
  for (let time = 0; time < phase.loop; time += frame) {
    const next = Math.min(phase.loop, time + frame);
    const before = valueAt(sharedOpacity, time);
    const after = valueAt(sharedOpacity, next);
    const states = tracks.reduce((sum, track) => sum + Math.abs(valueAt(track, next) * after - valueAt(track, time) * before), 0);
    const washChange = Math.abs(washWeight(next, wash) - washWeight(time, wash));
    peak = Math.max(peak, (states + washChange) / (tracks.length + 1));
  }
  if (peak > POP_BOUND) throw new Error(`visual-weight change ${peak.toFixed(6)} exceeds ${POP_BOUND.toFixed(3)} per frame`);
  return peak;
}
function assertNegativeChecks(tracks, wash) {
  const altered = tracks.map((track) => ({ ...track, values: [...track.values] }));
  altered[0].values.fill("0");
  const invisibleCutoff = (item, time) => time >= phase.outwardEnd && time < phase.returnStart ? "ghost" : stateForTime(item, time);
  for (const [label, candidate, expected] of [["altered state", altered, stateForTime], ["invisible-cutoff hold", tracks, invisibleCutoff]]) {
    try {
      verifyTracks(candidate, expected);
      throw new Error(`${label} was not rejected`);
    } catch (error) {
      if (/was not rejected/.test(error.message)) throw error;
    }
  }
  const stuckWash = {
    forward: { ...wash.forward, width: { ...wash.forward.width, values: [...wash.forward.width.values] } },
    returning: { ...wash.returning, width: { ...wash.returning.width, values: wash.returning.width.values.map(() => rail.rest - rail.left) } },
  };
  try {
    verifyCutoffAndWash(cutoffTracks, stuckWash);
    throw new Error("stuck wash was not rejected");
  } catch (error) {
    if (/was not rejected/.test(error.message)) throw error;
  }
}
function assertStateModel(tracks) {
  const count = verifyTracks(tracks);
  const geometrySamples = verifyCutoffAndWash();
  const peak = popWeight(tracks, washTracks);
  assertNegativeChecks(tracks, washTracks);
  console.log(`Hero state check passed: ${tracks.length} groups at ${count} samples; cutoff and wash checked at ${geometrySamples} samples with ${WASH_EDGE_TOLERANCE}px soft-edge tolerance; effective visual-weight peak ${peak.toFixed(6)} per 1/60s frame (limit ${POP_BOUND.toFixed(3)}).`);
  console.log("Hero negative checks passed: altered state, invisible-cutoff hold, and stuck resting wash rejected.");
}

function parseSerializedSvg(svg) {
  const root = { name: "#document", attrs: {}, children: [], parent: null };
  const stack = [root];
  const ids = new Map();
  const nodes = [];
  const textNodes = [];
  let offset = 0;
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  if (svg.startsWith(declaration)) offset = declaration.length;
  while (offset < svg.length) {
    const next = svg.indexOf("<", offset);
    const text = svg.slice(offset, next < 0 ? svg.length : next);
    if (text) {
      if (/&/.test(text)) throw new Error("serialized SVG contains an entity or character reference in text");
      const parent = stack.at(-1);
      if (/^[ \t\r\n]+$/.test(text)) {
        textNodes.push({ parent, text, formatting: true });
      } else {
        if (!parent || !["title", "desc", "text"].includes(parent.name) || !/^[A-Za-z0-9 ,.\-']+$/.test(text)) throw new Error("serialized SVG has text outside its permitted text elements");
        textNodes.push({ parent, text, formatting: false });
      }
    }
    if (next < 0) break;
    if (svg.startsWith("<!--", next)) throw new Error("serialized SVG contains a comment");
    if (svg.startsWith("<?", next)) throw new Error("serialized SVG contains a processing instruction");
    if (svg.startsWith("<!", next)) throw new Error("serialized SVG contains a declaration or CDATA section");
    const end = svg.indexOf(">", next + 1);
    if (end < 0) throw new Error("serialized SVG has an unclosed tag");
    const token = svg.slice(next, end + 1);
    offset = end + 1;
    if (token.startsWith("</")) {
      const match = token.match(/^<\/([A-Za-z][\w:-]*)\s*>$/);
      if (!match) throw new Error(`serialized SVG has an unreadable closing token: ${token}`);
      const [, name] = match;
      if (stack.length === 1 || stack.at(-1).name !== name) throw new Error(`serialized SVG has an unbalanced </${name}>`);
      stack.pop();
      continue;
    }
    const match = token.match(/^<([A-Za-z][\w:-]*)([\s\S]*)>$/);
    if (!match) throw new Error(`serialized SVG has an unreadable token: ${token}`);
    const [, name, rawAttrs] = match;
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const sourceAttrs = selfClosing ? rawAttrs.replace(/\/\s*$/, "") : rawAttrs;
    const attrs = {};
    let attrPos = 0;
    while (attrPos < sourceAttrs.length) {
      const gap = sourceAttrs.slice(attrPos).match(/^\s+/);
      if (!gap) throw new Error(`serialized SVG has unreadable attributes on <${name}>`);
      attrPos += gap[0].length;
      if (attrPos === sourceAttrs.length) break;
      const attr = sourceAttrs.slice(attrPos).match(/^([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([^<>&]*?)\2/);
      if (!attr) throw new Error(`serialized SVG has unreadable attributes on <${name}>`);
      if (Object.hasOwn(attrs, attr[1])) throw new Error(`serialized SVG repeats ${attr[1]} on <${name}>`);
      attrs[attr[1]] = attr[3];
      attrPos += attr[0].length;
    }
    const node = { name, attrs, children: [], parent: stack.at(-1) };
    node.parent.children.push(node);
    nodes.push(node);
    if (attrs.id) {
      if (ids.has(attrs.id)) throw new Error(`serialized SVG duplicates id=${attrs.id}`);
      ids.set(attrs.id, node);
    }
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`serialized SVG leaves <${stack.at(-1).name}> open`);
  return { root, nodes, ids, textNodes };
}
const SERIALIZED_ELEMENT_ATTRIBUTES = Object.freeze({
  svg: new Set(["xmlns", "viewBox", "role", "aria-labelledby"]),
  title: new Set(["id"]),
  desc: new Set(["id"]),
  defs: new Set(),
  linearGradient: new Set(["id", "x1", "x2", "y1", "y2"]),
  stop: new Set(["offset", "stop-color", "stop-opacity"]),
  clipPath: new Set(["id"]),
  rect: new Set(["x", "y", "width", "height", "rx", "fill", "stroke", "stroke-opacity", "stroke-width"]),
  g: new Set(["id", "opacity", "fill", "stroke", "stroke-opacity", "stroke-width", "shape-rendering", "clip-path", "transform", "font-family", "font-size", "letter-spacing"]),
  path: new Set(["id", "d", "fill", "stroke", "stroke-linecap", "stroke-opacity", "stroke-width"]),
  circle: new Set(["cx", "cy", "r", "fill", "stroke", "stroke-opacity", "stroke-width"]),
  use: new Set(["href", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity"]),
  animate: new Set(["attributeName", "calcMode", "dur", "repeatCount", "values", "keyTimes", "keySplines"]),
  animateTransform: new Set(["attributeName", "type", "calcMode", "dur", "repeatCount", "values", "keyTimes"]),
  text: new Set(["x", "y"]),
});
function addSerializedReference(references, id, node, kind) {
  if (!references.has(id)) references.set(id, []);
  references.get(id).push({ node, kind });
}
function isDrawableDefinition(node) {
  if (node.name === "path") return Boolean(node.attrs.d);
  if (node.name === "g") return node.children.some(isDrawableDefinition);
  return ["rect", "circle"].includes(node.name);
}
function assertSerializedAllowlist(parsed, theme) {
  if (parsed.root.children.length !== 1 || parsed.root.children[0].name !== "svg") throw new Error("serialized SVG must have one svg root");
  const references = new Map();
  for (const node of parsed.nodes) {
    const allowed = SERIALIZED_ELEMENT_ATTRIBUTES[node.name];
    if (!allowed) throw new Error(`serialized SVG has unsupported <${node.name}>`);
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name.startsWith("on")) throw new Error(`serialized SVG has an event attribute ${name}`);
      if (!allowed.has(name)) throw new Error(`serialized SVG has unsupported ${name} on <${node.name}>`);
      if (/&/.test(value)) throw new Error(`serialized SVG has an entity or character reference in ${name}`);
    }
    if (["animate", "animateTransform"].includes(node.name) && theme !== "dark") throw new Error("serialized light SVG contains an animation element");
    if (node.name === "use") {
      const href = node.attrs.href;
      if (!href || !/^#[A-Za-z][\w.-]*$/.test(href)) throw new Error("serialized <use> must have a local fragment href");
      addSerializedReference(references, href.slice(1), node, "use");
    }
    for (const [name, value] of Object.entries(node.attrs)) {
      const url = value.match(/^url\(#([A-Za-z][\w.-]*)\)$/);
      if (url) {
        if (![["fill", "linearGradient"], ["clip-path", "clipPath"]].some(([attribute, target]) => name === attribute && target)) {
          throw new Error(`serialized SVG has an unsupported local URL in ${name}`);
        }
        addSerializedReference(references, url[1], node, name);
      } else if (value.includes("url(")) {
        throw new Error(`serialized SVG has an unsupported URL value in ${name}`);
      }
    }
    if (node.name === "svg" && node.attrs["aria-labelledby"]) {
      for (const id of node.attrs["aria-labelledby"].split(/\s+/)) {
        if (!/^[A-Za-z][\w.-]*$/.test(id)) throw new Error("serialized SVG has an invalid aria-labelledby reference");
        addSerializedReference(references, id, node, "aria-labelledby");
      }
    }
  }
  for (const [id, uses] of references) {
    const target = parsed.ids.get(id);
    if (!target) throw new Error(`serialized SVG references missing id=${id}`);
    for (const { node, kind } of uses) {
      if (kind === "use" && (target.parent?.name !== "defs" || !isDrawableDefinition(target))) {
        throw new Error(`serialized <use> target #${id} is not a drawable definition`);
      }
      if (kind === "fill" && target.name !== "linearGradient") throw new Error(`serialized fill target #${id} is not a linearGradient`);
      if (kind === "clip-path" && target.name !== "clipPath") throw new Error(`serialized clip-path target #${id} is not a clipPath`);
      if (kind === "aria-labelledby" && !["title", "desc"].includes(target.name)) throw new Error(`serialized aria-labelledby target #${id} is not title or desc`);
      if (!node) throw new Error("serialized SVG has an invalid reference");
    }
  }
  for (const id of parsed.ids.keys()) {
    if (!references.has(id)) throw new Error(`serialized SVG defines unused id=${id}`);
  }
}
function directChildren(node, name) {
  return node.children.filter((child) => child.name === name);
}
function hasDirectUse(node, href) {
  return directChildren(node, "use").some((child) => child.attrs.href === href);
}
function animationNumbers(value, transform = false) {
  const parts = value.split(";");
  return parts.map((part) => {
    const fields = part.trim().split(/\s+/);
    if (transform && (fields.length !== 2 || fields[1] !== "0")) throw new Error(`invalid serialized translate value ${part}`);
    const number = Number(fields[0]);
    if (!Number.isFinite(number)) throw new Error(`invalid serialized animation value ${part}`);
    return number;
  });
}
function parseSerializedAnimation(node) {
  const { attrs } = node;
  if (!attrs.attributeName) throw new Error(`serialized <${node.name}> lacks attributeName`);
  if (attrs.dur !== `${phase.loop}s`) throw new Error(`serialized ${attrs.attributeName} duration is not ${phase.loop}s`);
  if (attrs.repeatCount !== "indefinite") throw new Error(`serialized ${attrs.attributeName} does not repeat indefinitely`);
  if (Object.hasOwn(attrs, "begin")) throw new Error(`serialized ${attrs.attributeName} must not have begin`);
  if (!attrs.values || !attrs.keyTimes) throw new Error(`serialized ${attrs.attributeName} lacks values or keyTimes`);
  const keyTimes = attrs.keyTimes.split(";").map(Number);
  if (keyTimes.some((time) => !Number.isFinite(time))) throw new Error(`serialized ${attrs.attributeName} has invalid keyTimes`);
  if (keyTimes.length !== attrs.values.split(";").length) throw new Error(`serialized ${attrs.attributeName} values/keyTimes length mismatch`);
  if (keyTimes.length < 2 || keyTimes[0] !== 0 || keyTimes.at(-1) !== 1) throw new Error(`serialized ${attrs.attributeName} keyTimes must span 0 to 1`);
  for (let i = 1; i < keyTimes.length; i += 1) {
    if (keyTimes[i] < keyTimes[i - 1] || keyTimes[i] > 1 || keyTimes[i] < 0) throw new Error(`serialized ${attrs.attributeName} keyTimes are not monotonic in [0, 1]`);
  }
  const mode = attrs.calcMode || "linear";
  if (!["linear", "discrete", "spline"].includes(mode)) throw new Error(`serialized ${attrs.attributeName} has unsupported calcMode=${mode}`);
  let splines;
  if (mode === "spline") {
    if (!attrs.keySplines) throw new Error(`serialized spline ${attrs.attributeName} lacks keySplines`);
    splines = attrs.keySplines.split(";");
    if (splines.length !== keyTimes.length - 1 || splines.some((spline) => spline.split(" ").length !== 4 || spline.split(" ").some((part) => !Number.isFinite(Number(part))))) {
      throw new Error(`serialized spline ${attrs.attributeName} has invalid keySplines`);
    }
  } else if (Object.hasOwn(attrs, "keySplines")) {
    throw new Error(`serialized non-spline ${attrs.attributeName} has keySplines`);
  }
  const transform = node.name === "animateTransform";
  if (transform && attrs.type !== "translate") throw new Error("serialized animateTransform is not a translate");
  return { node, parent: node.parent, attributeName: attrs.attributeName, mode, splines, keyTimes, values: animationNumbers(attrs.values, transform) };
}
function assertSerializedAttribute(track, attributeName, mode) {
  if (track.attributeName !== attributeName) throw new Error(`serialized ${track.node.name} targets ${track.attributeName}, not ${attributeName}`);
  if (track.mode !== mode) throw new Error(`serialized ${attributeName} has calcMode=${track.mode}, not ${mode}`);
}
function stateTarget(track) {
  const parent = track.parent;
  if (parent.name !== "g") return null;
  const line = directChildren(parent, "use").find((child) => /^#(?:e|r)\d+-line$/.test(child.attrs.href || ""));
  if (!line || !hasDirectUse(parent, line.attrs.href.replace("-line", "-marks"))) return null;
  const id = line.attrs.href.slice(1, -5);
  const item = records.find((record) => record.id === id);
  if (!item) throw new Error(`serialized state target has unknown record ${id}`);
  const which = line.attrs.stroke === palettes.dark.edge && line.attrs["stroke-opacity"] === palettes.dark.ghostLine ? "ghost"
    : line.attrs.stroke === palettes.dark.node && line.attrs["stroke-dasharray"] === "5 4" ? "flight"
      : line.attrs.stroke === (item.revision ? palettes.dark.ember : palettes.dark.blue) ? "resolved" : null;
  if (!which) throw new Error(`serialized state target ${id} has an unintended group style`);
  return { item, which };
}
function flareTarget(parent) {
  const circles = directChildren(parent, "circle");
  if (parent.name !== "g" || parent.attrs.opacity !== "0" || circles.length !== 2) return null;
  const item = records.find((record) => record.revision && circles.every((circle) => circle.attrs.cx === String(record.available) && circle.attrs.cy === String(rail.bottom)));
  if (!item) throw new Error("serialized flare has an unintended parent target");
  return item;
}
function isWashMaster(parent) {
  return parent.name === "g" && parent.attrs.opacity === "1" && parent.parent?.name === "g" && parent.parent.attrs.opacity === String(WASH_OPACITY)
    && directChildren(parent, "g").length === 2;
}
function washSection(parent) {
  if (parent.name !== "g" || !isWashMaster(parent.parent)) return null;
  const rect = directChildren(parent, "rect")[0];
  if (!rect || rect.attrs.x !== String(rail.left) || rect.attrs.y !== "41" || rect.attrs.height !== "218" || rect.attrs.fill !== palettes.dark.blue) return null;
  if (parent.attrs.opacity === "1" && rect.attrs.width === String(rail.rest - rail.left)) return "forward";
  if (parent.attrs.opacity === "0" && rect.attrs.width === "0") return "returning";
  return null;
}
function cutoffTarget(track) {
  const parent = track.parent;
  if (parent.name !== "g") return null;
  if (parent.attrs.transform === `translate(${rail.rest} 0)`) return "outer";
  if (parent.attrs.transform !== "translate(0 0)") return null;
  if (parent.parent?.attrs.transform === `translate(${rail.rest} 0)`) return "reset";
  if (parent.parent?.attrs.transform === "translate(0 0)" && parent.parent.parent?.attrs.transform === `translate(${rail.rest} 0)` && parent.attrs.opacity === "1") return "returning";
  return null;
}
function classifySerializedTracks(parsed) {
  const animationNodes = parsed.nodes.filter((node) => ["animate", "animateTransform", "set"].includes(node.name));
  if (animationNodes.some((node) => node.name === "set")) throw new Error("serialized dark SVG must not contain <set>");
  if (animationNodes.length !== 171) throw new Error(`serialized dark SVG has ${animationNodes.length} animation elements, not 171`);
  const result = { states: [], flares: [], widths: {}, washOpacity: {}, cutoff: {}, masters: {}, labels: null, all: [] };
  for (const node of animationNodes) {
    const track = parseSerializedAnimation(node);
    result.all.push(track);
    if (node.name === "animateTransform") {
      const name = cutoffTarget(track);
      if (!name || result.cutoff[name]) throw new Error("serialized cutoff translate has an unintended direct parent");
      assertSerializedAttribute(track, "transform", name === "reset" ? "discrete" : "linear");
      result.cutoff[name] = track;
      continue;
    }
    if (node.name !== "animate") throw new Error(`unexpected serialized animation element <${node.name}>`);
    if (track.attributeName === "width") {
      const rect = track.parent;
      const section = washSection(rect.parent);
      if (rect.name !== "rect" || !section || result.widths[section]) throw new Error("serialized wash width animation is not a direct child of its intended rect");
      assertSerializedAttribute(track, "width", "linear");
      result.widths[section] = track;
      continue;
    }
    if (track.attributeName !== "opacity") throw new Error(`serialized animate has unintended attributeName=${track.attributeName}`);
    const state = stateTarget(track);
    if (state) {
      assertSerializedAttribute(track, "opacity", "discrete");
      result.states.push({ ...track, ...state });
      continue;
    }
    const section = washSection(track.parent);
    if (section) {
      assertSerializedAttribute(track, "opacity", "discrete");
      if (result.washOpacity[section]) throw new Error(`serialized wash ${section} has duplicate opacity track`);
      result.washOpacity[section] = track;
      continue;
    }
    if (isWashMaster(track.parent)) {
      assertSerializedAttribute(track, "opacity", "spline");
      if (result.masters.wash) throw new Error("serialized wash has duplicate master opacity track");
      result.masters.wash = track;
      continue;
    }
    const parent = track.parent;
    const flare = flareTarget(parent);
    if (flare) {
      assertSerializedAttribute(track, "opacity", "linear");
      result.flares.push({ ...track, item: flare });
      continue;
    }
    if (parent.name === "g" && parent.attrs.fill === palettes.dark.quiet && directChildren(parent, "text").length === 2) {
      assertSerializedAttribute(track, "opacity", "discrete");
      if (result.labels) throw new Error("serialized labels have duplicate opacity tracks");
      result.labels = track;
      continue;
    }
    if (parent.name === "g" && parent.attrs.opacity === "1" && directChildren(parent, "rect").some((child) => child.attrs.width === "184")) {
      assertSerializedAttribute(track, "opacity", "spline");
      if (result.masters.cutoff) throw new Error("serialized cutoff has duplicate master opacity track");
      result.masters.cutoff = track;
      continue;
    }
    if (parent.name === "g" && parent.attrs.opacity === "1" && parent.parent?.attrs["clip-path"] === "url(#plot)") {
      assertSerializedAttribute(track, "opacity", "spline");
      if (result.masters.data) throw new Error("serialized data has duplicate master opacity track");
      result.masters.data = track;
      continue;
    }
    throw new Error("serialized opacity animation has an unintended direct parent");
  }
  if (result.states.length !== records.length * 3 || result.flares.length !== revisions.length || new Set(result.flares.map((track) => track.item.id)).size !== revisions.length || !result.widths.forward || !result.widths.returning || !result.washOpacity.forward || !result.washOpacity.returning || !result.masters.wash || !result.masters.data || !result.masters.cutoff || !result.labels || Object.keys(result.cutoff).length !== 3) {
    throw new Error("serialized dark SVG is missing an intended animation track");
  }
  for (const item of records) {
    const groups = result.states.filter((track) => track.item.id === item.id);
    if (groups.length !== 3 || new Set(groups.map((track) => track.which)).size !== 3) throw new Error(`serialized ${item.id} is missing a state opacity track`);
  }
  return result;
}
function serializedValueAt(track, time) {
  return valueAt({ keyTimes: track.keyTimes, values: track.values, mode: track.mode, splines: track.splines }, time);
}
function near(left, right, detail) {
  if (Math.abs(left - right) > SERIALIZED_NUMERIC_TOLERANCE) throw new Error(`${detail}: expected ${right}, got ${left}`);
}
function serializedSamples(tracks) {
  const samples = sampleTimes([]);
  for (const track of tracks) for (const keyTime of track.keyTimes) {
    const time = keyTime * phase.loop;
    samples.push(Math.max(0, time - .001), time, Math.min(phase.loop, time + .001));
  }
  return [...new Set(samples.map((time) => time.toFixed(12)))].map(Number).sort((a, b) => a - b);
}
function isSerializedBoundary(time, tracks) {
  return tracks.some((track) => track.keyTimes.some((keyTime) => Math.abs(time - keyTime * phase.loop) < 1e-10));
}
function flareOpacityAt(item, time) {
  const moments = [item.available > rail.rest ? timeFirst(item.available) : timeSecond(item.available)];
  const times = [0, ...moments.flatMap((at) => [Math.max(0, at - .08), at, Math.min(phase.loop, at + .26)]), phase.loop];
  const unique = [...new Set(times.map((at) => Number(at.toFixed(10))))].sort((a, b) => a - b);
  const values = unique.map((at) => moments.some((moment) => Math.abs(at - moment) < .001) ? .86 : 0);
  return valueAt({ times: unique, values, mode: "linear" }, time);
}
function verifySerializedAt(serialized, time, allowBoundaryState = false) {
  const { states, flares, widths, washOpacity, cutoff, masters, labels } = serialized;
  for (const master of Object.values(masters)) near(serializedValueAt(master, time), valueAt(sharedOpacity, time), `serialized master opacity at ${time}s`);
  const master = serializedValueAt(masters.data, time);
  const permittedStatuses = [pureStatusForTime];
  if (allowBoundaryState) {
    permittedStatuses.push((item, at) => pureStatusForTime(item, Math.max(0, at - 2 * SERIALIZED_KEY_TIME_QUANTIZATION_SECONDS)));
    permittedStatuses.push((item, at) => pureStatusForTime(item, Math.min(phase.loop, at + 2 * SERIALIZED_KEY_TIME_QUANTIZATION_SECONDS)));
  }
  for (const item of records) {
    const groups = states.filter((track) => track.item.id === item.id);
    const actual = Object.fromEntries(groups.map((group) => [group.which, serializedValueAt(group, time) * master]));
    const matches = permittedStatuses.some((stateAtTime) => {
      const expected = stateAtTime(item, time);
      return groups.every((group) => Math.abs(actual[group.which] - (group.which === expected ? Number(opacity[group.which]) * master : 0)) <= SERIALIZED_NUMERIC_TOLERANCE);
    });
    if (!matches) throw new Error(`serialized state tracks disagree with the model for ${item.id} at ${time}s: ${JSON.stringify(actual)}`);
  }
  for (const flare of flares) near(serializedValueAt(flare, time), flareOpacityAt(flare.item, time), `serialized flare opacity at ${time}s`);
  const parsedCutoff = serializedValueAt(cutoff.outer, time) + serializedValueAt(cutoff.reset, time) + serializedValueAt(cutoff.returning, time);
  near(parsedCutoff, cutoffAt(time), `serialized cutoff geometry at ${time}s`);
  const washMaster = serializedValueAt(masters.wash, time);
  for (const section of ["forward", "returning"]) {
    const effectiveOpacity = WASH_OPACITY * washMaster * serializedValueAt(washOpacity[section], time);
    if (washMaster <= SERIALIZED_NUMERIC_TOLERANCE && effectiveOpacity > SERIALIZED_NUMERIC_TOLERANCE) throw new Error(`serialized wash ${section} is visible while hidden at ${time}s`);
    if (effectiveOpacity > SERIALIZED_NUMERIC_TOLERANCE) near(rail.left + serializedValueAt(widths[section], time), parsedCutoff, `serialized wash ${section} edge at ${time}s`);
  }
  const labelResume = timeSecond(150);
  const labelAt = (at) => at < phase.reset || at >= labelResume ? 1 : 0;
  const labelCandidates = allowBoundaryState
    ? [labelAt(time), labelAt(Math.max(0, time - 2 * SERIALIZED_KEY_TIME_QUANTIZATION_SECONDS)), labelAt(Math.min(phase.loop, time + 2 * SERIALIZED_KEY_TIME_QUANTIZATION_SECONDS))]
    : [labelAt(time)];
  if (!labelCandidates.some((expected) => Math.abs(serializedValueAt(labels, time) - expected) <= SERIALIZED_NUMERIC_TOLERANCE)) {
    throw new Error(`serialized label opacity at ${time}s disagrees with the model`);
  }
}
function verifySerializedModel(serialized) {
  const samples = serializedSamples(serialized.all);
  for (const time of samples) verifySerializedAt(serialized, time, isSerializedBoundary(time, serialized.all));
  let boundaries = 0;
  for (const track of serialized.all) for (const keyTime of track.keyTimes) {
    const time = keyTime * phase.loop;
    verifySerializedAt(serialized, Math.max(0, time - SERIALIZED_BOUNDARY_PROBE_SECONDS));
    verifySerializedAt(serialized, Math.min(phase.loop, time + SERIALIZED_BOUNDARY_PROBE_SECONDS));
    verifySerializedAt(serialized, time, true);
    boundaries += 1;
  }
  return { samples: samples.length, boundaries };
}
function replaceNth(source, pattern, index, replacement) {
  let seen = 0;
  return source.replace(pattern, (match) => (seen++ === index ? replacement : match));
}
function swapDistinctValues(source) {
  return source.replace(/<animate\b[^>]*\bvalues="([^"]+)"[^>]*\/>/, (tag, sourceValues) => {
    const values = sourceValues.split(";");
    const other = values.findIndex((value) => value !== values[0]);
    if (other < 0) throw new Error("self-test could not find distinct animation values");
    [values[0], values[other]] = [values[other], values[0]];
    return tag.replace(`values="${sourceValues}"`, `values="${values.join(";")}"`);
  });
}
function shiftFirstKeyTime(source) {
  return source.replace(/<animate\b[^>]*\bkeyTimes="([^"]+)"[^>]*\/>/, (tag, sourceTimes) => {
    const times = sourceTimes.split(";");
    times[1] = String(Number(times[1]) + .01);
    return tag.replace(`keyTimes="${sourceTimes}"`, `keyTimes="${times.join(";")}"`);
  });
}
function stuckWashWidth(source) {
  return source.replace(/(<rect\b[^>]*\bwidth="0"[^>]*>)(<animate\b[^>]*\battributeName="width"[^>]*\/>)/, (match, open, animation) => {
    const values = animation.match(/\bvalues="([^"]+)"/)[1].split(";").map(() => String(rail.rest - rail.left)).join(";");
    return `${open}${animation.replace(/\bvalues="[^"]+"/, `values="${values}"`)}`;
  });
}
function validateSerializedDark(candidate) {
  const parsed = parseSerializedSvg(candidate);
  assertSerializedAllowlist(parsed, "dark");
  return verifySerializedModel(classifySerializedTracks(parsed));
}
function validatePair(dark, light, expected) {
  validateSerializedDark(dark);
  assertSerializedLight(light);
  assertGolden(dark, light, expected);
}
function assertSerializedMutation(name, svg, validate = validateSerializedDark) {
  try {
    validate(svg);
  } catch {
    return "CAUGHT";
  }
  throw new Error(`serialized mutation was not caught: ${name}`);
}
function assertSerializedLight(svg) {
  const parsed = parseSerializedSvg(svg);
  assertSerializedAllowlist(parsed, "light");
}
function declarationForMutation() {
  return '<?xml version="1.0" encoding="UTF-8"?>';
}
function assertSerializedSelfTests(svg, lightSvg, expected) {
  const withFirstAnimationAttribute = (name, value) => svg.replace(/(<animate(?:Transform)?\b[^>]*)(\/>)/, `$1 ${name}="${value}"$2`);
  const truncateFirstValues = (source) => source.replace(/(<animate\b[^>]*\bvalues=")([^"]+)("[^>]*\/>)/, (match, before, values, after) => `${before}${values.split(";").slice(0, -1).join(";")}${after}`);
  const reorderFirstKeyTimes = (source) => source.replace(/(<animate\b[^>]*\bkeyTimes=")([^"]+)("[^>]*\/>)/, (match, before, sourceTimes, after) => {
    const times = sourceTimes.split(";");
    [times[1], times[2]] = [times[2], times[1]];
    return `${before}${times.join(";")}${after}`;
  });
  const brokenSplineCount = svg.replace(/\bkeySplines="([^"]+);[^"]+"/, 'keySplines="$1"');
  const cutoffValues = `values="${rail.rest} 0;${rail.right} 0;${rail.right} 0;${rail.right} 0;${rail.right} 0"`;
  const mutations = [
    ["wrong-opacity-attribute", svg.replace(/(<animate\b[^>]*\battributeName=")opacity(")/, "$1width$2")],
    ["wrong-wash-attribute", svg.replace(/(<animate\b[^>]*\battributeName=")width(")/, "$1opacity$2")],
    ["wrong-transform-attribute", svg.replace(/(<animateTransform\b[^>]*\battributeName=")transform(")/, "$1opacity$2")],
    ["wash-width-on-parent-g", svg.replace(/(<rect\b[^>]*>)(<animate\b[^>]*\battributeName="width"[^>]*\/>)<\/rect>/, "$1</rect>$2")],
    ["dropped-track", svg.replace(/<animate\b[^>]*\bcalcMode="discrete"[^>]*\/>/, "")],
    ["extra-track", svg.replace("</svg>", '<animate attributeName="opacity" dur="28s" repeatCount="indefinite" values="0;1" keyTimes="0;1"/></svg>')],
    ["shifted-key-time", shiftFirstKeyTime(svg)],
    ["reordered-key-times", reorderFirstKeyTimes(svg)],
    ["key-time-out-of-range", svg.replace(/\bkeyTimes="0;/, 'keyTimes="-0.1;')],
    ["values-key-times-mismatch", truncateFirstValues(svg)],
    ["swapped-values", swapDistinctValues(svg)],
    ["truncated-values", truncateFirstValues(svg)],
    ["duration-changed", svg.replace('dur="28s"', 'dur="27s"')],
    ["begin-added", withFirstAnimationAttribute("begin", "1s")],
    ["end-added", withFirstAnimationAttribute("end", "1s")],
    ["from-added", withFirstAnimationAttribute("from", "0")],
    ["to-added", withFirstAnimationAttribute("to", "1")],
    ["by-added", withFirstAnimationAttribute("by", "1")],
    ["additive-added", withFirstAnimationAttribute("additive", "sum")],
    ["accumulate-added", withFirstAnimationAttribute("accumulate", "sum")],
    ["animation-fill-added", withFirstAnimationAttribute("fill", "freeze")],
    ["min-added", withFirstAnimationAttribute("min", "1s")],
    ["max-added", withFirstAnimationAttribute("max", "2s")],
    ["restart-added", withFirstAnimationAttribute("restart", "never")],
    ["repeat-count-changed", svg.replace('repeatCount="indefinite"', 'repeatCount="2"')],
    ["discrete-made-linear", svg.replace('calcMode="discrete"', 'calcMode="linear"')],
    ["bad-spline-count", brokenSplineCount],
    ["stuck-wash-width", stuckWashWidth(svg)],
    ["duplicate-id", svg.replace('<rect width="1440"', '<rect id="e0-line" width="1440"')],
    ["missing-use-target", svg.replace('id="e0-line"', 'id="e0-line-gone"')],
    ["missing-master-opacity", replaceNth(svg, /<animate\b[^>]*\bcalcMode="spline"[^>]*\/>/g, 1, "")],
    ["altered-master-opacity", svg.replace('values="1;1;0;1;1"', 'values="1;1;1;1;1"')],
    ["altered-cutoff-translate", svg.replace(cutoffValues, `values="${rail.rest} 0;${rail.right - 1} 0;${rail.right - 1} 0;${rail.right - 1} 0;${rail.right - 1} 0"`)],
    ["missing-flare-track", svg.replace(/(<circle\b[^>]*\bstroke-width="1"\/>)(<animate\b[^>]*\/>)(<\/g>)/, "$1$3")],
    ["altered-label-opacity", svg.replace(/(<g fill="#667788"[\s\S]*?<animate\b[^>]*\bvalues=")[^"]+/, "$11;1;1;1;1")],
    ["light-has-animate", lightSvg.replace("</svg>", '<animate attributeName="opacity" dur="28s" repeatCount="indefinite" values="0;1" keyTimes="0;1"/></svg>'), assertSerializedLight],
    ["script-inserted", svg.replace("</svg>", "<script/></svg>")],
    ["foreign-object-inserted", svg.replace("</svg>", "<foreignObject/></svg>")],
    ["external-xlink-href", svg.replace("<use href=", '<use xlink:href="https://invalid.example/shape" href=')],
    ["dark-animate-motion", svg.replace("</svg>", '<animateMotion dur="28s"/></svg>')],
    ["light-animate-motion", lightSvg.replace("</svg>", '<animateMotion dur="28s"/></svg>'), assertSerializedLight],
    ["unclosed-svg", svg.replace("</svg>", "")],
    ["oddly-quoted-attribute", svg.replace('dur="28s"', "dur=28s")],
    ["cdata-inserted", svg.replace("</svg>", "<![CDATA[x]]></svg>")],
    ["comment-inserted", svg.replace("</svg>", "<!--x--></svg>")],
    ["unknown-entity-text", svg.replace("</svg>", "&mystery;</svg>")],
    ["set-inserted", svg.replace("</svg>", "<set/></svg>")],
    ["style-inserted", svg.replace("</svg>", "<style/></svg>")],
    ["onload-added", svg.replace("<svg ", '<svg onload="alert(1)" ')],
    ["image-inserted", svg.replace("</svg>", '<image href="#field"/></svg>')],
    ["scheme-href", svg.replace(/<use href="#[^"]+"/, '<use href="https://invalid.example/shape"')],
    ["text-outside-text-element", svg.replace("</defs>", "outside</defs>")],
    ["duplicated-attribute", svg.replace('<rect width="1440"', '<rect width="1440" width="1"')],
    ["unknown-rect-attribute", svg.replace('<rect width="1440"', '<rect nope="1" width="1440"')],
    ["unknown-defs-child", svg.replace("</defs>", '<radialGradient id="extra"/></defs>')],
    ["doctype-inserted", svg.replace(declarationForMutation(), '<!DOCTYPE svg>' + declarationForMutation())],
    ["processing-instruction-inserted", svg.replace(declarationForMutation(), declarationForMutation() + "<?test value?>")],
    ["use-targets-gradient", svg.replace(/<use href="#[^"]+"/, '<use href="#field"')],
    ["dark-viewbox-changed", svg.replace('viewBox="0 0 1440 300"', 'viewBox="0 0 1441 300"'), (candidate) => validatePair(candidate, lightSvg, expected)],
    ["light-viewbox-changed", lightSvg.replace('viewBox="0 0 1440 300"', 'viewBox="0 0 1441 300"'), (candidate) => validatePair(svg, candidate, expected)],
    ["gradient-stop-colour-changed", svg.replace('stop-color="#0d1117"', 'stop-color="#0d1118"'), (candidate) => validatePair(candidate, lightSvg, expected)],
    ["grid-stroke-changed", svg.replace('stroke="#27313a"', 'stroke="#27313b"'), (candidate) => validatePair(candidate, lightSvg, expected)],
    ["path-geometry-changed", svg.replace(/<path id="e0-line" d="[^"]+"/, '<path id="e0-line" d="M0 0"'), (candidate) => validatePair(candidate, lightSvg, expected)],
    ["extra-overlay-rect", svg.replace("</svg>", '<rect x="0" y="0" width="1" height="1" fill="#0d1117"/></svg>'), (candidate) => validatePair(candidate, lightSvg, expected)],
    ["grid-transform-added", svg.replace('<g fill="none" stroke="#27313a"', '<g transform="translate(1 0)" fill="none" stroke="#27313a"'), (candidate) => validatePair(candidate, lightSvg, expected)],
    ["cutoff-clip-path-removed", svg.replace('<g clip-path="url(#plot)"><g transform="translate(900 0)">', '<g><g transform="translate(900 0)">'), (candidate) => validatePair(candidate, lightSvg, expected)],
    ["title-replaced", svg.replace(">Two clocks</title>", ">Another title</title>"), (candidate) => validatePair(candidate, lightSvg, expected)],
  ];
  const rows = mutations.map(([name, altered, validate]) => `| ${name} | ${assertSerializedMutation(name, altered, validate)} |`).join("\n");
  console.log(`Hero serialized mutation self-test PASS:\n| Mutation | Result |\n| --- | --- |\n${rows}`);
}
function assertSerializedDark(svg, lightSvg, expected) {
  const parsed = parseSerializedSvg(svg);
  assertSerializedAllowlist(parsed, "dark");
  const tracks = classifySerializedTracks(parsed);
  const { samples, boundaries } = verifySerializedModel(tracks);
  if (!process.env.HERO_SKIP_SELF_TESTS) assertSerializedSelfTests(svg, lightSvg, expected);
  console.log(`Hero serialized animation check PASS: ${tracks.all.length} tracks, ${samples} dense samples, ${boundaries} emitted key-time boundaries; ±${SERIALIZED_BOUNDARY_PROBE_SECONDS}s probes are exact outside boundaries (key-time quantization < ${SERIALIZED_KEY_TIME_QUANTIZATION_SECONDS}s).`);
}

const injectedChanges = Object.freeze({
  "dark-viewbox-changed": (svg) => svg.replace('viewBox="0 0 1440 300"', 'viewBox="0 0 1441 300"'),
  "light-viewbox-changed": (svg) => svg.replace('viewBox="0 0 1440 300"', 'viewBox="0 0 1441 300"'),
  "gradient-stop-colour-changed": (svg) => svg.replace('stop-color="#0d1117"', 'stop-color="#0d1118"'),
  "grid-stroke-changed": (svg) => svg.replace('stroke="#27313a"', 'stroke="#27313b"'),
  "path-geometry-changed": (svg) => svg.replace(/<path id="e0-line" d="[^"]+"/, '<path id="e0-line" d="M0 0"'),
  "extra-overlay-rect": (svg) => svg.replace("</svg>", '<rect x="0" y="0" width="1" height="1" fill="#0d1117"/></svg>'),
  "grid-transform-added": (svg) => svg.replace('<g fill="none" stroke="#27313a"', '<g transform="translate(1 0)" fill="none" stroke="#27313a"'),
  "cutoff-clip-path-removed": (svg) => svg.replace('<g clip-path="url(#plot)"><g transform="translate(900 0)">', '<g><g transform="translate(900 0)">'),
  "title-replaced": (svg) => svg.replace(">Two clocks</title>", ">Another title</title>"),
  "duration-changed": (svg) => svg.replace('dur="28s"', 'dur="27s"'),
});
function injectChange(theme, svg) {
  const name = process.env.HERO_TEST_CHANGE;
  if (!name) return svg;
  const change = injectedChanges[name];
  if (!change) throw new Error(`unknown test change: ${name}`);
  if ((name === "light-viewbox-changed") !== (theme === "light")) return svg;
  if (name === "light-viewbox-changed" || theme === "dark") return change(svg);
  return svg;
}
function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}
function assetHashes(directory) {
  const assetRoot = resolve(directory, "assets");
  const paths = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else paths.push(child);
    }
  }
  visit(assetRoot);
  return paths.sort().map((path) => `${path.slice(assetRoot.length)}:${digest(readFileSync(path, "utf8"))}`).join(" ");
}
function temporaryAssets(directory) {
  return readdirSync(resolve(directory, "assets")).filter((name) => name.endsWith(".tmp"));
}
function assertNoWriteOnFailure() {
  const temporary = mkdtempSync(join(tmpdir(), "hero-write-check-"));
  const copy = join(temporary, "repo");
  try {
    cpSync(root, copy, { recursive: true, filter: (source) => basename(source) !== ".git" });
    runCommand("git", ["init", "--quiet", copy]);
    runCommand("git", ["-C", copy, "add", "-A"]);
    runCommand("git", ["-C", copy, "-c", "user.name=check", "-c", "user.email=check@example.invalid", "commit", "--quiet", "-m", "hero check baseline"]);
    const fixtureGolden = readFileSync(resolve(copy, "assets/hero.sha256"), "utf8");
    const cases = [
      ...Object.keys(injectedChanges).map((name) => ({ name, args: [], change: name })),
      { name: "update-golden-refuses-invalid", args: ["--update-golden"], change: "duration-changed" },
      { name: "second-rename-failure", args: [], fault: "second-rename-failure" },
      { name: "manifest-write-failure", args: ["--update-golden"], fault: "manifest-write-failure" },
      { name: "temp-reread-failure", args: [], fault: "temp-reread-failure" },
      { name: "manifest-leading-blank-line", args: [], prepare: () => writeFileSync(resolve(copy, "assets/hero.sha256"), `\n${fixtureGolden}`) },
      { name: "manifest-extra-blank-line", args: [], prepare: () => writeFileSync(resolve(copy, "assets/hero.sha256"), fixtureGolden.replace("\n", "\n\n")) },
    ];
    const rows = [];
    for (const test of cases) {
      test.prepare?.();
      if (test.prepare) {
        runCommand("git", ["-C", copy, "add", "assets/hero.sha256"]);
        runCommand("git", ["-C", copy, "-c", "user.name=check", "-c", "user.email=check@example.invalid", "commit", "--quiet", "-m", `hero fixture ${test.name}`]);
      }
      const before = assetHashes(copy);
      const result = spawnSync(process.execPath, [resolve(copy, "scripts/generate-hero.mjs"), ...test.args], {
        cwd: copy,
        encoding: "utf8",
        env: { ...process.env, HERO_SKIP_SELF_TESTS: "1", HERO_TEST_CHANGE: test.change, HERO_TEST_FAULT: test.fault },
      });
      const after = assetHashes(copy);
      const status = runCommand("git", ["-C", copy, "status", "--porcelain"]);
      const leftovers = temporaryAssets(copy);
      if (result.status === 0 || before !== after || status || leftovers.length) throw new Error(`write safety check failed: ${test.name}`);
      rows.push(`| ${test.name} | CAUGHT | unchanged |`);
    }
    console.log(`Hero write safety self-test PASS (temporary repository clean):\n| Change | Result | Files |\n| --- | --- | --- |\n${rows.join("\n")}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const options = new Set(process.argv.slice(2));
for (const option of options) if (!new Set(["--update-golden", "--self-check"]).has(option)) throw new Error(`unknown option: ${option}`);
const darkPath = resolve(assets, "hero-dark.svg");
const lightPath = resolve(assets, "hero-light.svg");
const darkSvg = injectChange("dark", hero("dark"));
const lightSvg = injectChange("light", hero("light"));
const expected = options.has("--update-golden") ? generatedHashes(darkSvg, lightSvg) : readGolden();

assertSerializedDark(darkSvg, lightSvg, expected);
validatePair(darkSvg, lightSvg, expected);

const publication = [
  { name: "dark", path: darkPath, text: darkSvg },
  { name: "light", path: lightPath, text: lightSvg },
];
if (options.has("--update-golden")) publication.push({ name: "manifest", path: goldenPath, text: goldenText(expected) });
publish(publication, (written) => {
  const writtenDark = written.get(darkPath);
  const writtenLight = written.get(lightPath);
  validatePair(writtenDark, writtenLight, expected);
  if (options.has("--update-golden")) assertGolden(writtenDark, writtenLight, parseGolden(written.get(goldenPath)));
});
if (options.has("--self-check")) assertNoWriteOnFailure();
