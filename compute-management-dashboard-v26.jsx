import React, { useState, useMemo, useCallback, useEffect, useSyncExternalStore } from "react";

// ═════════════════════════════════════════════════════════════════════════════
// SHARED DATA LAYER — one book of record for supply and demand, read by both the
// Compute Supply and Compute Demand tabs so they reconcile against the same
// numbers (a miniature of the "compute intelligence platform": single source of
// truth for supply, demand, utilization, and capacity planning). Edits on either
// tab propagate live via useSyncExternalStore.
// ═════════════════════════════════════════════════════════════════════════════
// Seed book sized to TRACK the cohort demand curve (Compute Demand tab): a tight
// base delivering ~m1 demand today, then reserved blocks that ramp online in
// staggered tranches so delivered capacity climbs with demand rather than sitting
// idle. Every reserved rate is below both sell anchors (train $2.10 / inf $2.60,
// Compute Demand tab), so served capacity is gross-margin positive; long terms
// (30mo > horizon) keep the book from rolling off mid-projection. The result is
// a J-curve: a shallow early burn while capacity is pre-committed ahead of the
// ramp, then revenue outpaces COGS and free cash flow climbs through the horizon.
// Chip lean matters: demand is ~70% training, so the book is weighted to balanced
// H100/B200 (usable by either workload) with H200 covering the inference share.
const SEED_SUPPLY = [
  // ── Reserved H100/H200 core (Hopper HGX 8-GPU + IB NDR) ──────────────────
  { id: 1,  provider: "CoreWeave",       gpu: "H100", gpus: 8200,  structure: "reserved", rate: 1.68, termMo: 30, remMo: 30, upfrontPct: 20, pay: "prepay_q", region: "US-East",    ic: "ib32", soldPct: 92, status: "active" },
  { id: 2,  provider: "Voltage Park",    gpu: "H100", gpus: 6200,  structure: "reserved", rate: 1.60, termMo: 30, remMo: 30, upfrontPct: 10, pay: "prepay_m", region: "US-Central", ic: "ib32", soldPct: 60, rampMo: 14, status: "active" },
  { id: 3,  provider: "Hyperstack",      gpu: "H100", gpus: 1600,  structure: "reserved", rate: 1.72, termMo: 24, remMo: 24, upfrontPct: 10, pay: "prepay_q", region: "US-East",    ic: "ib32", soldPct: 70, rampMo: 4,  status: "active" },
  { id: 4,  provider: "Crusoe",          gpu: "H200", gpus: 2800,  structure: "reserved", rate: 1.72, termMo: 30, remMo: 30, upfrontPct: 15, pay: "prepay_m", region: "US-Central", ic: "ib32", soldPct: 90, status: "active" },
  { id: 5,  provider: "Nebius",          gpu: "H200", gpus: 1850,  structure: "reserved", rate: 1.62, termMo: 30, remMo: 30, upfrontPct: 0,  pay: "net30",    region: "Nordics",    ic: "ib16", soldPct: 85, status: "active" },
  { id: 6,  provider: "Nebius",          gpu: "H200", gpus: 5800,  structure: "reserved", rate: 1.58, termMo: 30, remMo: 30, upfrontPct: 0,  pay: "net30",    region: "EU",         ic: "ib32", soldPct: 36, rampMo: 20, status: "active" },
  // ── Reserved B200 (Blackwell HGX 8-GPU) ───────────────────────────────────
  { id: 7,  provider: "Crusoe",          gpu: "B200", gpus: 4500,  structure: "reserved", rate: 1.70, termMo: 30, remMo: 30, upfrontPct: 20, pay: "prepay_q", region: "US-Central", ic: "ib32", soldPct: 46, rampMo: 17, status: "active" },
  { id: 8,  provider: "DC partner",      gpu: "B200", gpus: 13700, structure: "reserved", rate: 1.64, termMo: 30, remMo: 30, upfrontPct: 25, pay: "prepay_q", region: "US-West",    ic: "ib32", soldPct: 26, rampMo: 22, status: "active" },
  { id: 9,  provider: "Nebius",          gpu: "B200", gpus: 2200,  structure: "reserved", rate: 1.85, termMo: 24, remMo: 24, upfrontPct: 15, pay: "prepay_q", region: "US-East",    ic: "ib32", soldPct: 40, rampMo: 6,  status: "active" },
  // ── Reserved B300 / GB300 NVL72 rack-scale (Blackwell Ultra 288GB) ────────
  { id: 10, provider: "CoreWeave",       gpu: "B300", gpus: 4320,  structure: "reserved", rate: 2.20, termMo: 36, remMo: 36, upfrontPct: 25, pay: "prepay_q", region: "US-East",    ic: "nvl72", soldPct: 10, rampMo: 16, status: "active" },
  { id: 11, provider: "Nebius",          gpu: "B300", gpus: 1440,  structure: "reserved", rate: 2.10, termMo: 30, remMo: 30, upfrontPct: 15, pay: "prepay_m", region: "EU",         ic: "nvl72", soldPct: 8,  rampMo: 8,  status: "active" },
  { id: 12, provider: "Vultr",           gpu: "B300", gpus: 512,   structure: "reserved", rate: 2.40, termMo: 18, remMo: 18, upfrontPct: 10, pay: "prepay_q", region: "US-East",    ic: "ib32",  soldPct: 20, rampMo: 4,  status: "active" },
  // ── Inference-optimized L40S (PCIe within node + IB scale-out) ───────────
  { id: 13, provider: "CoreWeave",       gpu: "L40S", gpus: 800,   structure: "reserved", rate: 0.85, termMo: 24, remMo: 24, upfrontPct: 10, pay: "prepay_q", region: "US-East",    ic: "roce",  soldPct: 75, status: "active" },
  // ── A100 tail (still widely used at scale) ─────────────────────────────────
  { id: 14, provider: "Denvr Dataworks", gpu: "A100_80", gpus: 1024, structure: "reserved", rate: 0.65, termMo: 12, remMo: 12, upfrontPct: 30, pay: "prepay_q", region: "US-Central", ic: "ib32", soldPct: 60, status: "active" },
  // ── On-demand + spot flex layer ────────────────────────────────────────────
  { id: 15, provider: "Lambda Labs",     gpu: "H100", gpus: 1500,  structure: "ondemand", rate: 2.49, termMo: 0,  remMo: 0,  upfrontPct: 0,  pay: "net30",    region: "US-West",    ic: "roce", soldPct: 55, status: "active" },
  { id: 16, provider: "GCP",             gpu: "H200", gpus: 640,   structure: "ondemand", rate: 4.20, termMo: 0,  remMo: 0,  upfrontPct: 0,  pay: "net30",    region: "US-West",    ic: "ib32", soldPct: 45, status: "active" },
  { id: 17, provider: "Community/spot",  gpu: "H100", gpus: 2900,  structure: "spot",     rate: 1.05, termMo: 0,  remMo: 0,  upfrontPct: 0,  pay: "prepay_m", region: "Global (mixed)", ic: "eth", soldPct: 65, status: "active" },
];
// Demand book: committed + pipeline consumption of compute. kind distinguishes
// training runs (finite, research-driven) from inference contracts (ongoing,
// revenue-generating). gpuClass/fabric are the hard requirements a position must
// satisfy; startMo/durationMo place the demand on the calendar for reconciliation.
const SEED_DEMAND = [
  { id: 1, name: "Frontier RL post-train",   kind: "training",  gpu: "H200", gpus: 3584, fabric: "ib32", startMo: 0,  durationMo: 3,  price: 2.9, status: "committed", region: "US-Central", model: "l405" },
  { id: 2, name: "Partner lab — 70B SFT",    kind: "training",  gpu: "H100", gpus: 1792, fabric: "ib32", startMo: 1,  durationMo: 2,  price: 2.7, status: "committed", region: "US-East",    model: "l70" },
  { id: 3, name: "DeepSeek-R1 serving",      kind: "inference", gpu: "H200", gpus: 896,  fabric: "ib32", startMo: 0,  durationMo: 12, price: 2.8, status: "committed", region: "US-Central", model: "ds" },
  { id: 4, name: "Qwen-72B API endpoint",    kind: "inference", gpu: "H100", gpus: 672,  fabric: "roce", startMo: 0,  durationMo: 12, price: 2.4, status: "committed", region: "US-West",    model: "q72" },
  { id: 5, name: "Enterprise agent workload",kind: "inference", gpu: "H100", gpus: 1260, fabric: "roce", startMo: 2,  durationMo: 10, price: 2.5, status: "pipeline",  region: "US-East",    model: "l70" },
  { id: 6, name: "GB200 pretraining (Q3)",   kind: "training",  gpu: "B200", gpus: 1792, fabric: "ib32", startMo: 3,  durationMo: 5,  price: 4.8, status: "pipeline",  region: "US-Central", model: "l405" },
];

// Delivery ramp: rampMo = months until a position is fully delivered (0 = live
// now). Capacity comes online linearly: fraction live in month m (1-indexed,
// from today) = min(1, m / rampMo). Cost and revenue both follow delivery —
// you don't pay for undelivered GPUs, and you can't sell them either. This is
// how nine-figure reserved blocks actually land: in tranches over quarters.
const liveFracOf = (r, m) => { const ramp = r.rampMo || 0; return ramp > 0 ? Math.min(1, m / ramp) : 1; };

const makeBookStore = (initial) => {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set: (next) => { state = typeof next === "function" ? next(state) : next; listeners.forEach(l => l()); },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
};
const SUPPLY_STORE = makeBookStore(SEED_SUPPLY);
const DEMAND_STORE = makeBookStore(SEED_DEMAND);

// Customer-cohort demand model (Prime Intellect-style bottoms-up build): demand
// = customers × per-customer compute intensity, by segment. Training uses an
// expected-concurrency approximation: concurrent H100e = customers × (runs/yr ÷ 12)
// × run duration (mo) × run size. Lives in its own store so the Compute Demand
// tab owns the assumptions and the Projections tab can seed its driver table
// from them.
// Customer-cohort demand model, monthly-driver edition: each segment carries a
// per-month driver row (customer adds/churn %, inference H100e per customer,
// training runs/yr × size × duration) so every assumption is editable per month
// in the Compute Demand tab's demand build — same columns-as-months format as
// the Projections tab. Month 1 is the starting actual (drivers ignored there).
const COHORT_MONTHS = 24;

// ─── Workload baselines — monthly training & inference assumptions ──────────
// Columns are months. The TRAINING baseline describes the "typical frontier
// run" each month (avg model size, token budget, wall-clock, MFU); the
// INFERENCE baseline describes the typical serving workload (active params,
// weight precision, tokens per query, serving efficiency). Every cell is
// editable. From each we derive a BASELINE INDEX (month 1 = 1.00) that shapes
// the per-customer footprints in the demand build; cohorts then apply ±% flex
// to ride the baseline harder (enterprise) or softer (individuals).
// Growth-driven fields: each carries a `<field>G` %/mo companion driver so the
// modeler tables can expose month-over-month growth as the editable assumption
// (month 1 is the anchor; months 2+ compound from it).
const GROWTH_FIELDS = { train: ["modelB", "tokensT"], inf: ["modelB", "inTok", "outTok"] };
const withGrowth = (rows, fields) => rows.map((r, i) => {
  const out = { ...r };
  fields.forEach(f => { out[f + "G"] = i === 0 ? 0 : Math.round(((r[f] / (rows[i - 1][f] || 1)) - 1) * 1000) / 10; });
  return out;
});
const RAW_TRAIN = Array.from({ length: COHORT_MONTHS }, (_, i) => {
  const g = Math.min(i, 18) / 12; // growth plateaus at month 19
  return {
    modelB: Math.round(70 * Math.pow(1.6, g)),          // avg params per run, B
    tokensT: Math.round(15 * Math.pow(1.4, g) * 10) / 10, // training tokens, T
    days: Math.round(30 + i * 0.6),                     // wall-clock per run
    mfu: 40,                                            // model FLOP utilization %
  };
});
const RAW_INF = Array.from({ length: COHORT_MONTHS }, (_, i) => ({
  modelB: Math.round(40 * Math.pow(1.25, i / 12) * 10) / 10, // avg ACTIVE params served, B
  bytes: 1,                                                  // bytes/param (1 = FP8, 0.5 = FP4)
  inTok: Math.round(4096 * Math.pow(1.9, i / 12)),           // input tokens / query (agentic growth)
  outTok: Math.round(512 * Math.pow(1.3, i / 12)),           // output tokens / query
  effPct: 80,                                                // serving efficiency %
}));
const SEED_BASELINE = {
  train: withGrowth(RAW_TRAIN, GROWTH_FIELDS.train),
  inf: withGrowth(RAW_INF, GROWTH_FIELDS.inf),
};
const BASELINE_STORE = makeBookStore(SEED_BASELINE);

// Derive the baseline indices. Training run concurrency ∝ FLOPs ÷ wall-clock
// ÷ MFU = 6·N·D / (days × MFU); the index is that quantity relative to month 1.
// Inference footprint ∝ bytes streamed per query × query intensity ÷ efficiency
// = activeB × bytes × (in + out tokens) ÷ eff, again relative to month 1.
function baselineIdx(base, horizon) {
  const at = (arr, i) => arr[Math.min(i, arr.length - 1)];
  const tRaw = i => { const r = at(base.train, i); return (r.modelB * r.tokensT) / Math.max(1, r.days * r.mfu); };
  const iRaw = i => { const r = at(base.inf, i); return (r.modelB * r.bytes * (r.inTok + r.outTok)) / Math.max(1, r.effPct); };
  const t0 = tRaw(0) || 1, i0 = iRaw(0) || 1;
  return {
    trainIdx: Array.from({ length: horizon }, (_, i) => tRaw(i) / t0),
    infIdx: Array.from({ length: horizon }, (_, i) => iRaw(i) / i0),
  };
}
// Implied H100e for one baseline frontier run (reference readout): GPUs =
// 6·N·D ÷ (days·86400s · 989e12 FLOP/s · MFU), in H100 units.
function baselineRunH100e(row) {
  return (6 * row.modelB * 1e9 * row.tokensT * 1e12) / Math.max(1, row.days * 86400 * 989e12 * (row.mfu / 100));
}

// ─── LLM model mix — share of inference demand by served model ───────────────
// Illustrative shares, assumed uniform across customer types. activeB = params
// streamed per decode token (MoE models activate a fraction of total). The mix
// pins the inference baseline's avg model size and tells the heterogeneous
// supply engine how much of the inference pool needs big-VRAM/bandwidth parts.
const SEED_MODEL_MIX = [
  { id: 1, name: "Llama 3.1 8B",        pct: 30, paramsB: 8,   activeB: 8 },
  { id: 2, name: "Mistral Small 24B",   pct: 15, paramsB: 24,  activeB: 24 },
  { id: 3, name: "Llama 3.3 70B",       pct: 20, paramsB: 70,  activeB: 70 },
  { id: 4, name: "Qwen 2.5 72B",        pct: 10, paramsB: 72,  activeB: 72 },
  { id: 5, name: "GPT-OSS 120B (MoE)",  pct: 10, paramsB: 117, activeB: 5.1 },
  { id: 6, name: "DeepSeek V3 (MoE)",   pct: 15, paramsB: 671, activeB: 37 },
];
const MODEL_MIX_STORE = makeBookStore(SEED_MODEL_MIX);

// A "leaf" is one segment x region group: customer roll-forward drivers per
// month, plus SCALAR month-1 workload anchors and a ±% flex that scales how
// hard this cohort rides the shared workload baselines. Effective multiplier
// in month m: 1 + (baselineIdx[m] − 1) × (1 + flex/100), floored at 0.05.
const seedLeaf = (id, region, custBase, addsPct, churnPct, infPerCust, runsPerYr, runSize, runDurMo, infFlexPct = 0, trainFlexPct = 0) => ({
  id, region, custBase,
  months: Array.from({ length: COHORT_MONTHS }, (_, i) => ({
    addsPct: i === 0 ? 0 : addsPct,
    churnPct: i === 0 ? 0 : churnPct,
  })),
  infPerCust, runsPerYr, runSize, runDurMo, infFlexPct, trainFlexPct,
});
// Segments contain region sub-groups. Flex seeds: enterprise rides frontier
// trends hardest (+30% train / +25% inf), startups track the baseline, and
// individuals lag it (smaller models, shorter contexts).
//
// Demand scenarios (weak / base / strong) diverge on TWO axes:
//   (a) starting book — segment-level custBase multipliers (entMult/suMult/
//       indMult) scale today's demand up/down (enterprise stickier, individuals
//       most volatile), so month-1 H100e demand and run-rate revenue reflect the
//       scenario — not just the trajectory.
//   (b) trajectory — per-segment adds/churn/flex determine how each cohort
//       compounds from that starting book against the frontier baselines.
// Region offsets vs. the segment anchor (e.g. APAC adds a touch faster, churns
// a touch harder) are preserved across scenarios.
const buildCohorts = (o) => [
  { id: 1, name: "Enterprise labs", regions: [
    seedLeaf(11, "US-East", Math.round(14 * o.entMult), o.entAdds, o.entChurn, 40, 4, 256, 1.5, o.entInfFlex, o.entTrainFlex),
    seedLeaf(12, "US-West", Math.round(7 * o.entMult), o.entAdds, o.entChurn, 44, 4, 288, 1.5, o.entInfFlex, o.entTrainFlex),
    seedLeaf(13, "EU", Math.round(7 * o.entMult), o.entAdds, o.entChurn, 40, 4, 256, 1.5, o.entInfFlex, o.entTrainFlex),
  ]},
  { id: 2, name: "Startup teams", regions: [
    seedLeaf(21, "US-East", Math.round(70 * o.suMult), o.suAdds, o.suChurn, 6, 6, 48, 0.75, o.suInfFlex, o.suTrainFlex),
    seedLeaf(22, "US-West", Math.round(56 * o.suMult), o.suAdds + 1, o.suChurn, 7, 6, 56, 0.75, o.suInfFlex, o.suTrainFlex),
    seedLeaf(23, "EU", Math.round(56 * o.suMult), o.suAdds, o.suChurn, 6, 6, 48, 0.75, o.suInfFlex, o.suTrainFlex),
    seedLeaf(24, "APAC", Math.round(28 * o.suMult), o.suAdds + 2, o.suChurn + 0.5, 5, 6, 48, 0.75, o.suInfFlex, o.suTrainFlex),
  ]},
  { id: 3, name: "Individuals / researchers", regions: [
    seedLeaf(31, "US-East", Math.round(800 * o.indMult), o.indAdds, o.indChurn, 0.25, 10, 4, 0.25, o.indInfFlex, o.indTrainFlex),
    seedLeaf(32, "US-West", Math.round(700 * o.indMult), o.indAdds + 1, o.indChurn, 0.28, 10, 4, 0.25, o.indInfFlex, o.indTrainFlex),
    seedLeaf(33, "EU", Math.round(800 * o.indMult), o.indAdds, o.indChurn, 0.25, 10, 4, 0.25, o.indInfFlex, o.indTrainFlex),
    seedLeaf(34, "APAC", Math.round(400 * o.indMult), o.indAdds + 2, o.indChurn + 1, 0.2, 10, 4, 0.25, o.indInfFlex, o.indTrainFlex),
  ]},
];
const DEMAND_SCENARIO_DEFS = {
  weak: {
    label: "Weak", color: "#f87171",
    params: { entMult: 0.90, suMult: 0.80, indMult: 0.70,
              entAdds: 1, entChurn: 1.5, entInfFlex: 0, entTrainFlex: -10,
              suAdds: 3, suChurn: 5, suInfFlex: -25, suTrainFlex: -35,
              indAdds: 5, indChurn: 10, indInfFlex: -70, indTrainFlex: -80 },
  },
  base: {
    label: "Base", color: "#67e8f9",
    params: { entMult: 1.00, suMult: 1.00, indMult: 1.00,
              entAdds: 3, entChurn: 0.5, entInfFlex: 25, entTrainFlex: 30,
              suAdds: 8, suChurn: 2, suInfFlex: 0, suTrainFlex: 0,
              indAdds: 12, indChurn: 6, indInfFlex: -40, indTrainFlex: -50 },
  },
  strong: {
    label: "Strong", color: "#6ee7b7",
    params: { entMult: 1.10, suMult: 1.20, indMult: 1.30,
              entAdds: 4, entChurn: 0.3, entInfFlex: 35, entTrainFlex: 40,
              suAdds: 11, suChurn: 1.5, suInfFlex: 10, suTrainFlex: 10,
              indAdds: 16, indChurn: 5, indInfFlex: -25, indTrainFlex: -35 },
  },
};
const SEED_COHORTS = buildCohorts(DEMAND_SCENARIO_DEFS.base.params);
const COHORT_STORE = makeBookStore(SEED_COHORTS);
// Which scenario is active, plus a per-scenario stash of the demand build so
// user edits inside one scenario survive toggling away and back.
const DEMAND_SCENARIO_STORE = makeBookStore("base");
const SCENARIO_COHORTS = {
  weak: buildCohorts(DEMAND_SCENARIO_DEFS.weak.params),
  base: SEED_COHORTS,
  strong: buildCohorts(DEMAND_SCENARIO_DEFS.strong.params),
};
// Prior probabilities on the three scenarios (percent, must sum to 100). Owned
// by the Compute Demand tab (edited alongside the scenario toggle), read by
// the Compute Supply tab's engine to weight the expected-value calculations.
const SCENARIO_PROB_STORE = makeBookStore({ weak: 25, base: 50, strong: 25 });

// Reserved-term discount curve — % off the vendor-catalog on-demand rate as
// a function of reservation length. Owned by the Vendor Spec & Contracts tab
// (sits under the catalog since it's a pricing assumption), read by the
// Supply Filling Engine. Three anchor points (1yr / 3yr / 5yr) that the
// engine interpolates piecewise-linearly for arbitrary term lengths.
// Non-linear because the anchors aren't equally spaced — biggest jump is 0→1yr
// (paying at all vs. any commitment), then diminishing returns.
const RESERVED_DISCOUNT_STORE = makeBookStore({ d1: 30, d3: 50, d5: 60 });
// Piecewise-linear discount fraction (0..1) at an arbitrary term length.
function discountForTerm(termMo, d) {
  const d1 = (d?.d1 ?? 30) / 100, d3 = (d?.d3 ?? 50) / 100, d5 = (d?.d5 ?? 60) / 100;
  const y = termMo / 12;
  if (y <= 0) return 0;
  if (y <= 1) return d1 * y;
  if (y <= 3) return d1 + (d3 - d1) * (y - 1) / 2;
  if (y <= 5) return d3 + (d5 - d3) * (y - 3) / 2;
  return d5;
}

// Pricing assumptions — what Prime Intellect charges customers, $/H100e-hour,
// by workload. Owned by the Compute Demand tab; feeds the Projections revenue
// math (training and inference are priced differently). The Projections
// sell-rate decline (Supply tab policy) is applied on top of these anchors.
const PRICING_STORE = makeBookStore({ trainPrice: 2.10, infPrice: 2.60, refTrainPrice: 2.10, refInfPrice: 2.60, elastTrain: 1.3, elastInf: 0.7 });

// Price→demand elasticity: constant-elasticity multiplier per workload,
// (P / P_ref)^(−ε). At P = P_ref the multiplier is exactly 1, so the demand
// build is unchanged until price moves off its reference anchor. Training is
// more elastic than inference (runs are deferrable / portable across clouds;
// serving traffic is stickier). Clamped so extreme slider combos stay sane.
function priceDemandMult(pricing) {
  if (!pricing) return { inf: 1, train: 1 };
  const m = (p, ref, e) => Math.min(4, Math.max(0.25, Math.pow(Math.max(0.01, p) / Math.max(0.01, ref), -(e || 0))));
  return { inf: m(pricing.infPrice, pricing.refInfPrice, pricing.elastInf), train: m(pricing.trainPrice, pricing.refTrainPrice, pricing.elastTrain) };
}

// Projection policy (renewals, pricing declines, next-gen step).
// Owned by the Compute Supply tab; read by the Projections engine. Sell prices
// erode gently (8%/yr) rather than collapsing, while sourcing cost falls faster
// (18%/yr) as capacity is renewed at market — so per-unit margin widens over the
// horizon. High renewal share on long terms keeps the delivered book from
// shrinking as contracts mature.
const POLICY_STORE = makeBookStore({ priceDecline: 8, costDecline: 18, genMo: 9, genAdv: 15, renewPct: 88, renewTerm: 18 });

// Inference throughput (tokens per H100e-hour). Owned by the Compute Demand
// tab alongside the customer-segment build; read by the Projections engine.
const TOKPERHR_STORE = makeBookStore(10);

// Roll one leaf (segment x region) into monthly customer / inference / training
// series. Customers roll additively (adds − churn). Workload footprints start
// from the leaf's month-1 anchors and follow the shared baseline index, scaled
// by the cohort's ±% flex: mult(m) = 1 + (idx[m] − 1) × (1 + flex/100).
// Enterprise (positive flex) rides the frontier trajectory harder; individuals
// (negative flex) lag it. idx == null → flat (multiplier 1).
function cohortLeafSeries(leaf, horizon, idx, pd) {
  const cust = [], inf = [], train = [];
  const pdInf = (pd && pd.inf) || 1, pdTrain = (pd && pd.train) || 1;
  const mult = (arr, m, flexPct) => {
    if (!arr) return 1;
    const v = arr[Math.min(m - 1, arr.length - 1)] ?? 1;
    return Math.max(0.05, 1 + (v - 1) * (1 + flexPct / 100));
  };
  let c = leaf.custBase;
  for (let m = 1; m <= horizon; m++) {
    const d = leaf.months[Math.min(m - 1, leaf.months.length - 1)];
    if (m > 1) c = Math.max(0, c * (1 + (d.addsPct - d.churnPct) / 100));
    cust.push(c);
    inf.push(c * leaf.infPerCust * mult(idx && idx.infIdx, m, leaf.infFlexPct || 0) * pdInf);
    train.push(c * (leaf.runsPerYr / 12) * leaf.runDurMo * leaf.runSize * mult(idx && idx.trainIdx, m, leaf.trainFlexPct || 0) * pdTrain);
  }
  return { cust, inf, train };
}

// Aggregate the whole cohort tree. Returns totals plus per-segment, per-region,
// and per-leaf series so Demand, Projections, and the segment P&L all read the
// exact same numbers (the reconciliation contract across tabs).
function cohortSeries(segments, horizon, idx, pricing) {
  const zero = () => Array.from({ length: horizon }, () => 0);
  const pd = priceDemandMult(pricing);
  const inf = zero(), train = zero();
  const perSeg = [], perReg = {}, perLeaf = [];
  for (const seg of segments) {
    const sInf = zero(), sTrain = zero();
    const leaves = [];
    for (const leaf of seg.regions) {
      const ls = cohortLeafSeries(leaf, horizon, idx, pd);
      leaves.push({ leaf, series: ls });
      if (!perReg[leaf.region]) perReg[leaf.region] = { inf: zero(), train: zero() };
      for (let m = 0; m < horizon; m++) {
        inf[m] += ls.inf[m]; train[m] += ls.train[m];
        sInf[m] += ls.inf[m]; sTrain[m] += ls.train[m];
        perReg[leaf.region].inf[m] += ls.inf[m]; perReg[leaf.region].train[m] += ls.train[m];
      }
    }
    perSeg.push({ id: seg.id, name: seg.name, inf: sInf, train: sTrain });
    perLeaf.push({ seg, leaves });
  }
  return { inf, train, perSeg, perReg, perLeaf, infBase: Math.round(inf[0] || 0), trainBase: Math.round(train[0] || 0) };
}
function useBookStore(store) {
  const value = useSyncExternalStore(store.subscribe, store.get, store.get);
  const setValue = useCallback((next) => store.set(next), [store]);
  return [value, setValue];
}


// ═════════════════════════════════════════════════════════════════════════════
// COMPUTE MANAGEMENT DASHBOARD v7
// (formerly Inference Cost Modeler)
// Seven complete, independent dashboards in one place:
//   BUYER-SIDE  — GPU Fleet Sizer v2: "what fleet do I need, and should I
//                 self-host or use APIs?" (KV-aware roofline, TP search,
//                 commitment & ownership economics)
//   SELLER-SIDE — Compute provider / aggregator P&L: "I hold GPU supply at a
//                 cost basis — what's my margin selling GPU-hours vs tokens?"
//   COMPUTE SUPPLY — Supply book & deal intake: "what capacity do we hold,
//                 on what terms, and should we accept this vendor's offer?"
// Each dashboard is wrapped in its own scope, byte-identical to its standalone
// version — nothing consolidated, nothing changed. Both stay mounted so slider
// state persists when switching tabs.
// ═════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════
// COMPUTE SUPPLY — supply book & deal intake for a compute aggregator
// (modeled on Prime Intellect: capacity sourced from hyperscalers, neoclouds,
// and datacenter partners, resold as on-demand / reserved clusters / spot).
// Two jobs: (1) track the existing supply book — who we buy from, on what
// terms, and when it rolls off; (2) evaluate a new vendor offer — effective
// cost after prepay financing, break-even sell-through, term risk against
// declining market rates — and log it to the book if accepted.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Vendor catalog (module-scope so both VendorSpecApp and SupplySideApp can read it) ──
// Owned display-wise by the Vendor Spec & Contracts tab, but the Supply Filling
// Engine reads it too — specifically to name the cheapest OD vendors when the
// engine recommends ON-DEMAND for a bucket. Prices are on-demand hourly rates
// as quoted by each provider (2026 snapshot; refresh quarterly).
const CATALOG = [
  // ─── H100 SXM (80 GB, HGX 8×) ───────────────────────────────────────────────
  { id: 1,  provider: "CoreWeave",       gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.46,  kwh: 0.07,  pue: 1.15, storage: "VAST / local NVMe",     storageAdd: 0.05, egress: 0,     sla: 99.9, support: "24/7 eng",  tenancy: "bare metal", leadWks: 1,  minCommit: "64",           resale: true,  notes: "HGX H100 SXM5; dedicated tenancy; IB NDR scale-out" },
  { id: 2,  provider: "Voltage Park",    gpu: "H100",    region: "US-Central",     node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 1.99,  kwh: 0.055, pue: 1.3,  storage: "Local NVMe",            storageAdd: 0.05, egress: 0,     sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 2,  minCommit: "64",           resale: true,  notes: "Bare-metal, no virtualization overhead" },
  { id: 3,  provider: "Hyperstack",      gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 1.90,  kwh: 0.07,  pue: 1.2,  storage: "Object storage",        storageAdd: 0.03, egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "US and Canada regions; on-demand 8× bare metal" },
  { id: 4,  provider: "Denvr Dataworks",  gpu: "H100",   region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.30,  kwh: 0.065, pue: 1.2,  storage: "Shared FS incl.",       storageAdd: 0,    egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 2,  minCommit: "64",           resale: true,  notes: "Sustainability focus; good PUE" },
  { id: 5,  provider: "Latitude.sh",     gpu: "H100",    region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 1.79,  kwh: 0.07,  pue: 1.25, storage: "Local NVMe",            storageAdd: 0.04, egress: 0,     sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "Global footprint; competitive 8× rate; on-demand" },
  { id: 6,  provider: "GMI Cloud",       gpu: "H100",    region: "APAC",           node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.00,  kwh: 0.08,  pue: 1.25, storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.02,  sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 3,  minCommit: "64",           resale: true,  notes: "Taiwan-sited; export-control screening applies" },
  { id: 7,  provider: "Crusoe",          gpu: "H100",    region: "US-Central",     node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.90,  kwh: 0.045, pue: 1.2,  storage: "Lustre incl.",          storageAdd: 0,    egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 4,  minCommit: "128",          resale: true,  notes: "Stranded-power / behind-the-meter; lowest kwh cost in class" },
  { id: 8,  provider: "Nebius",          gpu: "H100",    region: "EU",             node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.87,  kwh: 0.05,  pue: 1.1,  storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.01,  sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 2,  minCommit: "64",           resale: true,  notes: "EU-sited; hydro power; low PUE; spot ~$2.15/GPU-hr" },
  { id: 9,  provider: "Vultr",           gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.30,  kwh: 0.08,  pue: 1.25, storage: "Block / object",        storageAdd: 0.06, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "8× bare-metal H100; on-demand with no long-term commit" },
  { id: 10, provider: "Scaleway",        gpu: "H100",    region: "EU",             node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.62,  kwh: 0.06,  pue: 1.15, storage: "Object storage",        storageAdd: 0.04, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 2,  minCommit: "8",            resale: true,  notes: "French DC; EU data residency; hydro-heavy grid" },
  { id: 11, provider: "DigitalOcean",    gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.99,  kwh: 0.08,  pue: 1.25, storage: "Spaces (object)",       storageAdd: 0.05, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 0,  minCommit: "none",         resale: true,  notes: "On-demand H100 cluster; good developer UX; IB network" },
  { id: 12, provider: "RunPod",          gpu: "H100",    region: "Global (mixed)", node: 8,  ic: "nvlink4", outFabric: "roce",      price: 2.99,  kwh: 0.08,  pue: 1.3,  storage: "Network vol. (extra)",  storageAdd: 0.05, egress: 0,     sla: 99.0, support: "community", tenancy: "bare metal", leadWks: 0,  minCommit: "none",         resale: true,  notes: "Secure Cloud; distributed host network; spot ~$2.39" },
  { id: 13, provider: "Civo",            gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.99,  kwh: 0.07,  pue: 1.2,  storage: "Object storage",        storageAdd: 0.04, egress: 0,     sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 1,  minCommit: "none (commit tiers)", resale: true, notes: "On-demand $2.99; 6mo→$2.79, 12mo→$2.69, 24mo→$2.59, 36mo→$2.49" },
  { id: 14, provider: "Lambda Labs",     gpu: "H100",    region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.99,  kwh: 0.06,  pue: 1.25, storage: "Local NVMe",            storageAdd: 0.05, egress: 0,     sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "1-Click Cluster; IB scale-out; ML-first UX" },
  { id: 15, provider: "GCP",             gpu: "H100",    region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 4.20,  kwh: 0.085, pue: 1.1,  storage: "Filestore / GCS",       storageAdd: 0.14, egress: 0.08,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "A3 Mega (8× SXM5); 1-yr CUD ~30% off; spot ~$1.15/GPU-hr" },
  { id: 16, provider: "Azure",           gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 6.98,  kwh: 0.09,  pue: 1.18, storage: "Azure Files Premium",   storageAdd: 0.15, egress: 0.087, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "ND H100 v5; 1-yr reserved ~$5.80, 3-yr ~$4.30" },
  { id: 17, provider: "AWS",             gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "eth",       price: 6.88,  kwh: 0.09,  pue: 1.15, storage: "FSx for Lustre",        storageAdd: 0.16, egress: 0.09,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "P5 (8× H100); EFA (Ethernet-based RDMA, not IB); spot ~$0.83/GPU-hr" },
  { id: 18, provider: "OCI",             gpu: "H100",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 10.00, kwh: 0.07,  pue: 1.15, storage: "Block / object",        storageAdd: 0.10, egress: 0.085, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "BM.GPU4.8; high sticker; generous egress/storage credits in deals" },

  // ─── H200 (141 GB, HGX 8×) ──────────────────────────────────────────────────
  { id: 19, provider: "CoreWeave",       gpu: "H200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.62,  kwh: 0.07,  pue: 1.15, storage: "VAST / local NVMe",     storageAdd: 0.05, egress: 0,     sla: 99.9, support: "24/7 eng",  tenancy: "bare metal", leadWks: 2,  minCommit: "64",           resale: true,  notes: "HGX H200 SXM5; 141GB HBM3e — ~33% more memory than H100" },
  { id: 20, provider: "GMI Cloud",       gpu: "H200",    region: "APAC",           node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.60,  kwh: 0.08,  pue: 1.25, storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.02,  sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 3,  minCommit: "64",           resale: true,  notes: "Taiwan-sited H200; export-control screening applies" },
  { id: 21, provider: "Hyperstack",      gpu: "H200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.99,  kwh: 0.07,  pue: 1.2,  storage: "Object storage",        storageAdd: 0.03, egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 2,  minCommit: "8",            resale: true,  notes: "On-demand H200 8-GPU; standard HGX form factor" },
  { id: 22, provider: "Crusoe",          gpu: "H200",    region: "US-Central",     node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 4.29,  kwh: 0.045, pue: 1.2,  storage: "Lustre incl.",          storageAdd: 0,    egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 4,  minCommit: "128",          resale: true,  notes: "Behind-the-meter siting; premium H200 pricing vs H100" },
  { id: 23, provider: "Nebius",          gpu: "H200",    region: "EU",             node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 4.52,  kwh: 0.05,  pue: 1.1,  storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.01,  sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 3,  minCommit: "64",           resale: true,  notes: "EU-sited; hydro power; spot ~$2.45/GPU-hr" },
  { id: 24, provider: "DigitalOcean",    gpu: "H200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.44,  kwh: 0.08,  pue: 1.25, storage: "Spaces (object)",       storageAdd: 0.05, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 0,  minCommit: "none",         resale: true,  notes: "On-demand H200; same platform as their H100 offering" },
  { id: 25, provider: "RunPod",          gpu: "H200",    region: "Global (mixed)", node: 8,  ic: "nvlink4", outFabric: "roce",      price: 3.99,  kwh: 0.08,  pue: 1.3,  storage: "Network vol. (extra)",  storageAdd: 0.05, egress: 0,     sla: 99.0, support: "community", tenancy: "bare metal", leadWks: 0,  minCommit: "none",         resale: true,  notes: "Secure Cloud; community $3.59; spot ~$3.99" },
  { id: 26, provider: "GCP",             gpu: "H200",    region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 4.58,  kwh: 0.085, pue: 1.1,  storage: "Filestore / GCS",       storageAdd: 0.14, egress: 0.08,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "A3 Ultra (8× H200 SXM5); spot ~$4.46/GPU-hr" },
  { id: 27, provider: "AWS",             gpu: "H200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "eth",       price: 7.91,  kwh: 0.09,  pue: 1.15, storage: "FSx for Lustre",        storageAdd: 0.16, egress: 0.09,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "P5e (8× H200); EFA network; spot ~$2.23/GPU-hr" },
  { id: 28, provider: "OCI",             gpu: "H200",    region: "Middle East",    node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 10.00, kwh: 0.07,  pue: 1.2,  storage: "Block / object",        storageAdd: 0.10, egress: 0.085, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "Middle East and EU regions; high sticker; deal credits common" },

  // ─── B200 (192 GB, HGX 8× or NVL72 rack) ───────────────────────────────────
  { id: 29, provider: "CoreWeave",       gpu: "B200",    region: "US-East",        node: 72, ic: "nvlink5", outFabric: "ib_xdr",    price: 4.26,  kwh: 0.07,  pue: 1.15, storage: "VAST incl.",            storageAdd: 0,    egress: 0,     sla: 99.9, support: "24/7 eng",  tenancy: "bare metal", leadWks: 8,  minCommit: "1 rack (72)",  resale: true,  notes: "GB200 NVL72 rack-scale; liquid cooled; 1.8TB/s NVLink5 per GPU" },
  { id: 30, provider: "Nebius",          gpu: "B200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.95,  kwh: 0.05,  pue: 1.1,  storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.01,  sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 4,  minCommit: "64",           resale: true,  notes: "HGX B200 8-GPU form factor (not NVL72); on-demand" },
  { id: 31, provider: "GMI Cloud",       gpu: "B200",    region: "APAC",           node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 4.00,  kwh: 0.08,  pue: 1.25, storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.02,  sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 6,  minCommit: "64",           resale: true,  notes: "Taiwan-sited HGX B200; export-control screening applies" },
  { id: 32, provider: "Vultr",           gpu: "B200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.50,  kwh: 0.08,  pue: 1.25, storage: "Block / object",        storageAdd: 0.06, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 2,  minCommit: "8",            resale: true,  notes: "HGX B200 8-GPU bare metal; on-demand; competitive vs peers" },
  { id: 33, provider: "Hyperstack",      gpu: "B200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 6.00,  kwh: 0.07,  pue: 1.2,  storage: "Object storage",        storageAdd: 0.03, egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 4,  minCommit: "8",            resale: true,  notes: "HGX B200 8-GPU; on-demand availability" },
  { id: 34, provider: "Lambda Labs",     gpu: "B200",    region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 6.69,  kwh: 0.06,  pue: 1.25, storage: "Local NVMe",            storageAdd: 0.05, egress: 0,     sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 2,  minCommit: "8",            resale: true,  notes: "1-Click Cluster; HGX B200; EU/APAC/ME regions available" },
  { id: 35, provider: "RunPod",          gpu: "B200",    region: "Global (mixed)", node: 8,  ic: "nvlink4", outFabric: "roce",      price: 5.49,  kwh: 0.08,  pue: 1.3,  storage: "Network vol. (extra)",  storageAdd: 0.05, egress: 0,     sla: 99.0, support: "community", tenancy: "bare metal", leadWks: 0,  minCommit: "none",         resale: true,  notes: "Secure Cloud; community $5.98; on-demand $5.49" },
  { id: 36, provider: "GCP",             gpu: "B200",    region: "US-West",        node: 72, ic: "nvlink5", outFabric: "ib_xdr",    price: 8.05,  kwh: 0.085, pue: 1.1,  storage: "Filestore / GCS",       storageAdd: 0.14, egress: 0.08,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 6,  minCommit: "1yr reserve",  resale: false, notes: "A4 (GB200 NVL72) rack-scale; spot ~$4.08/GPU-hr" },
  { id: 37, provider: "AWS",             gpu: "B200",    region: "US-East",        node: 72, ic: "nvlink5", outFabric: "ib_xdr",    price: 14.24, kwh: 0.09,  pue: 1.15, storage: "FSx for Lustre",        storageAdd: 0.16, egress: 0.09,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "P6 (GB200 NVL72); highest on-demand sticker; spot ~$5.01/GPU-hr" },
  { id: 38, provider: "OCI",             gpu: "B200",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 14.00, kwh: 0.07,  pue: 1.15, storage: "Block / object",        storageAdd: 0.10, egress: 0.085, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 4,  minCommit: "none",         resale: false, notes: "HGX B200; premium on-demand list; deal credits common" },

  // ─── B300 / HGX B300 (Blackwell Ultra, 288 GB) ─────────────────────────────
  { id: 39, provider: "CoreWeave",       gpu: "B300",    region: "US-East",        node: 72, ic: "nvlink5", outFabric: "ib_xdr",    price: 4.48,  kwh: 0.07,  pue: 1.15, storage: "VAST incl.",            storageAdd: 0,    egress: 0,     sla: 99.9, support: "24/7 eng",  tenancy: "bare metal", leadWks: 16, minCommit: "1 rack (72)",  resale: true,  notes: "GB300 NVL72 rack-scale; 288GB HBM3e per GPU; long lead time" },
  { id: 40, provider: "Vultr",           gpu: "B300",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.80,  kwh: 0.08,  pue: 1.25, storage: "Block / object",        storageAdd: 0.06, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 4,  minCommit: "8",            resale: true,  notes: "HGX B300 8-GPU; unusually low on-demand price for Blackwell Ultra" },
  { id: 41, provider: "Nebius",          gpu: "B300",    region: "EU",             node: 8,  ic: "nvlink5", outFabric: "ib_xdr",    price: 4.30,  kwh: 0.05,  pue: 1.1,  storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.01,  sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 8,  minCommit: "64",           resale: true,  notes: "EU-sited B300; UK availability; spot ~$4.30" },
  { id: 42, provider: "RunPod",          gpu: "B300",    region: "Global (mixed)", node: 8,  ic: "nvlink4", outFabric: "roce",      price: 7.39,  kwh: 0.08,  pue: 1.3,  storage: "Network vol. (extra)",  storageAdd: 0.05, egress: 0,     sla: 99.0, support: "community", tenancy: "bare metal", leadWks: 0,  minCommit: "none",         resale: true,  notes: "Secure Cloud; community $6.94; on-demand $7.39" },
  { id: 43, provider: "Scaleway",        gpu: "B300",    region: "EU",             node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 9.01,  kwh: 0.06,  pue: 1.15, storage: "Object storage",        storageAdd: 0.04, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 4,  minCommit: "8",            resale: true,  notes: "EU data residency; B300 8-GPU node; high list, no egress in-region" },
  { id: 44, provider: "AWS",             gpu: "B300",    region: "US-East",        node: 72, ic: "nvlink5", outFabric: "ib_xdr",    price: 17.80, kwh: 0.09,  pue: 1.15, storage: "FSx for Lustre",        storageAdd: 0.16, egress: 0.09,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "Blackwell Ultra rack-scale; spot ~$3.72/GPU-hr (large spot discount)" },
  { id: 45, provider: "OCI",             gpu: "B300",    region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 15.00, kwh: 0.07,  pue: 1.15, storage: "Block / object",        storageAdd: 0.10, egress: 0.085, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 6,  minCommit: "none",         resale: false, notes: "HGX B300 (Blackwell Ultra); premium enterprise list price" },

  // ─── A100 SXM 80 GB (still widely used at scale) ───────────────────────────
  { id: 46, provider: "CoreWeave",       gpu: "A100_80", region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 1.21,  kwh: 0.07,  pue: 1.2,  storage: "VAST / local NVMe",     storageAdd: 0.05, egress: 0,     sla: 99.9, support: "24/7 eng",  tenancy: "bare metal", leadWks: 1,  minCommit: "64",           resale: true,  notes: "SXM4 A100; large installed base; proven reliability" },
  { id: 47, provider: "Hyperstack",      gpu: "A100_80", region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 1.35,  kwh: 0.07,  pue: 1.2,  storage: "Object storage",        storageAdd: 0.03, egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "On-demand A100 SXM; US and Canada" },
  { id: 48, provider: "Crusoe",          gpu: "A100_80", region: "US-Central",     node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 1.45,  kwh: 0.045, pue: 1.2,  storage: "Lustre incl.",          storageAdd: 0,    egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 4,  minCommit: "128",          resale: true,  notes: "Behind-the-meter power; lowest effective operating cost in class" },
  { id: 49, provider: "Denvr Dataworks",  gpu: "A100_80", region: "US-Central",    node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 0.58,  kwh: 0.065, pue: 1.2,  storage: "Shared FS incl.",       storageAdd: 0,    egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 4,  minCommit: "256 · 12mo",   resale: true,  notes: "Very aggressive rate — likely prepay or stranded-power deal" },
  { id: 50, provider: "Lambda Labs",     gpu: "A100_80", region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 2.79,  kwh: 0.06,  pue: 1.25, storage: "Local NVMe",            storageAdd: 0.05, egress: 0,     sla: 99.0, support: "business",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "On-demand A100 SXM; good for burst capacity" },
  { id: 51, provider: "GCP",             gpu: "A100_80", region: "US-West",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 1.85,  kwh: 0.085, pue: 1.1,  storage: "Filestore / GCS",       storageAdd: 0.14, egress: 0.08,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "A2 Ultra (8× A100 SXM4); spot ~$1.39/GPU-hr; 1-yr CUD" },
  { id: 52, provider: "AWS",             gpu: "A100_80", region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "eth",       price: 2.74,  kwh: 0.09,  pue: 1.15, storage: "FSx for Lustre",        storageAdd: 0.16, egress: 0.09,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "P4d (8× A100); EFA networking; spot ~$0.84/GPU-hr" },
  { id: 53, provider: "Azure",           gpu: "A100_80", region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 3.67,  kwh: 0.09,  pue: 1.18, storage: "Azure Files Premium",   storageAdd: 0.15, egress: 0.087, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "NC A100 v4; 3-yr reserved ~$2.13; spot ~$0.40" },
  { id: 54, provider: "OCI",             gpu: "A100_80", region: "US-East",        node: 8,  ic: "nvlink4", outFabric: "ib_ndr",    price: 4.00,  kwh: 0.07,  pue: 1.2,  storage: "Block / object",        storageAdd: 0.10, egress: 0.085, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "BM.GPU.A100-v2.8; premium list; deal credits common" },

  // ─── L40S (inference-scale, PCIe — no NVLink) ──────────────────────────────
  { id: 55, provider: "CoreWeave",       gpu: "L40S",    region: "US-East",        node: 8,  ic: "pcie",    outFabric: "ib_ndr",    price: 0.985, kwh: 0.07,  pue: 1.2,  storage: "VAST / local NVMe",     storageAdd: 0.05, egress: 0,     sla: 99.9, support: "24/7 eng",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "Inference-optimized; L40S has no NVLink — PCIe within node, IB across nodes" },
  { id: 56, provider: "Nebius",          gpu: "L40S",    region: "EU",             node: 8,  ic: "pcie",    outFabric: "roce",      price: 1.55,  kwh: 0.05,  pue: 1.1,  storage: "Shared FS incl.",       storageAdd: 0,    egress: 0.01,  sla: 99.5, support: "24/7 eng",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: true,  notes: "EU-sited L40S; spot ~$0.75/GPU-hr; 4-GPU max node" },
  { id: 57, provider: "Crusoe",          gpu: "L40S",    region: "US-Central",     node: 8,  ic: "pcie",    outFabric: "roce",      price: 1.45,  kwh: 0.045, pue: 1.2,  storage: "Lustre incl.",          storageAdd: 0,    egress: 0,     sla: 99.5, support: "24/7 eng",  tenancy: "bare metal", leadWks: 2,  minCommit: "64",           resale: true,  notes: "Behind-the-meter power; good economics for inference workloads" },
  { id: 58, provider: "Scaleway",        gpu: "L40S",    region: "EU",             node: 8,  ic: "pcie",    outFabric: "ib_ndr",    price: 1.70,  kwh: 0.06,  pue: 1.15, storage: "Object storage",        storageAdd: 0.04, egress: 0.01,  sla: 99.5, support: "business",  tenancy: "bare metal", leadWks: 1,  minCommit: "8",            resale: true,  notes: "EU L40S; IB scale-out for multi-node tensor-parallel inference" },
  { id: 59, provider: "AWS",             gpu: "L40S",    region: "US-East",        node: 8,  ic: "pcie",    outFabric: "eth",       price: 1.86,  kwh: 0.09,  pue: 1.15, storage: "EBS / S3",              storageAdd: 0.10, egress: 0.09,  sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "G6 (Ada Lovelace); serving-optimized; standard EBS/S3 storage" },
  { id: 60, provider: "OCI",             gpu: "L40S",    region: "US-East",        node: 4,  ic: "pcie",    outFabric: "ib_ndr",    price: 3.50,  kwh: 0.07,  pue: 1.15, storage: "Block / object",        storageAdd: 0.08, egress: 0.085, sla: 99.9, support: "24/7 ent",  tenancy: "VM",         leadWks: 0,  minCommit: "none",         resale: false, notes: "L40S 4-GPU max node; enterprise support; high list" },
];

// Cheapest N on-demand vendors for a bucket. Matches gpu strictly, and prefers
// exact matches on outFabric and region before falling back to just the GPU.
// Returns [] if no catalog entry matches the gpu. Skips hyperscalers with no
// egress-neutral OD if the caller only wants the "clean OD" tier — for now
// includes all catalog entries.
function pickODVendors(gpu, fab, region, n = 3) {
  const gpuMatches = CATALOG.filter(c => c.gpu === gpu);
  if (!gpuMatches.length) return [];
  const scored = gpuMatches.map(c => {
    let penalty = 0;
    if (fab && c.outFabric !== fab) penalty += 0.15;
    if (region && c.region !== region) penalty += 0.08;
    return { c, score: c.price + penalty };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, n).map(s => s.c);
}

const SupplySideApp = (() => {

// ─── Market reference data (Apr 2026 snapshots) ─────────────────────────────
// Market rate = achievable resale $/GPU-hr on an aggregator marketplace.
// OD source = what sourcing the same GPU on-demand upstream costs (no commit).
// tflops = FP16 dense tensor TFLOPS (same basis as GPU_SPECS on the other
// tabs); bw = HBM bandwidth TB/s. H100-equivalent weighting for blended cost,
// remaining term, and capacity supports two normalizations:
//   FLOPs — the training convention (B200 ≈ 2.3× H100, H200 = 1.0×)
//   Mem BW — inference-native: decode throughput is bandwidth-bound, which is
//            exactly why H200 commands a premium over H100 despite equal FLOPs
//            (H200 ≈ 1.43× on BW vs 1.0× on FLOPs).
// Neither is "right" for a mixed book — the toggle exists so the number matches
// the demand you're selling into.
const SUPPLY_GPUS = {
  H100:    { label: "H100 80GB",  tflops: 989, vram: 80, bw: 3.35, market: 1.85, odSource: 2.45, spotRef: 0.95 },
  H200:    { label: "H200 141GB", tflops: 989, vram: 141, bw: 4.8, market: 2.30, odSource: 3.10, spotRef: 1.20 },
  B200:    { label: "B200 192GB", tflops: 2250, vram: 192, bw: 8.0, market: 3.60, odSource: 4.90, spotRef: 2.10 },
  B300:    { label: "B300 288GB", tflops: 2900, vram: 288, bw: 8.0, market: 5.00, odSource: 6.50, spotRef: 3.00 },
  A100_80: { label: "A100 80GB",  tflops: 312, vram: 80, bw: 2.0, market: 1.10, odSource: 1.60, spotRef: 0.55 },
  L40S:    { label: "L40S 48GB",  tflops: 181, vram: 48, bw: 0.86, market: 0.75, odSource: 1.10, spotRef: 0.40 },
};
const h100eOf = (r, mode = "flops") => r.gpus * (mode === "bw"
  ? SUPPLY_GPUS[r.gpu].bw / SUPPLY_GPUS.H100.bw
  : SUPPLY_GPUS[r.gpu].tflops / SUPPLY_GPUS.H100.tflops);

// ─── Workload pool classification — mirrors the Projections engine ───────────
// Each chip's FLOPs:bandwidth ratio (vs H100) decides which demand it serves
// best. Training is compute-bound; inference decode is bandwidth-bound; chips
// in between form a balanced reservoir either workload can draw at full
// efficiency. Off-pool cross-serving costs 30% capacity (see Projections).
const POOL_OF = (gpu) => {
  const g = SUPPLY_GPUS[gpu]; if (!g) return "balanced";
  const ratio = (g.tflops / SUPPLY_GPUS.H100.tflops) / (g.bw / SUPPLY_GPUS.H100.bw);
  return ratio > 1.15 ? "compute" : ratio < 0.87 ? "inference" : "balanced";
};
const POOL_META = {
  compute:   { label: "COMPUTE",   short: "C", color: "#c4b5fd", desc: "dense-FLOP → training" },
  balanced:  { label: "BALANCED",  short: "B", color: "#94a3b8", desc: "either workload" },
  inference: { label: "INFERENCE", short: "I", color: "#67e8f9", desc: "high-BW → decode" },
};
function PoolChip({ gpu }) {
  const p = POOL_META[POOL_OF(gpu)];
  return <span title={`${p.label} pool — ${p.desc}`} style={{ border: `1px solid ${p.color}45`, color: p.color, borderRadius: 3, fontSize: 7.5, fontWeight: 700, padding: "0px 3px", marginLeft: 5, verticalAlign: "middle" }}>{p.short}</span>;
}

// ─── Open-weight model serviceability ───────────────────────────────────────
// Which supply can host which models is a hard constraint on what the capacity
// can be SOLD as. Weights must be fully resident (MoE included — every expert
// loads even though few activate per token), plus headroom for KV cache and
// activations. Pooling GPUs into one replica requires fabric: IB supports
// multi-node sharding, RoCE/NVLink a node (8), plain Ethernet effectively
// single-GPU serving (TP over PCIe/Eth is not competitively sellable).
const OPEN_MODELS = [
  { key: "l8",   label: "Llama 8B",      paramsB: 8 },
  { key: "q32",  label: "Qwen 32B",      paramsB: 33 },
  { key: "l70",  label: "Llama 70B",     paramsB: 71 },
  { key: "q72",  label: "Qwen 72B",      paramsB: 73 },
  { key: "mx22", label: "Mixtral 8×22B", paramsB: 141, moe: true },
  { key: "l405", label: "Llama 405B",    paramsB: 405 },
  { key: "ds",   label: "DeepSeek V3/R1",paramsB: 671, moe: true },
  { key: "k2",   label: "Kimi K2",       paramsB: 1026, moe: true },
];
// nvl72 = NVL72 rack-scale (NVLink5 within the rack + IB XDR across racks):
// 72 GPUs share one memory domain, so pooling for serviceability is capped at
// 72 (bigger than the IB NDR 32-GPU pool typical for HGX 8-GPU nodes).
const POOL_CAP = { nvl72: 72, ib32: 32, ib16: 32, roce: 8, eth: 1 };
// For serviceability, fabric matters only via its pooling class — IB 1.6T vs
// 3.2T changes throughput, not whether a model fits. NVL72 is its own class.
const FAB_CLASS = ic => (ic === "ib32" || ic === "ib16") ? "ib32" : ic;
const FAB_LABEL = { nvl72: "NVL72 rack (NVLink5 + IB)", ib32: "InfiniBand", roce: "RoCE/NVLink", eth: "Ethernet (single-GPU)" };
const SERVE_HEADROOM = 1.2;   // weights × 1.2 for KV cache + activations
const VRAM_USABLE = 0.85;     // fraction of VRAM available after runtime overhead
// Smallest power-of-2 GPU pool (≤ fabric cap and ≤ GPUs held) that fits the
// model at a given weight precision; null if it never fits.
function minPoolFor(paramsB, bytesPerParam, vram, cap, gpusAvail) {
  const needGB = paramsB * bytesPerParam * SERVE_HEADROOM;
  for (let n = 1; n <= Math.min(cap, Math.max(gpusAvail, 1)); n *= 2) {
    if (n * vram * VRAM_USABLE >= needGB) return n;
  }
  return null;
}
function hostability(gpuKey, ic, gpusAvail, models) {
  const g = SUPPLY_GPUS[gpuKey];
  const cap = POOL_CAP[ic] || 1;
  return (models || OPEN_MODELS).map(m => ({
    key: m.key,
    fp16: minPoolFor(m.paramsB, 2, g.vram, cap, gpusAvail),
    fp8:  minPoolFor(m.paramsB, 1, g.vram, cap, gpusAvail),
  }));
}
const PROVIDERS = ["CoreWeave", "Crusoe", "Nebius", "Lambda Labs", "AWS", "GCP", "Azure", "OCI", "Voltage Park", "Hyperstack", "Denvr Dataworks", "Vultr", "DigitalOcean", "Scaleway", "RunPod", "GMI Cloud", "Latitude.sh", "Civo", "DC partner", "Community/spot"];
// SemiAnalysis ClusterMAX™ GPU-cloud ratings (Nov 2025 snapshot) — an
// independent operational-quality ranking. Relevant to intake because prepaid
// capital and SLA exposure concentrate counterparty/ops risk: Platinum/Gold
// operators have proven large-cluster operations; Bronze/unrated demand
// stronger payment protections. (Prime Intellect itself rates Bronze as a
// provider — here we use ratings on the operators we BUY from.)
const CLUSTERMAX = { "CoreWeave": "platinum", "Crusoe": "gold", "Nebius": "gold", "Azure": "gold", "Lambda Labs": "silver", "Lambda": "silver", "AWS": "silver", "GCP": "silver", "OCI": "silver", "Voltage Park": "silver", "Denvr Dataworks": "silver", "Hyperstack": "bronze", "Scaleway": "bronze", "DigitalOcean": "bronze", "Vultr": "bronze", "GMI Cloud": "bronze", "Latitude.sh": "bronze", "Civo": "bronze", "RunPod": "bronze" };
const CMAX_META = {
  platinum: { label: "PLATINUM", color: "#e2e8f0" },
  gold:     { label: "GOLD",     color: "#fbbf24" },
  silver:   { label: "SILVER",   color: "#94a3b8" },
  bronze:   { label: "BRONZE",   color: "#d97706" },
};
const cmaxOf = p => CLUSTERMAX[p] || null;
function CmaxBadge({ provider, dot }) {
  const r = cmaxOf(provider);
  const m = r ? CMAX_META[r] : { label: "UNRATED", color: "rgba(255,255,255,0.25)" };
  if (dot) return <span title={`ClusterMAX: ${m.label}`} style={{ color: m.color, marginRight: 4 }}>●</span>;
  return <span title="SemiAnalysis ClusterMAX rating, Nov 2025" style={{ border: `1px solid ${m.color}50`, color: m.color, borderRadius: 3, fontSize: 7.5, letterSpacing: "0.05em", padding: "1px 4px", marginLeft: 5, verticalAlign: "middle" }}>{m.label}</span>;
}
const STRUCTURES = [
  { value: "reserved", label: "Contracted / reserved" },
  { value: "ondemand", label: "On-demand (pay per use)" },
  { value: "spot",     label: "Spot / interruptible" },
];
const PAY_TERMS = [
  { value: "net30",   label: "Net 30 (monthly arrears)" },
  { value: "prepay_m", label: "Monthly prepay" },
  { value: "prepay_q", label: "Quarterly prepay" },
  { value: "upfront",  label: "Upfront on signing" },
];
const REGIONS = ["US-East", "US-Central", "US-West", "EU", "Nordics", "Middle East", "APAC", "Global (mixed)"];
const REGION_COLORS = { "US-East": "#67e8f9", "US-Central": "#fbbf24", "US-West": "#6ee7b7", "EU": "#c4b5fd", "Nordics": "#f472b6", "Middle East": "#fb923c", "APAC": "#a3e635", "Global (mixed)": "#94a3b8" };
const INTERCONNECTS = [
  { value: "nvl72", label: "NVL72 rack (NVLink5 + IB XDR)" },
  { value: "ib32",  label: "InfiniBand NDR (400G)" },
  { value: "ib16",  label: "InfiniBand XDR (800G)" },
  { value: "roce",  label: "RoCE / NVLink4 (8-GPU node)" },
  { value: "eth",   label: "Std Ethernet (single-node)" },
];
const icLabel = v => (INTERCONNECTS.find(i => i.value === v) || {}).label || v;
const HRS_MO = 730;

// Seed book — illustrative positions for an aggregator sourcing across tiers
// ─── Formatters & UI primitives (supply accent: amber) ──────────────────────
const F = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const AMB = "#fbbf24";
const fmtUSD = (n, d) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a < 1 && n !== 0) return "$" + n.toFixed(d ?? 3); return "$" + n.toLocaleString(undefined, { maximumFractionDigits: d ?? 0 }); };
const fmtBig = (n) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(1) + "B"; if (a >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (a >= 1e3) return (n / 1e3).toFixed(1) + "K"; return n.toFixed(0); };
const fmtPct = (n, d = 0) => (n * 100).toFixed(d) + "%";

function Metric({ label, value, sub, accent, warn }) {
  return (
    <div style={{ background: warn ? "rgba(248,113,113,0.1)" : "rgba(255,255,255,0.06)", border: `1px solid ${warn ? "rgba(248,113,113,0.28)" : "rgba(255,255,255,0.11)"}`, borderRadius: 8, padding: "10px 12px", flex: "1 1 150px", minWidth: 150 }}>
      <div style={{ fontSize: 10, color: warn ? "rgba(248,113,113,0.7)" : "rgba(255,255,255,0.35)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 2, fontFamily: F }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: accent || "#e2e8f0", fontFamily: F, letterSpacing: "-0.02em", lineHeight: 1.15, wordBreak: "break-word" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2, fontFamily: F }}>{sub}</div>}
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>{children}</div>;
}
function Slider({ label, value, onChange, min, max, step = 1, fmtFn, hint }) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: AMB, height: 3 }} />
        <span style={{ fontSize: 13, color: AMB, fontFamily: F, fontWeight: 600, minWidth: 62, textAlign: "right" }}>{fmtFn ? fmtFn(value) : value}</span>
      </div>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}
function Select({ label, value, onChange, options, hint }) {
  return (
    <Field label={label}>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", padding: "7px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, color: "#e2e8f0", fontSize: 12, fontFamily: F, outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value} style={{ background: "#0b1118" }}>{o.label}</option>)}
      </select>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}
function Section({ title, children, style: s, right }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.1)", ...s }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: F, fontWeight: 600 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
function SectionHeader({ title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 12px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#e2e8f0", fontFamily: F, textTransform: "uppercase" }}>{title}</div>
      <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
    </div>
  );
}
const td = (extra = {}) => ({ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", ...extra });
const th = (align = "right") => ({ padding: "5px 8px", textAlign: align, color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 });
const structColor = s => s === "reserved" ? AMB : s === "ondemand" ? "#67e8f9" : "#c4b5fd";
const structTag = s => s === "reserved" ? "RSV" : s === "ondemand" ? "OD" : "SPOT";

// ─── Deal math ──────────────────────────────────────────────────────────────
// Effective cost of a committed deal: contract rate + carrying cost of any
// prepaid capital (average outstanding balance × cost of capital), spread
// over contracted GPU-hours. Prepay schedules shorten the float you give up.
function dealEconomics({ gpu, gpus, rate, termMo, upfrontPct, pay, wacc, mktDeclinePct, resalePremiumPct, expectedUtil, rampMo = 0 }) {
  const g = SUPPLY_GPUS[gpu];
  // Ramped GPU-hours: capacity (and cost, and sellable hours) come online
  // linearly over rampMo. liveMonths = Σ min(1, m/ramp) over the term.
  let liveMonths = 0;
  for (let m = 1; m <= termMo; m++) liveMonths += (rampMo > 0 ? Math.min(1, m / rampMo) : 1);
  const termHrs = liveMonths * HRS_MO;
  const contractValue = gpus * rate * termHrs;
  const upfront$ = (upfrontPct / 100) * contractValue;
  // Average outstanding prepaid balance: upfront on signing amortizes straight-line
  // over the term (avg = ½ × upfront × term). Quarterly/monthly prepay adds a small
  // float cost on the recurring portion (avg ≈ half the prepay period).
  const recurring$ = contractValue - upfront$;
  const prepayPeriodMo = pay === "prepay_q" ? 3 : pay === "prepay_m" ? 1 : 0;
  const avgBalance = upfront$ * (termMo / 12) / 2 + (prepayPeriodMo > 0 ? recurring$ * (prepayPeriodMo / 12) / 2 : 0);
  const financing$ = avgBalance * (wacc / 100); // $ of carry over the whole term (annualized balance × rate)
  const effRate = termHrs > 0 ? rate + financing$ / (gpus * termHrs) : rate;

  // Market resale trajectory: today's marketplace rate declining at d%/yr,
  // with an optional premium/discount for how you actually price vs. market.
  const d = mktDeclinePct / 100;
  const sellNow = g.market * (1 + resalePremiumPct / 100);
  // avgSell is DELIVERY-WEIGHTED: under a ramp, early (higher-price) months have
  // few sellable hours, so an unweighted mean overstates achievable revenue.
  let sumMkt = 0, wSum = 0, underwaterMo = null;
  const months = Math.max(termMo, 1);
  const traj = [];
  for (let m = 0; m < months; m++) {
    const mk = sellNow * Math.pow(1 - d, (m + 0.5) / 12);
    const w = rampMo > 0 ? Math.min(1, (m + 1) / rampMo) : 1;
    sumMkt += mk * w; wSum += w;
    traj.push(mk);
    if (underwaterMo === null && mk < effRate) underwaterMo = m + 1;
  }
  const avgSell = wSum > 0 ? sumMkt / wSum : sellNow;

  // Break-even sell-through: utilization at which resale revenue covers the commit
  const breakevenUtil = avgSell > 0 ? effRate / avgSell : Infinity;
  const u = expectedUtil / 100;
  const marginHr = u * avgSell - effRate;                    // per committed GPU-hr
  const termProfit = marginHr * gpus * termHrs;
  const monthlyCommit = gpus * rate * HRS_MO; // at full delivery

  // Alternative: don't commit — source upstream on-demand only when demand shows up.
  // Committed beats on-demand sourcing above u* = effRate / odSource.
  const odSource = g.odSource;
  const odMarginHr = u * (avgSell - odSource);
  const crossoverUtil = odSource > 0 ? effRate / odSource : Infinity;
  const vsOd = (marginHr - odMarginHr) * gpus * termHrs;

  return { effRate, financingPerHr: termHrs > 0 ? financing$ / (gpus * termHrs) : 0, upfront$, contractValue, avgSell, sellNow, underwaterMo, breakevenUtil, marginHr, termProfit, monthlyCommit, odSource, crossoverUtil, vsOd, traj };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLY-FILLING ENGINE — scenario-driven newsvendor commit optimizer.
//
// Every quantity is per scenario; expected values weight by P(s); downside
// checks read the WEAK column alone. Scenarios are CORRELATED states of the
// world (one coherent "weak future" — soft demand across all cohorts, baked
// into DEMAND_SCENARIO_DEFS at module scope), so the weak-case downside is
// a real tail, NOT the intersection of independent per-cohort worst cases.
//
// Eleven stages:
//   1  demand aggregated per scenario × (gpu, fabric, region, month)
//   2  current supply state (scenario-invariant — signed is signed)
//   3  capability cascade THEN gap analysis (idle higher-cap supply absorbs
//      lower-cap unmet demand before any gap is declared, so we don't
//      recommend H100 buys while idle H200 exists)
//   4  substitution priced at the WORKLOAD's value, not the chip's (serving
//      H100-class demand on B200 books H100 revenue, not 2.3× — carry both
//      the FLOPs norm for capacity and the workload norm for margin)
//   5  newsvendor critical fractile → commit level per bucket. saveIfUsed
//      = OD − reserved; lossIfIdle = reserved − salvage; fractile = loss /
//      (save + loss); commit through the highest D where P(demand ≥ D) ≥
//      fractile. Replaces the old "base = min of one curve" tranche logic.
//   6  candidate deals sized to commitLevel, ranked by EV per $ prepaid,
//      HARD-gated on weak-case downside (solvency ≠ merely lower EV)
//   7  overbooking: inference to ~P90 of aggregate (customer peaks don't
//      coincide); training to concurrent peak (a run wants all GPUs for weeks)
//   8  time-phased schedule: sign floor now, ladder increments on actuals-
//      to-date triggers (trigger points ARE where you learn which scenario
//      you're in)
//   9  renewal / lapse / decline decisions at each expiry, anchored to WEAK
//      demand at expiry — decline is a peer option, not a fallback (an
//      optimizer forced to fill every gap overpays in tight markets)
//   10 guardrails: concentration ≤ 40%/vendor, Bronze ≤ 10% of prepay,
//      weak-case profitability floor, capital cap, velocity ceiling
//   11 scenario P&L (revenue − cost − carry − overflow) + regret table for
//      ONE recommended book — you can only sign one, not three separate
//      optimal books. Regret = EV given up vs. perfect-foresight per scenario.
// ═══════════════════════════════════════════════════════════════════════════
const ENGINE_HORIZON = 24;
const GPU_CAP_ORDER = ["B300", "B200", "H200", "H100", "A100_80", "L40S"];
const capRank = g => { const i = GPU_CAP_ORDER.indexOf(g); return i < 0 ? 99 : i; };
const FAB_RANK = { nvl72: 4, ib32: 3, ib16: 3, roce: 2, eth: 1 };
const REGION_CONT = { "US-East": "NA", "US-Central": "NA", "US-West": "NA", "EU": "EU", "Nordics": "EU", "Middle East": "ME", "APAC": "AP", "Global (mixed)": "GL" };
// Region substitution matrix (Stage 4): training tolerates continent-level
// substitution at small haircuts; inference eats penalty for cross-region
// (egress + tail latency); EU↔NA inference forbidden (residency proxy).
function regionSub(from, to, kind) {
  if (from === to) return { factor: 1, allowed: true };
  const cf = REGION_CONT[from] || "GL", ct = REGION_CONT[to] || "GL";
  if (cf === "GL" || ct === "GL") return { factor: 0.90, allowed: true };
  const same = cf === ct;
  if (kind === "training") return { factor: same ? 0.98 : 0.85, allowed: true };
  if (!same && (cf === "EU" || ct === "EU")) return { factor: 0, allowed: false };
  return { factor: same ? 0.94 : 0.78, allowed: true };
}

// Route inference demand across (gpu, fabric) via cheapest capable option
// per model in the mix. Route training demand across capability tiers
// matching typical run sizes (mid = H100, large = B200, frontier = B300 rack).
function inferenceRouting(modelMix) {
  const chipPref = [
    { gpu: "L40S", fab: "roce" }, { gpu: "A100_80", fab: "roce" },
    { gpu: "H100", fab: "ib32" }, { gpu: "H200", fab: "ib32" },
    { gpu: "B200", fab: "ib32" }, { gpu: "B300", fab: "nvl72" },
  ];
  const totPct = modelMix.reduce((s, m) => s + m.pct, 0) || 100;
  const routes = {};
  for (const m of modelMix) {
    let chosen = null;
    for (const c of chipPref) {
      const cap = POOL_CAP[c.fab] || 1;
      if (minPoolFor(m.paramsB, 1, SUPPLY_GPUS[c.gpu].vram, cap, cap) != null) { chosen = c; break; }
    }
    if (!chosen) chosen = { gpu: "B300", fab: "nvl72" };
    const k = chosen.gpu + "|" + chosen.fab;
    routes[k] = (routes[k] || 0) + m.pct / totPct;
  }
  return routes;
}
const TRAINING_ROUTES = { "H100|ib32": 0.30, "B200|ib32": 0.45, "B300|nvl72": 0.25 };

// STAGE 1: demand aggregated per scenario × (gpu, fabric, region, month).
// Overlays explicit demand book positions (committed is scenario-invariant —
// signed is signed) on top of scenario-varying cohort demand routed to
// buckets via model mix (inference) and training tier defaults.
const EMPTY_BUCKET = h => ({ committed: Array(h).fill(0), pipeline: Array(h).fill(0), total: Array(h).fill(0), infTot: Array(h).fill(0), trainTot: Array(h).fill(0) });
function buildScenarioDemand(cohortsByScenario, baseline, pricing, modelMix, demandBook, horizon) {
  const idx = baselineIdx(baseline, horizon);
  const infRoutes = inferenceRouting(modelMix);
  const out = {};
  for (const s of Object.keys(cohortsByScenario)) {
    const buckets = {};
    const ensure = (gpu, fab, region) => {
      const k = gpu + "|" + fab + "|" + region;
      if (!buckets[k]) buckets[k] = { gpu, fab, region, ...EMPTY_BUCKET(horizon) };
      return buckets[k];
    };
    const cs = cohortSeries(cohortsByScenario[s], horizon, idx, pricing);
    for (const region of Object.keys(cs.perReg)) {
      const rr = cs.perReg[region];
      for (const [k, share] of Object.entries(infRoutes)) {
        const [gpu, fab] = k.split("|");
        const b = ensure(gpu, fab, region);
        for (let m = 0; m < horizon; m++) { const v = rr.inf[m] * share; b.pipeline[m] += v; b.total[m] += v; b.infTot[m] += v; }
      }
      for (const [k, share] of Object.entries(TRAINING_ROUTES)) {
        const [gpu, fab] = k.split("|");
        const b = ensure(gpu, fab, region);
        for (let m = 0; m < horizon; m++) { const v = rr.train[m] * share; b.pipeline[m] += v; b.total[m] += v; b.trainTot[m] += v; }
      }
    }
    for (const d of demandBook || []) {
      const b = ensure(d.gpu, d.fabric, d.region);
      const h100e = h100eOf({ gpu: d.gpu, gpus: d.gpus }, "flops");
      for (let m = 0; m < horizon; m++) {
        if (m < d.startMo || m >= d.startMo + d.durationMo) continue;
        if (d.status === "committed") { b.committed[m] += h100e; b.total[m] += h100e; }
        else { b.pipeline[m] += h100e; b.total[m] += h100e; }
        if (d.kind === "inference") b.infTot[m] += h100e; else b.trainTot[m] += h100e;
      }
    }
    out[s] = buckets;
  }
  return out;
}

// STAGE 2: supply state per (gpu, fabric, region). Scenario-invariant — the
// book is signed; scenarios only change how much of it gets USED.
function buildSupplyState(book, horizon) {
  const buckets = {};
  const ensure = (gpu, fab, region) => {
    const k = gpu + "|" + fab + "|" + region;
    if (!buckets[k]) buckets[k] = { gpu, fab, region, available: Array(horizon).fill(0), wSum: 0, rateSum: 0, termSum: 0, prepaidSum: 0, deals: [] };
    return buckets[k];
  };
  for (const r of book.filter(x => x.status === "active")) {
    const g = SUPPLY_GPUS[r.gpu]; if (!g) continue;
    const b = ensure(r.gpu, r.ic, r.region);
    const flopsFactor = g.tflops / SUPPLY_GPUS.H100.tflops;
    for (let m = 0; m < horizon; m++) {
      const active = r.structure === "reserved" ? (m < r.remMo ? 1 : 0) : 1;
      b.available[m] += r.gpus * liveFracOf(r, m + 1) * active * flopsFactor;
    }
    if (r.structure === "reserved") {
      const h100e = h100eOf(r, "flops");
      b.wSum += h100e; b.rateSum += h100e * r.rate; b.termSum += h100e * r.remMo;
      b.prepaidSum += (r.upfrontPct / 100) * r.gpus * r.rate * HRS_MO * (r.termMo || 0);
    }
    b.deals.push(r);
  }
  for (const k of Object.keys(buckets)) {
    const b = buckets[k];
    b.blendedReservedRate = b.wSum > 0 ? b.rateSum / b.wSum : (SUPPLY_GPUS[b.gpu]?.market || 1) * 0.75;
    b.blendedRemTerm = b.wSum > 0 ? b.termSum / b.wSum : 0;
  }
  return buckets;
}

// STAGE 3: capability cascade THEN gap analysis. Iterate months; at each
// month order buckets by capability descending, let idle supply flow down
// to unmet demand it can legally serve (chip cap ≥ workload, fabric class ≥
// requirement, region substitution allowed). Substitution penalty from
// Stage 4 charges MARGIN, not capacity. Gap = what remains AFTER the cascade.
function cascadeFill(supplyBuckets, demandBuckets, horizon) {
  const keys = new Set([...Object.keys(supplyBuckets), ...Object.keys(demandBuckets)]);
  const state = {};
  for (const k of keys) {
    const [gpu, fab, region] = k.split("|");
    const sup = supplyBuckets[k], dem = demandBuckets[k];
    state[k] = { gpu, fab, region, supBucket: sup, demBucket: dem, served: Array(horizon).fill(0), idle: Array(horizon).fill(0), gap: Array(horizon).fill(0), crossFilled: Array(horizon).fill(0), crossServed: Array(horizon).fill(0) };
    for (let m = 0; m < horizon; m++) {
      const s = sup ? sup.available[m] : 0, d = dem ? dem.total[m] : 0;
      const first = Math.min(s, d);
      state[k].served[m] = first; state[k].idle[m] = Math.max(0, s - first); state[k].gap[m] = Math.max(0, d - first);
    }
  }
  const sorted = Object.values(state).sort((a, b) => (capRank(a.gpu) - capRank(b.gpu)) || ((FAB_RANK[b.fab] || 0) - (FAB_RANK[a.fab] || 0)));
  for (let m = 0; m < horizon; m++) {
    for (const sup of sorted) {
      if (sup.idle[m] <= 0.01) continue;
      for (const dem of sorted) {
        if (dem === sup || dem.gap[m] <= 0.01) continue;
        if (capRank(sup.gpu) > capRank(dem.gpu)) continue;
        if ((FAB_RANK[sup.fab] || 0) < (FAB_RANK[dem.fab] || 0)) continue;
        const kind = (dem.demBucket && dem.demBucket.trainTot[m] > dem.demBucket.infTot[m]) ? "training" : "inference";
        const rs = regionSub(sup.region, dem.region, kind);
        if (!rs.allowed) continue;
        const use = Math.min(sup.idle[m], dem.gap[m]);
        sup.idle[m] -= use; sup.crossServed[m] += use;
        dem.gap[m] -= use; dem.crossFilled[m] += use; dem.served[m] += use;
        if (sup.idle[m] <= 0.01) break;
      }
    }
  }
  return state;
}

// STAGE 5: newsvendor commit level per bucket. commitLevel = highest D such
// that P(demand ≥ D) ≥ fractile. Replaces "base = min of one curve" tranche
// logic — with liquid resale and healthy OD premium the fractile is low
// (~0.35), so commitLevel lands at/above base. Poor salvage (obsolescence-
// prone chips, training-only supply) pulls it toward weak.
function computeCommitLevels(supplyBuckets, demandByScenario, probs, salvageMult, refWindow, reservedDiscount) {
  const [r0, r1] = refWindow;
  const bucketKeys = new Set();
  for (const s of Object.keys(demandByScenario)) for (const k of Object.keys(demandByScenario[s])) bucketKeys.add(k);
  for (const k of Object.keys(supplyBuckets)) bucketKeys.add(k);
  const out = {};
  const TERM_CHOICES = [12, 36, 60];
  for (const k of bucketKeys) {
    const [gpu, fab, region] = k.split("|");
    const g = SUPPLY_GPUS[gpu]; if (!g) continue;
    const sup = supplyBuckets[k];
    const odRate = g.odSource;
    const salvage = (salvageMult[gpu] ?? 0.65) * g.spotRef;
    const scen = Object.keys(demandByScenario);
    const scenLevels = scen.map(s => {
      const d = demandByScenario[s]?.[k]; if (!d) return 0;
      let sum = 0; for (let m = r0; m < r1; m++) sum += d.total[m];
      return sum / Math.max(1, r1 - r0);
    });
    const pairs = scen.map((s, i) => ({ s, D: scenLevels[i], P: probs[s] || 0 })).sort((a, b) => b.D - a.D);
    const scenObj = Object.fromEntries(scen.map((s, i) => [s, scenLevels[i]]));
    const weakD = scenObj.weak ?? 0, baseD = scenObj.base ?? 0, strongD = scenObj.strong ?? 0;

    // Per-term newsvendor. Each term has its own reserved rate (from the
    // discount curve), which shifts save-if-used and loss-if-idle and
    // therefore the fractile ratio + implied commit level. Strict snap-down:
    // commit at the largest scenario D such that P(D ≥ D) ≥ fractile. No
    // interpolation between scenarios — the 3-scenario model can't distinguish
    // fractiles that fall in the same probability bin, so multiple terms will
    // often produce the same commit. That's honest to the discretization; term
    // differentiation for the actual buy decision lives in the recommendations
    // table's excess-EV-per-prepaid-$ sweep, not in tranche sizing.
    const commitAtFractile = (fractile) => {
      let cum = 0;
      for (const p of pairs) {
        cum += p.P;
        if (cum >= fractile) return p.D;
      }
      return pairs.length ? pairs[pairs.length - 1].D : 0;
    };
    const perTerm = {};
    for (const T of TERM_CHOICES) {
      const rateT = odRate * (1 - discountForTerm(T, reservedDiscount));
      const saveT = Math.max(0, odRate - rateT);
      const lossT = Math.max(0, rateT - salvage);
      const denomT = saveT + lossT;
      const fractileT = denomT > 0 ? lossT / denomT : 0.5;
      const commitLevelT = commitAtFractile(fractileT);
      const committedTrancheT = Math.min(commitLevelT, weakD);
      const ladderTrancheT = Math.max(0, commitLevelT - committedTrancheT);
      const flexTrancheT = Math.max(0, strongD - commitLevelT);
      perTerm[T] = { termMo: T, reservedRate: rateT, save: saveT, loss: lossT, fractile: fractileT, commitLevel: commitLevelT, committedTranche: committedTrancheT, ladderTranche: ladderTrancheT, flexTranche: flexTrancheT };
    }
    // Blended anchor kept for backward-compat and legacy display references.
    // Uses the old blendedReservedRate from the supply book if present, else
    // 75% of market — the pre-discount-curve default. NOT used by the engine
    // anymore (engine reads perTerm[T] directly).
    const reservedRate = sup?.blendedReservedRate ?? g.market * 0.75;
    const save = Math.max(0, odRate - reservedRate);
    const loss = Math.max(0, reservedRate - salvage);
    const fractile = (save + loss) > 0 ? loss / (save + loss) : 0.5;
    const commitLevel = commitAtFractile(fractile);
    const committedTranche = Math.min(commitLevel, weakD);
    const ladderTranche = Math.max(0, commitLevel - committedTranche);
    const flexTranche = Math.max(0, strongD - commitLevel);

    out[k] = { gpu, fab, region, fractile, commitLevel, committedTranche, ladderTranche, flexTranche, reservedRate, odRate, salvage, weakD, baseD, strongD, perTerm };
  }
  return out;
}

// STAGES 6 + 10: generate candidate deals for buckets where commitLevel
// exceeds current supply. Score with full scenario distribution. Rank by EV
// per $ prepaid, HARD-gate on weak-case downside (solvency ≠ lower EV) and
// on Stage 10 guardrails. Can output "decline" — engine is not forced to
// fill every gap (Stage 9's decline logic peer-ranked here).
function generateCandidates(commitLevels, cascade, supplyBuckets, demandByScenario, probs, params, refWindow = [6, 18]) {
  const cands = [];
  // Per-scenario workload aggregates for a bucket, averaged over the SAME
  // reference window used by commitLevels — otherwise safeSize (= weakD at
  // ref window) and marginalDem (= term average) diverge and the ladder
  // gets a phantom-negative marginal demand.
  const [r0, r1] = refWindow;
  const bucketAvg = dem => {
    if (!dem) return { avgDem: 0, infShare: 0.5 };
    let sumTot = 0, sumInf = 0;
    for (let m = r0; m < r1; m++) { sumTot += dem.total[m] || 0; sumInf += dem.infTot[m] || 0; }
    const n = Math.max(1, r1 - r0);
    return { avgDem: sumTot / n, infShare: sumTot > 0 ? sumInf / sumTot : 0.5 };
  };
  for (const key of Object.keys(commitLevels)) {
    const cl = commitLevels[key];
    const [gpu, fab, region] = key.split("|");
    const g = SUPPLY_GPUS[gpu]; if (!g) continue;
    const sup = supplyBuckets[key];
    const curSup = sup ? sup.available.slice(6, 18).reduce((s, v) => s + v, 0) / 12 : 0;
    // Two candidates per bucket per Stage 5 tranche decomposition:
    //   SAFE (sign_now): sized to weakD − curSup — the "committed tranche",
    //     robust across all scenarios (util_weak = 1 by construction, so the
    //     "positive margin at WEAK-case util" gate passes trivially at any
    //     rate cleaner than break-even).
    //   LADDER (sign_at_trigger): sized to commitLevel − max(weakD, curSup) —
    //     the extra capacity the newsvendor fractile wants us to commit to,
    //     signed only when actuals-to-date confirm ≥ base trajectory.
    // Above commitLevel is the FLEX tranche — never committed, OD/spot only.
    // Safe tranche is TERM-INVARIANT: weakD is a fact about demand, not about
    // the reserved rate — the "always full" floor doesn't change when the term
    // does. Ladder tranche is TERM-DEPENDENT: each term has its own fractile
    // (bigger discount → smaller loss-if-idle → lower fractile → commit more
    // aggressively → bigger ladder), so ladderSize varies per T.
    const safeSize = Math.max(0, cl.weakD - curSup);
    const ladderSizeAt = (T) => {
      const perT = cl.perTerm?.[T];
      const commitT = perT ? perT.commitLevel : cl.commitLevel;
      return Math.max(0, commitT - Math.max(cl.weakD, curSup));
    };
    // Build the eligible vendor cohort for a given tranche term. cmax gates
    // are the same as before: 24mo+ terms require platinum/gold operators
    // (bronze can't hold a 2-year commitment); shorter terms drop bronze but
    // allow anyone else. Each vendor gets its own priced offer — platinum
    // charges a 6% premium on rate and demands 20% upfront, gold +3% / 15%,
    // silver flat / 10%.
    // Term-aware pricing: vendor rate = on-demand catalog rate × (1 - term
    // discount) × operator tier multiplier. The discount curve is set on the
    // Vendor Spec tab (three anchors: 1yr / 3yr / 5yr) and interpolated
    // piecewise-linearly for arbitrary term lengths — see discountForTerm.
    // Longer terms and less-tier-premium vendors both cut the hourly rate.
    const eligibleVendors = (termMo) => {
      const list = PROVIDERS.filter(p => {
        const c = cmaxOf(p);
        if (termMo >= 24) return c === "platinum" || c === "gold";
        return c && c !== "bronze";
      });
      if (!list.length) list.push("CoreWeave");
      const odRate = g.odSource;
      const termDisc = discountForTerm(termMo, params.reservedDiscount);
      const reservedRate = odRate * (1 - termDisc);
      return list.map(p => ({
        name: p,
        rate: reservedRate * (cmaxOf(p) === "platinum" ? 1.06 : cmaxOf(p) === "gold" ? 1.03 : 1.0),
        cmax: cmaxOf(p),
        prepay: cmaxOf(p) === "platinum" ? 20 : cmaxOf(p) === "gold" ? 15 : 10,
        odRate, termDisc,
      }));
    };
    const buildCandidateFor = (sizeH100e, kind, vendor, allVendors, termMo) => {
      if (sizeH100e <= 1) return null;
      const gpusNeeded = Math.max(64, Math.round(sizeH100e * SUPPLY_GPUS.H100.tflops / g.tflops / 8) * 8);
      const rampMo = 3;
      // Contract mechanics (effRate incl. prepay carry, upfront$). Util=100
      // because scenario revenue is computed ourselves at CUSTOMER prices —
      // dealEconomics values revenue at g.market (resale), which understates
      // the customer sell rate (params.infPrice / trainPrice, Stage 4).
      const contract = dealEconomics({
        gpu, gpus: gpusNeeded, rate: vendor.rate, termMo, upfrontPct: vendor.prepay,
        pay: "prepay_q", wacc: params.wacc, mktDeclinePct: params.mktDecline,
        resalePremiumPct: 0, expectedUtil: 100, rampMo,
      });
      let termHrs = 0;
      for (let m = 1; m <= termMo; m++) termHrs += (rampMo > 0 ? Math.min(1, m / rampMo) : 1) * HRS_MO;
      // H100-equivalence per physical GPU BLENDED by workload: training is
      // FLOPs-bound, inference decode is bandwidth-bound (H200's whole premium
      // over H100). Using FLOPs alone for a chip like L40S under-values it as
      // an inference server — L40S is 25% H100 in bandwidth but only 18% in
      // FLOPs; H200 is 100% in FLOPs but 143% in bandwidth.
      const flopsRatio = g.tflops / SUPPLY_GPUS.H100.tflops;
      const bwRatio = g.bw / SUPPLY_GPUS.H100.bw;
      const perScenario = {};
      for (const s of Object.keys(demandByScenario)) {
        const dem = demandByScenario[s]?.[key];
        // TIME-INTEGRATED per-scenario profit: iterate month-by-month.
        // Utilization varies month to month because demand ramps over the
        // term and each scenario has a different trajectory (weak grows
        // slowly, strong grows fast). Averaging over a fixed reference
        // window would clamp util at 1 for every scenario that meets or
        // exceeds the sizing level — hiding the scenario spread entirely.
        // The month-by-month integral captures the real difference.
        let sumProfit = 0, sumUtil = 0, sumInf = 0, sumTot = 0, sumMonths = 0;
        const nMonths = Math.min(termMo, ENGINE_HORIZON);
        // The ladder tranche is a CONDITIONAL commitment — signed only if
        // base trajectory confirms at the trigger (mo 6). Under weak the
        // ladder is not signed, so contract cost is not incurred and
        // profit contribution is zero. Under base/strong the ladder is
        // signed at mo 6 and delivers from ramp-3 months after that.
        const isLadderInWeak = kind === "ladder" && s === "weak";
        if (isLadderInWeak) {
          perScenario[s] = { profit: 0, util: 0, marginHr: 0, sellRate: 0, h100ePerGpu: 0 };
          continue;
        }
        for (let m = 0; m < nMonths; m++) {
          const live = rampMo > 0 ? Math.min(1, (m + 1) / rampMo) : 1;
          const capH100eFlops = gpusNeeded * live * flopsRatio;
          const dt = dem ? (dem.total[m] || 0) : 0;
          const di = dem ? (dem.infTot[m] || 0) : 0;
          const infShareM = dt > 0 ? di / dt : 0.5;
          // For revenue we need the workload-native H100e capacity: inference
          // reads BW, training reads FLOPs. Blend by month-specific mix.
          const h100ePerGpuM = infShareM * bwRatio + (1 - infShareM) * flopsRatio;
          const capH100eM = gpusNeeded * live * h100ePerGpuM;
          // Demand this new supply can serve (subtract existing supply and
          // any earlier-signed tranche in the same bucket).
          const alreadyFilled = kind === "ladder" ? safeSize : 0;
          const marginalDem = Math.max(0, dt - curSup - alreadyFilled);
          const util = capH100eM > 0 ? Math.min(1, marginalDem / capH100eM) : 0;
          const sellRateM = infShareM * params.infPrice + (1 - infShareM) * params.trainPrice;
          // Revenue = util × capacity × sell rate; cost = live GPU-hrs at
          // effective rate (rate + amortized financing). effRate is $/GPU-hr
          // already; summing cost over months with live_frac gives the same
          // total as one gpusNeeded × termHrs × effRate calculation.
          const revM = util * capH100eM * sellRateM * HRS_MO;
          const costM = gpusNeeded * live * contract.effRate * HRS_MO;
          sumProfit += revM - costM;
          sumUtil += util * live; // weight by delivered fraction
          sumInf += di; sumTot += dt; sumMonths += live;
        }
        const avgUtil = sumMonths > 0 ? sumUtil / sumMonths : 0;
        const infShareAvg = sumTot > 0 ? sumInf / sumTot : 0.5;
        const h100ePerGpuAvg = infShareAvg * bwRatio + (1 - infShareAvg) * flopsRatio;
        const sellRateAvg = infShareAvg * params.infPrice + (1 - infShareAvg) * params.trainPrice;
        const marginHr = avgUtil * h100ePerGpuAvg * sellRateAvg - contract.effRate;
        perScenario[s] = { profit: sumProfit, util: avgUtil, marginHr, sellRate: sellRateAvg, h100ePerGpu: h100ePerGpuAvg };
      }
      const EV = Object.keys(perScenario).reduce((s, sc) => s + (probs[sc] || 0) * perScenario[sc].profit, 0);
      // For the SAFE tranche, downside is weak-case termProfit (would sign
      // under all scenarios). For the LADDER, downside is the WORST of base
      // or strong (we conditionally sign; the risk is base underperforming).
      const downside = kind === "safe" ? (perScenario.weak?.profit ?? 0) : Math.min(perScenario.base?.profit ?? 0, perScenario.strong?.profit ?? 0);
      const prepaid = contract.upfront$ || 1;
      // Ladder's expected-value denominator: only sign in prob-mass of not-weak
      const evPerDollar = prepaid > 0 ? EV / prepaid : 0;
      const weakUtil = perScenario.weak?.util ?? 0;
      // Gates: SAFE tranche must clear weak-case (positive margin at weak-util
      // and weak-util above the floor). LADDER tranche is evaluated conditional
      // on the trigger firing (base+ trajectory), so gates read the BASE case.
      const gates = kind === "safe"
        ? {
            profitableAtWeakUtil: (perScenario.weak?.marginHr ?? -1) >= 0,
            weakUtilFloor: weakUtil >= params.weakUtilFloor,
          }
        : {
            profitableAtBaseUtil: (perScenario.base?.marginHr ?? -1) >= 0,
            baseUtilFloor: (perScenario.base?.util ?? 0) >= params.weakUtilFloor,
          };
      const passes = Object.values(gates).every(Boolean);
      // Ladder failing its base gate → still recommend as "ladder" but flagged;
      // ladder passing → recommend as "ladder-sign" (triggered later). To keep
      // the action taxonomy small: use "sign" for safe pass, "decline" for
      // safe fail, "ladder" for ladder pass, "decline" for ladder fail.
      const actionFor = kind === "safe" ? (passes ? "sign" : "decline") : (passes ? "ladder" : "decline");
      // Explain the failure so the collapsed DECLINE panel can show WHY
      // rather than just "we tried and rejected it". Reads the specific gate
      // that flipped false; if both, list both.
      let declineReason = null;
      if (actionFor === "decline") {
        const fails = [];
        if (kind === "safe") {
          if (!gates.profitableAtWeakUtil) fails.push(`margin < 0 at weak-case util (marginHr $${(perScenario.weak?.marginHr ?? 0).toFixed(3)}/H100e-hr)`);
          if (!gates.weakUtilFloor) fails.push(`weak-case util ${(weakUtil * 100).toFixed(0)}% below ${(params.weakUtilFloor * 100).toFixed(0)}% floor`);
        } else {
          if (!gates.profitableAtBaseUtil) fails.push(`margin < 0 at base-case util (marginHr $${(perScenario.base?.marginHr ?? 0).toFixed(3)}/H100e-hr)`);
          if (!gates.baseUtilFloor) fails.push(`base-case util ${((perScenario.base?.util ?? 0) * 100).toFixed(0)}% below ${(params.weakUtilFloor * 100).toFixed(0)}% floor`);
        }
        declineReason = fails.length ? fails.join("; ") : "local margin gate";
      }
      return {
        id: key + "-" + kind + "-" + vendor.name + "-t" + termMo, key, gpu, fab, region,
        action: actionFor,
        targetH100e: sizeH100e, gpus: gpusNeeded, termMo,
        rate: vendor.rate, vendor, vendors: allVendors, prepaid,
        odRate: vendor.odRate, termDiscount: vendor.termDisc,
        EV, downside, evPerDollar, perScenario, weakUtil, fractile: cl.fractile,
        trigger: kind === "safe" ? "now — committed tranche (weak-covered floor)" : "mo 6 — ladder increment, sign only if base trajectory confirms",
        tranche: kind,
        gates,
        declineReason,
      };
    };
    // OD baseline for a given tranche + horizon. On-demand economics differ
    // structurally from reserved: no upfront prepay, no lock-in, and cost
    // scales with delivered hours (you only pay for what you use). Cost per
    // month = util × gpus × live × odRate × 730 (util-scaled) vs. reserved's
    // util-INDEPENDENT fixed capacity cost. Revenue math is identical.
    // Returned EV becomes the baseline every reserved candidate at term T is
    // scored against — the reserved deal has to earn ENOUGH extra profit per
    // dollar of prepaid capital to beat sitting on OD.
    const computeODBaseline = (sizeH100e, kind, termMo) => {
      const gpusEquiv = Math.max(64, Math.round(sizeH100e * SUPPLY_GPUS.H100.tflops / g.tflops / 8) * 8);
      const rampMo = 3;
      const flopsRatio = g.tflops / SUPPLY_GPUS.H100.tflops;
      const bwRatio = g.bw / SUPPLY_GPUS.H100.bw;
      const odRate = g.odSource;
      const nMonths = Math.min(termMo, ENGINE_HORIZON);
      const perScenario = {};
      for (const s of Object.keys(demandByScenario)) {
        const dem = demandByScenario[s]?.[key];
        // Ladder under weak: trigger doesn't fire; we're not signing anything
        // AND we're not spinning up alternate OD capacity either. Zero-profit
        // parity with the reserved ladder-under-weak treatment.
        const isLadderInWeak = kind === "ladder" && s === "weak";
        if (isLadderInWeak) { perScenario[s] = { profit: 0, util: 0 }; continue; }
        let sumProfit = 0, sumUtil = 0, sumMonths = 0;
        for (let m = 0; m < nMonths; m++) {
          const live = rampMo > 0 ? Math.min(1, (m + 1) / rampMo) : 1;
          const dt = dem ? (dem.total[m] || 0) : 0;
          const di = dem ? (dem.infTot[m] || 0) : 0;
          const infShareM = dt > 0 ? di / dt : 0.5;
          const h100ePerGpuM = infShareM * bwRatio + (1 - infShareM) * flopsRatio;
          const capH100eM = gpusEquiv * live * h100ePerGpuM;
          const alreadyFilled = kind === "ladder" ? safeSize : 0;
          const marginalDem = Math.max(0, dt - curSup - alreadyFilled);
          const util = capH100eM > 0 ? Math.min(1, marginalDem / capH100eM) : 0;
          const sellRateM = infShareM * params.infPrice + (1 - infShareM) * params.trainPrice;
          const revM = util * capH100eM * sellRateM * HRS_MO;
          // OD cost scales with delivered physical GPU-hours — the flexibility premium.
          const costM = util * gpusEquiv * live * odRate * HRS_MO;
          sumProfit += revM - costM;
          sumUtil += util * live; sumMonths += live;
        }
        perScenario[s] = { profit: sumProfit, util: sumMonths > 0 ? sumUtil / sumMonths : 0 };
      }
      const EV = Object.keys(perScenario).reduce((s, sc) => s + (probs[sc] || 0) * perScenario[sc].profit, 0);
      return { EV, perScenario, gpus: gpusEquiv, odRate, termMo };
    };
    // Sweep the FULL cross-product of (term length × eligible vendor) per
    // tranche and pick the winner. Ranking metric: EXCESS EV OVER OD per
    // prepaid dollar — a reserved deal has to beat the on-demand baseline
    // by enough per capital dollar to justify locking in. Priority:
    //   (1) local margin gate pass > fail — a passing SIGN beats a
    //       "higher-excess but marginally unprofitable" one;
    //   (2) among peers, highest EXCESS EV / prepaid$ wins.
    // Term choices are asymmetric by tranche: SAFE covers a weak-case floor
    // so we're willing to sit in a 5-yr contract; LADDER is a conditional
    // signal-driven increment so we cap at 3yr. If NO reserved candidate has
    // positive excess-EV/$, OD wins the tranche → "on-demand" action (stay
    // flexible). If even OD has negative EV (sell rate < OD rate under the
    // scenario weights) → DECLINE — nothing here is profitable. Alternates
    // carry sibling vendors AT THE SAME winning term — those are what stage
    // 10 swaps to under a concentration cap trip.
    const pickBest = (sizeAt, kind) => {
      // sizeAt may be a scalar (term-invariant, e.g. safe tranche = weakD −
      // curSup) or a function T → size (term-dependent, e.g. ladder = per-term
      // commitLevel − weakD). Normalize to a function.
      const sizeFn = typeof sizeAt === "function" ? sizeAt : () => sizeAt;
      const termChoices = kind === "safe" ? [12, 36, 60] : [12, 36];
      const allCands = [];
      const odBaselines = {};
      let anySize = false;
      for (const termMo of termChoices) {
        const sizeH100e = sizeFn(termMo);
        if (sizeH100e <= 1) continue;
        anySize = true;
        const odBase = computeODBaseline(sizeH100e, kind, termMo);
        odBaselines[termMo] = odBase;
        const vendors = eligibleVendors(termMo);
        for (const v of vendors) {
          const c = buildCandidateFor(sizeH100e, kind, v, vendors, termMo);
          if (!c) continue;
          c.evOD = odBase.EV;
          c.excessEV = c.EV - odBase.EV;
          c.excessEvPerDollar = c.prepaid > 0 ? c.excessEV / c.prepaid : 0;
          allCands.push(c);
        }
      }
      if (!anySize || !allCands.length) return null;
      allCands.sort((a, b) => {
        const aPass = a.action !== "decline" ? 1 : 0;
        const bPass = b.action !== "decline" ? 1 : 0;
        if (aPass !== bPass) return bPass - aPass;
        return (b.excessEvPerDollar || 0) - (a.excessEvPerDollar || 0);
      });
      const topReserved = allCands[0];
      // OD wins the tranche if the best reserved candidate either fails gates
      // or has excess-EV ≤ 0 (OD baseline beats or ties it). Pick the term
      // whose OD-EV is highest as the display term for the ON-DEMAND row.
      const reservedBeatsOD = topReserved.action !== "decline" && (topReserved.excessEvPerDollar || 0) > 0;
      const bestODTerm = Object.keys(odBaselines).map(Number).sort((a, b) => (odBaselines[b].EV - odBaselines[a].EV))[0];
      const odBase = odBaselines[bestODTerm];
      const odSize = sizeFn(bestODTerm);
      if (!reservedBeatsOD) {
        // OD wins the tranche outright. Emit a primary ON-DEMAND row for the
        // cheapest catalog vendor + up to 2 alternate rows for the next-cheapest
        // catalog vendors — so the model tells the user WHO to buy OD from and
        // at what price. If OD-EV itself is ≤ 0 (unprofitable under the priors),
        // fall through to DECLINE — nothing here is worth doing.
        if (odBase.EV <= 0) {
          // Return the best reserved as a DECLINE with an honest reason —
          // even OD can't turn a profit at this bucket's demand vs. sell rate.
          topReserved.action = "decline";
          topReserved.declineReason = (topReserved.declineReason ? topReserved.declineReason + "; " : "") +
            `on-demand baseline also unprofitable (EV $${(odBase.EV / 1e6).toFixed(2)}M) — no scenario clears margin`;
          topReserved.alternates = allCands.filter(c => c !== topReserved && c.termMo === topReserved.termMo);
          topReserved.termAlternates = [];
          return topReserved;
        }
        const topOD = pickODVendors(gpu, fab, region, 3);
        // Fallback to a single generic row if no catalog match (shouldn't
        // happen for the six modeled chips, but keeps the flow resilient).
        const odRows = topOD.length ? topOD : [{ provider: "on-demand market", price: odBase.odRate, gpu, outFabric: fab, region }];
        const makeODCand = (v, idx) => {
          const isPrimary = idx === 0;
          // Vendor's specific OD price becomes the rate. EV/profit numbers are
          // re-scaled from the class-anchor OD baseline by the vendor-vs-anchor
          // price ratio: profit = revenue − util × gpus × price × hrs, so
          // adjusting price scales the cost side while leaving revenue fixed.
          const priceRatio = v.price / odBase.odRate;
          const scaledPerScen = {};
          for (const s of Object.keys(odBase.perScenario)) {
            const p = odBase.perScenario[s];
            // approx: rescale profit by (rev − scaled_cost) where scaled_cost = orig_cost × priceRatio.
            // Since orig profit = rev − orig_cost, and we don't have rev separately, use:
            // rev = profit + orig_cost. Then new profit = rev − orig_cost × priceRatio = profit + orig_cost × (1 − priceRatio).
            // orig_cost ≈ util × gpus × odRate × HRS_MO × months_live. Estimate months_live from util path.
            // Simpler and honest: scale by (2 − priceRatio) as a first-order approximation of the profit swing when rates move,
            // clamped. This is an approximation — the ranking (primary=cheapest) is what matters.
            const scaleFactor = Math.max(0, 2 - priceRatio);
            scaledPerScen[s] = { profit: (p.profit || 0) * scaleFactor, util: p.util || 0 };
          }
          const scaledEV = Object.keys(scaledPerScen).reduce((s, sc) => s + (probs[sc] || 0) * scaledPerScen[sc].profit, 0);
          return {
            id: key + "-" + kind + "-OD-" + v.provider.replace(/\s+/g, "_") + "-" + idx,
            key, gpu, fab, region,
            action: "on-demand",
            targetH100e: odSize,
            gpus: odBase.gpus,
            termMo: 0,
            rate: v.price,
            vendor: { name: v.provider, cmax: null, catalog: v },
            vendors: [],
            prepaid: 0,
            odRate: odBase.odRate,
            termDiscount: 0,
            EV: scaledEV,
            evOD: odBase.EV,
            excessEV: 0,
            excessEvPerDollar: 0,
            evPerDollar: 0,
            downside: scaledPerScen.weak?.profit ?? 0,
            perScenario: scaledPerScen,
            weakUtil: scaledPerScen.weak?.util ?? 0,
            fractile: cl.fractile,
            trigger: isPrimary
              ? `PRIMARY: cheapest on-demand vendor for this bucket. On-demand baseline beat every reserved-term candidate (best reserved would have earned ${((topReserved.excessEvPerDollar || 0)).toFixed(3)} excess profit per $1 of prepay vs. OD — negative, so locking in destroys value).`
              : `ALT #${idx}: alternative on-demand vendor at $${v.price.toFixed(2)}/hr (vs. primary at $${topOD[0].price.toFixed(2)}/hr). Same GPU/fabric/region bucket — pick this if the primary vendor is unavailable or oversubscribed.`,
            tranche: kind,
            gates: {},
            declineReason: null,
            bestReservedRejected: topReserved,
            isOD: true,
            odRank: idx,
            odRegion: v.region,
            odFabric: v.outFabric,
            odNotes: v.notes,
          };
        };
        const primaryAndAlts = odRows.map((v, i) => makeODCand(v, i));
        // Return array — caller will spread into cands.
        return primaryAndAlts;
      }
      // Reserved wins. Continue with the existing alternates logic.
      const winner = topReserved;
      // Alternates for stage-10 vendor swaps must share the winning term
      // (a concentration-cap swap is a same-deal vendor substitution, not a
      // reprice at a different term). Filter to same termMo, same tranche.
      winner.alternates = allCands.filter(c => c !== winner && c.termMo === winner.termMo);
      // Cross-term alternates: the runners-up at OTHER terms, one per term.
      // Purely informational — surfaces "at 12mo the best deal would have
      // been X, at 60mo it would have been Y". Not used for swaps.
      const bestPerTerm = {};
      for (const c of allCands) {
        const t = c.termMo;
        if (!bestPerTerm[t] || (c.excessEvPerDollar > bestPerTerm[t].excessEvPerDollar)) bestPerTerm[t] = c;
      }
      winner.termAlternates = Object.keys(bestPerTerm)
        .filter(t => Number(t) !== winner.termMo)
        .map(t => bestPerTerm[t]);
      return winner;
    };
    // Safe tranche is term-invariant (weakD is a fact about demand); ladder
    // tranche is term-dependent (each term's per-term commit level determines
    // its ladder increment above weakD). This is the joint (chip, term)
    // optimization — the winning (term, vendor, size) tuple emerges together.
    const safeCand = pickBest(safeSize, "safe");
    const ladderCand = pickBest(ladderSizeAt, "ladder");
    // OD path returns an array (primary + alternates); reserved path returns a
    // single candidate. Handle both.
    if (safeCand) { if (Array.isArray(safeCand)) cands.push(...safeCand); else cands.push(safeCand); }
    if (ladderCand) { if (Array.isArray(ladderCand)) cands.push(...ladderCand); else cands.push(ladderCand); }
  }
  cands.sort((a, b) => (b.excessEvPerDollar || 0) - (a.excessEvPerDollar || 0));
  return cands;
}

// STAGE 9: renewal / lapse / decline at each expiring position. Anchored to
// WEAK demand at expiry — if weak covers the position, renew; if only base
// covers a slice, renew-partial the slice and flex the rest; if base is
// negligible, let it lapse.
function generateRenewals(book, demandByScenario, horizon) {
  const out = [];
  for (const r of book.filter(x => x.status === "active" && x.structure === "reserved" && x.remMo <= horizon && x.remMo > 0)) {
    const key = r.gpu + "|" + r.ic + "|" + r.region;
    const h100e = h100eOf(r, "flops");
    const wd = demandByScenario.weak?.[key]?.total?.[Math.min(horizon - 1, r.remMo)] || 0;
    const bd = demandByScenario.base?.[key]?.total?.[Math.min(horizon - 1, r.remMo)] || 0;
    let action, note;
    if (wd >= h100e * 0.8) { action = "renew"; note = `weak-case demand at expiry (${fmtBig(Math.round(wd))} H100e) covers ≥80% of position — renewal beats OD-replacement`; }
    else if (wd >= h100e * 0.3) { action = "renew-partial"; note = `weak covers ${fmtPct(wd / Math.max(1, h100e))} of position; renew that slice, flex the rest`; }
    else if (bd <= h100e * 0.2) { action = "lapse"; note = `base-case demand at expiry (${fmtBig(Math.round(bd))} H100e) ≤20% of position — let it roll off`; }
    else { action = "renew-partial"; note = `base carries ${fmtPct(bd / Math.max(1, h100e))}; weak only ${fmtPct(wd / Math.max(1, h100e))} — renew the safe slice`; }
    const EV = h100e * (wd / Math.max(1, h100e)) * 0.4 * (r.rate || 1) * HRS_MO * 6;
    out.push({ id: "ren-" + r.id, key, gpu: r.gpu, fab: r.ic, region: r.region, action, note, EV, downside: 0, deal: r, targetH100e: h100e, trigger: `mo ${r.remMo} — position expiry`, evPerDollar: 0.1 });
  }
  return out;
}

// STAGE 10: book-level guardrails applied AFTER per-deal scoring — some
// gates (concentration, cumulative prepaid) can only be judged against the
// accumulated book, not per deal in isolation.
function applyBookGuardrails(recs, book, params) {
  const active = book.filter(r => r.status === "active" && r.structure === "reserved");
  const totalGpus = active.reduce((s, r) => s + r.gpus, 0);
  // Forward-looking concentration: judge each vendor's share against the
  // FINAL book (existing + all sign/ladder recs). Otherwise, if the current
  // book is small (bootstrap / after a big prune), any first deal trivially
  // hits 100% share of a tiny incumbent. The 40% cap is a stable-state
  // ceiling; if projected total is below the CONCENTRATION_FLOOR the engine
  // is in bootstrap mode and the cap doesn't apply yet.
  const CONC_FLOOR = 2000;
  const newSignGpus = recs.filter(r => r.action === "sign" || r.action === "ladder").reduce((s, r) => s + (r.gpus || 0), 0);
  const projectedTotal = totalGpus + newSignGpus;
  const byVendorProjected = {}; active.forEach(r => { byVendorProjected[r.provider] = (byVendorProjected[r.provider] || 0) + r.gpus; });
  for (const rec of recs) if (rec.action === "sign" || rec.action === "ladder") {
    const v = rec.vendor?.name; if (v) byVendorProjected[v] = (byVendorProjected[v] || 0) + (rec.gpus || 0);
  }
  const totalRev = params.arrRun || 500e6;
  const prepaidCap = params.prepaidCapRatio * totalRev;
  // Solvency ceiling on TOTAL committed spend across the reserved book. Baseline
  // = full contract value remaining across active reserved positions (ramp-
  // adjusted GPU-months × rate × HRS), i.e. what we're already on the hook for.
  // Each new sign / ladder / renew tranche adds its own contract value on top,
  // and the first candidate that would push the total past the cap is gated.
  const totalSpendCap = params.totalSpendCap || Infinity;
  let runningSpend = active.reduce((s, r) => {
    let liveMo = 0;
    for (let m = 1; m <= (r.remMo || 0); m++) liveMo += liveFracOf(r, m);
    return s + r.gpus * r.rate * HRS_MO * liveMo;
  }, 0);
  // Existing-book obligation "if we started counting from month mStart" —
  // i.e., how much take-or-pay is still ahead of us if we push the sign date
  // out by mStart months. Non-increasing in mStart: as positions roll off,
  // the residual obligation shrinks. Used to price DEFER candidates.
  const bookObligationFrom = (mStart) => {
    let s = 0;
    for (const r of active) {
      let liveMo = 0;
      for (let m = mStart + 1; m <= (r.remMo || 0); m++) liveMo += liveFracOf(r, m);
      s += r.gpus * r.rate * HRS_MO * liveMo;
    }
    return s;
  };
  const MAX_DEFER_MO = 24;
  // Layered obligation from earlier-deferred deals — added to the residual
  // book baseline so subsequent defers push further into the future rather
  // than all stacking at the same "first feasible" month. Conservative: full
  // contract value counted through the entire search window.
  let deferredCommitted = 0;
  let runningPrepaid = 0, bronzePrepaid = 0;
  for (const rec of recs) {
    const flags = [];
    if (rec.action === "sign" || rec.action === "ladder") {
      // Concentration swap: if the primary vendor would trip the 40% cap and
      // ranked alternates exist (stored on rec.alternates from the per-bucket
      // vendor sweep in generateCandidates), promote the first alt whose share
      // would still fit. Each alt is a full candidate — swapping copies its
      // vendor, rate, prepaid, EV, and perScenario onto the rec so downstream
      // math sees the correct economics. Only when NO alt fits do we flag.
      const gpusAdded = rec.gpus || 0;
      const primaryName = rec.vendor?.name || "unknown";
      if (projectedTotal >= CONC_FLOOR && rec.alternates && rec.alternates.length) {
        const shareOf = (name) => (byVendorProjected[name] || 0) / projectedTotal;
        if (shareOf(primaryName) > 0.4) {
          for (const alt of rec.alternates) {
            const altName = alt.vendor?.name;
            if (!altName || altName === primaryName) continue;
            const altShareIfSwap = ((byVendorProjected[altName] || 0) + gpusAdded) / projectedTotal;
            if (altShareIfSwap <= 0.4) {
              byVendorProjected[primaryName] = Math.max(0, (byVendorProjected[primaryName] || 0) - gpusAdded);
              byVendorProjected[altName] = (byVendorProjected[altName] || 0) + gpusAdded;
              rec.vendor = alt.vendor;
              rec.rate = alt.rate;
              rec.prepaid = alt.prepaid;
              rec.EV = alt.EV;
              rec.downside = alt.downside;
              rec.evPerDollar = alt.evPerDollar;
              rec.perScenario = alt.perScenario;
              rec.weakUtil = alt.weakUtil;
              rec.gates = alt.gates;
              rec.vendorSwappedFrom = primaryName;
              break;
            }
          }
        }
      }
      const vName = rec.vendor?.name || "unknown";
      if (projectedTotal >= CONC_FLOOR) {
        const vShare = (byVendorProjected[vName] || 0) / projectedTotal;
        if (vShare > 0.4) flags.push({ warn: true, text: `${vName} would hit ${fmtPct(vShare)} of the projected ${projectedTotal.toLocaleString()}-GPU book — >40% concentration cap (no alternate vendor with headroom)` });
      }
      const dealPrepaid = rec.prepaid || 0;
      if (rec.vendor?.cmax === "bronze") { bronzePrepaid += dealPrepaid; if (bronzePrepaid > totalRev * 0.10) flags.push({ warn: true, text: "Bronze vendor prepaid capital would exceed 10% of ARR cap" }); }
      runningPrepaid += dealPrepaid;
      if (runningPrepaid > prepaidCap) flags.push({ warn: true, text: `Cumulative prepaid capital would exceed ${(params.prepaidCapRatio * 100).toFixed(0)}% of ARR` });
      if (rec.fab === "eth" && rec.gpu !== "L40S") flags.push({ warn: true, text: "Standard Ethernet on non-inference chip — restricted from multi-node training" });
      // Total-spend / solvency gate. Full contract value of this tranche.
      const dealSpend = (rec.gpus || 0) * (rec.rate || 0) * HRS_MO * (rec.termMo || 0);
      const wouldBreachSpend = runningSpend + dealSpend > totalSpendCap;
      if (!wouldBreachSpend) runningSpend += dealSpend;
      // DEFER path: if spend cap is the ONLY thing blocking this deal
      // (concentration/prepay/ethernet all clean), search for the earliest
      // month where existing-book obligation has rolled off enough — layered
      // over any earlier defers in this pass — to fit the deal under the cap.
      // "Sign later" is a distinct action from "sign now" or "decline".
      if (wouldBreachSpend && flags.length === 0) {
        let deferAt = null;
        for (let mStart = 1; mStart <= MAX_DEFER_MO; mStart++) {
          const bookAt = bookObligationFrom(mStart);
          if (bookAt + deferredCommitted + dealSpend <= totalSpendCap) { deferAt = mStart; break; }
        }
        if (deferAt != null) {
          rec.action = "defer";
          rec.deferAt = deferAt;
          rec.trigger = `mo ${deferAt} — sign then; existing book rolls off to $${(bookObligationFrom(deferAt) / 1e6).toFixed(0)}M by then, fits under $${(totalSpendCap / 1e6).toFixed(0)}M cap`;
          rec.note = rec.trigger;
          rec.flags = [];
          deferredCommitted += dealSpend;
          continue;
        }
        flags.push({ warn: true, text: `Cumulative committed spend would exceed $${(totalSpendCap / 1e6).toFixed(0)}M total-spend cap (baseline $${(runningSpend / 1e6).toFixed(0)}M + this deal $${(dealSpend / 1e6).toFixed(0)}M); no month within ${MAX_DEFER_MO} mo frees enough headroom to defer` });
      } else if (wouldBreachSpend) {
        flags.push({ warn: true, text: `Cumulative committed spend would exceed $${(totalSpendCap / 1e6).toFixed(0)}M total-spend cap (baseline $${(runningSpend / 1e6).toFixed(0)}M + this deal $${(dealSpend / 1e6).toFixed(0)}M)` });
      }
    } else if (rec.action === "renew" || rec.action === "renew-partial") {
      // Renewals extend an existing position's term, adding new commitment
      // = gpus × rate × HRS × extendMo (full term for renew, ~½ for partial —
      // mirrors applyRec above). If the extension would breach the total-spend
      // cap, downgrade to lapse rather than silently over-committing.
      const d = rec.deal;
      if (d) {
        const extendMo = rec.action === "renew" ? (d.termMo || 24) : Math.max(6, Math.round((d.termMo || 24) * 0.5));
        const dealSpend = (d.gpus || 0) * (d.rate || 0) * HRS_MO * extendMo;
        if (runningSpend + dealSpend > totalSpendCap) {
          const f = { warn: true, text: `Renewal would breach $${(totalSpendCap / 1e6).toFixed(0)}M total-spend cap — downgraded to LAPSE` };
          rec.flags = [f];
          rec.action = "lapse";
          rec.note = f.text;
          continue;
        } else {
          runningSpend += dealSpend;
        }
      }
    }
    rec.flags = flags;
    if (flags.length > 0 && (rec.action === "sign" || rec.action === "ladder")) { rec.action = "decline"; rec.declineReason = flags[0].text; }
  }
  return recs;
}

// STAGE 11: scenario P&L for one recommended book. Revenue − sourcing cost
// − prepay carry − overflow. Overflow priced by workload (training
// checkpoint/restart HIGH; inference dropped-request LOW → spot ≈ free).
function computeScenarioPnL(book, demandByScenario, probs, params, horizon) {
  const HRS = HRS_MO;
  const per = {};
  for (const s of Object.keys(demandByScenario)) {
    let revenue = 0, cost = 0, carry = 0, overflow = 0;
    // Split supply by structure so we can charge take-or-pay to reserved
    // (paid whether used or not) and USAGE-BASED cost to OD/spot positions
    // (paid only per served GPU-hour). Existing bug was: OD/spot in the book
    // served demand "for free" — inflating margins for scenarios that lean
    // hard on OD/spot supply.
    const supByKey = {};
    const demByKey = demandByScenario[s];
    for (const r of book) {
      if (r.status !== "active") continue;
      const g = SUPPLY_GPUS[r.gpu]; if (!g) continue;
      const key = r.gpu + "|" + r.ic + "|" + r.region;
      supByKey[key] = supByKey[key] || { rsv: Array(horizon).fill(0), od: Array(horizon).fill(0), odRateWeighted: Array(horizon).fill(0), odCapForRate: Array(horizon).fill(0) };
      const b = supByKey[key];
      const flopsFactor = g.tflops / SUPPLY_GPUS.H100.tflops;
      for (let m = 0; m < horizon; m++) {
        const active = r.structure === "reserved" ? (m < r.remMo ? 1 : 0) : 1;
        const capH100e = r.gpus * liveFracOf(r, m + 1) * active * flopsFactor;
        if (r.structure === "reserved") {
          b.rsv[m] += capH100e;
        } else {
          b.od[m] += capH100e;
          // Capacity-weighted average rate so we can price OD/spot usage
          b.odRateWeighted[m] += capH100e * r.rate;
          b.odCapForRate[m] += capH100e;
        }
      }
      // Reserved book: take-or-pay contract — full contracted GPU-hours ×
      // rate hits COST regardless of utilization. That's the whole point of
      // "reserved": you locked it in.
      const maxMo = r.structure === "reserved" ? Math.min(horizon, r.remMo || horizon) : horizon;
      if (r.structure === "reserved") for (let m = 0; m < maxMo; m++) cost += r.gpus * liveFracOf(r, m + 1) * r.rate * HRS;
      // Prepay carry: cost of capital on upfront cash, amortized over horizon
      if (r.structure === "reserved" && (r.upfrontPct || 0) > 0 && r.termMo > 0) {
        const cv = r.gpus * r.rate * HRS * r.termMo;
        carry += (r.upfrontPct / 100) * cv * (params.wacc / 100) * Math.min(horizon, r.remMo || 0) / (r.termMo * 24);
      }
    }
    // Serving + overflow loop
    for (const key of Object.keys(demByKey)) {
      const [gpu] = key.split("|");
      const g = SUPPLY_GPUS[gpu]; if (!g) continue;
      const dem = demByKey[key];
      const b = supByKey[key] || { rsv: Array(horizon).fill(0), od: Array(horizon).fill(0), odRateWeighted: Array(horizon).fill(0), odCapForRate: Array(horizon).fill(0) };
      for (let m = 0; m < horizon; m++) {
        const rsvSup = b.rsv[m], odSup = b.od[m];
        const totalSup = rsvSup + odSup;
        const infShare = dem.total[m] > 0 ? dem.infTot[m] / dem.total[m] : 0.5;
        const sellRate = infShare * params.infPrice + (1 - infShare) * params.trainPrice;
        // Serve reserved first (already paid for), then dip into OD/spot
        // (usage-based cost). Idle reserved capacity gets salvaged at spot.
        const rsvServed = Math.min(rsvSup, dem.total[m]);
        const remainingDem = Math.max(0, dem.total[m] - rsvServed);
        const odServed = Math.min(odSup, remainingDem);
        const served = rsvServed + odServed;
        const idleRsv = Math.max(0, rsvSup - rsvServed);
        // Revenue: served demand × customer sell rate + salvage on idle reserved
        revenue += served * sellRate * HRS + idleRsv * g.spotRef * (params.liquidityFactor ?? 0.5) * HRS;
        // OD/spot supply usage-based cost — the fix: was previously $0
        if (odServed > 0 && b.odCapForRate[m] > 0) {
          const odRateAvg = b.odRateWeighted[m] / b.odCapForRate[m];
          cost += odServed * odRateAvg * HRS;
        }
        // OVERFLOW: demand still unmet after the book (both reserved + OD/spot).
        // Only cover on upstream OD if it's PROFITABLE (customer sell rate >
        // OD source cost). Otherwise walk away — you don't lose money on every
        // unit sold at a loss.
        //
        // FORFEIT cost when we walk away: Prime Intellect operates as an
        // on-demand rental marketplace — customers don't sign take-or-pay
        // agreements the way we do with upstream, so there's no contractual
        // SLA damage. What there IS: a customer-switching risk. A customer
        // that gets turned away has some probability of migrating their
        // future runs to a competitor (CoreWeave, Lambda, Voltage Park, etc.)
        // and never coming back. So the forfeit is walked-away revenue ×
        // switching probability × approximate customer LTV multiple.
        //   TRAINING switch cost ≈ 5% of walked-away rev — training buyers
        //     do multi-week runs and rate reliability HIGH; being unable to
        //     source their next run pushes them toward a more stable platform
        //     for the whole workload family.
        //   INFERENCE switch cost ≈ 2% of walked-away rev — inference is
        //     bursty and multi-vendor by default; a single miss is annoying
        //     but customers usually come back.
        // These are churn-risk premia on the walked-away revenue, not SLA
        // damages on a signed contract.
        const short = Math.max(0, dem.total[m] - totalSup);
        if (short > 0.01) {
          const marginOD = sellRate - g.odSource; // $/H100e-hr net if we cover on OD
          if (marginOD > 0) {
            // Cover and profit
            revenue += short * sellRate * HRS;
            cost += short * g.odSource * HRS;
          } else {
            // Walk away — book customer-switching risk on walked-away revenue
            const shortInf = short * infShare, shortTrain = short * (1 - infShare);
            overflow += shortTrain * sellRate * HRS * 0.05 + shortInf * sellRate * HRS * 0.02;
          }
        }
      }
    }
    per[s] = { revenue, cost, carry, overflow, netMargin: revenue - cost - carry - overflow };
  }
  const EV = Object.keys(per).reduce((sum, s) => sum + (probs[s] || 0) * per[s].netMargin, 0);
  return { perScenario: per, EV, downside: per.weak?.netMargin || 0, upside: per.strong?.netMargin || 0 };
}

// ─── Main App ────────────────────────────────────────────────────────────────
function App() {
  const [book, setBook] = useBookStore(SUPPLY_STORE);
  const [policy] = useBookStore(POLICY_STORE);

  // Demand + pricing context (shared stores): the cohort demand curve drives the
  // pool-balance check and the commitment ladder; pricing anchors the policy
  // sparkline; the LLM model mix from Compute Demand drives model
  // serviceability. Same numbers Compute Demand and Projections read.
  const cohorts = useBookStore(COHORT_STORE)[0];
  const baseline = useBookStore(BASELINE_STORE)[0];
  const [pricing] = useBookStore(PRICING_STORE);
  const modelMix = useBookStore(MODEL_MIX_STORE)[0];
  const demSeries = useMemo(() => {
    const idx = baselineIdx(baseline, 24);
    const cs = cohortSeries(cohorts, 24, idx, pricing);
    return { inf: cs.inf, train: cs.train, tot: cs.inf.map((v, i) => v + cs.train[i]) };
  }, [cohorts, baseline, pricing]);
  // Models to test for serviceability come from the Compute Demand tab's
  // LLM model mix (single source of truth). MoE flag is inferred from
  // active vs total params (a fraction under ~50% signals MoE routing).
  const dashModels = useMemo(() => modelMix
    .map(m => ({ key: "m" + m.id, label: m.name, paramsB: m.paramsB, moe: !!(m.activeB && m.activeB < m.paramsB * 0.5) }))
    .sort((a, b) => a.paramsB - b.paramsB), [modelMix]);

  // Cost-of-capital + market-decline are shared engine inputs (used by the
  // supply-filling engine below and by any downstream deal-economics call).
  const [wacc, setWacc] = useState(15);
  const [mktDecline, setMktDecline] = useState(25);
  // H100e normalization basis for book aggregates: FLOPs (training convention)
  // or memory bandwidth (inference-native).
  const [normMode, setNormMode] = useState("flops");
  // Supply-book sort state. key=null preserves insertion order; string keys are
  // sorted ascending, numeric keys descending, on first click.
  const [sortBy, setSortBy] = useState({ key: null, dir: "desc" });
  const STRING_SORT_KEYS = ["provider", "gpu", "structure", "pay", "region", "ic", "status"];
  const toggleSort = (key) => setSortBy(s => s.key === key
    ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
    : { key, dir: STRING_SORT_KEYS.includes(key) ? "asc" : "desc" });
  // $/H100e-hr: raw contracted rate divided by the row's H100-relative perf
  // ratio under the active normalization mode (FLOPs or memory bandwidth).
  // Makes rates directly comparable across chip generations.
  const normRateOf = (r) => {
    const g = SUPPLY_GPUS[r.gpu]; if (!g) return r.rate;
    const ratio = normMode === "bw" ? g.bw / SUPPLY_GPUS.H100.bw : g.tflops / SUPPLY_GPUS.H100.tflops;
    return ratio > 0 ? r.rate / ratio : r.rate;
  };
  // ── Book aggregates ──
  const agg = useMemo(() => {
    const act = book.filter(r => r.status === "active");
    const totalGpus = act.reduce((s, r) => s + r.gpus, 0);
    const rsv = act.filter(r => r.structure === "reserved");
    const rsvGpus = rsv.reduce((s, r) => s + r.gpus, 0);
    const odGpus = act.filter(r => r.structure === "ondemand").reduce((s, r) => s + r.gpus, 0);
    const spotGpus = act.filter(r => r.structure === "spot").reduce((s, r) => s + r.gpus, 0);
    const totalH100e = act.reduce((s, r) => s + h100eOf(r, normMode), 0);
    const spendHr = act.reduce((s, r) => s + r.gpus * r.rate, 0);
    const blended = totalH100e > 0 ? spendHr / totalH100e : 0;          // $/H100e-hr (FLOP-weighted)
    const blendedGpu = totalGpus > 0 ? spendHr / totalGpus : 0;         // raw $/GPU-hr for reference
    // Ramp-aware: this month's spend counts only delivered capacity; the
    // remaining obligation sums each month's delivered fraction to term end.
    const committedMonthly = rsv.reduce((s, r) => s + r.gpus * liveFracOf(r, 1) * r.rate * HRS_MO, 0);
    const committedRemaining = rsv.reduce((s, r) => { let liveMo = 0; for (let m = 1; m <= r.remMo; m++) liveMo += liveFracOf(r, m); return s + r.gpus * r.rate * HRS_MO * liveMo; }, 0);
    const undelivered = act.reduce((s, r) => s + r.gpus * (1 - liveFracOf(r, 1)), 0);
    // Unamortized prepaid capital: upfront% of contract value × fraction of term remaining
    const prepaidOut = rsv.reduce((s, r) => s + (r.upfrontPct / 100) * (r.gpus * r.rate * HRS_MO * r.termMo) * (r.termMo > 0 ? r.remMo / r.termMo : 0), 0);
    const rsvH100e = rsv.reduce((s, r) => s + h100eOf(r, normMode), 0);
    // Free = delivered but unsold. Undelivered capacity is neither free nor sold.
    const freeGpus = act.reduce((s, r) => s + r.gpus * liveFracOf(r, 1) * (1 - (r.soldPct || 0) / 100), 0);
    const freeH100e = act.reduce((s, r) => s + h100eOf(r, normMode) * liveFracOf(r, 1) * (1 - (r.soldPct || 0) / 100), 0);
    const wTerm = rsvH100e > 0 ? rsv.reduce((s, r) => s + h100eOf(r, normMode) * r.remMo, 0) / rsvH100e : 0;
    // Expiry ladder buckets (reserved GPUs rolling off)
    // Reserved capacity still under contract in each of the next 12 calendar
    // months: a position with N months remaining contributes to months 1..N.
    const now = new Date();
    const monthLabel = i => {
      const mo = (now.getMonth() + i) % 12 + 1;
      const yr = (now.getFullYear() + Math.floor((now.getMonth() + i) / 12)) % 100;
      return `${mo}/${String(yr).padStart(2, "0")}`;
    };
    const buckets = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const rows = rsv.filter(r => r.remMo >= m);
      const byRegion = {};
      for (const r of rows) byRegion[r.region] = (byRegion[r.region] || 0) + h100eOf(r, normMode) * liveFracOf(r, m);
      return { label: monthLabel(i), gpus: Math.round(rows.reduce((s, r) => s + r.gpus * liveFracOf(r, m), 0)), h100e: rows.reduce((s, r) => s + h100eOf(r, normMode) * liveFracOf(r, m), 0), byRegion };
    });
    // Per-GPU-type blended reserved rate, for comparing new deals to the book
    const byGpu = {};
    for (const r of rsv) { byGpu[r.gpu] = byGpu[r.gpu] || { gpus: 0, cost: 0 }; byGpu[r.gpu].gpus += r.gpus; byGpu[r.gpu].cost += r.gpus * r.rate; }
    for (const k of Object.keys(byGpu)) byGpu[k].rate = byGpu[k].cost / byGpu[k].gpus;
    return { totalGpus, totalH100e, rsvGpus, odGpus, spotGpus, blended, blendedGpu, committedMonthly, committedRemaining, prepaidOut, wTerm, buckets, byGpu, freeGpus, freeH100e, undelivered };
  }, [book, normMode]);

  // Sorted view of the book — click a header to sort by that column. Sort is
  // display-only; storage order in SUPPLY_STORE is preserved.
  const sortedBook = useMemo(() => {
    if (!sortBy.key) return book;
    const dir = sortBy.dir === "asc" ? 1 : -1;
    const getVal = (r) => {
      switch (sortBy.key) {
        case "provider":   return r.provider || "";
        case "gpu":        return r.gpu || "";
        case "gpus":       return r.gpus || 0;
        case "structure":  return r.structure || "";
        case "rate":       return r.rate || 0;
        case "normRate":   return normRateOf(r);
        case "termMo":     return r.termMo || 0;
        case "remMo":      return r.remMo || 0;
        case "upfrontPct": return r.upfrontPct || 0;
        case "pay":        return r.pay || "";
        case "region":     return r.region || "";
        case "ic":         return r.ic || "";
        case "status":     return r.status || "";
        default:           return 0;
      }
    };
    return [...book].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }, [book, sortBy, normMode]);

  const removeRow = useCallback(id => setBook(b => b.filter(r => r.id !== id)), []);
  const toggleStatus = useCallback(id => setBook(b => b.map(r => r.id === id ? { ...r, status: r.status === "active" ? "pending" : "active" } : r)), []);
  // Apply an engine recommendation to the actual supply book: sign/ladder =
  // log a new active deal from the vendor spec; renew / renew-partial = extend
  // the existing position's remaining term (full term for renew, half for
  // partial); lapse = remove the expiring deal from the book. Decline is a
  // no-op (nothing to add).
  const applyRec = useCallback((rec) => {
    if (!rec) return;
    if (rec.action === "sign" || rec.action === "ladder") {
      if (!rec.vendor) return;
      const newDeal = {
        id: Date.now() + Math.random(),
        provider: rec.vendor.name, gpu: rec.gpu, gpus: rec.gpus,
        structure: "reserved", rate: rec.vendor.rate, termMo: rec.termMo, remMo: rec.termMo,
        upfrontPct: rec.vendor.prepay, pay: "prepay_q", region: rec.region, ic: rec.fab,
        soldPct: 0, rampMo: 3, status: "active",
      };
      setBook(b => [...b, newDeal]);
    } else if (rec.action === "on-demand") {
      // OD isn't a fixed contract, but recording an entry gives the supply
      // book a visible line for "we intend to cover this bucket at OD from
      // vendor X." No prepay, no lock-in — remMo defaults to the engine
      // horizon so the entry appears alongside reserved positions.
      if (!rec.vendor) return;
      const newDeal = {
        id: Date.now() + Math.random(),
        provider: rec.vendor.name, gpu: rec.gpu, gpus: rec.gpus,
        structure: "ondemand", rate: rec.rate || rec.odRate || 0, termMo: 0, remMo: 0,
        upfrontPct: 0, pay: "net30", region: rec.region, ic: rec.fab,
        soldPct: 0, status: "active",
      };
      setBook(b => [...b, newDeal]);
    } else if ((rec.action === "renew" || rec.action === "renew-partial") && rec.deal) {
      const extendMo = rec.action === "renew" ? (rec.deal.termMo || 24) : Math.max(6, Math.round((rec.deal.termMo || 24) * 0.5));
      setBook(b => b.map(r => r.id === rec.deal.id ? { ...r, remMo: (r.remMo || 0) + extendMo, termMo: (r.termMo || 0) + extendMo } : r));
    } else if (rec.action === "lapse" && rec.deal) {
      setBook(b => b.filter(r => r.id !== rec.deal.id));
    }
  }, [setBook]);

  // ═══════════════════════════════════════════════════════════════════════
  // Supply-filling engine state (Stages 1-11). Scenarios are correlated
  // states of the world — one coherent "weak future" applied across all
  // cohorts, so weak-case downside is a real tail (not the intersection of
  // independent per-cohort worst cases). Salvage per chip is exposed because
  // it moves the commit level more than any other parameter.
  // ═══════════════════════════════════════════════════════════════════════
  // Prior probabilities are edited on the Compute Demand tab alongside the
  // scenario toggle — one control surface for "what future are we in?" — and
  // read here to weight expected values.
  const [probPct] = useBookStore(SCENARIO_PROB_STORE);
  const probs = useMemo(() => ({ weak: probPct.weak / 100, base: probPct.base / 100, strong: probPct.strong / 100 }), [probPct]);
  // Reserved discount curve — owned by the Vendor Spec & Contracts tab (edit
  // sliders there), read by candidate generation to price each term length.
  const [reservedDiscount] = useBookStore(RESERVED_DISCOUNT_STORE);
  // Liquidity factor per chip (0 → dead, 1 → fully resaleable at spot ref).
  // Training-only rack-scale chips (B300 NVL72) have poor secondary markets;
  // fungible H100/H200/L40S have healthy spot markets.
  const [salvage, setSalvage] = useState({ H100: 0.75, H200: 0.80, B200: 0.55, B300: 0.35, A100_80: 0.70, L40S: 0.85 });
  const setSalvageFor = k => v => setSalvage(prev => ({ ...prev, [k]: Math.max(0, Math.min(1, v / 100)) }));
  const [weakUtilFloor, setWeakUtilFloor] = useState(30);   // % — hard gate on new deals
  const [arrRunM, setArrRunM] = useState(500);              // $M ARR — capital cap denominator
  const [prepaidCapPct, setPrepaidCapPct] = useState(15);   // % of ARR — prepaid capital ceiling
  const [totalSpendCapM, setTotalSpendCapM] = useState(1000); // $M — solvency ceiling on total committed spend

  const demandBook = useBookStore(DEMAND_STORE)[0];
  const engineParams = useMemo(() => ({
    wacc, mktDecline, infPrice: pricing.infPrice, trainPrice: pricing.trainPrice,
    weakUtilFloor: weakUtilFloor / 100, arrRun: arrRunM * 1e6, prepaidCapRatio: prepaidCapPct / 100,
    totalSpendCap: totalSpendCapM * 1e6,
    liquidityFactor: 0.45,
    reservedDiscount,
  }), [wacc, mktDecline, pricing.infPrice, pricing.trainPrice, weakUtilFloor, arrRunM, prepaidCapPct, totalSpendCapM, reservedDiscount]);

  const demandByScenario = useMemo(
    () => buildScenarioDemand(SCENARIO_COHORTS, baseline, pricing, modelMix, demandBook, ENGINE_HORIZON),
    [baseline, pricing, modelMix, demandBook]
  );
  const supplyState = useMemo(() => buildSupplyState(book, ENGINE_HORIZON), [book]);
  // Cascade is computed per scenario for gap-map visualization; use base as
  // primary display, but recommendations look at all three.
  const cascadeByScenario = useMemo(() => {
    const out = {};
    for (const s of Object.keys(demandByScenario)) out[s] = cascadeFill(supplyState, demandByScenario[s], ENGINE_HORIZON);
    return out;
  }, [supplyState, demandByScenario]);
  const commitLevels = useMemo(
    () => computeCommitLevels(supplyState, demandByScenario, probs, salvage, [6, 18], reservedDiscount),
    [supplyState, demandByScenario, probs, salvage, reservedDiscount]
  );
  const candidates = useMemo(
    () => generateCandidates(commitLevels, cascadeByScenario.base, supplyState, demandByScenario, probs, engineParams),
    [commitLevels, cascadeByScenario, supplyState, demandByScenario, probs, engineParams]
  );
  const renewals = useMemo(() => generateRenewals(book, demandByScenario, ENGINE_HORIZON), [book, demandByScenario]);
  const recommendations = useMemo(() => {
    const merged = [...candidates, ...renewals].sort((a, b) => (b.evPerDollar || 0) - (a.evPerDollar || 0));
    return applyBookGuardrails(merged, book, engineParams);
  }, [candidates, renewals, book, engineParams]);
  // Recommended book = current active book + fabricated deals for each
  // sign/renew/renew-partial recommendation. Lapses drop from the projection.
  const recommendedBook = useMemo(() => {
    const active = book.filter(r => r.status === "active");
    const drops = new Set(recommendations.filter(r => r.action === "lapse").map(r => r.deal?.id));
    const kept = active.filter(r => !drops.has(r.id));
    let nid = 900;
    const signs = recommendations.filter(r => r.action === "sign").map(r => ({
      id: nid++, provider: r.vendor?.name || "New", gpu: r.gpu, gpus: r.gpus,
      structure: "reserved", rate: r.rate, termMo: r.termMo, remMo: r.termMo,
      upfrontPct: r.vendor?.prepay || 15, pay: "prepay_q", region: r.region, ic: r.fab,
      soldPct: 0, rampMo: 3, status: "active"
    }));
    return [...kept, ...signs];
  }, [book, recommendations]);
  const pnl = useMemo(() => computeScenarioPnL(recommendedBook, demandByScenario, probs, engineParams, ENGINE_HORIZON), [recommendedBook, demandByScenario, probs, engineParams]);
  // Perfect-foresight P&L per scenario: for each s, build the book that

  return (
    <div style={{ minHeight: "100vh", background: "#0b1118", color: "#e2e8f0", fontFamily: F, padding: "18px 20px 40px" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Compute Supply <span style={{ color: AMB }}>— supply book & deal intake</span></div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
            Track sourced capacity across providers, watch the roll-off ladder, and evaluate whether new vendor terms clear the bar: effective cost after prepay carry vs. resale rates that decline over the term.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>H100e basis</span>
            {[["flops", "FLOPs"], ["bw", "Mem BW"]].map(([v, l]) => (
              <button key={v} onClick={() => setNormMode(v)} style={{ background: normMode === v ? "rgba(251,191,36,0.12)" : "transparent", border: `1px solid ${normMode === v ? "rgba(251,191,36,0.4)" : "rgba(255,255,255,0.08)"}`, color: normMode === v ? AMB : "rgba(255,255,255,0.35)", borderRadius: 5, fontSize: 9, fontFamily: F, letterSpacing: "0.05em", padding: "3px 10px", cursor: "pointer" }}>{l}</button>
            ))}
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.22)" }}>
              {normMode === "flops" ? "training convention — undervalues H200's bandwidth premium for inference" : "inference-native — decode is bandwidth-bound, so H200 = 1.43× H100"}
            </span>
          </div>
        </div>

        {/* ═════════════════════════════════════════════════════════════════════
            SUMMARY STATS — moved to the top of the tab so the fleet-level view
            (composition cuts + which LLMs the supply can host) is the first
            thing visible, before drilling into the deal-level supply book.
            ═════════════════════════════════════════════════════════════════════ */}
        <SectionHeader title="Summary Stats" />

        {/* Composition of the fleet, four cuts */}
        <Section title="Fleet composition — H100e by region, provider, GPU type, contract type" style={{ marginBottom: 12 }}>
          {(() => {
            const act = book.filter(r => r.status === "active");
            const H = r => h100eOf(r, normMode) * liveFracOf(r, 1);
            const group = (keyFn) => {
              const m = {};
              for (const r of act) { const k = keyFn(r); m[k] = (m[k] || 0) + H(r); }
              return Object.entries(m).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
            };
            const contractType = r => r.structure === "ondemand" ? "On-demand" : r.structure === "spot" ? "Spot" : r.termMo >= 48 ? "5yr reserved" : r.termMo >= 30 ? "3yr reserved" : r.termMo >= 18 ? "2yr reserved" : r.termMo >= 9 ? "1yr reserved" : "<1yr reserved";
            const cuts = [
              ["By region", group(r => r.region), "#34d399"],
              ["By provider", group(r => r.provider), "#fbbf24"],
              ["By GPU type", group(r => r.gpu), "#a78bfa"],
              ["By contract type", group(contractType), "#67e8f9"],
            ];
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 18 }}>
                {cuts.map(([title, rows, color]) => {
                  const total = rows.reduce((s, r) => s + r.v, 0);
                  return (
                    <div key={title}>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>{title}</div>
                      {rows.map(r => {
                        const pct = total > 0 ? r.v / total : 0;
                        return (
                          <div key={r.k} style={{ marginBottom: 7 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: F, marginBottom: 2 }}>
                              <span style={{ color: "rgba(255,255,255,0.6)" }}>{r.k}</span>
                              <span style={{ color, fontWeight: 600 }} title={`${fmtBig(Math.round(r.v))} H100e`}>{(pct * 100).toFixed(0)}%</span>
                            </div>
                            <div style={{ height: 6, background: "rgba(255,255,255,0.04)", borderRadius: 3 }}>
                              <div style={{ height: "100%", width: `${pct * 100}%`, background: color, opacity: 0.65, borderRadius: 3 }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 6, lineHeight: 1.5 }}>
            Share of delivered H100-equivalent capacity across the active book, cut four ways. Contract-type buckets group reserved terms (≥48mo → 5yr, ≥30mo → 3yr, ≥18mo → 2yr, ≥9mo → 1yr) plus on-demand and spot. Hover a percentage to see the underlying H100e count.
          </div>
        </Section>

        {/* Model serviceability matrix */}
        <Section title="Model serviceability — which supply can host which LLMs from the Compute Demand mix" style={{ marginBottom: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: F }}>
              <thead><tr>
                <th style={th("left")}>POSITION</th>
                {dashModels.map(m => <th key={m.key} style={th("center")}>{m.label.toUpperCase()}<div style={{ fontWeight: 400, color: "rgba(255,255,255,0.2)" }}>{m.paramsB}B{m.moe ? " MoE" : ""}</div></th>)}
              </tr></thead>
              <tbody>
                {(() => {
                  const groups = {};
                  for (const r of book.filter(x => x.status === "active")) {
                    const fc = FAB_CLASS(r.ic), k = r.gpu + "|" + fc;
                    groups[k] = groups[k] || { gpu: r.gpu, fc, rows: [] };
                    groups[k].rows.push(r);
                  }
                  const order = Object.keys(SUPPLY_GPUS);
                  const fabOrder = { nvl72: 0, ib32: 1, roce: 2, eth: 3 };
                  return Object.values(groups).sort((a, b) => (order.indexOf(a.gpu) - order.indexOf(b.gpu)) || ((fabOrder[a.fc] ?? 9) - (fabOrder[b.fc] ?? 9)));
                })().map(g => {
                  const totalGpus = g.rows.reduce((s, r) => s + r.gpus, 0);
                  const freeGpus = g.rows.reduce((s, r) => s + r.gpus * liveFracOf(r, 1) * (1 - (r.soldPct || 0) / 100), 0);
                  const maxPos = Math.max(...g.rows.map(r => r.gpus));
                  const host = hostability(g.gpu, g.fc, maxPos, dashModels);
                  return (
                    <React.Fragment key={g.gpu + g.fc}>
                      <tr style={{ background: "rgba(251,191,36,0.03)" }}>
                        <td style={td({ color: "#e2e8f0", whiteSpace: "nowrap", fontWeight: 600, borderTop: "1px solid rgba(255,255,255,0.06)" })}>
                          {SUPPLY_GPUS[g.gpu].label} <span style={{ color: g.fc === "eth" ? "rgba(248,113,113,0.6)" : "#6ee7b7", fontSize: 9 }}>{FAB_LABEL[g.fc] || g.fc}</span>
                          <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 400 }}> ×{totalGpus.toLocaleString()}</span>
                          <span style={{ color: freeGpus / Math.max(totalGpus, 1) > 0.35 ? AMB : "rgba(255,255,255,0.3)", fontWeight: 400, fontSize: 9 }}> · {Math.round(freeGpus).toLocaleString()} free</span>
                        </td>
                        {host.map(h => (
                          <td key={h.key} style={td({ textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)" })} title={h.fp16 ? `FP16 · min ${h.fp16} GPU/replica${h.fp8 ? ` (FP8: ${h.fp8})` : ""}` : h.fp8 ? `FP8 only · min ${h.fp8} GPU/replica` : "does not fit within fabric pooling limit"}>
                            {h.fp16 ? <span style={{ color: "#6ee7b7", fontWeight: 700 }}>16</span> : h.fp8 ? <span style={{ color: AMB, fontWeight: 700 }}>8</span> : <span style={{ color: "rgba(255,255,255,0.12)" }}>—</span>}
                          </td>
                        ))}
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 8, lineHeight: 1.5 }}>
            Each row is a fleet capability class — GPU type × fabric — with total GPUs and free capacity across the class. 16 = servable at FP16 weights, 8 = FP8 only, — = doesn't fit; hover for min GPUs per replica. Class capability is tested at the largest single cluster in the class, since clusters at different providers can't shard one replica. Fit test: pooled usable VRAM (85% of raw, pool capped by fabric — NVL72 72, IB 32, RoCE/NVLink4 8, plain Ethernet 1) ≥ weights × 1.2 for KV + activations. MoE models load ALL experts. Model set is the LLM mix on the Compute Demand tab — edit that table to change the columns here.
          </div>
        </Section>

        {/* Chip mix vs. workload mix — pool balance + per-chip $-efficiency.
            Sits as the last box in Summary Stats: same fleet-level view as
            Fleet Composition, but cut by workload-fit (compute vs. inference
            pool) rather than by region/provider/GPU/contract. */}
        <Section title="Chip mix vs. workload mix — pool balance & per-chip $-efficiency" style={{ marginBottom: 12 }}>
          {(() => {
            const act = book.filter(r => r.status === "active");
            const CROSS = 0.7; // off-pool capacity penalty, mirrors Projections engine
            const poolsAt = (m) => {
              const p = { compute: 0, balanced: 0, inference: 0 };
              for (const r of act) p[POOL_OF(r.gpu)] += h100eOf(r, normMode) * liveFracOf(r, m);
              return p;
            };
            const match = (p, dTrain, dInf) => {
              let sT = Math.min(dTrain, p.compute), sI = Math.min(dInf, p.inference);
              let nT = dTrain - sT, nI = dInf - sI, bal = p.balanced;
              const tot = nT + nI;
              if (tot > 0 && bal > 0) { const u = Math.min(bal, tot); sT += u * nT / tot; sI += u * nI / tot; nT -= u * nT / tot; nI -= u * nI / tot; bal -= u; }
              let cross = 0;
              const idleC = Math.max(0, p.compute - Math.min(dTrain, p.compute)), idleI = Math.max(0, p.inference - Math.min(dInf, p.inference));
              if (nT > 0 && idleI > 0) { const c = Math.min(nT, idleI * CROSS); sT += c; nT -= c; cross += c; }
              if (nI > 0 && idleC > 0) { const c = Math.min(nI, idleC * CROSS); sI += c; nI -= c; cross += c; }
              return { short: nT + nI, cross, natInfCover: dInf > 0 ? Math.min(1, p.inference / dInf) : 1 };
            };
            const views = [
              { lbl: "Today", pools: poolsAt(1), dT: demSeries.train[0] || 0, dI: demSeries.inf[0] || 0 },
              { lbl: "Month 12", pools: poolsAt(12), dT: demSeries.train[11] || 0, dI: demSeries.inf[11] || 0 },
            ];
            const barRow = (label, segs, total) => (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, fontFamily: F, marginBottom: 3 }}>
                  <span style={{ color: "rgba(255,255,255,0.45)" }}>{label}</span>
                  <span style={{ color: "rgba(255,255,255,0.55)" }}>{fmtBig(Math.round(total))} H100e</span>
                </div>
                <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.03)" }}>
                  {segs.filter(s => s.v > 0).map(s => (
                    <div key={s.k} title={`${s.k}: ${fmtBig(Math.round(s.v))} H100e (${(s.v / Math.max(total, 1) * 100).toFixed(0)}%)`}
                      style={{ width: `${s.v / Math.max(total, 1) * 100}%`, background: s.color, opacity: 0.75, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {s.v / total > 0.12 && <span style={{ fontSize: 7.5, fontWeight: 700, color: "#0b1118", fontFamily: F }}>{s.k.toUpperCase()}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );

            const chips = Object.keys(SUPPLY_GPUS);
            const trainEff = k => (SUPPLY_GPUS[k].tflops / SUPPLY_GPUS[k].market) / (SUPPLY_GPUS.H100.tflops / SUPPLY_GPUS.H100.market);
            const infEff = k => (SUPPLY_GPUS[k].bw / SUPPLY_GPUS[k].market) / (SUPPLY_GPUS.H100.bw / SUPPLY_GPUS.H100.market);
            const trainH = Math.round(demSeries.train[0] || 0), infH = Math.round(demSeries.inf[0] || 0), totH = Math.max(1, trainH + infH);
            const rows = chips.map(k => ({ k, g: SUPPLY_GPUS[k], train: trainEff(k), inf: infEff(k) })).sort((a, b) => Math.max(b.train, b.inf) - Math.max(a.train, a.inf));
            const bestTrain = rows.reduce((m, r) => r.train > m.train ? r : m, rows[0]);
            const bestInf = rows.reduce((m, r) => r.inf > m.inf ? r : m, rows[0]);

            const subHeading = (txt) => (
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", fontWeight: 600, fontFamily: F, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>{txt}</div>
            );

            return (
              <>
                {subHeading("Pool balance — is the fleet mix right for the workload mix?")}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
                  {views.map(v => {
                    const supTot = v.pools.compute + v.pools.balanced + v.pools.inference;
                    const demTot = v.dT + v.dI;
                    const mm = match(v.pools, v.dT, v.dI);
                    return (
                      <div key={v.lbl}>
                        <div style={{ fontSize: 10, color: "#e2e8f0", fontWeight: 700, fontFamily: F, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{v.lbl}</div>
                        {barRow("Supply by pool", [
                          { k: "compute", v: v.pools.compute, color: POOL_META.compute.color },
                          { k: "balanced", v: v.pools.balanced, color: POOL_META.balanced.color },
                          { k: "inference", v: v.pools.inference, color: POOL_META.inference.color },
                        ], supTot)}
                        {barRow("Demand by workload", [
                          { k: "training", v: v.dT, color: POOL_META.compute.color },
                          { k: "inference", v: v.dI, color: POOL_META.inference.color },
                        ], demTot)}
                        <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.45)", fontFamily: F, lineHeight: 1.55, marginTop: 4 }}>
                          Inference pool covers <span style={{ color: POOL_META.inference.color, fontWeight: 700 }}>{fmtPct(mm.natInfCover)}</span> of inference demand natively; the rest rides the balanced reservoir.
                          {mm.cross > 0.5 && <span style={{ color: AMB }}> ⚠ {fmtBig(Math.round(mm.cross))} H100e cross-served off-pool at 30% capacity loss — wrong chips for the workload.</span>}
                          {mm.short > 0.5 ? <span style={{ color: "#f87171" }}> ⚠ {fmtBig(Math.round(mm.short))} H100e SHORT even after cross-serving.</span> : mm.cross <= 0.5 ? <span style={{ color: "#6ee7b7" }}> Mix is clean — no forced cross-serving.</span> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "20px 0 16px" }} />

                {subHeading("Per-chip $-efficiency — which GPU fits which workload")}
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                    <thead><tr>
                      <th style={th("left")}>GPU</th><th style={th()}>BF16 TFLOPS</th><th style={th()}>MEM BW TB/s</th><th style={th()}>MKT $/HR</th>
                      <th style={th()}>TRAINING $-EFF</th><th style={th()}>INFERENCE $-EFF</th><th style={th("left")}>BEST FOR</th>
                    </tr></thead>
                    <tbody>
                      {rows.map(r => {
                        const lean = r.train > r.inf * 1.05 ? "training" : r.inf > r.train * 1.05 ? "inference" : "either";
                        return (
                          <tr key={r.k}>
                            <td style={td({ color: "#e2e8f0", fontWeight: 600 })}>{r.g.label}</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{r.g.tflops.toLocaleString()}</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{r.g.bw.toFixed(2)}</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{fmtUSD(r.g.market, 2)}</td>
                            <td style={td({ textAlign: "right", color: r.k === bestTrain.k ? "#c4b5fd" : "rgba(255,255,255,0.55)", fontWeight: r.k === bestTrain.k ? 700 : 400 })}>{r.train.toFixed(2)}×</td>
                            <td style={td({ textAlign: "right", color: r.k === bestInf.k ? "#67e8f9" : "rgba(255,255,255,0.55)", fontWeight: r.k === bestInf.k ? 700 : 400 })}>{r.inf.toFixed(2)}×</td>
                            <td style={td({ color: lean === "training" ? "#c4b5fd" : lean === "inference" ? "#67e8f9" : "rgba(255,255,255,0.4)", fontSize: 10 })}>{lean}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 10, lineHeight: 1.6 }}>
                  Pools classified by FLOPs:bandwidth ratio vs H100 — <span style={{ color: POOL_META.compute.color }}>compute</span> (&gt; 1.15, training), <span style={{ color: POOL_META.inference.color }}>inference</span> (&lt; 0.87, decode), <span style={{ color: POOL_META.balanced.color }}>balanced</span> (H100, B200 — usable either way). Matching mirrors the Projections engine: native pools first, balanced pro-rata, then off-pool cross-serve at 30% capacity loss. <span style={{ color: "#c4b5fd" }}>Training $-eff</span> = TFLOPs ÷ $/hr (raw FLOPs bottleneck); <span style={{ color: "#67e8f9" }}>inference $-eff</span> = memory BW ÷ $/hr (decode streams weights + KV per token) — both normalized to H100 = 1.00×. Buy-side rule: size reserved compute-dense capacity to the {fmtPct(trainH / totH)} training share and bandwidth-dense capacity to the {fmtPct(infH / totH)} inference share; re-check as the Compute Demand baselines shift.
                </div>
              </>
            );
          })()}
        </Section>

        <SectionHeader title="Supply Book" />

        {/* Book aggregates */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <Metric label="Fleet under mgmt" value={fmtBig(agg.totalGpus)} sub={`${fmtBig(agg.totalH100e)} H100e · ${fmtBig(agg.rsvGpus)} rsv · ${fmtBig(agg.odGpus)} OD · ${fmtBig(agg.spotGpus)} spot${agg.undelivered > 0.5 ? ` · ${fmtBig(Math.round(agg.undelivered))} in delivery` : ""}`} accent={AMB} />
          <Metric label="Blended cost" value={fmtUSD(agg.blended, 2) + "/H100e-hr"} sub={`${normMode === "bw" ? "BW" : "FLOP"}-weighted · raw ${fmtUSD(agg.blendedGpu, 2)}/GPU-hr`} />
          <Metric label="Committed / month" value={fmtUSD(agg.committedMonthly)} sub="reserved contracts only" />
          <Metric label="Committed remaining" value={fmtUSD(agg.committedRemaining)} sub="total obligation to term end" />
          <Metric label="Prepaid outstanding" value={fmtUSD(agg.prepaidOut)} sub="unamortized vendor prepay" warn={agg.prepaidOut > agg.committedMonthly * 3} />
          <Metric label="Unused capacity" value={fmtBig(Math.round(agg.freeGpus))} sub={`${fmtBig(Math.round(agg.freeH100e))} H100e unused · ${fmtPct(agg.totalGpus > 0 ? agg.freeGpus / agg.totalGpus : 0)} of fleet`} warn={agg.totalGpus > 0 && agg.freeGpus / agg.totalGpus > 0.35} />
          <Metric label="Wtd. remaining term" value={agg.wTerm.toFixed(1) + " mo"} sub={`${normMode === "bw" ? "BW" : "FLOP"}-weighted, reserved book`} />
        </div>

        {/* Supply book table + expiry ladder */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 12, marginBottom: 12 }}>
          <Section title="Supply book">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: F }}>
                <thead><tr>
                  {(() => {
                    const cols = [
                      { k: "provider",   label: "PROVIDER",    align: "left"  },
                      { k: "gpu",        label: "GPU",         align: "left"  },
                      { k: "gpus",       label: "QTY",         align: "right" },
                      { k: "structure",  label: "STRUCT",      align: "left"  },
                      { k: "rate",       label: "$/GPU-HR",    align: "right" },
                      { k: "normRate",   label: "$/H100e-HR",  align: "right" },
                      { k: "termMo",     label: "TERM",        align: "right" },
                      { k: "remMo",      label: "LEFT",        align: "right" },
                      { k: "upfrontPct", label: "UPFRONT",     align: "right" },
                      { k: "pay",        label: "PAY",         align: "left"  },
                      { k: "region",     label: "REGION",      align: "left"  },
                      { k: "ic",         label: "FABRIC",      align: "left"  },
                      { k: "status",     label: "STATUS",      align: "left"  },
                    ];
                    return cols.map(c => {
                      const active = sortBy.key === c.k;
                      const arrow = active ? (sortBy.dir === "asc" ? " ▲" : " ▼") : "";
                      return (
                        <th key={c.k}
                            onClick={() => toggleSort(c.k)}
                            title={c.k === "normRate" ? `raw $/GPU-hr ÷ (${normMode === "bw" ? "BW" : "FLOPs"} vs H100)` : "click to sort"}
                            style={{ ...th(c.align), cursor: "pointer", userSelect: "none", color: active ? AMB : "rgba(255,255,255,0.25)" }}>
                          {c.label}{arrow}
                        </th>
                      );
                    });
                  })()}
                  <th style={th()}></th>
                </tr></thead>
                <tbody>
                  {sortedBook.map(r => (
                    <tr key={r.id} style={{ opacity: r.status === "pending" ? 0.55 : 1 }}>
                      <td style={td({ color: "#e2e8f0", whiteSpace: "nowrap" })}>{r.provider}<CmaxBadge provider={r.provider} /></td>
                      <td style={td({ color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap" })}>{SUPPLY_GPUS[r.gpu] ? SUPPLY_GPUS[r.gpu].label.split(" ")[0] : r.gpu}<PoolChip gpu={r.gpu} /></td>
                      <td style={td({ textAlign: "right", color: "#e2e8f0", fontWeight: 600 })}>{r.gpus.toLocaleString()}</td>
                      <td style={td({ color: structColor(r.structure), fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" })}>{structTag(r.structure)}</td>
                      <td style={td({ textAlign: "right", color: AMB })}>{fmtUSD(r.rate, 2)}</td>
                      <td style={td({ textAlign: "right", color: "rgba(251,191,36,0.65)" })} title={`normalized by ${normMode === "bw" ? "memory bandwidth" : "FLOPs"} vs H100`}>{fmtUSD(normRateOf(r), 2)}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>{r.termMo > 0 ? r.termMo + "mo" : "—"}</td>
                      <td style={td({ textAlign: "right", color: r.remMo > 0 && r.remMo <= 3 ? "#f87171" : "rgba(255,255,255,0.5)" })}>{r.termMo > 0 ? r.remMo + "mo" : "—"}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>{r.upfrontPct > 0 ? r.upfrontPct + "%" : "—"}</td>
                      <td style={td({ color: "rgba(255,255,255,0.45)", fontSize: 10 })}>{(PAY_TERMS.find(p => p.value === r.pay) || {}).label?.split(" (")[0]}</td>
                      <td style={td({ color: "rgba(255,255,255,0.45)", fontSize: 10 })}>{r.region}</td>
                      <td style={td({ color: r.ic === "nvl72" ? "#c4b5fd" : (r.ic === "ib32" || r.ic === "ib16") ? "#6ee7b7" : "rgba(255,255,255,0.45)", fontSize: 10 })}>{({ nvl72: "NVL72", ib32: "IB NDR", ib16: "IB XDR", roce: "RoCE", eth: "Eth" }[r.ic]) || r.ic}</td>
                      <td style={td()}>
                        <button onClick={() => toggleStatus(r.id)} style={{ background: "none", border: `1px solid ${r.status === "active" ? "rgba(110,231,183,0.3)" : "rgba(251,191,36,0.3)"}`, color: r.status === "active" ? "#6ee7b7" : AMB, borderRadius: 4, fontSize: 8, fontFamily: F, letterSpacing: "0.06em", padding: "2px 6px", cursor: "pointer" }}>{r.status.toUpperCase()}</button>
                      </td>
                      <td style={td({ textAlign: "right" })}>
                        <button onClick={() => removeRow(r.id)} style={{ background: "none", border: "none", color: "rgba(248,113,113,0.5)", cursor: "pointer", fontSize: 11, fontFamily: F }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 8 }}>
              RSV = contracted/reserved (paid whether sold or not) · OD = pay-per-use upstream · SPOT = interruptible. $/H100e-HR = raw $/GPU-hr normalized by the row's H100-relative {normMode === "bw" ? "memory-bandwidth" : "FLOPs"} ratio (toggle basis in the header above) — makes rates comparable across chip generations. Click any column header to sort (click again to flip direction). Rows marked PENDING are logged deals not yet signed and are excluded from aggregates. ✕ removes a row.
            </div>
          </Section>

          <Section title="Reserved capacity by month — stacked by region">
            <svg viewBox="0 0 232 160" style={{ width: "100%", height: "auto" }}>
              {(() => {
                const W = 232, H = 160, P = { t: 14, r: 2, b: 24, l: 2 };
                const pw = W - P.l - P.r, ph = H - P.t - P.b;
                const n = agg.buckets.length;
                const gap = pw / n, bw = gap * 0.68;
                const maxV = Math.max(...agg.buckets.map(b => b.h100e), 1);
                return <>
                  <line x1={P.l} x2={W - P.r} y1={P.t + ph} y2={P.t + ph} stroke="rgba(255,255,255,0.1)" />
                  {agg.buckets.map((b, i) => {
                    const x = P.l + gap * i + (gap - bw) / 2;
                    // A month where capacity steps down from the prior month is a cliff.
                    const cliff = i > 0 && b.h100e < agg.buckets[i - 1].h100e - 0.5;
                    let yCursor = P.t + ph;
                    const segs = REGIONS.filter(rg => b.byRegion[rg] > 0).map(rg => {
                      const h = (b.byRegion[rg] / maxV) * ph;
                      yCursor -= h;
                      return { rg, h, y: yCursor };
                    });
                    const topY = segs.length ? segs[segs.length - 1].y : P.t + ph;
                    return <g key={b.label}>
                      {segs.map(s => (
                        <rect key={s.rg} x={x} y={s.y} width={bw} height={Math.max(s.h, 1)} fill={REGION_COLORS[s.rg] || "#94a3b8"} opacity={0.85}>
                          <title>{`${b.label} · ${s.rg}: ${fmtBig(Math.round(b.byRegion[s.rg]))} H100e under contract`}</title>
                        </rect>
                      ))}
                      {b.h100e > 0 && <text x={x + bw / 2} y={topY - 3} textAnchor="middle" fontSize={6.5} fontWeight={600} fill={cliff ? "#f87171" : "#e2e8f0"} fontFamily={F}>{fmtBig(Math.round(b.h100e))}</text>}
                      {(i % 2 === 0) && <text x={x + bw / 2} y={P.t + ph + 10} textAnchor="middle" fontSize={6.2} fill="rgba(255,255,255,0.35)" fontFamily={F}>{b.label}</text>}
                    </g>;
                  })}
                  <text x={P.l + pw / 2} y={H - 3} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.25)" fontFamily={F}>reserved capacity under contract, next 12 months</text>
                </>;
              })()}
            </svg>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", marginTop: 6 }}>
              {REGIONS.filter(rg => agg.buckets.some(b => b.byRegion[rg] > 0)).map(rg => (
                <span key={rg} style={{ fontSize: 8.5, color: "rgba(255,255,255,0.45)", fontFamily: F, display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 2, background: REGION_COLORS[rg] || "#94a3b8", display: "inline-block" }} />{rg}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 8, lineHeight: 1.5 }}>
              Each bar is the H100-equivalent reserved compute still under contract AND delivered in that month (ramping positions grow into their bars), stacked by region (hover for detail; totals in red mark step-downs from the prior month). Where a color band ends, that region's capacity is gone — a renewal decision is due before that month arrives, and demand pinned to the region (data residency, latency) strands even if other regions still show supply.
            </div>
          </Section>
        </div>

        {/* ═════════════════════════════════════════════════════════════
            SUPPLY-FILLING ENGINE
            Replaces the prior Deal Evaluation / Commitment Ladder / Supply
            Policy sections. Every quantity below is computed per scenario;
            EV weights by P(s); solvency gates read the WEAK column alone.
            ═════════════════════════════════════════════════════════════ */}
        <SectionHeader title="Supply Filling Engine" />

        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 12, lineHeight: 1.55 }}>
          Scenario-driven vendor-commit optimizer. Reads the weak/base/strong cohort demand builds from the Compute Demand tab as CORRELATED states of the world (one coherent "weak future" applied across all cohorts — the tail is real, not the intersection of independent worst cases). Reports ONE recommended book of sign / renew / lapse decisions, scored on expected profit and gated on weak-case solvency. The six stages below describe the flow from demand to recommendation.
        </div>

        {/* How the engine works — six-box explainer laid out as an explicit
            3×2 grid (rather than auto-fit) so the six stages always sit in
            two neat rows with the same three columns per row. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
          {[
            {
              stage: "1 · Aggregate demand & supply",
              items: [
                "Read the weak/base/strong cohort demand curves from the Compute Demand tab. Overlay explicit committed positions from the demand book.",
                "Distribute each scenario's monthly demand across (chip · fabric · region) buckets: inference routed by model mix to the cheapest capable chip; training routed across capability tiers.",
                "Aggregate your supply book into the same bucket grid — reserved capacity, OD, and spot each tracked separately.",
              ],
            },
            {
              stage: "2 · Capability cascade",
              items: [
                "Before declaring any gap, let idle higher-capability supply flow DOWN to unmet lower-capability demand: H200 can serve H100 workloads; IB fabric can serve RoCE workloads; NA supply can serve compatible NA regions.",
                "Substitution is priced at the WORKLOAD's rate, not the chip's — serving H100 demand on B200 books H100-class revenue, not 2.3× revenue.",
                "A 'gap' is only what remains AFTER the cascade. Prevents recommending H100 buys while idle H200 exists.",
              ],
            },
            {
              stage: "3 · Commit level per bucket (critical-fractile rule)",
              items: [
                "For each bucket, compute the fractile ratio = loss-if-idle / (loss-if-idle + save-if-used). Loss-if-idle = reserved rate − salvage; save-if-used = OD upstream − reserved rate.",
                "Commit through the highest demand level D where P(demand ≥ D) ≥ fractile ratio. Splits into SAFE (weak-covered floor), LADDER (weak → commit), and FLEX (above commit — never pre-commit).",
                "Low fractile (H100/H200, liquid salvage) → commit through base. High fractile (B300 rack-scale, thin salvage) → commit through weak.",
              ],
            },
            {
              stage: "4 · Candidate deals & vendor picks",
              items: [
                "For each bucket where commit level > current supply, generate two candidate deals: a SAFE tranche (sign now, sized to weak) and a LADDER tranche (sign at month 6 if base trajectory confirms).",
                "Rotate vendors across buckets to avoid concentrating all recommendations on one operator. Vendor rate scales with ClusterMAX tier (Platinum +6%, Gold +3%).",
                "Score each candidate under every scenario: term profit under weak, base, and strong; EV = probability-weighted average; EV / $ PREPAID = capital efficiency (primary ranking).",
              ],
            },
            {
              stage: "5 · Gates & guardrails",
              items: [
                "SAFE gate: the sign-today tranche must show positive margin under the WEAK scenario. It's a solvency floor — if it doesn't clear at weak, one bad quarter puts you underwater on that deal.",
                "LADDER gate: the trigger-signed tranche is evaluated at BASE-case margin instead. The mo-6 trigger already filters out the weak tail (you only sign if actuals confirm base), so gating on weak would be double-counting the risk.",
                "Portfolio checks (any one flips the candidate to DECLINE, or a renewal to LAPSE): no single vendor above 40% of the book once the book exceeds 2,000 GPUs, cumulative prepaid cash outstanding within the ARR cap set below, cumulative committed spend (existing reserved contract value + all new sign / ladder / renew tranches) within the total-spend cap — the balance-sheet solvency ceiling — no Bronze operator carrying more than 10% of ARR in prepay, and no plain-Ethernet fabric under a training-class chip.",
              ],
            },
            {
              stage: "6 · Renewals, lapses, and scenario P&L",
              items: [
                "Constraint on renewals: reserved contracts are take-or-pay AND fixed-size — you can't renew for fewer GPUs than the original. The only lever is TERM LENGTH: full renew, half-term renew, or lapse. So the question isn't 'renew what we can,' it's 'commit to this fixed size for how long?'",
                "The rule at each expiry: RENEW full-term if weak-case demand still covers ≥80% of the position (you'd use most of it every month, even in the bad scenario). RENEW ½-term if weak covers only 30-80% — the shorter commit caps how long you're stuck paying for idle GPUs if weakness persists. LAPSE if even the base case can't fill 20% — better to release the take-or-pay and re-source at spot/OD when demand actually shows up (variable cost beats fixed cost when you'd carry mostly idle capacity).",
                "Then the recommended book (seed + SIGNs + RENEWs − LAPSEs) is played through each scenario: revenue, cash cost, prepay carry, forfeit cost, net margin per scenario, and the probability-weighted average as EV NET MARGIN — the number the engine maximizes, subject to the weak-case gate.",
              ],
            },
          ].map(st => (
            <div key={st.stage} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.6)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 7, fontFamily: F }}>{st.stage}</div>
              {st.items.map((it, i) => (
                <div key={i} style={{ display: "flex", gap: 6, fontSize: 9.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.5, marginBottom: 5, fontFamily: F }}>
                  <span style={{ color: AMB, flexShrink: 0 }}>·</span>
                  <span>{it}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* ── Engine parameter controls (scenario probabilities live on the
             Compute Demand tab alongside the weak/base/strong toggle — one
             surface for "what future are we in?") ── */}
        <Section title="Engine parameters" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", marginBottom: 10, fontFamily: F }}>
            Scenario probabilities: {["weak","base","strong"].map((s, i) => (
              <span key={s}>{i > 0 && " · "}<span style={{ color: DEMAND_SCENARIO_DEFS[s].color, fontWeight: 700 }}>{DEMAND_SCENARIO_DEFS[s].label} {((probs[s]||0)*100).toFixed(0)}%</span></span>
            ))} <span style={{ color: "rgba(255,255,255,0.3)" }}>— edit on the Compute Demand tab, next to the scenario toggle</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18 }}>
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Salvage / liquidity per chip <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— fraction of spot ref recoverable if idle. Moves the commit level more than any other parameter.</span></div>
              {Object.keys(salvage).map(k => (
                <Slider key={k} label={`${SUPPLY_GPUS[k]?.label.split(" ")[0] || k} (spot ref ${fmtUSD(SUPPLY_GPUS[k]?.spotRef||0, 2)}/hr)`} value={Math.round(salvage[k]*100)} onChange={setSalvageFor(k)} min={0} max={100} step={5} fmtFn={v => v + "% → " + fmtUSD((SUPPLY_GPUS[k]?.spotRef||0) * (v/100), 2) + "/hr"} />
              ))}
            </div>
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Book-level guardrails <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— risk limits that gate individual deals before they can enter the book. A candidate that clears all its per-deal economics can still be flipped to DECLINE if signing it would push the book across one of these thresholds. Move these to loosen or tighten how much stranding risk, capital, or vendor concentration you're willing to run.</span></div>
              <Slider label="Weak-case util floor" value={weakUtilFloor} onChange={setWeakUtilFloor} min={0} max={80} step={5} fmtFn={v => v + "%"} hint={`stranding-risk gate: a new deal must have at least ${weakUtilFloor}% of its capacity actually filled under the WEAK scenario, or it's declined. A deal can be profitable-per-hour at low utilization and still be a bad capital deployment (paying take-or-pay on mostly-idle GPUs). Raising this makes the engine only sign deals it's highly confident will fill; lowering it lets speculative bets through.`} />
              <Slider label="Annualized revenue baseline" value={arrRunM} onChange={setArrRunM} min={100} max={2000} step={50} fmtFn={v => "$" + v + "M"} hint={`your platform's current run-rate revenue (approximate). Used purely as a size reference — the prepaid cap below is expressed as a % of this number, so a $${arrRunM}M ARR business with a ${prepaidCapPct}% cap can have up to $${(arrRunM * prepaidCapPct / 100).toFixed(0)}M outstanding in prepaid deposits. Set this to what your CFO reports for ARR.`} />
              <Slider label="Prepaid capital cap" value={prepaidCapPct} onChange={setPrepaidCapPct} min={5} max={40} step={1} fmtFn={v => v + "% of ARR"} hint={`liquidity-risk gate: caps the total prepaid cash we can have outstanding across ALL active reserved contracts at ${prepaidCapPct}% of ARR (${"$"+(arrRunM * prepaidCapPct / 100).toFixed(0)}M today). Each candidate deal's upfront cash is added to the running total; the first deal that would breach the cap is declined. Prevents the book from turning into a working-capital sink where a downturn traps too much cash in take-or-pay commitments.`} />
              <Slider label="Total-spend cap" value={totalSpendCapM} onChange={setTotalSpendCapM} min={100} max={5000} step={50} fmtFn={v => "$" + v.toLocaleString() + "M"} hint={`solvency gate on the balance sheet as a whole: caps CUMULATIVE committed spend — existing reserved book (contract value to term end, ramp-adjusted) + every new sign / ladder / renew tranche — at $${totalSpendCapM.toLocaleString()}M. Distinct from the prepaid cap: prepaid limits cash already out the door, this limits total contractual obligation (take-or-pay you'd owe even if revenue vanished tomorrow). Signs and ladders that trip ONLY this gate get downgraded to DEFER — the engine finds the earliest future month where existing positions have rolled off enough to admit the deal under the cap, and recommends signing then. If no month within 24 mo works (or another gate also fails), the deal becomes DECLINE. Renewals that would breach are downgraded to LAPSE. Set this to what the CFO / board considers the maximum defensible compute obligation for the business — a soft version of "how much can we go into the hole before we go bankrupt."`} />
              <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)", fontFamily: F, marginTop: 4, lineHeight: 1.5 }}>
                Two other portfolio checks are hard-coded (not sliders): no single vendor {'>'}40% of the projected book once the book exceeds 2,000 GPUs (concentration risk), and no plain Ethernet on a training-class chip (multi-node training doesn't work over standard Ethernet). Cost of capital ({wacc}%/yr) and market decline ({mktDecline}%/yr) also feed the engine — set on the Compute Supply tab.
              </div>
            </div>
          </div>
        </Section>

        {/* ── Gap map: (gpu × region) × month, colored by weak/base/strong gap ── */}
        <Section title="Gap map — post-cascade unmet demand by (chip · fabric · region) × month" style={{ marginBottom: 12 }}>
          {(() => {
            const months = ENGINE_HORIZON;
            const cascade = cascadeByScenario.base;
            // Calendar month labels (M/YY) starting from the current month —
            // m1 = this month, m2 = next month, etc.
            const now = new Date();
            const mLabel = (i) => {
              const mo = ((now.getMonth() + i) % 12) + 1;
              const yr = (now.getFullYear() + Math.floor((now.getMonth() + i) / 12)) % 100;
              return `${mo}/${String(yr).padStart(2, "0")}`;
            };
            const keys = Object.keys(cascade).sort((a, b) => {
              const [ga, , ra] = a.split("|"), [gb, , rb] = b.split("|");
              return (capRank(ga) - capRank(gb)) || (ra.localeCompare(rb));
            });
            const rows = keys.filter(k => {
              const c = cascade[k];
              return c.demBucket && c.demBucket.total.some(v => v > 5);
            });
            // Max gap across ALL scenarios for consistent color scaling
            const maxGap = Math.max(1,
              ...rows.map(k => Math.max(
                Math.max(...(cascadeByScenario.weak[k]?.gap || [0])),
                Math.max(...(cascade[k]?.gap || [0])),
                Math.max(...(cascadeByScenario.strong[k]?.gap || [0])),
              ))
            );
            return (
              <>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: F, fontSize: 9, tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "22%" }} />
                    {Array.from({ length: months }).map((_, i) => <col key={i} style={{ width: `${78 / months}%` }} />)}
                  </colgroup>
                  <thead><tr>
                    <th style={{ ...th("left"), padding: "2px 6px" }}>BUCKET (chip · fabric · region)</th>
                    {Array.from({ length: months }).map((_, i) => <th key={i} style={{ padding: "2px 0", color: "rgba(255,255,255,0.25)", fontSize: 7.5, textAlign: "center", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>{mLabel(i)}</th>)}
                  </tr></thead>
                  <tbody>
                    {rows.map(k => {
                      const c = cascade[k];
                      const wc = cascadeByScenario.weak[k] || {};
                      const sc = cascadeByScenario.strong[k] || {};
                      const anyWeakGap = (wc.gap || []).some(v => v > 5);
                      return (
                        <tr key={k}>
                          <td style={{ padding: "2px 6px", color: anyWeakGap ? "#f87171" : "#e2e8f0", whiteSpace: "nowrap", fontSize: 9.5, fontFamily: F, overflow: "hidden", textOverflow: "ellipsis" }}>
                            <span style={{ fontWeight: 600 }}>{SUPPLY_GPUS[c.gpu]?.label.split(" ")[0] || c.gpu}</span>
                            <span style={{ color: "rgba(255,255,255,0.45)" }}> · {c.fab}</span>
                            <span style={{ color: "rgba(255,255,255,0.55)" }}> · {c.region}</span>
                            {anyWeakGap && <span style={{ marginLeft: 6, fontSize: 8, background: "rgba(248,113,113,0.15)", color: "#f87171", padding: "1px 5px", borderRadius: 3, letterSpacing: "0.05em" }}>CRITICAL</span>}
                          </td>
                          {Array.from({ length: months }).map((_, i) => {
                            const wg = (wc.gap && wc.gap[i]) || 0;
                            const bg = (c.gap && c.gap[i]) || 0;
                            const sg = (sc.gap && sc.gap[i]) || 0;
                            let col = "rgba(255,255,255,0.02)";
                            if (wg > 5) col = `rgba(248,113,113,${0.18 + 0.72 * Math.min(1, wg / maxGap)})`;
                            else if (bg > 5) col = `rgba(251,191,36,${0.15 + 0.6 * Math.min(1, bg / maxGap)})`;
                            else if (sg > 5) col = `rgba(103,232,249,${0.10 + 0.4 * Math.min(1, sg / maxGap)})`;
                            const title = `${c.gpu} · ${c.fab} · ${c.region} · ${mLabel(i)}\nweak gap: ${fmtBig(Math.round(wg))} H100e\nbase gap: ${fmtBig(Math.round(bg))} H100e\nstrong gap: ${fmtBig(Math.round(sg))} H100e`;
                            return <td key={i} title={title} style={{ padding: 1 }}><div style={{ width: "100%", height: 14, background: col, borderRadius: 2 }} /></td>;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 14, marginTop: 10, alignItems: "center", flexWrap: "wrap", fontSize: 9.5, fontFamily: F }}>
                  <span style={{ color: "rgba(255,255,255,0.35)" }}>Cell color =</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 12, background: "rgba(248,113,113,0.55)", borderRadius: 2 }} /><span style={{ color: "#f87171" }}>gap appears in WEAK (critical — a real shortfall)</span></span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 12, background: "rgba(251,191,36,0.45)", borderRadius: 2 }} /><span style={{ color: AMB }}>gap only in BASE (structural)</span></span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 12, background: "rgba(103,232,249,0.35)", borderRadius: 2 }} /><span style={{ color: "#67e8f9" }}>gap only in STRONG (upside)</span></span>
                </div>
                <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)", marginTop: 8, lineHeight: 1.6 }}>
                  Each cell reads the unmet H100-equivalent demand in that <b>chip · fabric · region</b> bucket for that month, AFTER the capability cascade has run — i.e., after any idle higher-capability supply has already been reallocated to cover compatible lower-capability workloads (chip cap ≥ requirement, fabric class ≥ requirement, region substitution allowed). So what shows up here is a genuine hole in the book, not a bucket-level accounting artifact. Color reads severity: <b style={{ color: "#f87171" }}>red</b> = the gap is present even in the weak scenario, meaning it's a real shortfall to pre-fill; <b style={{ color: AMB }}>amber</b> = only present in base, structural but softer; <b style={{ color: "#67e8f9" }}>cyan</b> = only present in strong, upside to chase with on-demand/spot rather than pre-commit. Rows with any weak-case gap are flagged CRITICAL. Hover a cell for weak/base/strong numbers.
                </div>
              </>
            );
          })()}
        </Section>

        {/* ── Commit-level readout per bucket ── */}
        <Section title="Commit level per bucket — how much capacity to buy, per (chip · fabric · region)" style={{ marginBottom: 12 }}>
          {(() => {
            // Sort by chip capability, then fabric class, then region name —
            // groups related buckets together so B300s sit next to each other
            // etc. and it's easy to scan a chip family across regions.
            const rows = Object.values(commitLevels)
              .filter(cl => (cl.strongD || 0) > 5)
              .sort((a, b) =>
                (capRank(a.gpu) - capRank(b.gpu))
                || ((FAB_RANK[b.fab] || 0) - (FAB_RANK[a.fab] || 0))
                || a.region.localeCompare(b.region)
              );
            return (
              <>
                <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 420, border: "1px solid rgba(255,255,255,0.04)", borderRadius: 4 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                    <thead style={{ position: "sticky", top: 0, background: "#0f172a", zIndex: 1 }}><tr>
                      <th style={{ ...th("left"), background: "#0f172a" }}>BUCKET (chip · fabric · region)</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="representative reserved $/GPU-hr for this bucket (blended anchor from the supply book, or 75% of on-demand as a default). The engine sweeps per-term rates internally when scoring candidate deals — this column is just the fractile anchor.">RESERVED $/HR</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="on-demand upstream $/GPU-hr — what you'd pay if you didn't commit">OD $/HR</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="salvage $/GPU-hr — what you can recover on secondary market if the GPU sits idle">SALVAGE $/HR</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="fractile ratio = loss-if-idle / (loss-if-idle + save-if-used). The newsvendor critical fractile: commit up to the demand level D where P(demand ≥ D) ≥ fractile.">FRACTILE RATIO</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="weak-case demand at the reference window (m6-m18 average) — the safe floor">WEAK D</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="base-case demand at the reference window">BASE D</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="strong-case demand at the reference window">STRONG D</th>
                      <th style={{ ...th(), background: "#0f172a" }} title="fractile-implied commit level — snapped to the largest scenario D such that P(D ≥ D) ≥ fractile (strict discrete newsvendor)">COMMIT</th>
                      <th style={{ ...th("left"), background: "#0f172a" }} title="tranche decomposition: SIGN = weak-covered floor (safe today), LADDER = commit − weak (trigger-signed), FLEX = strong − commit (never committed)">SIGN · LADDER · FLEX</th>
                    </tr></thead>
                    <tbody>
                      {rows.map(cl => (
                        <tr key={cl.gpu + cl.fab + cl.region}>
                          <td style={td({ color: "#e2e8f0", whiteSpace: "nowrap" })}>
                            <span style={{ fontWeight: 600 }}>{SUPPLY_GPUS[cl.gpu]?.label.split(" ")[0] || cl.gpu}</span>
                            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 9.5 }}> · {cl.fab} · {cl.region}</span>
                          </td>
                          <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{fmtUSD(cl.reservedRate, 2)}</td>
                          <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{fmtUSD(cl.odRate, 2)}</td>
                          <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{fmtUSD(cl.salvage, 2)}</td>
                          <td style={td({ textAlign: "right", color: cl.fractile > 0.5 ? "#f87171" : cl.fractile > 0.35 ? AMB : "#6ee7b7", fontWeight: 700 })} title={`fractile ratio ${(cl.fractile*100).toFixed(0)}% — ${cl.fractile > 0.5 ? "high, commit toward WEAK" : cl.fractile > 0.35 ? "moderate, commit near BASE" : "low, safe to commit through BASE"}`}>{(cl.fractile*100).toFixed(0)}%</td>
                          <td style={td({ textAlign: "right", color: DEMAND_SCENARIO_DEFS.weak.color })}>{fmtBig(Math.round(cl.weakD))}</td>
                          <td style={td({ textAlign: "right", color: DEMAND_SCENARIO_DEFS.base.color })}>{fmtBig(Math.round(cl.baseD))}</td>
                          <td style={td({ textAlign: "right", color: DEMAND_SCENARIO_DEFS.strong.color })}>{fmtBig(Math.round(cl.strongD))}</td>
                          <td style={td({ textAlign: "right", color: "#e2e8f0", fontWeight: 700 })}>{fmtBig(Math.round(cl.commitLevel))}</td>
                          <td style={td({ color: "rgba(255,255,255,0.5)", fontSize: 9.5, whiteSpace: "nowrap" })}>
                            <span style={{ color: "#6ee7b7" }} title="SIGN tranche: safe floor sized to weak demand">{fmtBig(Math.round(cl.committedTranche))}</span>
                            {" · "}<span style={{ color: "#67e8f9" }} title="LADDER tranche: commit level − safe (signed at trigger)">{fmtBig(Math.round(cl.ladderTranche))}</span>
                            {" · "}<span style={{ color: "rgba(255,255,255,0.45)" }} title="FLEX tranche: strong demand − commit level (OD/spot, never committed)">{fmtBig(Math.round(cl.flexTranche))}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.4)", marginTop: 10, lineHeight: 1.65 }}>
                  <b style={{ color: "#e2e8f0" }}>Newsvendor model.</b> Sizing here uses the classical <b>newsvendor</b> framework — the same math a paper vendor uses to decide how many copies to stock each morning under uncertain demand. Every reserved GPU carries two competing costs: <b style={{ color: "#6ee7b7" }}>save-if-used</b> = OD rate − reserved rate (what you save vs. paying hourly on-demand) and <b style={{ color: "#f87171" }}>loss-if-idle</b> = reserved rate − salvage (what you waste on an unused GPU that only recovers secondary-market value). The <b style={{ color: AMB }}>FRACTILE RATIO</b> = loss / (loss + save) is the critical newsvendor threshold: commit up to the demand level Q* such that P(demand ≥ Q*) = fractile.
                  <br/><br/>
                  <b style={{ color: "#e2e8f0" }}>Direction.</b> <b style={{ color: "#f87171" }}>High fractile</b> (loss dominates) → commit less; only where demand is highly certain. <b style={{ color: "#6ee7b7" }}>Low fractile</b> (save dominates) → commit aggressively; upside is big and downside is thin. Longer term = bigger discount → lower reserved rate → smaller loss + bigger save → lower fractile → commit more. That's why 60mo naturally wants a bigger commit than 12mo. The ratio just balances the three prices (reserved, OD, salvage) — "high" or "low" reflects that specific chip's economics, not any attribute like age or form factor.
                  <br/><br/>
                  <b style={{ color: "#e2e8f0" }}>Three-scenario discretization.</b> With only weak / base / strong scenarios, P(D ≥ Q) isn't a smooth curve — it's a step function:
                  <ul style={{ margin: "4px 0 0 20px", padding: 0, lineHeight: 1.55 }}>
                    <li>Q ≤ weak: <b>P = 1.0</b> (every scenario covers this)</li>
                    <li>weak &lt; Q ≤ base: <b>P = 0.75</b> (base + strong cover this)</li>
                    <li>base &lt; Q ≤ strong: <b>P = 0.25</b> (only strong covers this)</li>
                    <li>Q &gt; strong: <b>P = 0</b></li>
                  </ul>
                  So COMMIT snaps to the largest scenario level that still satisfies the fractile: fractile in (75%, 100%] → weak; fractile in (25%, 75%] → base; fractile in [0%, 25%] → strong. Any two fractiles that fall in the same bin land at the same COMMIT. Term-length differentiation for the actual buy decision therefore lives in the <b>recommendations table's</b> excess-EV-per-prepaid-$ sweep across (term × vendor), not in this table's tranche sizing. The RESERVED $/HR column shows a representative blended anchor; the engine internally sweeps per-term rates from the Vendor Spec discount curve.
                  <br/><br/>
                  <b style={{ color: "#e2e8f0" }}>Tranches.</b> <b style={{ color: "#6ee7b7" }}>SIGN</b> = weak floor (sign today, safe in every scenario). <b style={{ color: "#67e8f9" }}>LADDER</b> = commit − weak (sign at mo 6 only if base trajectory confirms — cost-free under weak because we never actually sign). <b style={{ color: "rgba(255,255,255,0.55)" }}>FLEX</b> = strong − commit (never committed — rides on OD/spot). Rows grouped by chip capability (B300 → L40S), then fabric class, then region.
                </div>
              </>
            );
          })()}
        </Section>

        {/* ── Recommendation table ── */}
        <Section
          title="Recommendations — sign / ladder / defer / renew / lapse / decline for ONE book"
          style={{ marginBottom: 12 }}
          right={
            <div
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 9px", background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 4, fontSize: 9.5, fontFamily: F, whiteSpace: "nowrap" }}
              title="From the Supply Chain Bottlenecks tab: HBM + advanced packaging are the pacing constraints and begin meaningfully easing H2 2027 as HBM4 volume and new CoWoS fabs (AP6, AP7) ramp. Silicon balance closer to 2028 when N2 wafers scale. DC power is structural and keeps effective AI-compute supply tight into 2029+. Not fed into the engine's math — surfaced here as context on whether new sign / defer recommendations sit against a tightening or loosening supply backdrop."
            >
              <span style={{ color: AMB, fontSize: 8 }}>●</span>
              <span style={{ color: "#e2e8f0", fontWeight: 600 }}>Aggregate supply bottleneck: easing H2 2027</span>
              <span style={{ color: "rgba(255,255,255,0.3)" }}>· from Bottlenecks tab</span>
            </div>
          }
        >
          {(() => {
            const actColor = { sign: "#6ee7b7", renew: "#6ee7b7", "renew-partial": AMB, ladder: "#67e8f9", defer: "#a78bfa", "on-demand": "#94a3b8", lapse: "rgba(255,255,255,0.55)", decline: "#f87171" };
            const actOrder = { sign: 0, ladder: 1, defer: 2, "on-demand": 3, renew: 4, "renew-partial": 5, lapse: 6, decline: 7 };
            const rows = [...recommendations].sort((a, b) => (actOrder[a.action] ?? 9) - (actOrder[b.action] ?? 9) || (b.evPerDollar || 0) - (a.evPerDollar || 0));
            const activeRows = rows.filter(r => r.action !== "decline");
            const declinedRows = rows.filter(r => r.action === "decline");
            const btnLabel = { sign: "ADD TO BOOK", ladder: "ADD (TRIGGER)", defer: null, "on-demand": "ADD OD BUY", renew: "EXTEND", "renew-partial": "EXTEND ½", lapse: "REMOVE", decline: null };
            const timingLabel = (r) => {
              if (r.action === "sign") return "now";
              if (r.action === "ladder") return "mo 6 (trigger)";
              if (r.action === "defer") return "mo " + (r.deferAt || "?");
              if (r.action === "on-demand") return "flexible";
              if (r.action === "renew" || r.action === "renew-partial") return "at expiry";
              if (r.action === "lapse") return "at expiry";
              return "—";
            };
            const renderHead = (extraCol) => (
              <thead style={{ position: "sticky", top: 0, background: "#0f172a", zIndex: 1 }}><tr>
                <th style={th("left")}>ACTION</th>
                <th style={th("left")} title="when the deal is signed. SIGN = now; LADDER = month 6 conditional on base trajectory; DEFER = future month when existing book has rolled off enough to fit under the total-spend cap; RENEW/LAPSE = at position expiry.">SIGN DATE</th>
                <th style={th("left")}>VENDOR</th>
                <th style={th("left")}>GPU · FABRIC · REGION</th>
                <th style={th()}>SIZE (H100e)</th>
                <th style={th()} title="reservation length. Engine sweeps 12/36/60mo (safe tranche) or 12/36mo (ladder) and picks the term with the highest EV per dollar prepaid. Longer terms cut $/hr via the discount curve (Vendor Spec tab) but tie up prepaid capital and expose more months to price decline. Hover the winning term for the runners-up.">TERM</th>
                <th style={th()} title="reserved rate the vendor would quote at the winning term = on-demand catalog rate × (1 − term discount from Vendor Spec tab) × operator tier multiplier (Platinum +6% / Gold +3% / Silver flat). Hover the cell for the on-demand and discount breakdown.">$/HR</th>
                <th style={th()} title="total contract value: gpus × $/hr × 730 × term months. For RENEW/RENEW-½: the incremental cost of the extension only. For DEFER: full contract value at future sign date. For DECLINE: counterfactual (what the deal would have cost had we signed).">TOTAL COST</th>
                <th style={th()} title="upfront cash at signing: upfront% × total contract value. The prepaid capital that gets tied up.">UPFRONT</th>
                <th style={th()}>EV</th>
                <th style={th()}>BASE-CASE EV</th>
                <th style={th()} title="the engine's primary ranking metric. Excess expected profit ABOVE the on-demand baseline, per dollar of prepaid capital. Positive → locking in the reserved deal beats staying flexible on OD by that much per capital dollar committed. Negative → the deal loses to OD; the engine picks ON-DEMAND (or DECLINE if OD is also unprofitable). Treats on-demand as the do-nothing benchmark every reserved candidate has to beat.">EV vs OD / $ PREPAID</th>
                {extraCol ? <th style={th("left")} title="which gate rejected this deal">WHY DECLINED</th> : <th style={th("center")}></th>}
              </tr></thead>
            );
            const renderRow = (r, showWhy) => {
              const price = r.rate || r.deal?.rate || 0;
              const baseEV = r.perScenario?.base?.profit ?? 0;
              const vendorName = r.vendor?.name || r.deal?.provider || "—";
              const term = r.termMo || r.deal?.termMo || 0;
              const canApply = btnLabel[r.action] != null;
              const isOD = r.action === "on-demand";
              let totalCost = 0, upfrontCost = 0, costIsCounterfactual = false;
              if (r.action === "sign" || r.action === "ladder" || r.action === "defer") {
                totalCost = (r.gpus || 0) * (r.rate || 0) * HRS_MO * (r.termMo || 0);
                upfrontCost = r.prepaid || 0;
              } else if ((r.action === "renew" || r.action === "renew-partial") && r.deal) {
                const extendMo = r.action === "renew" ? (r.deal.termMo || 24) : Math.max(6, Math.round((r.deal.termMo || 24) * 0.5));
                totalCost = (r.deal.gpus || 0) * (r.deal.rate || 0) * HRS_MO * extendMo;
                upfrontCost = ((r.deal.upfrontPct || 0) / 100) * totalCost;
              } else if (r.action === "decline") {
                totalCost = (r.gpus || 0) * (r.rate || 0) * HRS_MO * (r.termMo || 0);
                upfrontCost = r.prepaid || 0;
                costIsCounterfactual = true;
              }
              const costColor = costIsCounterfactual ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.7)";
              const upfrontColor = costIsCounterfactual ? "rgba(255,255,255,0.3)" : (upfrontCost > 0 ? AMB : "rgba(255,255,255,0.35)");
              const timingColor = r.action === "defer" ? "#a78bfa" : r.action === "ladder" ? "#67e8f9" : r.action === "sign" ? "#6ee7b7" : isOD ? "#94a3b8" : "rgba(255,255,255,0.5)";
              // For OD rows: EV per prepaid$ is undefined (no prepay). The
              // ranking metric — excess EV / $ prepaid — is 0 for OD by
              // definition (OD is its own benchmark), so we render it as such.
              const rankMetric = isOD ? 0 : (r.excessEvPerDollar ?? 0);
              return (
                <tr key={r.id}>
                  <td style={td({ color: actColor[r.action] || "#e2e8f0", fontWeight: 700, letterSpacing: "0.05em", fontSize: 9.5, textTransform: "uppercase" })}>{r.action}</td>
                  <td style={td({ color: timingColor, whiteSpace: "nowrap", fontSize: 9.5, fontWeight: 600 })} title={r.trigger || ""}>{timingLabel(r)}</td>
                  <td style={td({ color: "#e2e8f0", whiteSpace: "nowrap", fontSize: 10.5 })}>
                    {isOD ? (
                      <span style={{ color: r.odRank > 0 ? "rgba(148,163,184,0.75)" : "#e2e8f0", fontWeight: r.odRank > 0 ? 400 : 600 }}>
                        {vendorName}
                        {r.odRank > 0 && <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, marginLeft: 4 }}>· alt #{r.odRank}</span>}
                      </span>
                    ) : (
                      <><CmaxBadge provider={vendorName} dot />{vendorName}</>
                    )}
                  </td>
                  <td style={td({ color: "#e2e8f0", whiteSpace: "nowrap" })}>
                    <span style={{ fontWeight: 600 }}>{SUPPLY_GPUS[r.gpu]?.label.split(" ")[0] || r.gpu}</span>
                    <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 9.5 }}> · {r.fab} · {r.region}</span>
                  </td>
                  <td style={td({ textAlign: "right", color: AMB, fontWeight: 600 })}>{fmtBig(Math.round(r.targetH100e))}</td>
                  <td style={td({ textAlign: "right", color: isOD ? "#94a3b8" : "rgba(255,255,255,0.55)", fontWeight: isOD ? 600 : 400 })} title={(() => {
                    if (isOD) {
                      const b = r.bestReservedRejected;
                      if (!b) return "On-demand has no term commitment — you pay hourly with no lock-in.";
                      const ex = (b.excessEvPerDollar || 0);
                      return `On-demand has no term commitment — you pay hourly with no lock-in. Best reserved alternative that lost to OD: ${b.termMo}mo at ${b.vendor?.name || "?"} — would have earned ${ex >= 0 ? "+" : "−"}$${Math.abs(ex).toFixed(3)} of extra profit per $1 of prepaid capital vs. staying on OD (negative → locking in loses value here).`;
                    }
                    if (!r.termAlternates?.length) return term > 0 ? `${term}mo — the only term evaluated for this tranche (safe sweeps 12/36/60mo, ladder sweeps 12/36mo).` : "";
                    const alts = r.termAlternates.map(a => {
                      const ex = (a.excessEvPerDollar || 0);
                      const sign = ex >= 0 ? "+" : "−";
                      return `• ${a.termMo}mo term: reserved rate $${(a.rate || 0).toFixed(2)}/hr — would earn ${sign}$${Math.abs(ex).toFixed(3)} of extra profit per $1 of prepaid capital vs. staying on OD`;
                    }).join("\n");
                    return `Winning term across the sweep. Runner-up terms considered:\n${alts}`;
                  })()}>{isOD ? "flex" : (term > 0 ? term + "mo" : "—")}</td>
                  <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })} title={isOD ? `on-demand catalog rate — pay only for hours delivered, no lock-in, no prepay` : (r.odRate ? `$${r.odRate.toFixed(2)}/hr on-demand (vendor catalog rate) × (1 − ${((r.termDiscount || 0) * 100).toFixed(1)}% ${term}mo discount) × operator tier multiplier` : "")}>{price > 0 ? fmtUSD(price, 2) : "—"}</td>
                  <td style={td({ textAlign: "right", color: isOD ? "#94a3b8" : costColor })} title={isOD ? "on-demand cost varies with delivered hours — no fixed commitment" : (costIsCounterfactual ? "counterfactual — deal was declined; this is what it would have cost" : (r.action === "renew" || r.action === "renew-partial" ? "incremental cost of the extension" : ""))}>{isOD ? "variable" : (totalCost > 0 ? fmtUSD(totalCost) : "—")}</td>
                  <td style={td({ textAlign: "right", color: isOD ? "#94a3b8" : upfrontColor, fontWeight: upfrontCost > 0 && !costIsCounterfactual ? 600 : 400 })} title={isOD ? "on-demand has no prepay — full flexibility" : (costIsCounterfactual ? "counterfactual upfront" : "prepaid cash at signing")}>{isOD ? "$0" : (totalCost > 0 ? (upfrontCost > 0 ? fmtUSD(upfrontCost) : "$0") : "—")}</td>
                  <td style={td({ textAlign: "right", color: (r.EV || 0) >= 0 ? "#6ee7b7" : "#f87171" })}>{r.EV != null ? ((r.EV >= 0 ? "+" : "−") + fmtUSD(Math.abs(r.EV))) : "—"}</td>
                  <td style={td({ textAlign: "right", color: baseEV >= 0 ? "#e2e8f0" : "#f87171" })}>{r.perScenario ? ((baseEV >= 0 ? "+" : "−") + fmtUSD(Math.abs(baseEV))) : "—"}</td>
                  <td style={td({ textAlign: "right", color: isOD ? "#94a3b8" : (rankMetric > 0 ? "#6ee7b7" : "#f87171"), fontWeight: 600 })} title={isOD ? "on-demand is the benchmark — excess vs. itself is 0 by definition. Reserved candidates must beat this to be picked." : (r.evOD != null ? `reserved EV $${((r.EV || 0) / 1e6).toFixed(2)}M − OD baseline EV $${((r.evOD || 0) / 1e6).toFixed(2)}M = excess $${(((r.EV || 0) - (r.evOD || 0)) / 1e6).toFixed(2)}M over ${term}mo; divide by $${((r.prepaid || 0) / 1e6).toFixed(2)}M prepaid → ${(rankMetric >= 0 ? "+" : "") + rankMetric.toFixed(3)}× — positive means signing beats staying on OD` : "")}>{isOD ? "baseline" : ((rankMetric >= 0 ? "+" : "") + rankMetric.toFixed(2) + "×")}</td>
                  {showWhy ? (
                    <td style={td({ color: "#f87171", fontSize: 9, lineHeight: 1.35, maxWidth: 260 })} title={r.declineReason || ""}>{r.declineReason || "—"}</td>
                  ) : (
                    <td style={td({ textAlign: "center" })}>
                      {canApply ? (
                        <button onClick={() => applyRec(r)} title={r.trigger || ""} style={{ background: `${actColor[r.action]}12`, border: `1px solid ${actColor[r.action]}55`, color: actColor[r.action], borderRadius: 4, fontSize: 8.5, fontFamily: F, letterSpacing: "0.06em", padding: "3px 8px", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 700 }}>{btnLabel[r.action]}</button>
                      ) : <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 9 }}>—</span>}
                    </td>
                  )}
                </tr>
              );
            };
            return (
              <>
                <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 560, border: "1px solid rgba(255,255,255,0.04)", borderRadius: 4 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                    {renderHead(false)}
                    <tbody>
                      {activeRows.length > 0 ? activeRows.map(r => renderRow(r, false)) : (
                        <tr><td colSpan={13} style={{ padding: "14px 10px", fontSize: 10, color: "rgba(255,255,255,0.4)", textAlign: "center", fontStyle: "italic" }}>No actionable recommendations — every candidate either declined or the book already covers demand. Expand the panel below to see rejected candidates and why.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {declinedRows.length > 0 && (
                  <details style={{ marginTop: 8, border: "1px solid rgba(255,255,255,0.04)", borderRadius: 4 }}>
                    <summary style={{ cursor: "pointer", padding: "8px 10px", fontSize: 10.5, fontFamily: F, color: "rgba(255,255,255,0.55)", background: "rgba(255,255,255,0.02)", userSelect: "none" }}>
                      ▸ <b style={{ color: "#f87171" }}>{declinedRows.length}</b> declined candidate{declinedRows.length === 1 ? "" : "s"} — click to expand (shows which gate rejected each; useful for auditing "why nothing here" when tuning sliders)
                    </summary>
                    <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 400, borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                        {renderHead(true)}
                        <tbody>{declinedRows.map(r => renderRow(r, true))}</tbody>
                      </table>
                    </div>
                  </details>
                )}
                <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.4)", marginTop: 10, lineHeight: 1.65 }}>
                  <b style={{ color: "#e2e8f0" }}>What each row is:</b> a concrete deal action the engine wants you to take on one supply bucket. Actions come in seven flavors, sorted top-to-bottom in that priority:
                  <br/>
                  <span style={{ color: "#6ee7b7", fontWeight: 700 }}>SIGN</span> — commit today to the safe floor (sized to WEAK demand at the reference window; utilizes fully in every scenario).
                  {" "}<span style={{ color: "#67e8f9", fontWeight: 700 }}>LADDER</span> — a conditional commitment: don't sign now, but if actuals-to-date at month 6 confirm the base trajectory, THEN sign the increment above the safe floor (up to the fractile-implied commit level).
                  {" "}<span style={{ color: "#a78bfa", fontWeight: 700 }}>DEFER</span> — an otherwise-clean SIGN/LADDER that breaches the total-spend cap TODAY, but fits at a specific future month once existing positions roll off enough to free the headroom. SIGN DATE column shows when. Deal economics unchanged (same term, rate, size) — you're just waiting for balance-sheet room.
                  {" "}<span style={{ color: "#94a3b8", fontWeight: 700 }}>ON-DEMAND</span> — no reserved term at any vendor beats the on-demand baseline on excess-EV-per-prepaid-dollar. Stay flexible: pay OD hourly, no lock-in, no prepay. Each OD-winning bucket emits a primary row (cheapest catalog vendor for that GPU · fabric · region) plus up to 2 alternate rows. Clicking ADD OD BUY inserts an OD-structured entry into the supply book so the intent shows up above.
                  {" "}<span style={{ color: "#6ee7b7", fontWeight: 700 }}>RENEW</span> / <span style={{ color: AMB, fontWeight: 700 }}>RENEW-PARTIAL</span> — an existing position expires inside the 24-month horizon and weak/base demand still supports keeping it (full or half term).
                  {" "}<span style={{ color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>LAPSE</span> — an existing position expires and there isn't enough demand to justify renewing.
                  {" "}<span style={{ color: "#f87171", fontWeight: 700 }}>DECLINE</span> — the engine considered a deal, saw every reserved term lose to OD, AND found OD itself unprofitable at this bucket. Nothing to do — don't sign, don't even cover on OD (sell rate {'<'} OD rate under the scenario weights).
                  <br/><br/>
                  <b style={{ color: "#e2e8f0" }}>How to read the numbers:</b>
                  <ul style={{ margin: "4px 0 4px 20px", padding: 0, lineHeight: 1.6 }}>
                    <li><b>SIGN DATE</b> = when the deal actually gets signed. <span style={{ color: "#6ee7b7" }}>now</span> for SIGN; <span style={{ color: "#67e8f9" }}>mo 6 (trigger)</span> for LADDER; <span style={{ color: "#a78bfa" }}>mo N</span> for DEFER — the earliest month where existing-book obligation drops enough to admit the deal under the ${totalSpendCapM.toLocaleString()}M spend cap, with earlier defers in this pass layered on top so later ones push further out. <b>SIZE</b> = H100-equivalent capacity of the candidate. <b>TERM</b> = commitment length in months from the sign date. The engine sweeps 12/36/60mo (SAFE tranche) or 12/36mo (LADDER) per bucket-vendor pair and picks the term with the highest EV per dollar prepaid — longer terms cut $/hr via the discount curve (Vendor Spec tab) but tie up prepaid capital and expose more months to price decline. Hover the winning term to see runner-up terms. <b>$/HR</b> = reserved rate at the winning term = on-demand catalog rate × (1 − term discount) × operator tier multiplier. Hover for the breakdown.</li>
                    <li><b>TOTAL COST</b> = full contract value paid upstream over the term (gpus × $/hr × 730 × term). For RENEW / RENEW-½ it's the incremental cost of the extension only. For DEFER it's the full contract value at the future sign date. For DECLINE it's counterfactual (muted) — the deal wasn't signed. <b>UPFRONT</b> = prepaid cash at signing (upfront% × total cost) — the capital that actually gets tied up.</li>
                    <li><b>EV</b> = probability-weighted expected profit over the deal's term. Σ P(s) × profit_s across weak/base/strong. The priors P(s) are set on the Compute Demand tab next to the scenario toggle.</li>
                    <li><b>BASE-CASE EV</b> = the profit this deal delivers if the base scenario actually plays out. It's the "central expectation" version of EV; usually higher than EV because the weak scenario drags the probability-weighted average down.</li>
                    <li><b>EV vs OD / $ PREPAID</b> = the engine's primary ranking metric. Expected profit ABOVE the on-demand baseline, per dollar of prepaid capital. It answers "does locking capital in this reserved deal beat sitting flexibly on OD, and by how much per dollar committed?" — a positive value means the reserved deal wins by that many dollars-of-excess-profit per dollar-of-prepay; a negative value means OD beats it and the engine picks ON-DEMAND. This differs from raw EV per prepaid dollar because it nets out the profit you'd earn anyway on OD — a deal that returns $2 EV per prepaid $ is only impressive if the OD alternative would have returned less than $2. For OD rows the metric shows "baseline" — OD is the benchmark, so its excess vs. itself is zero by definition.</li>
                  </ul>
                  <b style={{ color: "#e2e8f0" }}>Why a candidate flips to DEFER vs DECLINE:</b> if a SIGN or LADDER passes every gate EXCEPT the total-spend cap, the engine tries to defer — searching month-by-month for the earliest sign date where existing-book obligation has rolled off enough to fit the new deal under the cap. If a feasible month exists within 24 months → DEFER (informational — no book action taken, you revisit at that date). If not, or if any OTHER gate trips ({'>'}40% vendor concentration once the projected book exceeds 2,000 GPUs, cumulative prepaid capital ≥ {prepaidCapPct}% of ARR, Bronze operator prepaid ≥ 10% of ARR, plain Ethernet on a non-inference chip, or the deal fails its own margin gate — SIGN at weak-case, LADDER at base-case) → DECLINE. The engine is not obliged to fill every gap — DEFER and DECLINE are peer options, not fallbacks (an optimizer forced to fill every gap overpays in tight markets).
                  <br/><br/>
                  <b style={{ color: "#e2e8f0" }}>The button at the far right</b> applies the recommendation directly to your supply book above: ADD TO BOOK / ADD (TRIGGER) creates a new active reserved deal from the vendor spec; EXTEND / EXTEND ½ adds a full or half term to an existing position's remaining months; REMOVE deletes a lapsed position. DEFER and DECLINE are read-only — no book change, you act on DEFER manually when the sign date arrives.
                </div>
              </>
            );
          })()}
        </Section>

        {/* ── Scenario P&L table ── */}
        <Section title="Scenario P&L — how the recommended book plays out under each scenario" style={{ marginBottom: 12 }}>
          {(() => {
            const scenarios = ["weak", "base", "strong"];
            // Probability-weighted totals for the summary row
            const wRev = scenarios.reduce((s, k) => s + (probs[k] || 0) * (pnl.perScenario[k]?.revenue || 0), 0);
            const wCost = scenarios.reduce((s, k) => s + (probs[k] || 0) * (pnl.perScenario[k]?.cost || 0), 0);
            const wCarry = scenarios.reduce((s, k) => s + (probs[k] || 0) * (pnl.perScenario[k]?.carry || 0), 0);
            const wOverflow = scenarios.reduce((s, k) => s + (probs[k] || 0) * (pnl.perScenario[k]?.overflow || 0), 0);
            return (
              <>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                    <thead><tr>
                      <th style={th("left")}>SCENARIO</th>
                      <th style={th()} title="prior probability set on the Compute Demand tab">P(s)</th>
                      <th style={th()} title="H100-hours served × customer sell rate (inf/train prices from the Compute Demand tab), including salvage on idle capacity and revenue from profitable OD coverage of overflow">REVENUE</th>
                      <th style={th()} title="ACTUAL CASH PAID upstream: reserved take-or-pay + OD/spot usage-based + upstream OD covering profitable overflow. Only real cash out — no opportunity costs.">COST (cash out)</th>
                      <th style={th()} title="cost of capital on prepaid cash: upfront% × contract value × WACC, amortized over horizon">CARRY</th>
                      <th style={th()} title="OPPORTUNITY COST (not cash): customer-switching risk from demand we chose to walk away from because covering it on upstream OD would have been unprofitable (OD rate > customer sell rate). Prime Intellect is an on-demand marketplace — no signed SLAs, but walked-away customers may migrate their future runs to a competitor. Booked as ~5% of walked-away training revenue and ~2% of walked-away inference revenue (churn premium × workload stickiness).">FORFEIT COST</th>
                      <th style={th()} title="revenue − cost − carry − forfeit cost, over the 24-month term">NET MARGIN</th>
                    </tr></thead>
                    <tbody>
                      {scenarios.map(s => {
                        const p = pnl.perScenario[s];
                        return (
                          <tr key={s}>
                            <td style={td({ color: DEMAND_SCENARIO_DEFS[s].color, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" })}>{DEMAND_SCENARIO_DEFS[s].label}</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{((probs[s]||0)*100).toFixed(0)}%</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.7)" })}>{fmtUSD(p.revenue)}</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>−{fmtUSD(p.cost)}</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>−{fmtUSD(p.carry)}</td>
                            <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>−{fmtUSD(p.overflow)}</td>
                            <td style={td({ textAlign: "right", color: p.netMargin >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 700 })}>{(p.netMargin >= 0 ? "+" : "−") + fmtUSD(Math.abs(p.netMargin))}</td>
                          </tr>
                        );
                      })}
                      <tr style={{ borderTop: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.02)" }}>
                        <td style={td({ color: "#e2e8f0", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" })} title="probability-weighted average across the three scenarios (Σ P(s) × column)">EV (Σ P·x)</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.3)" })}>100%</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.75)", fontWeight: 600 })}>{fmtUSD(wRev)}</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.6)", fontWeight: 600 })}>−{fmtUSD(wCost)}</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.6)", fontWeight: 600 })}>−{fmtUSD(wCarry)}</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.6)", fontWeight: 600 })}>−{fmtUSD(wOverflow)}</td>
                        <td style={td({ textAlign: "right", color: pnl.EV >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 700 })}>{(pnl.EV >= 0 ? "+" : "−") + fmtUSD(Math.abs(pnl.EV))}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.4)", marginTop: 10, lineHeight: 1.65 }}>
                  <b style={{ color: "#e2e8f0" }}>What this table is:</b> the recommended book — everything in the supply book above PLUS the engine's SIGN and RENEW recommendations, MINUS its LAPSE recommendations — played out under each of the three demand scenarios. All numbers are total dollars over the 24-month horizon. LADDER recommendations count in base and strong only (they're not signed under weak because the mo-6 trigger doesn't fire). The bottom row is the probability-weighted average (Σ P(s) · column); the EV NET MARGIN cell is the number the engine maximizes.
                  <br/><br/>
                  <b style={{ color: "#e2e8f0" }}>How to read each column:</b>
                  <ul style={{ margin: "4px 0 4px 20px", padding: 0, lineHeight: 1.6 }}>
                    <li><b>REVENUE</b> = served H100-hours × customer sell rate (inference/training prices from the Compute Demand tab, blended per bucket's workload mix) + idle reserved capacity salvaged at spot rate + profitable overflow served on OD at customer sell rate.</li>
                    <li><b>COST (cash out)</b> — actual dollars spent upstream: (a) full take-or-pay on reserved contracts (paid whether the capacity gets sold or not), (b) usage-based rate on any OD/spot supply IN YOUR BOOK when it serves demand, and (c) upstream OD purchases to cover overflow — but ONLY when covering is profitable (customer sell rate {'>'} OD upstream rate). Unprofitable overflow is skipped, not paid for.</li>
                    <li><b>CARRY</b> = cost of capital tied up in prepayments (upfront% × contract value × WACC, amortized over horizon).</li>
                    <li><b>FORFEIT COST</b> — customer-switching risk, not cash. When demand shows up but our book is full AND covering it on upstream OD would be unprofitable, we walk away. Our business operates as an on-demand marketplace (no signed take-or-pay from customers), so there's no contractual SLA damage — but a walked-away customer may migrate future runs to a competitor. Booked as <b>~5% of walked-away TRAINING revenue</b> (multi-week runs, high reliability sensitivity) and <b>~2% of walked-away INFERENCE revenue</b> (bursty, multi-vendor by default, more forgiving).</li>
                    <li><b>NET MARGIN</b> = REVENUE − COST − CARRY − FORFEIT COST for that scenario.</li>
                  </ul>
                </div>
              </>
            );
          })()}
        </Section>


        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.18)", marginTop: 16, fontFamily: F, lineHeight: 1.5 }}>
          Market rates, on-demand source rates, and the seed book are illustrative Apr 2026 snapshots — replace with live marketplace data before real intake decisions. Prepay carry uses average outstanding balance × cost of capital; counterparty credit risk on prepaid capital is flagged qualitatively, not priced.
        </div>
      </div>
    </div>
  );
}

return App;
})();

// ═════════════════════════════════════════════════════════════════════════════
// COMPUTE DEMAND — the other half of the book. Three jobs:
//   (1) track committed + pipeline demand (training runs and inference contracts)
//   (2) size a training run from first principles (C≈6ND) into a GPU requirement
//       and check it against the clusters we actually hold
//   (3) reconcile demand against supply by GPU class and by month — where are we
//       short, where is capacity sitting idle, and is a run even placeable
// Reads the shared supply book, so edits on the Compute Supply tab flow through.
// ═════════════════════════════════════════════════════════════════════════════

const DemandSideApp = (() => {

// Mirror of the supply-side GPU specs (kept local to this IIFE, matching the
// buyer/seller pattern of self-contained scopes). tflops = BF16 dense tensor.
const DGPU = {
  H100:    { label: "H100 80GB",  tflops: 989,  vram: 80,  bw: 3.35, market: 1.85 },
  H200:    { label: "H200 141GB", tflops: 989,  vram: 141, bw: 4.8,  market: 2.30 },
  B200:    { label: "B200 192GB", tflops: 2250, vram: 192, bw: 8.0,  market: 3.60 },
  B300:    { label: "B300 288GB", tflops: 2900, vram: 288, bw: 8.0,  market: 5.00 },
  A100_80: { label: "A100 80GB",  tflops: 312,  vram: 80,  bw: 2.0,  market: 1.10 },
  L40S:    { label: "L40S 48GB",  tflops: 181,  vram: 48,  bw: 0.86, market: 0.75 },
};
const h100eOf = (gpu, gpus, mode = "flops") => gpus * (mode === "bw" ? DGPU[gpu].bw / DGPU.H100.bw : DGPU[gpu].tflops / DGPU.H100.tflops);
const POOL_CAP = { ib32: 32, ib16: 32, roce: 8, eth: 1 };
const FAB_CLASS = ic => (ic === "ib32" || ic === "ib16") ? "ib32" : ic;
const FAB_LABEL = { ib32: "InfiniBand", roce: "RoCE/NVLink", eth: "Ethernet" };
const REGIONS = ["US-East", "US-Central", "US-West", "EU", "Nordics", "Middle East", "APAC", "Global (mixed)"];
// Open-weight model configs. paramsB = total params (weight FOOTPRINT, incl. all
// MoE experts); activeB = params READ per decode step (MoE reads only active
// experts, so decode is memory-bound on activeB). layers/kvHeads/headDim give the
// KV-cache size per token; DeepSeek uses MLA (compressed latent KV), overridden.
const MODELS = [
  { key: "l8",   label: "Llama 8B",      paramsB: 8,    activeB: 8,   layers: 32,  kvHeads: 8, headDim: 128 },
  { key: "q32",  label: "Qwen 32B",      paramsB: 33,   activeB: 33,  layers: 64,  kvHeads: 8, headDim: 128 },
  { key: "l70",  label: "Llama 70B",     paramsB: 71,   activeB: 71,  layers: 80,  kvHeads: 8, headDim: 128 },
  { key: "q72",  label: "Qwen 72B",      paramsB: 73,   activeB: 73,  layers: 80,  kvHeads: 8, headDim: 128 },
  { key: "mx22", label: "Mixtral 8×22B", paramsB: 141,  activeB: 39,  layers: 56,  kvHeads: 8, headDim: 128, moe: true },
  { key: "l405", label: "Llama 405B",    paramsB: 405,  activeB: 405, layers: 126, kvHeads: 8, headDim: 128 },
  { key: "ds",   label: "DeepSeek V3/R1",paramsB: 671,  activeB: 37,  layers: 61,  kvHeads: 8, headDim: 128, moe: true, kvPerTokKB: 70 },
  { key: "k2",   label: "Kimi K2",       paramsB: 1026, activeB: 32,  layers: 61,  kvHeads: 8, headDim: 128, moe: true },
];
const MODEL_BY_KEY = Object.fromEntries(MODELS.map(m => [m.key, m]));
const QUANTS = [{ value: 2, label: "FP16/BF16" }, { value: 1, label: "FP8" }];
const OPEN_MODELS = Object.fromEntries(MODELS.map(m => [m.key, m.label])); // legacy label map
// KV cache bytes per token (FP16): 2 (K,V) × layers × kvHeads × headDim × 2 bytes,
// unless a compressed-attention override is given (e.g. MLA).
const kvBytesPerTok = m => (m.kvPerTokKB != null) ? m.kvPerTokKB * 1024 : 2 * m.layers * m.kvHeads * m.headDim * 2;
const SERVE_HEADROOM = 1.2, VRAM_USABLE = 0.85;
// Smallest power-of-2 GPU pool (≤ fabric cap) whose usable VRAM holds the weights
// at bytesPerParam, with headroom for KV/activations. null if it never fits.
function minPool(m, gpuKey, bytesPerParam, cap) {
  const needGB = m.paramsB * bytesPerParam * SERVE_HEADROOM;
  for (let n = 1; n <= cap; n *= 2) { if (n * DGPU[gpuKey].vram * VRAM_USABLE >= needGB) return n; }
  return null;
}
const HRS_MO = 730;
const KINDS = [{ value: "training", label: "Training run" }, { value: "inference", label: "Inference contract" }];
const STATUSES = [{ value: "committed", label: "Committed" }, { value: "pipeline", label: "Pipeline" }];
const FABRICS = [{ value: "ib32", label: "InfiniBand" }, { value: "roce", label: "RoCE/NVLink" }, { value: "eth", label: "Ethernet" }];

const F = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const CY = "#67e8f9"; // demand accent: cyan
const GRW = "#86efac"; // editable-field green — shared by demand build, modelers, model mix
const fmtUSD = (n, d) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a < 1 && n !== 0) return "$" + n.toFixed(d ?? 3); return "$" + n.toLocaleString(undefined, { maximumFractionDigits: d ?? 0 }); };
const fmtBig = (n) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(1) + "B"; if (a >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (a >= 1e3) return (n / 1e3).toFixed(1) + "K"; return n.toFixed(0); };
const fmtPct = (n, d = 0) => (n * 100).toFixed(d) + "%";

function Metric({ label, value, sub, accent, warn }) {
  return (
    <div style={{ background: warn ? "rgba(248,113,113,0.1)" : "rgba(255,255,255,0.06)", border: `1px solid ${warn ? "rgba(248,113,113,0.28)" : "rgba(255,255,255,0.11)"}`, borderRadius: 8, padding: "10px 12px", flex: "1 1 150px", minWidth: 150 }}>
      <div style={{ fontSize: 10, color: warn ? "rgba(248,113,113,0.7)" : "rgba(255,255,255,0.35)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 2, fontFamily: F }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "#e2e8f0", fontFamily: F, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2, fontFamily: F }}>{sub}</div>}
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>{children}</div>;
}
function Slider({ label, value, onChange, min, max, step = 1, fmtFn, hint }) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: CY, height: 3 }} />
        <span style={{ fontSize: 13, color: CY, fontFamily: F, fontWeight: 600, minWidth: 62, textAlign: "right" }}>{fmtFn ? fmtFn(value) : value}</span>
      </div>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}
function Select({ label, value, onChange, options, hint }) {
  return (
    <Field label={label}>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", padding: "7px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, color: "#e2e8f0", fontSize: 12, fontFamily: F, outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value} style={{ background: "#0b1118" }}>{o.label}</option>)}
      </select>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}
function Section({ title, children, style: s }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.1)", ...s }}>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: F, fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  );
}
function SectionHeader({ title, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 12px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#e2e8f0", fontFamily: F, textTransform: "uppercase" }}>{title}</div>
      {right}
      <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
    </div>
  );
}
const td = (extra = {}) => ({ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", ...extra });
const th = (align = "right") => ({ padding: "5px 8px", textAlign: align, color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 });
const kindColor = k => k === "training" ? "#c4b5fd" : CY;

// ─── Training-run sizing: C ≈ 6ND ───────────────────────────────────────────
// Total training compute ≈ 6 × params × tokens FLOPs (fwd+bwd). GPU-hours =
// C / (peakFLOPS × MFU × 3600). GPUs = GPU-hours / (days × 24). MFU (model FLOPs
// utilization) is the single biggest lever — 35-50% is realistic at scale.
// Bytes/param to hold TRAINING state under mixed-precision Adam with FSDP/ZeRO
// sharding: 2 (fp16 weight) + 2 (fp16 grad) + 12 (fp32 master + momentum +
// variance) ≈ 16, plus a headroom multiplier for activations/comms buffers.
const TRAIN_BYTES_PER_PARAM = 16, TRAIN_MEM_HEADROOM = 1.25, TRAIN_VRAM_USABLE = 0.85;
function sizeTrainOnGpu({ paramsB, tokensT, days, gpu, mfu }) {
  const g = DGPU[gpu];
  const C = 6 * paramsB * 1e9 * tokensT * 1e12;          // total FLOPs (fwd+bwd)
  const peak = g.tflops * 1e12;
  const gpuHours = C / (peak * (mfu / 100) * 3600);       // fixed by total compute, not GPU count
  const computeGpus = Math.ceil(gpuHours / (days * 24));  // to hit the time target
  // Memory floor: training state sharded across GPUs must fit in aggregate VRAM.
  const footprintGB = paramsB * TRAIN_BYTES_PER_PARAM * TRAIN_MEM_HEADROOM;
  const memGpus = Math.ceil(footprintGB / (g.vram * TRAIN_VRAM_USABLE));
  const gpus = Math.max(computeGpus, memGpus);
  const memBound = memGpus > computeGpus;
  const actualDays = gpuHours / (gpus * 24);              // < target if memory forces extra GPUs
  const cost = gpuHours * g.market;
  return { gpu, C, gpuHours, computeGpus, memGpus, gpus, memBound, actualDays, cost };
}
// GPU as OUTPUT: evaluate every GPU, rank by total cost (compute cost is fixed
// per GPU by its $/FLOP; the cheapest $/effective-FLOP wins). Memory-bound small
// GPUs need more units but the same GPU-hours, so they mainly change wall-clock.
function sizeTrainingRun({ paramsB, tokensT, days, mfu }) {
  const options = Object.keys(DGPU).map(gpu => sizeTrainOnGpu({ paramsB, tokensT, days, gpu, mfu }));
  const viable = [...options].sort((a, b) => a.cost - b.cost);
  return { options, viable, best: viable[0] || null, C: options[0].C };
}

// ─── Inference-run sizing: roofline-lite, decode-bound ───────────────────────
// Serving throughput is memory-bandwidth-bound at decode: each step reads the
// (active) weights once plus the KV cache for every sequence in the batch.
//   bytes/step = activeWeights + batch × KVperTok × avgContext
//   tokens/s   = (aggregate BW × eff / bytes/step) × batch
// Batch is capped by the VRAM left after weights. Prefill is ignored (decode
// dominates for chat/agent traffic); outputs are an upper bound like the
// buyer/seller roofline. Returns a GPU requirement for a target request rate.
function sizeOnGpu({ modelKey, gpu, bytesPerParam, avgIn, avgOut, targetRPS, eff, tpotMs }) {
  const m = MODEL_BY_KEY[modelKey];
  const cap = 32; // allow up to an IB pool; pool>8 will require IB at placement
  const pool = minPool(m, gpu, bytesPerParam, cap);
  if (!pool) return { servable: false, gpu, pool: null };
  const g = DGPU[gpu];
  const weightFootprint = m.paramsB * bytesPerParam * 1e9;            // bytes, all experts resident
  const poolVRAM = pool * g.vram * VRAM_USABLE * 1e9;                 // bytes
  const kvTok = kvBytesPerTok(m);                                     // bytes/token
  const peakCtx = avgIn + avgOut;                                     // footprint at end of gen
  const vramBatch = Math.max(1, Math.floor((poolVRAM - weightFootprint) / (kvTok * peakCtx)));
  const aggBW = pool * g.bw * 1e12 * eff;                             // bytes/s
  const weightRead = m.activeB * bytesPerParam * 1e9;                 // bytes/step (active for MoE)
  const avgCtx = avgIn + avgOut / 2;                                  // avg during generation
  // Latency (TPOT = time per output token) rises with batch: bigger batch reads
  // more KV per step, so the per-token step time grows. Cap batch so decode step
  // time stays within the SLA. step_time = bytesPerStep / aggBW; TPOT = step_time.
  //   bytesPerStep(b) = weightRead + b × kvTok × avgCtx
  //   TPOT(b) = bytesPerStep(b) / aggBW ≤ tpotMs/1000  ⟹  solve for b
  const budgetBytes = (tpotMs / 1000) * aggBW;
  const slaBatch = Math.max(0, Math.floor((budgetBytes - weightRead) / (kvTok * avgCtx)));
  const batch = Math.min(vramBatch, slaBatch);
  const slaLimited = slaBatch < vramBatch;               // SLA is the binding constraint
  if (batch < 1) return { servable: true, gpu, pool, batch: 0, slaMiss: true }; // can't meet SLA even at batch=1
  const bytesPerStep = weightRead + batch * kvTok * avgCtx;
  const stepsPerSec = aggBW / bytesPerStep;
  const tpotActualMs = (bytesPerStep / aggBW) * 1000;
  const tokPerSecReplica = stepsPerSec * batch;
  const rpsReplica = tokPerSecReplica / avgOut;
  const replicas = Math.max(1, Math.ceil(targetRPS / rpsReplica));
  const totalGPUs = replicas * pool;
  const tokPerSec = tokPerSecReplica * replicas;
  const costHr = totalGPUs * g.market;
  const per1M = tokPerSec > 0 ? (costHr / (tokPerSec * 3600)) * 1e6 : Infinity;
  return { servable: true, gpu, pool, batch, slaLimited, tpotActualMs, rpsReplica, replicas, totalGPUs, tokPerSec, costHr, per1M };
}
// Requirements in, GPU recommendation out: evaluate every GPU type and rank the
// viable options by cost efficiency ($/1M tokens). GPU is an OUTPUT here — the
// customer specifies the model + SLA, the tool says which GPU/how many to book.
function sizeInferenceRun({ modelKey, bytesPerParam, avgIn, avgOut, targetRPS, eff, tpotMs }) {
  const options = Object.keys(DGPU).map(gpu => sizeOnGpu({ modelKey, gpu, bytesPerParam, avgIn, avgOut, targetRPS, eff, tpotMs }));
  const viable = options.filter(o => o.servable && o.batch >= 1).sort((a, b) => a.per1M - b.per1M);
  return { options, viable, best: viable[0] || null };
}

function App() {
  const supply = useBookStore(SUPPLY_STORE)[0];
  const [demand, setDemand] = useBookStore(DEMAND_STORE);
  const [cohorts, setCohorts] = useBookStore(COHORT_STORE);
  const [scenario] = useBookStore(DEMAND_SCENARIO_STORE);
  const [probPct, setProbPct] = useBookStore(SCENARIO_PROB_STORE);
  const switchScenario = (key) => {
    if (key === scenario) return;
    SCENARIO_COHORTS[scenario] = COHORT_STORE.get();
    DEMAND_SCENARIO_STORE.set(key);
    COHORT_STORE.set(SCENARIO_COHORTS[key]);
  };
  const setSegName = (id, name) => setCohorts(prev => prev.map(c => c.id === id ? { ...c, name } : c));
  const setLeafField = (segId, leafId, field, value) => setCohorts(prev => prev.map(c => c.id === segId ? { ...c, regions: c.regions.map(l => l.id === leafId ? { ...l, [field]: value } : l) } : c));
  const setLeafMonth = (segId, leafId, mi, field, value) => setCohorts(prev => prev.map(c => c.id === segId ? { ...c, regions: c.regions.map(l => l.id === leafId ? { ...l, months: l.months.map((mm, j) => j === mi ? { ...mm, [field]: value } : mm) } : l) } : c));
  const nextLeafId = (prev) => Math.max(0, ...prev.flatMap(c => c.regions.map(l => l.id))) + 1;
  const addSegment = () => setCohorts(prev => [...prev, { id: Math.max(0, ...prev.map(c => c.id)) + 1, name: "New segment", regions: [seedLeaf(nextLeafId(prev), "US-East", 10, 5, 2, 2, 4, 32, 0.5, 0, 0)] }]);
  const delSegment = (id) => setCohorts(prev => prev.filter(c => c.id !== id));
  const addRegion = (segId) => setCohorts(prev => prev.map(c => c.id === segId ? { ...c, regions: [...c.regions, seedLeaf(nextLeafId(prev), "US-East", 5, 5, 2, 2, 4, 32, 0.5, 0, 0)] } : c));
  const delRegion = (segId, leafId) => setCohorts(prev => prev.map(c => c.id === segId ? { ...c, regions: c.regions.filter(l => l.id !== leafId) } : c));
  const [baseline, setBaseline] = useBookStore(BASELINE_STORE);
  const setBaseCell = (kind, mi, field, value) => setBaseline(prev => ({ ...prev, [kind]: prev[kind].map((r, j) => j === mi ? { ...r, [field]: value } : r) }));
  // Growth-driven fields: month 1 is the anchor; months 2+ compound through each
  // month's `<field>G` %/mo rate. Editing a growth rate or the anchor recomputes
  // the whole absolute series.
  const recompoundField = (rows, field) => {
    let v = rows[0][field];
    return rows.map((r, i) => {
      if (i === 0) return r;
      v = v * (1 + (r[field + "G"] || 0) / 100);
      return { ...r, [field]: v };
    });
  };
  const setBaseGrowth = (kind, mi, field, g) => setBaseline(prev => {
    const rows = prev[kind].map((r, j) => j === mi ? { ...r, [field + "G"]: g } : r);
    return { ...prev, [kind]: recompoundField(rows, field) };
  });
  const setBaseAnchor = (kind, field, v) => setBaseline(prev => {
    const rows = prev[kind].map((r, j) => j === 0 ? { ...r, [field]: v } : r);
    return { ...prev, [kind]: recompoundField(rows, field) };
  });
  // Shared monthly line chart (demand build + modelers). Series tagged L/R
  // scale to their own axis so different-magnitude inputs stay readable; the
  // axis tag is dropped from legends when a chart is single-axis. Legend wraps
  // to two columns on half-width charts.
  const paramChart = (series, opts = {}) => {
    const n = COHORT_MONTHS;
    const now = new Date();
    const mLbl = i => { const mo = (now.getMonth() + i) % 12 + 1; const yr = (now.getFullYear() + Math.floor((now.getMonth() + i) / 12)) % 100; return `${mo}/${String(yr).padStart(2, "0")}`; };
    const W = opts.W || 900, H = 170;
    const hasR = series.some(s => s.axis === "R");
    const lgCols = W < 600 ? 2 : series.length;
    const lgRows = Math.ceil(series.length / lgCols);
    const P = { t: 10 + lgRows * 12, r: 46, b: 20, l: 46 };
    const every = W < 600 ? 4 : 2; // x-label density
    const pw = W - P.l - P.r, ph = H - P.t - P.b;
    const x = i => P.l + (n <= 1 ? 0 : (pw * i) / (n - 1));
    const maxOf = ax => Math.max(...series.filter(s => s.axis === ax).flatMap(s => s.vals), 1e-9) * 1.05;
    const Lmax = maxOf("L"), Rmax = hasR ? maxOf("R") : 1;
    const y = (v, ax) => P.t + ph - (v / (ax === "R" ? Rmax : Lmax)) * ph;
    const fmtT = v => Math.abs(v) >= 1000 ? fmtBig(Math.round(v)) : (Math.round(v * 10) / 10).toString();
    const lgW = (W - P.l - 10) / lgCols;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", marginTop: 8 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
          const gy = P.t + ph - f * ph;
          return <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={gy} y2={gy} stroke="rgba(255,255,255,0.05)" />
            <text x={P.l - 6} y={gy + 3} textAnchor="end" fontSize={8} fill="rgba(255,255,255,0.3)" fontFamily={F}>{fmtT(f * Lmax)}</text>
            {hasR && <text x={W - P.r + 6} y={gy + 3} textAnchor="start" fontSize={8} fill="rgba(255,255,255,0.3)" fontFamily={F}>{fmtT(f * Rmax)}</text>}
          </g>;
        })}
        {Array.from({ length: n }, (_, i) => i % every === 0 && (
          <text key={"x" + i} x={x(i)} y={P.t + ph + 12} textAnchor="middle" fontSize={7.5} fill="rgba(255,255,255,0.35)" fontFamily={F}>{mLbl(i)}</text>
        ))}
        {series.map(s => (
          <g key={s.label}>
            <polyline points={s.vals.map((v, i) => `${x(i).toFixed(1)},${y(v, s.axis).toFixed(1)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={1.5} strokeDasharray={s.dash} opacity={0.9} />
            {s.vals.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v, s.axis)} r={1.6} fill={s.color} opacity={0.55}>
                <title>{`${s.label} — ${mLbl(i)}: ${fmtT(v)}${s.unit ? " " + s.unit : ""}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {series.map((s, si) => {
          const lx = P.l + (si % lgCols) * lgW;
          const ly = 10 + Math.floor(si / lgCols) * 12;
          return <g key={"lg" + s.label}>
            <line x1={lx} x2={lx + 13} y1={ly} y2={ly} stroke={s.color} strokeWidth={1.5} strokeDasharray={s.dash} />
            <text x={lx + 17} y={ly + 3} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>{`${s.label}${hasR ? ` (${s.axis})` : ""}`}</text>
          </g>;
        })}
      </svg>
    );
  };
  const [modelMix, setModelMix] = useBookStore(MODEL_MIX_STORE);
  const setMixField = (id, field, value) => setModelMix(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  const baseIdx = useMemo(() => baselineIdx(baseline, COHORT_MONTHS), [baseline]);
  const [pricing, setPricing] = useBookStore(PRICING_STORE);
  const cohortAgg = useMemo(() => cohortSeries(cohorts, COHORT_MONTHS, baseIdx, pricing), [cohorts, baseIdx, pricing]);
  // ── Cohort series for ALL three scenarios (for the summary chart overlays).
  // The active scenario's live edits sit in `cohorts`; the other two live in
  // SCENARIO_COHORTS which is only re-synced on scenario toggle. So we source
  // the active scenario from `cohorts` and the inactive ones from the map.
  const scenarioSeries = useMemo(() => {
    const out = {};
    for (const s of ["weak", "base", "strong"]) {
      const src = s === scenario ? cohorts : SCENARIO_COHORTS[s];
      out[s] = src ? cohortSeries(src, COHORT_MONTHS, baseIdx, pricing) : null;
    }
    return out;
  }, [cohorts, scenario, baseIdx, pricing]);
  // Collapsible panels: keys "seg-{id}" and "leaf-{id}"; start with region
  // leaves collapsed beyond the first segment so the table opens readable.
  const [collapsed, setCollapsed] = useState(() => new Set(["seg-2","seg-3","leaf-12","leaf-13","leaf-21","leaf-22","leaf-23","leaf-24","leaf-31","leaf-32","leaf-33","leaf-34"]));
  const toggleCollapse = (key) => setCollapsed(prev => { const nx = new Set(prev); nx.has(key) ? nx.delete(key) : nx.add(key); return nx; });
  const [tokPerHr, setTokPerHr] = useBookStore(TOKPERHR_STORE);
  const [normMode] = useState("flops");

  // Training sizer
  const [tParams, setTParams] = useState(70);
  const [tTokens, setTTokens] = useState(15);
  const [tDays, setTDays] = useState(30);
  const [tMfu, setTMfu] = useState(40);
  // Inference sizer
  const [iModel, setIModel] = useState("l70");
  const [iQuant, setIQuant] = useState(1);   // bytes/param: 2=FP16, 1=FP8
  const [iIn, setIIn] = useState(4096);
  const [iOut, setIOut] = useState(512);
  const [iRPS, setIRPS] = useState(50);
  const [iTpot, setITpot] = useState(40);    // latency SLA: ms per output token
  const [iEff, setIEff] = useState(80);
  const [inclPipeline, setInclPipeline] = useState(true);

  // ── Demand aggregates — from the cohort build (single source of truth) ──
  const dAgg = useMemo(() => {
    const infH = cohortAgg.infBase, trainH = cohortAgg.trainBase;
    const mrr = infH * pricing.infPrice * HRS_MO; // inference book at current price
    const trainRunRate = trainH * pricing.trainPrice * HRS_MO;
    return { infH, trainH, totalH100e: infH + trainH, mrr, trainRunRate };
  }, [cohortAgg, pricing]);

  // ── Supply capacity by GPU class (active) ──
  const supplyByClass = useMemo(() => {
    const m = {};
    for (const r of supply.filter(r => r.status === "active")) {
      m[r.gpu] = m[r.gpu] || { gpus: 0, h100e: 0, maxCluster: 0 };
      m[r.gpu].gpus += r.gpus;
      m[r.gpu].h100e += h100eOf(r.gpu, r.gpus, normMode);
      m[r.gpu].maxCluster = Math.max(m[r.gpu].maxCluster, Math.floor(r.gpus * liveFracOf(r, 1)));
    }
    return m;
  }, [supply, normMode]);

  // ── Supply/demand reconciliation by GPU class ──
  const recon = useMemo(() => {
    const rows = demand.filter(r => inclPipeline || r.status === "committed");
    const demByClass = {};
    for (const r of rows) {
      demByClass[r.gpu] = demByClass[r.gpu] || { gpus: 0, h100e: 0 };
      demByClass[r.gpu].gpus += r.gpus;
      demByClass[r.gpu].h100e += h100eOf(r.gpu, r.gpus, normMode);
    }
    const classes = Array.from(new Set([...Object.keys(supplyByClass), ...Object.keys(demByClass)]));
    const order = Object.keys(DGPU);
    return classes.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(gpu => {
      const sup = supplyByClass[gpu] || { gpus: 0, h100e: 0, maxCluster: 0 };
      const dem = demByClass[gpu] || { gpus: 0, h100e: 0 };
      const gap = sup.gpus - dem.gpus; // + = surplus, − = short
      const cover = dem.gpus > 0 ? Math.min(1, sup.gpus / dem.gpus) : (sup.gpus > 0 ? 1 : 0);
      return { gpu, sup, dem, gap, cover };
    });
  }, [supplyByClass, demand, inclPipeline, normMode]);

  // Aggregate balance
  const bal = useMemo(() => {
    // Utilization is measured against DELIVERED capacity — undelivered ramping
    // supply can't serve demand today. Contracted total shown alongside.
    const act = supply.filter(r => r.status === "active");
    const supH = act.reduce((s, r) => s + h100eOf(r.gpu, r.gpus, normMode) * liveFracOf(r, 1), 0);
    const supHContracted = act.reduce((s, r) => s + h100eOf(r.gpu, r.gpus, normMode), 0);
    // Utilization compares like with like: cohort-build demand THIS MONTH vs
    // supply DELIVERED this month — the same numbers Projections month 1 sees.
    const demNowH = dAgg.totalH100e;
    return { supH, supHContracted, demH: demNowH, demNowH, util: supH > 0 ? demNowH / supH : 0, freeH: Math.max(0, supH - demNowH), shortH: Math.max(0, demNowH - supH) };
  }, [supply, dAgg, normMode]);

  // ── Monthly supply-vs-demand curve (next 12 months, H100e) ──
  //   Base scenario is shown as the stacked demand bar; weak/strong totals
  //   are overlaid as dashed lines so the fan of scenarios is visible against
  //   the same supply bar.
  const monthly = useMemo(() => {
    const rsv = supply.filter(r => r.status === "active");
    const rows = demand.filter(r => inclPipeline || r.status === "committed");
    const now = new Date();
    const lbl = i => { const mo = (now.getMonth() + i) % 12 + 1; const yr = (now.getFullYear() + Math.floor((now.getMonth() + i) / 12)) % 100; return `${mo}/${String(yr).padStart(2, "0")}`; };
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const sup = rsv.reduce((s, r) => s + ((r.structure !== "reserved" || r.remMo >= m) ? h100eOf(r.gpu, r.gpus, normMode) * liveFracOf(r, m) : 0), 0);
      const demTrain = cohortAgg.train[i] || 0, demInf = cohortAgg.inf[i] || 0;
      const demWeak = ((scenarioSeries.weak?.train?.[i] || 0) + (scenarioSeries.weak?.inf?.[i] || 0));
      const demBase = ((scenarioSeries.base?.train?.[i] || 0) + (scenarioSeries.base?.inf?.[i] || 0));
      const demStrong = ((scenarioSeries.strong?.train?.[i] || 0) + (scenarioSeries.strong?.inf?.[i] || 0));
      return { label: lbl(i), sup, dem: demTrain + demInf, demTrain, demInf, demWeak, demBase, demStrong };
    });
  }, [supply, cohortAgg, scenarioSeries, normMode]);

  // ── Supply vs demand by region (delivered supply, active) ──
  // Region reconciliation: both demand (cohort) and supply now use the same
  // granular region labels (US-East, US-West, EU, …). Only fold supply's extra
  // buckets (Nordics → EU, Global/mixed → its own line) so the two sides align.
  const macroRegion = rg => rg === "Nordics" ? "EU" : rg;
  const byRegion = useMemo(() => {
    const sMap = {}, dBase = {}, dWeak = {}, dStrong = {};
    for (const r of supply.filter(r => r.status === "active")) { const mr = macroRegion(r.region); sMap[mr] = (sMap[mr] || 0) + h100eOf(r.gpu, r.gpus, normMode) * liveFracOf(r, 1); }
    const fillFromSeries = (map, ser) => {
      if (!ser) return;
      Object.entries(ser.perReg).forEach(([rg, s]) => { const mr = macroRegion(rg); map[mr] = (map[mr] || 0) + (s.inf[0] || 0) + (s.train[0] || 0); });
    };
    fillFromSeries(dBase, scenarioSeries.base);
    fillFromSeries(dWeak, scenarioSeries.weak);
    fillFromSeries(dStrong, scenarioSeries.strong);
    const regions = Array.from(new Set([...Object.keys(sMap), ...Object.keys(dBase), ...Object.keys(dWeak), ...Object.keys(dStrong)]))
      .filter(rg => (sMap[rg] || 0) > 0.5 || (dBase[rg] || 0) > 0.5 || (dWeak[rg] || 0) > 0.5 || (dStrong[rg] || 0) > 0.5);
    return regions.map(rg => ({
      region: rg,
      sup: sMap[rg] || 0,
      dem: dBase[rg] || 0,
      demWeak: dWeak[rg] || 0,
      demBase: dBase[rg] || 0,
      demStrong: dStrong[rg] || 0,
      gap: (sMap[rg] || 0) - (dBase[rg] || 0),
    }));
  }, [supply, scenarioSeries, normMode]);

  // ── Serveable supply per model (VRAM + fabric fit on delivered clusters) ──
  // For each open model, how much of the fleet can actually host it: sum the
  // delivered GPUs on positions whose contiguous cluster meets the model's
  // min-pool at FP8, on a fabric that can pool that wide. Small/old GPUs and
  // Ethernet positions drop out for the big models.
  const serveByModel = useMemo(() => {
    const act = supply.filter(r => r.status === "active");
    const demByModel = {};
    for (const r of demand.filter(r => inclPipeline || r.status === "committed")) if (r.model) demByModel[r.model] = (demByModel[r.model] || 0) + h100eOf(r.gpu, r.gpus, normMode);
    return MODELS.map(m => {
      let serveGpus = 0, serveH = 0;
      for (const r of act) {
        const cap = POOL_CAP[FAB_CLASS(r.ic)] || 1;
        const pool = minPool(m, r.gpu, 1, cap); // FP8 weights
        const delivered = Math.floor(r.gpus * liveFracOf(r, 1));
        if (pool != null && delivered >= pool) { serveGpus += delivered; serveH += h100eOf(r.gpu, delivered, normMode); }
      }
      return { key: m.key, label: m.label, paramsB: m.paramsB, moe: m.moe, serveGpus, serveH, demH: demByModel[m.key] || 0 };
    });
  }, [supply, demand, inclPipeline, normMode]);

  // ── Training run sizing (GPU as output) ──
  const run = useMemo(() => sizeTrainingRun({ paramsB: tParams, tokensT: tTokens, days: tDays, mfu: tMfu }), [tParams, tTokens, tDays, tMfu]);
  const tbest = run.best;
  // ── Inference run sizing ──
  const irun = useMemo(() => sizeInferenceRun({ modelKey: iModel, bytesPerParam: iQuant, avgIn: iIn, avgOut: iOut, targetRPS: iRPS, eff: iEff / 100, tpotMs: iTpot }), [iModel, iQuant, iIn, iOut, iRPS, iEff, iTpot]);
  const best = irun.best;
  const maxMonthly = Math.max(...monthly.map(m => Math.max(m.sup, m.dem, m.demWeak, m.demBase, m.demStrong)), 1);

  return (
    <div style={{ minHeight: "100vh", background: "#0b1118", color: "#e2e8f0", fontFamily: F, padding: "18px 20px 40px" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Compute Demand <span style={{ color: "#fbbf24" }}>— customer-driven demand build & workload modelers</span></div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
            Build demand bottoms-up from customer segments (this feeds the Projections tab), see summary stats reconciled against the supply book, and use the workload modelers to translate specific training/inference jobs into the H100-equivalent footprint they'd add.
          </div>
        </div>

        <SectionHeader title="Demand Scenarios" right={
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, overflow: "hidden" }}>
              {Object.entries(DEMAND_SCENARIO_DEFS).map(([k, d]) => (
                <button key={k} onClick={() => switchScenario(k)} style={{
                  background: scenario === k ? d.color + "26" : "transparent",
                  color: scenario === k ? d.color : "rgba(255,255,255,0.4)",
                  border: "none", borderLeft: k !== "weak" ? "1px solid rgba(255,255,255,0.1)" : "none",
                  fontFamily: F, fontSize: 9.5, fontWeight: scenario === k ? 700 : 500,
                  letterSpacing: "0.06em", textTransform: "uppercase",
                  padding: "4px 14px", cursor: "pointer",
                }}>{d.label}</button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9.5, fontFamily: F }}>
              <span style={{ color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Probabilities:</span>
              {["weak", "base", "strong"].map(k => (
                <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={`prior probability of the ${k} scenario — used by the Compute Supply engine to weight expected values`}>
                  <span style={{ color: DEMAND_SCENARIO_DEFS[k].color, fontWeight: 700 }}>{DEMAND_SCENARIO_DEFS[k].label.charAt(0)}</span>
                  <input type="number" min={0} max={100} step={5} value={probPct[k]} onChange={e => {
                    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                    setProbPct(prev => {
                      const next = { ...prev, [k]: v };
                      const sum = next.weak + next.base + next.strong;
                      if (sum > 0 && sum !== 100) {
                        const otherKeys = ["weak", "base", "strong"].filter(x => x !== k);
                        const otherSum = otherKeys.reduce((s, x) => s + prev[x], 0);
                        if (otherSum > 0) {
                          const scale = (100 - v) / otherSum;
                          otherKeys.forEach(x => { next[x] = Math.round(prev[x] * scale); });
                        }
                      }
                      return next;
                    });
                  }} style={{ width: 42, padding: "2px 4px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: DEMAND_SCENARIO_DEFS[k].color, fontSize: 10, fontFamily: F, textAlign: "right" }} />
                  <span style={{ color: "rgba(255,255,255,0.3)" }}>%</span>
                </label>
              ))}
              <span style={{ color: (probPct.weak + probPct.base + probPct.strong) === 100 ? "rgba(255,255,255,0.3)" : "#f87171", fontSize: 9 }}>
                Σ = {probPct.weak + probPct.base + probPct.strong}%
              </span>
            </div>
          </div>
        } />

        {/* Scenario descriptions — what each toggle position assumes and why */}
        <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", lineHeight: 1.6, marginBottom: 12, padding: "10px 12px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 8 }}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: "#f87171", fontWeight: 700 }}>WEAK — capex digestion.</span> Enterprise AI budgets hit CFO scrutiny: net adds stall, churn ticks up as marginal training runs consolidate onto hyperscaler credits. The startup funding window closes, lifting failure rates; the individual tier decays toward free and serverless endpoints. Frontier efficiency gains get captured as cost savings rather than more usage, so per-customer footprints lag the workload baselines (flex cut deeply negative).
          </div>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: "#67e8f9", fontWeight: 700 }}>BASE — steady adoption.</span> Current course: enterprises expand steadily and ride the frontier hardest (+25/+30 flex), the startup funnel stays healthy with typical failure rates, and individuals remain a high-churn long-tail acquisition channel whose footprints lag the frontier (smaller models, shorter contexts).
          </div>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: "#6ee7b7", fontWeight: 700 }}>STRONG — agentic inflection.</span> Reasoning and agent workloads inflect per-customer consumption: a second wave of enterprise adoption accelerates adds while multi-year commitments compress churn to near zero; startup formation booms and the individual tier grows virally. Footprints overshoot the workload baselines across every segment (flex raised broadly).
          </div>
          <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.3)", marginTop: 6 }}>
            Each scenario diverges on two axes: (1) starting book — segment-level custBase multipliers scale today's customer count (enterprise stickiest, individuals most volatile) so month-1 demand and run-rate revenue reflect the scenario; (2) trajectory — net adds, churn, and baseline flex determine how the book compounds. Every assumption below stays editable; each scenario keeps its own copy of the build, so edits survive toggling away and back.
          </div>
        </div>

        {/* ═════════════════════════════════════════════════════════════════════
            SUMMARY STATS — moved to the top of the tab so the reconciliation
            of the demand build against the supply book is the first thing
            visible after the scenario framing. Charts show all three scenarios
            (weak/base/strong) so the fan of outcomes is visible against the
            same supply bar rather than requiring the user to toggle.
            ═════════════════════════════════════════════════════════════════════ */}
        <SectionHeader title="Summary Stats" />

        {/* Balance headline */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <Metric label="Demand (H100e)" value={fmtBig(Math.round(bal.demNowH))} sub={`from cohort build · ${fmtBig(dAgg.trainH)} train / ${fmtBig(dAgg.infH)} inf`} accent={CY} />
          <Metric label="Supply (H100e)" value={fmtBig(Math.round(bal.supH))} sub={bal.supHContracted - bal.supH > 0.5 ? `delivered today · ${fmtBig(Math.round(bal.supHContracted))} contracted incl. ramps` : "active fleet, all structures"} />
          <Metric label="Fleet utilization" value={fmtPct(bal.util)} sub={bal.shortH > 0 ? `this month · ${fmtBig(Math.round(bal.shortH))} H100e SHORT` : `this month · ${fmtBig(Math.round(bal.freeH))} H100e idle`} accent={bal.util > 1 ? "#f87171" : bal.util > 0.85 ? "#6ee7b7" : "#fbbf24"} warn={bal.util > 1} />
          <Metric label="Inference revenue run-rate" value={fmtUSD(dAgg.mrr)} sub={`${fmtBig(dAgg.infH)} H100e × ${fmtUSD(pricing.infPrice, 2)}/hr`} />
          <Metric label="Training revenue run-rate" value={fmtUSD(dAgg.trainRunRate)} sub={`${fmtBig(dAgg.trainH)} H100e × ${fmtUSD(pricing.trainPrice, 2)}/hr`} />
        </div>

        {/* Monthly supply vs demand — base scenario stacked as bars; weak/strong
            demand totals overlaid as dashed lines so the scenario fan is visible
            against the same supply bar. */}
        <Section title="Supply vs. demand by month (H100e) — is committed capacity covered across scenarios?" style={{ marginBottom: 12 }}>
          <svg viewBox="0 0 900 200" style={{ width: "100%", height: "auto" }}>
            {(() => {
              const W = 900, H = 200, P = { t: 14, r: 10, b: 26, l: 44 };
              const pw = W - P.l - P.r, ph = H - P.t - P.b;
              const n = monthly.length, gap = pw / n, bw = gap * 0.34;
              const y = v => P.t + ph - (v / maxMonthly) * ph;
              const xc = i => P.l + gap * i + gap / 2;
              const WEAK = "#f87171", BASE_L = "#67e8f9", STRONG = "#6ee7b7";
              const linePoints = key => monthly.map((m, i) => `${(xc(i) + 1 + bw / 2).toFixed(1)},${y(m[key]).toFixed(1)}`).join(" ");
              return <>
                {[0, maxMonthly / 2, maxMonthly].map((v, i) => <g key={i}>
                  <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
                  <text x={P.l - 6} y={y(v) + 3} textAnchor="end" fontSize={8} fill="rgba(255,255,255,0.3)" fontFamily={F}>{fmtBig(Math.round(v))}</text>
                </g>)}
                {monthly.map((m, i) => {
                  const cx = xc(i);
                  const short = m.dem > m.sup;
                  const baseY = P.t + ph;
                  const infH = baseY - y(m.demInf);
                  const trH = (baseY - y(m.dem)) - infH;
                  return <g key={m.label}>
                    <rect x={cx - bw - 1} y={y(m.sup)} width={bw} height={baseY - y(m.sup)} fill="#6ee7b7" opacity={0.55} rx={1}><title>{`${m.label} supply: ${fmtBig(Math.round(m.sup))} H100e`}</title></rect>
                    <rect x={cx + 1} y={y(m.demInf)} width={bw} height={infH} fill={CY} opacity={0.75} rx={1}><title>{`${m.label} inference demand (base): ${fmtBig(Math.round(m.demInf))} H100e`}</title></rect>
                    <rect x={cx + 1} y={y(m.dem)} width={bw} height={Math.max(trH, m.demTrain > 0 ? 1 : 0)} fill="#c4b5fd" opacity={0.8} rx={1}><title>{`${m.label} training demand (base): ${fmtBig(Math.round(m.demTrain))} H100e`}</title></rect>
                    {short && <text x={cx + 1 + bw / 2} y={y(m.dem) - 2} textAnchor="middle" fontSize={7} fill="#f87171" fontFamily={F}>⚠</text>}
                    <text x={cx} y={baseY + 11} textAnchor="middle" fontSize={7.5} fill={short ? "rgba(248,113,113,0.8)" : "rgba(255,255,255,0.35)"} fontFamily={F}>{m.label}</text>
                  </g>;
                })}
                {/* Scenario overlay lines — weak & strong total demand */}
                <polyline points={linePoints("demWeak")} fill="none" stroke={WEAK} strokeWidth={1.4} strokeDasharray="4 3" opacity={0.9} />
                <polyline points={linePoints("demStrong")} fill="none" stroke={STRONG} strokeWidth={1.4} strokeDasharray="4 3" opacity={0.9} />
                {monthly.map((m, i) => <g key={"sp" + i}>
                  <circle cx={xc(i) + 1 + bw / 2} cy={y(m.demWeak)} r={1.8} fill={WEAK}><title>{`${m.label} WEAK demand: ${fmtBig(Math.round(m.demWeak))} H100e`}</title></circle>
                  <circle cx={xc(i) + 1 + bw / 2} cy={y(m.demStrong)} r={1.8} fill={STRONG}><title>{`${m.label} STRONG demand: ${fmtBig(Math.round(m.demStrong))} H100e`}</title></circle>
                </g>)}
                {/* Legend */}
                <rect x={P.l} y={P.t} width={9} height={9} fill="#6ee7b7" opacity={0.55} /><text x={P.l + 13} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>supply</text>
                <rect x={P.l + 58} y={P.t} width={9} height={9} fill={CY} opacity={0.75} /><text x={P.l + 71} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>inference (base)</text>
                <rect x={P.l + 158} y={P.t} width={9} height={9} fill="#c4b5fd" opacity={0.8} /><text x={P.l + 171} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>training (base)</text>
                <line x1={P.l + 250} x2={P.l + 265} y1={P.t + 4} y2={P.t + 4} stroke={WEAK} strokeWidth={1.4} strokeDasharray="4 3" /><text x={P.l + 269} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>weak total</text>
                <line x1={P.l + 335} x2={P.l + 350} y1={P.t + 4} y2={P.t + 4} stroke={STRONG} strokeWidth={1.4} strokeDasharray="4 3" /><text x={P.l + 354} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>strong total</text>
              </>;
            })()}
          </svg>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 4 }}>
            Paired bars per month: available supply (reserved still under contract, scaled by delivery ramp, + on-demand/spot) vs. base-scenario demand (training + inference stacked). Dashed lines are total demand under the <span style={{ color: "#f87171" }}>weak</span> and <span style={{ color: "#6ee7b7" }}>strong</span> scenarios — the fan of possible demand paths against the same supply. A red ⚠ marks a month where base demand exceeds supply.
          </div>
        </Section>

        {/* Reconciliation by region — scenario range shown as tick marks around
            the base bar. */}
        <Section title="Supply vs. demand by region (H100e) — coverage across scenarios" style={{ marginBottom: 12 }}>
          <svg viewBox="0 0 900 200" style={{ width: "100%", height: "auto" }}>
            {(() => {
              const W = 900, H = 200, P = { t: 14, r: 10, b: 40, l: 44 };
              const pw = W - P.l - P.r, ph = H - P.t - P.b;
              const n = Math.max(byRegion.length, 1), gap = pw / n, bw = gap * 0.3;
              const maxV = Math.max(...byRegion.map(r => Math.max(r.sup, r.demBase, r.demWeak, r.demStrong)), 1);
              const y = v => P.t + ph - (v / maxV) * ph;
              const WEAK = "#f87171", STRONG = "#6ee7b7";
              return <>
                {[0, maxV / 2, maxV].map((v, i) => <g key={i}>
                  <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
                  <text x={P.l - 6} y={y(v) + 3} textAnchor="end" fontSize={8} fill="rgba(255,255,255,0.3)" fontFamily={F}>{fmtBig(Math.round(v))}</text>
                </g>)}
                {byRegion.map((r, i) => {
                  const xc = P.l + gap * i + gap / 2;
                  const short = r.demBase > r.sup;
                  const dx0 = xc + 1, dx1 = xc + 1 + bw;
                  return <g key={r.region}>
                    {/* Supply bar (left) */}
                    <rect x={xc - bw - 1} y={y(r.sup)} width={bw} height={P.t + ph - y(r.sup)} fill="#6ee7b7" opacity={0.55} rx={1}><title>{`${r.region} supply: ${fmtBig(Math.round(r.sup))} H100e`}</title></rect>
                    {/* Base demand bar (right) */}
                    <rect x={dx0} y={y(r.demBase)} width={bw} height={P.t + ph - y(r.demBase)} fill={short ? "#f87171" : CY} opacity={0.7} rx={1}><title>{`${r.region} demand (base): ${fmtBig(Math.round(r.demBase))} H100e`}</title></rect>
                    {/* Weak & strong tick marks across the demand bar */}
                    <line x1={dx0 - 2} x2={dx1 + 2} y1={y(r.demWeak)} y2={y(r.demWeak)} stroke={WEAK} strokeWidth={1.4} strokeDasharray="3 2"><title>{`${r.region} WEAK demand: ${fmtBig(Math.round(r.demWeak))} H100e`}</title></line>
                    <line x1={dx0 - 2} x2={dx1 + 2} y1={y(r.demStrong)} y2={y(r.demStrong)} stroke={STRONG} strokeWidth={1.4} strokeDasharray="3 2"><title>{`${r.region} STRONG demand: ${fmtBig(Math.round(r.demStrong))} H100e`}</title></line>
                    <text x={xc} y={P.t + ph + 11} textAnchor="middle" fontSize={7.5} fill={short ? "rgba(248,113,113,0.85)" : "rgba(255,255,255,0.4)"} fontFamily={F}>{r.region.replace("Global (mixed)", "Global")}</text>
                    <text x={xc} y={P.t + ph + 21} textAnchor="middle" fontSize={7} fill={short ? "#f87171" : "rgba(255,255,255,0.25)"} fontFamily={F}>{r.gap >= 0 ? "+" : ""}{fmtBig(Math.round(r.gap))}</text>
                  </g>;
                })}
                {/* Legend */}
                <rect x={P.l} y={P.t} width={9} height={9} fill="#6ee7b7" opacity={0.55} /><text x={P.l + 13} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>supply</text>
                <rect x={P.l + 58} y={P.t} width={9} height={9} fill={CY} opacity={0.7} /><text x={P.l + 71} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>demand (base)</text>
                <line x1={P.l + 155} x2={P.l + 170} y1={P.t + 4} y2={P.t + 4} stroke={WEAK} strokeWidth={1.4} strokeDasharray="3 2" /><text x={P.l + 174} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>weak</text>
                <line x1={P.l + 218} x2={P.l + 233} y1={P.t + 4} y2={P.t + 4} stroke={STRONG} strokeWidth={1.4} strokeDasharray="3 2" /><text x={P.l + 237} y={P.t + 8} fontSize={8.5} fill="rgba(255,255,255,0.5)" fontFamily={F}>strong</text>
              </>;
            })()}
          </svg>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 4, lineHeight: 1.5 }}>
            Delivered supply vs. base-scenario demand per region (gap under each label). Dashed tick marks show the same region's demand under the <span style={{ color: "#f87171" }}>weak</span> and <span style={{ color: "#6ee7b7" }}>strong</span> scenarios — the vertical range across the demand bar is your scenario band. Tokens can't be served across a data-residency boundary, so a fleet that's balanced in aggregate can still be short where demand actually sits.
          </div>
        </Section>

        <SectionHeader title="Demand Assumptions" />

        {/* ── Demand build: per-segment monthly drivers, months as columns (matches Projections) ── */}
        <Section title="Demand build — customer segments × regions, monthly drivers (feeds Projections)" style={{ marginBottom: 12 }}>
          {(() => {
            const n = COHORT_MONTHS;
            const now = new Date();
            const mLbl = i => { const mo = (now.getMonth() + i) % 12 + 1; const yr = (now.getFullYear() + Math.floor((now.getMonth() + i) / 12)) % 100; return `${mo}/${String(yr).padStart(2, "0")}`; };
            const bl = "1px solid rgba(255,255,255,0.04)";
            const INF_COL = "#67e8f9", TRAIN_COL = "#c4b5fd", NEUT_COL = "rgba(255,255,255,0.7)";
            const inpBase = { width: "100%", minWidth: 0, background: "transparent", border: "none", borderBottom: "1px dashed rgba(255,255,255,0.16)", fontFamily: F, fontSize: 9.5, fontWeight: 600, textAlign: "center", padding: "1px 0" };
            const lblCell = (txt, sub, opts = {}) => (
              <td style={{ padding: "3px 6px", paddingLeft: opts.indent ? 28 : 6, whiteSpace: "nowrap", color: opts.tone || (opts.strong ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.45)"), fontSize: 9.5, fontWeight: opts.strong ? 700 : 500, borderBottom: bl, borderTop: opts.topRule ? "1px solid rgba(255,255,255,0.1)" : undefined }}>
                <span>{txt}</span>{sub && <span style={{ fontSize: 7.5, color: "rgba(255,255,255,0.25)", fontWeight: 400, marginLeft: 4 }}>{sub}</span>}
              </td>
            );
            const derCell = (k, v, opts = {}) => (
              <td key={k} style={{ padding: "2px 1px", textAlign: "center", fontSize: opts.strong ? 9.5 : 9, fontWeight: opts.strong ? 700 : 400, color: opts.color || (opts.strong ? "#e2e8f0" : "rgba(255,255,255,0.5)"), borderBottom: bl, borderTop: opts.topRule ? "1px solid rgba(255,255,255,0.1)" : undefined }}>{v}</td>
            );
            const inCell = (k, value, onChange, step, col = NEUT_COL) => (
              <td key={k} style={{ padding: "2px 1px", borderBottom: bl }}>
                <input type="number" value={value} min={0} step={step} onChange={onChange} style={{ ...inpBase, color: GRW }} />
              </td>
            );
            const caret = (open) => <span style={{ display: "inline-block", width: 16, fontSize: 14, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>{open ? "▾" : "▸"}</span>;
            const fmtCust = c => c >= 100 ? Math.round(c).toLocaleString() : (Math.round(c * 10) / 10).toString();
            return (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: 1150, tableLayout: "fixed", borderCollapse: "collapse", fontFamily: F }}>
                  <colgroup>
                    <col style={{ width: 165 }} />
                    {Array.from({ length: n }, (_, i) => <col key={i} />)}
                  </colgroup>
                  <thead>
                    <tr>
                      <td style={{ fontSize: 8.5, color: "rgba(255,255,255,0.35)", padding: "0 6px 4px" }}>MONTH</td>
                      {Array.from({ length: n }, (_, i) => (
                        <td key={i} style={{ textAlign: "center", fontSize: 8.5, color: "rgba(255,255,255,0.4)", paddingBottom: 4, borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" }}>{(i % 2 === 0) ? mLbl(i) : ""}</td>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cohortAgg.perLeaf.map(({ seg, leaves }, si) => {
                      const segOpen = !collapsed.has("seg-" + seg.id);
                      const sTot = cohortAgg.perSeg.find(x => x.id === seg.id);
                      return (
                        <React.Fragment key={seg.id}>
                          {/* ── Segment header (collapsible) ── */}
                          <tr>
                            <td colSpan={n + 1} style={{ paddingTop: si === 0 ? 4 : 14 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span onClick={() => toggleCollapse("seg-" + seg.id)} style={{ cursor: "pointer", userSelect: "none" }}>{caret(segOpen)}</span>
                                <input value={seg.name} onChange={e => setSegName(seg.id, e.target.value)} style={{ background: "transparent", border: "none", borderBottom: "1px dashed rgba(226,232,240,0.25)", color: "#86efac", fontFamily: F, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 4px", width: 220 }} />
                                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{fmtBig(Math.round(sTot.inf[0]))} inf · {fmtBig(Math.round(sTot.train[0]))} train H100e now · {leaves.length} region{leaves.length > 1 ? "s" : ""}</span>
                                <button onClick={() => addRegion(seg.id)} style={{ marginLeft: "auto", background: "none", border: "1px solid rgba(226,232,240,0.2)", color: "rgba(226,232,240,0.7)", borderRadius: 4, fontSize: 8.5, fontFamily: F, padding: "2px 8px", cursor: "pointer" }}>+ region</button>
                                <button onClick={() => delSegment(seg.id)} style={{ background: "none", border: "none", color: "rgba(248,113,113,0.6)", cursor: "pointer", fontSize: 13 }} title="remove segment">×</button>
                              </div>
                            </td>
                          </tr>
                          {segOpen && leaves.map(({ leaf, series: ls }) => {
                            const leafOpen = !collapsed.has("leaf-" + leaf.id);
                            return (
                              <React.Fragment key={leaf.id}>
                                {/* ── Region sub-header (collapsible) ── */}
                                <tr>
                                  <td colSpan={n + 1} style={{ paddingTop: 6, paddingLeft: 14 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                      <span onClick={() => toggleCollapse("leaf-" + leaf.id)} style={{ cursor: "pointer", userSelect: "none" }}>{caret(leafOpen)}</span>
                                      <input value={leaf.region} onChange={e => setLeafField(seg.id, leaf.id, "region", e.target.value)} style={{ background: "transparent", border: "none", borderBottom: "1px dashed rgba(255,255,255,0.15)", color: "#86efac", fontFamily: F, fontSize: 10, fontWeight: 700, padding: "1px 4px", width: 90 }} />
                                      <span style={{ fontSize: 8.5, color: "rgba(255,255,255,0.28)" }}>{fmtCust(ls.cust[0])} customers · {fmtBig(Math.round(ls.inf[0]))} inf · {fmtBig(Math.round(ls.train[0]))} train H100e</span>
                                      <button onClick={() => delRegion(seg.id, leaf.id)} style={{ marginLeft: "auto", background: "none", border: "none", color: "rgba(248,113,113,0.45)", cursor: "pointer", fontSize: 11 }} title="remove region">×</button>
                                    </div>
                                  </td>
                                </tr>
                                {leafOpen && <>
                                  <tr>
                                    {lblCell("· Customers", "beg / adds% / churn%", { indent: true })}
                                    {Array.from({ length: n }, (_, i) => i === 0
                                      ? inCell("b" + leaf.id + i, leaf.custBase, e => setLeafField(seg.id, leaf.id, "custBase", Math.max(0, Number(e.target.value) || 0)), 1)
                                      : derCell("b" + leaf.id + i, fmtCust(ls.cust[i])))}
                                  </tr>
                                  <tr>
                                    {lblCell("· + Adds", "%/mo", { indent: true })}
                                    {Array.from({ length: n }, (_, i) => i === 0
                                      ? derCell("a" + leaf.id + i, "—")
                                      : inCell("a" + leaf.id + i, leaf.months[i].addsPct, e => setLeafMonth(seg.id, leaf.id, i, "addsPct", Math.max(0, Number(e.target.value) || 0)), 0.5))}
                                  </tr>
                                  <tr>
                                    {lblCell("· − Churn", "%/mo", { indent: true })}
                                    {Array.from({ length: n }, (_, i) => i === 0
                                      ? derCell("c" + leaf.id + i, "—")
                                      : inCell("c" + leaf.id + i, leaf.months[i].churnPct, e => setLeafMonth(seg.id, leaf.id, i, "churnPct", Math.max(0, Number(e.target.value) || 0)), 0.5))}
                                  </tr>
                                  {/* Workload anchors: month-1 scalars + baseline flex; the monthly
                                      trajectory is derived from the workload baselines below. */}
                                  <tr>
                                    <td colSpan={n + 1} style={{ padding: "4px 6px 2px 14px", borderBottom: bl }}>
                                      <span style={{ fontSize: 9, fontFamily: F, color: INF_COL }}>Inference anchor:</span>
                                      <input type="number" value={leaf.infPerCust} min={0} step={0.25} onChange={e => setLeafField(seg.id, leaf.id, "infPerCust", Math.max(0, Number(e.target.value) || 0))} style={{ ...inpBase, color: GRW, width: 52, display: "inline-block", margin: "0 3px" }} />
                                      <span style={{ fontSize: 8.5, fontFamily: F, color: "rgba(255,255,255,0.35)" }}>H100e/cust (mo 1) · baseline flex</span>
                                      <input type="number" value={leaf.infFlexPct} step={5} onChange={e => setLeafField(seg.id, leaf.id, "infFlexPct", Number(e.target.value) || 0)} style={{ ...inpBase, color: GRW, width: 44, display: "inline-block", margin: "0 3px" }} />
                                      <span style={{ fontSize: 8.5, fontFamily: F, color: "rgba(255,255,255,0.35)" }}>%</span>
                                      <span style={{ fontSize: 9, fontFamily: F, color: TRAIN_COL, marginLeft: 18 }}>Training anchor:</span>
                                      <input type="number" value={leaf.runsPerYr} min={0} step={1} onChange={e => setLeafField(seg.id, leaf.id, "runsPerYr", Math.max(0, Number(e.target.value) || 0))} style={{ ...inpBase, color: GRW, width: 36, display: "inline-block", margin: "0 3px" }} />
                                      <span style={{ fontSize: 8.5, fontFamily: F, color: "rgba(255,255,255,0.35)" }}>runs/yr ×</span>
                                      <input type="number" value={leaf.runSize} min={0} step={8} onChange={e => setLeafField(seg.id, leaf.id, "runSize", Math.max(0, Math.round(Number(e.target.value) || 0)))} style={{ ...inpBase, color: GRW, width: 48, display: "inline-block", margin: "0 3px" }} />
                                      <span style={{ fontSize: 8.5, fontFamily: F, color: "rgba(255,255,255,0.35)" }}>H100e ×</span>
                                      <input type="number" value={leaf.runDurMo} min={0} step={0.25} onChange={e => setLeafField(seg.id, leaf.id, "runDurMo", Math.max(0, Number(e.target.value) || 0))} style={{ ...inpBase, color: GRW, width: 42, display: "inline-block", margin: "0 3px" }} />
                                      <span style={{ fontSize: 8.5, fontFamily: F, color: "rgba(255,255,255,0.35)" }}>mo (mo 1) · baseline flex</span>
                                      <input type="number" value={leaf.trainFlexPct} step={5} onChange={e => setLeafField(seg.id, leaf.id, "trainFlexPct", Number(e.target.value) || 0)} style={{ ...inpBase, color: GRW, width: 44, display: "inline-block", margin: "0 3px" }} />
                                      <span style={{ fontSize: 8.5, fontFamily: F, color: "rgba(255,255,255,0.35)" }}>%</span>
                                    </td>
                                  </tr>
                                  <tr>
                                    {lblCell("· Inference", "H100e", { strong: true, topRule: true, tone: INF_COL, indent: true })}
                                    {Array.from({ length: n }, (_, i) => derCell("ei" + leaf.id + i, fmtBig(Math.round(ls.inf[i])), { strong: true, color: INF_COL, topRule: true }))}
                                  </tr>
                                  <tr>
                                    {lblCell("· Training", "H100e", { strong: true, tone: TRAIN_COL, indent: true })}
                                    {Array.from({ length: n }, (_, i) => derCell("et" + leaf.id + i, fmtBig(Math.round(ls.train[i])), { strong: true, color: TRAIN_COL }))}
                                  </tr>
                                </>}
                              </React.Fragment>
                            );
                          })}
                          {segOpen && (
                            <tr>
                              {lblCell(seg.name + " total", "H100e", { strong: true, topRule: true })}
                              {Array.from({ length: n }, (_, i) => derCell("st" + seg.id + i, fmtBig(Math.round(sTot.inf[i] + sTot.train[i])), { strong: true, topRule: true }))}
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    <tr>
                      <td colSpan={n + 1} style={{ paddingTop: 14 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.04em", color: "#e2e8f0", padding: "2px 4px" }}>All segments</div>
                      </td>
                    </tr>
                    <tr>
                      {lblCell("Inference", "H100e", { strong: true, topRule: true, tone: INF_COL })}
                      {Array.from({ length: n }, (_, i) => derCell("ti" + i, fmtBig(Math.round(cohortAgg.inf[i])), { strong: true, color: INF_COL, topRule: true }))}
                    </tr>
                    <tr>
                      {lblCell("Training", "H100e", { strong: true, tone: TRAIN_COL })}
                      {Array.from({ length: n }, (_, i) => derCell("tt" + i, fmtBig(Math.round(cohortAgg.train[i])), { strong: true, color: TRAIN_COL }))}
                    </tr>
                    <tr>
                      {lblCell("Total demand", "H100e", { strong: true, topRule: true })}
                      {Array.from({ length: n }, (_, i) => derCell("td" + i, fmtBig(Math.round(cohortAgg.inf[i] + cohortAgg.train[i])), { strong: true, topRule: true }))}
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })()}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
            <button onClick={addSegment} style={{ background: "rgba(103,232,249,0.08)", border: "1px solid rgba(103,232,249,0.3)", color: CY, borderRadius: 5, fontSize: 10, fontFamily: F, padding: "5px 12px", cursor: "pointer" }}>+ ADD SEGMENT</button>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", lineHeight: 1.5 }}>
              Click ▸ to expand/collapse. <span style={{ color: "#67e8f9" }}>Cyan = inference</span>, <span style={{ color: "#c4b5fd" }}>violet = training</span>. Customer counts roll forward monthly (Ending = Beginning × (1 + adds − churn)). Workload footprints anchor at month 1, then scale by the baseline index (below) and each cohort's ± flex modifier. Totals feed Projections.
            </span>
          </div>
          {(() => {
            const pal = [CY, "#c4b5fd", "#fbbf24", "#6ee7b7", "#f87171", "#60a5fa"];
            const sum = (a, b) => a.map((v, i) => v + b[i]);
            const segSeries = cohortAgg.perSeg.map((s, i) => ({ label: s.name, unit: "H100e", axis: "L", color: pal[i % pal.length], vals: sum(s.inf, s.train) }));
            const regSeries = Object.entries(cohortAgg.perReg).map(([reg, v], i) => ({ label: reg, unit: "H100e", axis: "L", color: pal[i % pal.length], vals: sum(v.inf, v.train) }));
            const kindSeries = [
              { label: "inference", unit: "H100e", axis: "L", color: CY, vals: cohortAgg.inf },
              { label: "training", unit: "H100e", axis: "L", color: "#c4b5fd", vals: cohortAgg.train },
            ];
            const cap = t => <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", fontFamily: F, marginTop: 12 }}>{t}</div>;
            return (
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 300px", minWidth: 280 }}>{cap("H100e demand by customer type")}{paramChart(segSeries, { W: 440 })}</div>
                <div style={{ flex: "1 1 300px", minWidth: 280 }}>{cap("H100e demand by region")}{paramChart(regSeries, { W: 440 })}</div>
                <div style={{ flex: "1 1 300px", minWidth: 280 }}>{cap("H100e demand by workload")}{paramChart(kindSeries, { W: 440 })}</div>
              </div>
            );
          })()}
        </Section>

        {/* LLM model mix — share of inference demand by served model */}
        {/* Training & inference workload baselines */}
        <SectionHeader title="Training and Inference Modelers" />
        <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.35)", marginTop: -4, marginBottom: 12, lineHeight: 1.5 }}>
          Monthly baseline assumptions for typical training runs and inference deployments. Each table rolls up to a <b style={{ color: "rgba(255,255,255,0.55)" }}>baseline index</b> (month 1 = 1.00) that drives all cohort footprints above, scaled by each segment's ± flex modifier.
        </div>

        {(() => {
          const n = COHORT_MONTHS;
          const now = new Date();
          const mLbl = i => { const mo = (now.getMonth() + i) % 12 + 1; const yr = (now.getFullYear() + Math.floor((now.getMonth() + i) / 12)) % 100; return `${mo}/${String(yr).padStart(2, "0")}`; };
          const bl2 = "1px solid rgba(255,255,255,0.04)";
          const inpB = { width: "100%", minWidth: 0, background: "transparent", border: "none", borderBottom: "1px dashed rgba(255,255,255,0.16)", fontFamily: F, fontSize: 9.5, fontWeight: 600, textAlign: "center", padding: "1px 0" };
          const lblC = (txt, sub, tone) => (
            <td style={{ padding: "3px 6px", whiteSpace: "nowrap", color: tone || "rgba(255,255,255,0.45)", fontSize: 9.5, fontWeight: 500, borderBottom: bl2 }}>
              <span>{txt}</span>{sub && <span style={{ fontSize: 7.5, color: "rgba(255,255,255,0.25)", fontWeight: 400, marginLeft: 4 }}>{sub}</span>}
            </td>
          );
          const inC = (k, value, onChange, step, col) => (
            <td key={k} style={{ padding: "2px 1px", borderBottom: bl2 }}>
              <input type="number" value={value} min={0} step={step} onChange={onChange} style={{ ...inpB, color: GRW }} />
            </td>
          );
          const derC = (k, v, opts = {}) => (
            <td key={k} style={{ padding: "2px 1px", textAlign: "center", fontSize: 9.5, fontWeight: opts.strong ? 700 : 400, color: opts.color || "rgba(255,255,255,0.5)", borderBottom: bl2, borderTop: opts.topRule ? "1px solid rgba(255,255,255,0.1)" : undefined }}>{v}</td>
          );
          const header = (
            <thead>
              <tr>
                <td style={{ fontSize: 8.5, color: "rgba(255,255,255,0.35)", padding: "0 6px 4px" }}>MONTH</td>
                {Array.from({ length: n }, (_, i) => (
                  <td key={i} style={{ textAlign: "center", fontSize: 8.5, color: "rgba(255,255,255,0.4)", paddingBottom: 4, borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" }}>{(i % 2 === 0) ? mLbl(i) : ""}</td>
                ))}
              </tr>
            </thead>
          );
          const TR = "#c4b5fd", IN = "#67e8f9";
          const tRow = (label, sub, field, step, col) => (
            <tr>
              {lblC(label, sub, col)}
              {Array.from({ length: n }, (_, i) => inC(field + i, baseline.train[i][field], e => setBaseCell("train", i, field, Math.max(0, Number(e.target.value) || 0)), step, col))}
            </tr>
          );
          const iRow = (label, sub, field, step, col) => (
            <tr>
              {lblC(label, sub, col)}
              {Array.from({ length: n }, (_, i) => inC("i" + field + i, baseline.inf[i][field], e => setBaseCell("inf", i, field, Math.max(0, Number(e.target.value) || 0)), step, col))}
            </tr>
          );
          const fmtV = v => Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString();
          const inCg = (k, value, onChange) => (
            <td key={k} style={{ padding: "2px 1px", borderBottom: bl2 }}>
              <input type="number" value={value} step={0.5} onChange={onChange} style={{ ...inpB, color: GRW }} />
            </td>
          );
          // Growth-driven field: value row (month 1 = editable anchor, months 2+
          // derived) plus a growth-%/mo driver row (months 2+ editable).
          const growthRows = (kind, label, sub, field, anchorStep, col) => (
            <>
              <tr>
                {lblC(label, sub, col)}
                {Array.from({ length: n }, (_, i) => i === 0
                  ? inC(kind + field + i, baseline[kind][i][field], e => setBaseAnchor(kind, field, Math.max(0, Number(e.target.value) || 0)), anchorStep, col)
                  : derC(kind + field + i, fmtV(baseline[kind][i][field]), { color: "rgba(255,255,255,0.5)" }))}
              </tr>
              <tr>
                {lblC("↳ growth", "%/mo", "rgba(255,255,255,0.35)")}
                {Array.from({ length: n }, (_, i) => i === 0
                  ? derC(kind + field + "g" + i, "—", { color: "rgba(255,255,255,0.35)" })
                  : inCg(kind + field + "g" + i, baseline[kind][i][field + "G"], e => setBaseGrowth(kind, i, field, Number(e.target.value) || 0)))}
              </tr>
            </>
          );
          return (
            <>
              <Section title="Training baseline — the typical frontier run, by month" style={{ marginBottom: 12 }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", minWidth: 1150, tableLayout: "fixed", borderCollapse: "collapse", fontFamily: F }}>
                    <colgroup><col style={{ width: 165 }} />{Array.from({ length: n }, (_, i) => <col key={i} />)}</colgroup>
                    {header}
                    <tbody>
                      {growthRows("train", "Avg model size", "B params", "modelB", 5, TR)}
                      {growthRows("train", "Training tokens", "T", "tokensT", 1, TR)}
                      {tRow("Training time", "days", "days", 1, TR)}
                      {tRow("MFU", "%", "mfu", 1, TR)}
                      <tr>
                        {lblC("Implied run size", "H100e", TR)}
                        {Array.from({ length: n }, (_, i) => derC("rh" + i, fmtBig(Math.round(baselineRunH100e(baseline.train[i]))), { color: "rgba(196,181,253,0.6)" }))}
                      </tr>
                      <tr>
                        {lblC("Baseline index", "mo 1 = 1.00", TR)}
                        {Array.from({ length: n }, (_, i) => derC("ti" + i, baseIdx.trainIdx[i].toFixed(2) + "×", { strong: true, color: TR, topRule: true }))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 380px", minWidth: 320 }}>
                    {paramChart([
                      { label: "model size, B", unit: "B", axis: "L", color: TR, vals: baseline.train.map(r => r.modelB) },
                      { label: "training days", unit: "days", axis: "R", color: "#fbbf24", dash: "4 3", vals: baseline.train.map(r => r.days) },
                    ], { W: 440 })}
                  </div>
                  <div style={{ flex: "1 1 380px", minWidth: 320 }}>
                    {paramChart([
                      { label: "tokens, T", unit: "T", axis: "L", color: "#67e8f9", vals: baseline.train.map(r => r.tokensT) },
                      { label: "MFU %", unit: "%", axis: "R", color: "#6ee7b7", dash: "2 3", vals: baseline.train.map(r => r.mfu) },
                    ], { W: 440 })}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 6, lineHeight: 1.5 }}>
                  Model size and training tokens are growth-driven: the green %/mo row compounds each series from its month-1 anchor (months 2+ of the value row are derived); training time and MFU are direct-entry. Run FLOPs use the 6ND approximation. Implied run size = 6 × params × tokens ÷ (days × 86,400s × 989 TF × MFU) — the H100e one baseline run holds while training. The index ∝ params × tokens ÷ (days × MFU): bigger models and token budgets push concurrency up; longer wall-clock spreads the same FLOPs thinner. Cohort training footprints in the build scale with this index × their flex.
                </div>
              </Section>

              <Section title="Inference baseline — the typical serving workload, by month" style={{ marginBottom: 12 }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", minWidth: 1150, tableLayout: "fixed", borderCollapse: "collapse", fontFamily: F }}>
                    <colgroup><col style={{ width: 165 }} />{Array.from({ length: n }, (_, i) => <col key={i} />)}</colgroup>
                    {header}
                    <tbody>
                      {growthRows("inf", "Avg model size", "B active params", "modelB", 1, IN)}
                      {iRow("Weight precision", "bytes/param", "bytes", 0.25, IN)}
                      {growthRows("inf", "Input tokens", "/query", "inTok", 256, IN)}
                      {growthRows("inf", "Output tokens", "/query", "outTok", 64, IN)}
                      {iRow("Serving efficiency", "%", "effPct", 5, IN)}
                      <tr>
                        {lblC("Baseline index", "mo 1 = 1.00", IN)}
                        {Array.from({ length: n }, (_, i) => derC("ii" + i, baseIdx.infIdx[i].toFixed(2) + "×", { strong: true, color: IN, topRule: true }))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 380px", minWidth: 320 }}>
                    {paramChart([
                      { label: "input tok/query", unit: "tok", axis: "L", color: IN, vals: baseline.inf.map(r => r.inTok) },
                      { label: "output tok/query", unit: "tok", axis: "L", color: "#60a5fa", dash: "4 3", vals: baseline.inf.map(r => r.outTok) },
                    ], { W: 440 })}
                  </div>
                  <div style={{ flex: "1 1 380px", minWidth: 320 }}>
                    {paramChart([
                      { label: "active params, B", unit: "B", axis: "L", color: "#fbbf24", vals: baseline.inf.map(r => r.modelB) },
                      { label: "serving eff %", unit: "%", axis: "R", color: "#6ee7b7", dash: "2 3", vals: baseline.inf.map(r => r.effPct) },
                    ], { W: 440 })}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 6, lineHeight: 1.5 }}>
                  Model size and input/output tokens are growth-driven: the green %/mo row compounds each series from its month-1 anchor (months 2+ of the value row are derived); precision and efficiency are direct-entry. Index ∝ active params × bytes × (input + output tokens) ÷ efficiency — the bytes a deployment streams per query, the decode-roofline driver of footprint. Agentic use grows input tokens fastest (seeded ~90%/yr); a precision shift (1 → 0.5 bytes = FP8 → FP4) halves the index in one step. Avg model size should track the LLM demand mix above ({(() => { const tot = modelMix.reduce((a, r) => a + r.pct, 0) || 1; const w = modelMix.reduce((a, r) => a + r.pct * r.activeB, 0) / tot; return w.toFixed(0); })()}B mix-weighted active today). Cohort inference footprints scale with this index × their flex.
                </div>
              </Section>
            </>
          );
        })()}

        <Section title="Demand by LLM model — share of inference workload (uniform across customer types)" style={{ marginBottom: 12 }}>
          {(() => {
            const totPct = modelMix.reduce((a, r) => a + r.pct, 0);
            const wAct = totPct > 0 ? modelMix.reduce((a, r) => a + r.pct * r.activeB, 0) / totPct : 0;
            const wTot = totPct > 0 ? modelMix.reduce((a, r) => a + r.pct * r.paramsB, 0) / totPct : 0;
            const bigSharePct = totPct > 0 ? modelMix.filter(r => r.paramsB >= 70).reduce((a, r) => a + r.pct, 0) / totPct * 100 : 0;
            const maxPct = Math.max(...modelMix.map(r => r.pct), 1);
            return (
              <>
                <table style={{ width: "100%", maxWidth: 860, borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                  <thead><tr>
                    <th style={th("left")}>MODEL</th><th style={th()}>SHARE %</th><th style={th("left")}></th><th style={th()}>TOTAL PARAMS B</th><th style={th()}>ACTIVE PARAMS B</th><th style={th("left")}>SERVING PROFILE</th>
                  </tr></thead>
                  <tbody>
                    {modelMix.map(r => (
                      <tr key={r.id}>
                        <td style={td({ color: "#e2e8f0", whiteSpace: "nowrap" })}>{r.name}</td>
                        <td style={td({ textAlign: "right", width: 64 })}>
                          <input type="number" value={r.pct} min={0} max={100} step={5} onChange={e => setMixField(r.id, "pct", Math.max(0, Number(e.target.value) || 0))} style={{ width: 48, background: "transparent", border: "none", borderBottom: "1px dashed rgba(255,255,255,0.16)", color: GRW, fontFamily: F, fontSize: 10.5, fontWeight: 600, textAlign: "right", padding: "1px 2px" }} />
                        </td>
                        <td style={td({ width: 180 })}>
                          <div style={{ height: 6, background: "rgba(255,255,255,0.04)", borderRadius: 3 }}>
                            <div style={{ height: "100%", width: `${(r.pct / maxPct) * 100}%`, background: r.paramsB >= 70 ? "#c4b5fd" : CY, opacity: 0.6, borderRadius: 3 }} />
                          </div>
                        </td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{r.paramsB}</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{r.activeB}</td>
                        <td style={td({ color: "rgba(255,255,255,0.4)", fontSize: 9.5 })}>{r.paramsB >= 400 ? "frontier — big-VRAM multi-GPU only" : r.paramsB >= 70 ? "large — high-bandwidth pool" : r.paramsB !== r.activeB || r.activeB < 10 ? "light decode — runs almost anywhere" : "mid — standard nodes"}</td>
                      </tr>
                    ))}
                    <tr>
                      <td style={td({ fontWeight: 700, color: totPct === 100 ? "rgba(255,255,255,0.7)" : "#fbbf24" })}>Total{totPct !== 100 ? " ⚠" : ""}</td>
                      <td style={td({ textAlign: "right", fontWeight: 700, color: totPct === 100 ? CY : "#fbbf24" })}>{totPct}%</td>
                      <td style={td()} colSpan={2} />
                      <td style={td({ textAlign: "right", fontWeight: 700, color: CY })}>{wAct.toFixed(0)}B</td>
                      <td style={td({ color: "rgba(255,255,255,0.35)", fontSize: 9.5 })}>mix-weighted active params (total-weighted: {wTot.toFixed(0)}B)</td>
                    </tr>
                  </tbody>
                </table>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 8, lineHeight: 1.6 }}>
                  Illustrative shares, applied uniformly across customer types. Two things flow out of this mix: (1) the mix-weighted <b style={{ color: "#e2e8f0" }}>active params ({wAct.toFixed(0)}B)</b> is the natural anchor for the Inference Baseline's avg model size below (kept manually editable); (2) <b style={{ color: "#c4b5fd" }}>{bigSharePct.toFixed(0)}%</b> of inference demand sits on ≥70B-class models that need the high-VRAM / high-bandwidth inference pool — the share the heterogeneous supply engine should cover with H200/Blackwell-class parts rather than assuming any idle GPU can serve it. MoE models (DeepSeek, GPT-OSS) are VRAM-hungry to host but light per decode token — big to place, cheap to stream.{totPct !== 100 ? " ⚠ Shares don't sum to 100% — treated as weights, but normalize for clean reporting." : ""}
                </div>
              </>
            );
          })()}
        </Section>

        <SectionHeader title="Pricing Assumptions" />

        {/* Pricing assumptions + price→demand elasticity: sell rates feed
            Projections revenue and, via constant-elasticity, feed back into the
            demand build. Two columns (training / inference); three stacked rows
            (price → reference price → elasticity). Throughput is a separate
            fleet-wide dial below. */}
        <Section title="Pricing assumptions — sell rates by workload + price → demand elasticity (feeds Projections revenue AND the demand build)" style={{ marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 22, rowGap: 0, maxWidth: 900 }}>
            <Slider label="Training price" value={pricing.trainPrice} onChange={v => setPricing(prev => ({ ...prev, trainPrice: v }))} min={0.5} max={6} step={0.05} fmtFn={v => fmtUSD(v, 2) + "/H100e-hr"} hint="reserved training-run capacity; usually priced below inference" />
            <Slider label="Inference price" value={pricing.infPrice} onChange={v => setPricing(prev => ({ ...prev, infPrice: v }))} min={0.5} max={6} step={0.05} fmtFn={v => fmtUSD(v, 2) + "/H100e-hr"} hint="always-on serving capacity; commands a premium for SLA + burst" />
            <Slider label="Reference training price" value={pricing.refTrainPrice} onChange={v => setPricing(prev => ({ ...prev, refTrainPrice: v }))} min={0.5} max={6} step={0.05} fmtFn={v => fmtUSD(v, 2) + "/H100e-hr"} hint="price the demand build is anchored to; demand flexes as actual price departs from it" />
            <Slider label="Reference inference price" value={pricing.refInfPrice} onChange={v => setPricing(prev => ({ ...prev, refInfPrice: v }))} min={0.5} max={6} step={0.05} fmtFn={v => fmtUSD(v, 2) + "/H100e-hr"} hint="price the demand build is anchored to; demand flexes as actual price departs from it" />
            <Slider label="Training elasticity (ε)" value={pricing.elastTrain} onChange={v => setPricing(prev => ({ ...prev, elastTrain: v }))} min={0} max={3} step={0.1} fmtFn={v => v.toFixed(1)} hint="runs are deferrable and portable across clouds — more price-sensitive" />
            <Slider label="Inference elasticity (ε)" value={pricing.elastInf} onChange={v => setPricing(prev => ({ ...prev, elastInf: v }))} min={0} max={3} step={0.1} fmtFn={v => v.toFixed(1)} hint="serving traffic is stickier — customers eat price moves before migrating" />
          </div>
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", marginTop: 6, paddingTop: 6, maxWidth: 900 }}>
            <Slider label="Throughput — tokens per H100e-hour" value={tokPerHr} onChange={setTokPerHr} min={1} max={50} fmtFn={v => v + "M"} hint="fleet-wide; feeds the token-output chart on Projections" />
          </div>
          {(() => {
            const pd = priceDemandMult(pricing);
            return (
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4, lineHeight: 1.5 }}>
                Sell rates drive the Projections revenue math (each month: served H100e-hours × workload rate); the Supply tab's sell-rate decline is applied on top over time. Implied blended rate today: {fmtUSD(((cohortAgg.trainBase * pricing.trainPrice + cohortAgg.infBase * pricing.infPrice) / Math.max(1, cohortAgg.trainBase + cohortAgg.infBase)), 2)}/H100e-hr at the current demand mix. Prices also feed back into the demand build via constant elasticity: each workload's H100e demand is scaled by (price ÷ reference price)^−ε, applied uniformly across every segment and region (a 1% price rise cuts demand by ~ε%). Current multipliers: training ×{pd.train.toFixed(2)}, inference ×{pd.inf.toFixed(2)} — at price = reference both are ×1.00 and the build is unchanged. This scales quantity demanded rather than the ±% flex fields, which capture sensitivity to the frontier-workload baseline, not to price.
              </div>
            );
          })()}
        </Section>


        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.18)", marginTop: 16, fontFamily: F, lineHeight: 1.5 }}>
          Demand book and supply book share one data layer — edits here and on the Compute Supply tab reconcile live. Training-run FLOPs use the 6ND approximation (excludes activation recomputation and specifics of parallelism); MFU (training) and serving efficiency (inference) are the assumptions to pressure-test, alongside market prices. Inference throughput is a decode-bound roofline upper bound. H100e uses FLOP-normalization to match the supply tab.
        </div>
      </div>
    </div>
  );
}

return App;
})();

// ═════════════════════════════════════════════════════════════════════════════
// VENDOR SPEC — compare GPU cloud vendor offerings side by side. Distinct from
// Compute Supply (what we already hold, deal economics) and Compute Demand
// (what we need): this is the pre-sourcing catalog — evaluating candidate
// vendors on the specs that actually differ between two providers selling
// "the same H100," since GPU model alone doesn't tell you what you're buying.
// ═════════════════════════════════════════════════════════════════════════════

const VendorSpecApp = (() => {

const F = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const VI = "#a78bfa"; // vendor-spec accent: violet
const fmtUSD = (n, d) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a < 1 && n !== 0) return "$" + n.toFixed(d ?? 3); return "$" + n.toLocaleString(undefined, { maximumFractionDigits: d ?? 0 }); };
const fmtBig = (n) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(1) + "B"; if (a >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (a >= 1e3) return (n / 1e3).toFixed(1) + "K"; return n.toFixed(0); };
const fmtPct = (n, d = 0) => (n * 100).toFixed(d) + "%";

// ─── GPU reference specs — compute density, memory, native precision support ──
// tflops = dense BF16/FP16; fp8/fp4 = native low-precision peak where the
// silicon supports it (Hopper: no native FP4; Blackwell: native FP4 via 2nd-gen
// transformer engine). vram/bw as before. tdpW + nvlinkBW describe per-GPU
// density and intra-node scale-up bandwidth.
const GPU_REF = {
  A100_80: { label: "A100 80GB",  gen: "Ampere",    tflops: 312,  fp8: null,  fp4: null,  vram: 80,  bw: 2.0,  tdpW: 400, nvlinkGBs: 600 , capex: 17000 },
  L40S:    { label: "L40S 48GB",  gen: "Ada",       tflops: 181,  fp8: 362,   fp4: null,  vram: 48,  bw: 0.86, tdpW: 350, nvlinkGBs: 0 , capex: 11000 },
  H100:    { label: "H100 80GB",  gen: "Hopper",    tflops: 989,  fp8: 1979,  fp4: null,  vram: 80,  bw: 3.35, tdpW: 700, nvlinkGBs: 900 , capex: 27500 },
  H200:    { label: "H200 141GB", gen: "Hopper",    tflops: 989,  fp8: 1979,  fp4: null,  vram: 141, bw: 4.8,  tdpW: 700, nvlinkGBs: 900 , capex: 32000 },
  B200:    { label: "B200 192GB", gen: "Blackwell", tflops: 2250, fp8: 4500,  fp4: 9000,  vram: 192, bw: 8.0,  tdpW: 1000, nvlinkGBs: 1800 , capex: 40000 },
  B300:    { label: "B300 288GB", gen: "Blackwell Ultra", tflops: 2900, fp8: 5800, fp4: 11600, vram: 288, bw: 8.0, tdpW: 1200, nvlinkGBs: 1800 , capex: 55000 },
};
const PRECISIONS = ["FP16", "FP8", "FP4"];
function precisionsOf(gpu) { const g = GPU_REF[gpu]; const list = ["FP16"]; if (g.fp8) list.push("FP8"); if (g.fp4) list.push("FP4"); return list; }

// ─── Interconnect reference — scale-up (intra-node) vs scale-out (multi-node) ──
// category: "scale-up" = GPU-to-GPU within a node/rack domain (NVLink, NVSwitch);
// "scale-out" = node-to-node fabric (InfiniBand, Spectrum-X, RoCE, Ethernet).
// UALink is included for completeness but flagged not yet in production per
// public reporting as of mid-2026 (spec ratified, silicon expected late
// 2026/2027, targeted at non-NVIDIA accelerators — not an offering any GPU
// cloud sells today).
const INTERCONNECTS = {
  nvlink5:   { label: "NVLink 5 + NVSwitch (NVL72)", category: "scale-up",  bw: "1.8 TB/s/GPU, up to 72-GPU domain", maturity: "production", notes: "Rack-scale single memory domain (Blackwell NVL72); the gold standard for scale-up, proprietary to NVIDIA." },
  nvlink4:   { label: "NVLink 4 (8-GPU node)",       category: "scale-up",  bw: "900 GB/s/GPU, 8-GPU domain",        maturity: "production", notes: "Standard HGX 8-GPU server domain (Hopper)." },
  ib_ndr:    { label: "InfiniBand NDR (400G)",       category: "scale-out", bw: "400 Gb/s/port, RDMA",               maturity: "production", notes: "Current-gen IB; the default for multi-node training scale-out." },
  ib_xdr:    { label: "InfiniBand XDR (800G)",       category: "scale-out", bw: "800 Gb/s/port, RDMA",               maturity: "early production", notes: "Next-gen IB, deploying with Blackwell-class clusters." },
  spectrumx: { label: "Spectrum-X Ethernet",         category: "scale-out", bw: "400 Gb/s/port, RoCE + congestion control", maturity: "production", notes: "NVIDIA's Ethernet-based scale-out fabric; targets IB-class performance on standard Ethernet economics." },
  roce:      { label: "RoCE (generic)",              category: "scale-out", bw: "100–200 Gb/s/port, RDMA",           maturity: "production", notes: "RDMA over commodity Ethernet; cheaper than IB, less mature congestion handling at scale." },
  ualink:    { label: "UALink",                      category: "scale-up",  bw: "200 Gb/s/lane (spec), up to 1,024 accelerators", maturity: "pre-production", notes: "Open scale-up standard (AMD/Broadcom/Google/Intel/Microsoft-backed); 1.0 spec ratified Apr 2025. No shipping silicon or cloud offering as of mid-2026 — targets non-NVIDIA accelerators, not a current H100/B200 option." },
  eth:       { label: "Standard Ethernet",           category: "scale-out", bw: "25–100 Gb/s/port, no RDMA",         maturity: "production", notes: "No multi-node scale-out for training; fine for single-GPU inference only." },
  pcie:      { label: "PCIe only (no GPU fabric)",   category: "scale-up",  bw: "64 GB/s (Gen5 x16)",                maturity: "production", notes: "No NVLink — GPU-to-GPU traffic crosses PCIe/host. Fine for single-GPU serving; poor for tensor parallelism. L40S and ungrouped spot instances live here." },
};
const IC_ORDER = ["nvlink5", "nvlink4", "pcie", "ib_xdr", "ib_ndr", "spectrumx", "roce", "ualink", "eth"];

// Vendor SKU catalog is defined at module scope (see near top of file) so both
// this app and the Supply Filling Engine can read from a single source of truth.

// ── Price-sustainability floor: power + straight-line capex recovery ─────────
// powerCost/hr = TDP × PUE × $/kWh × 1.15 (node non-GPU draw). Capex floor =
// purchase price / 4yr straight-line hours. A quote below ~floor means the
// vendor is losing cash on every hour — fine short-term (distress inventory),
// dangerous on a prepaid term: the discount IS the counterparty risk.
const powerCostHr = c => (GPU_REF[c.gpu].tdpW / 1000) * c.pue * c.kwh * 1.15;
const capexFloorHr = c => GPU_REF[c.gpu].capex / (4 * 8760);
const floorHr = c => powerCostHr(c) + capexFloorHr(c);
const allInHr = c => c.price + (c.storageAdd || 0);
const belowFloor = c => c.price < floorHr(c) * 1.05;

// ClusterMAX ratings — SemiAnalysis, Nov 2025 snapshot (same source as Compute
// Supply; redefined locally per this file's one-tab-one-scope convention).
const CLUSTERMAX = { "CoreWeave": "platinum", "Crusoe": "gold", "Nebius": "gold", "Azure": "gold", "Lambda Labs": "silver", "AWS": "silver", "GCP": "silver", "Voltage Park": "silver", "OCI": "silver", "Denvr Dataworks": "silver", "Hyperstack": "bronze", "Scaleway": "bronze", "DigitalOcean": "bronze", "Vultr": "bronze", "GMI Cloud": "bronze", "Latitude.sh": "bronze" };
const CMAX_META = { platinum: { label: "PLATINUM", color: "#e2e8f0" }, gold: { label: "GOLD", color: "#fbbf24" }, silver: { label: "SILVER", color: "#94a3b8" }, bronze: { label: "BRONZE", color: "#d97706" } };
function CmaxBadge({ provider }) {
  const r = CLUSTERMAX[provider];
  const m = r ? CMAX_META[r] : { label: "UNRATED", color: "rgba(255,255,255,0.25)" };
  return <span title="SemiAnalysis ClusterMAX, Nov 2025" style={{ border: `1px solid ${m.color}50`, color: m.color, borderRadius: 3, fontSize: 7.5, letterSpacing: "0.05em", padding: "1px 4px", marginLeft: 5 }}>{m.label}</span>;
}

const REGIONS = ["US-East", "US-Central", "US-West", "EU", "Nordics", "Middle East", "APAC", "Global (mixed)"];

// ─── Hedonic fair-price model ────────────────────────────────────────────────
// A GPU-hour is a bundle of measurable attributes; the market pays for each.
// We fit an ordinary-least-squares regression of log(all-in $/hr) on the
// quantifiable features below, using the whole catalog as the training set.
// log-space because price effects are multiplicative (a premium is "+30%", not
// "+$0.50"), which also guarantees the model never predicts a negative price.
// Output: a fitted coefficient per feature (the market's implied value of each
// attribute) and a fair price per listing. Gap vs. quoted = the premium/discount
// left unexplained by hardware — attributable to the non-quantifiable factors.
const CMAX_NUM = { platinum: 4, gold: 3, silver: 2, bronze: 1 };
function hedonicFeatures(c) {
  const g = GPU_REF[c.gpu];
  const fabQ = c.outFabric.startsWith("ib") ? 3 : c.outFabric === "spectrumx" ? 2.5 : c.outFabric === "roce" ? 1.5 : 0.5;
  const scaleUp = c.ic === "nvlink5" ? 3 : c.ic === "nvlink4" ? 2 : c.ic === "nvlink" ? 1 : 0.3;
  return {
    density: g.tflops / 1000, vram: g.vram / 100, bw: g.bw,
    fp4: g.fp4 ? 1 : 0, fabric: fabQ, scaleUp,
    cmax: CMAX_NUM[CLUSTERMAX[c.provider]] || 0, sla: c.sla - 99,
  };
}
const HEDONIC_KEYS = ["density", "vram", "bw", "fp4", "fabric", "scaleUp", "cmax", "sla"];
const HEDONIC_LABEL = { density: "Compute density (BF16)", vram: "Memory capacity", bw: "Memory bandwidth", fp4: "FP4 capable (yes vs no)", fabric: "Scale-out fabric", scaleUp: "Scale-up (NVLink)", cmax: "Operator tier (ClusterMAX)", sla: "SLA level" };
// Fit: sign-constrained ridge regression on STANDARDIZED features.
// Why not plain OLS: with ~15 listings and 8 features that co-move across GPU
// generations (density, VRAM, BW, FP4 all jump together at each new part),
// unconstrained OLS splits the generation premium arbitrarily and flips signs
// (VRAM came out −60%/100GB). Two corrections: (1) standardize + ridge, which
// shares a collinear premium across the correlated features instead of letting
// one cannibalize the rest; (2) constrain feature coefficients ≥ 0 — the
// economic prior that no listed capability commands a negative premium.
// Coordinate descent handles the constraint; coefficients are mapped back to
// the original units for interpretation.
function fitHedonic(catalog, lambda = 1.0, iters = 600) {
  const X = catalog.map(c => { const f = hedonicFeatures(c); return [1, ...HEDONIC_KEYS.map(k => f[k])]; });
  const y = catalog.map(c => Math.log(allInHr(c)));
  const p = X[0].length, n = X.length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let k = 1; k < p; k++) {
    mu[k] = X.reduce((s, r) => s + r[k], 0) / n;
    sd[k] = Math.sqrt(X.reduce((s, r) => s + (r[k] - mu[k]) ** 2, 0) / n) || 1;
  }
  const Z = X.map(r => r.map((v, k) => k === 0 ? 1 : (v - mu[k]) / sd[k]));
  const cols = Array.from({ length: p }, (_, k) => Z.map(r => r[k]));
  const cc = cols.map(c => c.reduce((s, v) => s + v * v, 0));
  const bz = new Array(p).fill(0);
  for (let it = 0; it < iters; it++) for (let k = 0; k < p; k++) {
    let num = 0;
    for (let i = 0; i < n; i++) { let pr = 0; for (let j = 0; j < p; j++) if (j !== k) pr += Z[i][j] * bz[j]; num += cols[k][i] * (y[i] - pr); }
    let b = num / (cc[k] + (k === 0 ? 0 : lambda * n));
    if (k !== 0) b = Math.max(0, b);
    bz[k] = b;
  }
  const beta = bz.map((b, k) => k === 0 ? b : b / sd[k]);
  beta[0] = bz[0] - HEDONIC_KEYS.reduce((s, _, i) => s + beta[i + 1] * mu[i + 1], 0);
  const predictLog = c => { const f = hedonicFeatures(c); return beta[0] + HEDONIC_KEYS.reduce((s, k, i) => s + beta[i + 1] * f[k], 0); };
  const fair = c => Math.exp(predictLog(c));
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  let ssr = 0, sst = 0;
  catalog.forEach((c, i) => { const e = y[i] - predictLog(c); ssr += e * e; sst += (y[i] - ybar) ** 2; });
  return { beta, fair, r2: sst > 0 ? 1 - ssr / sst : 0, keys: HEDONIC_KEYS };
}
const HEDONIC = fitHedonic(CATALOG);

// Regression-implied $ value of a capability vs a baseline, holding everything
// else at a neutral reference listing (NVLink4 / InfiniBand NDR / gold operator
// / 99.5% SLA). Used by the GPU and interconnect ranking tables so the "worth"
// columns come straight from the fitted model rather than a separate guess.
const HEDONIC_REF = { gpu: "H100", ic: "nvlink4", outFabric: "ib_ndr", provider: "Crusoe", sla: 99.5, storageAdd: 0, price: 2.0 };
const gpuFairValue = (k) => HEDONIC.fair({ ...HEDONIC_REF, gpu: k });
const GPU_BASELINE_FAIR = gpuFairValue("H100");
const scaleUpFairValue = (ic) => HEDONIC.fair({ ...HEDONIC_REF, ic });
const SCALEUP_BASELINE_FAIR = scaleUpFairValue("pcie");
const scaleOutFairValue = (f) => HEDONIC.fair({ ...HEDONIC_REF, outFabric: f });
const SCALEOUT_BASELINE_FAIR = scaleOutFairValue("eth");

// ─── New-entrant diligence checklist ─────────────────────────────────────────
// The repeatable process before a first commitment to a provider with no
// history with us. Line items mirror the attributes this tab prices (catalog
// specs, fair-price features, sustainability floor) plus the commercial and
// operational terms that separate two vendors selling "the same H100."
const ENTRANT_CHECKLIST = [
  { stage: "1 · Identity & legitimacy", items: [
    "Corporate registration + ownership chain — operator, or reseller-of-a-reseller?",
    "Operating history, capitalization, and who funds them (runway for the term you'd sign)",
    "Verifiable DC footprint: sites, power contracts, third-party press or satellite evidence",
  ]},
  { stage: "2 · Hardware & silicon", items: [
    "GPU model, generation, form factor (SXM vs PCIe — same silicon, very different multi-GPU behavior) — and proof they physically hold them",
    "Quantity offered AND largest single cluster (separate sites can't shard one replica)",
    "Quoted FLOPS: precision named AND dense-vs-sparse disclosed? (halve if 2:4 sparse; FP4 is inference-only, not training)",
    "Memory capacity ÷ bandwidth = time to read all memory once — did this generation improve or regress on that ratio?",
    "Memory bandwidth (TB/s) — the inference-decode driver; what H200's premium actually buys",
    "Performance claims traceable: MLPerf division (closed = apples-to-apples, open ≠ ), software stack = my deploy version, and MFU (not HFU) — ~35–50% is real dense-training",
  ]},
  { stage: "3 · Interconnect & topology", items: [
    "Match fabric to workload's parallelism strategy — TP/SP need intra-node NVLink; PP tolerates cross-node IB; MoE all-to-all requires rail-aligned, low-oversubscription bisection (see parallelism → fabric table below)",
    "Scale-up: NVLink generation + domain size (8-GPU HGX vs NVL72), with a real crossbar switch chip (no switch chip = ring, not fully-connected)",
    "Scale-out fabric: InfiniBand NDR/XDR vs Spectrum-X vs RoCE vs plain Ethernet",
    "Oversubscription ratio per tier (1:1 = non-blocking) + rail alignment — the cheapest place a vendor cuts cost; 2-tier or 3-tier at your scale?",
    "Bandwidth quoted per-GPU + unidirectional (not aggregate, not the bidirectional 2× figure)",
    "Test-cluster access before signature: NCCL all-reduce + measured end-to-end latency at target message sizes (not per-hop silicon), storage I/O throughput",
  ]},
  { stage: "4 · Facility & power", items: [
    "Power price ($/kWh) and PUE — is the quoted price/power IT load or total facility draw?",
    "Cooling class: is the peak FLOPS number real with the cooling I'm buying? (>700W chips can't sustain boost on air)",
    "Rack density vs existing electrical — 5–15 kW/rack halls need real retrofit for 100+ kW liquid racks",
    "DC redundancy across power, cooling, and network paths: N = single point of failure; N+1 ≈ Uptime Tier III (survives one component fault); 2N ≈ Tier IV (fully duplicated). Long training runs need N+1 or better — one utility hiccup kills the checkpoint",
    "Region: data residency, export-control screening, latency to core demand geographies",
  ]},
  { stage: "5 · Storage & data", items: [
    "Storage type (Lustre / VAST / WEKA / local NVMe) and whether it's included or a $/GPU-hr adder",
    "Egress fees $/GB — moves the all-in price and is often omitted from the headline rate",
    "Data-loading path: bandwidth from storage to GPUs at training scale",
  ]},
  { stage: "6 · Commercial terms", items: [
    "Quoted rate vs the fair-price model above — what premium/discount is unexplained by hardware",
    "Sustainability floor check: power + 4yr capex recovery — a sub-floor quote is counterparty risk, not a bargain",
    "All-in price: quoted rate + storage adder + egress, not the headline number",
    "Minimum commitment size and term length proportionate to their apparent scale",
    "Prepay % and payment terms — large prepay to a small operator concentrates default risk",
    "Utilization assumption behind the price comparison, and whether scarcity flips this from a cost decision to an access decision",
  ]},
  { stage: "7 · Service & operations", items: [
    "SLA % with credits in writing — quoted uptime without credits is marketing",
    "Support tier: 24/7 engineering vs business hours vs email-only; MTTR on a downed node mid-run",
    "Burn-in / acceptance-test clause with walk-away rights — turns 'we were told' into 'we confirmed'",
    "Fleet homogeneity: firmware / driver / NCCL version pinning practice (skew causes silent perf divergence)",
    "Tenancy (bare metal vs VM), lead time, and ramp schedule with milestone payments tied to it",
  ]},
  { stage: "8 · Rights & references", items: [
    "Resale rights — decisive for marketplace supply; hyperscaler ToS generally prohibit it",
    "Exit terms: sell-back rights, mid-term rate reopeners, upgrade options on 3yr+ terms",
    "Named reference customers at comparable scale, contactable",
    "Incident / outage history from public or industry sources",
    "Delivered-vs-promised ramp on any prior tranche (ours or referenced)",
  ]},
];



function Field({ label, children }) {
  return <div style={{ marginBottom: 10 }}><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>{children}</div>;
}
function Select({ label, value, onChange, options }) {
  return (
    <Field label={label}>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", padding: "7px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, color: "#e2e8f0", fontSize: 12, fontFamily: F, outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value} style={{ background: "#0b1118" }}>{o.label}</option>)}
      </select>
    </Field>
  );
}
function Section({ title, children, style: s }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.1)", ...s }}>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: F, fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  );
}
function SectionHeader({ title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 12px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#e2e8f0", fontFamily: F, textTransform: "uppercase" }}>{title}</div>
      <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
    </div>
  );
}
const td = (extra = {}) => ({ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", ...extra });
const th = (align = "right") => ({ padding: "5px 8px", textAlign: align, color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 });
const matColor = m => m === "production" ? "#6ee7b7" : m === "early production" ? "#fbbf24" : "#f87171";

function App() {
  const [fGpu, setFGpu] = useState("all");
  const [fRegion, setFRegion] = useState("all");
  const [fIc, setFIc] = useState("all");
  const [sortKey, setSortKey] = useState("density");
  const [compare, setCompare] = useState([39, 41]); // CoreWeave B300 vs Nebius B300 — visible by default
  const [disc, setDisc] = useBookStore(RESERVED_DISCOUNT_STORE);

  const rows = useMemo(() => {
    let r = CATALOG.filter(c =>
      (fGpu === "all" || c.gpu === fGpu) &&
      (fRegion === "all" || c.region === fRegion) &&
      (fIc === "all" || c.outFabric === fIc)
    );
    const key = { price: c => c.price, density: c => -GPU_REF[c.gpu].tflops, mem: c => -GPU_REF[c.gpu].vram, bw: c => -GPU_REF[c.gpu].bw, provider: c => c.provider }[sortKey];
    return [...r].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
  }, [fGpu, fRegion, fIc, sortKey]);

  const toggleCompare = useCallback(id => setCompare(c => c.includes(id) ? c.filter(x => x !== id) : (c.length >= 4 ? c : [...c, id])), []);
  const compareRows = compare.map(id => CATALOG.find(c => c.id === id)).filter(Boolean);

  const gpuOptions = [{ value: "all", label: "All GPUs" }, ...Object.keys(GPU_REF).map(k => ({ value: k, label: GPU_REF[k].label }))];
  const regionOptions = [{ value: "all", label: "All regions" }, ...REGIONS.map(r => ({ value: r, label: r }))];
  const icOptions = [{ value: "all", label: "All scale-out fabrics" }, ...IC_ORDER.filter(k => INTERCONNECTS[k].category === "scale-out").map(k => ({ value: k, label: INTERCONNECTS[k].label }))];
  const sortOptions = [{ value: "price", label: "Price (low→high)" }, { value: "density", label: "Compute density (high→low)" }, { value: "mem", label: "Memory capacity (high→low)" }, { value: "bw", label: "Memory bandwidth (high→low)" }, { value: "provider", label: "Provider (A→Z)" }];

  return (
    <div style={{ minHeight: "100vh", background: "#0b1118", color: "#e2e8f0", fontFamily: F, padding: "18px 20px 40px" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Vendor Spec & Contracts <span style={{ color: "#fbbf24" }}>— compare GPU cloud vendor offerings</span></div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
            The pre-sourcing catalog: two vendors selling "the same H100" can differ on node interconnect, scale-out fabric, region, and operator quality. Filter the catalog, then select up to 4 rows to compare side by side.
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12 }}>
          <Select label="GPU type" value={fGpu} onChange={setFGpu} options={gpuOptions} />
          <Select label="Region" value={fRegion} onChange={setFRegion} options={regionOptions} />
          <Select label="Scale-out fabric" value={fIc} onChange={setFIc} options={icOptions} />
          <Select label="Sort by" value={sortKey} onChange={setSortKey} options={sortOptions} />
        </div>

        {/* Catalog table */}
        <Section title={`Vendor catalog (${rows.length} of ${CATALOG.length})`} style={{ marginBottom: 12 }}>
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 520, border: "1px solid rgba(255,255,255,0.04)", borderRadius: 4 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: F }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 2, background: "#0f151d" }}><tr>
                <th style={{ ...th("left"), background: "#0f151d" }}></th><th style={{ ...th("left"), background: "#0f151d" }}>PROVIDER</th><th style={{ ...th("left"), background: "#0f151d" }}>GPU</th><th style={{ ...th(), background: "#0f151d" }}>NODE</th>
                <th style={{ ...th("left"), background: "#0f151d" }}>REGION</th><th style={{ ...th("left"), background: "#0f151d" }}>SCALE-UP</th><th style={{ ...th("left"), background: "#0f151d" }}>SCALE-OUT</th>
                <th style={{ ...th(), background: "#0f151d" }}>MEM</th><th style={{ ...th(), background: "#0f151d" }}>MEM BW</th><th style={{ ...th("left"), background: "#0f151d" }}>PRECISION</th><th style={{ ...th(), background: "#0f151d" }}>$/GPU-HR</th><th style={{ ...th(), background: "#0f151d" }}>ALL-IN</th><th style={{ ...th(), background: "#0f151d" }} title="Model-implied fair value">FAIR</th><th style={{ ...th(), background: "#0f151d" }} title="All-in vs. fair: + premium, − discount">VS FAIR</th>
              </tr></thead>
              <tbody>
                {rows.map(c => {
                  const g = GPU_REF[c.gpu], ic = INTERCONNECTS[c.ic], out = INTERCONNECTS[c.outFabric];
                  const checked = compare.includes(c.id);
                  return (
                    <tr key={c.id} style={{ background: checked ? "rgba(167,139,250,0.06)" : "transparent" }}>
                      <td style={td()}><input type="checkbox" checked={checked} onChange={() => toggleCompare(c.id)} style={{ accentColor: VI, cursor: "pointer" }} /></td>
                      <td style={td({ color: "#e2e8f0", whiteSpace: "nowrap" })}>{c.provider}<CmaxBadge provider={c.provider} /></td>
                      <td style={td({ color: "rgba(255,255,255,0.6)" })}>{g.label}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>×{c.node}</td>
                      <td style={td({ color: "rgba(255,255,255,0.5)", fontSize: 10 })}>{c.region}</td>
                      <td style={td({ color: ic.category === "scale-up" ? "#6ee7b7" : "rgba(255,255,255,0.4)", fontSize: 10 })} title={ic.notes}>{ic.label}</td>
                      <td style={td({ color: matColor(out.maturity), fontSize: 10 })} title={out.notes}>{out.label}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{g.vram}GB</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{g.bw.toFixed(1)}TB/s</td>
                      <td style={td({ fontSize: 9 })}>{precisionsOf(c.gpu).join(" / ")}</td>
                      <td style={td({ textAlign: "right", color: VI, fontWeight: 600, whiteSpace: "nowrap" })}>{fmtUSD(c.price, 2)}{belowFloor(c) && <span title={`Below sustainability floor ~${fmtUSD(floorHr(c), 2)}/hr (power ${fmtUSD(powerCostHr(c), 2)} + capex ${fmtUSD(capexFloorHr(c), 2)}) — vendor loses cash every hour; on a prepaid term the discount IS the counterparty risk`} style={{ color: "#f87171", marginLeft: 3, cursor: "help" }}>⚠</span>}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })} title={c.storageAdd > 0 ? `+${fmtUSD(c.storageAdd, 2)} storage` : "storage included"}>{fmtUSD(allInHr(c), 2)}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })} title="Model-implied fair value from hardware + operator features">{fmtUSD(HEDONIC.fair(c), 2)}</td>
                      {(() => { const gap = allInHr(c) / HEDONIC.fair(c) - 1; const col = gap > 0.08 ? "#f87171" : gap < -0.08 ? "#6ee7b7" : "rgba(255,255,255,0.45)"; return <td style={td({ textAlign: "right", color: col, fontWeight: 600 })} title={gap > 0 ? "Priced above model — paying for non-quantifiable factors (or overpaying)" : "Priced below model — a relative bargain (or hidden risk)"}>{(gap >= 0 ? "+" : "") + fmtPct(gap)}</td>; })()}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 8, lineHeight: 1.5 }}>
            SCALE-UP = intra-node/rack GPU-to-GPU fabric (NVLink/NVSwitch); SCALE-OUT = node-to-node network fabric (color = maturity: green production, amber early production, red immature/not offered). Hover either for details. Node = GPUs sharing one scale-up domain (72 for NVL72 rack-scale, 8 for standard HGX, 1 for ungrouped spot instances). ALL-IN = quoted price + storage adder where storage isn't included — the hyperscaler gotcha. ⚠ on a price = below the power+capex sustainability floor (hover for the math): a too-good-to-be-true quote is a counterparty-risk signal, not a bargain, especially with prepay.
          </div>
        </Section>

        {/* Reserved-term discount curve — read by the Supply Filling Engine */}
        <Section title="Reserved-term discount curve — % off on-demand as a function of term length" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.55)", lineHeight: 1.6, marginBottom: 12 }}>
            The catalog above quotes <b style={{ color: "#e2e8f0" }}>on-demand pay-as-you-go rates</b>. Vendors also offer reserved contracts — locking in capacity for a set term in exchange for a discount off on-demand. Real reserved pricing isn't in the catalog (varies by vendor and negotiation), so we assume a discount curve: bigger discount for committing at all (0 → 1yr is the biggest jump), then diminishing returns for longer commitments. Set three anchors below; the engine interpolates piecewise-linearly for any term. This curve feeds directly into the Supply Filling Engine — when it evaluates a candidate deal at term T, the vendor rate = on-demand × (1 − discount(T)) × operator tier multiplier.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
            {[
              { key: "d1", label: "1-YEAR TERM", desc: "biggest jump from OD — first commitment", color: "#fbbf24" },
              { key: "d3", label: "3-YEAR TERM", desc: "typical enterprise reserved sweet spot", color: "#67e8f9" },
              { key: "d5", label: "5-YEAR TERM", desc: "long lock — neocloud / dedicated compute", color: "#86efac" },
            ].map(({ key, label, desc, color }) => (
              <div key={key} style={{ padding: "10px 12px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: color, fontFamily: F, fontWeight: 700, letterSpacing: "0.06em" }}>{label}</span>
                  <span style={{ fontSize: 16, color: "#e2e8f0", fontWeight: 700, fontFamily: F }}>{disc[key]}%</span>
                </div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginBottom: 8, fontFamily: F }}>{desc}</div>
                <input type="range" min={0} max={80} step={1} value={disc[key]}
                  onChange={e => setDisc({ ...disc, [key]: parseInt(e.target.value, 10) })}
                  style={{ width: "100%", accentColor: color, cursor: "pointer" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: F, marginTop: 2 }}>
                  <span>0%</span><span>80%</span>
                </div>
              </div>
            ))}
          </div>

          {/* Preview: discount schedule + effective rate for H100 */}
          {(() => {
            const H100_OD = 2.45;
            const terms = [0, 6, 12, 18, 24, 36, 48, 60];
            const rows2 = terms.map(t => ({ t, disc: discountForTerm(t, disc), rate: H100_OD * (1 - discountForTerm(t, disc)) }));
            const maxDisc = Math.max(...rows2.map(r => r.disc), 0.01);
            return (
              <div style={{ padding: "12px 14px", background: "rgba(167,139,250,0.04)", border: "1px solid rgba(167,139,250,0.15)", borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                  Schedule preview — H100 at ${H100_OD.toFixed(2)}/GPU-hr on-demand
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                  <thead><tr>
                    <th style={{ textAlign: "left", color: "rgba(255,255,255,0.4)", padding: "4px 8px", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 9 }}>TERM</th>
                    <th style={{ textAlign: "right", color: "rgba(255,255,255,0.4)", padding: "4px 8px", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 9 }}>DISCOUNT</th>
                    <th style={{ textAlign: "right", color: "rgba(255,255,255,0.4)", padding: "4px 8px", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 9 }}>H100 $/GPU-HR</th>
                    <th style={{ textAlign: "left", color: "rgba(255,255,255,0.4)", padding: "4px 8px", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 9, width: "40%" }}>CURVE</th>
                  </tr></thead>
                  <tbody>
                    {rows2.map(r => {
                      const isAnchor = r.t === 12 || r.t === 36 || r.t === 60;
                      const isOD = r.t === 0;
                      return (
                        <tr key={r.t} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          <td style={{ padding: "4px 8px", color: isOD ? "#e2e8f0" : "rgba(255,255,255,0.7)", fontWeight: isAnchor || isOD ? 600 : 400 }}>{isOD ? "on-demand" : `${r.t / 12}yr (${r.t}mo)`}</td>
                          <td style={{ padding: "4px 8px", textAlign: "right", color: isOD ? "rgba(255,255,255,0.3)" : VI, fontWeight: isAnchor ? 700 : 500 }}>{isOD ? "—" : (r.disc * 100).toFixed(1) + "%"}</td>
                          <td style={{ padding: "4px 8px", textAlign: "right", color: "#67e8f9", fontWeight: isAnchor || isOD ? 700 : 500 }}>${r.rate.toFixed(2)}</td>
                          <td style={{ padding: "4px 8px" }}>
                            <div style={{ height: 6, background: "rgba(255,255,255,0.04)", borderRadius: 3, position: "relative" }}>
                              <div style={{ width: `${r.disc / maxDisc * 100}%`, height: "100%", background: VI, opacity: 0.55, borderRadius: 3 }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 8, lineHeight: 1.5 }}>
                  Curve is piecewise-linear on years: 0→1yr scales from 0 to the 1yr anchor, 1→3yr interpolates 1yr→3yr, 3→5yr interpolates 3yr→5yr, and beyond 5yr is capped at the 5yr anchor. Vendor tier premium (Platinum +6%, Gold +3%) is applied on top of the term-discounted rate.
                </div>
              </div>
            );
          })()}
        </Section>

        {/* Hedonic pricing model */}
        <Section title={`Side-by-side comparison (${compareRows.length} selected)`} style={{ marginBottom: 12 }}>
          {compareRows.length === 0 ? (
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: F, padding: "6px 0" }}>Check up to 4 rows in the catalog to compare specs side by side.</div>
          ) : <>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${compareRows.length}, 1fr)`, gap: 10, marginBottom: 14 }}>
              {compareRows.map(c => {
                const g = GPU_REF[c.gpu], ic = INTERCONNECTS[c.ic], out = INTERCONNECTS[c.outFabric];
                return (
                  <div key={c.id} style={{ border: "1px solid rgba(167,139,250,0.25)", borderRadius: 8, padding: "10px 12px", background: "rgba(167,139,250,0.04)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", fontFamily: F, marginBottom: 2 }}>{c.provider}<CmaxBadge provider={c.provider} /></div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>{g.label} · {c.region}</div>
                    {[["Compute (BF16)", g.tflops + " TFLOPS"], ["Compute (FP8)", g.fp8 ? g.fp8 + " TFLOPS" : "n/a"], ["Compute (FP4)", g.fp4 ? g.fp4 + " TFLOPS" : "n/a"],
                      ["Memory", g.vram + "GB"], ["Mem bandwidth", g.bw.toFixed(1) + " TB/s"], ["TDP", g.tdpW + "W"],
                      ["Scale-up fabric", ic.label], ["Scale-out fabric", out.label], ["Node size", "×" + c.node],
                      ["Power", (c.kwh * 100).toFixed(1) + "¢/kWh · PUE " + c.pue], ["Storage", c.storage + (c.storageAdd > 0 ? ` (+${fmtUSD(c.storageAdd, 2)})` : "")],
                      ["SLA / support", (c.sla > 0 ? c.sla + "%" : "none") + " · " + c.support], ["Tenancy · lead", c.tenancy + " · " + (c.leadWks === 0 ? "now" : c.leadWks + "wk")],
                      ["Min commit", c.minCommit], ["Resale rights", c.resale ? "permitted ✓" : "PROHIBITED ✗"],
                      ["Quoted price", fmtUSD(c.price, 2) + "/GPU-hr" + (belowFloor(c) ? " ⚠ below floor" : "")], ["All-in price", fmtUSD(allInHr(c), 2) + "/GPU-hr"]].map(([k, v]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 3, fontFamily: F }}>
                        <span style={{ color: "rgba(255,255,255,0.35)" }}>{k}</span><span style={{ color: "#e2e8f0", textAlign: "right" }}>{v}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 6, fontStyle: "italic" }}>{c.notes}</div>
                  </div>
                );
              })}
            </div>
          </>}
        </Section>

        <SectionHeader title="Fair-Price Regression Model" />

        <Section title="Fair-price model — what the market pays for each quantifiable attribute" style={{ marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 20 }}>
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Implied price effect per feature</div>
              {(() => {
                const effects = HEDONIC.keys.map((k, i) => {
                  const b = HEDONIC.beta[i + 1];
                  // Effect of a representative +1 step in that feature, as % price move.
                  const pct = Math.exp(b) - 1;
                  return { k, pct };
                }).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
                const mx = Math.max(...effects.map(e => Math.abs(e.pct)), 0.01);
                return effects.map(e => (
                  <div key={e.k} style={{ marginBottom: 7 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: F, marginBottom: 2 }}>
                      <span style={{ color: "rgba(255,255,255,0.6)" }}>{HEDONIC_LABEL[e.k]}</span>
                      <span style={{ color: e.pct >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 600 }}>{(e.pct >= 0 ? "+" : "") + fmtPct(e.pct)}</span>
                    </div>
                    <div style={{ height: 6, background: "rgba(255,255,255,0.04)", borderRadius: 3, position: "relative" }}>
                      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.15)" }} />
                      <div style={{ position: "absolute", left: e.pct >= 0 ? "50%" : `${50 - Math.abs(e.pct) / mx * 50}%`, width: `${Math.abs(e.pct) / mx * 50}%`, top: 0, height: "100%", background: e.pct >= 0 ? "#6ee7b7" : "#f87171", opacity: 0.6, borderRadius: 3 }} />
                    </div>
                  </div>
                ));
              })()}
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 8, lineHeight: 1.5 }}>
                Each bar = the price move the market attaches to a one-unit step in that attribute, holding the others fixed — per-100GB memory, per-TB/s bandwidth, one ClusterMAX tier, one SLA nine, and for FP4 the yes-vs-no jump from a chip without native FP4 to one with it. Model fit: R² = {fmtPct(HEDONIC.r2)} of price variance explained by hardware + operator features across {CATALOG.length} listings.
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>What the model can't see — non-quantifiable premium drivers</div>
              <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.55)", fontFamily: F, lineHeight: 1.7 }}>
                The {fmtPct(1 - HEDONIC.r2)} of price variance the features don't explain is where these live — the "vs fair" gap in the catalog is their combined footprint:
                <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
                  <li><b style={{ color: "#e2e8f0" }}>Support depth & responsiveness</b> — dedicated solutions engineers vs. email/community; MTTR on a downed node mid-run.</li>
                  <li><b style={{ color: "#e2e8f0" }}>Reliability track record</b> — real goodput, silent-data-corruption rates, health-check automation (partly proxied by ClusterMAX, not fully).</li>
                  <li><b style={{ color: "#e2e8f0" }}>Contract flexibility</b> — cancellation terms, burst/on-demand access, reservation portability, resale rights.</li>
                  <li><b style={{ color: "#e2e8f0" }}>Delivery certainty & lead time</b> — a slot available now vs. a 12-week build; penalty clauses for slipped delivery.</li>
                  <li><b style={{ color: "#e2e8f0" }}>Software & ecosystem</b> — managed Slurm/K8s, storage performance, observability, one-click orchestration.</li>
                  <li><b style={{ color: "#e2e8f0" }}>Security & compliance</b> — SOC 2 / ISO, tenancy isolation, data residency, export-control posture.</li>
                  <li><b style={{ color: "#e2e8f0" }}>Power & siting</b> — behind-the-meter or renewable power, PUE, and grid-cost stability behind a low headline rate.</li>
                  <li><b style={{ color: "#e2e8f0" }}>Brand & counterparty risk</b> — will the provider exist in 24 months; is a below-floor quote distress inventory or a trap.</li>
                </ul>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 10, lineHeight: 1.6 }}>
            Method: a sign-constrained ridge regression of log(all-in $/GPU-hr) on the eight hardware + operator features, fit across the whole catalog. Log-space makes each effect a percentage premium and keeps predicted prices positive. The ridge penalty spreads a shared premium across features that move together across GPU generations (density, VRAM, bandwidth, FP4 all step up at once), and the ≥ 0 constraint encodes the prior that no listed capability is priced negatively. The fitted model prices each listing: the catalog's <b style={{ color: "#e2e8f0" }}>FAIR</b> column is that prediction and <b style={{ color: "#e2e8f0" }}>VS FAIR</b> is quoted-minus-fair. A positive gap isn't automatically "overpriced" — it's the price of things the model can't measure (listed above); a large negative gap on a prepaid term is a counterparty-risk signal, not a bargain.
          </div>
        </Section>

        <SectionHeader title="Vendor Diligence Framework" />

        {/* New-entrant diligence checklist */}
        <Section title="New-entrant diligence checklist — before any first commitment" style={{ marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10 }}>
            {ENTRANT_CHECKLIST.map(st => (
              <div key={st.stage} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.55)", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 6, fontFamily: F }}>{st.stage}</div>
                {st.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, fontSize: 9.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.45, marginBottom: 4, fontFamily: F }}>
                    <span style={{ color: "rgba(255,255,255,0.25)", flexShrink: 0 }}>☐</span>
                    <span>{it}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>

        {/* Interconnect reference */}
        <SectionHeader title="Reference Guide" />
        <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.35)", marginTop: -4, marginBottom: 12, lineHeight: 1.5 }}>
          What is worth paying more for, quantified. Three rankings — GPUs, interconnects, and data-center operators — each with the measurable performance gap between tiers, so a price premium can be weighed against the capability it actually buys.
        </div>

        {/* 1 — GPU ranking */}
        <Section title="GPU ranking — compute density, precision support, memory capacity & bandwidth" style={{ marginBottom: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
              <thead><tr>
                <th style={th("left")}>RANK</th><th style={th("left")}>GPU</th><th style={th()}>BF16 DENSE TF</th><th style={th()}>FP8 TF</th><th style={th()}>FP4 TF</th>
                <th style={th("left")}>PRECISIONS</th><th style={th()}>VRAM GB</th><th style={th()} title="Largest model the VRAM holds at FP8 (~1 byte/param) with 20% KV/activation headroom, single GPU">MAX MODEL (FP8)</th><th style={th()}>MEM BW TB/s</th><th style={th()}>× H100 COMPUTE</th><th style={th()}>× H100 BW</th><th style={th()}>MKT $/HR</th><th style={th()} title="Regression-implied fair value vs H100, holding fabric/operator/SLA fixed">MODEL $ VS H100</th>
              </tr></thead>
              <tbody>
                {["B300", "B200", "H200", "H100", "A100_80", "L40S"].map((k, i) => {
                  const g = GPU_REF[k];
                  const mkt = { B300: 5.00, B200: 3.60, H200: 2.30, H100: 1.85, A100_80: 1.10, L40S: 0.75 }[k];
                  const xC = g.tflops / GPU_REF.H100.tflops, xB = g.bw / GPU_REF.H100.bw;
                  const maxModelB = g.vram * 0.85 / 1.2; // FP8 ≈ 1 byte/param, 20% headroom for KV + activations
                  const dVal = gpuFairValue(k) - GPU_BASELINE_FAIR;
                  return (
                    <tr key={k}>
                      <td style={td({ color: "rgba(255,255,255,0.4)" })}>{i + 1}</td>
                      <td style={td({ color: "#e2e8f0", fontWeight: 600 })}>{g.label} <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 9 }}>({g.gen})</span></td>
                      <td style={td({ textAlign: "right", color: VI })}>{g.tflops.toLocaleString()}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{g.fp8 ? g.fp8.toLocaleString() : "—"}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.55)" })}>{g.fp4 ? g.fp4.toLocaleString() : "—"}</td>
                      <td style={td({ color: "rgba(255,255,255,0.5)", fontSize: 9.5 })}>{precisionsOf(k).join(" · ")}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.6)" })}>{g.vram}</td>
                      <td style={td({ textAlign: "right", color: "#67e8f9" })}>~{Math.round(maxModelB)}B</td>
                      <td style={td({ textAlign: "right", color: "#67e8f9" })}>{g.bw.toFixed(2)}</td>
                      <td style={td({ textAlign: "right", color: xC >= 1 ? "#6ee7b7" : "#fbbf24", fontWeight: 600 })}>{xC.toFixed(2)}×</td>
                      <td style={td({ textAlign: "right", color: xB >= 1 ? "#6ee7b7" : "#fbbf24" })}>{xB.toFixed(2)}×</td>
                      <td style={td({ textAlign: "right", color: "#e2e8f0" })}>{fmtUSD(mkt, 2)}</td>
                      <td style={td({ textAlign: "right", color: dVal >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 600 })}>{(dVal >= 0 ? "+" : "−") + fmtUSD(Math.abs(dVal), 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 6, lineHeight: 1.6 }}>
            MAX MODEL = the largest model the VRAM holds at FP8 (~1 byte/param, 20% headroom for KV cache + activations) on a single GPU — VRAM decides which models fit at all. MODEL $ VS H100 is the regression's implied fair value for the chip vs an H100, holding fabric, operator, and SLA fixed. FP8/FP4 support is a hard capability line: A100 (no FP8) is locked out of modern low-precision serving. For compute-bound training weight ×compute; for decode-bound serving weight ×BW — bandwidth, not FLOPs, sets inference speed.
          </div>
        </Section>

        {/* 2 — Interconnect ranking */}
        <Section title="Interconnect ranking — scale-up (inside the node/rack) and scale-out (across nodes)" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: VI, fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Scale-up domain — GPU↔GPU inside one coherent pool</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F, marginBottom: 12 }}>
            <thead><tr>
              <th style={th("left")}>RANK</th><th style={th("left")}>FABRIC</th><th style={th()}>PER-GPU BW</th><th style={th()}>DOMAIN SIZE</th><th style={th()}>× PCIe 5</th><th style={th()} title="Regression-implied fair value vs PCIe-only, holding GPU/operator/SLA fixed">MODEL $ VS PCIe</th><th style={th("left")}>WHAT IT UNLOCKS</th>
            </tr></thead>
            <tbody>
              {[
                ["1", "NVLink 5 + NVSwitch (GB200/NVL72)", "1.8 TB/s", "72 GPUs", "28×", "nvlink5", "rack-scale coherent memory; trillion-param inference & giant KV caches without sharding penalties"],
                ["2", "NVLink 4 + NVSwitch (HGX H100/H200)", "900 GB/s", "8 GPUs", "14×", "nvlink4", "full-node tensor parallelism; the baseline for serious training and 70B+ FP16 serving"],
                ["3", "NVLink bridge (pairwise, L40S/A100 PCIe)", "600 GB/s", "2 GPUs", "9×", "nvlink", "cheap 2-GPU pooling; no full-node collective performance"],
                ["4", "PCIe 5.0 x16 only", "~64 GB/s", "1 GPU", "1×", "pcie", "single-GPU workloads only; multi-GPU jobs bottleneck immediately"],
              ].map(r => {
                const dVal = scaleUpFairValue(r[5]) - SCALEUP_BASELINE_FAIR;
                return (
                <tr key={r[1]}>
                  <td style={td({ color: "rgba(255,255,255,0.4)" })}>{r[0]}</td>
                  <td style={td({ color: "#e2e8f0", fontWeight: 600 })}>{r[1]}</td>
                  <td style={td({ textAlign: "right", color: VI })}>{r[2]}</td>
                  <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.6)" })}>{r[3]}</td>
                  <td style={td({ textAlign: "right", color: "#6ee7b7", fontWeight: 600 })}>{r[4]}</td>
                  <td style={td({ textAlign: "right", color: dVal > 0.005 ? "#6ee7b7" : "rgba(255,255,255,0.45)", fontWeight: 600 })}>{dVal > 0.005 ? "+" + fmtUSD(dVal, 2) : "—"}</td>
                  <td style={td({ color: "rgba(255,255,255,0.5)", fontSize: 9.5 })}>{r[6]}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 10, color: VI, fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Scale-out fabric — node↔node across the cluster</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
            <thead><tr>
              <th style={th("left")}>RANK</th><th style={th("left")}>FABRIC</th><th style={th()}>PER-GPU BW</th><th style={th()}>TYPICAL ALL-REDUCE EFF.</th><th style={th()}>PRACTICAL JOB CEILING</th><th style={th()} title="Regression-implied fair value vs plain Ethernet, holding GPU/operator/SLA fixed">MODEL $ VS ETH</th><th style={th("left")}>NOTES</th>
            </tr></thead>
            <tbody>
              {[
                ["1", "InfiniBand NDR 400G (rail-optimized)", "400 Gb/s", "~90–95%", "10k+ GPUs", "ib_ndr", "in-network reduction (SHARP), lossless by design; the default for frontier training"],
                ["2", "InfiniBand HDR 200G", "200 Gb/s", "~85–90%", "~4k GPUs", "ib_ndr", "previous gen; still solid for mid-scale training"],
                ["3", "RoCE v2 400G Ethernet (well-tuned)", "400 Gb/s", "~75–90%", "~2k GPUs", "roce", "matches IB on paper; in practice tuning-sensitive (PFC/ECN) — quality varies by operator"],
                ["4", "Standard Ethernet (no RDMA)", "≤100 Gb/s", "~30–50%", "1 node", "eth", "fine for serving small models per-node; multi-node training effectively non-viable"],
              ].map(r => {
                const dVal = scaleOutFairValue(r[5]) - SCALEOUT_BASELINE_FAIR;
                return (
                <tr key={r[1]}>
                  <td style={td({ color: "rgba(255,255,255,0.4)" })}>{r[0]}</td>
                  <td style={td({ color: "#e2e8f0", fontWeight: 600 })}>{r[1]}</td>
                  <td style={td({ textAlign: "right", color: VI })}>{r[2]}</td>
                  <td style={td({ textAlign: "right", color: "#6ee7b7" })}>{r[3]}</td>
                  <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.6)" })}>{r[4]}</td>
                  <td style={td({ textAlign: "right", color: dVal > 0.005 ? "#6ee7b7" : "rgba(255,255,255,0.35)", fontWeight: 600 })}>{dVal > 0.005 ? "+" + fmtUSD(dVal, 2) : "~$0"}</td>
                  <td style={td({ color: "rgba(255,255,255,0.5)", fontSize: 9.5 })}>{r[6]}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 6, lineHeight: 1.6 }}>
            At scale, training throughput ≈ compute × communication efficiency, so dropping from IB (~90%+) to poorly-tuned RoCE (~75%) wastes ~15% of every GPU-hour. MODEL $ columns are the regression's implied fair value vs the lowest tier. The scale-out column reads ~$0 because in this catalog fabric quality moves together with GPU generation and scale-up domain, so the ridge attributes the interconnect premium almost entirely to <b style={{ color: "#e2e8f0" }}>scale-up</b> (NVLink) — the model can't cleanly separate the two, not evidence that fabric is free. Scale-up matters most for inference and tensor parallelism; scale-out for training job size. A lower rate on plain Ethernet isn't cheaper — it's a smaller product.
          </div>
          <details style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
            <summary style={{ cursor: "pointer", fontSize: 10.5, color: VI, fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, userSelect: "none", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>▸</span> Show interconnect topology diagrams (fat tree · rail alignment · radix · GPU:NIC · oversubscription)
            </summary>
            <div style={{ marginTop: 10 }}>
              <iframe
                src="/interconnect-diagrams.html"
                title="Interconnect topology reference — what good scale-out fabric looks like"
                style={{ width: "100%", height: "640px", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, background: "#0b1118", display: "block" }}
              />
            </div>
          </details>
        </Section>

        {/* 3 — Operator ranking (ClusterMAX) */}
        <Section title="Data-center operator ranking — SemiAnalysis ClusterMAX 2.0 tiers (Nov 2025)" style={{ marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
            <thead><tr>
              <th style={th("left")}>TIER</th><th style={th("left")}>OPERATORS</th><th style={th("left")}>WHAT THE TIER MEANS FOR A BUYER</th>
            </tr></thead>
            <tbody>
              {[
                ["Platinum", "#67e8f9", "CoreWeave (only member)", "excels across all 10 criteria (security, orchestration, networking, reliability, support); proven 10k+ GPU operations — the tier for bet-the-company training runs"],
                ["Gold", "#fbbf24", "Nebius · Oracle · Azure · Fluidstack · Crusoe", "strong across the board with minor gaps; wins competitive deals — safe default for production training"],
                ["Silver", "#e2e8f0", "Together · Lambda · GCP · AWS · Scaleway · Cirrascale · GCORE · Firmus/SMC · GMO · Vultr · Voltage Park · TensorWave", "adequate with noticeable gaps (support, networking consistency); fine for inference fleets and mid-scale training with your own ops muscle"],
                ["Bronze", "#c4956a", "19 providers incl. GMI · RunPod · Vast.ai · DigitalOcean · IBM Cloud", "meets minimum criteria — last tier SemiAnalysis directly recommends; expect inconsistent support or networking gaps, price accordingly"],
                ["Underperforming", "#f87171", "22 providers (missing security attestation, older GPUs, or misconfigured RDMA/ACS)", "cheap rates that buy real operational risk — health checks, PCIe ACS, GPUDirect issues surface as lost goodput"],
              ].map(r => (
                <tr key={r[0]}>
                  <td style={td({ color: r[1], fontWeight: 700 })}>{r[0]}</td>
                  <td style={td({ color: "rgba(255,255,255,0.65)", fontSize: 10 })}>{r[2]}</td>
                  <td style={td({ color: "rgba(255,255,255,0.5)", fontSize: 9.5 })}>{r[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 6, lineHeight: 1.6 }}>
            Tiers per SemiAnalysis ClusterMAX 2.0 (84 neoclouds rated Nov 2025 on 10 criteria incl. security, orchestration, networking, reliability, support). The tier prices <em>goodput</em>, not the silicon: a Bronze cluster that loses 10–20% of wall-clock to node failures, slow storage, or fabric misconfiguration erases its discount on a serious training run, while for fault-tolerant inference fleets a cheaper tier can be the rational buy. Ratings move every cycle — verify before sourcing.
          </div>
        </Section>

        {/* 4 — Workload → parallelism → fabric */}
        <Section title="Workload → parallelism → fabric — for the researcher conversation" style={{ marginBottom: 12 }}>
          <div style={{ padding: "10px 12px", background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.18)", borderRadius: 4, marginBottom: 10, fontSize: 10.5, lineHeight: 1.6, color: "rgba(255,255,255,0.75)" }}>
            <b style={{ color: VI }}>Why this belongs on the vendor conversation, not the internal engineering one.</b> Parallelism (DP · TP · PP · MoE · SP) is software — ML engineers pick it based on model size, memory, and latency. But each strategy has a distinct communication pattern that dictates the <em>hardware</em> the cluster must provide: intra-node NVLink BW, cross-node fabric BW/latency, oversubscription, rail alignment. Two nominally identical H100 clusters can diverge sharply in goodput — NVL72 + rail-aligned 400G IB vs. 8×H100 PCIe boxes on standard Ethernet — the latter <b style={{ color: "#f87171" }}>can't run TP at all</b> and any MoE workload strands from all-to-all congestion. You need enough fluency to translate "TP=8 + MoE cross-node" into concrete network specs so the vendor can quote them, and so you can push back on an oversubscribed cluster. <b style={{ color: "#e2e8f0" }}>The three-step flow:</b> <b style={{ color: "#86efac" }}>(1)</b> talk to researchers → identify parallelism strategies for your workloads &nbsp;→&nbsp; <b style={{ color: "#fbbf24" }}>(2)</b> use this table → derive the fabric specs those strategies demand &nbsp;→&nbsp; <b style={{ color: "#67e8f9" }}>(3)</b> vendor conversation → "quote a cluster that meets these specs, and here's how we'll test it at acceptance."
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(167,139,250,0.18)" }}>
              <b style={{ color: "#67e8f9" }}>Vendor questions this table arms you to ask</b> — pick from these based on which parallelism strategies your workloads use. Every one has a right answer you can score against.
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "rgba(255,255,255,0.65)" }}>
                <li><b style={{ color: "#e2e8f0" }}>Intra-node:</b> "What's the NVLink domain size (8-GPU HGX, 72-GPU NVL72, or PCIe-only)? Per-GPU NVLink bandwidth in GB/s? Any partitioning that fragments the domain (MIG, vGPU)?" — TP and SP are dead without NVLink.</li>
                <li><b style={{ color: "#e2e8f0" }}>Cross-node:</b> "InfiniBand generation (NDR / XDR) and per-GPU cross-node bandwidth? Ethernet or IB? Per-GPU rate in Gbps (400 baseline / 800 next-gen)?" — PP over Ethernet is inference-only territory.</li>
                <li><b style={{ color: "#e2e8f0" }}>Topology:</b> "Fat-tree bisection ratio? Oversubscription at each tier (leaf, spine)? Number of switch hops end-to-end?" — MoE dies if this isn't 1:1 or 2:1.</li>
                <li><b style={{ color: "#e2e8f0" }}>Rail alignment:</b> "Is the fabric rail-aligned — each GPU's NIC has a dedicated switch plane? Or is it a shared / partially-shared fabric?" — the single question that most vendors don't volunteer and that most determines MoE / all-to-all goodput.</li>
                <li><b style={{ color: "#e2e8f0" }}>Acceptance test:</b> "Will you commit to running <em>my</em> NCCL all-reduce, all-to-all, and end-to-end MFU benchmark at handover, at target message sizes? What's the minimum result you'll cure to?" — never sign without this.</li>
                <li><b style={{ color: "#e2e8f0" }}>Fleet homogeneity:</b> "Firmware / NCCL / driver version pinning across the fleet? Are all nodes the same hardware SKU?" — a mixed fleet destroys collective performance because slowest node paces the group.</li>
              </ul>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
              <thead><tr>
                <th style={th("left")}>STRATEGY</th><th style={th("left")}>WHAT'S SPLIT</th><th style={th("left")}>COMMUNICATION</th><th style={th("left")}>FABRIC REQUIREMENT</th>
              </tr></thead>
              <tbody>
                {[
                  ["Data parallel (DP / FSDP / ZeRO)", "Batch across full-model replicas (weights sharded across replicas in FSDP/ZeRO-3)", "Gradient all-reduce, once per step — hides behind backward compute", "Most forgiving. Standard Ethernet often OK; ≥100 GbE for large models. If you're only doing DP you can save on fabric."],
                  ["Tensor parallel (TP)", "One layer's weight matrix (columns or rows) across GPUs", "All-reduce every layer, forward AND backward — on the critical path", "MUST stay intra-node on NVLink (SXM ≥900 GB/s / NVL72 ≥1.8 TB/s). PCIe boxes or cross-node = will not achieve theoretical throughput. Ask: NVLink BW per GPU, NVLink domain size (8 / 72)."],
                  ["Pipeline parallel (PP)", "Model by depth; each GPU owns a contiguous layer block", "Point-to-point activation sends at stage boundaries; latency-sensitive due to bubbles", "InfiniBand cross-node is fine (NDR 400 Gbps per GPU baseline for large models). Latency matters more than bandwidth — high hop-count topologies hurt. Ask: per-GPU cross-node BW, switch hop count end-to-end."],
                  ["Expert parallel (MoE)", "Router sends each token to top-k experts sharded across GPUs (typically 8–64 experts)", "All-to-all TWICE per layer (dispatch + combine). Uneven per-token load, bursty.", "Brutal. Needs full-bisection non-blocking fabric, RAIL-ALIGNED topology (each GPU's NIC → dedicated switch plane), oversubscription ≤2:1 (ideally 1:1). Oversubscribed or non-rail-aligned = MoE dies from congestion, not compute. Ask: bisection BW, oversubscription ratio, rail alignment (yes/no)."],
                  ["Sequence parallel (SP)", "One long sequence split by token position, paired with TP", "All-gather across the sequence dim for attention", "Same intra-node NVLink demand as TP; long-context (128K+) amplifies it. Ask: same as TP."],
                  ["Inference — prefill", "Long input processed in one shot (FLOPs-bound)", "Similar to training — TP inside NVLink, DP across", "FLOPs-heavy → compute-bound. Fabric like training-TP."],
                  ["Inference — decode", "Single stream, one token at a time (BW-bound)", "Re-reads full KV cache + weights per step; TP all-reduce per layer if sharded", "Memory-BW-bound (HBM BW is the ceiling). If serving with TP shard, NVLink required. HBM capacity limits max batch size."],
                ].map(r => (
                  <tr key={r[0]}>
                    <td style={td({ color: "#e2e8f0", fontWeight: 600 })}>{r[0]}</td>
                    <td style={td({ color: "rgba(255,255,255,0.55)", fontSize: 10 })}>{r[1]}</td>
                    <td style={td({ color: "rgba(255,255,255,0.55)", fontSize: 10 })}>{r[2]}</td>
                    <td style={td({ color: "#67e8f9", fontSize: 10 })}>{r[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 8, lineHeight: 1.6 }}>
            Translate a researcher's ask ("400B dense", "70B decode at 100 QPS with 8K context", "MoE 8-expert top-2", "128K sequence fine-tune") into the parallelism split, its comm pattern, and the fabric requirement that follows. The fabric column is where two nominally identical clusters silently diverge in goodput.
          </div>
          <details style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
            <summary style={{ cursor: "pointer", fontSize: 10.5, color: VI, fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, userSelect: "none", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>▸</span> Show parallelism diagrams (DP · TP · PP · MoE · SP)
            </summary>
            <div style={{ marginTop: 10 }}>
              <iframe
                src="/parallelism-diagrams.html"
                title="Parallelism strategies — visual diagrams"
                style={{ width: "100%", height: "560px", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, background: "#0b1118", display: "block" }}
              />
            </div>
          </details>
        </Section>

        {/* Comparison */}
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.18)", marginTop: 16, fontFamily: F, lineHeight: 1.5 }}>
          Catalog prices scraped from computeprices.com (Jul 2026 snapshot); GPU specs and ClusterMAX ratings are Apr 2026 / Nov 2025 references. Verify against live vendor spec sheets and current SemiAnalysis ratings before real sourcing decisions. This tab is a comparison catalog, not tied to the Compute Supply book; add an accepted vendor to Compute Supply's deal evaluator to price the actual contract.
        </div>
      </div>
    </div>
  );
}

return App;
})();

// ═════════════════════════════════════════════════════════════════════════════
// FINANCIALS — the P&L that falls out of the Compute Supply and Compute Demand
// books together. Revenue comes from the demand book (what customers pay);
// COGS comes from the supply book (what we pay vendors) — reserved capacity is
// a fixed cost paid whether or not it's matched to demand; on-demand/spot
// capacity is a variable cost incurred only to cover demand beyond what
// reserved capacity delivers. Same shared data layer as Compute Supply/Demand,
// so this tab has no seed data of its own — it's a pure derived view.
// ═════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════
// PROJECTIONS — 12–24 month supply/demand outlook for compute and tokens.
// Baseline comes from the shared books: booked demand (Compute Demand) and the
// contracted supply schedule with roll-offs and ramps (Compute Supply). On top
// of that baseline, a growth model extends demand beyond bookings, a renewal
// policy decides what happens as contracts expire. Prices decline over the
// horizon on both sides (sell rates and renewal costs), so the output is a
// full projected P&L, token-volume curve, and a capacity-decision ledger:
// when the gap opens and how much must be sourced.
// ═════════════════════════════════════════════════════════════════════════════

const ProjectionsApp = (() => {

const F = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const RO = "#f472b6"; // projections accent: rose
const HRS_MO = 730;
const PGPU = {
  H100: { tflops: 989, bw: 3.35, market: 1.85 }, H200: { tflops: 989, bw: 4.8, market: 2.30 },
  B200: { tflops: 2250, bw: 8.0, market: 3.60 }, B300: { tflops: 2900, bw: 8.0, market: 5.00 },
  A100_80: { tflops: 312, bw: 2.0, market: 1.10 }, L40S: { tflops: 181, bw: 0.86, market: 0.75 },
};
const h100e = (gpu, n) => n * (PGPU[gpu].tflops / PGPU.H100.tflops);
const fmtUSD = (n, d) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a < 1 && n !== 0) return "$" + n.toFixed(d ?? 3); return "$" + n.toLocaleString(undefined, { maximumFractionDigits: d ?? 0 }); };
const fmtBig = (n) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a >= 1e12) return (n / 1e12).toFixed(1) + "T"; if (a >= 1e9) return (n / 1e9).toFixed(1) + "B"; if (a >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (a >= 1e3) return (n / 1e3).toFixed(1) + "K"; return n.toFixed(0); };
const fmtPct = (n, d = 0) => (n * 100).toFixed(d) + "%";
const sgn = n => (n >= 0 ? "+" : "−") + fmtUSD(Math.abs(n));
const TE = "#34d399"; // financials accent: emerald
const GPU_LABEL = { H100: "H100", H200: "H200", B200: "B200", B300: "B300", A100_80: "A100", L40S: "L40S" };

function SectionHeader({ title, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 12px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#e2e8f0", fontFamily: F, textTransform: "uppercase" }}>{title}</div>
      <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
      {right}
    </div>
  );
}
function BarRow({ label, value, max, color, sub }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: "rgba(255,255,255,0.5)" }}>{label}</span>
        <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmtUSD(value)}{sub && <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400 }}> · {sub}</span>}</span>
      </div>
      <div style={{ width: "100%", height: 6, background: "rgba(255,255,255,0.04)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

// ─── Current-month P&L from the live books (ported from the old Financials tab):
// reserved capacity is a fixed cost (paid whether matched to demand or not);
// on-demand/spot is variable, drawn cheapest-first only to cover overflow.
// Revenue is recognized only on the served fraction of booked demand. ───────
function computeMonth(demandRows, m, byClassSupply) {
  const demGpusByClass = {}, bookedByClass = {};
  let bookedTrain = 0, bookedInf = 0;
  for (const d of demandRows) {
    if ((m - 1) >= d.startMo && (m - 1) < d.startMo + d.durationMo) {
      demGpusByClass[d.gpu] = (demGpusByClass[d.gpu] || 0) + d.gpus;
      const r = d.gpus * d.price * HRS_MO;
      bookedByClass[d.gpu] = (bookedByClass[d.gpu] || 0) + r;
      if (d.kind === "training") bookedTrain += r; else bookedInf += r;
    }
  }
  let reservedCogs = 0, variableCogs = 0, idleReservedCost = 0, shortfallGpus = 0, servedRevenue = 0, unservedRevenue = 0, cashReserved = 0, prepaidConsumed = 0;
  const classesSeen = new Set();
  for (const gpu of Object.keys(byClassSupply)) {
    classesSeen.add(gpu);
    const cls = byClassSupply[gpu];
    let reservedDelivered = 0, reservedCostThisClass = 0, rateWeighted = 0;
    for (const r of cls.reserved) {
      const lf = liveFracOf(r, m);
      const g = r.gpus * lf;
      reservedDelivered += g;
      const cost = r.gpus * r.rate * HRS_MO * lf;
      reservedCostThisClass += cost;
      cashReserved += cost * (1 - (r.upfrontPct || 0) / 100);
      prepaidConsumed += cost * ((r.upfrontPct || 0) / 100);
      rateWeighted += r.rate * g;
    }
    reservedCogs += reservedCostThisClass;
    const blendedRate = reservedDelivered > 0 ? rateWeighted / reservedDelivered : 0;
    const demGpus = demGpusByClass[gpu] || 0;
    const idleGpus = Math.max(0, reservedDelivered - demGpus);
    idleReservedCost += idleGpus * blendedRate * HRS_MO;
    let overflow = Math.max(0, demGpus - reservedDelivered);
    const others = [...cls.other].sort((a, b) => a.rate - b.rate);
    for (const r of others) {
      if (overflow <= 0) break;
      const avail = r.gpus * liveFracOf(r, m);
      const use = Math.min(avail, overflow);
      variableCogs += use * r.rate * HRS_MO;
      overflow -= use;
    }
    shortfallGpus += Math.max(0, overflow);
    const servedFrac = demGpus > 0 ? (demGpus - Math.max(0, overflow)) / demGpus : 1;
    const booked = bookedByClass[gpu] || 0;
    servedRevenue += booked * servedFrac;
    unservedRevenue += booked * (1 - servedFrac);
  }
  for (const gpu of Object.keys(bookedByClass)) {
    if (!classesSeen.has(gpu)) { unservedRevenue += bookedByClass[gpu]; shortfallGpus += demGpusByClass[gpu]; }
  }
  const totalBooked = bookedTrain + bookedInf;
  const servedShare = totalBooked > 0 ? servedRevenue / totalBooked : 1;
  const revenue = servedRevenue;
  const revTrain = bookedTrain * servedShare, revInf = bookedInf * servedShare;
  const totalCogs = reservedCogs + variableCogs;
  const cashCogs = cashReserved + variableCogs;
  return { revenue, revTrain, revInf, unservedRevenue, reservedCogs, variableCogs, totalCogs, cashCogs, prepaidConsumed, idleReservedCost, shortfallGpus, grossMargin: revenue - totalCogs };
}

function Metric({ label, value, sub, accent, warn }) {
  return (
    <div style={{ background: warn ? "rgba(248,113,113,0.1)" : "rgba(255,255,255,0.06)", border: `1px solid ${warn ? "rgba(248,113,113,0.28)" : "rgba(255,255,255,0.11)"}`, borderRadius: 8, padding: "10px 12px", flex: "1 1 150px", minWidth: 150 }}>
      <div style={{ fontSize: 10, color: warn ? "rgba(248,113,113,0.7)" : "rgba(255,255,255,0.35)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 2, fontFamily: F }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, color: accent || "#e2e8f0", fontFamily: F, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2, fontFamily: F }}>{sub}</div>}
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ marginBottom: 11 }}><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>{children}</div>;
}
function Slider({ label, value, onChange, min, max, step = 1, fmtFn, hint }) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: RO, height: 3 }} />
        <span style={{ fontSize: 12.5, color: RO, fontFamily: F, fontWeight: 600, minWidth: 66, textAlign: "right" }}>{fmtFn ? fmtFn(value) : value}</span>
      </div>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}
function Section({ title, children, style: s }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.1)", ...s }}>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: F, fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  );
}
const td = (extra = {}) => ({ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", ...extra });
const th = (align = "right") => ({ padding: "5px 8px", textAlign: align, color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 });

const SCENARIOS = {
  bear: { label: "Bear", gInf: 3,  churn: 3,   upsell: 0.5, priceDecline: 45, costDecline: 25, cadSize: 256, cadEvery: 6, renewPct: 50 },
  base: { label: "Base", gInf: 8,  churn: 1.5, upsell: 1,   priceDecline: 30, costDecline: 20, cadSize: 512, cadEvery: 4, renewPct: 75 },
  bull: { label: "Bull", gInf: 14, churn: 1,   upsell: 2,   priceDecline: 20, costDecline: 15, cadSize: 768, cadEvery: 3, renewPct: 90 },
};

// ─── Monthly demand table defaults ────────────────────────────────────────────
// Builds an analyst-style DRIVER table: instead of storing absolute demand, we
// store the per-month rate drivers (new-logo growth %, up-sell %, churn %) for
// inference and the discrete new-run / roll-off (H100e) for training, plus the
// starting anchors (infBase / trainBase). The roll-forward (buildMonthly) turns
// these drivers into the beginning→ending waterfall the engine reads. Month 1 is
// the starting actual (0% drivers); growth begins month 2 — standard convention.
// Training new/roll-off are first-differenced from the original booked+cadence
// series so the seeded curve reproduces the old model exactly before any edits.
function generateMonthlyDefaults(demand, horizon, gInf, churn, upsell, cadSize, cadEvery, cadDur, inclPipeline) {
  const dRows = demand.filter(r => inclPipeline || r.status === "committed");
  const infBase = dRows.reduce((s, r) => s + ((0 >= r.startMo && 0 < r.startMo + r.durationMo && r.kind === "inference") ? h100e(r.gpu, r.gpus) : 0), 0);
  const bookedAt = (m, kind) => dRows.reduce((s, r) => s + (((m - 1) >= r.startMo && (m - 1) < r.startMo + r.durationMo && r.kind === kind) ? h100e(r.gpu, r.gpus) : 0), 0);
  // original training series (booked + cadence), first-differenced into new/roll-off
  const trainSeries = [];
  for (let m = 1; m <= horizon; m++) {
    let cad = 0;
    if (cadSize > 0 && cadEvery > 0) { for (let s = cadEvery; s <= m; s += cadEvery) if (m < s + cadDur) cad += cadSize; }
    trainSeries.push(bookedAt(m, "training") + cad);
  }
  const trainBase = Math.round(trainSeries[0] || 0);
  const rows = [];
  for (let m = 1; m <= horizon; m++) {
    const first = m === 1;
    const dTrain = first ? 0 : trainSeries[m - 1] - trainSeries[m - 2];
    rows.push({
      m,
      infGrowthPct: first ? 0 : gInf,
      infUpsellPct: first ? 0 : upsell,
      infChurnPct: first ? 0 : churn,
      trainNew: Math.round(Math.max(0, dTrain)),
      trainRolloff: Math.round(Math.max(0, -dTrain)),
    });
  }
  return { rows, infBase: Math.round(infBase), trainBase };
}

// ─── Roll-forward: drivers → beginning/ending waterfall per month ─────────────
// Inference is an additive NRR waterfall (BEG + new-growth + up-sell − churn =
// END), so the line items literally reconcile. Training rolls BEG + new − off.
// Each month's END becomes the next month's BEG. END values are what the engine
// consumes as demInf / demTrain.
function buildMonthly(rows, infBase, trainBase) {
  let begInf = infBase, begTrain = trainBase;
  return rows.map(r => {
    const newAdds = begInf * (r.infGrowthPct || 0) / 100;
    const expansion = begInf * (r.infUpsellPct || 0) / 100;
    const churned = begInf * (r.infChurnPct || 0) / 100;
    const endInf = Math.max(0, begInf + newAdds + expansion - churned);
    const endTrain = Math.max(0, begTrain + (r.trainNew || 0) - (r.trainRolloff || 0));
    const netPct = begInf > 0 ? (newAdds + expansion - churned) / begInf * 100 : 0;
    const out = {
      m: r.m,
      begInf, newAdds, expansion, churned, endInf, netPct,
      begTrain, trainNew: r.trainNew || 0, trainRolloff: r.trainRolloff || 0, endTrain,
      demInf: endInf, demTrain: endTrain,
    };
    begInf = endInf; begTrain = endTrain;
    return out;
  });
}

// ─── The projection engine (pure function so the tornado can re-run it) ──────
// ─── Heterogeneous chip classification ───────────────────────────────────────
// A GPU's "lean" = how its compute density compares to its bandwidth density,
// relative to H100. Compute-lean parts (high FLOPs per unit bandwidth) are the
// efficient home for TRAINING (compute-bound); bandwidth-lean parts are the
// efficient home for INFERENCE decode (memory-bandwidth-bound). Balanced parts
// serve either at par. Returns "compute" | "inference" | "balanced".
const WORKLOAD_LEAN = (gpu) => {
  const g = PGPU[gpu]; if (!g) return "balanced";
  const ratio = (g.tflops / PGPU.H100.tflops) / (g.bw / PGPU.H100.bw);
  return ratio > 1.15 ? "compute" : ratio < 0.87 ? "inference" : "balanced";
};
// Cross-serving efficiency: a chip serving its off-workload delivers less
// effective capacity (a compute-dense chip wastes bandwidth on decode; a
// bandwidth-dense chip is FLOP-starved on training). 1.0 = no penalty.
const CROSS_EFF = 0.7;

function project(P) {
  const { supply, horizon, monthly,
    priceDecline, costDecline, genMo, genAdv, renewPct, renewTerm, tokPerHr, trainPrice, infPrice, hetero = true } = P;
  const act = supply.filter(r => r.status === "active");
  const rsv = act.filter(r => r.structure === "reserved");
  const flex = act.filter(r => r.structure !== "reserved");
  const liveFrac = (r, m) => { const ramp = r.rampMo || 0; return ramp > 0 ? Math.min(1, m / ramp) : 1; };

  // Which pool a position feeds. "balanced" positions count toward whichever
  // side needs them (modeled as available to both at full efficiency).
  const poolOf = (r) => WORKLOAD_LEAN(r.gpu);

  const mktCostNow = 1.85;
  // Flex (on-demand/spot) capacity, split by pool.
  const flexByPool = { compute: 0, inference: 0, balanced: 0 };
  let flexCostSum = 0, flexHtot = 0;
  for (const r of flex) { const h = h100e(r.gpu, r.gpus); flexByPool[poolOf(r)] += h; flexCostSum += r.rate * (PGPU[r.gpu].tflops / PGPU.H100.tflops) * r.gpus; flexHtot += h; }
  const flexRate = flexHtot > 0 ? flexCostSum / flexHtot : 1.4;
  const flexH = flexHtot;

  const months = [];
  const renewals = [];  // { srcId, h100e, rate, endM, pool } — finite-term, re-renews with attrition
  const ledger = [];
  let cashCommitted = 0;
  const now = new Date();
  const lbl = i => { const mo = (now.getMonth() + i) % 12 + 1; const yr = (now.getFullYear() + Math.floor((now.getMonth() + i) / 12)) % 100; return `${mo}/${String(yr).padStart(2, "0")}`; };

  for (let m = 1; m <= horizon; m++) {
    const t = (m - 0.5) / 12;
    const decay = Math.pow(1 - priceDecline / 100, t);
    const sellTrain = trainPrice * decay;
    const sellInf = infPrice * decay;
    const genFactor = m >= genMo ? (1 - genAdv / 100) : 1;
    const mktCost = mktCostNow * Math.pow(1 - costDecline / 100, t) * genFactor;

    // ── Demand split by workload ──
    const row = monthly[m - 1] || monthly[monthly.length - 1] || { demInf: 0, demTrain: 0 };
    const demInf = Math.max(0, row.demInf);
    const demTrain = Math.max(0, row.demTrain);
    const dem = demInf + demTrain;

    // ── Reserved supply by pool: existing book + handle renewals ──
    const supRes = { compute: 0, inference: 0, balanced: 0 };
    let costExisting = 0;
    for (const r of rsv) {
      const pool = poolOf(r);
      if (r.remMo >= m) { supRes[pool] += h100e(r.gpu, r.gpus) * liveFrac(r, m); costExisting += r.gpus * r.rate * HRS_MO * liveFrac(r, m); }
      else if (r.remMo === m - 1 && renewPct > 0 && !renewals.some(x => x.srcId === r.id)) {
        const h = h100e(r.gpu, r.gpus) * (renewPct / 100);
        renewals.push({ srcId: r.id, h100e: h, rate: mktCost, endM: m + renewTerm - 1, pool });
        cashCommitted += h * mktCost * HRS_MO * renewTerm;
        ledger.push({ m, label: lbl(m - 1), action: "Renewal", detail: `${fmtBig(Math.round(h))} H100e (${r.provider} ${r.gpu}, ${pool}) re-signed ${renewTerm}mo at ~${fmtUSD(mktCost, 2)}/H100e-hr` });
      }
    }
    for (const x of renewals) {
      if (x.endM === m - 1 && !x.rolled) {
        x.rolled = true;
        if (renewPct > 0) {
          const h = x.h100e * (renewPct / 100);
          renewals.push({ srcId: `re${x.srcId}-${m}`, h100e: h, rate: mktCost, endM: m + renewTerm - 1, pool: x.pool });
          cashCommitted += h * mktCost * HRS_MO * renewTerm;
          ledger.push({ m, label: lbl(m - 1), action: "Re-renewal", detail: `${fmtBig(Math.round(h))} H100e (${x.pool}) rolls again ${renewTerm}mo at ~${fmtUSD(mktCost, 2)}/H100e-hr` });
        }
      }
    }
    let costRenew = 0;
    for (const x of renewals) { if (m <= x.endM) { supRes[x.pool] += x.h100e; costRenew += x.h100e * x.rate * HRS_MO; } }

    // ── Total capacity per pool (reserved + flex), including balanced ──
    // Balanced capacity is a shared reservoir usable by either workload.
    const capCompute = supRes.compute + flexByPool.compute;
    const capInf = supRes.inference + flexByPool.inference;
    const capBal = supRes.balanced + flexByPool.balanced;

    // ── Two-pool matching with a shared balanced reservoir, then penalized
    // cross-serving of leftover off-workload capacity. ──
    // 1) Native pools serve their own workload first.
    let servedTrain = Math.min(demTrain, capCompute);
    let servedInf = Math.min(demInf, capInf);
    let needTrain = demTrain - servedTrain;
    let needInf = demInf - servedInf;
    let balLeft = capBal;
    // 2) Balanced reservoir covers remaining need (full efficiency), split
    //    proportionally to remaining need so neither workload is starved.
    const totNeed = needTrain + needInf;
    if (totNeed > 0 && balLeft > 0) {
      const useBal = Math.min(balLeft, totNeed);
      const toTrain = useBal * (needTrain / totNeed), toInf = useBal * (needInf / totNeed);
      servedTrain += toTrain; needTrain -= toTrain;
      servedInf += toInf; needInf -= toInf;
      balLeft -= useBal;
    }
    // 3) Penalized cross-serving: leftover native capacity in the OTHER pool
    //    can absorb remaining need at CROSS_EFF (each off-workload H100e yields
    //    only CROSS_EFF of effective capacity).
    let crossTrain = 0, crossInf = 0;
    const idleCompute = Math.max(0, capCompute - servedTrain);
    const idleInf = Math.max(0, capInf - servedInf);
    if (needTrain > 0 && idleInf > 0) { crossTrain = Math.min(needTrain, idleInf * CROSS_EFF); servedTrain += crossTrain; needTrain -= crossTrain; }
    if (needInf > 0 && idleCompute > 0) { crossInf = Math.min(needInf, idleCompute * CROSS_EFF); servedInf += crossInf; needInf -= crossInf; }

    const served = servedTrain + servedInf;
    const shortfall = needTrain + needInf;
    const shortTrain = needTrain, shortInf = needInf;
    const supReserved = supRes.compute + supRes.inference + supRes.balanced;
    const supTotal = capCompute + capInf + capBal;

    // Revenue on what each workload actually got served.
    const revTrain = servedTrain * sellTrain * HRS_MO;
    const revInf = servedInf * sellInf * HRS_MO;
    const revenue = revTrain + revInf;
    const servedRatio = dem > 0 ? served / dem : 0;
    const sell = served > 0 ? revenue / (served * HRS_MO) : sellInf;

    // Cost: reserved cost is committed regardless of use; flex billed on the
    // effective served-from-flex (approx: served beyond reserved).
    const overflowServed = Math.max(0, served - supReserved);
    const cogs = costExisting + costRenew + overflowServed * flexRate * HRS_MO;

    const tokens = servedInf * HRS_MO * tokPerHr * 1e6;
    const util = supTotal > 0 ? dem / supTotal : 0;
    const utilCompute = capCompute > 0 ? servedTrain / capCompute : 0;
    const utilInf = capInf > 0 ? servedInf / capInf : 0;

    months.push({ m, label: lbl(m - 1), dem, demInf, demTrain,
      capCompute, capInf, capBal, supReserved, supFlex: flexH, supTotal,
      served, servedTrain, servedInf, servedRatio, shortfall, shortTrain, shortInf,
      crossTrain, crossInf,
      supExisting: supReserved, supRenew: 0, // legacy fields for any old consumers
      revenue, revInf, revTrain, sellInf, sellTrain, cogs, gm: revenue - cogs, sell, mktCost, tokens, util, utilCompute, utilInf });
  }
  const cumGM = months.reduce((s, x) => s + x.gm, 0);
  return { months, ledger, cumGM, cashCommitted };
}

function App() {
  const supply = useBookStore(SUPPLY_STORE)[0];
  const cohorts = useBookStore(COHORT_STORE)[0];
  const [horizon, setHorizon] = useState(24);
  const [policy, setPolicy] = useBookStore(POLICY_STORE);
  const { priceDecline, costDecline, genMo, genAdv, renewPct, renewTerm } = policy;
  const [tokPerHr] = useBookStore(TOKPERHR_STORE);
  const baseline = useBookStore(BASELINE_STORE)[0];
  const baseIdx = useMemo(() => baselineIdx(baseline, horizon), [baseline, horizon]);
  const [opexPct, setOpexPct] = useState(15);

  const [pricing] = useBookStore(PRICING_STORE);

  // Scenario toggle — writes through to the same DEMAND_SCENARIO_STORE and
  // COHORT_STORE the Compute Demand tab uses, so switching here rebuilds
  // demand and every downstream number (projections, financials, supply
  // recommendations) exactly as if the user had toggled on the Demand tab.
  const [scenario] = useBookStore(DEMAND_SCENARIO_STORE);
  const switchScenario = (key) => {
    if (key === scenario) return;
    SCENARIO_COHORTS[scenario] = COHORT_STORE.get();
    DEMAND_SCENARIO_STORE.set(key);
    COHORT_STORE.set(SCENARIO_COHORTS[key]);
  };

  // Demand comes live from the Compute Demand tab's customer-segment build:
  // cohortSeries rolls the per-segment/per-region monthly drivers into
  // aggregate inference and training H100e per month, which the engine reads
  // directly. Pricing (train vs. inference $/H100e-hr) comes from the same
  // tab's pricing assumptions. Editing either re-runs everything here.
  const cohortAgg = useMemo(() => cohortSeries(cohorts, horizon, baseIdx, pricing), [cohorts, horizon, baseIdx, pricing]);
  const built = useMemo(() => cohortAgg.inf.map((infV, i) => ({ demInf: infV, demTrain: cohortAgg.train[i], endInf: infV, endTrain: cohortAgg.train[i] })), [cohortAgg]);

  const params = useMemo(() => ({ supply, horizon, monthly: built, priceDecline, costDecline, genMo, genAdv, renewPct, renewTerm, tokPerHr, trainPrice: pricing.trainPrice, infPrice: pricing.infPrice }),
    [supply, horizon, built, priceDecline, costDecline, genMo, genAdv, renewPct, renewTerm, tokPerHr, pricing]);
  const proj = useMemo(() => project(params), [params]);

  // ── Segment P&L: revenue / cost / margin by workload, customer type, region ──
  // Revenue per group = its H100e-hours x the workload sell rate x served ratio
  // (shortfall months serve everyone pro-rata). Cost is allocated pro-rata on
  // served H100e-hours, so the groups sum exactly to the headline P&L.
  const segPnl = useMemo(() => {
    const M = proj.months;
    const mk = () => ({ rev: 0, cost: 0, h: 0 });
    const wl = { Training: mk(), Inference: mk() };
    const byCust = {}; const byReg = {};
    let totServedH = 0, totCost = 0;
    M.forEach((mo, i) => { totServedH += mo.served * HRS_MO; totCost += mo.cogs; });
    const costPerH = totServedH > 0 ? totCost / totServedH : 0;
    const add = (bucket, key, h, rate) => {
      if (!bucket[key]) bucket[key] = mk();
      bucket[key].rev += h * rate; bucket[key].cost += h * costPerH; bucket[key].h += h;
    };
    M.forEach((mo, i) => {
      // Heterogeneous engine: training and inference serve at DIFFERENT ratios
      // (pool-constrained), so each workload uses its own served ratio.
      const srT = mo.demTrain > 0 ? mo.servedTrain / mo.demTrain : 0;
      const srI = mo.demInf > 0 ? mo.servedInf / mo.demInf : 0;
      wl.Training.rev += mo.revTrain; wl.Inference.rev += mo.revInf;
      wl.Training.cost += (mo.servedTrain * HRS_MO) * costPerH;
      wl.Inference.cost += (mo.servedInf * HRS_MO) * costPerH;
      wl.Training.h += mo.servedTrain * HRS_MO;
      wl.Inference.h += mo.servedInf * HRS_MO;
      cohortAgg.perSeg.forEach(sg => {
        add(byCust, sg.name, sg.inf[i] * srI * HRS_MO, mo.sellInf);
        add(byCust, sg.name, sg.train[i] * srT * HRS_MO, mo.sellTrain);
      });
      Object.entries(cohortAgg.perReg).forEach(([rg, sr2]) => {
        add(byReg, rg, sr2.inf[i] * srI * HRS_MO, mo.sellInf);
        add(byReg, rg, sr2.train[i] * srT * HRS_MO, mo.sellTrain);
      });
    });
    const fin = o => Object.entries(o).map(([k, v]) => ({ k, ...v, gm: v.rev - v.cost, pct: v.rev > 0 ? (v.rev - v.cost) / v.rev : 0 })).sort((a, b) => b.rev - a.rev);
    return { workload: fin(wl), customer: fin(byCust), region: fin(byReg) };
  }, [proj, cohortAgg]);

  // ─── Current-month financials from the live books (merged Financials tab) ───
  const byClassSupply = useMemo(() => {
    const m = {};
    for (const r of supply.filter(r => r.status === "active")) {
      m[r.gpu] = m[r.gpu] || { reserved: [], other: [] };
      (r.structure === "reserved" ? m[r.gpu].reserved : m[r.gpu].other).push(r);
    }
    return m;
  }, [supply]);
  
  const costByClass = useMemo(() => {
    const rows = [];
    for (const gpu of Object.keys(byClassSupply)) {
      const cls = byClassSupply[gpu];
      const reservedCost = cls.reserved.reduce((s, r) => s + r.gpus * r.rate * HRS_MO * liveFracOf(r, 1), 0);
      rows.push({ gpu, reservedCost, label: GPU_LABEL[gpu] || gpu });
    }
    return rows.filter(r => r.reservedCost > 0).sort((a, b) => b.reservedCost - a.reservedCost);
  }, [byClassSupply]);
  
  const maxCostClass = Math.max(...costByClass.map(c => c.reservedCost), 1);
  

  const M = proj.months;
  const last = M[M.length - 1];
  const cumRev = M.reduce((s, x) => s + x.revenue, 0);
  const cumTok = M.reduce((s, x) => s + x.tokens, 0);
  const firstShort = M.find(x => x.shortfall > 1);
  const maxH = Math.max(...M.map(x => Math.max(x.dem, x.supTotal)), 1);
  const maxFin = Math.max(...M.map(x => Math.max(x.revenue, x.cogs)), 1);

  return (
    <div style={{ minHeight: "100vh", background: "#0b1118", color: "#e2e8f0", fontFamily: F, padding: "18px 20px 40px" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Projections <span style={{ color: "#fbbf24" }}>&mdash; compute outlook &amp; financials</span></div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
            Compute Projections: 12&ndash;24mo demand vs. supply. Demand feeds live from the customer-segment build on the Compute Demand tab; supply policy comes from the Compute Supply tab. Financials: projected revenue, COGS, margin, and free cash flow derived from the same build.
          </div>
        </div>

        <SectionHeader title="Compute Projections" right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)", fontFamily: F, letterSpacing: "0.06em", textTransform: "uppercase" }}>Scenario</span>
            <div style={{ display: "flex", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, overflow: "hidden" }}>
              {Object.entries(DEMAND_SCENARIO_DEFS).map(([k, d]) => (
                <button key={k} onClick={() => switchScenario(k)} title={`switch the whole dashboard to the ${d.label.toLowerCase()} demand scenario — edits assumptions on the Compute Demand tab and flows through here`} style={{
                  background: scenario === k ? d.color + "26" : "transparent",
                  color: scenario === k ? d.color : "rgba(255,255,255,0.4)",
                  border: "none", borderLeft: k !== "weak" ? "1px solid rgba(255,255,255,0.1)" : "none",
                  fontFamily: F, fontSize: 9.5, fontWeight: scenario === k ? 700 : 500,
                  letterSpacing: "0.06em", textTransform: "uppercase",
                  padding: "4px 14px", cursor: "pointer",
                }}>{d.label}</button>
              ))}
            </div>
          </div>
        } />

            <div style={{ maxWidth: 420, marginBottom: 12 }}>
              <Slider label="Horizon" value={horizon} onChange={setHorizon} min={12} max={24} fmtFn={v => v + "mo"} />
            </div>

            {/* Capacity chart */}
            <Section title="Compute: demand vs. supply by pool (H100e) — training vs. inference capacity" style={{ marginBottom: 12 }}>
              <svg viewBox="0 0 880 240" style={{ width: "100%", height: "auto" }}>
                {(() => {
                  const W = 880, H = 240, P = { t: 16, r: 10, b: 28, l: 52 };
                  const pw = W - P.l - P.r, ph = H - P.t - P.b;
                  const n = M.length, gap = pw / n, bw = gap * 0.66;
                  const y = v => P.t + ph - (v / maxH) * ph;
                  const base = P.t + ph;
                  const trainPts = M.map((x, i) => `${P.l + gap * i + gap / 2},${y(x.demTrain)}`).join(" ");
                  const demPts = M.map((x, i) => `${P.l + gap * i + gap / 2},${y(x.dem)}`).join(" ");
                  // Stack: compute pool (violet), balanced (grey), inference pool (cyan)
                  const layers = [["capCompute", "#c4b5fd"], ["capBal", "#94a3b8"], ["capInf", "#67e8f9"]];
                  return <>
                    {[0, maxH / 2, maxH].map((v, i) => <g key={i}>
                      <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
                      <text x={P.l - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.4)" fontFamily={F}>{fmtBig(Math.round(v))}</text>
                    </g>)}
                    {M.map((x, i) => {
                      const xl = P.l + gap * i + (gap - bw) / 2;
                      let acc = 0;
                      const names = { capCompute: "compute pool", capBal: "balanced", capInf: "inference pool" };
                      return <g key={x.label}>
                        {layers.map(([k, col]) => {
                          const v = x[k]; if (v <= 0) return null;
                          const yTop = y(acc + v), h = y(acc) - yTop; acc += v;
                          return <rect key={k} x={xl} y={yTop} width={bw} height={Math.max(h, 0.5)} fill={col} opacity={0.55} rx={1}><title>{`${x.label} ${names[k]}: ${fmtBig(Math.round(v))} H100e`}</title></rect>;
                        })}
                        {x.shortfall > 1 && <rect x={xl} y={y(x.dem)} width={bw} height={Math.max(y(x.supTotal) - y(x.dem), 1)} fill="#f87171" opacity={0.35} rx={1}><title>{`${x.label} shortfall: ${fmtBig(Math.round(x.shortfall))} H100e (train ${fmtBig(Math.round(x.shortTrain))} / inf ${fmtBig(Math.round(x.shortInf))})`}</title></rect>}
                        {(i % 2 === 0) && <text x={xl + bw / 2} y={base + 16} textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.4)" fontFamily={F}>{x.label}</text>}
                      </g>;
                    })}
                    <polyline points={demPts} fill="none" stroke={RO} strokeWidth={2} />
                    <polyline points={trainPts} fill="none" stroke="#c4b5fd" strokeWidth={1.5} strokeDasharray="3 3" opacity={0.8} />
                    <text x={P.l + 4} y={y(M[0].dem) - 7} fontSize={11} fill={RO} fontFamily={F} fontWeight={600}>total demand</text>
                    <text x={P.l + 4} y={y(M[0].demTrain) + 14} fontSize={10} fill="#c4b5fd" fontFamily={F}>training demand</text>
                    {[["compute pool", "#c4b5fd"], ["balanced", "#94a3b8"], ["inference pool", "#67e8f9"], ["shortfall", "#f87171"]].map(([l, c], i) => (
                      <g key={l}><rect x={P.l + 150 + i * 108} y={P.t} width={10} height={10} fill={c} opacity={0.6} /><text x={P.l + 164 + i * 108} y={P.t + 9} fontSize={10} fill="rgba(255,255,255,0.5)" fontFamily={F}>{l}</text></g>
                    ))}
                  </>;
                })()}
              </svg>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4, lineHeight: 1.5 }}>
                Supply is now split by chip lean: <span style={{ color: "#c4b5fd" }}>compute pool</span> (dense-FLOP chips → training), <span style={{ color: "#67e8f9" }}>inference pool</span> (high-bandwidth chips → decode), and a <span style={{ color: "#94a3b8" }}>balanced</span> reservoir usable by either. Solid line = total demand, dashed = training demand (the gap to total is inference). A pool can cover the other's overflow but only at {Math.round((1 - CROSS_EFF) * 100)}% capacity loss, so a red shortfall can appear even when total H100e looks sufficient — the wrong chips for the workload.
              </div>
            </Section>


            {/* Utilization & token output */}
            <Section title="Utilization & token output" style={{ marginBottom: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <svg viewBox="0 0 430 190" style={{ width: "100%", height: "auto" }}>
                  {(() => {
                    const W = 430, H = 190, P = { t: 16, r: 8, b: 26, l: 44 };
                    const pw = W - P.l - P.r, ph = H - P.t - P.b;
                    const n = M.length, gap = pw / n;
                    const uMax = Math.max(1.1, ...M.map(x => x.util)) * 1.05;
                    const y = v => P.t + ph - (v / uMax) * ph;
                    const pts = M.map((x, i) => `${P.l + gap * i + gap / 2},${y(x.util)}`).join(" ");
                    return <>
                      {[0, 0.5, 1].map((v, i) => <g key={i}>
                        <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
                        <text x={P.l - 5} y={y(v) + 4} textAnchor="end" fontSize={10} fill="rgba(255,255,255,0.4)" fontFamily={F}>{fmtPct(v)}</text>
                      </g>)}
                      <line x1={P.l} x2={W - P.r} y1={y(1)} y2={y(1)} stroke="#f87171" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
                      {M.map((x, i) => (i % 3 === 0) && <text key={i} x={P.l + gap * i + gap / 2} y={P.t + ph + 14} textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.4)" fontFamily={F}>{x.label}</text>)}
                      <polyline points={pts} fill="none" stroke="#67e8f9" strokeWidth={2} />
                      {M.map((x, i) => x.util > 1 && <circle key={i} cx={P.l + gap * i + gap / 2} cy={y(x.util)} r={2.5} fill="#f87171" />)}
                      <text x={P.l + 4} y={P.t + 10} fontSize={10} fill="#67e8f9" fontFamily={F} fontWeight={600}>utilization %</text>
                    </>;
                  })()}
                </svg>
                <svg viewBox="0 0 430 190" style={{ width: "100%", height: "auto" }}>
                  {(() => {
                    const W = 430, H = 190, P = { t: 16, r: 8, b: 26, l: 44 };
                    const pw = W - P.l - P.r, ph = H - P.t - P.b;
                    const n = M.length, gap = pw / n, bw = gap * 0.62;
                    const tMax = Math.max(...M.map(x => x.tokens), 1) * 1.05;
                    const y = v => P.t + ph - (v / tMax) * ph;
                    return <>
                      {[0, tMax / 2, tMax].map((v, i) => <g key={i}>
                        <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
                        <text x={P.l - 5} y={y(v) + 4} textAnchor="end" fontSize={10} fill="rgba(255,255,255,0.4)" fontFamily={F}>{fmtBig(v)}</text>
                      </g>)}
                      {M.map((x, i) => (
                        <rect key={i} x={P.l + gap * i + (gap - bw) / 2} y={y(x.tokens)} width={bw} height={Math.max(P.t + ph - y(x.tokens), 0.5)} fill={RO} opacity={0.55} rx={1}>
                          <title>{`${x.label}: ${fmtBig(x.tokens)} tokens`}</title>
                        </rect>
                      ))}
                      {M.map((x, i) => (i % 3 === 0) && <text key={"l" + i} x={P.l + gap * i + gap / 2} y={P.t + ph + 14} textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.4)" fontFamily={F}>{x.label}</text>)}
                      <text x={P.l + 4} y={P.t + 10} fontSize={10} fill={RO} fontFamily={F} fontWeight={600}>tokens / month</text>
                    </>;
                  })()}
                </svg>
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4, lineHeight: 1.5 }}>
                Left: fleet utilization vs. 100% (red dashed; red dots = over capacity). Right: monthly token output at {tokPerHr}M tokens per H100e-hour.
              </div>
            </Section>

        <SectionHeader title="Financials" />

            <div style={{ maxWidth: 420, marginBottom: 12 }}>
              <Slider label="Opex (S&M + G&A, % of revenue)" value={opexPct} onChange={setOpexPct} min={0} max={50} step={1} fmtFn={v => v + "%"} hint="used for the free-cash-flow chart below" />
            </div>

            {/* P&L — grouped bars */}
            <Section title="Projected revenue, COGS" style={{ marginBottom: 12 }}>
              <svg viewBox="0 0 880 220" style={{ width: "100%", height: "auto" }}>
                {(() => {
                  const W = 880, H = 220, P = { t: 16, r: 10, b: 28, l: 52 };
                  const pw = W - P.l - P.r, ph = H - P.t - P.b;
                  const n = M.length, gap = pw / n, bw = gap * 0.32;
                  const y = v => P.t + ph - (Math.max(v, 0) / maxFin) * ph;
                  return <>
                    {[0, maxFin / 2, maxFin].map((v, i) => <g key={i}>
                      <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
                      <text x={P.l - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.4)" fontFamily={F}>{fmtUSD(Math.round(v))}</text>
                    </g>)}
                    {M.map((x, i) => {
                      const x0 = P.l + gap * i + (gap - 2 * bw - 2) / 2;
                      return <g key={x.label}>
                        {x.gm < 0 && <rect x={P.l + gap * i + 1} y={P.t} width={gap - 2} height={ph} fill="#f87171" opacity={0.06} />}
                        <rect x={x0} y={y(x.revenue)} width={bw} height={Math.max(P.t + ph - y(x.revenue), 0.5)} fill="#6ee7b7" opacity={0.65} rx={1}>
                          <title>{`${x.label} revenue: ${fmtUSD(Math.round(x.revenue))}`}</title>
                        </rect>
                        <rect x={x0 + bw + 2} y={y(x.cogs)} width={bw} height={Math.max(P.t + ph - y(x.cogs), 0.5)} fill="#fbbf24" opacity={0.65} rx={1}>
                          <title>{`${x.label} COGS: ${fmtUSD(Math.round(x.cogs))} · GM ${sgn(x.gm)}`}</title>
                        </rect>
                        {(i % 2 === 0) && <text x={P.l + gap * i + gap / 2} y={P.t + ph + 16} textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.4)" fontFamily={F}>{x.label}</text>}
                      </g>;
                    })}
                    {[["revenue", "#6ee7b7"], ["COGS", "#fbbf24"]].map(([l, c], i) => (
                      <g key={l}><rect x={P.l + 8 + i * 90} y={P.t} width={10} height={10} fill={c} opacity={0.65} /><text x={P.l + 22 + i * 90} y={P.t + 9} fontSize={10} fill="rgba(255,255,255,0.5)" fontFamily={F}>{l}</text></g>
                    ))}
                  </>;
                })()}
              </svg>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4, lineHeight: 1.5 }}>
                Paired bars per month. Loss months tinted red.
              </div>
            </Section>

            {/* Free cash flow */}
            <Section title="Free cash flow" style={{ marginBottom: 12 }}>
              <svg viewBox="0 0 880 220" style={{ width: "100%", height: "auto" }}>
                {(() => {
                  const W = 880, H = 220, P = { t: 16, r: 10, b: 28, l: 52 };
                  const pw = W - P.l - P.r, ph = H - P.t - P.b;
                  const n = M.length, gap = pw / n, bw = gap * 0.6;
                  const fcf = M.map(x => x.gm - x.revenue * opexPct / 100);
                  const lo = Math.min(0, ...fcf) * 1.08, hi = Math.max(1, ...fcf) * 1.08;
                  const y = v => P.t + ph - ((v - lo) / (hi - lo)) * ph;
                  const z = y(0);
                  return <>
                    {[lo, 0, hi].map((v, i) => <g key={i}>
                      <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)"} />
                      <text x={P.l - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.4)" fontFamily={F}>{fmtUSD(Math.round(v))}</text>
                    </g>)}
                    {M.map((x, i) => {
                      const v = fcf[i];
                      const yTop = v >= 0 ? y(v) : z;
                      const h = Math.abs(y(v) - z);
                      return <g key={x.label}>
                        <rect x={P.l + gap * i + (gap - bw) / 2} y={yTop} width={bw} height={Math.max(h, 0.5)} fill={v >= 0 ? "#6ee7b7" : "#f87171"} opacity={0.6} rx={1}>
                          <title>{`${x.label} FCF: ${sgn(v)}`}</title>
                        </rect>
                        {(i % 2 === 0) && <text x={P.l + gap * i + gap / 2} y={P.t + ph + 16} textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.4)" fontFamily={F}>{x.label}</text>}
                      </g>;
                    })}
                  </>;
                })()}
              </svg>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4, lineHeight: 1.5 }}>
                FCF = gross margin &minus; opex ({opexPct}% of revenue). Green = cash-generating months, red = burn. Simplified: excludes prepay timing and working-capital swings.
              </div>
            </Section>

            {/* Segment P&L — revenue / cost / margin by workload, customer type, region */}
            <Section title={`Revenue, cost & margin by segment — cumulative over ${horizon}mo`} style={{ marginBottom: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
                {[["By workload", segPnl.workload], ["By customer type", segPnl.customer], ["By region", segPnl.region]].map(([title, rows]) => (
                  <div key={title}>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{title}</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                      <thead><tr>
                        <th style={{ padding: "4px 6px", textAlign: "left", color: "rgba(255,255,255,0.3)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>SEGMENT</th>
                        <th style={{ padding: "4px 6px", textAlign: "right", color: "rgba(255,255,255,0.3)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>REVENUE</th>
                        <th style={{ padding: "4px 6px", textAlign: "right", color: "rgba(255,255,255,0.3)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>COST</th>
                        <th style={{ padding: "4px 6px", textAlign: "right", color: "rgba(255,255,255,0.3)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>MARGIN</th>
                        <th style={{ padding: "4px 6px", textAlign: "right", color: "rgba(255,255,255,0.3)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>%</th>
                      </tr></thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.k}>
                            <td style={{ padding: "4px 6px", color: "#e2e8f0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>{r.k}</td>
                            <td style={{ padding: "4px 6px", textAlign: "right", color: "#6ee7b7", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>{fmtUSD(r.rev)}</td>
                            <td style={{ padding: "4px 6px", textAlign: "right", color: "#fbbf24", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>{fmtUSD(r.cost)}</td>
                            <td style={{ padding: "4px 6px", textAlign: "right", color: r.gm >= 0 ? "#e2e8f0" : "#f87171", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.03)" }}>{fmtUSD(r.gm)}</td>
                            <td style={{ padding: "4px 6px", textAlign: "right", color: r.gm >= 0 ? "#6ee7b7" : "#f87171", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>{fmtPct(r.pct)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 8, lineHeight: 1.5 }}>
                Revenue = each group's served H100e-hours &times; its workload's sell rate (training {fmtUSD(pricing.trainPrice, 2)} / inference {fmtUSD(pricing.infPrice, 2)} per H100e-hr from the Compute Demand tab, declining per the Supply-tab policy). Cost is allocated pro-rata on served hours, so each table sums to the same headline gross margin. Customer-type and region tables slice the identical cohort demand two ways.
              </div>
            </Section>

            {/* Cost breakdown */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Section title="Reserved cost by GPU class (this month, delivered)">
                {costByClass.length === 0 ? <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>No reserved positions.</div> :
                  costByClass.map(c => <BarRow key={c.gpu} label={c.label} value={c.reservedCost} max={maxCostClass} color="#fbbf24" />)}
              </Section>
            </div>

        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.18)", marginTop: 16, fontFamily: F, lineHeight: 1.5 }}>
          Model notes: inference and training demand feed live from the customer-segment build on the Compute Demand tab (edit it there to change this projection); renewals have finite terms with compounding attrition and market re-pricing; the next-gen step applies only to commitments signed after the transition month (existing contracts keep their locked rates). No auto-buy — supply is existing reserved capacity, renewals, and on-demand/spot overflow only, so a shortfall shows up as unserved demand rather than being auto-sourced. Still single-pool H100e (no per-class engine), one market anchor, no financing/prepay carry (Compute Supply's evaluator owns that), and no counterparty limits.
        </div>
      </div>
    </div>
  );
}

return App;
})();

const TAB_F = "'IBM Plex Mono', 'JetBrains Mono', monospace";

function InstructionsApp() {
  const F = TAB_F;
  const CYAN = "#67e8f9";
  const GRW = "#86efac";
  const AMB = "#fbbf24";
  const VIO = "#c4b5fd";
  const RO  = "#f87171";
  const MUT = "rgba(255,255,255,0.55)";

  // Ordered pipeline: each node is one analytical step. `tabs` names the
  // dashboard tab(s) that answer it. `question` is the plain-English decision
  // the step tackles; `answer` is a one-liner on how the tab addresses it.
  const steps = [
    {
      n: "01",
      title: "Forecast Compute Demand",
      tabs: ["Compute Demand"],
      color: GRW,
      question: "How much compute will we need — and when, where, for what?",
      answer: "Bottom-up 24-month build over customer cohorts, regions, and training/inference workloads. Weak/base/strong scenarios flex new-logo growth, up-sell, and churn; price elasticity feeds back into demanded volume.",
    },
    {
      n: "02",
      title: "Inventory Existing Supply",
      tabs: ["Compute Supply"],
      color: CYAN,
      question: "What compute do we already own or have on contract?",
      answer: "Live supply book with coverage cuts by region, provider, GPU type, contract structure, model-serving ability, and workload type. Establishes the baseline the demand forecast is compared against.",
    },
    {
      n: "03",
      title: "Identify Supply Gaps",
      tabs: ["Compute Supply", "→ Supply Filling Engine"],
      color: CYAN,
      question: "Where does supply fall short of demand — and by how much?",
      answer: "Supply Filling Engine diffs projected demand against the existing book across chip / fabric / region / customer / workload, then surfaces the shortfall (and any idle capacity that could be re-cascaded to cover it).",
    },
    {
      n: "04",
      title: "Vet Vendors & Price Hardware",
      tabs: ["Vendor Spec & Contracts"],
      color: AMB,
      question: "Who do we buy from, and what is a fair price for each GPU spec?",
      answer: "Cross-check vendor catalogs (GPU type, fabric, config, price), fit a sign-constrained ridge regression for a \"fair\" price benchmark, and score prospective vendors against an 8-part diligence framework that highlights key negotiating points for the contract-signing process. A reference guide covers GPU hardware specs, scale-up/scale-out topologies (e.g., rail-alignment, fat-trees), parallelism strategies, and data center operator rankings.",
    },
    {
      n: "05",
      title: "Read the Market Context",
      tabs: ["Supply Chain Bottlenecks"],
      color: RO,
      question: "How long will aggregate compute supply stay constrained — buy now, or wait?",
      answer: "Zooms out from our book to the full semiconductor stack (wafers → packaging → HBM → GPUs → systems → DC), tracking ~200 companies critical to the supply chain and marking the pacing chokepoints. Structural bottlenecks → lock in now; loosening → wait before signing take-or-pay.",
    },
    {
      n: "06",
      title: "Time the Generation Switch",
      tabs: ["Future Supply"],
      color: VIO,
      question: "Buy long-term on current-gen now, or bridge short-term until next-gen chips land?",
      answer: "Prices every \"bridge n years on current-gen, then switch\" strategy under a two-regime price path and maturity-ramped speedup. Inverts to the break-even next-gen unit cost that would justify each bridge length, expressed in prices you can quote today.",
    },
    {
      n: "07",
      title: "Optimize the Purchase Plan",
      tabs: ["Compute Supply", "→ Supply Filling Engine"],
      color: CYAN,
      question: "Which GPUs, how many, from which vendors, at what term — under what risk limits?",
      answer: "Supply Filling Engine sizes each bucket's committable capacity via the classical newsvendor model, then selects deals through a three-stage stochastic optimization with real-options structure subject to portfolio guardrails (e.g., vendor concentration, cash-prepay caps, DC-tier limits, total-spend cap). Emits a ranked buy list with quantity, vendor, term, and timing.",
    },
  ];

  const Arrow = () => (
    <div style={{ display: "flex", justifyContent: "center", padding: "6px 0" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.18)" }} />
        <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 14, lineHeight: 1, marginTop: -2 }}>▼</div>
      </div>
    </div>
  );

  return (
    <div style={{ background: "#0b1118", color: "#e2e8f0", minHeight: "calc(100vh - 60px)", padding: "28px 32px", fontFamily: F }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", color: "#e2e8f0" }}>Instructions</div>
          <div style={{ fontSize: 11, color: CYAN, letterSpacing: "0.08em" }}>— procurement workflow</div>
        </div>
        <div style={{ height: 1, background: "rgba(255,255,255,0.07)", marginBottom: 18 }} />

        <div style={{ fontSize: 13, lineHeight: 1.65, color: "#cbd5e1", marginBottom: 22 }}>
          The dashboard tabs are laid out to follow one end-to-end question: <span style={{ color: "#e2e8f0", fontWeight: 600 }}>how much compute should we buy, of what kind, from whom, and when?</span> Each step below is one link in that chain — the flow feeds forward into the next.
        </div>

        {/* ── Flow diagram ─────────────────────────────────────────────────── */}
        {steps.map((s, i) => (
          <React.Fragment key={s.n}>
            <div style={{
              border: `1px solid ${s.color}55`,
              borderLeft: `3px solid ${s.color}`,
              borderRadius: 6,
              padding: "14px 18px",
              background: "rgba(255,255,255,0.06)",
              display: "grid",
              gridTemplateColumns: "48px 1fr",
              gap: 14,
              alignItems: "start",
            }}>
              <div style={{
                fontSize: 22, fontWeight: 700, color: s.color, letterSpacing: "-0.03em",
                lineHeight: 1, paddingTop: 2, fontFamily: F,
              }}>{s.n}</div>
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", letterSpacing: "-0.01em" }}>{s.title}</div>
                  <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    tab: {s.tabs.map((t, k) => (
                      <span key={k} style={{ color: s.color, marginLeft: k === 0 ? 4 : 4 }}>{t}</span>
                    ))}
                  </div>
                </div>
                <div style={{
                  fontSize: 12, fontStyle: "italic", color: s.color,
                  marginBottom: 6, lineHeight: 1.5,
                }}>“{s.question}”</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: "#cbd5e1" }}>{s.answer}</div>
              </div>
            </div>
            {i < steps.length - 1 && <Arrow />}
          </React.Fragment>
        ))}

        {/* ── Terminal node: Projections is the summary read-out ──────────── */}
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 6px" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.18)" }} />
            <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.1em", marginTop: 2 }}>ROLLS UP INTO</div>
            <div style={{ width: 1, height: 6, background: "rgba(255,255,255,0.18)" }} />
            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 14, lineHeight: 1 }}>▼</div>
          </div>
        </div>
        <div style={{
          border: `1px dashed ${RO}88`,
          borderRadius: 6,
          padding: "14px 18px",
          background: "rgba(248,113,113,0.08)",
          display: "grid",
          gridTemplateColumns: "48px 1fr",
          gap: 14,
          alignItems: "start",
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: RO, letterSpacing: "-0.03em", lineHeight: 1, paddingTop: 2, fontFamily: F }}>Σ</div>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", letterSpacing: "-0.01em" }}>Projections</div>
              <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.08em", textTransform: "uppercase" }}>tab: <span style={{ color: RO, marginLeft: 4 }}>Projections</span></div>
            </div>
            <div style={{ fontSize: 12, fontStyle: "italic", color: RO, marginBottom: 6, lineHeight: 1.5 }}>“What does the whole plan look like in dollars?”</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "#cbd5e1" }}>
              Summary read-out of the demand and supply engines over the 24-month horizon: matched supply/demand, revenues, COGS, free cash flow, and segment economics under weak/base/strong scenarios.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// TEMPORAL — old-gen vs. new-gen upgrade timing analyzer.
//   Models the "bridge N years on current hardware, then switch to next-gen"
//   decision explicitly, with interactive inputs for the two-regime price path
//   (scarcity inflation → normalization decay), maturity-ramped speedup, and
//   discount rate. Computes PV of every valid bridge length and the break-even
//   next-gen effective price Λ*(n) that would tie each bridge with never-switch.
//   Derivation section walks through the 12-step build of the model from first
//   physical primitives to the practical inverted form.
//
//   Wired live to the SUPPLY_STORE / DEMAND_STORE: the current-gen dropdown
//   auto-populates P_c(N) from the weighted-average reserved rate on that GPU
//   in the supply book, and the training/decode workload split defaults to the
//   ratio observed in the demand book. σ is now decomposed into σ_train (FLOPs
//   ratio, precision-matched) and σ_decode (HBM bandwidth ratio) — the two
//   physical regimes matter separately, and the effective σ is a workload-mix-
//   weighted blend of them.
// ═════════════════════════════════════════════════════════════════════════════
// Hardware catalog for the Temporal tab. Mirrors the SUPPLY_GPUS map inside
// SupplySideApp (unreachable from this scope) and extends it with (a) native
// precision multipliers for FP8/FP4 tensor throughput, so σ can be computed at
// the precision the user actually runs, and (b) a forward-looking set of
// announced-but-not-yet-released chips with (partly speculative) specs and
// vendor-guided launch windows. Edit the future entries as roadmaps firm up.
//   tflops    — FP16 dense tensor TFLOPS per chip (matches SUPPLY_GPUS basis)
//   fp8x/fp4x — throughput multiplier vs FP16 dense when the precision is
//               natively supported; 0 means the chip has no native tensor path
//               at that precision (falls back to a lower precision in the calc)
//   bw        — HBM aggregate bandwidth, TB/s per chip
//   released  — true for chips already contractable in the supply book
//   tLaunch   — years from "now" (dashboard clock) until first contract avail.
//   pLaunch   — indicative $/GPU-hr contract rate at launch
// The `market` field holds current-market rates for NEW reserved contracts —
// i.e. what you would sign today, mirroring the SUPPLY_GPUS.market values in
// SupplySideApp. This is the right seed for P_c because the temporal decision
// is about new signings; existing supply-book positions are locked and cannot
// be exited. The historical book rate stays available as reference context.
const HARDWARE_CATALOG = {
  // ── Released (mirrors SUPPLY_GPUS with precision flags + new-sign market) ─
  A100_80:     { label: "A100 80GB",         vendor: "Nvidia", tflops: 312,  vram: 80,   bw: 2.0,  fp8x: 0, fp4x: 0, market: 1.10, released: true },
  H100:        { label: "H100 80GB",         vendor: "Nvidia", tflops: 989,  vram: 80,   bw: 3.35, fp8x: 2, fp4x: 0, market: 1.85, released: true },
  H200:        { label: "H200 141GB",        vendor: "Nvidia", tflops: 989,  vram: 141,  bw: 4.8,  fp8x: 2, fp4x: 0, market: 2.30, released: true },
  L40S:        { label: "L40S 48GB",         vendor: "Nvidia", tflops: 181,  vram: 48,   bw: 0.86, fp8x: 2, fp4x: 0, market: 0.75, released: true },
  B200:        { label: "B200 192GB",        vendor: "Nvidia", tflops: 2250, vram: 192,  bw: 8.0,  fp8x: 2, fp4x: 4, market: 3.60, released: true },
  B300:        { label: "B300 288GB",        vendor: "Nvidia", tflops: 2900, vram: 288,  bw: 8.0,  fp8x: 2, fp4x: 4, market: 5.00, released: true },
  // ── Unreleased (announced roadmap; specs partly speculative) ─────────────
  GB300_ULTRA: { label: "GB300 NVL72 Ultra", vendor: "Nvidia", tflops: 3500, vram: 288,  bw: 8.4,  fp8x: 2, fp4x: 4, market: 5.50, released: false, tLaunch: 0.25, pLaunch: 5.50, note: "Blackwell Ultra rack-scale refresh; early shipping, broader availability H2 2026" },
  RUBIN_R100:  { label: "Vera Rubin R100",   vendor: "Nvidia", tflops: 3600, vram: 288,  bw: 13.0, fp8x: 2, fp4x: 4, market: 6.00, released: false, tLaunch: 1.0,  pLaunch: 6.00, note: "Announced GTC 2025; first HBM4 volume chip; H2 2027 volume" },
  RUBIN_ULTRA: { label: "Rubin Ultra",       vendor: "Nvidia", tflops: 5400, vram: 1024, bw: 20.0, fp8x: 2, fp4x: 4, market: 8.50, released: false, tLaunch: 2.0,  pLaunch: 8.50, note: "2028+ roadmap; multi-die Rubin; specs and pricing highly speculative" },
  MI400:       { label: "AMD MI400",         vendor: "AMD",    tflops: 3200, vram: 432,  bw: 15.0, fp8x: 2, fp4x: 4, market: 4.80, released: false, tLaunch: 1.25, pLaunch: 4.80, note: "Announced roadmap; ROCm software maturity is the wildcard on realized σ" },
};

// Effective FP16-equivalent TFLOPS at a chosen precision. Falls back down the
// precision ladder when the chip lacks native support (H100 at FP4 → uses FP8).
function effectiveTflops(spec, precision) {
  if (!spec) return 0;
  if (precision === "fp4") {
    if (spec.fp4x > 0) return spec.tflops * spec.fp4x;
    // fall back
    return effectiveTflops(spec, "fp8");
  }
  if (precision === "fp8") {
    if (spec.fp8x > 0) return spec.tflops * spec.fp8x;
    return spec.tflops; // FP16 fallback
  }
  return spec.tflops; // fp16
}

// Highest precision both chips natively support (used to label what σ was
// actually computed at when the user's chosen precision isn't available on one
// side).
function commonPrecision(a, b, want) {
  const supports = (spec, p) => p === "fp16" || (p === "fp8" && spec.fp8x > 0) || (p === "fp4" && spec.fp4x > 0);
  if (supports(a, want) && supports(b, want)) return want;
  if (want === "fp4") {
    if (supports(a, "fp8") && supports(b, "fp8")) return "fp8";
  }
  return "fp16";
}

// Weighted-average reserved rate for a given GPU class in the live supply book.
// Weight = remaining GPU-months (gpus × remMo), which is what the book will
// actually pay for. Falls back to null if no active reserved position exists.
function weightedReservedRate(supply, gpuKey) {
  const rows = supply.filter(r => r.gpu === gpuKey && r.status === "active" && r.structure === "reserved" && r.remMo > 0);
  if (rows.length === 0) return null;
  let num = 0, den = 0;
  for (const r of rows) {
    const w = r.gpus * r.remMo;
    num += w * r.rate;
    den += w;
  }
  return den > 0 ? num / den : null;
}

// Portfolio blend: synthesize a single "current-gen" spec from the entire
// active reserved supply book by GPU-month weighting. Answers the question
// "should we extend the mix we already hold, or switch generations?" rather
// than "should we buy more of one chip class or switch." tflops, bw, vram,
// fp8x, fp4x are all GPU-month-weighted averages; portfolioRate is the
// weighted-average $/hr that P_c should seed to. Returns null when the book
// has no active reserved positions to weight.
function portfolioSpec(supply) {
  const rows = supply.filter(r => r.status === "active" && r.structure === "reserved" && r.remMo > 0);
  if (rows.length === 0) return null;
  let W = 0, tf = 0, bw = 0, vr = 0, rate = 0, mkt = 0, f8 = 0, f4 = 0;
  const chips = new Set();
  for (const r of rows) {
    const spec = HARDWARE_CATALOG[r.gpu];
    if (!spec) continue;
    const w = r.gpus * r.remMo;
    W += w;
    tf += w * spec.tflops;
    bw += w * spec.bw;
    vr += w * spec.vram;
    rate += w * r.rate;                        // book-locked (historical)
    mkt += w * (spec.market || r.rate);        // market rate for NEW signings
    f8 += w * (spec.fp8x || 0);
    f4 += w * (spec.fp4x || 0);
    chips.add(r.gpu);
  }
  if (W === 0) return null;
  return {
    label: `Portfolio blend (${chips.size}-chip mix)`,
    vendor: "mixed",
    tflops: tf / W,
    vram: vr / W,
    bw: bw / W,
    fp8x: f8 / W,
    fp4x: f4 / W,
    market: mkt / W,                           // this is what P_c seeds to
    released: true,
    portfolioRate: rate / W,                   // legacy: book-locked rate (context)
    portfolioMarketRate: mkt / W,
    chips: Array.from(chips),
    totalGpuMonths: W,
  };
}

// Resolve which spec to use for the current-gen selection — either a fixed
// catalog entry or the live-computed portfolio blend when the sentinel key is
// picked.
function resolveCurrentSpec(key, supply) {
  if (key === "PORTFOLIO_AVG") return portfolioSpec(supply);
  return HARDWARE_CATALOG[key];
}

// Slider input — hoisted OUT of TemporalApp so its component identity is
// stable across parent re-renders. Defining components inside a render
// function gives them a fresh identity every render, which forces React to
// unmount + remount them, killing drag focus and (in some browsers) bumping
// the scroll position. Colors/font are passed in as props.
function TemporalInpBox({ label, value, onChange, min, max, step = 1, fmt, hint, color, mut, font }) {
  const fmtFn = fmt || (v => v);
  return (
    <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ fontSize: 10, color: mut, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: font }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: color, height: 3 }} />
        <span style={{ fontSize: 12, color, fontFamily: font, fontWeight: 600, minWidth: 66, textAlign: "right" }}>{fmtFn(value)}</span>
      </div>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.28)", fontFamily: font, marginTop: 3, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

// Training share of demand (GPU-months on kind="training" ÷ total). Used to
// weight σ_train vs σ_decode when the user hasn't overridden the split.
function trainShareFromDemand(demand) {
  let t = 0, i = 0;
  for (const d of demand) {
    if (d.status === "cancelled") continue;
    const gmo = (d.gpus || 0) * (d.durationMo || 0);
    if (d.kind === "training") t += gmo;
    else if (d.kind === "inference") i += gmo;
  }
  const total = t + i;
  return total > 0 ? t / total : 0.5;
}

function TemporalApp() {
  const F = TAB_F;
  const VIO = "#c4b5fd";
  const CYAN = "#67e8f9";
  const GRW = "#86efac";
  const AMB = "#fbbf24";
  const RO = "#f87171";
  const MUT = "rgba(255,255,255,0.35)";
  const MUT2 = "rgba(255,255,255,0.55)";

  // ── Live book context ──────────────────────────────────────────────────────
  const [supply] = useBookStore(SUPPLY_STORE);
  const [demand] = useBookStore(DEMAND_STORE);
  const releasedKeys = React.useMemo(() => Object.keys(HARDWARE_CATALOG).filter(k => HARDWARE_CATALOG[k].released), []);
  const futureKeys = React.useMemo(() => Object.keys(HARDWARE_CATALOG).filter(k => !HARDWARE_CATALOG[k].released), []);

  // ── Inputs ─────────────────────────────────────────────────────────────────
  const [horizon, setHorizon] = React.useState(5);            // N years
  const [discountRate, setDiscountRate] = React.useState(10); // r %

  // GPU pickers — current from released chips (in supply book), next from
  // announced-but-unreleased. Changing a selection resets P_c / t_L / P_L to
  // catalog defaults (see useEffect below); overrides are preserved otherwise.
  const [currentGpu, setCurrentGpu] = React.useState("B200");
  const [nextGenId, setNextGenId] = React.useState("RUBIN_R100");

  // Requested precision — the aspirational ceiling. commonPrecision(cur, nxt)
  // walks down until both chips natively support the level. Kept as a constant
  // because in the current catalog all Blackwell+ chips share fp8x=2/fp4x=4,
  // so σ_train is invariant to the request once both chips clear the same rung
  // — the picker was cosmetic. Auto-fallback is preserved for asymmetric
  // comparisons like A100→Rubin (A100 lacks FP8, so we drop to FP16).
  const precision = "fp4";

  // Training share of workload. "auto" pulls it from the demand book; a number
  // 0–100 overrides. σ_decode gets weight (1 − train share).
  const [trainShareMode, setTrainShareMode] = React.useState("auto");
  const [trainShareOverride, setTrainShareOverride] = React.useState(70);

  // Price / timing inputs — seeded from the catalog when the selection
  // changes, but freely editable afterward.
  const [pCurrent, setPCurrent] = React.useState(2.10);
  const [termDiscount, setTermDiscount] = React.useState(4); // %/yr of contract length
  const [tLaunch, setTLaunch] = React.useState(1);
  const [pLaunch, setPLaunch] = React.useState(6.00);

  const [maturityInit, setMaturityInit] = React.useState(65);
  const [maturityYears, setMaturityYears] = React.useState(2);
  const [inflationRate, setInflationRate] = React.useState(15);
  const [tNorm, setTNorm] = React.useState(2);
  const [decayRate, setDecayRate] = React.useState(25);

  // Optional manual override for σ_∞ (bypasses the FLOPs/BW blend entirely).
  const [sigmaMode, setSigmaMode] = React.useState("derived"); // "derived" | "manual"
  const [sigmaManual, setSigmaManual] = React.useState(2.5);

  // ── Auto-seed P_c / t_L / P_L from catalog when picks change ───────────────
  // P_c seeds to the CURRENT-MARKET new-sign rate, not the book-locked rate.
  // Rationale: the temporal decision is about what to sign new; existing
  // positions in the supply book are contractually locked and can't be exited,
  // so their historical rate is not the marginal decision variable. The book
  // rate is still displayed as reference context in the picker description.
  React.useEffect(() => {
    if (currentGpu === "PORTFOLIO_AVG") {
      const port = portfolioSpec(supply);
      if (port != null) setPCurrent(+port.portfolioMarketRate.toFixed(2));
      return;
    }
    const cur = HARDWARE_CATALOG[currentGpu];
    if (!cur) return;
    setPCurrent(cur.market != null ? +cur.market.toFixed(2) : 2.10);
  }, [currentGpu, supply]);
  React.useEffect(() => {
    const nxt = HARDWARE_CATALOG[nextGenId];
    if (!nxt) return;
    if (nxt.tLaunch != null) setTLaunch(nxt.tLaunch);
    if (nxt.pLaunch != null) setPLaunch(nxt.pLaunch);
  }, [nextGenId]);

  const r = discountRate / 100;
  const g = inflationRate / 100;
  const delta = decayRate / 100;
  // Contract length discount: each additional year of contract length knocks
  // `discount` off the shorter-term rate. Equivalent to "signing a longer
  // contract compounds a `discount` savings per year." P_curr slider represents
  // the fully-discounted N-year rate; shorter terms scale up as they give back
  // years of discount:  P_curr(n) = P_curr(N) / (1 − discount)^(N − n).
  const discount = termDiscount / 100;
  const m0 = maturityInit / 100;

  // ── Speedup decomposition — the physically-grounded σ_∞ ───────────────────
  // σ_train uses FLOPs at the highest precision both chips natively support;
  // σ_decode uses HBM bandwidth (decode is memory-bound). σ_∞ is the workload-
  // mix-weighted blend, with training weight from the demand book (or override).
  const speedupDerivation = React.useMemo(() => {
    const cur = resolveCurrentSpec(currentGpu, supply);
    const nxt = HARDWARE_CATALOG[nextGenId];
    if (!cur || !nxt) return null;
    const effPrec = commonPrecision(cur, nxt, precision);
    const tflopsCur = effectiveTflops(cur, effPrec);
    const tflopsNxt = effectiveTflops(nxt, effPrec);
    const sigmaTrain = tflopsCur > 0 ? tflopsNxt / tflopsCur : 1;
    const sigmaDecode = cur.bw > 0 ? nxt.bw / cur.bw : 1;
    const autoTrainShare = trainShareFromDemand(demand);
    const wTrain = trainShareMode === "auto" ? autoTrainShare : trainShareOverride / 100;
    const sigmaBlend = wTrain * sigmaTrain + (1 - wTrain) * sigmaDecode;
    return { effPrec, tflopsCur, tflopsNxt, sigmaTrain, sigmaDecode, autoTrainShare, wTrain, sigmaBlend, cur, nxt };
  }, [currentGpu, nextGenId, precision, trainShareMode, trainShareOverride, demand, supply]);

  // Final σ_∞ used in the model — derived blend or manual override.
  const speedupInf = sigmaMode === "manual" ? sigmaManual : (speedupDerivation?.sigmaBlend ?? 1);

  // ── Model helpers ──────────────────────────────────────────────────────────
  // Annuity factor: PV of $1 paid at the end of each of n years @ rate r.
  const annuity = (n, rr) => n <= 0 ? 0 : (1 - Math.pow(1 + rr, -n)) / rr;
  // Current-gen rate card: N-yr rate is the deepest discount (P_curr slider);
  // shorter terms scale UP because they give back years of length discount.
  //   P_curr(n) = P_curr(N) / (1 − discount)^(N − n)
  // Clamped so a runaway 100% discount doesn't produce Infinity.
  const pcByTerm = (n) => {
    const yearsShort = Math.max(0, horizon - n);
    const factor = Math.pow(Math.max(1 - discount, 0.01), yearsShort);
    return pCurrent / factor;
  };
  // Two-regime next-gen price. Before launch: undefined. In [t_L, t_norm):
  // inflating at g/yr from P_L. In [t_norm, ∞): decaying at δ/yr from the
  // inflated value at t_norm. If t_norm ≤ t_L, no inflation regime.
  const pNext = (t) => {
    if (t < tLaunch) return null;
    if (tNorm <= tLaunch) return pLaunch * Math.exp(-delta * (t - tLaunch));
    if (t < tNorm) return pLaunch * Math.pow(1 + g, t - tLaunch);
    const pAtNorm = pLaunch * Math.pow(1 + g, tNorm - tLaunch);
    return pAtNorm * Math.exp(-delta * (t - tNorm));
  };
  // Maturity ramp: linear m₀ → 1 over `maturityYears` after launch.
  const maturity = (t) => {
    if (t < tLaunch) return m0;
    const dt = t - tLaunch;
    if (dt >= maturityYears || maturityYears <= 0) return 1;
    return m0 + (1 - m0) * (dt / maturityYears);
  };
  const sigmaOf = (t) => speedupInf * maturity(t);
  const lambdaOf = (t) => {
    const p = pNext(t); if (p === null) return null;
    return p / Math.max(sigmaOf(t), 1e-6);
  };

  // ── Bridge PV table: for each valid n in [ceil(t_L), N], compute
  //   PV(n) = P_c(n) · A(n,r) + P_next(n) · Σ_(y=n+1..N) (1+r)^-y / σ(y)
  // Note the tail integrates σ(y) over each year — the contract price is locked
  // at switch time n, but realized speedup keeps improving with software
  // maturity after switch. Earlier fixed-σ formulation over-penalized early
  // bridges by charging immature-σ prices for the full tail.
  //
  // Λ_avg(n) is the discounted-average effective unit cost applied over the
  // tail: P_next(n) · (Σ (1+r)^-y / σ(y)) / (Σ (1+r)^-y). It equals P_next(n)/σ(n)
  // in the degenerate case where σ is already at maturity by year n+1.
  //
  // Break-even Λ*(n) is unchanged in form — it's the constant tail unit cost
  // that would tie PV(n) with never-switch PV(N):
  //   Λ*(n) = [P_c(N)·A(N) − P_c(n)·A(n)] / [A(N) − A(n)]
  // Now compared against Λ_avg(n) rather than the instantaneous Λ(n).
  const bridges = React.useMemo(() => {
    const results = [];
    const nMin = Math.max(0, Math.ceil(tLaunch));
    const AN = annuity(horizon, r);
    const pcN = pcByTerm(horizon);
    const pvNever = pcN * AN;
    for (let n = nMin; n <= horizon; n++) {
      const pc_n = pcByTerm(n);
      const An = annuity(n, r);
      const tailA = AN - An;
      const pNextAt = n < horizon ? pNext(n) : null;
      const sigmaAt = n < horizon ? sigmaOf(n) : null;
      // Integrate σ(y) over the tail (year-end discounting).
      let tailPV = 0;
      if (pNextAt !== null) {
        for (let y = n + 1; y <= horizon; y++) {
          const sigmaY = sigmaOf(y);
          if (sigmaY > 1e-9) {
            tailPV += (pNextAt / sigmaY) * Math.pow(1 + r, -y);
          }
        }
      }
      const pv = pc_n * An + tailPV;
      // Discounted-average effective unit cost applied to the tail.
      const lamAvg = n < horizon && tailA > 1e-9 ? tailPV / tailA : null;
      // Instantaneous Λ at switch time — kept for reference.
      const lamAtSwitch = n < horizon ? (lambdaOf(n) ?? 0) : 0;
      const lamStar = n < horizon && tailA > 1e-9 ? (pvNever - pc_n * An) / tailA : null;
      results.push({ n, pc_n, An, tailA, lam: lamAvg ?? 0, lamAtSwitch, pv, lamStar, pNextAt, sigmaAt, pvNever });
    }
    return results;
  }, [horizon, r, pCurrent, discount, tLaunch, pLaunch, g, tNorm, delta, speedupInf, m0, maturityYears]);

  const best = React.useMemo(
    () => bridges.length ? bridges.reduce((a, b) => a.pv < b.pv ? a : b) : null,
    [bridges]
  );
  const neverSwitch = bridges.length ? bridges[bridges.length - 1] : null;
  const switchAsap = bridges.length ? bridges[0] : null;

  // Time series for curve charts.
  const curve = React.useMemo(() => {
    const arr = [];
    const step = 0.1;
    for (let t = 0; t <= horizon + 1e-6; t += step) {
      arr.push({ t: +t.toFixed(2), price: pNext(t), sigma: sigmaOf(t), lam: lambdaOf(t) });
    }
    return arr;
  }, [horizon, tLaunch, pLaunch, g, tNorm, delta, speedupInf, m0, maturityYears]);

  // Steady-state break-even speedup at chosen n (Step 10 rule):
  //   σ > P_next(n) / P_c(n)  ⇔  next-gen wins per unit work
  const sigmaStar = best && best.pNextAt !== null ? best.pNextAt / best.pc_n : null;
  const sigmaAtBest = best && best.sigmaAt !== null ? best.sigmaAt : null;

  // Marginal rule (Step 11): benefit of waiting one more year at the current n=best.
  // If PV(best+1) < PV(best), wait. If PV(best-1) < PV(best), you already waited too long.
  const pvAt = (n) => { const b = bridges.find(x => x.n === n); return b ? b.pv : null; };
  const marginal = best ? {
    dNextYr: pvAt(best.n + 1) !== null ? pvAt(best.n + 1) - best.pv : null,
    dPrevYr: pvAt(best.n - 1) !== null ? pvAt(best.n - 1) - best.pv : null,
  } : { dNextYr: null, dPrevYr: null };

  // ── Formatters & mini UI primitives (self-contained; top-level file scope) ──
  const fmt$ = (v, d = 2) => v == null || !isFinite(v) ? "—" : (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(d);
  const fmtx = (v, d = 2) => v == null || !isFinite(v) ? "—" : v.toFixed(d) + "×";
  const fmtY = (v, d = 1) => v == null || !isFinite(v) ? "—" : v.toFixed(d) + " yr";
  const fmtPc = (v, d = 0) => v == null || !isFinite(v) ? "—" : v.toFixed(d) + "%";
  const fmtBigNum = (v) => v == null || !isFinite(v) ? "—" : v >= 1000 ? (v / 1000).toFixed(1) + "K TF" : v.toFixed(0) + " TF";

  // All UI helper components wrapped with useMemo so their identities are
  // stable across TemporalApp re-renders. Without this, every state change
  // (slider drag, select change) gives Sec / Row / Kpi / H new function
  // references → React treats them as new component types → unmounts and
  // remounts the entire subtree → focus lost + browser scroll adjusts to
  // maintain focused element in view = the "scroll jump" behavior. Color/font
  // closures capture const strings that never change, so [] deps are correct.
  /* eslint-disable react-hooks/exhaustive-deps */
  const Row = React.useMemo(() => ({ children }) => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 12 }}>{children}</div>
  ), []);
  const InpBox = React.useMemo(() => (p) => <TemporalInpBox {...p} color={VIO} mut={MUT} font={F} />, []);
  const Kpi = React.useMemo(() => ({ label, value, sub, accent }) => (
    <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 8, padding: "12px 14px", minWidth: 150 }}>
      <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 3, fontFamily: F }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent || "#e2e8f0", fontFamily: F, letterSpacing: "-0.02em", lineHeight: 1.15 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3, fontFamily: F, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  ), []);
  const Sec = React.useMemo(() => ({ title, children, style }) => (
    <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: "14px 16px", border: "1px solid rgba(255,255,255,0.1)", marginBottom: 14, ...style }}>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: F, fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  ), []);
  const H = React.useMemo(() => ({ title }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 12px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#e2e8f0", fontFamily: F, textTransform: "uppercase" }}>{title}</div>
      <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
    </div>
  ), []);
  /* eslint-enable react-hooks/exhaustive-deps */
  // KaTeX loader (via CDN, no npm dependency) — resolves after mount in the
  // browser so <Eq> can render proper display-mode math. During SSR / the verify
  // harness, katex stays null and <Eq> falls back to plain text.
  const [katexRef, setKatexRef] = React.useState(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.katex) { setKatexRef(window.katex); return; }
    if (!document.getElementById("katex-css")) {
      const link = document.createElement("link");
      link.id = "katex-css";
      link.rel = "stylesheet";
      link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
      document.head.appendChild(link);
    }
    let existing = document.getElementById("katex-js");
    if (!existing) {
      const script = document.createElement("script");
      script.id = "katex-js";
      script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
      script.onload = () => setKatexRef(window.katex);
      document.head.appendChild(script);
    } else {
      const iv = setInterval(() => { if (window.katex) { setKatexRef(window.katex); clearInterval(iv); } }, 80);
      return () => clearInterval(iv);
    }
  }, []);
  // Per-instance KaTeX render cache — repeat renders of the same LaTeX string
  // reuse the compiled HTML instead of re-parsing every time. Renderings are
  // memoized by (tex, katex-loaded) so a slider drag doesn't pay for the
  // equation stack on every intermediate value.
  const katexCache = React.useRef(new Map());
  // Memoized on katexRef so Eq's identity only changes when katex loads (once),
  // not on every parent re-render — preserving derivation body focus/scroll.
  const Eq = React.useMemo(() => ({ children }) => {
    const boxStyle = { background: "rgba(0,0,0,0.35)", border: "1px solid rgba(196,181,253,0.18)", borderRadius: 6, padding: "10px 14px", margin: "8px 0", color: "#e2e8f0", overflowX: "auto" };
    const tex = String(children);
    if (!katexRef) {
      return <div style={{ ...boxStyle, fontSize: 12, fontFamily: F, lineHeight: 1.7 }}>{tex}</div>;
    }
    if (!katexCache.current.has(tex)) {
      try { katexCache.current.set(tex, katexRef.renderToString(tex, { throwOnError: false, displayMode: true, output: "html" })); }
      catch (e) { katexCache.current.set(tex, tex); }
    }
    return <div style={{ ...boxStyle, fontSize: 15 }} dangerouslySetInnerHTML={{ __html: katexCache.current.get(tex) }} />;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [katexRef]);

  // ── Charts ──────────────────────────────────────────────────────────────────
  // PV by bridge length — bar chart. Best bridge highlighted in violet.
  const pvChart = (() => {
    const W = 880, Hc = 240, P = { t: 20, r: 16, b: 40, l: 60 };
    const pw = W - P.l - P.r, ph = Hc - P.t - P.b;
    const n = bridges.length;
    if (n === 0) return null;
    const gap = pw / n, bw = gap * 0.65;
    const maxPV = Math.max(...bridges.map(b => b.pv)) * 1.08;
    const y = v => P.t + ph - (v / maxPV) * ph;
    const bestN = best ? best.n : -1;
    return (
      <svg viewBox={`0 0 ${W} ${Hc}`} style={{ width: "100%", height: "auto" }}>
        {[0, maxPV / 2, maxPV].map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.06)" />
            <text x={P.l - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={MUT} fontFamily={F}>{fmt$(v, 0)}</text>
          </g>
        ))}
        {bridges.map((b, i) => {
          const x0 = P.l + gap * i + (gap - bw) / 2;
          const isBest = b.n === bestN;
          return (
            <g key={b.n}>
              <rect x={x0} y={y(b.pv)} width={bw} height={Math.max(P.t + ph - y(b.pv), 0.5)}
                fill={isBest ? VIO : "rgba(148,163,184,0.4)"} opacity={isBest ? 0.9 : 0.55} rx={2}>
                <title>{`Bridge n=${b.n} yrs: PV=${fmt$(b.pv, 2)} · P_curr(${b.n})=${fmt$(b.pc_n, 2)} · Λ(${b.n})=${fmt$(b.lam, 2)} · Λ*(${b.n})=${fmt$(b.lamStar, 2)}`}</title>
              </rect>
              <text x={x0 + bw / 2} y={y(b.pv) - 6} textAnchor="middle" fontSize={10}
                fill={isBest ? VIO : MUT2} fontFamily={F} fontWeight={isBest ? 700 : 500}>{fmt$(b.pv, 2)}</text>
              <text x={x0 + bw / 2} y={P.t + ph + 16} textAnchor="middle" fontSize={11} fill={isBest ? VIO : MUT2} fontFamily={F} fontWeight={isBest ? 700 : 500}>
                n={b.n}
              </text>
              <text x={x0 + bw / 2} y={P.t + ph + 30} textAnchor="middle" fontSize={9} fill={MUT} fontFamily={F}>
                {b.n === 0 ? "switch now" : b.n === horizon ? "never switch" : `bridge ${b.n}y`}
              </text>
              {isBest && <text x={x0 + bw / 2} y={P.t - 6} textAnchor="middle" fontSize={10} fill={VIO} fontFamily={F} fontWeight={700}>◆ OPTIMAL</text>}
            </g>
          );
        })}
        <text x={P.l - 46} y={P.t - 6} fontSize={10} fill={MUT} fontFamily={F}>PV cost per unit work ($)</text>
      </svg>
    );
  })();

  // Time-series charts. Split into two side-by-side single-axis panels — the
  // 4-series overlay was too dense to read. Each panel now shows exactly two
  // related traces:
  //   (A) Contract prices        — P_next(t) evolving vs. P_c(N) anchor
  //   (B) Effective unit cost    — Λ(t) = P_next / σ, with σ(t) on right axis
  const validCurvePts = curve.filter(p => p.price !== null);
  const noCurve = validCurvePts.length === 0;
  const tMarkers = (x, P, ph) => (
    <>
      {tLaunch <= horizon && (
        <g>
          <line x1={x(tLaunch)} x2={x(tLaunch)} y1={P.t} y2={P.t + ph} stroke={VIO} strokeWidth={1} strokeDasharray="2 3" opacity={0.4} />
          <text x={x(tLaunch)} y={P.t - 18} textAnchor="middle" fontSize={9} fill={VIO} fontFamily={F} opacity={0.9}>t_L={fmtY(tLaunch, 1)}</text>
        </g>
      )}
      {tNorm > tLaunch && tNorm <= horizon && (
        <g>
          <line x1={x(tNorm)} x2={x(tNorm)} y1={P.t} y2={P.t + ph} stroke={CYAN} strokeWidth={1} strokeDasharray="2 3" opacity={0.4} />
          <text x={x(tNorm)} y={P.t - 6} textAnchor="middle" fontSize={9} fill={CYAN} fontFamily={F} opacity={0.9}>t★={fmtY(tNorm, 1)}</text>
        </g>
      )}
    </>
  );
  const legendBar = (items, P, pw, ph) => {
    const legendW = pw / items.length;
    const y = P.t + ph + 46;
    return items.map(([lbl, col, dash], i) => (
      <g key={lbl}>
        <line x1={P.l + i * legendW + 6} x2={P.l + i * legendW + 26} y1={y} y2={y}
          stroke={col} strokeWidth={2} strokeDasharray={dash} opacity={dash ? 0.75 : 1} />
        <text x={P.l + i * legendW + 30} y={y + 4} fontSize={10} fill={col} fontFamily={F}>{lbl}</text>
      </g>
    ));
  };

  // Chart A — Contract prices ($/GPU-hr, single axis).
  const priceChart = (() => {
    if (noCurve) return (
      <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", color: MUT, fontFamily: F, fontSize: 11 }}>
        Launch is past the horizon — no next-gen curve to plot.
      </div>
    );
    const W = 480, Hc = 300, P = { t: 32, r: 20, b: 66, l: 56 };
    const pw = W - P.l - P.r, ph = Hc - P.t - P.b;
    const anchor = pcByTerm(horizon);
    const yMax = Math.max(anchor, ...validCurvePts.map(p => p.price)) * 1.15;
    const x = tt => P.l + (tt / horizon) * pw;
    const yP = v => P.t + ph - (v / yMax) * ph;
    const linePts = validCurvePts.map(p => `${x(p.t)},${yP(p.price)}`).join(" ");
    return (
      <svg viewBox={`0 0 ${W} ${Hc}`} style={{ width: "100%", height: "auto" }}>
        {[0, yMax / 2, yMax].map((v, i) => (
          <g key={"g" + i}>
            <line x1={P.l} x2={W - P.r} y1={yP(v)} y2={yP(v)} stroke="rgba(255,255,255,0.05)" />
            <text x={P.l - 6} y={yP(v) + 4} textAnchor="end" fontSize={10} fill={AMB} fontFamily={F}>{fmt$(v, 2)}</text>
          </g>
        ))}
        <text x={P.l - 6} y={P.t - 10} textAnchor="end" fontSize={9} fill={AMB} fontFamily={F} opacity={0.7}>$/GPU-hr</text>
        {/* P_curr(N) horizontal anchor */}
        <line x1={P.l} x2={W - P.r} y1={yP(anchor)} y2={yP(anchor)} stroke={AMB} strokeWidth={1} strokeDasharray="4 4" opacity={0.55} />
        <text x={P.l + 6} y={yP(anchor) - 4} textAnchor="start" fontSize={9.5} fill={AMB} fontFamily={F} opacity={0.85}>P_curr(N)={fmt$(anchor, 2)}/hr</text>
        {tMarkers(x, P, ph)}
        {/* P_next(t) trajectory */}
        <polyline points={linePts} fill="none" stroke={AMB} strokeWidth={2.2} />
        {Array.from({ length: horizon + 1 }, (_, i) => (
          <text key={"x" + i} x={x(i)} y={P.t + ph + 16} textAnchor="middle" fontSize={10} fill={MUT} fontFamily={F}>y{i}</text>
        ))}
        {legendBar([["P_next(t) trajectory", AMB, ""], ["P_curr(N) anchor", AMB, "4 4"]], P, pw, ph)}
      </svg>
    );
  })();

  // Chart B — Effective unit cost Λ(t) on a single axis, with the P_curr(N)
  // reference line so the "when does Λ cross under our anchor?" question is
  // visually obvious. σ(t) removed — it was a distraction; the Λ curve already
  // embeds its effect.
  const unitCostChart = (() => {
    if (noCurve) return (
      <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", color: MUT, fontFamily: F, fontSize: 11 }}>
        Launch is past the horizon — no Λ curve to plot.
      </div>
    );
    const W = 480, Hc = 300, P = { t: 32, r: 20, b: 66, l: 56 };
    const pw = W - P.l - P.r, ph = Hc - P.t - P.b;
    const yMaxL = Math.max(pcByTerm(horizon), ...validCurvePts.map(p => p.lam ?? 0)) * 1.15;
    const x = tt => P.l + (tt / horizon) * pw;
    const yL = v => P.t + ph - (v / yMaxL) * ph;
    const lamPts = validCurvePts.map(p => `${x(p.t)},${yL(p.lam)}`).join(" ");
    return (
      <svg viewBox={`0 0 ${W} ${Hc}`} style={{ width: "100%", height: "auto" }}>
        {[0, yMaxL / 2, yMaxL].map((v, i) => (
          <g key={"gl" + i}>
            <line x1={P.l} x2={W - P.r} y1={yL(v)} y2={yL(v)} stroke="rgba(255,255,255,0.05)" />
            <text x={P.l - 6} y={yL(v) + 4} textAnchor="end" fontSize={10} fill={RO} fontFamily={F}>{fmt$(v, 2)}</text>
          </g>
        ))}
        <text x={P.l - 6} y={P.t - 10} textAnchor="end" fontSize={9} fill={RO} fontFamily={F} opacity={0.75}>Λ ($/GPU-hr eq.)</text>
        {/* P_curr(N) anchor for reference — same axis as Λ, tells you when Λ crosses under */}
        <line x1={P.l} x2={W - P.r} y1={yL(pcByTerm(horizon))} y2={yL(pcByTerm(horizon))} stroke={AMB} strokeWidth={1} strokeDasharray="4 4" opacity={0.55} />
        <text x={P.l + 6} y={yL(pcByTerm(horizon)) - 4} textAnchor="start" fontSize={9.5} fill={AMB} fontFamily={F} opacity={0.85}>P_curr(N)={fmt$(pcByTerm(horizon), 2)}/hr</text>
        {tMarkers(x, P, ph)}
        <polyline points={lamPts} fill="none" stroke={RO} strokeWidth={2.2} />
        {Array.from({ length: horizon + 1 }, (_, i) => (
          <text key={"x" + i} x={x(i)} y={P.t + ph + 16} textAnchor="middle" fontSize={10} fill={MUT} fontFamily={F}>y{i}</text>
        ))}
        {legendBar([["Λ(t) = P_next / σ", RO, ""], ["P_curr(N) anchor", AMB, "4 4"]], P, pw, ph)}
      </svg>
    );
  })();

  // Break-even analysis split into two independent tables so the two
  // scenarios (forecast-required vs forecast-free) don't sit smushed together.
  const thStyle = { padding: "6px 10px", textAlign: "right", color: MUT, borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9.5, letterSpacing: "0.05em", textTransform: "uppercase" };
  const tdStyle = (extra = {}) => ({ padding: "6px 10px", textAlign: "right", ...extra });

  // Table A — Forecast-based: what next-gen delivers under YOUR assumptions.
  //   Columns depend on P_L, inflation, decay, σ_∞, maturity inputs.
  const forecastTable = (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: F }}>
        <thead>
          <tr>
            {[
              <>n (bridge yrs)</>,
              <>P<sub>curr</sub>(n) $/hr</>,
              <>P<sub>next</sub>(n) $/hr</>,
              <>σ(n)</>,
              <>Avg next-gen cost $/hr-eq</>,
              <>PV(n)</>,
            ].map((hd, i) => (
              <th key={i} style={thStyle}>{hd}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bridges.map(b => {
            const isBest = best && b.n === best.n;
            return (
              <tr key={b.n} style={isBest ? { background: "rgba(196,181,253,0.06)" } : null}>
                <td style={tdStyle({ color: isBest ? VIO : "#e2e8f0", fontWeight: isBest ? 700 : 500 })}>{b.n}{b.n === 0 ? " (now)" : b.n === horizon ? " (never)" : ""}</td>
                <td style={tdStyle({ color: AMB })}>{fmt$(b.pc_n, 2)}</td>
                <td style={tdStyle({ color: MUT2 })}>{fmt$(b.pNextAt, 2)}</td>
                <td style={tdStyle({ color: GRW })}>{fmtx(b.sigmaAt, 2)}</td>
                <td style={tdStyle({ color: RO })}>{fmt$(b.lam, 2)}</td>
                <td style={tdStyle({ color: isBest ? VIO : "#e2e8f0", fontWeight: isBest ? 700 : 500 })}>{fmt$(b.pv, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // Table B — Forecast-free: the break-even bar, computed from P_curr rates
  //   alone (no P_L / g / δ / σ inputs enter the RHS). Gap = Λ*(n) − Λ_avg(n),
  //   shown for reference (green = forecast beats the bar).
  const breakEvenTable = (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: F }}>
        <thead>
          <tr>
            {[
              <>n (bridge yrs)</>,
              <>P<sub>curr</sub>(n) $/hr</>,
              <>Λ<sup>*</sup>(n) break-even $/hr-eq</>,
              <>gap vs Λ<sup>*</sup></>,
            ].map((hd, i) => (
              <th key={i} style={thStyle}>{hd}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bridges.map(b => {
            const isBest = best && b.n === best.n;
            const gapVal = b.lamStar != null && b.lam != null ? b.lamStar - b.lam : null;
            const winning = gapVal != null && gapVal > 0;
            return (
              <tr key={b.n} style={isBest ? { background: "rgba(196,181,253,0.06)" } : null}>
                <td style={tdStyle({ color: isBest ? VIO : "#e2e8f0", fontWeight: isBest ? 700 : 500 })}>{b.n}{b.n === 0 ? " (now)" : b.n === horizon ? " (never)" : ""}</td>
                <td style={tdStyle({ color: AMB })}>{fmt$(b.pc_n, 2)}</td>
                <td style={tdStyle({ color: VIO, fontWeight: 600 })}>{fmt$(b.lamStar, 2)}</td>
                <td style={tdStyle({ color: winning ? GRW : (gapVal === null ? MUT : RO) })}>
                  {gapVal === null ? "—" : (winning ? "+" : "") + fmt$(gapVal, 2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // ── Derivation steps content — one continuous section, each step
  //    individually collapsible. Default: all collapsed (cheaper KaTeX render
  //    on first load, and keeps the tab compact — the equations are reference
  //    material, not the primary result).
  const [expandedSteps, setExpandedSteps] = React.useState(() => new Set());
  const steps = [
    {
      title: "From physics to cost per year (per generation)",
      body: (
        <>
          <div>Start with what you actually need: some quantity of work W per year — effective PFLOP-hours, tokens trained, whatever unit survives goodput adjustment. A GPU delivers work at throughput τ (work per GPU-hour), but only during hours it's actually productive. If you contract H GPU-hours and utilization is u, productive hours are H·u, so:</div>
          <Eq>{String.raw`W \;=\; \tau \cdot H \cdot u \qquad\Longrightarrow\qquad H \;=\; \dfrac{W}{\tau \cdot u}`}</Eq>
          <div>At price P per contracted GPU-hour, annual cost is:</div>
          <Eq>{String.raw`C \;=\; P \cdot H \;=\; \dfrac{P \cdot W}{\tau \cdot u}`}</Eq>
          <div>P multiplies contracted hours, not productive ones — idle reserved capacity inflates cost with no offsetting benefit, which is why u lands in the denominator. Now define H<sub>0</sub> = W / (τ · u) as the contracted hours needed per year on the current generation, and σ = τ<sub>next</sub> · u<sub>next</sub> / (τ · u) as the goodput-adjusted speedup of the next generation. Then H<sub>next</sub> = H<sub>0</sub> / σ — the load-bearing substitution: a σ× faster chip needs 1/σ as many hours for the same work, which is how a chip with a higher hourly price can still be cheaper per unit of work delivered. Annual costs by generation:</div>
          <Eq>{String.raw`C_{\text{curr}} \;=\; P_{\text{curr}} \cdot H_0 \qquad\text{and}\qquad C_{\text{next}} \;=\; \dfrac{P_{\text{next}}}{\sigma} \cdot H_0`}</Eq>
          <div>This is the entire physics. Everything after is accounting.</div>
        </>
      ),
    },
    {
      title: "Discounting & the bridge PV formula",
      body: (
        <>
          <div>Money spent in year y isn't worth money spent today. With cost of capital r, a payment in year y has present value (1+r)^−y. Define the annuity factor — present value of one unit paid annually for n years:</div>
          <Eq>{String.raw`A(n,\,r) \;=\; \sum_{y=1}^{n} (1+r)^{-y} \;=\; \dfrac{1 \,-\, (1+r)^{-n}}{r}`}</Eq>
          <div>Sanity check: A(0, r) = 0. ✓ &nbsp; A(∞, r) = 1/r. ✓ Over horizon N, a bridge strategy runs current gen for years 1..n, then next gen for years n+1..N. Combining the two phases:</div>
          <Eq>{String.raw`\text{PV}(n) \;=\; P_{\text{curr}}(n) \cdot H_0 \cdot A(n,\,r) \;+\; P_{\text{next}}(n) \cdot H_0 \cdot \!\!\!\sum_{y=n+1}^{N}\!\! \dfrac{(1+r)^{-y}}{\sigma(y)}`}</Eq>
          <div>The tail is <em>integrated over σ(y)</em> — contract price P<sub>next</sub> is locked at switch time n, but realized speedup keeps improving year-by-year with software maturity after the switch (step 3 defines σ(y) as σ<sub>∞</sub> · m(y)). The time-invariant shortcut <Eq>{String.raw`\text{PV}(n) \;=\; P_{\text{curr}}(n) \cdot H_0 \cdot A(n,\,r) \;+\; \dfrac{P_{\text{next}}(n)}{\sigma(n)} \cdot H_0 \cdot \bigl[\,A(N,\,r) \,-\, A(n,\,r)\,\bigr]`}</Eq> is what you get if σ is treated as constant after the switch. With a maturity ramp, that shortcut systematically over-penalizes early bridges — it makes you pay year-1 immature σ for year-4 mature workloads.</div>
          <div>Since H<sub>0</sub> multiplies every strategy identically, it drops out of any comparison. The optimal strategy is scale-invariant — same answer for 64 GPUs as for 6,400. Useful when you're arguing with a CFO who thinks the answer changes with deal size.</div>
        </>
      ),
    },
    {
      title: "Price & speedup trajectories, with boundary cases",
      body: (
        <>
          <div><b style={{ color: "#e2e8f0" }}>Two-regime pricing.</b> Next-gen silicon launches at a scarcity premium that in supply-constrained markets keeps appreciating before it decays — a single exponential decay from t<sub>L</sub> is too clean. Model P<sub>next</sub>(t) as inflating at rate g through normalization time t<sup>★</sup>, then decaying at rate δ:</div>
          <Eq>{String.raw`P_{\text{next}}(t) \;=\; P_L \cdot (1+g)^{\,t - t_L} \qquad\text{for } t_L \le t < t^{\!\star}`}</Eq>
          <Eq>{String.raw`P_{\text{next}}(t) \;=\; P_L \cdot (1+g)^{\,t^{\!\star} - t_L} \cdot e^{-\delta\,(t - t^{\!\star})} \qquad\text{for } t \ge t^{\!\star}`}</Eq>
          <div><b style={{ color: "#e2e8f0" }}>Maturity-adjusted speedup.</b> Realized σ at launch is a fraction of eventual σ — optimized frameworks lag hardware by ~2 years. Model it as σ(t) = σ<sub>∞</sub> · m(t) with m rising linearly from launch-day maturity m<sub>0</sub> to 1 over t<sub>mat</sub> years:</div>
          <Eq>{String.raw`\sigma(t) \;=\; \sigma_\infty \cdot m(t), \qquad m(t) \;=\; \min\!\left(1,\; m_0 \,+\, (1 - m_0) \cdot \dfrac{t - t_L}{t_{\text{mat}}}\right) \quad\text{for } t \ge t_L`}</Eq>
          <div>This is what σ(y) in step 2's PV formula actually is. Both corrections — two-regime pricing and the maturity ramp — push toward longer bridges: switching at launch buys peak price <em>and</em> immature software, so you pay the premium for performance you can't yet extract. It's also why PV(n) isn't monotone in n — bridging longer costs you time on slower hardware but buys a cheaper entry price on the new one <em>and</em> more of the maturity gain is banked before you switch.</div>
          <div>With P<sub>next</sub>(t) and σ(t) defined, three sanity-check boundaries hold:</div>
          <ul style={{ margin: "4px 0 4px 20px", padding: 0, lineHeight: 1.7 }}>
            <li><b style={{ color: VIO }}>σ → 1:</b> no speedup, so C<sub>next</sub> = P<sub>next</sub> · H<sub>0</sub> — you're paying a premium for identical throughput; switching can only be justified by non-price factors.</li>
            <li><b style={{ color: VIO }}>σ → ∞:</b> switch as early as physically possible.</li>
            <li><b style={{ color: VIO }}>n = N:</b> never switch. Tail term vanishes since A(N) − A(N) = 0. ✓</li>
          </ul>
        </>
      ),
    },
    {
      title: "Is switching worth it, and if so when? — decision rules & enumeration",
      body: (
        <>
          <div>Strip discounting (r = 0) and compare steady-state annual unit costs. Next-gen wins per unit of work iff:</div>
          <Eq>{String.raw`\sigma \;>\; \dfrac{P_{\text{next}}}{P_{\text{curr}}}`}</Eq>
          <div>The speedup must exceed the price premium. Everything else in the model is second-order correction to this. If you remember one thing, it's this inequality — and the fact that the right-hand side shrinks every year while σ<sub>∞</sub> is fixed at launch.</div>
          <div>For picking the right bridge length, take the first difference PV(n+1) − PV(n). Bridging one more year replaces one year of next-gen cost with one year of current-gen cost, plus you get to lock in a (hopefully) lower Λ:</div>
          <Eq>{String.raw`\text{Wait one more year iff:}\quad \bigl[\Lambda(n) - \Lambda(n{+}1)\bigr] \cdot \!\!\!\sum_{y=n+2}^{N}\!\! (1+r)^{-y} \;\;>\;\; \bigl[P_{\text{curr}}(n) - \Lambda(n)\bigr] \cdot (1+r)^{-(n+1)}`}</Eq>
          <div>Two forces, explicitly opposed. Early in the horizon the tail is long and decay savings are large, so waiting wins. Late in the horizon the tail is short and the current-gen carrying cost dominates, so you stop waiting. That's the whole shape of the problem in one line.</div>
          <div>You might expect to differentiate and solve for n*. You can't cleanly: P<sub>curr</sub> is a step function read off a vendor rate card (terms come in 1/2/3/5-year buckets, not a continuum), and n is integer-valued. So:</div>
          <Eq>{String.raw`n^{\!*} \;=\; \underset{n \,\in\, \{\lceil t_L\rceil,\; \ldots,\; N\}}{\arg\min}\; \text{PV}(n)`}</Eq>
          <div>Enumerate. The candidate set has maybe four elements. This is a feature — it means the model is trivially auditable in a spreadsheet, which matters more than elegance when someone senior is checking your work. (This is exactly what the PV-by-bridge-length bar chart above is: 6-10 candidate n's, evaluated exhaustively, argmin highlighted.)</div>
        </>
      ),
    },
    {
      title: "What would next-gen have to cost to break even? — the break-even Λ*(n)",
      body: (
        <>
          <div>P<sub>L</sub>, g, and δ are forecasts, not observables. But they only enter as the quotient Λ(t) = P<sub>next</sub>(t) / σ(t). Define this as the next-gen effective price per unit of work, denominated in the same units as P<sub>curr</sub> — directly comparable.</div>
          <div>Collapsing two unknowns into one isn't cosmetic. Errors are correlated in the helpful direction: a chip that lands faster than expected is almost always priced higher than expected, and vice versa. Forecasting Λ is meaningfully easier than forecasting either component, because the two mistakes partially cancel.</div>
          <div>Don't forecast Λ — solve for the value that makes you indifferent, then ask whether reality is plausibly on the far side of it. From PV(n) = PV(N):</div>
          <Eq>{String.raw`\Lambda^{\!*}(n) \;=\; \dfrac{P_{\text{curr}}(N)\cdot A(N,\,r) \;-\; P_{\text{curr}}(n)\cdot A(n,\,r)}{A(N,\,r) \;-\; A(n,\,r)}`}</Eq>
          <div>Every term on the right is a quoted price you can verify today. No forecast anywhere. This is the "what would have to be true" version — the one that goes into the meeting.</div>
        </>
      ),
    },
    {
      title: "Workload-decomposing σ_∞ — making the speedup auditable",
      body: (
        <>
          <div>σ<sub>∞</sub> isn't a scalar the vendor hands you. It's workload-dependent — different workloads hit different bottlenecks:</div>
          <ul style={{ margin: "4px 0 4px 20px", padding: 0, lineHeight: 1.7 }}>
            <li><b style={{ color: GRW }}>Training and prefill</b> are FLOPs-bound — dense tensor throughput at matched precision. A chip without native support for the requested precision falls back to the highest precision both chips share.</li>
            <li><b style={{ color: CYAN }}>Inference decode</b> is memory-bandwidth-bound — every generated token streams model weights from HBM to registers, so aggregate HBM bandwidth is what matters, not FLOPs.</li>
          </ul>
          <div>Define the two regime speedups, blend by workload mix:</div>
          <Eq>{String.raw`\sigma_{\text{train}} \;=\; \dfrac{\text{TFLOPS}_{\text{next}}(p^*)}{\text{TFLOPS}_{\text{cur}}(p^*)} \qquad\quad \sigma_{\text{decode}} \;=\; \dfrac{\text{BW}_{\text{next}}}{\text{BW}_{\text{cur}}}`}</Eq>
          <Eq>{String.raw`\sigma_\infty \;=\; w_{\text{train}} \cdot \sigma_{\text{train}} \;+\; (1 - w_{\text{train}}) \cdot \sigma_{\text{decode}}`}</Eq>
          <div>where p<sup>*</sup> is the highest precision both chips natively support and w<sub>train</sub> is pulled from your demand book (or overridden). σ<sub>∞</sub> becomes a computation over two ratios you verify against a spec sheet, weighted by your own demand mix — not a number the vendor hands you.</div>
          <div>The remaining wildcard is realized-vs-peak throughput (goodput), which is what the maturity ramp m(t) in step 3 stands in for. If B200 quotes 4× FP4 on paper but a fresh vLLM only delivers 2× of that in month 1, that's m<sub>0</sub> = 0.5.</div>
        </>
      ),
    },
  ];

  return (
    <div style={{ background: "#0b1118", color: "#e2e8f0", minHeight: "calc(100vh - 60px)", padding: "18px 20px 40px", fontFamily: F }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>

        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Future Supply <span style={{ color: AMB }}>&mdash; old-gen vs. new-gen upgrade timing</span>
          </div>
          <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.72)", marginTop: 6, lineHeight: 1.6 }}>
            <div style={{ marginBottom: 6 }}>When do we stop signing new positions on current-generation silicon and start signing next-gen instead?</div>
            <ul style={{ margin: 0, paddingLeft: 18, color: "rgba(255,255,255,0.65)" }}>
              <li style={{ marginBottom: 4 }}><b style={{ color: "#e2e8f0" }}>Decision variable:</b> <em>new</em> contracts. Existing supply-book positions are locked and can't be exited, so their historical rate doesn't factor in — <b>P<sub>curr</sub>(N)</b> seeds from the current-market rate for a fresh reservation on the picked chip.</li>
              <li style={{ marginBottom: 4 }}><b style={{ color: "#e2e8f0" }}>Bridge strategies:</b> for every valid switch year — from the next-gen launch year through the end of the planning horizon — the model prices "sign current-gen for n years, then switch to next-gen for the remainder", using two-regime price dynamics (scarcity inflation → normalization decay) and a maturity-ramped speedup, then picks the n with the lowest total PV.</li>
              <li style={{ marginBottom: 4 }}><b style={{ color: "#e2e8f0" }}>σ decomposition:</b> speedup is workload-dependent, so σ<sub>∞</sub> = <b style={{ color: GRW }}>σ<sub>train</sub></b> (FLOPs ratio at matched precision, weighted by training share from your demand book) + <b style={{ color: CYAN }}>σ<sub>decode</sub></b> (HBM bandwidth ratio, weighted by inference share). Training and inference hit different bottlenecks; blending is honest.</li>
              <li><b style={{ color: "#e2e8f0" }}>Inverted form:</b> solves for the break-even effective price <b style={{ color: AMB }}>Λ<sup>*</sup>(n)</b> — measured in <b>$/GPU-hr of current-gen-equivalent work</b> (next-gen $/hr ÷ its speedup) — that would tie bridge-n with never-switching.</li>
            </ul>
          </div>
        </div>

        <H title="Result — optimal bridge length" />

        <Sec title="Glossary — variables used in the charts and tables below">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, fontSize: 10.5, lineHeight: 1.55 }}>
            <div>
              <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5, fontFamily: F, fontWeight: 600 }}>Horizon & discount</div>
              <ul style={{ margin: 0, paddingLeft: 14, color: MUT2 }}>
                <li><b style={{ color: "#e2e8f0" }}>N</b> — planning window (years).</li>
                <li><b style={{ color: VIO }}>n</b> — bridge length; <b style={{ color: VIO }}>n*</b> = PV-minimizing choice (violet bar).</li>
                <li><b style={{ color: "#e2e8f0" }}>r</b> — discount rate / cost of capital.</li>
                <li><b style={{ color: "#e2e8f0" }}>A(n,r)</b> — annuity factor [1−(1+r)<sup>−n</sup>]/r; PV of $1/yr for n years.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5, fontFamily: F, fontWeight: 600 }}>Current-gen pricing</div>
              <ul style={{ margin: 0, paddingLeft: 14, color: MUT2 }}>
                <li><b style={{ color: AMB }}>P<sub>curr</sub>(N)</b> — $/GPU-hr at full N-yr lock; the "never-switch" anchor.</li>
                <li><b style={{ color: AMB }}>P<sub>curr</sub>(n)</b> — $/GPU-hr at n-yr lock; shorter n prices higher via <b>termDiscount</b> %/yr.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5, fontFamily: F, fontWeight: 600 }}>Next-gen price (2-regime)</div>
              <ul style={{ margin: 0, paddingLeft: 14, color: MUT2 }}>
                <li><b style={{ color: "#e2e8f0" }}>t<sub>L</sub></b> — years until launch.</li>
                <li><b style={{ color: "#e2e8f0" }}>P<sub>L</sub></b> — launch $/GPU-hr.</li>
                <li><b style={{ color: AMB }}>g</b> — inflation while HBM-tight (%/yr).</li>
                <li><b style={{ color: "#e2e8f0" }}>t<sup>★</sup></b> — normalization year (inflate → decay).</li>
                <li><b style={{ color: "#e2e8f0" }}>δ</b> — post-normalization decay (%/yr).</li>
                <li><b style={{ color: AMB }}>P<sub>next</sub>(t)</b> — resulting rate at year t (piecewise).</li>
              </ul>
            </div>
            <div>
              <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5, fontFamily: F, fontWeight: 600 }}>Speedup (blended)</div>
              <ul style={{ margin: 0, paddingLeft: 14, color: MUT2 }}>
                <li><b style={{ color: GRW }}>σ<sub>train</sub></b> — FLOPs ratio at matched precision (training).</li>
                <li><b style={{ color: CYAN }}>σ<sub>decode</sub></b> — HBM-BW ratio (inference decode).</li>
                <li><b style={{ color: "#e2e8f0" }}>σ<sub>∞</sub></b> — mature blend: train-share·σ<sub>train</sub> + inf-share·σ<sub>decode</sub>.</li>
                <li><b style={{ color: "#e2e8f0" }}>m<sub>0</sub></b> — launch-day maturity (frac. of σ<sub>∞</sub>).</li>
                <li><b style={{ color: "#e2e8f0" }}>t<sub>mat</sub></b> — years to reach σ<sub>∞</sub>.</li>
                <li><b style={{ color: GRW }}>σ(t)</b> — realized σ at t; ramps m<sub>0</sub>·σ<sub>∞</sub> → σ<sub>∞</sub> over t<sub>mat</sub>.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5, fontFamily: F, fontWeight: 600 }}>Decision quantities</div>
              <ul style={{ margin: 0, paddingLeft: 14, color: MUT2 }}>
                <li><b style={{ color: RO }}>Λ(t)</b> — effective unit cost P<sub>next</sub>(t)/σ(t), in $/curr-gen-equiv hr.</li>
                <li><b style={{ color: VIO }}>Λ<sup>*</sup>(n)</b> — break-even Λ that ties bridge-n with never-switching.</li>
                <li><b style={{ color: "#e2e8f0" }}>PV(n)</b> — total PV of bridge-n over N years; smallest wins.</li>
              </ul>
            </div>
          </div>
        </Sec>

        <Sec title={`PV of total cost by bridge length — ${currentGpu === "PORTFOLIO_AVG" ? "Portfolio blend" : (HARDWARE_CATALOG[currentGpu]?.label || currentGpu)} → ${HARDWARE_CATALOG[nextGenId]?.label || nextGenId} (per unit of work)`}>
          {pvChart}
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4, lineHeight: 1.5 }}>
            Each bar is one bridge choice: run current-gen for <b>n</b> years then switch to next-gen for the remaining <b>N−n</b> years, PV'd back to today. Optimal <b>n*</b> highlighted in violet. If PV is monotone increasing → never switch; if monotone decreasing → switch as early as possible; if U-shaped → interior optimum. Current-gen rate for shorter contracts scales up per the <b>{fmtPc(termDiscount, 1)}/yr</b> contract length discount (a shorter contract gives back years of the discount).
          </div>
        </Sec>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <Sec title="A. Contract prices — P_next(t) vs. P_curr(N) anchor" style={{ marginBottom: 0 }}>
            {priceChart}
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4, lineHeight: 1.5 }}>
              Raw quoted rates. <span style={{ color: AMB }}>P<sub>next</sub>(t)</span> is two-regime — inflates at {fmtPc(inflationRate, 0)}/yr from launch through t<sup>★</sup>={fmtY(tNorm, 1)}, then decays at {fmtPc(decayRate, 0)}/yr. The <span style={{ color: AMB }}>P<sub>curr</sub>(N)</span> dashed line is the current-gen full-horizon lock we're comparing against. Where the trajectory crosses under the dashed line = when next-gen becomes cheaper per contracted GPU-hour (before adjusting for speedup).
            </div>
          </Sec>
          <Sec title="B. Effective unit cost Λ(t) vs. P_curr(N) anchor" style={{ marginBottom: 0 }}>
            {unitCostChart}
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4, lineHeight: 1.5 }}>
              Speedup-adjusted. <span style={{ color: RO }}>Λ(t) = P<sub>next</sub>(t) / σ(t)</span> is what next-gen actually costs per unit of work — speedup already baked in via σ(t) rising from {fmtPc(maturityInit, 0)} of σ<sub>∞</sub> at launch to 100% over {fmtY(maturityYears, 1)}. Where Λ crosses under the <span style={{ color: AMB }}>P<sub>curr</sub>(N)</span> anchor is when next-gen wins per unit of work delivered — the actionable moment.
            </div>
          </Sec>
        </div>

        <div style={{ padding: "10px 14px", background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.15)", borderRadius: 4, color: "rgba(255,255,255,0.75)", fontSize: 11, lineHeight: 1.6, marginBottom: 14 }}>
          <b style={{ color: AMB }}>Two ways to read tables C & D:</b> (a) <b>With a next-gen forecast → read Table C.</b> It plays your forecast through each bridge length and reports total PV, so the smallest-PV row is the recommended bridge. (b) <b>Without a next-gen forecast → read Table D.</b> It reports Λ<sup>*</sup>(n) — the highest $/hr-equivalent next-gen could cost and still make bridge-n beat never-switching. Larger Λ<sup>*</sup>(n) = more forgiving bar. If you do have a forecast, the gap column shows Λ<sup>*</sup>(n) minus Table C's "Avg next-gen cost" — the largest green gap is the most attractive bridge.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <Sec title="C. Forecast-based — what next-gen actually delivers under your assumptions" style={{ marginBottom: 0 }}>
            {forecastTable}
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 10, lineHeight: 1.55 }}>
              Every number here depends on your next-gen inputs (launch price, inflation, decay, ultimate speedup, maturity ramp). Read it as: <em>"if my forecast is right, here's what each bridge strategy really costs."</em>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "rgba(255,255,255,0.6)" }}>
                <li><b style={{ color: AMB }}>P<sub>curr</sub>(n)</b> — the current-gen rate you'd sign for an n-year contract (higher for shorter contracts).</li>
                <li><b>P<sub>next</sub>(n)</b> — the next-gen contract rate at the moment you switch, i.e. year n. Locked at that rate for the rest of the horizon.</li>
                <li><b style={{ color: GRW }}>σ(n)</b> — realized next-gen speedup at year n. Grows over time as the software stack matures (ramp from m<sub>0</sub> to 1).</li>
                <li><b style={{ color: RO }}>Avg next-gen cost</b> — the average effective $/hr you actually pay on next-gen across all the years after you switch, in current-gen-equivalent units (i.e. adjusted for speedup). σ improves year by year during those years, so this is not just P<sub>next</sub>(n) / σ(n) — it's a discount-weighted average that gives credit for maturity gains that show up after the switch.</li>
                <li><b>PV(n)</b> — total present-value cost of the whole bridge (both phases). Smallest wins — that row is highlighted violet.</li>
              </ul>
            </div>
          </Sec>
          <Sec title="D. Forecast-free — the break-even bar Λ*(n)" style={{ marginBottom: 0 }}>
            {breakEvenTable}
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 10, lineHeight: 1.55 }}>
              Every number here uses only current-gen prices and your discount rate — no next-gen assumptions at all. Read it as: <em>"without predicting anything about next-gen, here's the bar it would have to clear at each switch year."</em>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "rgba(255,255,255,0.6)" }}>
                <li><b style={{ color: AMB }}>P<sub>curr</sub>(n)</b> — same as Table C.</li>
                <li><b style={{ color: VIO }}>Λ<sup>*</sup>(n) break-even</b> — the highest $/hr-equivalent next-gen could cost while still making bridge-n at least as good as never-switching. If next-gen ends up cheaper than Λ<sup>*</sup>(n), bridging n years wins; if it ends up more expensive, you're better off staying on current-gen for the whole horizon. This is the "bar" — a number you can look at and judge against your own priors without needing the model to price P<sub>L</sub> or δ for you.</li>
                <li><b>gap vs Λ<sup>*</sup></b> — Λ<sup>*</sup>(n) minus the "Avg next-gen cost" from Table C. <span style={{ color: GRW }}>Green (positive)</span> = your forecast is under the bar → bridging n years pays. <span style={{ color: RO }}>Red (negative)</span> = your forecast is over the bar → don't switch at that n.</li>
              </ul>
            </div>
          </Sec>
        </div>

        <H title="Assumptions" />
        <Sec title="Horizon & discount">
          <Row>
            <InpBox label="Horizon N (years)" value={horizon} onChange={setHorizon} min={2} max={10} step={1} fmt={v => v + " yr"} hint="Total planning window over which you're comparing bridge lengths." />
            <InpBox label="Discount rate r" value={discountRate} onChange={setDiscountRate} min={0} max={25} step={0.1} fmt={v => v.toFixed(1) + "%"} hint="Cost of capital used to PV each year's spend." />
          </Row>
        </Sec>
        <Sec title="Current-generation (chip we'd sign new positions on)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 12 }}>
            <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: F }}>Current-gen GPU</div>
              <select value={currentGpu} onChange={e => setCurrentGpu(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#e2e8f0", fontFamily: F, fontSize: 12 }}>
                {(() => {
                  const port = portfolioSpec(supply);
                  return <option value="PORTFOLIO_AVG" style={{ background: "#0b1118" }}>◆ Portfolio blend (mix-weighted new-sign){port ? ` — ${port.tflops.toFixed(0)}TF · ${port.bw.toFixed(1)}TB/s · $${port.portfolioMarketRate.toFixed(2)}/hr` : " — no active book"}</option>;
                })()}
                <option disabled style={{ background: "#0b1118", color: "rgba(255,255,255,0.3)" }}>── single chip ──</option>
                {releasedKeys.map(k => {
                  const c = HARDWARE_CATALOG[k];
                  const inBook = weightedReservedRate(supply, k) != null;
                  return <option key={k} value={k} style={{ background: "#0b1118" }}>{c.label} · {c.vendor} · {c.tflops}TF · {c.bw}TB/s{inBook ? " · in book" : ""}</option>;
                })}
              </select>
              {(() => {
                if (currentGpu === "PORTFOLIO_AVG") {
                  const port = portfolioSpec(supply);
                  if (!port) return <div style={{ fontSize: 9.5, color: RO, marginTop: 6, lineHeight: 1.5 }}>No active reserved positions in supply book — pick a specific chip.</div>;
                  const rows = supply.filter(r => r.status === "active" && r.structure === "reserved" && r.remMo > 0);
                  const byChip = {};
                  for (const r of rows) {
                    const w = r.gpus * r.remMo;
                    if (!byChip[r.gpu]) byChip[r.gpu] = 0;
                    byChip[r.gpu] += w;
                  }
                  const chipShares = Object.entries(byChip).sort((a, b) => b[1] - a[1]).map(([g, w]) => `${g} ${(w / port.totalGpuMonths * 100).toFixed(0)}%`);
                  return (
                    <div style={{ fontSize: 9.5, color: MUT, marginTop: 6, lineHeight: 1.5 }}>
                      New-sign market (weighted by book mix): <b style={{ color: AMB }}>${port.portfolioMarketRate.toFixed(2)}/hr</b> · seeded P_curr(N).
                      <br /><span style={{ color: "rgba(255,255,255,0.28)" }}>Book-locked positions currently avg ${port.portfolioRate.toFixed(2)}/hr — reference only; they're sunk and don't affect the marginal sign/switch decision.</span>
                      <br />Mix: {chipShares.join(" · ")}
                      <br />Weighted FP16: {port.tflops.toFixed(0)} TF · HBM: {port.bw.toFixed(2)} TB/s · VRAM: {port.vram.toFixed(0)} GB · FP8x: {port.fp8x.toFixed(2)} · FP4x: {port.fp4x.toFixed(2)}
                    </div>
                  );
                }
                const c = HARDWARE_CATALOG[currentGpu];
                const book = weightedReservedRate(supply, currentGpu);
                return (
                  <div style={{ fontSize: 9.5, color: MUT, marginTop: 6, lineHeight: 1.5 }}>
                    New-sign market rate: <b style={{ color: AMB }}>${c.market?.toFixed(2)}/hr</b> · seeded P_curr(N).
                    {book != null && <><br /><span style={{ color: "rgba(255,255,255,0.28)" }}>Book-locked positions on this chip currently avg ${book.toFixed(2)}/hr — reference only; sunk.</span></>}
                    <br />FP16 dense: {c.tflops} TF · HBM: {c.bw} TB/s · VRAM: {c.vram} GB · FP8: {c.fp8x > 0 ? c.fp8x + "×" : "no native"} · FP4: {c.fp4x > 0 ? c.fp4x + "×" : "no native"}
                  </div>
                );
              })()}
            </div>
            <InpBox label="P_curr(N) — new-sign N-yr rate ($/hr)" value={pCurrent} onChange={setPCurrent} min={0.50} max={10.00} step={0.01} fmt={v => "$" + v.toFixed(2)} hint="Seeded from current-market rate for a new reserved sign — edit to run a what-if." />
            <InpBox label="Contract length discount (%/yr)" value={termDiscount} onChange={setTermDiscount} min={0} max={20} step={0.1} fmt={v => v.toFixed(1) + "%/yr"} hint="Discount each additional year of contract length gets you off the shorter-term rate. Set 0 to price all terms flat." />
          </div>
          {currentGpu === "PORTFOLIO_AVG" && (
            <div style={{ background: "rgba(196,181,253,0.05)", border: "1px solid rgba(196,181,253,0.15)", borderRadius: 6, padding: "8px 12px", fontSize: 10.5, color: "rgba(255,255,255,0.7)", fontFamily: F, lineHeight: 1.55 }}>
              <b style={{ color: VIO }}>Portfolio blend</b> asks "if we keep signing new positions in our current chip mix at today's market rates, vs. switch to next-gen — which wins?" Specs are GPU-month-weighted across the active reserved book (so σ_train/σ_decode reflect the average chip you'd sign more of); the rate is the market rate for those chips weighted by that same mix. Useful when your fleet is heterogeneous.
            </div>
          )}
        </Sec>
        <Sec title="Next-generation (announced, not yet in book)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 12 }}>
            <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: F }}>Next-gen GPU</div>
              <select value={nextGenId} onChange={e => setNextGenId(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#e2e8f0", fontFamily: F, fontSize: 12 }}>
                {futureKeys.map(k => {
                  const c = HARDWARE_CATALOG[k];
                  return <option key={k} value={k} style={{ background: "#0b1118" }}>{c.label} · {c.vendor} · {c.tflops}TF · {c.bw}TB/s · t_L={c.tLaunch}y</option>;
                })}
              </select>
              {(() => {
                const c = HARDWARE_CATALOG[nextGenId];
                return (
                  <div style={{ fontSize: 9.5, color: MUT, marginTop: 6, lineHeight: 1.5 }}>
                    FP16 dense: {c.tflops} TF · HBM: {c.bw} TB/s · VRAM: {c.vram} GB · FP4: {c.fp4x > 0 ? c.fp4x + "×" : "no"}
                    <br /><span style={{ color: "rgba(255,255,255,0.5)", fontStyle: "italic" }}>{c.note}</span>
                  </div>
                );
              })()}
            </div>
            <InpBox label="Launch year t_L (yrs from now)" value={tLaunch} onChange={setTLaunch} min={0} max={5} step={0.05} fmt={v => v.toFixed(2) + " yr"} hint="Seeded from catalog; edit to test earlier/later launch." />
            <InpBox label="Launch price P_L ($/hr)" value={pLaunch} onChange={setPLaunch} min={1.00} max={15.00} step={0.05} fmt={v => "$" + v.toFixed(2)} hint="Seeded from catalog; contracted rate at launch before inflation/decay." />
            <InpBox label="Inflation g (pre-normalization %/yr)" value={inflationRate} onChange={setInflationRate} min={-10} max={40} step={0.5} fmt={v => v.toFixed(1) + "%/yr"} hint="Scarcity premium builds until supply normalizes. Set negative to skip." />
            <InpBox label="Normalization year t★" value={tNorm} onChange={setTNorm} min={0} max={6} step={0.05} fmt={v => v.toFixed(2) + " yr"} hint="When HBM/CoWoS supply catches up and prices flip from inflating to decaying." />
            <InpBox label="Decay δ (post-normalization %/yr)" value={decayRate} onChange={setDecayRate} min={0} max={50} step={0.5} fmt={v => v.toFixed(1) + "%/yr"} hint="How fast next-gen price falls once supply normalizes." />
            <InpBox label="Maturity m₀ at launch (%)" value={maturityInit} onChange={setMaturityInit} min={30} max={100} step={0.5} fmt={v => v.toFixed(1) + "%"} hint="Fraction of σ∞ realized on day one — immature CUDA/vLLM/TensorRT drags this down." />
            <InpBox label="Maturity ramp duration (yrs)" value={maturityYears} onChange={setMaturityYears} min={0} max={4} step={0.05} fmt={v => v.toFixed(2) + " yr"} hint="Years after launch until the software stack matures and m(t) = 1." />
          </div>
        </Sec>
        <Sec title="Workload & precision — decomposes σ into a physical blend">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 8 }}>
            {/* ── Picker 1: training share ─────────────────────────────── */}
            <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: F }}>Training share</div>
              <select value={trainShareMode} onChange={e => setTrainShareMode(e.target.value)}
                style={{ width: "100%", padding: "5px 6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#e2e8f0", fontFamily: F, fontSize: 11, marginBottom: 6 }}>
                <option value="auto" style={{ background: "#0b1118" }}>Auto — Demand book</option>
                <option value="manual" style={{ background: "#0b1118" }}>Manual override</option>
              </select>
              {trainShareMode === "manual" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="range" min={0} max={100} step={1} value={trainShareOverride} onChange={e => setTrainShareOverride(Number(e.target.value))} style={{ flex: 1, accentColor: VIO, height: 3 }} />
                  <span style={{ fontSize: 11, color: VIO, fontFamily: F, fontWeight: 600, minWidth: 34, textAlign: "right" }}>{trainShareOverride}%</span>
                </div>
              ) : (
                speedupDerivation && (
                  <div style={{ fontSize: 11, color: VIO, fontFamily: F }}>w_t = <b>{(speedupDerivation.autoTrainShare * 100).toFixed(0)}%</b> · w_d = <b>{((1 - speedupDerivation.autoTrainShare) * 100).toFixed(0)}%</b></div>
                )
              )}
            </div>
            {/* ── Picker 2: σ_∞ source ─────────────────────────────────── */}
            <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: F }}>σ_∞ source</div>
              <select value={sigmaMode} onChange={e => setSigmaMode(e.target.value)}
                style={{ width: "100%", padding: "5px 6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#e2e8f0", fontFamily: F, fontSize: 11, marginBottom: 6 }}>
                <option value="derived" style={{ background: "#0b1118" }}>Derived — FLOPs/BW</option>
                <option value="manual" style={{ background: "#0b1118" }}>Manual override</option>
              </select>
              {sigmaMode === "manual" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="range" min={1.0} max={6.0} step={0.05} value={sigmaManual} onChange={e => setSigmaManual(Number(e.target.value))} style={{ flex: 1, accentColor: VIO, height: 3 }} />
                  <span style={{ fontSize: 11, color: VIO, fontFamily: F, fontWeight: 600, minWidth: 40, textAlign: "right" }}>{sigmaManual.toFixed(2)}×</span>
                </div>
              ) : (
                speedupDerivation && (
                  <div style={{ fontSize: 11, color: VIO, fontFamily: F }}>σ_∞ = <b>{speedupDerivation.sigmaBlend.toFixed(2)}×</b></div>
                )
              )}
            </div>
            {/* ── Derivation cells (σ_train, σ_decode, blend) ──────────── */}
            {speedupDerivation && (
              <>
                <div style={{ background: "rgba(196,181,253,0.05)", border: "1px solid rgba(196,181,253,0.18)", borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: F }}>σ_train (FLOPs @ {speedupDerivation.effPrec.toUpperCase()})</div>
                  <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.6)", fontFamily: F, lineHeight: 1.5 }}>
                    <span style={{ color: GRW }}>{fmtBigNum(speedupDerivation.tflopsNxt)}</span> <span style={{ color: MUT }}>(next-gen)</span><br />
                    <span style={{ color: MUT }}>÷ </span><span style={{ color: AMB }}>{fmtBigNum(speedupDerivation.tflopsCur)}</span> <span style={{ color: MUT }}>(current-gen)</span>
                  </div>
                  <div style={{ fontSize: 14, color: GRW, fontFamily: F, fontWeight: 700, marginTop: 4 }}>= {speedupDerivation.sigmaTrain.toFixed(2)}×</div>
                </div>
                <div style={{ background: "rgba(196,181,253,0.05)", border: "1px solid rgba(196,181,253,0.18)", borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: F }}>σ_decode (HBM BW)</div>
                  <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.6)", fontFamily: F, lineHeight: 1.5 }}>
                    <span style={{ color: CYAN }}>{speedupDerivation.nxt.bw}</span> <span style={{ color: MUT }}>(next-gen)</span><br />
                    <span style={{ color: MUT }}>÷ </span><span style={{ color: AMB }}>{speedupDerivation.cur.bw}</span> <span style={{ color: MUT }}>(current-gen)</span>
                  </div>
                  <div style={{ fontSize: 14, color: CYAN, fontFamily: F, fontWeight: 700, marginTop: 4 }}>= {speedupDerivation.sigmaDecode.toFixed(2)}×</div>
                </div>
                <div style={{ background: "rgba(196,181,253,0.05)", border: "1px solid rgba(196,181,253,0.18)", borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: MUT, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4, fontFamily: F }}>Blend (w_t={(speedupDerivation.wTrain * 100).toFixed(0)}%)</div>
                  <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.6)", fontFamily: F, lineHeight: 1.5 }}>
                    {sigmaMode === "manual"
                      ? <span style={{ color: RO }}>overridden manually</span>
                      : <>weighted avg of σ_train &amp; σ_decode</>}
                  </div>
                  <div style={{ fontSize: 14, color: VIO, fontFamily: F, fontWeight: 700, marginTop: 4 }}>σ_∞ = {(sigmaMode === "manual" ? sigmaManual : speedupDerivation.sigmaBlend).toFixed(2)}×</div>
                </div>
              </>
            )}
          </div>
          {speedupDerivation && (
            <div style={{ fontSize: 9.5, color: MUT, lineHeight: 1.5 }}>
              σ_train and σ_decode both divide <b style={{ color: GRW }}>next-gen</b> capability by <b style={{ color: AMB }}>current-gen</b> capability — a ratio &gt; 1 means the next-gen chip ({speedupDerivation.nxt.label}) is faster than the current-gen chip ({speedupDerivation.cur.label}) on that dimension. Training uses FLOPs at <b style={{ color: VIO }}>{speedupDerivation.effPrec.toUpperCase()}</b> (highest precision both chips natively support); decode uses HBM bandwidth. σ_∞ blends the two at your training/decode share.
            </div>
          )}
        </Sec>

        <H title="Derivation — how the equations were built" />
        <Sec title={`${steps.length} steps from primitives to the practical inverted form`}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginBottom: 14 }}>
            <button type="button" onClick={(e) => { e.preventDefault(); setExpandedSteps(new Set(steps.map((_, i) => i))); }} style={{ background: "rgba(196,181,253,0.08)", border: "1px solid rgba(196,181,253,0.25)", color: VIO, borderRadius: 4, padding: "5px 10px", fontSize: 10, fontFamily: F, fontWeight: 600, cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase" }}>Expand all</button>
            <button type="button" onClick={(e) => { e.preventDefault(); setExpandedSteps(new Set()); }} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", color: MUT2, borderRadius: 4, padding: "5px 10px", fontSize: 10, fontFamily: F, fontWeight: 600, cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase" }}>Collapse all</button>
          </div>
          {steps.map((s, i) => {
            const open = expandedSteps.has(i);
            const toggle = (e) => {
              // preventDefault + explicit type="button" defuses any form-submit
              // fallback behavior; the wrapper's overflow-anchor:none stops the
              // browser from grabbing the newly-visible body as a scroll anchor
              // (which is what caused the scroll to jump on expand/collapse).
              e.preventDefault();
              const next = new Set(expandedSteps);
              if (open) next.delete(i); else next.add(i);
              setExpandedSteps(next);
            };
            return (
              <div key={i} style={{ marginBottom: 10, borderBottom: i < steps.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none", paddingBottom: open ? 18 : 10, overflowAnchor: "none" }}>
                <button type="button" onClick={toggle} style={{
                  width: "100%", background: "none", border: "none", cursor: "pointer",
                  padding: "8px 0", display: "flex", alignItems: "baseline", gap: 12,
                  color: "#e2e8f0", fontFamily: F, textAlign: "left", outline: "none",
                }}>
                  <span style={{ color: VIO, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", minWidth: 62 }}>STEP {String(i + 1).padStart(2, "0")}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "#e2e8f0", letterSpacing: "-0.01em", flex: 1 }}>{s.title}</span>
                  <span style={{ color: MUT, fontSize: 15, minWidth: 14, textAlign: "center" }}>{open ? "−" : "+"}</span>
                </button>
                {open && (
                  <div style={{ paddingLeft: 74, marginTop: 4, fontSize: 12, lineHeight: 1.65, color: "rgba(255,255,255,0.78)", display: "flex", flexDirection: "column", gap: 8, overflowAnchor: "none" }}>
                    {s.body}
                  </div>
                )}
              </div>
            );
          })}
        </Sec>

        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.22)", marginTop: 20, fontFamily: F, lineHeight: 1.55 }}>
          Model notes: single discount rate r (real rate cards charge different r's per term — the term-uplift input is the compact proxy for this). Continuous exponential decay approximates a step-wise vendor rate card. σ is assumed constant across workloads (in reality it's precision- and workload-dependent — FP4 inference on B200 ≫ FP16 matched precision). Utilization u drops out of comparisons under the (defensible) assumption that it's the same on both generations. n is integer-valued because vendor terms come in year buckets; the marginal rule looks one step in either direction from the enumerated optimum.
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Q&A TAB — OpenRouter-backed chat that can read and edit any editable
// dashboard parameter through a small tool-call surface. The LLM never
// touches the engines directly; every mutation flows through the module-level
// stores below. A snapshot captured at module load drives "Reset defaults".
// ═════════════════════════════════════════════════════════════════════════════
const QA_CLONE = (v) => JSON.parse(JSON.stringify(v));

const QA_DEFAULTS = {
  supply: QA_CLONE(SUPPLY_STORE.get()),
  demand: QA_CLONE(DEMAND_STORE.get()),
  baseline: QA_CLONE(BASELINE_STORE.get()),
  modelMix: QA_CLONE(MODEL_MIX_STORE.get()),
  cohorts: QA_CLONE(COHORT_STORE.get()),
  scenarioCohorts: QA_CLONE(SCENARIO_COHORTS),
  demandScenario: DEMAND_SCENARIO_STORE.get(),
  scenarioProb: { ...SCENARIO_PROB_STORE.get() },
  pricing: { ...PRICING_STORE.get() },
  policy: { ...POLICY_STORE.get() },
  tokPerHr: TOKPERHR_STORE.get(),
};

function qaResetDefaults() {
  SUPPLY_STORE.set(QA_CLONE(QA_DEFAULTS.supply));
  DEMAND_STORE.set(QA_CLONE(QA_DEFAULTS.demand));
  BASELINE_STORE.set(QA_CLONE(QA_DEFAULTS.baseline));
  MODEL_MIX_STORE.set(QA_CLONE(QA_DEFAULTS.modelMix));
  Object.keys(SCENARIO_COHORTS).forEach(k => { SCENARIO_COHORTS[k] = QA_CLONE(QA_DEFAULTS.scenarioCohorts[k]); });
  DEMAND_SCENARIO_STORE.set(QA_DEFAULTS.demandScenario);
  // Reload the active scenario's cohort data so COHORT_STORE stays in sync.
  COHORT_STORE.set(QA_CLONE(QA_DEFAULTS.scenarioCohorts[QA_DEFAULTS.demandScenario]));
  SCENARIO_PROB_STORE.set({ ...QA_DEFAULTS.scenarioProb });
  PRICING_STORE.set({ ...QA_DEFAULTS.pricing });
  POLICY_STORE.set({ ...QA_DEFAULTS.policy });
  TOKPERHR_STORE.set(QA_DEFAULTS.tokPerHr);
}

function qaGetState() {
  return {
    pricing: PRICING_STORE.get(),
    policy: POLICY_STORE.get(),
    tokPerHr: TOKPERHR_STORE.get(),
    demandScenario: DEMAND_SCENARIO_STORE.get(),
    scenarioProb: SCENARIO_PROB_STORE.get(),
    modelMix: MODEL_MIX_STORE.get(),
    baseline: BASELINE_STORE.get(),
    cohorts: COHORT_STORE.get(),
    supply: SUPPLY_STORE.get(),
    demand: DEMAND_STORE.get(),
  };
}

const QA_STORE_MAP = {
  pricing: PRICING_STORE, policy: POLICY_STORE, tokPerHr: TOKPERHR_STORE,
  demandScenario: DEMAND_SCENARIO_STORE, scenarioProb: SCENARIO_PROB_STORE,
  modelMix: MODEL_MIX_STORE, baseline: BASELINE_STORE, cohorts: COHORT_STORE,
  supply: SUPPLY_STORE, demand: DEMAND_STORE,
};

// Parse "pricing.trainPrice" / "supply[id=15].rate" / "baseline.train[3].modelB"
// into a segment list. `[k=v]` selects an array item by field equality; `[N]`
// selects by numeric index.
function qaParsePath(path) {
  const segs = [];
  let i = 0;
  while (i < path.length) {
    let seg = "";
    while (i < path.length && path[i] !== "." && path[i] !== "[") { seg += path[i]; i++; }
    if (seg) segs.push({ kind: "field", key: seg });
    if (path[i] === ".") { i++; continue; }
    if (path[i] === "[") {
      i++;
      let inside = "";
      while (i < path.length && path[i] !== "]") { inside += path[i]; i++; }
      if (path[i] === "]") i++;
      if (path[i] === ".") i++;
      const eq = inside.indexOf("=");
      if (eq >= 0) segs.push({ kind: "match", key: inside.slice(0, eq), value: inside.slice(eq + 1) });
      else segs.push({ kind: "index", idx: Number(inside) });
    }
  }
  return segs;
}

function qaWalk(root, segs) {
  let cur = root, parent = null, key = null;
  for (const s of segs) {
    parent = cur;
    if (s.kind === "field") { key = s.key; cur = cur == null ? undefined : cur[key]; }
    else if (s.kind === "index") { key = s.idx; cur = cur == null ? undefined : cur[key]; }
    else {
      if (!Array.isArray(cur)) throw new Error("selector on non-array: [" + s.key + "=" + s.value + "]");
      const idx = cur.findIndex(x => String(x[s.key]) === String(s.value));
      if (idx < 0) throw new Error("no match for [" + s.key + "=" + s.value + "]");
      key = idx; cur = cur[idx];
    }
  }
  return { parent, key, value: cur };
}

// Scenario switches must go through the same stash-and-swap the tabs use, or
// the tabs will show cohorts that no longer match the selected scenario.
function qaSetScenario(next) {
  const prev = DEMAND_SCENARIO_STORE.get();
  if (prev === next) return;
  if (!SCENARIO_COHORTS[next]) throw new Error("unknown scenario: " + next);
  SCENARIO_COHORTS[prev] = COHORT_STORE.get();
  DEMAND_SCENARIO_STORE.set(next);
  COHORT_STORE.set(SCENARIO_COHORTS[next]);
}

function qaApplyPatches(patches) {
  const out = [];
  for (const p of patches || []) {
    try {
      const segs = qaParsePath(p.path || "");
      if (!segs.length) throw new Error("empty path");
      const rootKey = segs[0].key;
      const store = QA_STORE_MAP[rootKey];
      if (!store) throw new Error("unknown root: " + rootKey);
      const before = store.get();
      if (segs.length === 1) {
        if (rootKey === "demandScenario") qaSetScenario(p.value);
        else store.set(p.value);
        out.push({ path: p.path, ok: true, from: before, to: p.value });
        continue;
      }
      const isObj = before !== null && typeof before === "object";
      const clone = isObj ? QA_CLONE(before) : before;
      const { parent, key, value: from } = qaWalk(clone, segs.slice(1));
      if (parent == null) throw new Error("path did not resolve");
      parent[key] = p.value;
      store.set(clone);
      out.push({ path: p.path, ok: true, from, to: p.value });
    } catch (e) {
      out.push({ path: p.path, ok: false, error: String(e.message || e) });
    }
  }
  return out;
}

function qaAddItem(collection, item) {
  const store = QA_STORE_MAP[collection];
  if (!store) throw new Error("unknown collection: " + collection);
  const cur = store.get();
  if (!Array.isArray(cur)) throw new Error(collection + " is not an array");
  const nextId = cur.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) + 1;
  const withId = { id: nextId, ...item };
  store.set([...cur, withId]);
  return withId;
}

function qaRemoveItem(collection, id) {
  const store = QA_STORE_MAP[collection];
  if (!store) throw new Error("unknown collection: " + collection);
  const cur = store.get();
  if (!Array.isArray(cur)) throw new Error(collection + " is not an array");
  const filtered = cur.filter(x => String(x.id) !== String(id));
  if (filtered.length === cur.length) throw new Error("no item with id=" + id);
  store.set(filtered);
  return { removed: id, remaining: filtered.length };
}

const QA_TOOLS = [
  { type: "function", function: {
    name: "get_state",
    description: "Return the full current state of every editable dashboard parameter as JSON. Call this before proposing edits so you're working from current values.",
    parameters: { type: "object", properties: {}, required: [] },
  }},
  { type: "function", function: {
    name: "update_state",
    description: "Apply one or more parameter updates. Each patch is { path, value }. Paths use dotted notation with [key=value] selectors for arrays. Examples: 'pricing.trainPrice', 'supply[id=15].rate', 'cohorts[id=1].regions[region=US-East].custBase', 'modelMix[id=5].pct', 'baseline.train[3].modelB'. Only edit existing fields — do not invent new ones.",
    parameters: {
      type: "object",
      properties: {
        patches: {
          type: "array",
          items: { type: "object", properties: { path: { type: "string" }, value: {} }, required: ["path", "value"] },
        },
      },
      required: ["patches"],
    },
  }},
  { type: "function", function: {
    name: "add_item",
    description: "Append a new item to one of the array-shaped collections: supply, demand, or modelMix. An id is auto-assigned. Provide the full item body — see get_state for the shape of existing items.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", enum: ["supply", "demand", "modelMix"] },
        item: { type: "object" },
      },
      required: ["collection", "item"],
    },
  }},
  { type: "function", function: {
    name: "remove_item",
    description: "Remove an item by id from supply, demand, or modelMix.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", enum: ["supply", "demand", "modelMix"] },
        id: { type: ["number", "string"] },
      },
      required: ["collection", "id"],
    },
  }},
];

const QA_SYSTEM = `You are the Q&A assistant embedded in a compute-management dashboard. The dashboard tracks GPU supply deals, customer demand forecasts, pricing, workload baselines, and a temporal upgrade-timing model. Your job is to answer the user's question and, when appropriate, use the provided tools to READ current parameter state and PROPOSE / APPLY parameter edits.

Rules:
- You may only edit parameters through the tools. You cannot change how the dashboard computes anything, add new fields, or refactor structures.
- Always call get_state before proposing a set of edits so you're working from current values, not assumptions.
- When the user speaks in general terms ("make demand more aggressive", "reflect a 15% price cut", "add a Rubin R100 line at $6/hr"), translate that into concrete numeric patches and show what you changed and why.
- If the user attaches a spec sheet or vendor doc, compare it to what's already in the dashboard (via get_state) and describe the deltas. Only apply edits if the user asks you to.
- Keep replies concise. When you make edits, summarize them as a short bulleted list of "old → new".

Parameter surface (top-level keys, all accessible via get_state / update_state):
- pricing: { trainPrice, infPrice, refTrainPrice, refInfPrice, elastTrain, elastInf } — $/H100e-hr sell prices, reference prices for elasticity anchoring, and elasticities.
- policy: { priceDecline, costDecline, genMo, genAdv, renewPct, renewTerm } — %/yr price/cost trajectory, next-gen cadence & advance %, and renewal share/term.
- tokPerHr: scalar — inference tokens per H100e-hr throughput assumption.
- demandScenario: "weak" | "base" | "strong" — which scenario is active. Editing this stashes the current cohort edits and swaps in the target scenario's cohorts (same behavior as the tab's toggle).
- scenarioProb: { weak, base, strong } — prior probabilities in percent; should sum to 100.
- modelMix: array of { id, name, pct, paramsB, activeB } — LLM mix served on the inference pool.
- baseline: { train: [{ modelB, tokensT, days, mfu, modelBG, tokensTG }...], inf: [{ modelB, bytes, inTok, outTok, effPct, modelBG, inTokG, outTokG }...] } — 24-month workload baseline drivers with monthly growth companions.
- cohorts: array of { id, name, regions: [{ id, region, custBase, months: [{ addsPct, churnPct }...], infPerCust, runsPerYr, runSize, runDurMo, infFlexPct, trainFlexPct }] } — bottoms-up customer demand build for the ACTIVE scenario.
- supply: array of supply deals — see get_state for shape (provider, gpu, gpus, structure, rate, termMo, remMo, upfrontPct, pay, region, ic, soldPct, rampMo, status).
- demand: array of demand positions — see get_state for shape (name, kind, gpu, gpus, fabric, startMo, durationMo, price, status, region, model).

Vendor-spec table and the temporal model's inputs are read-only from your side (not in the parameter surface). If the user asks about vendor SKUs or the temporal analysis, reason from the attached documents and get_state, and tell the user those specific tabs aren't editable via chat.`;

function qaBtn(color) {
  return {
    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)",
    color, padding: "7px 12px", borderRadius: 4,
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace",
    fontSize: 11, cursor: "pointer", letterSpacing: "0.02em", whiteSpace: "nowrap",
  };
}

function QAMessage({ m }) {
  const F = "'IBM Plex Mono', 'JetBrains Mono', monospace";
  const CYAN = "#67e8f9", GRW = "#86efac", AMB = "#fbbf24", VIO = "#c4b5fd";
  const MUT = "rgba(255,255,255,0.35)", MUT2 = "rgba(255,255,255,0.55)";
  if (m.role === "user") {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 3 }}>You</div>
        <div style={{ background: "rgba(103,232,249,0.06)", border: "1px solid rgba(103,232,249,0.2)", borderRadius: 4, padding: "8px 12px", fontSize: 12, color: "#e2e8f0", whiteSpace: "pre-wrap", fontFamily: F, lineHeight: 1.55 }}>
          {m.display || m.content}
          {m.attachments && m.attachments.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 10, color: MUT2 }}>
              + attached: {m.attachments.map(a => a.name).join(", ")}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 3 }}>Assistant</div>
        {m.content && (
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, padding: "8px 12px", fontSize: 12, color: "#e2e8f0", whiteSpace: "pre-wrap", fontFamily: F, lineHeight: 1.55 }}>
            {m.content}
          </div>
        )}
        {m.tool_calls && m.tool_calls.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {m.tool_calls.map((tc, i) => {
              const args = (tc.function && tc.function.arguments) || "";
              const shown = args.length > 240 ? args.slice(0, 240) + "…" : args;
              return (
                <div key={i} style={{ fontSize: 10, color: VIO, fontFamily: F, marginTop: 2 }}>
                  → tool call: <span style={{ color: MUT2 }}>{tc.function && tc.function.name}({shown})</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
  if (m.role === "tool") {
    const raw = m.content || "";
    const shown = raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
    return (
      <div style={{ marginBottom: 8, fontSize: 10, color: GRW, fontFamily: F }}>
        ← tool result <span style={{ color: MUT2 }}>({m.name}):</span>{" "}
        <span style={{ color: MUT2 }}>{shown}</span>
      </div>
    );
  }
  if (m.role === "system-note") {
    return (
      <div style={{ marginBottom: 8, fontSize: 10, color: AMB, fontFamily: F, letterSpacing: "0.05em" }}>
        [ {m.content} ]
      </div>
    );
  }
  return null;
}

function QAApp() {
  const F = TAB_F;
  const CYAN = "#67e8f9", GRW = "#86efac", AMB = "#fbbf24", RO = "#f87171";
  const MUT = "rgba(255,255,255,0.35)", MUT2 = "rgba(255,255,255,0.55)";

  const [apiKey, setApiKey] = React.useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem("qa.apiKey") || "" : ""));
  const [model, setModel] = React.useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem("qa.model") || "anthropic/claude-sonnet-4.5" : "anthropic/claude-sonnet-4.5"));
  const [showKey, setShowKey] = React.useState(false);
  const [messages, setMessages] = React.useState([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [attachments, setAttachments] = React.useState([]);
  const scrollRef = React.useRef(null);

  React.useEffect(() => { if (typeof localStorage !== "undefined") localStorage.setItem("qa.apiKey", apiKey); }, [apiKey]);
  React.useEffect(() => { if (typeof localStorage !== "undefined") localStorage.setItem("qa.model", model); }, [model]);
  React.useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, busy]);

  const handleAttach = async (files) => {
    const arr = Array.from(files || []);
    const next = [];
    for (const f of arr) {
      try {
        const text = await f.text();
        next.push({ name: f.name, size: f.size, type: f.type || "text/plain", text: text.slice(0, 200000) });
      } catch (e) {
        next.push({ name: f.name, size: f.size, type: f.type || "unknown", text: "[unable to read as text: " + (e.message || e) + "]" });
      }
    }
    setAttachments(a => [...a, ...next]);
  };

  const runTool = (name, args) => {
    try {
      if (name === "get_state") return JSON.stringify(qaGetState());
      if (name === "update_state") return JSON.stringify(qaApplyPatches(args.patches || []));
      if (name === "add_item") return JSON.stringify(qaAddItem(args.collection, args.item));
      if (name === "remove_item") return JSON.stringify(qaRemoveItem(args.collection, args.id));
      return JSON.stringify({ error: "unknown tool: " + name });
    } catch (e) {
      return JSON.stringify({ error: String(e.message || e) });
    }
  };

  const callOpenRouter = async (chatMsgs) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "HTTP-Referer": (typeof window !== "undefined" ? window.location.origin : ""),
        "X-Title": "Compute Management Dashboard Q&A",
      },
      body: JSON.stringify({ model, messages: chatMsgs, tools: QA_TOOLS, tool_choice: "auto" }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error("OpenRouter " + res.status + ": " + t.slice(0, 400));
    }
    return await res.json();
  };

  const send = async () => {
    if (!apiKey.trim()) { setError("Enter your OpenRouter API key first."); return; }
    if (!input.trim() && attachments.length === 0) return;
    setError("");
    setBusy(true);
    let userContent = input.trim();
    if (attachments.length) {
      const attStr = attachments.map(a => "── attachment: " + a.name + " (" + a.type + ", " + a.size + " bytes) ──\n" + a.text).join("\n\n");
      userContent = (userContent ? userContent + "\n\n" : "") + attStr;
    }
    const userMsg = { role: "user", content: userContent, display: input.trim(), attachments: attachments.map(a => ({ name: a.name, size: a.size })) };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setAttachments([]);
    try {
      let apiMsgs = [{ role: "system", content: QA_SYSTEM }, ...nextMessages.map(m => {
        const { display, attachments, ...rest } = m;
        return rest;
      })];
      for (let turn = 0; turn < 8; turn++) {
        const resp = await callOpenRouter(apiMsgs);
        const choice = resp.choices && resp.choices[0];
        if (!choice) throw new Error("empty response");
        const asst = choice.message || {};
        const asstStored = { role: "assistant", content: asst.content || "", tool_calls: asst.tool_calls || undefined };
        apiMsgs.push(asstStored);
        setMessages(m => [...m, asstStored]);
        if (!asst.tool_calls || !asst.tool_calls.length) break;
        for (const tc of asst.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { args = { _parse_error: String(e.message || e) }; }
          const result = runTool(tc.function.name, args);
          const toolMsg = { role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result };
          apiMsgs.push(toolMsg);
          setMessages(m => [...m, toolMsg]);
        }
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const clearChat = () => { setMessages([]); setError(""); };
  const resetDefaults = () => {
    if (typeof window !== "undefined" && !window.confirm("Reset all dashboard parameters to defaults? This undoes every edit, including anything the LLM has changed.")) return;
    qaResetDefaults();
    setMessages(m => [...m, { role: "system-note", content: "Dashboard parameters reset to defaults." }]);
  };

  return (
    <div style={{ padding: "24px 28px 60px", color: "#e2e8f0", fontFamily: F, minHeight: "100vh" }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Q&A <span style={{ color: AMB }}>— ask the LLM to tweak parameters</span></div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 3, lineHeight: 1.5, maxWidth: 900 }}>
          Ask questions about the dashboard's parameters, or describe changes in plain English ("bump the training price 15%", "add a Rubin R100 reservation at $6/hr", "make the weak scenario weaker"). The LLM can read and edit any parameter through a tool-call API — it cannot change how the dashboard computes anything. Attach spec sheets or vendor docs as plain text (.txt / .md / .csv / .json / .tsv) to compare them against what's in the model.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1.4fr auto auto", gap: 10, alignItems: "end", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>OpenRouter API key</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-or-v1-…"
              style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "7px 10px", color: "#e2e8f0", fontFamily: F, fontSize: 12 }}
            />
            <button onClick={() => setShowKey(s => !s)} style={qaBtn(MUT2)}>{showKey ? "hide" : "show"}</button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: MUT, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Model (OpenRouter id)</div>
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="anthropic/claude-sonnet-4.5"
            style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "7px 10px", color: "#e2e8f0", fontFamily: F, fontSize: 12 }}
          />
        </div>
        <button onClick={clearChat} style={qaBtn(MUT2)}>Clear chat</button>
        <button onClick={resetDefaults} title="Restore all editable parameters to the values that were loaded when the dashboard first opened." style={{ ...qaBtn(AMB), fontWeight: 600 }}>Reset defaults</button>
      </div>

      <div ref={scrollRef} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: 14, minHeight: 400, maxHeight: 560, overflowY: "auto", marginBottom: 12 }}>
        {messages.length === 0 && (
          <div style={{ color: MUT, fontSize: 12, lineHeight: 1.7 }}>
            Ready. Try something like:<br />
            <span style={{ color: MUT2 }}>• "What's the current supply book weighted-average rate?"</span><br />
            <span style={{ color: MUT2 }}>• "Attach this Rubin R100 spec sheet — how does it fit relative to the B300 I already have?"</span><br />
            <span style={{ color: MUT2 }}>• "Switch to the strong demand scenario and drop training elasticity to 1.0."</span><br />
            <span style={{ color: MUT2 }}>• "Assume enterprise adds are 50% higher — update the base scenario cohorts."</span>
          </div>
        )}
        {messages.map((m, i) => <QAMessage key={i} m={m} />)}
        {busy && <div style={{ color: MUT, fontSize: 11, marginTop: 8 }}>… waiting on model …</div>}
        {error && <div style={{ color: RO, fontSize: 11, marginTop: 8, background: "rgba(248,113,113,0.08)", padding: "6px 10px", borderRadius: 4 }}>{error}</div>}
      </div>

      {attachments.length > 0 && (
        <div style={{ marginBottom: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {attachments.map((a, i) => (
            <div key={i} style={{ background: "rgba(103,232,249,0.08)", border: "1px solid rgba(103,232,249,0.25)", borderRadius: 4, padding: "4px 8px", fontSize: 11, color: CYAN, display: "flex", alignItems: "center", gap: 8 }}>
              <span>{a.name}</span>
              <span style={{ color: MUT }}>{(a.size / 1024).toFixed(1)} KB</span>
              <button onClick={() => setAttachments(l => l.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: MUT2, cursor: "pointer", padding: 0, fontFamily: F, fontSize: 13, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label style={{ ...qaBtn(MUT2), cursor: "pointer", display: "inline-block" }}>
          + attach
          <input type="file" multiple style={{ display: "none" }} onChange={e => { handleAttach(e.target.files); e.target.value = ""; }} accept=".txt,.md,.csv,.json,.tsv,.log,text/*" />
        </label>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
          placeholder="Ask a question or describe a change… (Ctrl/Cmd+Enter to send)"
          rows={3}
          disabled={busy}
          style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "8px 10px", color: "#e2e8f0", fontFamily: F, fontSize: 12, resize: "vertical" }}
        />
        <button onClick={send} disabled={busy} style={{ ...qaBtn(CYAN), fontWeight: 700 }}>{busy ? "…" : "Send"}</button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SUPPLY CHAIN BOTTLENECKS — aggregate compute-supply outlook.
//   Wraps the semiconductor-tree-diagram-v16.html (self-contained interactive
//   diagram of the full semiconductor stack, with bottleneck nodes highlighted
//   in red) as an iframe. Sourced from public/ so Vite dev + Vercel build both
//   serve it at /semiconductor-tree-diagram-v16.html.
//
//   Purpose: the Compute Supply tab tracks OUR book; this tab zooms out to the
//   MARKET. If the chokes are structural (CoWoS packaging, HBM allocation,
//   advanced-node wafer supply, grid interconnect), aggregate GPU supply stays
//   tight and rental prices keep climbing — lock in reserved capacity now. If
//   they're loosening, be patient and let spot soften before committing to
//   take-or-pay.
// ═════════════════════════════════════════════════════════════════════════════
function BottlenecksApp() {
  const F = TAB_F;
  const AMB = "#fbbf24";
  return (
    <div style={{ background: "#0b1118", color: "#e2e8f0", minHeight: "calc(100vh - 60px)", padding: "18px 20px 40px", fontFamily: F }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Supply Chain Bottlenecks <span style={{ color: AMB }}>— aggregate compute-supply outlook</span>
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 3, lineHeight: 1.6, maxWidth: 1050 }}>
            Zooms out from <em>our</em> book (Compute Supply) to <em>market</em> supply. Structural + multi-year → <b style={{ color: "#e2e8f0" }}>lock reserved capacity now</b>. Loosening → <b style={{ color: "#e2e8f0" }}>be patient</b> before committing take-or-pay.
          </div>
        </div>

        {/* Bottleneck monitor — the 5 pacing chokepoints, read through the leading supplier's financial signals */}
        {(() => {
          const RED = "#f87171", AMBER = "#fbbf24", GREEN = "#6ee7b7";
          const statusColor = { CRITICAL: RED, TIGHT: AMBER, EASING: GREEN, STRUCTURAL: RED };
          const thS = (align = "right") => ({ padding: "5px 8px", textAlign: align, color: "rgba(255,255,255,0.35)", borderBottom: "1px solid rgba(255,255,255,0.08)", fontSize: 9, fontWeight: 600, letterSpacing: "0.04em" });
          const tdS = (extra = {}) => ({ padding: "6px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", ...extra });
          // Numbers below are revenue-weighted averages (rev growth, op margin)
          // and sums (capex) across the listed companies for each segment.
          // LTM = trailing 12 months from most recent filings; NTM = next 12
          // months implied by segment guidance. Refresh quarterly.
          const nodes = [
            { node: "Memory (HBM)",         who: "SK Hynix · Samsung · Micron",   revG: "+40% → +28%", opM: "32% → 30%", capex: "$53B → $60B",  status: "CRITICAL",   ease: "H2 2027" },
            { node: "Advanced packaging",   who: "TSMC · Amkor · ASE",            revG: "+30% → +25%", opM: "42% → 43%", capex: "$45B → $52B",  status: "CRITICAL",   ease: "H1 2027" },
            { node: "Leading-edge foundry", who: "TSMC · Samsung",                revG: "+30% → +25%", opM: "40% → 42%", capex: "$52B → $58B",  status: "TIGHT",      ease: "2027" },
            { node: "Substrates",           who: "Ibiden · Unimicron · Shinko",   revG: "flat → +10%", opM: "12% → 15%", capex: "$1B → $1B",    status: "EASING",     ease: "already moderating" },
            { node: "DC power & grid",      who: "NextEra · Duke · Iberdrola · SSE", revG: "+7% → +8%", opM: "20% → 20%", capex: "$44B → $50B", status: "STRUCTURAL", ease: "not before 2029" },
          ];
          return (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 8, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Bottleneck monitor <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 500 }}>— the 5 pacing chokepoints, read through the leader's financials</span>
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>Snapshot Jul 2026 · refresh quarterly from earnings</div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: F }}>
                <thead><tr>
                  <th style={thS("left")}>NODE</th>
                  <th style={thS("left")}>KEY COMPANIES</th>
                  <th style={thS()} title="revenue-weighted average YoY revenue growth across listed companies: LTM (actual) → NTM (implied by segment guidance)">REV GROWTH (LTM → NTM)</th>
                  <th style={thS()} title="revenue-weighted average operating margin across listed companies: LTM (actual) → NTM (implied by segment guidance). High margin holding or rising = pricing power intact.">OP MARGIN (LTM → NTM)</th>
                  <th style={thS()} title="SUM of annual capex across listed companies: LTM (actual) → NTM (guided). Ramping capex = capacity coming; flat or falling = the segment is done building.">CAPEX (LTM → NTM)</th>
                  <th style={thS("left")}>STATUS</th>
                  <th style={thS("left")}>MEANINGFUL EASING</th>
                </tr></thead>
                <tbody>
                  {nodes.map(n => (
                    <tr key={n.node}>
                      <td style={tdS({ color: "#e2e8f0", fontWeight: 600 })}>{n.node}</td>
                      <td style={tdS({ color: "rgba(255,255,255,0.55)", fontSize: 10 })}>{n.who}</td>
                      <td style={tdS({ textAlign: "right", color: "rgba(255,255,255,0.7)", fontSize: 10 })}>{n.revG}</td>
                      <td style={tdS({ textAlign: "right", color: "rgba(255,255,255,0.7)", fontSize: 10 })}>{n.opM}</td>
                      <td style={tdS({ textAlign: "right", color: "rgba(255,255,255,0.7)", fontSize: 10 })}>{n.capex}</td>
                      <td style={tdS({ color: statusColor[n.status], fontWeight: 700, fontSize: 10 })}>{n.status}</td>
                      <td style={tdS({ color: "#67e8f9", fontSize: 10 })}>{n.ease}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.55)", marginTop: 10, lineHeight: 1.6, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 8 }}>
                <b style={{ color: "#e2e8f0" }}>Aggregate:</b> supply is only as tight as the weakest link — pacing constraints are <b style={{ color: RED }}>HBM + advanced packaging</b>, which start meaningfully easing H2 2027 as HBM4 volume and new CoWoS fabs (AP6, AP7) ramp. Full balance across silicon nodes closer to <b style={{ color: "#e2e8f0" }}>2028</b> when N2 wafers scale. <b style={{ color: RED }}>DC power</b> is the wildcard — utility timelines don't compress and can keep effective AI-compute supply tight into 2029+ regardless of silicon availability.
              </div>
              <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.4)", marginTop: 8, lineHeight: 1.55 }}>
                <b style={{ color: "#e2e8f0" }}>Method:</b> rev growth & op margin = rev-weighted avg across listed companies; capex = sum. LTM (actual) → NTM (segment guidance). <b style={{ color: "#e2e8f0" }}>Pattern:</b> high margin + high rev growth + still-ramping capex = undersupplied, pricing power intact; softening growth or capex pullback = constraint releasing. Utility metrics informational — grid buildout is permitting/queue-bound, not capital-bound.
              </div>
            </div>
          );
        })()}

        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 10px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#e2e8f0", fontFamily: F, textTransform: "uppercase" }}>Semiconductor Market Map</div>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
        </div>
        <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.35)", marginBottom: 10, lineHeight: 1.5, maxWidth: 1050 }}>
          Full stack around the 5 pacing nodes above. Click any node to trace suppliers (red lines up) and customers (blue lines down).
        </div>

        <iframe
          src="/semiconductor-tree-diagram-v16.html"
          title="Semiconductor Market Map"
          style={{ width: "100%", height: "82vh", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, background: "#0b1118", display: "block" }}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [side, setSide] = useState("instructions");
  const [hoveredKey, setHoveredKey] = useState(null);
  const tabs = [
    { key: "instructions", label: "INSTRUCTIONS", sub: "how to read this dashboard" },
    { key: "qa", label: "Q&A", sub: "ask the LLM to tweak parameters" },
    { key: "projections", label: "PROJECTIONS", sub: "compute outlook & financials" },
    { key: "demand", label: "COMPUTE DEMAND", sub: "demand book & run sizing" },
    { key: "supply", label: "COMPUTE SUPPLY", sub: "supply book & deal intake" },
    { key: "vendor", label: "VENDOR SPEC & CONTRACTS", sub: "compare vendor spec sheets" },
    { key: "bottlenecks", label: "SUPPLY CHAIN BOTTLENECKS", sub: "aggregate compute-supply outlook" },
    { key: "temporal", label: "FUTURE SUPPLY", sub: "old-gen vs. new-gen upgrade timing" },
  ];
  return (
    <div style={{ minHeight: "100vh", background: "#0b1118" }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 4, borderBottom: "1px solid rgba(103,232,249,0.15)", background: "#0b1118", padding: "0 20px", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", paddingRight: 20, borderRight: "1px solid rgba(255,255,255,0.05)", margin: "10px 0" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", fontFamily: TAB_F, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>Compute Management Dashboard</span>
        </div>
        {tabs.map(t => {
          const isActive = side === t.key;
          const isHovered = hoveredKey === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSide(t.key)}
              onMouseEnter={() => setHoveredKey(t.key)}
              onMouseLeave={() => setHoveredKey(null)}
              style={{
                background: isActive ? "rgba(103,232,249,0.1)" : isHovered ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                border: isActive ? "1px solid rgba(103,232,249,0.4)" : isHovered ? "1px solid rgba(255,255,255,0.18)" : "1px solid rgba(255,255,255,0.08)",
                borderBottom: isActive ? "2px solid #67e8f9" : "1px solid rgba(255,255,255,0.08)",
                cursor: "pointer",
                padding: "10px 16px 9px",
                margin: "8px 0 0",
                borderRadius: "6px 6px 0 0",
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                transition: "background 0.12s, border-color 0.12s, color 0.12s",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", fontFamily: TAB_F, color: isActive ? "#67e8f9" : isHovered ? "#f1f5f9" : "rgba(226,232,240,0.85)" }}>{t.label}</span>
              <span style={{ fontSize: 9, fontFamily: TAB_F, color: isActive ? "rgba(255,255,255,0.6)" : isHovered ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.4)" }}>{t.sub}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: side === "instructions" ? "block" : "none" }}><InstructionsApp /></div>
      <div style={{ display: side === "projections" ? "block" : "none" }}><ProjectionsApp /></div>
      <div style={{ display: side === "demand" ? "block" : "none" }}><DemandSideApp /></div>
      <div style={{ display: side === "supply" ? "block" : "none" }}><SupplySideApp /></div>
      <div style={{ display: side === "vendor" ? "block" : "none" }}><VendorSpecApp /></div>
      <div style={{ display: side === "bottlenecks" ? "block" : "none" }}><BottlenecksApp /></div>
      <div style={{ display: side === "temporal" ? "block" : "none" }}><TemporalApp /></div>
      <div style={{ display: side === "qa" ? "block" : "none" }}><QAApp /></div>
    </div>
  );
}
