# Two additional cat avatar concepts

These Product and Operations designs were generated with the built-in image tool
from the website's four existing avatar illustrations and approved for the app's
avatar set. They preserve the circular crop, large ears, @ eye, wink, and pastel
style. Production artwork is replaced under the existing filenames; see
[implementation validation](IMPLEMENTATION.md).

Source artwork: [Product](architect.webp) (rose/cream) and
[Operations](businessman.webp) (teal/mint). The 1254 × 1254 images are stored as
lossless WebP with transparent corners; decoded RGBA pixels match the generated
PNGs. Production assets retain the `architect.png` and `businessman.png` names
and 512 × 512 dimensions. Their matching SVG files embed those production PNG
bytes, preserving compatibility URLs. These are raster images, not editable
vector masters.

The reference PNGs are deterministic rasterizations of `avatar-{general,engineering,design,growth}-lark-v3.svg` from opentag-site commit `4f63d20383045861ca5cd93be8196829f0974e5f`.
