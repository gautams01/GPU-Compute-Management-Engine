# Compute Management Dashboard

[Compute Management Engine Dashboard](https://gpu-compute-management-engine.vercel.app/)

A comprehensive dashboard for managing GPU compute supply and demand. A bottom-up demand build, existing compute supply book, and vendor specs are fed into a multi-step supply procurement optimizer (Supply Filling Engine) to maximize expected profits.

## Procurement workflow

The tabs are ordered around a single end-to-end question: **how much compute should we buy, of what kind, from whom, and when?** The **Instructions** tab lays this out as a flow diagram — each step below is one link in that chain, feeding forward into the next, with the whole thing rolling up into **Projections**.

- **Instructions**
  - Landing page. Renders the procurement workflow as a numbered flow diagram (steps 01–06 → Projections), naming the tab that answers each step and the plain-English decision it tackles. Read this first for the map of how the tabs fit together.

- **Q&A**
  - Chatbot tab backed by an LLM (OpenRouter, user supplies their own API key + model). The model has read/write access to every parameter across the other tabs via tool calls — describe changes in plain English ("shift the base scenario 10% up on enterprise demand", "add a Rubin-class row to the vendor spec") and it edits the underlying store rather than the UI. Supports attachments (spec sheets, vendor PDFs pasted as text) for side-by-side comparison against existing dashboard data. It cannot alter the dashboard's mechanics — only its parameters. A **Reset defaults** button restores every store to its as-loaded snapshot.

## Analytical pipeline (Instructions steps 01–06)

- **01 — Compute Demand** *(forecast compute demand)*
  - Detailed bottom-up 24-month demand build with weak/base/strong scenarios. Models customer-type cohorts, regions, training/inference workloads, new-logo growth, up-sell, and churn.
  - More detailed training and inference modelers consider variables like LLM parameter counts, training tokens/time, MFU, input/output tokens, and serving efficiency.
  - Incorporates demand elasticity to price charged for training/inference.

- **02 — Compute Supply** *(inventory existing supply)*
  - Keeps track of existing compute supply and provides summary statistics detailing coverage by region, provider, GPU type, contract type, model serving ability, and training/inference workload type.
  - The supply-book table is fully sortable (click any column header; click again to flip direction) and now carries a **$/H100e-HR** column that normalizes the raw $/GPU-hr by each row's H100-relative FLOPs (or memory-bandwidth) ratio — so rates are directly comparable across chip generations. The normalization basis follows the FLOPs/BW toggle in the tab header.

- **03–05 — Compute Supply → Supply Filling Engine** *(identify gaps, vet the plan, optimize the buy list)*
  - Based on forecasted compute demand and existing compute supply, the Supply Filling Engine identifies gaps in coverage across chip, fabric, region, customer type, and workload based on a 6-part scheme:
    1. Category-by-category supply/demand mismatch analysis.
    2. Capability cascades / substitution for idle capacity.
    3. Fractile rules measuring loss-if-idle (considers salvage value of unused GPUs) and save-if-used (considers on-demand/spot upstream) ratios against projected demand scenarios to determine optimal type / quantity / timing of GPUs to purchase.
    4. Identify optimal vendor to source GPUs from based on individual vendor specs, pricing, and expected value.
    5. A gating / guardrail mechanism to ensure portfolio risks are contained (e.g., vendor concentration, cash prepayment limits, low-quality data-center purchase limits).
    6. A final expected profit function that must be maximized given the prior constraints.

- **04 — Vendor Spec** *(vet vendors & price hardware)*
  - Sources GPU availability from different vendors, with detailed GPU type, configuration, scale-up / scale-out fabric, and pricing. Allows for easy comparison of hardware specs.
  - Estimates a "fair" price to pay for each GPU spec based on a sign-constrained ridge regression.
  - An 8-part vendor diligence framework is included as a reference guide when evaluating new providers.

- **06 — Future Supply** *(time the generation switch)*
  - Old-gen vs. new-gen hardware upgrade-timing analyzer. Prices every "bridge N years on current-gen, then switch" strategy under a two-regime price path (scarcity inflation → post-normalization decay) with a maturity-ramped speedup, and inverts to the break-even next-gen effective price Λ*(n) that would justify each bridge length — expressed in prices you can quote today.
  - Wired live to the supply and demand books: the current-gen dropdown auto-populates P_c from the weighted-average reserved rate on that GPU, and the training/decode workload split defaults to the ratio observed in demand. σ is decomposed into σ_train (FLOPs ratio, precision-matched) and σ_decode (HBM bandwidth ratio), blended by workload mix.
  - Includes a "Portfolio blend" option that synthesizes a single current-gen spec from the entire active reserved book (GPU-month-weighted), so the question becomes "extend the mix we already hold, or switch generations?" rather than one chip at a time.
  - Bottom section is a 12-step derivation of the underlying equation from first physical primitives to the practical inverted form.

- **Σ — Projections** *(roll-up)*
  - Summary statistics from demand and supply engines over a 24-month horizon. Matched supply/demand, revenues, COGS, free cash flow, and segment economics are detailed across weak/base/strong scenarios.
