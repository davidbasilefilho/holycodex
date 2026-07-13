---
name: frontend
description: Use when a task needs frontend, web UI, UX, visual design, interaction, responsive layout, accessibility, or browser-performance work; do not use for backend-only work, static prose, or non-web artifacts. Produces context-aware approved design decisions followed by accessible responsive implementation or findings; premium React/Tailwind creation adds the GPT Taste route.
---

# Frontend

Preserve stack, behavior, tokens, patterns, supplied visual contract, and existing product identity. Keep scope small. Avoid generic AI styling. Do not force `DESIGN.md`, research, dependencies, GSAP, or heavy QA.

## Approval sequence

1. Load `frontend`; inspect the request, product shell, target surface, design tokens, nearest pattern, responsive contract, supplied references, and relevant states.
2. Select only material design decisions: theme or visual direction, typography, layout and density, color and surfaces, asset role, interaction and motion, responsive behavior, and accessibility or state treatment. Preserve established decisions unless change is requested.
3. Present the compact decision set with existing constraints and ask for approval before implementation. For a fix, audit, accessibility, or performance task, include only decisions that alter user-visible design; diagnosis and technical implementation details need no approval.
4. After approval, ask whether the user wants to define a goal. Only after explicit agreement load `define-goal`; otherwise implement.

Approval owns visible direction and material interaction changes. Existing component APIs, code structure, exact CSS values, breakpoint mechanics, libraries already required by the approved route, and other reversible implementation details remain implementation decisions.

## Route

- Build/redesign: inspect shell, tokens, target component, responsive contract.
- Visual reference: use it first; measure layout, type, color, spacing, surface, and motion.
- Performance: load `references/perfection/README.md` only for real audit or regression.
- Palette/type/style: load only relevant `references/ui-ux-db` data.
- Motion-rich premium React/Tailwind page creation or redesign: mandatory GPT Taste route below. Ordinary fixes, debugging, accessibility, and performance work stay on normal route.

## Mandatory GPT Taste route

- During the approval decision set, emit `<design_plan>` with deterministic prompt-derived selection: one hero, one approved font stack (`Satoshi`, `Cabinet Grotesk`, `Outfit`, or `Geist`; never `Inter`), three component architectures, two GSAP paradigms. Do not repeat a default combination or replace an established type contract.
- Follow AIDA: premium nav; Attention hero; Interest bento/features; Desire scroll/media; Action CTA/footer. Separate chapters with `py-32 md:py-48`.
- Select cinematic center, artistic asymmetry, or editorial split. Build one hero: wide `max-w-5xl`/`max-w-6xl` H1, responsive `clamp`, maximum 2–3 lines, strong art direction, perfect button contrast, no stamp icons, pill tags, or raw stats.
- Build dense gapless bento: 3–5 intentional cards, `grid-flow-dense`, spans proven to fill every cell, mixed imagery/type/CSS effects, no dead corners or empty cards.
- Use contextual `https://picsum.photos/seed/{keyword}/1920/1080` assets; art-direct coherent grayscale/blend/contrast/opacity with subtle radial blur, grain mesh, or dark overlays.
- Select three architectures: inline heading image, horizontal expanding accordion, infinite partner marquee, restrained testimonial carousel, pinned gallery, or stacked cards.
- Use real GSAP with `@gsap/react` and `ScrollTrigger`. Select two systems: pinned title/gallery split, image scale/fade scroll, scrubbed word reveal, or stacked cards. Motion explains hierarchy, state, or navigation; static interface fails. Interactive images/cards use slow contained scale hover.
- Wrap page: `<main className="overflow-x-hidden w-full max-w-full">`.

Ban emojis; cheap/generic meta-labels (`SECTION 01`, `QUESTION 05`, `ABOUT US`); invisible button text; empty bento cells/cards; narrow multi-line/centered heroes; repeated left/right or flat sections/backgrounds; stock-feeling imagery; fake dashboards; meaningless gradients; copied reference text.

Required `<design_plan>`:

1. Three-line deterministic selection: hero, font stack, three architectures, two GSAP systems.
2. AIDA map.
3. H1 max-width and 2–3-line proof; confirm no stamps/tags.
4. Grid-span math and `grid-flow-dense` proof.
5. Meta-label sweep and button-contrast check.

Only after approval and optional goal choice may implementation begin.

## Implementation

1. Inspect target and nearest established pattern.
2. Lock visual direction: type, spacing, surfaces, color, asset role, motion role.
3. Implement smallest coherent slice. Keep semantics and keyboard behavior.
4. Test narrow/mobile/wide containment. No horizontal leak, clipped text, overlap, or unreadable measure.
5. Check contrast, focus, labels, reduced motion, loading, error, empty state when in scope.
6. Check interaction and performance proportional to change. Avoid layout shift, oversized media, needless client work.

Use real assets when supplied. Never invent research or claim screenshot parity without visual comparison.
