# Compute Management Dashboard

[Live Demo](https://gpu-compute-management-engine.vercel.app/)

A comprehensive dashboard for managing GPU compute supply and demand. A bottom-up demand build, existing compute supply book, and vendor specs are fed into a multi-step supply procurement optimizer (Supply Filling Engine) to maximize expected profits.

## Tabs

- **Projections**
  - Summary statistics from demand and supply engines over a 24-month horizon.  Compute supply/demand and financials (revenues, COGS, free cash flow, segment-economics) are detailed across weak/base/strong scenarios.

- **Compute Demand** 
  - Detailed bottom-up 24-month demand build with weak/base/strong scenarios. Models customer-type cohorts, regions, training/inference workloads, new-logo growth, up-sell, and churn.
  - More detailed training and inference modelers consider variables like LLM parameter counts, training tokens/time, MFU, input/output tokens, and serving efficiency.
  - Incorporates demand elasticity to price-charged for training/inference.

- **Compute Supply** 
  - Keeps track of existing compute supply and provides summary statistics detailing coverage by region, provider, GPU type, contract type, model serving ability, and training/inference workload type.
  - Based on forecasted compute demand and existing compute supply, the Supply Filling Engine identifies gaps in coverage across chip, fabric, region, customer type, and workload based on a 6-part scheme.
    1. Category-by-category supply/demand mismatch analysis.
    2. Capability cascades/substitution for idle capacity.
    3. Fractile rules measuring loss-if-idle (considers salvage value of unused GPUs) and save-if-used (considers on-demand/spot ) ratios against projected demand scenarios to determine optimal type/quantity/timing of GPUs to purchase.
    4. Identify optimal vendor to source GPUs from based on individual vendor specs, pricing, and expected value.
    5. A gating/guardrail mechanism to ensure portfolio risks are contained (e.g., vendor concentration, cash prepayment limits, low-quality data center purchase limits).
    6. A final expected profit function that must be maximized given the prior constraints.


- **Vendor Spec** 
  - Sources GPU availability from different vendors, with detailed GPU type, configuration, scale-up/scale-out fabric, and pricing.  Allows for easy comparison of hardware specs.  
  - Estimates a "fair" price to pay for each GPU spec based on a sign-constrained ridge regression.
  - An 8-part vendor diligence framework is included as a reference guide when evaluating new providers.

  
