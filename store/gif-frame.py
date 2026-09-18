"""Makes store/shots/gif-record.png from the real recording store/shots/gif-record-sample.gif.

Uses frame 13 (the frames with a user's hover card open are skipped), and:
  - patches the mouse pointer out with frame 11, which shows the same post 38px lower
    (in frame 13 that post is in its hover state, so the patch is tinted to match);
  - blurs the usernames, including the viewer's own name under USER FLAIR in the sidebar;
  - crops away the red line at the right edge and the cut-off cards at the top, at the
    700x496 aspect of the screenshot frame.
The recording outline and pill are not in the frame: store/templates/screenshot.js draws them.

  ffmpeg -i store/shots/gif-record-sample.gif -vsync 0 <dir>/f%02d.png
  python store/gif-frame.py <dir> store/shots/gif-record.png

Needs Pillow and numpy.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

frames, out = sys.argv[1], sys.argv[2]
base = Image.open(f'{frames}/f13.png').convert('RGB')
donor = Image.open(f'{frames}/f11.png').convert('RGB')

# 1. The pointer, over the username of the third post and the title below it.
SHIFT = 38                    # frame 11 shows this post 38px lower
HOVER_TINT = (2, 13, 3)       # hovered post background minus the plain one
x0, y0, x1, y1 = 66, 398, 94, 426
patch = np.asarray(donor.crop((x0, y0 + SHIFT, x1, y1 + SHIFT))).astype(int) + np.array(HOVER_TINT)
base.paste(Image.fromarray(np.clip(patch, 0, 255).astype('uint8')), (x0, y0))

# 2. Usernames.
for box in [
    (42, 45, 118, 61),     # first post
    (42, 260, 89, 276),    # second post
    (42, 395, 98, 411),    # third post
    (586, 310, 684, 328),  # the viewer's own name, under USER FLAIR
]:
    base.paste(base.crop(box).filter(ImageFilter.GaussianBlur(3.2)), box[:2])

# 3. Crop to the frame's aspect (700x496), clear of the red line at x=792.
W = 790
H = round(W * 496 / 700)      # 560
TOP = 10
base.crop((0, TOP, W, TOP + H)).save(out, optimize=True)
print(out, f'{W}x{H}')
