# Paints out the window's resize handle iPadOS 26 draws in a landscape iPad's bottom right corner,
# with the black of the same row just left of it.
#   ipadcorner.py in.png out.png
import sys
import numpy as np
from PIL import Image

a = np.array(Image.open(sys.argv[1]).convert("RGB"))
h, w, _ = a.shape
x0, y0 = w - 62, h - 55
for y in range(y0, h):
    a[y, x0:] = a[y, x0 - 6]
# The handle's top end, right of the message box's last button.
for y in range(h - 64, y0):
    a[y, w - 28:] = a[h - 1, w - 1]
Image.fromarray(a).save(sys.argv[2])
