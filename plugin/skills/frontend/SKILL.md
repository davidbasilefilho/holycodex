---
name: frontend
description: Build, style, debug, audit, or polish web UI. Use for frontend components, pages, visual QA, accessibility, performance, or premium editorial design.
---

# Frontend

Preserve stack, behavior, design tokens, component patterns, and supplied screenshot/URL contract. Small request stays small. No forced `DESIGN.md`, research lane, new dependency, GSAP, or heavyweight QA.

## Route

- Build/redesign: inspect app shell, tokens, target component, responsive contract.
- Visual reference: use supplied screenshot/URL first. Measure layout, type, color, spacing, surface, motion.
- Performance: load `references/perfection/README.md` only for real audit or regression.
- Palette/type/style lookup: load only relevant `references/ui-ux-db` data.
- Premium editorial: use rules below.

## Premium editorial mode

- Before code, emit `<design_plan>` only for premium page/redesign work. Derive choices from prompt; vary combination. Include hero, font, three component patterns, two motion patterns, AIDA map, H1 width/line proof, grid span math, label/contrast sweep.
- AIDA page sequence when landing-page persuasion matters.
- Cinematic, asymmetric, editorial hero. Wide two-to-three-line headline. Strong art direction.
- Dense gapless bento where content supports it. Cards must carry real information.
- Strong contrast, deliberate type scale, responsive containment, contextual assets.
- Font fits project; for greenfield premium work consider Satoshi, Cabinet Grotesk, Outfit, or Geist. Never replace established type contract.
- Choose three useful structures: inline heading image, expanding accordion, partner marquee, restrained carousel, pinned gallery, stacked cards.
- Real GSAP, `@gsap/react`, and ScrollTrigger only when user asks for advanced motion or project already uses them. Choose at most two motion systems: pinned split, image scale/fade, scrubbed word reveal, stacked cards.
- Motion must explain hierarchy, state, or navigation. No decoration-only motion.
- Contain animated overflow with full-width `overflow-x-hidden` shell when needed.

Ban generic meta-labels, empty cards, narrow centered heroes, flat repeated sections, emoji icons, fake dashboards, meaningless gradients, and copied reference text.

## Implementation

1. Inspect target and nearest established pattern.
2. Lock visual direction: type, spacing, surfaces, color, asset role, motion role.
3. Implement smallest coherent slice. Keep semantics and keyboard behavior.
4. Test narrow/mobile/wide containment. No horizontal leak, clipped text, overlap, or unreadable measure.
5. Check contrast, focus, labels, reduced motion, loading, error, empty state when in scope.
6. Check interaction and performance proportional to change. Avoid layout shift, oversized media, needless client work.

Use real assets when supplied. Never invent research or claim screenshot parity without visual comparison.
