# Changelog

All notable changes to Diashow Studio. Versions follow [Semantic Versioning](https://semver.org). The release workflow publishes the section of a version as its release notes.

## [1.3.0] - 2026-10-13

**Downloads**

- `Diashow.Studio-Setup-1.3.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.3.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Light and colour per photo and video: brightness, contrast, warmth and saturation in the edit view (**Light and colour**) and in the Slide tab, also for several slides at once. Live preview, one undo step per drag; edited slides get a mark in the filmstrip. Pixelated faces stay pixelated, however bright you make the picture.
- More music: every theme now has three songs, and a music library adds songs by mood, among them two festive pieces for graduations (Handel, Sousa) and two Christmas songs. In all there are 38 songs, all CC0 or public domain, at most 2:30 each.
  - The Music tab has a song chooser: the theme's songs first, then the other themes' and the library, filtered by mood, each with a listen button.
  - "Add to my music" puts a bundled song into the playlist like a song of your own.
- Archive as ZIP: a finished slideshow in one file for the school archive or a USB stick. It holds the project, the original photos and videos, the music, exports if wanted, and a read-me with the deletion date. Face data is left out unless you include it, and the archive is checked after writing; archives over 4 GB work too (ZIP64).
- A project double-clicked inside a ZIP file asks you to extract the ZIP first instead of opening without its photos.
- Ctrl+Z / Ctrl+Y also work while a slider has the focus.
- New pictures in the handbook and on the website, made from free sample photos of a class trip (CC0 / public domain, Wikimedia Commons), and a 74-second demo video on the website made with Diashow Studio.

**Fixes**

- Faces in a photo were not searched again when a slideshow was closed during its face search.
- Photos without camera details no longer show their colour profile's maker as the device ("Unknown (saws)").
- The theme previews show "TITLE" and "Sunday" in the English UI.
- The hint in the pixelation editor is no longer cut off in small windows.

## [1.2.0] - 2026-10-12

**Downloads**

- `Diashow.Studio-Setup-1.2.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.2.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including the theme music. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Theme music, like in Photos: every theme has its own song, and a new slideshow plays it right away. The songs are CC0 or public domain, so they are free to use, also in videos you share, without naming anyone.
  - Ken Burns: "Falling stars" (Ondrosik). Origami: "Yippee !" (Loyalty Freak Music). Reflections: "Above the Earth" (TRG Banks). Sliding Panels: "Back In The 80s" (HoliznaCC0).
  - Vintage Prints: "Journey with Russ" (TRG Banks). Classic: Haydn, "The Lark", Menuetto (Musopen String Quartet). Magazine: "Classic" (HoliznaCC0). Retro Film: "Roger Moore" (TRG Banks).
  - Scrapbook: "Red Hair, Blue Sky" (Monplaisir). Snapshots: "Go to the Picnic" (Loyalty Freak Music). Shatter: "Drama" (HoliznaCC0).
- Your own music replaces the theme song; remove it and the theme song comes back. The Music tab switches theme music off or picks another theme's song. Long slideshows loop the song with a crossfade instead of squeezing the photos into its length; beat sync and loudness levelling work as with your own music.
- Existing slideshows stay as they were and can switch theme music on.

**Fixes**

- Saving settings or a slideshow no longer fails with "file is locked" when Windows or a virus scanner holds the file for a moment.
- An export could be refused with "invalid gain point" when a music fade ended on a rounding error.

## [1.1.0] - 2026-10-12

**Downloads**

- `Diashow.Studio-Setup-1.1.0.exe`: installer (no admin rights needed); it updates an installed 1.0 and keeps your slideshows and settings.
- `Diashow.Studio-1.1.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Rotate, straighten and crop photos and videos, like in Photos: **Edit** in the Slide tab or the slide's menu. Turn by 90°, straighten up to ±45° (zoomed so no corners are empty), crop freely or to 1:1, 4:3, 3:2, 16:9 or 9:16. Ctrl+R turns all selected photos left. Pixelated faces stay on the same faces, in the preview and the export.
- Clean up after the project (data protection): one dialog lists with their sizes what the app keeps for a slideshow and deletes what you pick, for good. You can pick face data, uploads from pupils, the cache, older versions and finished export jobs. Everything pixelated stays pixelated. Your own photos, videos and exported videos are never touched.
- Deletion date per slideshow (in 1, 3, 6 or 12 months, or a date): when it comes, the home screen reminds you to clean up.
- Deleting a slideshow asks whether its cache, uploads and finished export jobs go too.
- "Report a problem…" in Settings → Troubleshooting and in About: opens the bug form on GitHub with the app version, Windows version and graphics card filled in; nothing else is sent.
- Project website with download, SmartScreen help and the handbook online: https://asamedia.github.io/diashow-studio/

**Faster and better**

- Laptops with two graphics chips draw the preview and the export on the stronger one: 4K exports about a third faster (Settings → Graphics chip → Power saving switches back).
- PCs with only Intel graphics: exports with Quick Sync now have the same quality as with NVIDIA (before, H.264 came out noticeably softer at half the size). Rotated H.264 phone videos are prepared on Intel's graphics too.

**Privacy and licences**

- The error log hides pupils' names in upload folders.
- Each release also carries the source code of every library compiled into the bundled FFmpeg, with a manifest (also added to 1.0.0).

**Under the hood**

- Updated development tools (vitest 5, TypeScript 7); issue forms for bugs and ideas.

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
