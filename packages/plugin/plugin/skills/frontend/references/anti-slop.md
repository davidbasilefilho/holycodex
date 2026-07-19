# Anti-slop craft reference

Use this reference for every interface design, build, styling, redesign, mockup, or visual decision. It is a project-original synthesis of the [pols.dev anti-slop design law](https://pols.dev/slop.md), the [Oh My OpenAgent frontend skill](https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/refs/heads/dev/packages/omo-opencode/src/features/builtin-skills/frontend/SKILL.md), and the [GPT Taste skill](https://raw.githubusercontent.com/Leonxlnx/taste-skill/refs/heads/main/skills/gpt-tasteskill/SKILL.md). It does not reproduce those sources verbatim.

## Enforcement and precedence

- Read before visual work and handoff. Confirm briefly; at handoff report checks/fixes, not promises.
- These are defaults. Explicit user direction wins; established product contract wins unless redesign. Ask on ambiguity.
- Keep code, comments, plans, and output professional: no emoji and no em dash. Preserve exact technical strings where changing them would be incorrect.
- Avoidance is not design: replace canned choices with authored product-specific ones. Judge combinations because acceptable defaults can compound into slop. Protect function, content visibility, accessibility, and performance.

## Default slop patterns

Reject canned or unearned use of every pattern below. Allow a crafted exception only when it is product-specific, survives this file's quality checks, and does not recreate the named template.

### Small decorations and controls

- Reject automatic hero eyebrow/pill badges; gradient icon-label-glow pills; glowy pill buttons; default filled-primary plus outlined-secondary CTAs; eyebrow ticks/rules; one tracked uppercase/mono label across roles; ubiquitous tinted metadata chips; inner-glow badges; active-nav dots; canned underline fills/hover boops; default sun-moon toggles; and redrawn library icons.
- Add arrows only when earned, then tune shape, spacing, alignment, and motion. Never ship dead controls, fake links, decorative search, or nonfunctional interactivity.

### Icons, marks, and social proof

- Reject oversized icons in colored tiles, boxed logos, gradient icon-tile wordmarks, fake logos/initial avatars/customer marks/logo walls, fake macOS or code windows, traffic-light chrome, empty mockups, crude CSS/SVG media stand-ins, and false countdowns/urgency.
- Reject any Lucide use. For new icons preserve a matching non-Lucide repository system, else use faithful Tabler Icons, then custom SVG. Do use icons where they materially improve recognition.

### Cards and repeated content

- Reject kitchen-sink cards (icon tile, badge, tags, divider, price, glow, CTA); meaningless bobbing cards; automatic accent bars or identical hairline boxes; default all-around shadows, hover lifts, glowing borders, or offset-box fake shadows; three-tier pricing with glowing middle/`MOST POPULAR`; testimonial decoration or invented people/metrics; automatic image overlays; empty cards, bento holes, filler stats, and placeholder dashboards.

### Hero and page templates

- Reject default eyebrow/headline/subcopy/paired-CTA/trust-line/framed-panel heroes; habitual text-plus-framed-visual split heroes with floating tags/stats; recolored right-panel skeletons; narrow multiline or cramped display type, dangling accents, arbitrary stamps/pills/raw stats, and heroes that do not own the first screen.
- Compose the first viewport. A user- or concept-specified next-section preview is valid; otherwise prevent an accidental unbalanced half-section in the fold.
- Reject unneeded pre-footer gradient CTAs or standard multicolumn footers; oversized footer marks without disciplined clipping, spacing, purpose, and responsive proof; and default SaaS chains of hero, logo strip, bento, process, testimonials, pricing, CTA, footer.

### Section and form templates

- Reject repeated kicker-plus-serif or small-label-over-big-heading sections; generic big-serif statements replacing content; default numbered vertical-line steps; preset enquiry islands, email pills, or fill-plus-outline buttons; flat alternate fill after every section; mechanical left-right alternation or edge-flung asymmetry; and recycled layouts, palettes, type pairings, or signature tricks across unrelated products.

## Layout and composition failures

- Do not leave comparison columns ragged. Align titles, values, body copy, list starts, and actions on shared rows. Reserve space for missing or variable content and anchor actions consistently.
- Do not jam text against borders, viewport edges, notches, images, or controls. Preserve deliberate breathing room.
- Center intentionally. Verify optical and geometric centering for text, icons, controls, and compositions instead of assuming flex alignment is enough.
- Clear every cut. When using `clip-path`, notches, fixed heights, overlap, or `overflow: hidden`, pad content beyond the removed region and inspect the exact edge at high zoom.
- Prevent clipped content where sections overlap and avoid hard seams between images, gradients, and backgrounds.
- For an approved full-bleed image that must dissolve into one continuous page color, mask the image pixels rather than overlaying color. Use a long, finely eased mask with 10+ stops, about 30% fade at each edge, a sufficiently tall image region such as `116vh`, an opaque middle such as `#000 31%` through `#000 65%`, and a text scrim that returns to transparent before both edges. Treat these values as the source recipe, not a universal layout mandate.
- Avoid hard color seams between adjacent sections unless the boundary is deliberate and composed.
- Do not stack multiple slop layouts. Composition-level repetition compounds faster than isolated styling tells.
- Do not merely recolor the same skeleton or swap in a supposedly tasteful font.
- Use a real responsive contract. Check content hierarchy, reading order, wrapping, density, touch targets, and containment at narrow, mobile, tablet, desktop, and wide sizes.

## Typography, color, surface, and icon failures

### Typography

- Follow the source-conditional font policy in `../SKILL.md`, not a universal ban; preserve product type unless redesign. Fraunces + Work Sans concerns overuse, Space Grotesk + Inter default tech, and Inter is allowed as a neutral body face but not identity everywhere. Apply other display/serif/mono/reputation/startup cautions only under named conditions. Do not let trendy/free type carry identity by novelty; use mono only for real data/code/timestamps/technical values; reject instant-luxury letterspaced serif marks and recycled serif-display/sans pairings.
- View real content before choosing authentic, licensed, self-hosted, project-owned, or distinctive type, with quiet neutral body when useful. Do not default or randomly select Satoshi, Cabinet Grotesk, Outfit, or Geist. Fontshare offers self-hosted WOFF2 Pally, Gambarino, Sentient, Tanker; Velvetyne is another characterful source. General Sans, Clash Display, Cabinet Grotesk, and Satoshi remain generic as automatic startup signatures. Use `next/font/local` when apt. Give display type adequate width, line height, tracking, and space; keep landing heroes wide and usually within two or three lines only when fitting.

### Color and atmosphere

- Reject default purple/blue-purple/pastel-candy/adjacent-hue gradients; gradient headlines; automatic radial glows or soft-blend blobs; cool blue-charcoal dark, cream editorial, or UI-kit gray palettes; and saturated accent on every control/section. Resolve hard collisions/seams through shared tone, overlap, material, or space. Shape and contain light independently, never by blurring a copy. Reject generic grid/graph paper except sparse product-representative texture, and fixed backgrounds without narrative/spatial purpose.

### Surfaces, glass, borders, shadows, and grain

- Reject cut-off glows, halos, banded/botched glass, leaking shadows, blur pops, hard shadow boxes, faint borders everywhere, decorative hairlines, filler lines, and grain over content. Put texture behind clear text. Integrate media by matching crop, light, color, mask, and material. Remove glass that bands/leaks/pops or refracts nothing. When earned, use tonal elevation, self-colored borders, real translucency, controlled specular light, and material-specific shadow.

## Motion, clipping, and interaction failures

- Keep essential text and controls visible by default. Never start required content hidden and depend on CSS timelines, JavaScript, observers, hydration, or GSAP to reveal it.
- Preserve readability and operation when JavaScript fails, animation pauses, screenshots run, the tab is backgrounded, or reduced motion is enabled.
- Do not animate non-interactive elements merely to make a page feel alive.
- Reject canned hover lifts, jumps, border blooms, scale effects, and shadows. Author motion around a real state or affordance.
- Avoid botched fill animations. Keep cap shape stable, fill the complete track, use smooth easing, and verify the end state.
- Avoid layout-property animation by default. Prefer transform, opacity, and filter, then verify compositing and containment.
- Use GSAP when installed or approved. Pinning, stacking, scrubbing, parallax, marquees, image scaling, text treatment, and hover physics are conditional tools, not a mandatory bundle.
- Never let off-screen animation create a horizontal scrollbar. Fix geometry and containment; do not use page-wide clipping to hide a broken layout.
- Provide reduced-motion behavior and retain every interaction, state change, and piece of meaning.

## Premium craft

Premium means authored execution, not extra glow or motion. Build translucency from meaningful layers, controlled blur/saturation/edge light, and a background worth refracting. Prefer self-colored borders, tonal elevation, bespoke geometry/silhouette/crop/spacing/material over gray borders, all-around shadows, and default rounded rectangles. Use bare/project-coherent icons without automatic containers; craft SVG/iconography when approved libraries cannot supply a needed signature. Remove labels, badges, helper copy, and decoration that do not aid comprehension. Author micro-interactions with clear states, timing, easing, continuity, and reduced motion. Give light an identifiable source and bounded falloff without clipped bloom. Keep subtle noise/grain behind content; test banding/contrast. Use glass buttons only in supporting material; verify edge, gloss, contrast, hover, active, focus, disabled, and reduced motion.

- When reproducing the source glass-button recipe, retain its exact contract: `#2575FF` fill, thick variant at 50% fill opacity, `#FFFFFF` label/icon, Geist Medium 20, 8 icon gap, 20 horizontal/14 vertical padding, two 20%-opacity strokes (`#22BBFD` and `#FFFFFF`), `#FFFFFF` 20% inner shadow at Y 1/blur 32, and `#2575FF` 6% drop shadow at Y 3/blur 3. Thin material: light `-45deg`/80%, refraction 80, depth 2, dispersion 40, frost 6, splay 0. Thick: light `-50deg`/60%, refraction 64, depth 44, dispersion 67, frost 2, splay 20. Approximate unsupported refraction/dispersion with `backdrop-filter`, saturation/contrast, inset highlight, layered strokes, tight color-matched shadow, and a 1px edge offset or thin conic edge gradient; use `feDisplacementMap` only when its cost is justified.
- Prefer full-page relationships over card piles. Use authorized logo walls only with real proof; blueprint/canvas detail only when sparse, specific, relevant; inset islands only when transition, material, and role justify them. Keep work alive through proportionate motion, character, specificity, and responsive composition. Fine micro-grid/grain gradients must be crafted, non-banded, subordinate, and specific, never generic graph paper or candy aurora. Scroll motion must advance narrative, spatial continuity, comparison, or understanding. Oversized footer type needs deliberate crop, baseline, scale, and small-screen transformation.

## Signature and cohesion

Choose one product-specific signature, not competing tricks. Build atmosphere with purposeful color, light, texture, material, and depth; compose foreground/content/background while preserving legibility and reach. Show a populated functional product only when one exists, otherwise show its true form. Give type character without a source-named font, generic italic serif, or trendy free face. Create one belonging silhouette/crop/edge/spatial gesture. Treat navigation as design, avoiding logo-left/links-center/pill-right unless contracted. Use real names, copy, data, imagery, controls, and domain detail. Unify fitting signature, atmosphere, depth, product, type, silhouette, navigation, and content without forcing every ingredient. References supply design language only, never product, copy, claims, data, or artifact.

## Libraries and assets

- Reuse accessible, functioning repository primitives before hand-rolling generic controls. When installation is approved and the stack fits, consider Motion (`motion`, imported from `motion/react`), shadcn/ui, Tailark, motion-primitives, or Kokonut UI. Motion works without Tailwind; the others are Tailwind-oriented. Adapt their structure into a non-Tailwind project instead of adding global Tailwind for one block.
- Treat every prebuilt block as behavior and structure, not finished art direction. Remove default blue-purple gradients, glowy pills, paired fill/outline CTAs, sun-moon toggles, tracked caps, generic hero stacks, and any other catalog failure.
- Use real authorized logos, recognizable marks, content, and data only when truthful. Pull marks from official assets or reputable packages. Never fabricate customers, proof, metrics, testimonials, urgency, or capabilities.
- Priority builder asset rules override GPT Taste's prescribed `https://picsum.photos/seed/{keyword}/1920/1080`, stock filters (`grayscale`, `mix-blend-luminosity`, `opacity-90`, `contrast-125`), and automatic radial blur, mesh-gradient, or dark-overlay treatment. Use supplied/authentic assets and Image Gen concepts/assets under the priority workflow.

## Conditional GPT Taste constraints

- Use AIDA only when it matches a marketing narrative.
- Use a premium navigation treatment only when navigation is present and the direction calls for it.
- Keep a landing H1 wide and normally within two or three lines when an editorial hero fits. Source candidates are `max-w-5xl`, `max-w-6xl`, `w-full`, and `clamp(3rem, 5vw, 5.5rem)`; treat them as adaptable measures, not mandatory classes.
- Use three to five intentional bento cards only when a bento grid fits the content. Apply `grid-flow-dense`/`grid-auto-flow: dense` and prove column/row spans leave no unintended holes.
- Give major sections strong rhythm without imposing fixed `py-32 md:py-48` spacing.
- Use reasoned variety. Do not simulate Python, use prompt-length seeds, select fixed counts, or obey random output.
- Use authentic assets first. Do not prescribe Picsum, filters, background blurs, mesh gradients, or dark overlays.
- Use GSAP under the frontend skill's permission rule. `@gsap/react` and `ScrollTrigger` pinning, left-title/right-gallery splits, horizontal scroll, card stacking, scrubbed word reveals, marquees, parallax, and image scale/fade are candidates only when accepted and meaningful. Taste's source values (`scale: 0.8` to `1`, outgoing `opacity: 0.2`, `group-hover:scale-105 transition-transform duration-700 ease-out`) are optional tuned starting points, never universal requirements; essential content stays visible and reduced motion stays complete.
- Treat inline heading images, horizontal hover accordions, infinite authentic-logo/type marquees, and portrait testimonial carousels as optional architectures, never a required randomized set. Do not add them unless requested, concept-approved, truthful, and functional.
- Never force exactly two hero CTAs, a full-bleed dark radial wash, a split hero, AIDA, pricing/footer action, bento, GSAP, or any fixed component count. The priority builder's supplied IA, accepted concept, product fit, repository stack, accessibility, and fidelity rules decide.
- Prevent horizontal overflow by correcting animated geometry and containment. Do not conceal a broken page with the Taste source's universal `<main className="overflow-x-hidden w-full max-w-full">` wrapper.
- Include applicable hero measure, grid density, labels, button contrast, motion, states, responsiveness, accessibility, assets, and QA in `<design_plan>`.

## Preflight and final audit

Before implementation:

Confirm this reference is loaded; inspect product contract, real content, nearest patterns, dependencies, viewports, and states; identify the product signature and all material visible decisions; enforce frontend font/icon policy; verify assets are supplied, authentic, approved, or accepted placeholders; verify motion purpose, GSAP availability, visible fallback, and reduced motion; condition AIDA, hero, bento, card count, and spacing on fit; obtain approval for visible direction and material interaction.

Before handoff:

Re-read this file and check each applicable item. Inspect default, hover, active, focus, disabled, loading, empty, error, keyboard, and reduced-motion states. For significant work inspect 375, 768, and 1280 pixels; scale proof for small fixes. Check alignment, text edges, cuts, seams, centering, contrast, assets, controls, icons, type, and horizontal containment. Exercise motion and prove essential content without animation. Compare references with fresh browser evidence while preserving content/identity. Run requested production performance audits with repeated mobile/desktop measurements and diagnose architectural causes. Fix every failure; report only measured parity, scores, and checks.
