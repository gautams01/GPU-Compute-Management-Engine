# Compute Management Dashboard

[Compute Management Engine Dashboard](https://gpu-compute-management-engine.vercel.app/)

## Instructions — procurement workflow

The dashboard tabs are laid out to follow one end-to-end question: **how much compute should we buy, of what kind, from whom, and when?** Each step below is one link in that chain — the flow feeds forward into the next.

---

**01 — Forecast Compute Demand**
*tab: Compute Demand*
> "How much compute will we need — and when, where, for what?"

Bottom-up 24-month build over customer cohorts, regions, and training/inference workloads. Weak/base/strong scenarios flex new-logo growth, up-sell, and churn; price elasticity feeds back into demanded volume.

▼

**02 — Inventory Existing Supply**
*tab: Compute Supply*
> "What compute do we already own or have on contract?"

Live supply book with coverage cuts by region, provider, GPU type, contract structure, model-serving ability, and workload type. Establishes the baseline the demand forecast is compared against.

▼

**03 — Identify Supply Gaps**
*tab: Compute Supply → Supply Filling Engine*
> "Where does supply fall short of demand — and by how much?"

Supply Filling Engine diffs projected demand against the existing book across chip / fabric / region / customer / workload, then surfaces the shortfall (and any idle capacity that could be re-cascaded to cover it).

▼

**04 — Vet Vendors & Price Hardware**
*tab: Vendor Spec & Contracts*
> "Who do we buy from, and what is a fair price for each GPU spec?"

Cross-check vendor catalogs (GPU type, fabric, config, price), fit a sign-constrained ridge regression for a "fair" price benchmark, and score prospective vendors against an 8-part diligence framework that highlights key negotiating points for the contract-signing process. A reference guide covers GPU hardware specs, scale-up/scale-out topologies (e.g., rail-alignment, fat-trees), parallelism strategies, and data center operator rankings.

▼

**05 — Read the Market Context**
*tab: Supply Chain Bottlenecks*
> "How long will aggregate compute supply stay constrained — buy now, or wait?"

Zooms out from our book to the full semiconductor stack (wafers → packaging → HBM → GPUs → systems → DC), tracking ~200 companies critical to the supply chain and marking the pacing chokepoints. Structural bottlenecks → lock in now; loosening → wait before signing take-or-pay.

▼

**06 — Time the Generation Switch**
*tab: Future Supply*
> "Buy long-term on current-gen now, or bridge short-term until next-gen chips land?"

Prices every "bridge n years on current-gen, then switch" strategy under a two-regime price path and maturity-ramped speedup. Inverts to the break-even next-gen unit cost that would justify each bridge length, expressed in prices you can quote today.

▼

**07 — Optimize the Purchase Plan**
*tab: Compute Supply → Supply Filling Engine*
> "Which GPUs, how many, from which vendors, at what term — under what risk limits?"

Supply Filling Engine sizes each bucket's committable capacity via the classical newsvendor model, then selects deals through a three-stage stochastic optimization with real-options structure subject to portfolio guardrails (e.g., vendor concentration, cash-prepay caps, DC-tier limits, total-spend cap). Emits a ranked buy list with quantity, vendor, term, and timing.

▼

*ROLLS UP INTO*

▼

**Σ — Projections**
*tab: Projections*
> "What does the whole plan look like in dollars?"

Summary read-out of the demand and supply engines over the 24-month horizon: matched supply/demand, revenues, COGS, free cash flow, and segment economics under weak/base/strong scenarios.
