# Just download it

Click **Download** on your favourite sites, paste a link into the toolbar button, or right-click anything and pick **Just download media**. Choose a quality. That's it.

- **Free.** No accounts, no servers, no ads.
- **On your device.** Everything happens in your browser: video and audio tracks are combined, and MP3s encoded, on your computer.
- **Quality you pick.** Every size the site offers, with the best one pre-selected (press <kbd>Enter</kbd>).
- **Any kind of file.** Videos, photos, songs as tagged MP3/M4A, any video's sound as MP3, and parts of web pages as PNG images or GIF recordings.

## What works today

| Site | Where | What you can save |
|---|---|---|
| **YouTube** | **Download** button next to Like, or right-click a video link/thumbnail | MP4 in every quality up to 4K (video and sound combined on your computer), MP3 (converted on your computer), M4A (original AAC audio), and the thumbnail |
| **YouTube Music** | Download buttons in the player bar and on album/playlist pages, or right-click a song | Songs as MP3 or M4A with title, artist, album and cover art written in; whole albums and playlists |
| **Spotify** | Download button next to the play button on songs, albums and playlists, or right-click a song | Full songs as tagged MP3/M4A (found on YouTube Music, since Spotify's own audio is DRM-locked), cover art, and 30-second previews |
| **Apple Music** | Download button next to Play on albums and playlists, or right-click a song | Full songs as tagged MP3/M4A (found on YouTube Music, since Apple's audio is DRM-locked), cover art up to 3000 px, and previews |
| **Medal** | Hover a clip | Clips in every quality |
| **Instagram** | Download icon after **Share** (posts and the Reels viewer), a hover button on videos, or right-click | Photos at original resolution (up to 4096 px), any carousel slide or all of them, reels and videos (1080p *with* sound when Instagram has it), audio only, cover images, stories, highlights, and HD profile pictures |
| **TikTok** | Hover a video: a download button appears in its corner | Videos in every quality TikTok has (H.264 and HEVC), photo slideshows, the sound, and the cover |
| **X** | Download icon in the post’s buttons (posts with media), a hover button on videos | Photos at original size, videos and GIFs in every bitrate |
| **Twitch** | Download button in the player controls on clips and past broadcasts | Clips in every quality; past broadcasts (VODs) in every quality or audio only, assembled into one MP4 on your computer |
| **Facebook** | Hover a video | Videos and reels in HD/SD, and sharper quality when Facebook has it |
| **Snapchat** | Hover a video | Public Stories and Spotlight videos and snaps |
| **Any other site** | Right-click | Images (the largest from `srcset`/`<picture>`, lazy-load attributes and "click to enlarge" links, even under invisible overlays), direct video/audio files, CSS background images, and the page's preview image |
| **Any link** | Toolbar button → paste | Whatever the link points to, on any of the sites above or a direct file link |
| **Any web page** | Right-click → **Just download web page** | Part of the page (or all of it) as a PNG image, or a GIF you record while you scroll |

Any video saved as a plain file also offers an **MP3** of its sound.

Long or 4K videos are processed on your computer, and a progress bubble in the corner shows how far along it is. The finished file lands in Chrome's normal downloads.

## Install

The extension isn't on the Chrome Web Store (the Store doesn't allow YouTube downloaders), so load it directly:

1. Open `chrome://extensions` and switch on **Developer mode** (top right). Leave it on; Chrome disables unpacked extensions when it's off.
2. Click **Load unpacked** and choose the **`extension`** folder inside this project (not the project folder itself).
3. Open YouTube or Instagram. You'll see the Download buttons.

To update after changes, click the reload icon on the extension's card in `chrome://extensions`. Open tabs pick up the new version automatically.

## Use

- **YouTube:** click **Download** (left of Like).
- **Instagram:** click the download arrow after Share. For carousels it opens on the slide you're looking at; pick another slide from the strip or use **Download all**.
- **A link:** click the **Just download it** toolbar button, paste the link (it looks it up as soon as you paste), and pick what to save. You can close the popup; the toolbar badge shows progress. **Download from this tab** uses the page you're on.
- **Anywhere:** right-click a photo or video and choose **Just download it ▸ Just download media**.
- **Part of a page:** right-click and choose **Just download web page ▸ As an image (PNG)** or **As a GIF**. Point at the part you want (scroll or press <kbd>↑</kbd>/<kbd>↓</kbd> to pick a bigger or smaller part) and click. For a GIF, scroll or click around inside the box, then press **Stop & save**.

In the picker, arrow keys move, <kbd>Enter</kbd> saves, <kbd>Esc</kbd> closes. Files go to `Downloads/Just Download It/<Site>/`, for example `Downloads/Just Download It/YouTube/Me at the zoo [jNQXAC9IVRw] 1080p.mp4` or `Downloads/Just Download It/Instagram/username_2026-09-15_DdW9NvLJmhn.jpg`.

Settings (the gear in the toolbar popup): the download folder, a subfolder per site, asking where to save each file, skipping the picker (save the best quality right away), showing the page buttons, and whether to ask Instagram for full quality.

## Your accounts

**Instagram:** the extension asks Instagram for a post's media only when you click, one request at a time, and caches answers for 20 minutes. If Instagram says to slow down, it stops asking for 10 minutes and offers the version shown on the page instead. It's built for saving things one at a time, not bulk scraping, which is what gets accounts flagged.

**Spotify and Apple Music:** their audio is DRM-protected and is never touched. The extension reads the song's title, artist, album and length from their public pages and APIs, finds the same recording on YouTube Music, and saves that, with the tags and cover art written into the file. Check the match shown in the picker; now and then it can pick a different version.

**YouTube:** no cookies and no account are used. The extension asks YouTube's player API for the video's streams the way a YouTube app does. YouTube changes what works every few months; when that happens, `CLIENTS` at the top of `extension/content/handlers/youtube.js` is the one place to update. Age-restricted, private and members-only videos aren't supported.

## How it works

```
right-click ──► content script records what's under the cursor (even beneath overlays)
page button ─┐
menu click  ─┴► site handler resolves every quality ──► quality picker (closed shadow DOM)
pasted link ──► service worker resolver (YouTube, YouTube Music, Spotify, Apple Music,
                Medal, direct files) or, for other sites, the site handler in a muted
                background tab ──► toolbar popup
choose      ──► service worker
                  ├─ plain file ─────────────────────────────────────► chrome.downloads
                  ├─ song (Spotify/Apple Music/YouTube Music) ──► found on YouTube Music ─┐
                  └─ needs processing (combine tracks, MP3, HLS, tags) ◄──────────────────┘
                       offscreen document: Mediabunny reads the streams in ranges, writes
                       to temporary private storage, hands back a blob URL ► chrome.downloads
web page    ──► element picker ──► PNG: captureVisibleTab slices stitched in the page
                               └─► GIF: tab capture stream ► offscreen GIF encoder
```

Handlers live in `extension/content/handlers/` and return items with variants. A variant is either a plain URL or a **job** the offscreen document runs. Sites whose data comes from public APIs also have a resolver in `extension/background/resolvers/`, which both the page handler and pasted links use. Page buttons register through `extension/content/buttons.js`.

```
extension/
  manifest.json
  background/service-worker.js   menus, downloads, jobs, the popup's links and progress
  background/resolvers.js        link resolvers (resolvers/*.js: YouTube, YouTube Music,
                                 Spotify, Apple Music, Medal, direct files)
  background/youtube.js          InnerTube from the service worker, YouTube Music search and song matching
  background/capture.js          screenshots and tab recording for "Just download web page"
  background/net.js              fetch helpers, Origin rewriting for the extension's own requests
  offscreen/                     combining tracks, MP3 encoding, tags, GIF recording
  vendor/                        Mediabunny + its MP3 encoder, gifenc (built by npm run vendor)
  content/core.js                right-click tracking, handler orchestration, progress
  content/picker.js              the quality picker and toasts
  content/capture.js             the element picker and recording controls
  content/buttons.js             Download buttons on supported sites
  content/dom.js                 hit-testing helpers
  content/handlers/*.js          one per site, plus generic.js for everything else
  popup/                         the toolbar popup (paste a link)
  shared/util.js                 filename safety, srcset parsing, URL checks, handler registry
  options/                       settings page
test/
  unit/                          node --test
  e2e/                           Puppeteer + Chrome for Testing against fake YouTube/Instagram/CDN/generic sites
  live/                          the real youtube.com (needs internet)
scripts/                         icon rendering, vendoring Mediabunny
```

## Development

No build step: the `extension` folder is the extension.

```bash
npm install
```

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
node test/live/youtube.mjs
```

- **Unit tests** cover filename safety, URL parsing, and the YouTube and Instagram quality logic.
- **End-to-end tests** load the real extension into Chrome for Testing and serve fake YouTube, Instagram, CDN and generic sites over local HTTPS. They click the page buttons, right-click things, and check the files that land on disk (including that combined MP4s really contain the right video and audio codecs, and that MP3s are MP3s). They need `ffmpeg` and `openssl` on your PATH the first time. Set `HEADFUL=1` to watch.
- **The live test** runs the extension against the real youtube.com. Pass a video id and a quality to try something bigger: `node test/live/youtube.mjs dQw4w9WgXcQ 1080p`.

Other scripts: `npm run icons` re-renders the PNG icons; `npm run vendor` rebuilds `extension/vendor/` after updating Mediabunny.

## Roadmap

| Next | Plan |
|---|---|
| **YouTube Shorts** | A button in the Shorts action bar (right-click already works on Shorts links) |
| **Captures** | MP4 recordings as well as GIFs |
| **Twitch** | Saving the last part of a live stream |
| **Any site** | HLS/streamed videos |

## Credits

Video remuxing and MP3 encoding use [Mediabunny](https://mediabunny.dev) and `@mediabunny/mp3-encoder` (MPL-2.0; license in `extension/vendor/mediabunny.LICENSE.txt`; LAME is LGPL).
