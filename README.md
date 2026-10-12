# Diashow Studio

Photo and video slideshows for Windows, modelled on the slideshow feature of macOS Photos: pick photos and videos, choose a theme and music, and export an MP4.

**Website:** https://asamedia.github.io/diashow-studio/ (German, with an English version and the handbook online). **Download:** [latest release](https://github.com/ASAMedia/diashow-studio/releases/latest).

## Features

- **Getting started:** on the first start a three-step assistant makes a first show (photos or a folder, theme and music, then play or export). It can be skipped and is also on the home screen ("New slideshow with assistant").
- **Handbook:** F1 (or Handbook in Settings and the "⋯" menu) opens a short handbook in German or English, with screenshots and a searchable table of contents. It is bundled with the app and works offline.
- **Light or dark:** Settings → Appearance offers System (follows Windows), Light and Dark. The preview, fullscreen player and presentation stay dark, because photos look best there.
- **Keyboard and screen readers:**
  - Every control can be reached with Tab and shows a focus ring. Esc closes dialogs and menus, and Tab stays inside an open dialog.
  - The filmstrip is one Tab stop: ←/→ select slides (Shift for a range), Alt+←/→ move a slide, and Shift+F10 opens its menu.
  - Trim handles and song order work with the arrow keys.
  - Buttons, fields and dialogs have names for screen readers, text meets WCAG AA contrast in both themes, and UI animations stay off when Windows' "Animation effects" are off.
- **11 themes.** The seven Photos themes are Ken Burns, Origami, Reflections, Sliding Panels, Vintage Prints, Classic and Magazine. Four more are our own:
  - Retro Film: a Super 8 look.
  - Scrapbook: taped prints on kraft paper with handwritten captions.
  - Snapshots: instant photos that land on a wooden table and pile up.
  - Shatter: each picture breaks into shards that reveal the next.
  - Multi-photo themes group photos into layouts automatically. You can split a group or join photos into one slide.
  - Magazine follows a reference show exported from Photos: background #EDF2EE, equal margins and gutters, and 1 to 6 photos per slide on measured grids. Cells fade in one after another.
    - Text slides become white captions at the bottom right of the next slide, and the title sits on the first slide.
    - Unlike Photos, there are no half-empty slides: a lone portrait photo is paired with the next photo.
  - Cropped layouts (Magazine, Origami, Sliding Panels, Classic in fill mode, Retro Film) let you drag each photo or video inside its cell in the preview, zoom it with the mouse wheel and reset it with a double-click. You can also choose the layout per slide.
  - Free collage: with the "Free" layout, the photos of a slide can be placed by hand. Drag one to move it, drag its corner to resize it (its shape stays) and turn it with the knob. Light themes show them as prints with a white border.
  - Crop or whole picture: "Crop photos to fill" sets the default for the show. Each photo or video can override it with "Crop to fill" or "Whole picture", from the Slide tab or the toggle in its cell in the preview.
    - In Magazine a whole picture sits on the paper; the darker themes put it on a blurred copy of itself.
  - Magazine puts videos into its grids too: several clips play side by side, and the slide lasts as long as the longest clip. Only the first clip is heard unless you switch others on.
  - You decide which photos and videos form a slide:
    - Drag one slide onto another, or Ctrl+click several slides and choose "Combine into one slide".
    - Add or remove items with +/− in the Slide tab, or take a single item out of a slide.
  - Every transition in a show has the same length; slides are kept long enough for it.
