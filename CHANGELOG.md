# Changelog

All notable changes to Diashow Studio. Versions follow [Semantic Versioning](https://semver.org). The release workflow publishes the section of a version as its release notes.

## [1.9.0] - 2026-10-14

**Downloads**

- `Diashow.Studio-Setup-1.9.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.9.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- The app's taskbar button shows the progress of an export (yellow when paused, red for a moment when one fails), and Windows tells you when an export is finished or failed while you work in another program; a click shows the video in its folder. No notification appears while a slideshow plays fullscreen.

**Security**

- Network shares you haven't trusted stay untouched in more places: opening a slideshow file from elsewhere no longer looks at its files' sizes, and a Live Photo's video, the diagnostics package, packing, frames, waveforms and files offered on the phones' page wait for your OK too. `\\.\UNC\…` spellings of a share count as that share; other device paths are refused.
- A slideshow file from elsewhere can no longer make the app create folders or files outside its media cache.
- Share over Wi-Fi: one phone or laptop can hold at most 32 connections and 3 uploads at once, so nobody can lock the class out; uploads that run together count against the free disk space; "~" in pupils' names and file names becomes "_". Slideshows with a slash in their name ("Klassenfahrt 9/10") get their own upload folder.
- Links open in the browser only to GitHub, the website and the GPL text. An installed app ignores the developer setting that would load another page.
- The diagnostics package counts trusted network hosts instead of naming them.

**Fixes**

- Photos and videos still being read for one slideshow no longer land in another one opened meanwhile (Add photos, drop, Ctrl+V, Insert…, pupils' uploads).
- An edit made right before the window is closed is saved, with its undo step; opening a slideshow right after closing it waits for its last save.
- Undo and redo also take back a song's trim.
- The clean-up: a background update during it no longer writes the slideshow back as it was.
- Trash: a slideshow restored with an upload under another name is no longer processed again every time it opens (its face data was dropped); a slideshow whose move into the trash was taken back while a file stayed busy can be saved again; finished exports come back into the queue after an interrupted restore; the home screen no longer waits for the trash's expiry at start-up.
- Snapshots: Loop and Bounce prints on the pile no longer decode their motion again for every exported frame. Magazine preview: a Loop or Bounce no longer shows its still at the start of its slide.
- Beat sync no longer cuts a Loop or Bounce shorter than one cycle, or a grid slide shorter than its longest clip.
- Panoramas in HEIF, HIF and JPEG XL keep their full display size and get sharper 4K versions.
- "Split into single slides" also separates the slide's last photo; moving a slide in grid themes no longer lands inside the next slide or between a caption text and its slide; a panorama dropped onto a card gets a slide of its own; combining is no longer offered for a Live Photo that plays; a text slide is no longer counted among the fixed slides.
- Search finds a person where the people list sees them; "n of m" and F3 follow the match shown when the slideshow changes; the zoom slider's arrow keys work at small sizes; the filmstrip stays a Tab stop when the selected slide is scrolled away.
- The repeat notice counts how many skipped files repeat a left-out photo.

## [1.8.1] - 2026-10-14

**Downloads**

- `Diashow.Studio-Setup-1.8.1.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.8.1-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**Changes**

- Wording: one term per thing in German and English (Diashow/slideshow, Vorschau/preview, Videokopien/video copies, Themenmusik/theme music, herausgenommen/left out, Textfolie/text slide, Bildtext/caption, endgültig löschen/delete permanently). "…" on every command that opens a dialog or a file picker. "1 Folie" / "3 Folien" instead of "Folie(n)". British spelling throughout. The phones' upload page and the archive's read-me use the same words. A glossary is in the README.
- Handbook: new chapters for the home screen, adding and inserting photos, the filmstrip, editing photos, panoramas, videos and Live Photos, and the trash; touch screens are covered. New pictures of a panorama, a Live Photo loop, a copy made with Duplicate, and the trash.

## [1.8.0] - 2026-10-14

**Downloads**

- `Diashow.Studio-Setup-1.8.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.8.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Duplicate a slideshow from its card on the home screen or the "⋯" menu, e.g. a parents' version with more pixelation next to the class version. The copy has everything the show has, including its deletion date, starts without older versions or undo history, and keeps the original's title in the video.
- Drop photos onto a slideshow on the home screen to add them to it, sorted into their day; photos it already has are skipped.

**Fixes**

- Files dropped while a dialog is open are no longer imported into the show behind it or made into a new show: the window refuses them and says "Close the dialog first". The assistant still takes photos.
- The clean-up and deleting a show no longer remove uploads that a show in the trash still uses, and uploads two shows shared are deleted with the last of them.
- The undo history is no longer lost when the slideshow is saved just as the app closes.
- A paused preview no longer redraws ten times a second when nothing changes, which kept the processor busy on PCs without a graphics card.
- Temporary files of the graphics card check at start-up no longer stay behind in the Windows temp folder when the app is closed during the check.
- Windows' file dialogs (adding photos and music, opening, exporting, archiving, the diagnostics package, offering a video) and the presentation window are titled in English in the English UI.
- With several slides selected, "n areas pixelated" also counts the faces followed in videos.
- Starting an export while another one is being written no longer breaks the running one.
- Moving through the filmstrip with the arrow keys keeps the focused card fully in view at the left edge.

## [1.7.0] - 2026-10-13

**Downloads**

- `Diashow.Studio-Setup-1.7.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.7.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Trash for slideshows: Delete moves a show to the trash for 30 days instead of deleting it. Restore brings it back with its older versions, undo history, uploaded photos and export jobs, also after a restart; "Delete permanently" and "Empty trash" delete at once, and after 30 days it goes by itself. Settings → Privacy shows and empties the trash. A show with an unfinished export can only be deleted once the export is done or removed.
- Touch screens: text boxes, the free collage, framing, crop and trim handles and a card's time can be dragged with a finger.

**Fixes**

- Moving a slide or song no longer gets lost or ends up in the wrong place when it is let go right after the pointer crossed onto another card or song.
- The "drop here" overlay and the filmstrip's marks go away as soon as files leave the window or Esc is pressed, also when the filmstrip scrolled meanwhile. Files dragged over the song list no longer leave a mark there.
- A slide whose card scrolled out of view while it was dragged no longer stays half transparent, and files dropped afterwards are inserted instead of moving that slide.
- A card marked for joining no longer shrinks under the pointer; its pictures do.
- Dragging a card's time, text boxes, the Ken Burns frame, a photo in its cell, the free collage, trim handles, the edit view's crop and pixelated areas stops when the mouse button is let go while another window has the mouse.
- Pictures in the app can no longer be dragged by mistake (they were taken for files from Explorer).

## [1.6.0] - 2026-10-13

**Downloads**

- `Diashow.Studio-Setup-1.6.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.6.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Live Photos and Motion Photos as Loop and Bounce, like on the iPhone: the Slide tab chooses Off, Live, Loop or Bounce for one or several photos. A Loop repeats with a soft crossfade at its seam, a Bounce plays forward and backward; both play all the slide long, in the preview and in the export frame by frame, in every theme, with pixelated faces kept. The filmstrip shows the effect next to LIVE.

**Fixes**

- Photos dropped onto a filmstrip card right on the edge between two of its pictures could get lost, and the card's highlight flickered there.

## [1.5.0] - 2026-10-13

**Downloads**

- `Diashow.Studio-Setup-1.5.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.5.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Panoramas pan across their slide, like in Photos: a wide (or very tall) panorama gets a slide of its own in every theme, fills its height and travels end to end at an even speed with a soft start and stop. Its slide lasts longer the wider it is (at most 2.5×). The Slide tab chooses Pan, Whole picture or Crop to fill and the direction; the filmstrip marks panoramas. 4K exports use a sharp version made from the original.
- Photos that are already in the slideshow are not added twice: the same file, a copy under another name or in another folder, the same photo twice in one import, or the same shot as HEIC and JPEG, also when two pupils upload the same photo. A notice says how many were skipped and offers "Add anyway" and "Show". Recompressed copies (e.g. from WhatsApp) are still found by "Find rejects".
- Group automatically: in Magazine, Origami and the other themes with several photos per slide, a chip above the filmstrip shows how many slides keep their photos (combined, split or kept when photos were inserted) and lets the theme group them again. The slide menu does the same for the selected slides only.

**Fixes**

- "Sort by capture date" now groups the photos again instead of keeping slides together whose photos had moved apart.

## [1.4.0] - 2026-10-13

**Downloads**

- `Diashow.Studio-Setup-1.4.0.exe`: installer (no admin rights needed); it updates an installed version and keeps your slideshows and settings.
- `Diashow.Studio-1.4.0-portable.exe`: runs without installing, e.g. from a USB stick.
- The installer is not code-signed. If Windows SmartScreen says "Windows protected your PC", choose "More info" and then "Run anyway".
- `THIRD_PARTY_NOTICES.txt` lists the licences of everything bundled, including all songs. The `ffmpeg-*` archives contain the source code of the bundled FFmpeg build and of every library compiled into it (GPL), listed in `ffmpeg-deps-sources-*.txt`.

**New**

- Undo after a restart: Ctrl+Z and Ctrl+Y go on where you left off, with the last 100 steps of each slideshow. The history is kept in the app's own folder, never next to the project file, and never goes into a pack, ZIP archive or diagnostics package. If the slideshow was changed on another PC, restored from an older version or repaired, the old history is dropped instead of undoing the wrong thing. The clean-up lists it with its size, and Settings → Privacy deletes it for one or all slideshows.
- Filmstrip zoom: −/+, a slider or Ctrl+mouse wheel make the cards smaller or larger, and "Show the whole slideshow" fits every slide into the window. Small cards show a thin mark at each chapter; the music lane and the playhead stay aligned.
- Search in the filmstrip (Ctrl+F): by file name, chapter or day, caption, text, person, "Video" or "Live", and by capture date in German or English ("12.5.", "12. Mai", "Dienstag", "May 2026"). Matches get a yellow mark; Enter or F3 jumps to the next one. A "Chapters" menu jumps straight to a chapter.
- Insert photos and videos exactly where you want them:
  - drop them from Explorer between two slides (or onto a slide to add them to it in Magazine, Origami and the other themes with several photos per slide);
  - Ctrl+V pastes copied files, or a screenshot, which is saved under `Documents\Diashow Studio\Eingefügt` and removed by the clean-up like uploads;
  - "Insert…" in a slide's menu.

  It is one undo step, and in themes with several photos per slide the other slides keep their layouts.
- New demo video on the website, with the reworked transitions.

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

- Transitions reviewed in every theme, frame by frame and with a jump detector:
  - **Vintage Prints:** each new print now falls onto the pile from above, turning and landing with its shadow. The prints below stay where they landed and get darker and softer as they are covered. Before, the new print zoomed in and faded, and the old one grew bigger in the background.
  - **Origami:** the new picture now folds in from the edge for the whole transition. Before, nothing moved for half a second and then the picture jumped in.
  - **Classic:** Push, Move in, Reveal, Wipe, Zoom, Cube, Flip and Droplet start and stop gently instead of jumping to full speed and stopping hard.
  - **Snapshots:** prints on the pile are no longer see-through and don't jump at each change, and the oldest fades away smoothly. Videos slide in and out as a big print instead of fading in and out as a ghost. The handwritten line fades instead of vanishing.
  - **Scrapbook:** the old page is swept off solid, then the new prints fall onto the paper one after another. Before, the whole page turned see-through. Every print now lands exactly in place.
  - **Reflections:** two titles in a row no longer slide through each other, and cards are solid as soon as they appear.
  - **Ken Burns:** the camera keeps moving through the crossfade instead of slowing to a stop at the end of every slide, and two titles in a row fade through black.
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
