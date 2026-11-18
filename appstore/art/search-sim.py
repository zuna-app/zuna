# Shows search artwork as App Store Connect's iPhone preview did: its whole width at 556 px, its top 2017 px.
#   python search-sim.py <search.png> <out.png>
import sys
from PIL import Image
art = Image.open(sys.argv[1]).convert("RGB")
art.crop((0, 0, 3840, 2017)).resize((556, 292), Image.LANCZOS).save(sys.argv[2])
