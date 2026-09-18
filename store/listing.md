# Chrome Web Store listing — Just download it

Everything a store submission needs, in one place. Images live in `store/assets/`
(built by `store/build.mjs`); the raw screenshots they are made from are in
`store/shots/`.

> **Before you submit:** Google's Developer Program Policies don't allow
> extensions that download YouTube videos, and reviewers do enforce it. Options:
> publish with YouTube support removed, publish **unlisted** and share the link,
> or keep distributing the unpacked folder / a `.crx` from your own site. The
> copy below has a YouTube-free variant of the short description for that case.

## Name (45 characters max)

```
Just download it
```

## Short description (132 characters max)

Main (117):

```
Download videos, songs, photos and GIFs from the sites you use, in the quality you pick. Free, and it runs on your device.
```

YouTube-free variant (124):

```
Save videos, songs, photos and web pages as PNG or GIF from the sites you use. Free, no accounts, runs on your device.
```

## Category

Productivity → Tools (secondary: Photos & Video, if a second is offered)

## Detailed description

```
Just download it puts a Download button where you already are.

No converter sites. No pasting links into pages full of ads. No "add dl to the
URL" tricks that stop working a week later. Open a page, click Download, pick the
quality, and the file lands in your Downloads folder.

WHERE THE BUTTON IS
• YouTube — next to the Like button
• YouTube Music, Spotify and Apple Music — next to the play buttons, and beside
  the song in the player bar
• Instagram — in a post's action row, next to Share
• X — in a post's action bar
• Twitch — in the player controls
• TikTok, Facebook, Snapchat and Medal — point at a video and a button appears
• Anywhere else — right-click a photo, video or audio file

WHAT YOU CAN SAVE
• Videos in every quality the site offers, up to 4K, with the sound included
• MP3 or M4A of any song or video, with title, artist, album and cover art
  written into the file
• Photos at their original resolution, carousels and stories, cover art, thumbnails
• Whole albums and playlists: as separate tracks, as one ZIP, or combined into a
  single mix with crossfades
• Any web page, or one part of it, as a PNG image — including parts taller than
  the screen
• A scrolling GIF you record yourself: pick an area, scroll through a comment
  thread, press stop

PASTE A LINK
Click the toolbar button and paste any link. It finds what's there and asks which
quality you want. The progress shows on the toolbar icon, so you can close the
popup.

IT ALL HAPPENS ON YOUR COMPUTER
There is no server. Video and audio are combined, MP3s encoded and GIFs recorded
by your own browser. Nothing you download is sent anywhere, and there is no
account, no sign-up and no ads.

ABOUT SPOTIFY AND APPLE MUSIC
Their own audio is copy-protected and is never touched. For a song you pick, the
extension finds the same recording on YouTube Music and saves that, with the
title, artist, album and cover art filled in. Cover art and the official preview
clips come straight from the source.

FREE
Free, with no paid tier. Suggestions are welcome: peter@peterwild.pw
```

## Screenshots (1280×800, at least one, up to five)

Upload in this order from `store/assets/` (see its README for every field).

1. `screenshot-1-youtube-quality.png` — **YouTube**: the Download button next to
   Like, with the quality picker open showing 4K (2160p) down to 144p, then MP3
   and M4A.
   Caption: "Every quality, right where you watch."
2. `screenshot-2-album-downloads.png` — **Spotify**: an album page with the
   Download button, and the picker showing a song as MP3 with tags and cover,
   plus "Download all 13 as MP3" with its ZIP and one-mix options open.
   Caption: "Albums and playlists, tagged."
3. `screenshot-3-page-to-png.png` — **Save a web page**: the element picker over
   an X post, highlighting it with its size, under the picker bar (Image (PNG) /
   GIF, Visible area, Whole page).
   Caption: "Save any part of a page as an image."
4. `screenshot-4-scrolling-gif.png` — **Scrolling GIF**: a Reddit feed with the
   recorded area outlined and the recording pill under it (0:06 / 1:00,
   Stop & save, Cancel). A frame of a real recording, usernames blurred.
   Caption: "Record a scrolling GIF of a thread."
5. `screenshot-5-paste-a-link.png` — **Paste a link**: the toolbar popup with a
   YouTube link pasted and the qualities it found listed.
   Caption: "Paste any link. Pick a quality."

## Promo images

- Small tile 440×280 (`promo-small-440x280.png`): icon, "Just download it",
  "Videos, songs, photos — where you already are."
- Marquee 1400×560 (`promo-marquee-1400x560.png`): the same name and line, beside
  the Download button in a site's action row with the quality picker open.
- Store icon 128×128 (`icon-128.png`): the extension's own icon.

## Privacy

**Single purpose:** Download media from the page you are on, in the quality you
choose, and save parts of web pages as images or GIFs.

**Permission justifications**

| Permission | Why |
|---|---|
| `downloads` | Saving the file you picked to your Downloads folder, and naming it. |
| `contextMenus` | The right-click items "Just download media" and "Just download web page". |
| `storage` | Your settings (folder, quality preferences) and the state of downloads in progress. |
| `unlimitedStorage` | Large videos are assembled in temporary browser storage before being saved. |
| `offscreen` | Combining video and audio, encoding MP3s and recording GIFs need a document; a service worker can't do it. |
| `scripting` | Adding the Download button to tabs that were already open when the extension was installed or updated. |
| `tabCapture` | Recording the part of the page you selected, when you choose "As a GIF". |
| `declarativeNetRequestWithHostAccess` | Only to set the Origin header on the extension's own API requests to YouTube, which refuses requests from extensions. It never touches your browsing. |
| Host permission `<all_urls>` | The Download button has to work on whatever site you are on, and the file has to be fetched from that site's CDN. |

**Data use disclosures:** no data collected. Nothing is sent to any server the
extension controls; there is no analytics, no account and no remote code. Requests
go only to the site you are downloading from.

## Support links

- Support email: peter@peterwild.pw
- Website / homepage: (optional) peterwild.pw
