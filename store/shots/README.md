# Raw captures

Drop each capture here under the file name below and run `node store/build.mjs`.
The build crops and frames it, so the size does not have to be exact — but more
pixels are better, and the listed part must be in shot. PNG only.

Capture with the browser at a comfortable zoom, on a clean profile (no other
extensions in the toolbar, no personal account name or avatar in frame), and a
light page theme so the captures match the light frame around them.

Capture the page content only — the build draws its own browser chrome around it.
The address shown in that chrome is the slot's `url` in `store/build.mjs`; change
it to match whatever page the capture was actually taken on.

## `youtube-picker.png`

Screenshot 1 — "Every quality, right where you watch."

Must be visible:

- The Download button sitting in the action row, next to Like
- The quality picker open: 4K through 144p, MP3, M4A, thumbnail
- Enough of the video and title above it to read as a watch page

Cropping: Capture the browser content area at 1600x1000 or wider. Frame so the action row sits a little above centre; the picker must not be cut off at the bottom.

Framed at 1040x428 and cropped to fill, anchored 50% across and 34% down. That is the slot's `focus` in `store/build.mjs` — change it if the crop lands badly.

## `spotify-album-menu.png`

Screenshot 2 — "Albums and playlists, tagged."

Must be visible:

- An album page with the Download button next to the play controls
- The picker showing a single song as a tagged MP3
- The "Download all" row with its ZIP and one-mix options

Cropping: Portrait-ish crop, roughly 4:3. Keep the album cover and title in shot for context; the open menu should sit in the middle third.

Framed at 700x496 and cropped to fill, anchored 50% across and 40% down. That is the slot's `focus` in `store/build.mjs` — change it if the crop lands badly.

## `webpage-png.png`

Screenshot 3 — "Save any part of a page as an image."

Must be visible:

- The element picker highlighting a post, with its size readout
- The "Save as PNG" affordance visible
- The finished PNG beside it, if it fits without crowding

Cropping: Roughly 4:3. The highlighted element should fill the middle; leave a little page around it so it is clear this is a live page.

Framed at 640x550 and cropped to fill, anchored 50% across and 0% down. That is the slot's `focus` in `store/build.mjs` — change it if the crop lands badly.

## `gif-record.png`

Screenshot 4 — "Record a scrolling GIF of a thread."

Must be visible:

- A thread or feed mid-scroll, with no hover cards or pop-ups open
- No readable usernames (blur them), and no mouse pointer
- No extension UI: the build draws the recording outline and pill over it

Cropping: Exactly 700x496 or a larger image of the same aspect, so `recording.area` lines up. The current one is frame 13 of gif-record-sample.gif, made by store/gif-frame.py.

Framed at 700x496 and cropped to fill, anchored 50% across and 50% down. That is the slot's `focus` in `store/build.mjs` — change it if the crop lands badly.

## `popup-paste.png`

Screenshot 5 — "Paste any link. Pick a quality."

Must be visible:

- The toolbar popup with a link already pasted in the field
- The options it found listed underneath, with qualities
- No browser chrome around it — the popup only

Cropping: Capture the popup on its own, at 2x if possible, then trim to its rounded edge. Portrait, about 400x620.

Framed at 430x660 and cropped to fill, anchored 50% across and 0% down. That is the slot's `focus` in `store/build.mjs` — change it if the crop lands badly.

## `marquee-detail.png` (optional)

Not used yet: the marquee draws its own close-up of the Download button and the
quality picker. A real close-up of the button in a site's action row could
replace it later.
