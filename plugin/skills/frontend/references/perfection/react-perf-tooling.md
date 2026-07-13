# React performance

Profile first. Use React Profiler for render duration/commit count and browser Performance panel for main-thread/network/layout. Find owning state and rerender fan-out. Prefer state locality, derived values, stable architecture, route/code splitting, and right-sized media. Memoize only measured expensive stable work. Avoid blanket `memo`, callback churn, effect-driven state sync, premature virtualization, and hydration suppression. Reprofile identical interaction after change.
