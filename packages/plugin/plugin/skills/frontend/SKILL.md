---
name: frontend
description: Use when a task needs frontend, web UI, UX, visual design, interaction, responsive layout, accessibility, or browser-performance work; do not use for backend-only work, static prose, or non-web artifacts. Produces context-aware approved design decisions followed by accessible responsive implementation or findings; premium React/Tailwind creation adds the GPT Taste route.
---

# Frontend

Preserve stack, behavior, tokens, patterns, visual contract, and identity. Keep scope small; avoid generic AI styling. Do not force `DESIGN.md`, research, dependencies, GSAP, or heavy QA.

## Approval sequence

1. Load `frontend`; inspect the request, product shell, target surface, design tokens, nearest pattern, responsive contract, supplied references, and relevant states.
2. Select only material decisions: direction, type, layout/density, color/surfaces, assets, responsiveness, applicable states, plus a motion system and accessibility treatment for every task. Give motion a proportional hierarchy, state, interaction, continuity, or navigation purpose. Define `prefers-reduced-motion`, keyboard operation, focus visibility, semantics, contrast, and labels. Preserve established decisions unless change is requested.
3. Present the compact decision set with existing constraints and ask for approval before implementation. For a fix, audit, accessibility, or performance task, include only decisions that alter user-visible design; diagnosis and technical implementation details need no approval.
4. After approval, ask whether the user wants to define a goal. Only after explicit agreement load `define-goal`; otherwise implement.

Approval owns visible direction and material interaction. Component APIs, code structure, exact CSS, breakpoint mechanics, route-required libraries, and other reversible implementation details remain implementation decisions.

## Route

- Build/redesign: inspect shell, tokens, component, responsive contract.
- Visual reference: use first; measure layout, type, color, spacing, surface, motion.
- Performance: load `references/perfection/README.md` only for real audit or regression.
- Palette/type/style: load only relevant `references/ui-ux-db` data.
- Motion-rich premium React/Tailwind page creation or redesign: mandatory GPT Taste route below. Ordinary fixes, debugging, accessibility, and performance work stay on normal route.

## GPT Taste route

- During approval, emit `<design_plan>` with prompt-derived direction, type, layout, motion, responsive, accessibility, and state choices. Established contracts win.
- Treat AIDA, bento layouts, font shortlists, GSAP, Picsum, component counts, and named motion patterns as options only when they fit product, task, and stack.
- State each chosen pattern's user-facing purpose and containment. Add no dependency or remote asset unless approved and required.
- Motion is required but may be subtle. Avoid gratuitous, blocking, performance-heavy, or reduced-motion-unsafe effects.
- Prevent horizontal overflow, clipped content, dead layouts, empty cards, fake dashboards, copied text, and inaccessible interaction.

Ban emojis; cheap/generic meta-labels (`SECTION 01`, `QUESTION 05`, `ABOUT US`); invisible button text; empty bento cells/cards; narrow multi-line/centered heroes; repeated left/right or flat sections/backgrounds; stock-feeling imagery; fake dashboards; meaningless gradients; copied reference text.

Required `<design_plan>`: visible direction; layout/responsive contract; asset role; motion purpose/reduced-motion fallback; accessibility treatment; applicable loading, error, and empty states. Include only chosen patterns, never a fixed architecture count.

Only after approval and optional goal choice may implementation begin.

## Implementation

1. Inspect target and nearest pattern.
2. Lock type, spacing, surfaces, color, asset role, and motion role.
3. Implement smallest coherent slice with purposeful motion, reduced motion, keyboard operation, visible focus, semantics, contrast, and labels.
4. Test narrow/mobile/wide containment: no horizontal leak, clipped text, overlap, or unreadable measure.
5. Check loading, error, and empty states when applicable.
6. Check proportional interaction/performance. Avoid layout shift, oversized media, needless client work.

Use real assets when supplied. Never invent research or claim screenshot parity without visual comparison.
