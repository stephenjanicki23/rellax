export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const logistic = (x: number): number => 1 / (1 + Math.exp(-x));

export const logit = (p: number): number => {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const round = (v: number, dp = 0): number => {
  const m = 10 ** dp;
  return Math.round(v * m) / m;
};

export const sum = (arr: readonly number[]): number => {
  let s = 0;
  for (const v of arr) s += v;
  return s;
};

export const mean = (arr: readonly number[]): number => (arr.length ? sum(arr) / arr.length : 0);

export const stdev = (arr: readonly number[]): number => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
};

export const percentile = (arr: readonly number[], p: number): number => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lerp(sorted[lo], sorted[hi], idx - lo);
};

/** Histogram with fixed integer bins. */
export const histogram = (arr: readonly number[], min: number, max: number, step = 1): { bin: number; count: number }[] => {
  const bins: { bin: number; count: number }[] = [];
  for (let b = min; b <= max; b += step) bins.push({ bin: b, count: 0 });
  for (const v of arr) {
    const i = clamp(Math.floor((v - min) / step), 0, bins.length - 1);
    bins[i].count++;
  }
  return bins;
};

export const sortBy = <T>(arr: T[], key: (t: T) => number, desc = true): T[] =>
  arr.sort((a, b) => (desc ? key(b) - key(a) : key(a) - key(b)));
