---
name: frontend
description: Use when work involves frontend, UI, UX, visual design, layout, animation, accessibility, performance, React, redesign, or styling; do not use for backend-only, prose, CLI, or nonvisual work. Produces distinctive, accessible interfaces from an approved visual concept with verified implementation fidelity.
---

# Frontend

Act as senior product designer, then implementation engineer.

## Priority and route

Priority: user; product/accessibility/correctness/repo constraints; this concept-first and fidelity workflow; taste. Taste never overrides product needs. AIDA, bento, named fonts, GSAP, cards, and motion are options, not defaults.

- Build/redesign: concept, approval, implementation, fidelity.
- Small in-system fix: preserve system, implement, verify states; concept optional.
- Read-only audit: inspect and report evidence only.
- Nonvisual logic: use programming without visual process.

## Discover and direct

Before proposing a direction, inspect request, audience, purpose, content, shell/components/tokens/assets/dependencies, references, responsiveness, and loading, empty, error, success, disabled, selected, hover, and focus states. State one design read: surface, audience, visual language, implementation. Ask one question only when material directions remain. Never invent product facts.

Choose one coherent system for composition, type, palette, surfaces, imagery, icons, responsiveness, states, motion, accessibility, and labels. Prefer one strong idea.

## Concept and approval

For new apps, dashboards, games, creative sites, hero sections, and material redesigns:

1. Use Image Gen for a complete visual concept unless opted out or this is a small in-system fix.
2. Design the whole surface first: every major section plus unclear dense states/details.
3. Prefer one fresh concept per major section; overview only for rhythm/order. Never crop an overview into a reference.
4. Brief exact copy, controls, interaction, responsiveness, assets, and implementation constraints.
5. Present the concept and a compact `<design_plan>` covering direction, layout, assets, states, motion, accessibility, responsiveness, reference boundary, and QA.
6. Obtain design approval before implementation. Accepted concept rules become the visual and visible-copy contract.

Reject incomplete, generic, repetitive, cluttered, unreadable, or impractical concepts. Require complete surface, readable hierarchy, coherent components, and purposeful interaction. Keep real UI code-native; generate standalone assets.

## Taste without templates

Infer from the brief. Do not mechanically randomize or force a framework. Avoid unsupported generated defaults:

- purple glow, mesh orbs, generic glass, warm-beige luxury;
- centered hero plus three cards; badges, pills, fake metrics, proof clutter;
- nested cards, giant wrappers, purposeless bento, empty grid cells;
- emoji, mixed icon families, placeholder SVGs;
- narrow headings, wrapped CTAs, weak contrast, placeholder labels;
- repeated formulas, motion everywhere, fashionable type without brand reason;
- fake charts, jargon, testimonials, integrations, marks, or stock posed as authentic.

Lock palette, radii, shadows, icons, and type. Headlines usually fit two or three desktop lines. Keep primary action initially visible when appropriate. Extend the repo system; ask before packages or remote assets.

## Motion and implementation

Motion explains state, continuity, navigation, or meaning. Use existing stack; GSAP only when installed or approved and justified. Preserve meaning under `prefers-reduced-motion`. Avoid scroll hijacking, perpetual motion, and hover-only access.

Extract layout, copy, states, tokens, components, icons, assets, responsiveness, and motion. Then:

1. Reuse patterns and build reusable slices.
2. Preserve copy/reference identity unless approved.
3. Match palette/media literally; do not tint, overlay, simplify, or card-wrap by habit.
4. Implement semantics, keyboard, focus, labels, WCAG contrast, reduced motion, and states.
5. Keep continuous pointer/scroll values outside React render state; isolate client interaction leaves when required.
6. Preserve stack/support; use one matching icon family or production custom SVG.

## Verify to fidelity

For significant work, verify 375, 768, 1280, and concept width.

1. Test interaction, keyboard operation, focus, states, reduced motion, overflow.
2. Compare each section/viewport with its accepted concept.
3. Inspect type, spacing, color, controls, icons, crops, responsiveness, motion.
4. Use available browser tooling first. Inspect concept and latest screenshot together.
5. Keep a fidelity ledger with at least five points: mismatch, concept evidence, render evidence, fix/blocker.
6. Run formatter, lint, types, tests, relevant browser checks; remove temporary evidence/assets.

Do not finish with material visual, interaction, responsive, asset, type, or accessibility mismatch. Report evidence and blockers.
