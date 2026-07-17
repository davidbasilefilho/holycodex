# Frontend audit

Use only for requested audit/regression. Establish page and device matrix. Record baseline before changes. Check console/network errors, keyboard path, focus, labels, contrast, reduced motion, mobile/narrow/wide containment, overflow, loading/error/empty states. Measure Lighthouse/Core Web Vitals in production-like build: LCP, INP, CLS. Attribute largest cost by route, component, asset, or dependency. Make one bounded fix; repeat same measurement. Report environment, before/after, remaining risk. Never claim parity or performance gain without matching evidence.

React-specific profiling: see `react-perf-tooling.md`.
