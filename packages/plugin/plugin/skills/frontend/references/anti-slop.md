# Anti-slop craft reference

Use this reference for every interface design, build, styling, redesign, mockup, or visual decision. It is a project-original synthesis of the [pols.dev anti-slop design law](https://pols.dev/slop.md), the [Oh My OpenAgent frontend skill](https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/refs/heads/dev/packages/omo-opencode/src/features/builtin-skills/frontend/SKILL.md), and the [GPT Taste skill](https://raw.githubusercontent.com/Leonxlnx/taste-skill/refs/heads/main/skills/gpt-tasteskill/SKILL.md). It does not reproduce those sources verbatim.

## Contents

- Enforcement and precedence
- Default slop patterns
- Layout and composition failures
- Typography, color, surface, and icon failures
- Motion, clipping, and interaction failures
- Premium craft
- Signature and cohesion
- Preflight and final audit

## Enforcement and precedence

- Read this file before visual work and re-read it before handoff.
- Confirm the load compactly. At handoff, report applicable checks and fixes instead of making a ceremonial promise.
- Treat these rules as defaults. Explicit user direction wins. An established product contract wins unless a redesign is requested. Ask when either is ambiguous.
- Keep code, comments, plans, and output professional: no emoji and no em dash. Preserve exact technical strings where changing them would be incorrect.
- Do not evade the catalog by removing all character. Avoidance alone is not design. Replace canned choices with authored, product-specific choices.
- Judge combinations, not isolated atoms. Several acceptable defaults stacked together create stronger slop.
- Protect function, content visibility, accessibility, and performance while improving craft.

## Default slop patterns

Reject canned or unearned use of every pattern below. Allow a crafted exception only when it is product-specific, survives this file's quality checks, and does not recreate the named template.

### Small decorations and controls

- Pill or eyebrow badges used as automatic hero decoration.
- Gradient pills combining icon, label, glow, and rounded container.
- Glowy pill buttons and the default filled-primary plus outlined-secondary CTA pair.
- A little rule or tick beside an eyebrow label.
- One tracked uppercase or monospace label treatment repeated across every role.
- Tinted metadata chips everywhere.
- Inner-glow badges, active-nav dots, canned underline fills, and hover boops.
- Arrows added by reflex. When an arrow earns its place, tune its shape, spacing, alignment, and motion.
- Default sun-and-moon toggles and redrawn library icons.
- Dead controls, fake links, decorative search boxes, and nonfunctional interactivity.

### Icons, marks, and social proof

- Oversized icons inside colored tiles, boxed logos, and gradient icon-tile wordmarks.
- Fake logos, gradient initials avatars, invented customer marks, and fake logo walls.
- Any Lucide use. For new icons, preserve a matching non-Lucide repository system, otherwise use Tabler Icons when faithful, then custom SVG.
- No-icons-at-all minimalism when icons would improve recognition.
- Fake macOS windows, traffic-light chrome, generic code windows, and empty product mockups.
- Crude CSS or SVG stand-ins for real imagery, product UI, charts, or illustration.
- Countdown timers and urgency widgets without a real deadline.

### Cards and repeated content

- Kitchen-sink cards combining icon tile, badge, tags, divider, price, glow, and CTA.
- Floating cards that bob without functional meaning.
- Accent-bar cards and identical hairline-bordered boxes used as automatic structure.
- Default all-around shadows, hover lifts, glowing borders, and a second offset box pretending to be a shadow.
- Three-tier pricing presets with a glowing middle card and `MOST POPULAR` pill.
- Testimonial cards with decorative quote marks, fake avatars, job titles, or invented metrics.
- Image cards with automatic overlay captions.
- Empty cards, bento holes, filler statistics, and placeholder dashboards.

### Hero and page templates

- The default hero stack: eyebrow, oversized headline, subcopy, paired CTAs, trust line, then a framed panel.
- The habitual split hero, including a text column plus framed visual, floating tag, or stat row.
- The hero stack with a panel on the right and the same skeleton recolored for every brief.
- Narrow multi-line headlines, dangling accent words, cramped display type, and heroes that fail to own the first screen.
- Compose the first viewport deliberately. A next-section preview is valid when the user or accepted concept specifies it; otherwise prevent an accidental, unbalanced half-section from leaking into the fold.
- Arbitrary stamp icons, tag pills, and raw stats in heroes.
- Pre-footer gradient CTA slabs and standard multi-column footers used without product need.
- Oversized footer wordmarks without clipping discipline, spacing, purpose, or responsive proof.
- Whole SaaS product-page templates assembled from hero, logo strip, bento, process, testimonials, pricing, CTA, and footer by default.

### Section and form templates

- Kicker plus serif heading repeated for every section.
- A generic big-serif statement block standing in for content.
- Small-label-over-big-heading section heads repeated mechanically.
- Numbered steps arranged beside a vertical line by default.
- Inset enquiry islands, email-pill forms, and filled-plus-outlined button pairs used as presets.
- A flat alternate fill placed under every section after the hero.
- Repeated left-right section alternation and content flung to opposite edges as default asymmetry.
- Recycled house layouts, palettes, type pairings, or signature tricks across unrelated products.

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

- Follow the source-conditional font policy in `../SKILL.md`; it is not a universal font ban. Preserve established product typography outside a requested redesign. Fraunces + Work Sans is an overused-pairing concern; Space Grotesk + Inter is a default-tech concern; Inter is allowed as a neutral body face, not an identity everywhere. Apply the listed display, serif, mono, reputation-swap, and startup-signature cautions only under their named source conditions.
- Avoid a free or trendy font carrying the entire identity merely because it appears distinctive.
- Avoid mono as the house voice. Reserve it for genuine data, code, timestamps, or technical values.
- Avoid a letterspaced serif wordmark as an instant-luxury shortcut.
- Avoid the same serif-display plus clean-sans pairing across unrelated briefs.
- Choose type after viewing it with real content. Prefer authentic, licensed, self-hosted, project-owned, or genuinely distinctive type, with a quiet neutral body face when useful.
- Do not constrain every design to Satoshi, Cabinet Grotesk, Outfit, or Geist and never choose among them by prompt-length randomness. Fontshare can supply self-hosted WOFF2 files, including Pally, Gambarino, Sentient, and Tanker; Velvetyne is another characterful source. General Sans, Clash Display, Cabinet Grotesk, and Satoshi can still read generic when used as automatic startup signatures. With Next.js, use `next/font/local` when appropriate.
- Give display type enough width, line height, tracking, and surrounding space. Keep landing heroes wide and normally within two or three lines only when that structure fits.

### Color and atmosphere

- Reject default purple, blue-purple, pastel-candy, and adjacent-hue gradients.
- Reject gradient-filled headline text, automatic radial glows, drifting soft-blend blobs, cool blue-charcoal dark palettes, cream editorial palettes, and default UI-kit gray surfaces.
- Reject a saturated accent pasted onto every control and section.
- Avoid hard color collisions and seams. Make transitions deliberate through shared tones, overlap, material, or spacing.
- Do not use a blurred copy of an element as its bloom. Shape light independently and contain it.
- Avoid generic grid or graph-paper backgrounds. A sparing, authored technical texture may earn its place when it represents the product.
- Avoid fixed backgrounds that merely follow scrolling without narrative or spatial purpose.

### Surfaces, glass, borders, shadows, and grain

- Reject cut-off glows, blurred halos, banded glass, leaking shadows, blur pops, and hard-edged shadow boxes.
- Reject faint borders on every box, unrounded decorative hairlines, and lines added only to fill space.
- Reject grain laid over content. Place texture behind content and protect text clarity.
- Reject hard image seams. Match crop, lighting, color, mask, and surrounding material so media belongs to the composition.
- Reject botched glass. If blur bands, leaks, pops, or has nothing real to refract, remove it.
- Use tonal elevation, self-colored borders, real translucency, controlled specular light, and material-specific shadows when they earn their place.

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

Premium means authored execution, not more glow or animation.

- Build real translucency from meaningful layers, controlled blur, saturation, edge light, and a background worth refracting.
- Use self-colored borders and tonal elevation instead of default gray borders and all-around shadows.
- Prefer bespoke geometry, silhouette, cropping, spacing, and material over default rounded rectangles.
- Use bare or project-coherent icons where the selected library priority does not fit. Never add a container automatically.
- Say less. Remove labels, badges, helper copy, and decoration that do not improve comprehension.
- Create custom iconography or crafted SVG renders when the product needs a signature and approved libraries cannot supply it.
- Author micro-interactions with clear states, timing, easing, continuity, and reduced-motion behavior.
- Use considered light with an identifiable source, bounded falloff, and no clipped bloom.
- Put premium noise and grain behind content, keep it subtle, and test banding and contrast.
- Use glass buttons only when the surrounding material supports them. Verify edge, gloss, contrast, hover, active, focus, disabled, and reduced-motion states.
- When reproducing the source glass-button recipe, retain its exact contract: `#2575FF` fill, thick variant at 50% fill opacity, `#FFFFFF` label/icon, Geist Medium 20, 8 icon gap, 20 horizontal/14 vertical padding, two 20%-opacity strokes (`#22BBFD` and `#FFFFFF`), `#FFFFFF` 20% inner shadow at Y 1/blur 32, and `#2575FF` 6% drop shadow at Y 3/blur 3. Thin material: light `-45deg`/80%, refraction 80, depth 2, dispersion 40, frost 6, splay 0. Thick: light `-50deg`/60%, refraction 64, depth 44, dispersion 67, frost 2, splay 20. Approximate unsupported refraction/dispersion with `backdrop-filter`, saturation/contrast, inset highlight, layered strokes, tight color-matched shadow, and a 1px edge offset or thin conic edge gradient; use `feDisplacementMap` only when its cost is justified.
- Prefer full-page composition and large-scale relationships over a pile of isolated cards.
- Use real, authorized logo walls only when social proof exists.
- Use blueprint or canvas detail only when sparse, specific, and product-relevant.
- Use inset island sections only when transition, material, and content role justify the island.
- Keep professional work alive through proportionate motion, character, specificity, and responsive composition.
- Use a fine textured micro-grid or grainy gradient only when crafted, non-banded, subordinate, and specific. Never fall back to generic graph paper or candy aurora.
- Use scroll-authored motion only when it advances narrative, spatial continuity, comparison, or product understanding.
- Place oversized footer type only when its cropping, baseline, scale, and small-screen transformation are deliberate.

## Signature and cohesion

- Choose one product-specific signature artifact instead of many competing tricks.
- Create atmosphere from purposeful color, light, texture, material, and depth instead of a flat fill or default glow.
- Compose the z-axis with foreground, content plane, and background relationships. Keep text legible and interactions reachable.
- Show the product as a real, populated, functional artifact only when the product has such an interface. Otherwise show what the product actually is.
- Give display type character without relying on a source-named font, generic italic serif, or trendy free face.
- Create one bespoke silhouette, crop, edge, or spatial gesture that belongs to the product.
- Treat navigation as part of the design. Avoid the default logo-left, links-center, pill-right arrangement unless the product contract calls for it.
- Use real names, copy, data, imagery, controls, and domain details. Specificity is stronger than decoration.
- Combine signature artifact, atmosphere, depth, real product, characterful type, bespoke silhouette, treated navigation, and specific content into one coherent language. Do not force every ingredient when it does not fit.
- Use references for design language only. Never copy their product, copy, claims, data, or artifact.

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

1. Confirm the anti-slop reference is loaded.
2. Inspect the product contract, real content, nearest patterns, dependencies, viewports, and states.
3. Identify the product-specific signature and every material visible decision.
4. Confirm font and icon choices follow the frontend skill's new-choice policies.
5. Confirm assets are supplied, authentic, approved, or explicitly accepted placeholders.
6. Confirm motion purpose, GSAP availability, content-visible fallback, and reduced-motion behavior.
7. Confirm conditional AIDA, hero, bento, card-count, and spacing rules are used only when they fit.
8. Obtain approval for visible direction and material interaction.

Before handoff:

1. Re-read this file and check every applicable catalog item.
2. Inspect default, hover, active, focus, disabled, loading, empty, error, keyboard, and reduced-motion states.
3. Inspect 375, 768, and 1280 pixel widths for significant work; scale evidence proportionally for small fixes.
4. Check alignment, text edges, cuts, seams, centering, contrast, assets, controls, icons, type, and horizontal containment.
5. Exercise motion and verify essential content remains visible when animation does not run.
6. Compare supplied visual references with fresh browser evidence while preserving original content and identity.
7. Run requested performance audits on production output, use repeated mobile and desktop measurements, and diagnose architectural causes.
8. Fix every observed failure. Report only measured parity, scores, and checks.
