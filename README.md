# Diashow Studio

Photo and video slideshows for Windows, modelled on the slideshow feature of macOS Photos: pick photos and videos, choose a theme and music, and export an MP4.

## Features

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
  - Drag a filmstrip card's right edge to set its time; double-click the edge for automatic again.
  - Day titles from the capture date, or chapters from folder names ("2_Sonntag Unser erster Tag" becomes "Sonntag" with the subtitle "Unser erster Tag").
  - Sort by capture date.
  - Text style for titles and captions: font, size, colour, position and capitals.
  - Video trimming: drag the in and out handles over a strip of frames from the clip, then preview the cut. "Videos at most" (Timing tab) cuts long clips down automatically.
  - Shortcuts: press F1 for the list. Short tips introduce the main steps on first use.
- **Automatic help:**
  - Offline face detection (MediaPipe BlazeFace, run on the whole picture and on tiles) keeps faces inside crops and gives Ken Burns a target.
  - "Change slides on the beat" puts every slide change on a beat of the music.
  - "Find rejects" lists blurry photos and near-duplicates (difference hash); of each duplicate group the sharpest photo stays.
- **Export presets:** YouTube 1080p/4K, Instagram Reel 9:16, Instagram 1:1, WhatsApp, TV/projector. Another aspect ratio relays the show.
  - 4K exports first prepare full-resolution versions of videos that only have a 1080p proxy.
- **Large shows:** the filmstrip renders only what is visible, layout results are cached, and processing updates are batched.
- **Speed:**
  - Exports run about 3x faster than before: the graphics card converts each frame to YUV, and the next frame renders while the last one is read back. A 220-second show exports in 55 s at 1080p with NVENC, at the same quality.
  - HDR phone videos are tone-mapped on the graphics card (libplacebo on Vulkan), falling back to the CPU automatically.
  - Preview quality (High, Medium, Low) is set in Settings, for slower laptops; exports are not affected.
- **Projects:**
  - Automatic backups: before a save, the previous version is kept (at most every 10 minutes, the last 20). Restore them with "Restore an older version…" in the "⋯" menu.
  - Missing originals (moved folder, new drive letter) are found again with "Search a folder…" in the banner.
  - Settings show how much cache each part uses, with buttons to remove unused files, 4K versions or video proxies.
- **Pack project:** copies the project with all photos, videos and music into one folder for a USB stick or another PC. "Open project…" or a double-click on the .dshow loads it there.
- **Presentation mode:** the show runs fullscreen on a second display (projector) while the laptop shows the current and next slide, time and controls.
- **Kiosk mode:** choose a project in Settings, and the app starts straight into it, playing in a loop. The screen stays on while a show plays.
- **Timing like Photos:**
  - "Fit to music" or a custom total length.
  - "Play selected for" sets the time for a single slide.
  - Classic has a free choice of transition with speed and direction: Dissolve, Fade through black or white, Push, Wipe, Move in, Reveal, Cube, Flip, Zoom or Droplet.
- **Ken Burns:** set the start and end framing per photo by dragging and zooming a frame.
- **Music:** your own files (MP3, M4A/AAC, WAV, FLAC, OGG, Opus, ALAC, WMA, AIFF) in a playlist you can reorder. It supports crossfades, fades and repeat.
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

## Supported media

| Source | Photos | Videos |
|---|---|---|
| iPhone | HEIC (tiled), JPEG, ProRAW DNG, Live Photos | MOV HEVC 10-bit HDR (HLG / Dolby Vision), H.264, ProRes |
| Android | JPEG / Ultra HDR, HEIC, DNG, Motion Photos | MP4 H.264 / HEVC, AV1, VP9 |
| Sony Alpha / ZV / FX | JPEG, HIF (10-bit 4:2:2), ARW | XAVC S / HS / S-I (H.264 / HEVC, 4:2:2 10-bit, LPCM), AVCHD (MTS / M2TS) |
| Other | PNG, WebP, AVIF, GIF, TIFF, BMP, JPEG XL | MKV, WebM, AVI, 3GP, M4V, MPG, WMV, MXF |

Videos Chromium can't play directly are converted in the background into an H.264 proxy (max. 1080p). That covers HEVC 4:2:2, H.264 10-bit, HDR (tone-mapped to SDR), rotated phone videos and AVCHD. Sidecar files (XML, THM, AAE, …) are ignored, and RAW+JPEG pairs use the JPEG.

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
npm run dist         # Windows installer and portable exe in dist/
```

GitHub Actions (`.github/workflows/ci.yml`) runs the type check, the unit tests and the end-to-end test on Windows for every push.

`npm run test:media` writes generated sample files (iPhone, Android and Sony-like) to `test-media/`.

## Licence

MIT for the app code. The bundled FFmpeg build is GPL; see `vendor/ffmpeg/LICENSE.txt`. MediaPipe and the BlazeFace model are Apache-2.0; their usage statistics are blocked inside the app. Fonts are under the SIL Open Font License (Inter, Anton, Cinzel, Special Elite, Playfair Display, Barlow Semi Condensed, Nunito Sans, Caveat).
