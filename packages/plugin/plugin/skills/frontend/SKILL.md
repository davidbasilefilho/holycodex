---
name: frontend
description: Use when work involves frontend, UI, UX, visual design, responsive layout, animation, accessibility, SEO, performance, visual QA, mockups, React, redesign, styling, taste, or polish; do not use for backend-only, prose, CLI, or nonvisual work. Produces approved accessible responsive interfaces or evidence-backed findings with anti-slop craft.
---

# Frontend

Preserve explicit direction and product contracts. Ask before an ambiguous override. Priority: user; product; accessibility, visible content, correctness, performance; then workflow.

Before visual work, read `references/anti-slop.md` completely and confirm compactly. Re-read before handoff; fix failures.

## Route

- Audit: load `references/perfection/README.md`; add `react-perf-tooling.md` for React. Scale to risk.
- Palette, type, style, chart, landing, UX, or stack lookup: load only relevant `references/ui-ux-db` data through its `README.md`.
- Visual reference: match its design language and behavior; preserve original content and identity unless exact reproduction is explicit.
- Greenfield: offer concepts only when useful.
- Browser QA: use browser control and evidence.
- Nonvisual logic: use `programming` alone.

Never require `DESIGN.md`. Follow one when present; otherwise derive the smallest contract from nearby code and approved decisions.

## Approval sequence

1. First inspect the request, product shell, target, nearby patterns, tokens, responsiveness, references, content, and states.
2. Select only visible direction, type, layout/density, color/surfaces, assets, responsiveness, states, plus a motion system and accessibility treatment for every task.
3. Present a compact `<design_plan>` and ask for approval before implementation. Cover direction, type, layout, assets, states, motion, GSAP, reduced motion, keyboard operation, focus visibility, semantic treatment, contrast, labels, applicable loading, error, and empty states, reference boundary, and QA.
4. After approval, ask whether the user wants to define a goal. Load `define-goal` only after explicit agreement; otherwise implement.

Visible direction and material interaction require approval; reversible implementation details need no approval. Ask before installing dependencies or adding remote assets.

## Fixed decisions

- Use reasoned variety, never mock RNG or fixed counts. Treat AIDA, bento, hero geometry, component counts, named motion, and spacing as options only when they fit product, task, and stack.
- Use authentic assets; ask before remote ones. Picsum requires explicit placeholder approval. Never invent research, content, proof, controls, or capabilities.
- For new type, ban every font named by the comparison sources; choose viewed, authentic, distinctive, licensed, self-hosted, project-owned, or system type. Preserve existing type unless redesign is requested.
- For new icons, prefer Tabler Icons, another library, Lucide, then bare SVGs. Preserve an existing icon system; use authorized brand marks; ban emoji icons and default icon containers.
- Use AIDA only when fitting. Use wide two- or three-line landing headings, three to five dense gapless bento cards, and strong spacing only when fitting.
- Define motion for every implementation. Use GSAP when installed or installation is permitted; otherwise use the existing stack or no-new-dependency motion. Keep essential content visible, preserve meaning under `prefers-reduced-motion`, favor `transform`, `opacity`, and `filter`, and use effects only for real state, continuity, navigation, or explanation.
- Provide keyboard operation, focus visibility, semantics, contrast, labels, and applicable states. Record material debt and unresolved risks.

## Implementation

1. Inspect target, patterns, assets, dependencies, and states; lock approved design roles.
2. Implement a coherent slice with reusable existing or approved components.
3. Test viewports, containment, interaction, keyboard, states, and reduced motion.
4. Check rendering and interaction performance; never weaken UX solely for a score.
5. Run proportional fresh browser QA. For significant work inspect 375, 768, and 1280 pixels. For performance acceptance audit production repeatedly on mobile and desktop, use medians, and fix architectural causes.
6. Re-read `references/anti-slop.md`, fix failures, and report only measured evidence.

Run `vp check --fix` after repository edits.
