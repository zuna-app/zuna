# Puts the bottom of a capture with nothing under the tab bar (clean) onto a capture of the full list
# (full), from just above the bar down, so the glass shows no avatar it sits over.
#   cleanbar.py full.png clean.png out.png
import sys
import numpy as np
from PIL import Image

full = Image.open(sys.argv[1]).convert("RGB")
clean = Image.open(sys.argv[2]).convert("RGB")
c = np.asarray(clean).astype(float)
f = np.asarray(full).astype(float)
h, w, _ = c.shape
top = h - 400
ys = np.nonzero(c[top:].max(axis=2).max(axis=1) > 14)[0]
y0 = ys.min() + top
print("bar top", y0)
feather = 10
alpha = np.clip((np.arange(h) - (y0 - 4 - feather)) / feather, 0, 1)[:, None, None]
Image.fromarray((f * (1 - alpha) + c * alpha).round().astype(np.uint8)).save(sys.argv[3])
