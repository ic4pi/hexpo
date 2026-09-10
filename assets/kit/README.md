# Broomstick Run — Level Asset Kit

Preview every asset live at `/asset-kit.html`.

## Palette atlas

All city-kit models (everything except `broom.glb`) share a single texture,
`Textures/colormap.png`, referenced by relative URI from inside each `.glb`.
Keep the folder layout intact or the models load untextured.

The atlas is a **palette strip, not a picture**: the `u` coordinate snaps to one
of 8 columns and `v` is a free vertical ramp. Recolouring the entire kit is
therefore a single PNG edit — no model changes, no re-export.

| col | used by                          | current colour  |
|-----|----------------------------------|-----------------|
| 0   | building walls, path base        | violet stone    |
| 1   | tree canopy, roof trim           | teal            |
| 2   | tyres, character body            | near-black      |
| 3   | vehicle primary                  | magenta         |
| 4   | fence, tree trunk                | brass           |
| 5   | debris, kart shell               | purple          |
| 6   | warm highlight                   | gold            |
| 7   | accent                           | cyan            |

Regenerate with `tools/make-colormap.py`.

## Models

Scenery and obstacle pieces are authored around a ~1 unit grid; the game's
world units are much larger, so scale up on placement (roughly 2–3x for
buildings). Vehicles are ~3.4 units long.

`broom.glb` is the odd one out: it is an AI-generated mesh with **no material
and no UVs**, so it needs a material assigned in code. It was decimated from
998k triangles / 24 MB down to 11.9k / 213 KB; the silhouette is unchanged.
It sits diagonally in its bounding box and needs re-orienting when mounted on
the player.
