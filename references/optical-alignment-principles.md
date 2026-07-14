# Optical alignment principles

## Core model

Geometric center is the midpoint of a box. Optical center is the position where the visible form feels balanced in its actual context. The two often diverge for directional, tapered, open, skewed, or detached shapes.

Evaluate several signals instead of relying on a single centroid:

- visible-area distribution;
- boundary and contour distribution;
- convex hull and directional mass;
- horizontal and vertical symmetry axes;
- negative space inside the container;
- rasterized appearance at the production size;
- neighboring text, shapes, and container geometry.

Psychophysical research indicates that perceived centers depend strongly on boundary contour, not only luminance or filled area. Treat the final judgment as perceptual and context-dependent.

## Common corrections

- Shift right-facing play triangles slightly toward the point.
- Balance chevrons and arrows according to their direction and container.
- Give visually heavy sides more negative space.
- Use asymmetric side bearings or viewBox padding when the asset must remain reusable.
- Down-weight or exclude detached `TM`, registered marks, shadows, and notification badges when they are not part of the primary silhouette.
- Re-evaluate outline icons because stroke joins and caps change their perceived mass.
- Mirror the approved horizontal correction when the glyph itself is mirrored for RTL.

## Size and context

Inspect the rasterized result at the exact display size. A correction that works at 48px may look exaggerated at 16px because antialiasing and pixel snapping change the silhouette. Compare at least the production sizes and both light and dark backgrounds.

For icon-text controls, optical centering does not replace baseline alignment. First verify line-height, inline formatting context, flex alignment, and icon-label gap.

## Sources

- Apple, [Icons](https://developer.apple.com/design/human-interface-guidelines/icons)
- Apple, [Designing Glyphs](https://developer.apple.com/videos/play/wwdc2017/823/)
- Apple, [SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)
- Material Design, [System icons](https://m1.material.io/style/icons.html)
- IBM Design Language, [UI icon design](https://www.ibm.com/design/language/iconography/ui-icons/design/)
- Proffitt, Thomas, and O'Brien, [The roles of contour and luminance distribution in determining perceived centers within shapes](https://pubmed.ncbi.nlm.nih.gov/6844093/)
- W3C SMuFL, [Glyphs with anchors](https://www.w3.org/2019/03/smufl13/specification/glyphswithanchors.html)
