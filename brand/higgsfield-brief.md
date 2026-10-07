# HIVE brand brief (for Higgsfield)

Use these prompts with Higgsfield's image models. Generate 4 variations of each, pick one, then
upscale. Keep text out of the generated art (add the wordmark in post), except where noted.

## Palette and feel

- Base: deep comb black #120C06, surface #1C1409
- Amber #F5A524, honey gold #FFC866, wax cream #FFF1D6, royal jelly white #FFF8EC
- Accents: swarm red #FF5C3A (sparingly)
- Material: glossy translucent honey, warm specular highlights, soft bloom, beeswax.
- Shape language: the hexagon is the only shape.
- Mood: premium fintech product, not a cartoon game. Clean, warm, cinematic.

## Logo (square, 1:1, 1024 x 1024)

Prompt:
> A single glossy hexagonal honeycomb cell seen at a slight three-quarter tilt, filled with
> translucent amber honey with a bright meniscus highlight, a small elegant queen bee with a tiny
> gold crown hovering just above the cell, warm rim light, deep black background (#120C06), soft
> golden bloom, minimalist premium app icon, centered, high detail, no text.

Negative: text, letters, watermark, cartoon face, clutter, multiple bees, frame.

Variants to try: (a) the cell only, honey glowing from within; (b) the queen bee's silhouette
cut out of a solid amber hexagon (flat, for small sizes / favicon).

## Banner (X / Twitter header, 3:1, 1500 x 500)

Prompt:
> A wide cinematic honeycomb made of glossy hexagonal wax cells stretching into darkness, each
> cell filled to a different level with translucent amber honey, small worker bees hovering over
> the cells, one bright white royal cell in the center glowing, a golden pulse rippling outward
> across the comb, shallow depth of field, warm amber and gold light on a deep black background
> (#120C06), premium, cinematic, ultra detailed. Leave clean dark space on the left third for a
> wordmark. No text.

## Banner (site / OG image, 1.91:1, 1200 x 630)

Same prompt as above, composed with the glowing white royal cell slightly right of center and the
left 40% calm and dark for the "HIVE" wordmark and tagline.

## Wordmark (add in post)

"HIVE" in Space Grotesk 600, tight tracking (-0.03em), wax cream #FFF1D6, with the tagline
"Every coin is a beehive. Every holder is a bee." in Inter, amber #F5A524.

## Where they go in the app

- Logo → `public/brand/logo.png` (and a 512 px copy for `app/icon.png` / favicon)
- X banner → `public/brand/banner-x.png`
- OG banner → `public/brand/og.png` (wire into `app/layout.tsx` metadata.openGraph.images)
