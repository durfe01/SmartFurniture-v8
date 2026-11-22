// Monte Carlo: stability of aspect-ratio recovery from 4 manually clicked corners.
type P = { x: number; y: number };
type Q = [P, P, P, P]; // TL, TR, BR, BL
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const tri = (a: number[], b: number[], c: number[]) => dot(cross(a, b), c);

function parts(q: Q, cx: number, cy: number) {
  const m = (p: P) => [p.x - cx, p.y - cy, 1];
  const [TL, TR, BR, BL] = q;
  const m1 = m(TL), m2 = m(TR), m3 = m(BL), m4 = m(BR); // Zhang Z-order
  const k2 = tri(m1, m4, m3) / tri(m2, m4, m3), k3 = tri(m1, m4, m2) / tri(m3, m4, m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  return { n2, n3, f2 };
}
const arWithF2 = (n2: number[], n3: number[], f2: number) =>
  Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2));
export const arZhang = (q: Q, cx: number, cy: number) => { const p = parts(q, cx, cy); return p.f2 > 0 && isFinite(p.f2) ? arWithF2(p.n2, p.n3, p.f2) : NaN; };
export const arKnownF = (q: Q, cx: number, cy: number, f: number) => { const p = parts(q, cx, cy); return arWithF2(p.n2, p.n3, f * f); };
const d = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
export const arEuclid = (q: Q) => (d(q[0], q[1]) + d(q[3], q[2])) / (d(q[0], q[3]) + d(q[1], q[2]));

function rng(s: number) { return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// Display-resolution image the user actually clicks on (phone screen), 26 mm-equivalent lens.
const IW = 1000, IH = 750, f = (26 / 43.27) * Math.hypot(IW, IH);
function project(w: number, h: number, pitchDeg: number, yawDeg: number): Q {
  const p = (pitchDeg * Math.PI) / 180, y = (yawDeg * Math.PI) / 180;
  const D = (h / 0.7) * f / IH; // furniture fills ~70 % of frame height
  return ([[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2], [-w / 2, -h / 2]] as const).map(([X, Y]) => {
    let x = X, yy = Y * Math.cos(p), z = Y * Math.sin(p);           // pitch (about X)
    const x2 = x * Math.cos(y) + z * Math.sin(y); z = -x * Math.sin(y) + z * Math.cos(y); x = x2; // yaw (about Y)
    z += D;
    return { x: IW / 2 + (f * x) / z, y: IH / 2 - (f * yy) / z };
  }) as Q;
}

const cases = [
  { name: 'Frontal casi perfecto (pitch 3°, yaw 3°)', pitch: 3, yaw: 3 },
  { name: 'Clóset típico: celular inclinado (pitch 15°, yaw 0°)', pitch: 15, yaw: 0 },
  { name: 'Clóset desde costado (pitch 12°, yaw 20°)', pitch: 12, yaw: 20 },
  { name: 'Foto muy oblicua (pitch 20°, yaw 35°)', pitch: 20, yaw: 35 },
];
const W = 1500, H = 2100, trueAR = W / H, N = 4000, sigmaPx = 2.5;
const pct = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
console.log(`True AR = ${trueAR.toFixed(4)} | click noise σ = ${sigmaPx}px on ${IW}x${IH} display | f = ${f.toFixed(0)}px`);
for (const c of cases) {
  const r = rng(42), base = project(W, H, c.pitch, c.yaw);
  const err: Record<string, number[]> = { euclid: [], zhang: [], fPrior: [], fPrior15: [] };
  let zhangInvalid = 0;
  for (let i = 0; i < N; i++) {
    const q = base.map(p => ({ x: p.x + sigmaPx * gauss(r), y: p.y + sigmaPx * gauss(r) })) as Q;
    const e = (v: number) => (100 * Math.abs(v - trueAR)) / trueAR;
    err.euclid.push(e(arEuclid(q)));
    const z = arZhang(q, IW / 2, IH / 2);
    if (isNaN(z)) { zhangInvalid++; err.zhang.push(e(arEuclid(q))); } else err.zhang.push(e(z));
    err.fPrior.push(e(arKnownF(q, IW / 2, IH / 2, f)));
    err.fPrior15.push(e(arKnownF(q, IW / 2, IH / 2, f * 1.15))); // prior off by 15 %
  }
  console.log(`\n${c.name}  (Zhang f² inválido: ${((100 * zhangInvalid) / N).toFixed(1)} %)`);
  for (const [k, v] of Object.entries(err)) console.log(`  ${k.padEnd(9)} mediana ${pct(v, 0.5).toFixed(2).padStart(6)} %   p95 ${pct(v, 0.95).toFixed(2).padStart(6)} %`);
}
