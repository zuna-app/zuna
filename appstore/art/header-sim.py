# Shows a header as App Store Connect's iPhone preview did: about 3240 px of its width at 616 px, under the status
# bar, with the back and share buttons over its top corners.
#   python header-sim.py <header.png> <out.png>
import sys
from PIL import Image, ImageDraw
art = Image.open(sys.argv[1]).convert("RGB")
scale = 616 / 3240
crop = art.crop((300, 0, 3540, art.height)).resize((616, round(art.height * scale)), Image.LANCZOS)
top = 108
sim = Image.new("RGB", (616, top + crop.height), (12, 12, 14))
sim.paste(crop, (0, top))
draw = ImageDraw.Draw(sim)
for x in (60, 555):
    draw.ellipse((x - 38, top + 24 - 38, x + 38, top + 24 + 38), fill=(205, 205, 210))
sim.save(sys.argv[2])