- **Colour looks:** Natural, Vivid, Warm, Cool, Dramatic, Faded, Mono and Noir. A look changes only the photos and videos, never the theme's paper, backgrounds or text.
- **Editing:**
  - Undo and redo (Ctrl+Z / Ctrl+Y).
  - Rotate, straighten and crop like in Photos: **Edit** in the Slide tab (or the slide's menu) turns a photo or video by 90°, straightens it up to ±45° (zoomed so no corners are empty) and crops it freely or to Original, 1:1, 4:3, 3:2, 16:9 or 9:16. Ctrl+R turns all selected photos left.
    - The edit belongs to the photo: every slide, layout, Ken Burns move, thumbnail, presentation and export uses it.
    - Pixelated faces stay on the same faces. The edit is a mapping of texture coordinates in the shader (`src/shared/mediaEdit.ts`), and faces and pixelated areas stay in the coordinates of the original.
  - Light and colour, like in Photos: brightness, contrast, warmth and saturation (−100 to +100). They are in the edit view's **Light and colour** tool and in the Slide tab, for one photo or video or for all selected ones; no automatic enhancement.
    - A drag previews live and is one undo step. The adjustment belongs to the photo and comes before the slideshow's colour look.
    - It is one per-pixel step in the shader (`src/shared/adjust.ts`, with the same math in TypeScript for thumbnails). It works on the already pixelated picture, so pixelated faces stay pixelated.
  - Drag a filmstrip card's right edge to set its time; double-click the edge for automatic again.
  - Day titles from the capture date, or chapters from folder names ("2_Sonntag Unser erster Tag" becomes "Sonntag" with the subtitle "Unser erster Tag").
  - Sort by capture date.
  - Text style for titles and captions: font, size, colour, position and capitals.
  - Animated titles for the show title and chapter slides: handwriting that writes itself, a typewriter, or a big word rising from a line. Each text slide can also have its own style, including rolling end credits ("Add end credits" in the "⋯" menu).
  - Video trimming: drag the in and out handles over a strip of frames from the clip, then preview the cut. "Videos at most" (Timing tab) cuts long clips down automatically.
  - Slow motion and time lapse per clip (0.25× to 8×). Between 0.5× and 2× the sound plays along with its pitch kept; outside that range the clip is silent.
  - Text boxes anywhere on a slide: drag them in the preview and double-click to type. Each box has its own font, size, colour, rotation, and a shadow, dark band, white card or speech bubble behind it.
  - Several slides at once: Shift+click selects a range, Ctrl+click adds single slides, Ctrl+A selects all. The Slide tab then sets their duration, framing, clip speed, video sound and Live Photo motion together, pixelates their faces, or leaves them out of the show.
  - Shortcuts: the list is in the handbook (F1) and in Settings. Short tips introduce the main steps on first use.
- **Review ("Sichten"):** a grid of every photo and video for going through a big import with the keyboard.
  - X leaves an item out of the show and brings it back; it stays in the project.
  - 1–5 give stars, and the Space bar shows the item large.
  - Filters: in the show, left out, star rating, or "blurry & duplicates".
  - "Only n+ stars in the show" keeps just the best.
- **Privacy:** faces can be pixelated, e.g. for pupils without photo consent.
  - In "Pixelate faces…" you click detected faces or drag out any area.
  - When the editor opens, it searches the photo again with a fine tile grid, so small faces at the back of group photos are found too.
  - Videos: the editor shows a frame from the middle of the clip (a slider picks another one). A clicked face is followed through the whole clip; areas you drag out apply to the whole clip.
  - "Pixelate this person everywhere" (the person button on a face): the face is recognised in every photo and video of the show and pixelated there too. The people list shows each person's matches; a wrong match is corrected with ✕.
  - "Check faces…" before the export (optional) lists the slides whose detected faces are not pixelated.
  - The pixelation sits on the picture itself, so it follows crops and Ken Burns moves and appears in the preview and the export.
  - Faces are analysed in the background in Web Workers (photos first, then a frame every 0.5 s of each video), paused while the show plays, exports or presents.
  - **Clean up after the project** ("⋯" menu, the eraser on a slideshow on the home screen, or Settings → Privacy) lists with their sizes what the app keeps for a slideshow and deletes what you pick, for good:
    - face data;
    - photos and videos pupils uploaded (all, or only those not in the show);
    - the cache, older versions and finished export jobs.

    Face data leaves the project, its older versions and the cache. Everything that is pixelated stays pixelated, because marked people become fixed areas, but new photos are no longer recognised automatically. Your own photos, videos, music and exported videos are never touched.
  - **Deletion date:** in 1, 3, 6 or 12 months or on a date (also offered after an export). When it comes, the slideshow on the home screen gets a hint and a banner says "Deletion date reached: clean up?", with "Remind me in a month".
  - Deleting a slideshow asks whether its cache, uploads and finished export jobs go too.
- **Automatic help:**
  - Offline face detection (MediaPipe BlazeFace, run on the whole picture and on tiles) keeps faces inside crops and gives Ken Burns a target.
  - "Change slides on the beat" puts every slide change on a beat of the music.
  - "Find rejects" lists blurry photos and near-duplicates (difference hash); of each duplicate group the sharpest photo stays.
    - It also finds the same video clip twice, e.g. the original and a copy forwarded through WhatsApp: same length and matching frames at 10 % and 60 %. The copy with the most pixels and the highest bit rate stays.
  - "Reduce shake" per clip: shaky phone videos are stabilised in the background (FFmpeg vid.stab, zoomed 6 % so no edges show). The preview and the export then use the steady version.
- **Export presets:** YouTube 1080p/4K, Instagram Reel 9:16, Instagram 1:1, WhatsApp, TV/projector. Another aspect ratio relays the show.
  - 4K exports first prepare full-resolution versions of videos that only have a 1080p proxy.
  - Chapters: the MP4 gets the show title and every chapter slide (also one shown as a caption) as chapter marks, so players such as VLC or QuickTime jump straight to "Tuesday" (option "Chapters as jump marks", on from two chapters). "Copy chapters" in the export dialog or the finished export puts the list on the clipboard as "0:00 Title" lines for a YouTube description.
- **Export queue:** exports run in the background, one after another, while you keep editing. The title bar shows the progress.
  - Each export is a snapshot of the show, so later edits don't change it.
  - A hidden window renders exports in 30-second parts. After a crash or a restart the export continues from the last finished part ("Continue" in the queue).
  - The PC doesn't go to sleep while an export runs.
- **Large shows:** the filmstrip renders only what is visible, layout results are cached, and processing updates are batched.
- **Speed:**
  - Exports run about 3x faster than before: the graphics card converts each frame to YUV, and the next frame renders while the last one is read back. A 220-second show exports in 55 s at 1080p with NVENC, at the same quality.
  - 4K: the same show took 429 s before and 175 s now. Besides the YUV frames, NVENC now uses its p4 preset: the same quality as p5, but 2.5× faster for H.264 at 4K, where the encoder had become the limit.
  - HDR phone videos are decoded, rotated and scaled on the graphics card (libplacebo on Vulkan), falling back to the CPU automatically. PQ is tone-mapped there too. HLG (iPhone, Pixel) gets the CPU's tone curve at proxy size, so its proxy looks the same with or without a graphics card, at half the CPU time. Rotated SDR videos that the graphics card decodes get their proxies there too.
  - Importing is about 4× faster. A folder of 625 phone photos and videos (17 GB) went from "everything ready" after 558 s to 130 s. Every thumbnail now appears within about 20 s, and every photo is ready after about 66 s.
    - Thumbnails come first, then the rest in show order. What the viewer, the filmstrip and the review grid show goes ahead of everything else.
    - Display images, video sound and proxies run side by side, each on its own resource (CPU, disk, graphics card).
    - Duplicate and sharpness analysis waits until every item is usable.
  - Preview quality (High, Medium, Low) is set in Settings, for slower laptops; exports are not affected.
  - Laptops with two graphics chips: the app renders on the high-performance one. Chromium alone would pick the integrated chip, and every exported frame would then travel to the other chip for encoding. On an Iris Xe + RTX 4070 laptop a 220 s show exported in 4K in 289 s instead of 419 s, and in 1080p in 58 s instead of 64 s. Settings → Graphics chip → Power saving leaves the choice to Windows.
  - PCs with only Intel graphics (e.g. school PCs) export with Quick Sync at the same quality as NVENC: H.264 uses look-ahead ICQ, HEVC lower quality values (calibrated by SSIM against a near-lossless export). Rotated H.264 phone videos get their proxies on Intel's GPU too; HDR proxies decode HEVC in software there, because Intel's Vulkan driver doesn't decode 10-bit HEVC.
  - System check (in Settings) for other PCs, such as a school PC without NVIDIA. It shows:
    - the graphics card, WebGL and a real test encode with each hardware encoder;
    - HEVC playback, GPU tone mapping, CPU, memory and free disk space;
    - a short export benchmark.
    Every item comes with a plain verdict, and "Copy report" copies a text report.
- **Projects:**
  - Automatic backups: before a save, the previous version is kept (at most every 10 minutes, the last 20). Restore them with "Restore an older version…" in the "⋯" menu.
  - Missing originals (moved folder, new drive letter) are found again with "Search a folder…" in the banner.
  - A project made elsewhere that points to network shares (`\\host\share`) doesn't open those files until you allow it in a banner, because Windows would sign in to that host with your account. Shares you import from yourself are trusted automatically.
  - Settings show how much cache each part uses, with buttons to remove unused files, 4K versions or video proxies.
  - Damaged files: every project is checked when it opens (also packed ones). Broken or unknown parts are dropped or repaired, and a notice says what changed; the file as it was stays as a backup. A file that can't be read at all (e.g. cut off by a power loss) is listed on the home screen with "Repair…": rescue what is readable, or take one of its backups. The damaged file is kept.
  - The project format has a version and a migration chain (`src/main/projectSchema.ts`); a project saved by a newer version is refused with a hint to update instead of being opened half.
- **Share over Wi-Fi** ("⋯" menu), local network only, no internet:
  - Collect photos: the laptop shows a QR code. Pupils open a page on their phones, enter their name if they like and upload photos and videos.
    - Files are stored in `Documents\Diashow Studio\Uploads\<project>\<name>\`.
    - In the show they are sorted into their day by capture time. A show with day titles gets a new title for a day that wasn't there yet. They can also go after the selected slide instead.
  - Hand out the video: offered files (e.g. a finished 720p export from the queue) can be watched and saved on the phones.
  - The server only runs while the dialog is open and only answers links with a random token.
  - On first use Windows asks whether to allow network access. On guest Wi-Fi that keeps devices apart, the Windows mobile hotspot helps.
  - Networks that give every device a public address (eduroam and other campus Wi-Fi) work too. Such an address is marked "public", comes after private ones, and the dialog warns while it is used: the server may be reachable from outside the Wi-Fi, so the link should only go to the class and the server should be stopped after use.
- **Pack project:** copies the project with all photos, videos and music into one folder for a USB stick or another PC. "Open project…" or a double-click on the .dshow loads it there.
- **Archive as ZIP** ("⋯" menu, or the archive symbol on a slideshow on the home screen): one ZIP file for the school archive with everything to open, change and play the show again on any PC:
  - the project (as packed), the original photos and videos, the music or theme song, finished exports if wanted;
  - a `LIESMICH.txt` / `README.txt` with the contents, how to open it and the deletion date.

  The dialog lists each part with its size, the total and the free space, and warns on FAT32 sticks for archives over 4 GB. Left-out photos go in only on request, and face data is left out by default (pixelation stays).

  The ZIP writer streams with ZIP64 (`src/main/archive/zip64.ts`): media are stored, text is deflated, and names are UTF-8. It writes to a temp file, reads it back with a CRC check, then puts it in place. To open an archive, extract it and open the `.dshow`.
- **When something goes wrong:**
  - Error messages say what happened and what to do (FFmpeg missing, disk full, file locked or missing, unreadable file, export encoder, blocked network port, damaged project), with the technical message under "Details".
  - The app keeps an error log in `%APPDATA%\Diashow Studio\logs` (a few files of 2 MB): start, versions and graphics card, errors of the main process and the windows, crashes. Paths are shortened to `%USERPROFILE%`, and pupils' names in upload folders become `<name>`; no media content, face data or share links.
  - "Report a problem…" (Settings → Troubleshooting, and About) shows what will be sent, offers the diagnostics package first, and opens the bug form on GitHub with the app version, Windows version and graphics card filled in. The app opens only pages of its own GitHub project in the browser.
  - "Create diagnostics package…" (Settings) shows every file it would contain and then saves a zip to e-mail: logs, system check, settings, versions, the export queue's states and a summary of the open project made of counts, formats and size classes only (no names, captions or paths of the photos).
- **Security:** the windows run sandboxed with context isolation and a strict CSP, can't navigate away from the app, open other windows, use camera, microphone or location, or reach the internet; IPC only answers the app's own page; `dsmedia://` serves photos, videos and music only; FFmpeg only reads existing local files. The packaged exe can't be run as Node (Electron fuses).
- **Presentation mode:** the show runs fullscreen on a second display (projector) while the laptop shows the current and next slide, time and controls.
- **Kiosk mode:** choose a project in Settings, and the app starts straight into it, playing in a loop. The screen stays on while a show plays.
- **Timing like Photos:**
  - "Fit to music" or a custom total length.
  - "Play selected for" sets the time for a single slide.
  - Classic has a free choice of transition with speed and direction: Dissolve, Fade through black or white, Push, Wipe, Move in, Reveal, Cube, Flip, Zoom or Droplet.
- **Ken Burns:** set the start and end framing per photo by dragging and zooming a frame.
- **Music:** your own files (MP3, M4A/AAC, WAV, FLAC, OGG, Opus, ALAC, WMA, AIFF) in a playlist you can reorder. It supports crossfades, fades and repeat.
  - Theme music, like in Photos: each theme has three songs, and a new slideshow plays the first one right away.
    - A music library adds songs by mood (calm, cheerful, festive, emotional, upbeat, nostalgic, Christmas), some of them for no theme, e.g. a festive march for a graduation or carols for the school Christmas party. 38 songs in all, at most 2:30 each (they loop in long slideshows).
    - The songs are CC0 or public domain, so they are free to use, also in shared videos, without credit. Sources and licence statements are in `resources/theme-music/SOURCES.md`.
    - Your own music replaces the theme song. The Music tab switches it off or chooses another song: of the theme, of another theme or from the library, filtered by mood, each with a listen button. "Add to my music" puts a bundled song into the playlist as a song of your own (trim, chapter music).
    - Long slideshows loop the song with a crossfade, and "Fit to music" ignores a lone theme song.
  - Song sections: drag the start and end of each song over its waveform (scissors button), e.g. to skip a long intro, and listen to the result.
  - Music per chapter: each song can play in the whole show or from a chapter's text slide on (e.g. its own songs for each day).
    - With "Fit to music", every chapter lasts as long as its songs.
    - At the change the old songs fade out while the new ones start.
    - Beat sync follows each chapter's own songs.
  - "Even out loudness" brings songs and video sound to the same level (−16 LUFS).
  - The audio lane shows the songs' waveforms and beat markers.
- **Video sound and ducking:** video clips play with their sound, and the music is lowered automatically while a clip with sound plays.
  - You set the level and ramp time, plus a per-clip override and mute.
  - The audio lane under the filmstrip shows the resulting music volume.
- **Live Photos** (iPhone HEIC + MOV) and **Motion Photos** (Android): you choose per slide whether the motion part plays.
- **Preview** in the editor, with a filmstrip that scrolls along with the playhead, a **fullscreen player** (Space, arrow keys, Esc), and **export** to MP4 (H.264/HEVC) up to 4K.
  - Export uses NVENC, Quick Sync or AMF when available.
  - Aspect ratios: 16:9, 4:3, 1:1, 9:16.
- German and English UI, following the Windows language.
- **About and updates:** "About Diashow Studio" (Settings) shows the versions of the app, Electron, Chromium and FFmpeg, the licences of everything bundled, and checks for a new release. At start the app asks GitHub at most once a day for the newest release and shows a hint in the title bar; it never installs anything, stays silent offline and can be switched off in Settings.

## Supported media

| Source | Photos | Videos |
|---|---|---|
| iPhone | HEIC (tiled), JPEG, ProRAW DNG, Live Photos | MOV HEVC 10-bit HDR (HLG / Dolby Vision), H.264, ProRes |
| Android | JPEG / Ultra HDR, HEIC, DNG, Motion Photos | MP4 H.264 / HEVC, AV1, VP9 |
| Sony Alpha / ZV / FX | JPEG, HIF (10-bit 4:2:2), ARW | XAVC S / HS / S-I (H.264 / HEVC, 4:2:2 10-bit, LPCM), AVCHD (MTS / M2TS) |
| Other | PNG, WebP, AVIF, GIF, TIFF, BMP, JPEG XL | MKV, WebM, AVI, 3GP, M4V, MPG, WMV, MXF |

Videos Chromium can't play directly are converted in the background into an H.264 proxy (max. 1080p). That covers HEVC 4:2:2, H.264 10-bit, HDR (tone-mapped to SDR), rotated phone videos and AVCHD.

Some videos play as they are, both in the preview and in the export. This was checked in Electron 44 by `e2e/codecs.spec.ts`. They are:
- 8-bit HEVC, where the graphics card decodes it.
- H.264 or HEVC in MKV.
- iPhone videos with spatial audio.

Sony XAVC S (8-bit 4:2:0 with LPCM sound) gets its video stream copied instead of converted. A video's sound is copied as it is when it is AAC.

Sidecar files (XML, THM, AAE, …) are ignored, and RAW+JPEG pairs use the JPEG.

## How it works

- **Main process:** Electron, Node.
  - Media import, metadata via exiftool, and thumbnails and display images via sharp and FFmpeg 9.
  - Video proxies, audio extraction, projects (`Documents\Diashow Studio\*.dshow`) and the export encoder.
- **Renderer:** React UI plus a WebGL2 engine (`src/renderer/src/engine`).
  - The same engine draws the editor preview, the fullscreen player and every export frame, so the export matches the preview.
  - Export decodes video frames frame-exactly with WebCodecs (mediabunny). A shader packs each rendered frame as I420 (BT.709), which is read back asynchronously through pixel buffers and piped to FFmpeg.
  - Where WebCodecs offers a hardware encoder, the renderer encodes itself instead. The main process then recovers each frame's display order from the stream (B-frames) and only muxes it. Electron's software encoder is not used, because its quality stayed too low.
- **Shared logic** (`src/shared`): timeline (slide grouping, durations, transitions) and the audio plan (playlist, crossfades, ducking curves).
  - Pure TypeScript with unit tests. The preview (Web Audio) and the export mixer use the same audio plan.

## Development

```bash
npm install          # also downloads FFmpeg 9.0 (BtbN GPL build) and the face model into vendor/
npm run dev          # start the app with hot reload
npm test             # unit and pipeline tests (generates test media first)
npm run e2e          # build + Playwright end-to-end test with screenshots of every theme
npm run dist         # Windows installer and portable exe in dist/ (writes THIRD_PARTY_NOTICES first)
npm run notices      # vendor/THIRD_PARTY_NOTICES.txt: licences of FFmpeg, fonts, models, theme songs and every bundled npm package
npm run theme-music -- <folder>   # theme songs: resources/theme-music from <theme>.mp3 … files and sources.json (see the script)
npm run site         # rebuilds the generated parts of the website in docs/ (handbook pages, screenshots, icons, link previews)
npm run samples      # the sample trip: CC0 / public-domain photos and clips from Wikimedia Commons in samples/media/ (sources in samples/SOURCES.md)
```

`DIASHOW_GPU=integrated` makes a laptop with two graphics chips behave like a PC with only integrated graphics (rendering, Quick Sync, the integrated Vulkan device, no NVENC or CUDA); `DIASHOW_GPU=discrete` renders on the high-performance GPU. `e2e/exportspeed.spec.ts` (with `DIASHOW_ORIGINALS_DIR`) prints which chip WebGL uses, the encoders, and speed and quality of an export.

The handbook lives in `src/renderer/src/handbook/de.md` and `en.md` (a small Markdown subset, see `handbook/markdown.tsx`). Its screenshots in `src/renderer/public/handbook/<de|en>/` are made from the sample trip (`npm run samples`) by `npx electron-vite build && DIASHOW_HANDBOOK_SHOTS=1 npx playwright test e2e/handbook-shots.spec.ts`; without the samples they fall back to the generated test media. `DIASHOW_DEMO_VIDEO=1 npx playwright test e2e/demo-video.spec.ts` makes the website's demo video (`docs/media/demo.mp4`) with the app from the same trip.

`DIASHOW_UI_REVIEW=1 npx playwright test e2e/ui-review.spec.ts` takes screenshots of every screen and dialog (German and English, light and dark, small and large window) and checks contrast and accessible names; the results are in `test-results/ui-review/`.

The app icon is drawn in `build/icon.svg` (and `build/icon-small.svg` for 16 px); `npm run icon` writes `build/icon.ico`, `build/icon.png` and the favicon of the phone pages from them.

**Releases:** add a section for the version to `CHANGELOG.md`, set the same version in `package.json`, and push a tag `v<version>`. `.github/workflows/release.yml` then runs the type check and unit tests, builds the installer and the portable exe, and publishes them as a GitHub release with that changelog section, `THIRD_PARTY_NOTICES.txt` and the source of the bundled FFmpeg build.

GitHub Actions (`.github/workflows/ci.yml`) runs the type check, the unit tests and most end-to-end tests on Windows for every push, in English and with software WebGL. Tests that need a graphics card (GPU tone mapping, hardware encoders) skip themselves there.

`npm run test:media` writes generated sample files (iPhone, Android and Sony-like) to `test-media/`.

## Licence

MIT for the app code. `THIRD_PARTY_NOTICES.txt` (next to the installed exe, and in the About dialog) lists every bundled licence. The bundled FFmpeg build is GPL-3.0 (BtbN, pinned in `scripts/ffmpeg-build.json`); see `vendor/ffmpeg/LICENSE.txt`. Each release carries the complete source of that exact build: FFmpeg itself, the BtbN build scripts, and every library compiled into it at the exact revision the build used (`ffmpeg-deps-sources-<tag>.tar`, with the manifest `ffmpeg-deps-sources-<tag>.txt` that names each library, its licence, origin and revision; `npm run gpl-sources -- <folder>` collects them). MediaPipe and the BlazeFace model are Apache-2.0; their usage statistics are blocked inside the app. Face recognition uses dlib's face recognition model (public domain, CC0) as converted by face-api.js (MIT), from `@vladmandic/face-api` (MIT), with TensorFlow.js (Apache-2.0). Fonts are under the SIL Open Font License (Inter, Anton, Cinzel, Playfair Display, Barlow Semi Condensed, Nunito Sans, Caveat) and the Apache License 2.0 (Special Elite).
