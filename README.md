# Diashow Studio

Photo and video slideshows for Windows, modelled on the slideshow feature of macOS Photos: pick photos and videos, choose a theme and music, and export an MP4.

## Features

- **8 themes.** The seven Photos themes are Ken Burns, Origami, Reflections, Sliding Panels, Vintage Prints, Classic and Magazine. Retro Film adds an eighth, a Super 8 look.
  - Multi-photo themes group photos into layouts automatically. You can split a group or join photos into one slide.
  - Magazine follows a reference show exported from Photos: background #EDF2EE, equal margins and gutters, and 1 to 6 photos per slide on measured grids. Cells fade in one after another.
    - Text slides become white captions at the bottom right of the next slide, and the title sits on the first slide.
    - Unlike Photos, there are no half-empty slides: a lone portrait photo is paired with the next photo.
  - Cropped layouts (Magazine, Origami, Sliding Panels, Classic in fill mode, Retro Film) let you drag each photo inside its cell in the preview, zoom it with the mouse wheel and reset it with a double-click. You can also choose the layout per slide.
- **Colour looks:** Natural, Vivid, Warm, Cool, Dramatic, Faded, Mono and Noir.
- **Timing like Photos:**
  - "Fit to music" or a custom total length.
  - "Play selected for" sets the time for a single slide.
  - Classic has a free choice of transition with speed and direction: Dissolve, Fade through black or white, Push, Wipe, Move in, Reveal, Cube, Flip, Zoom or Droplet.
- **Ken Burns:** set the start and end framing per photo by dragging and zooming a frame.
- **Music:** your own files (MP3, M4A/AAC, WAV, FLAC, OGG, Opus, ALAC, WMA, AIFF) in a playlist you can reorder. It supports crossfades, fades and repeat.
- **Video sound and ducking:** video clips play with their sound, and the music is lowered automatically while a clip with sound plays.
  - You set the level and ramp time, plus a per-clip override and mute.
  - The audio lane under the filmstrip shows the resulting music volume.
- **Live Photos** (iPhone HEIC + MOV) and **Motion Photos** (Android): you choose per slide whether the motion part plays.
- **Preview** in the editor, a **fullscreen player** (Space, arrow keys, Esc), and **export** to MP4 (H.264/HEVC) up to 4K.
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
  - Export decodes video frames frame-exactly with WebCodecs (mediabunny) and streams RGBA frames to FFmpeg.
- **Shared logic** (`src/shared`): timeline (slide grouping, durations, transitions) and the audio plan (playlist, crossfades, ducking curves).
  - Pure TypeScript with unit tests. The preview (Web Audio) and the export mixer use the same audio plan.

## Development

```bash
npm install          # also downloads FFmpeg 9.0 (BtbN GPL build) into vendor/ffmpeg
npm run dev          # start the app with hot reload
npm test             # unit and pipeline tests (generates test media first)
npm run e2e          # build + Playwright end-to-end test with screenshots of every theme
npm run dist         # Windows installer and portable exe in dist/
```

`npm run test:media` writes generated sample files (iPhone, Android and Sony-like) to `test-media/`.

## Licence

MIT for the app code. The bundled FFmpeg build is GPL; see `vendor/ffmpeg/LICENSE.txt`. Fonts are under the SIL Open Font License (Inter, Anton, Cinzel, Special Elite, Playfair Display).
