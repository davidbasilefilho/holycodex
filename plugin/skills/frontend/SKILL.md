---
name: frontend
description: Use when a task needs frontend, web UI, UX, visual design, interaction, responsive layout, accessibility, or browser-performance work; do not use for backend-only work, static prose, or non-web artifacts. Produces context-aware approved design decisions followed by accessible responsive implementation or findings; premium React/Tailwind creation adds the GPT Taste route.
---

# Frontend

Preserve stack, behavior, tokens, patterns, supplied visual contract, and product identity. Keep scope small. Avoid generic AI styling. Do not force `DESIGN.md`, research, dependencies, GSAP, or heavy QA.

## Approval sequence

1. Load `frontend`; inspect the request, product shell, target surface, design tokens, nearest pattern, responsive contract, supplied references, and relevant states.
2. Select only material design decisions: visual direction, typography, layout and density, color and surfaces, assets, responsive behavior, applicable states, plus a motion system and accessibility treatment for every task. Define how motion communicates hierarchy, state, interaction, continuity, or navigation; keep it proportional. Define `prefers-reduced-motion`, keyboard operation, focus visibility, semantics, contrast, and labels. Preserve established decisions unless change is requested.
3. Present the compact decision set with existing constraints and ask for approval before implementation. For a fix, audit, accessibility, or performance task, include only decisions that alter user-visible design; diagnosis and technical implementation details need no approval.
4. After approval, ask whether the user wants to define a goal. Only after explicit agreement load `define-goal`; otherwise implement.

Approval owns visible direction and material interaction changes. Existing component APIs, code structure, exact CSS values, breakpoint mechanics, libraries already required by the approved route, and other reversible implementation details remain implementation decisions.

## Route

- Build/redesign: inspect shell, tokens, target component, responsive contract.
- Visual reference: use it first; measure layout, type, color, spacing, surface, and motion.
- Performance: load `references/perfection/README.md` only for real audit or regression.
- Palette/type/style: load only relevant `references/ui-ux-db` data.
- Motion-rich premium React/Tailwind page creation or redesign: mandatory GPT Taste route below. Ordinary fixes, debugging, accessibility, and performance work stay on normal route.

## GPT Taste route

- During approval, emit `<design_plan>` with prompt-derived visual direction, type, layout, motion, responsive, accessibility, and state choices. Established contracts win.
- Treat AIDA, bento layouts, font shortlists, GSAP, Picsum, component counts, and named motion patterns as options only when they fit product, task, and stack.
- For each chosen pattern, state its user-facing purpose and containment. Do not add dependencies or remote assets unless approved and required.
- Motion is required but may be subtle. Avoid gratuitous, blocking, performance-heavy, or reduced-motion-unsafe effects.
- Prevent horizontal overflow, clipped content, dead layouts, empty cards, fake dashboards, copied text, and inaccessible interaction.

Ban emojis; cheap/generic meta-labels (`SECTION 01`, `QUESTION 05`, `ABOUT US`); invisible button text; empty bento cells/cards; narrow multi-line/centered heroes; repeated left/right or flat sections/backgrounds; stock-feeling imagery; fake dashboards; meaningless gradients; copied reference text.

Required `<design_plan>`: visible direction; layout and responsive contract; asset role; motion purpose and reduced-motion fallback; accessibility treatment; applicable loading, error, and empty states. Include only chosen patterns, not a fixed architecture count.

Only after approval and optional goal choice may implementation begin.

## Implementation

1. Inspect target and nearest established pattern.
2. Lock visual direction: type, spacing, surfaces, color, asset role, motion role.
3. Implement smallest coherent slice with purposeful motion, reduced-motion behavior, keyboard operation, visible focus, semantic structure, contrast, and labels.
4. Test narrow/mobile/wide containment. No horizontal leak, clipped text, overlap, or unreadable measure.
5. Check loading, error, and empty states when applicable.
6. Check interaction and performance proportional to change. Avoid layout shift, oversized media, needless client work.

Use real assets when supplied. Never invent research or claim screenshot parity without visual comparison.
