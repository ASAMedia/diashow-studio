# Changelog

All notable changes to Diashow Studio. Versions follow [Semantic Versioning](https://semver.org). The release workflow publishes the section of a version as its release notes.

## [1.0.0] - 2026-10-11

The first public version: photo and video slideshows for Windows, modelled on the slideshow feature of macOS Photos. German and English, works offline.

**Downloads**

- `Diashow.Studio-Setup-1.0.0.exe`: installer (no admin rights needed).
- `Diashow.Studio-1.0.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build (GPL).

**Getting started**

- A three-step assistant on first start: photos or a folder, a theme and music, then play or export.
- A built-in handbook (F1) in German and English, with a searchable table of contents.
- "Play a folder" shows a slideshow straight away.
- Light or dark UI (Settings → Appearance; System follows Windows). The preview and fullscreen stay dark.
- Full keyboard use: focus ring, Esc and Tab in dialogs and menus, arrow keys in the filmstrip and the inspector; UI animations stay off when Windows' "Animation effects" are off.
- A new app icon.

**Themes and looks**

- 11 themes: the seven Photos themes (Ken Burns, Origami, Reflections, Sliding Panels, Vintage Prints, Classic, Magazine) and Retro Film, Scrapbook, Snapshots and Shatter.
- Multi-photo layouts, chosen per slide; drag, zoom and crop photos in their cells; a free collage layout.
- Eight colour looks (Natural, Vivid, Warm, Cool, Dramatic, Faded, Mono, Noir).
- Classic offers ten transitions with speed and direction; Ken Burns start and end framing per photo.

**Editing**

- Undo and redo, slide durations by dragging, day titles from the capture date or chapters from folder names, sorting by date.
- Text style for titles and captions, animated titles (handwriting, typewriter, big date), end credits and free text boxes.
- Video trimming over a frame strip, slow motion and time lapse, Live Photos and Motion Photos.
- Several slides at once (Shift/Ctrl+click, Ctrl+A) and grouping of photos into slides.
- Review grid ("Sichten") for big imports: stars, leave out, filters, blurry photos and duplicates.

**Music**

- Own music files in a playlist with crossfades, fades and repeat; song sections; music per chapter.
- "Fit to music", beat sync, loudness levelling and automatic ducking under video sound.

**Privacy**

- Pixelate faces by click or area, in photos and videos (faces are followed through the clip).
- "Pixelate this person everywhere" recognises a person in the whole show; "Check faces" before the export.
- Face detection and recognition run offline on the computer.

**Export and sharing**

- MP4 (H.264/HEVC) up to 4K with presets for YouTube, Instagram, WhatsApp and TV; hardware encoders (NVENC, Quick Sync, AMF).
- Export queue in the background that continues after a crash or restart.
- Share over Wi-Fi: pupils upload photos from their phones via QR code, and the finished video can be handed out the same way (local network only).
- Presentation mode for a projector, kiosk mode, packing a project with all media for another PC.

**Settings and help**

- Preview quality, cache management, kiosk mode and a system check for school PCs.
- About dialog with versions and licences; an optional hint when a new version is on GitHub (at most once a day, can be switched off; no automatic updates).
- Error messages that say what to do; an error log and a "Create diagnostics package" button (Settings) whose contents are shown before saving: no photos, names or face data.

**Reliability and security**

- Projects are checked when they open: broken parts are repaired or dropped with a notice, the old file stays as a backup. A damaged project (e.g. after a power loss) can be repaired from the home screen: rescue what is readable or take a backup. Projects from a newer version are refused with a hint to update.
- Sharing also works on networks with public addresses (eduroam), with a warning to give the link only to the class.
- A project made elsewhere that points to network shares (`\\host\share`) opens those files only after you allow it, because Windows would sign in to that host with your account.
- Sandboxed windows, a strict content security policy, no internet access from the app's pages, IPC and file access limited to what the app needs, Electron fuses on the packaged exe.
