---
name: frontend
description: Use when work involves frontend, UI, UX, design, layout, animation, accessibility, performance, React, redesign, or styling; do not use for backend-only, prose, CLI, or nonvisual work. Produces approved accessible interfaces or evidence-backed findings.
---

# Frontend

Priority: user; product; accessibility, visible content, correctness, performance; then workflow.

Read `references/anti-slop.md` completely before visual work; re-read before handoff and fix failures.

## Route

- New apps, dashboards, games, creative/visually driven sites, hero sections, redesign/restyle/modernization: read `references/openai-app-builder.md` completely. It has highest priority over anti-slop, UI/UX, and frontend refs on conflict; explicit user/product/accessibility/correctness rules remain hard unless it controls the conflict.
- Audit: load perfection/React tooling as applicable; lookup only needed UI/UX data. Preserve reference identity/content unless reproduction is explicit. Nonvisual logic uses `programming` alone.
- read-only frontend audits proceed without `<design_plan>`, concept generation, design approval, goal choice, or implementation unless separately authorized; report findings/evidence only.

Never require `DESIGN.md`; follow it when present, otherwise derive the smallest approved contract.

## Approval

1. First inspect the request, product shell, target, patterns, tokens, responsiveness, references, content, and states.
2. Select only visible direction, type, layout/density, color/surfaces, assets, responsiveness, states, plus a motion system and accessibility treatment for every task.
3. Present a compact `<design_plan>` and ask for approval before implementation. Cover direction/type/layout/assets/states/motion/GSAP/reduced motion/keyboard operation/focus visibility/semantic treatment/contrast/labels/applicable loading, error, and empty states/reference boundary/QA. Routed work needs complete Image Gen concept and design approval before implementation detail; accepted concept rules control.
4. After approval, ask whether the user wants to define a goal. Load `define-goal` only after explicit agreement; otherwise implement.

Direction/interaction need approval; implementation details need no approval; ask before dependencies or remote assets.

## Fixed decisions

- Use reasoned variety; AIDA, bento, hero geometry, counts, motion, and spacing are options only when they fit product, task, and stack.
- Use authentic supplied assets; ask before remote assets. Never invent research, content, proof, controls, or capabilities.
- Preserve project typography unless redesign. Apply the source-conditional font policy below, not a universal ban: reject Fraunces + Work Sans only where it is an overused pairing; Space Grotesk + Inter only as default tech pairing; Cormorant Garamond, Bodoni Moda, Didot, Playfair only as luxury autopilot; Sora only as AI/deep-tech default; JetBrains Mono only as fake-code/house voice; Syne only as edgy default; Archivo only as sport/streetwear default; Inter only as identity/everywhere (allowed neutral body); identity-bearing trendy/free sans/grotesques Inter, Space Grotesk, Sora, Syne, Archivo, Onest, Darker Grotesk, Geologica, Hanken Grotesk, Spline Sans, Schibsted Grotesk, Gabarito, Figtree, Quicksand; novelty display Bagel Fat One, Baloo, Fredoka, Chewy, Lobster; identity-bearing serifs Fraunces, Cormorant, Bodoni, Petrona, Hedvig Letters Serif, Brygada 1918, Young Serif; house-voice monos JetBrains Mono, IBM Plex Mono, Spline Sans Mono, Fragment Mono (allow real data/code/timestamps/prices/tables); reputation-only swaps Big Shoulders, Newsreader, IBM Plex Mono, Instrument Serif, Bricolage; startup-signature defaults Clash Display, General Sans. Choose viewed, authentic, licensed, self-hosted, project-owned, system, or distinctive type when the source condition applies.
- New icons: prefer Tabler Icons, another library, Lucide, then bare SVG. Preserve existing icon system and accepted-design fidelity; authorized brands only; no emoji icons or default icon containers.
- Define purposeful motion. Use GSAP when installed or installation is permitted; otherwise existing stack or no-new-dependency motion. Ask before installation. Keep content visible, preserve meaning under `prefers-reduced-motion`, favor `transform`, `opacity`, `filter`, and use effects only for state, continuity, navigation, or explanation.
- Provide keyboard, focus, semantics, contrast, labels, and applicable states; record material debt/risk.

## Implementation and evidence

1. Inspect target/patterns/assets/states; lock roles; implement reusable slices.
2. Test containment, interaction, keyboard, states, reduced motion, and 375/768/1280 for significant work.
3. Check performance; never weaken UX for a score. Re-read anti-slop, repair, report measured evidence.
4. Run the target repository's formatter, linter, type checker, and tests, plus project-specific browser and fidelity checks.
