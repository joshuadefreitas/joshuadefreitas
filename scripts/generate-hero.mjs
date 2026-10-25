#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, "assets");
mkdirSync(assets, { recursive: true });

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

const darkTracks = [];
writeFileSync(resolve(assets, "hero-dark.svg"), hero("dark", darkTracks));
assertStateModel(darkTracks);
writeFileSync(resolve(assets, "hero-light.svg"), hero("light"));
