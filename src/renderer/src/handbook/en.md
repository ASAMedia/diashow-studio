# Handbook

## Getting started {#start}

Diashow Studio turns photos, videos and music into a slideshow and saves it as an MP4 video. Everything runs on your PC, without the internet.

The quickest way is the **assistant**. It opens on the first start, and later from **New slideshow with assistant** on the home screen.

1. **Photos and videos:** choose single files or a whole folder. Subfolders are included.
2. **Theme and music:** click a theme and, if you like, add your own music.
3. **Show or export:** play the slideshow or save it as a video.

![The assistant: choosing a theme and music](wizard.jpg)

Other ways to start a slideshow:

- Drag photos, videos or folders into the window.
- **New slideshow** picks files; **Play a folder** shows a folder as a slideshow straight away.
- **Open project…** loads a `.dshow` file, e.g. a packed project from another PC.

Projects are saved automatically, in `Documents\Diashow Studio`. New photos are prepared in the background; you can carry on working right away.

![The home screen with your slideshows](home.jpg)

## Editing {#edit}

The editor has three areas: the **preview** in the middle, the tabs **Themes**, **Music**, **Duration** and **Slide** on the right, and the **filmstrip** with every slide at the bottom.

![The editor](editor.jpg)

- **Order:** drag slides in the filmstrip. Dropping a slide on the middle of another combines both into one slide.
- **Several slides:** [[Ctrl]]+click, [[Shift]]+click or [[Ctrl+A]]. The **Slide** tab then changes them all together.
- **Time on screen:** drag the right edge of a card; a double-click there sets it back to automatic.
- **Framing:** drag in the preview to move the photo, scroll to zoom, double-click to reset.
- **Text:** **Add text** creates a text slide. The **Slide** tab adds text boxes on top of a photo.
- **Chapters:** the **⋯** menu has **Day titles from capture date** and **Chapters from folder names**, as well as **Sort by capture date** and **Add end credits**.
- **Videos:** trim them, change their speed (slow motion, time lapse) and **Reduce shake** in the **Slide** tab.
- **Undo:** [[Ctrl+Z]], redo with [[Ctrl+Y]].

> Tip: [[Space]] plays the preview, [[←]] and [[→]] step from slide to slide.

## Themes and looks {#themes}

The **theme** decides how slides look and change. There are 11 themes, e.g. **Ken Burns** (slow moves across the photo), **Magazine** (several photos in a grid) or **Snapshots** (instant photos landing on a table).

- Themes with several photos per slide arrange them automatically. In the **Slide** tab you choose another layout, or **Free** for your own collage.
- The **look** (Natural, Vivid, Warm, Cool, Dramatic, Faded, Mono, Noir) colours only the photos and videos, never the background.
- **Crop photos to fill** applies to the whole show; any photo can be an exception with **Whole picture**.
- **Title:** title text, font, size, colour and an animation (handwriting, typewriter, big date) are set in the **Themes** tab.
- In the **Classic** theme you choose the transition (Dissolve, Push, Cube…) in the **Duration** tab.

## Music {#music}

In the **Music** tab you add your own music files (MP3, M4A, WAV, FLAC and more). Several songs form a playlist that you reorder by dragging.

![Music with waveform and beat markers](music.jpg)

- **Fit to music** (**Duration** tab): the slideshow lasts exactly as long as the music. Or set your own total length.
- **Change slides on the beat** puts every change on a beat.
- The **scissors** next to a song choose its start and end, e.g. to skip a long intro.
- **Music from here on:** a song can start at a chapter slide, e.g. its own music for each day of a class trip.
- During videos with sound the music gets quieter automatically. **Even out loudness** brings songs and video sound to the same level.

## Review {#cull}

**Review** (top right) shows every photo and video in a grid, for going through a big import quickly with the keyboard.

![Review: leave out and rate](cull.jpg)

- [[X]] leaves a picture out of the slideshow (it stays in the project) and brings it back.
- [[1]] to [[5]] give stars, [[Space]] shows the picture large.
- Filters show e.g. only **Left out**, only rated pictures, or **Blurry & duplicates**.
- **Only 3+ ★ in the slideshow** (or another number) keeps just the best.
- **Find rejects…** in the **⋯** menu lists blurry photos and duplicates, including the same video twice (e.g. from WhatsApp).

## Privacy: pixelating faces {#privacy}

Faces of pupils without photo consent can be pixelated. Face detection runs offline on your PC; no picture leaves it.

![Pixelating faces](privacy.jpg)

1. Select a slide and click **Pixelate faces…** in the **Slide** tab.
2. Click a detected face, or drag out an area with the mouse.
3. With the person button (**Pixelate this person everywhere**) on a face, this person is looked for and pixelated in **every** photo and video of the show. The people list shows the matches; remove a wrong match with ✕.

- In videos, a clicked face is followed through the whole clip.
- Before exporting, **Check faces…** (**⋯** menu or the export dialog) lists every slide with faces that are not pixelated yet.

> Always check the result yourself: detection doesn't find every face, e.g. in profile or very small.

## Export and the export queue {#export}

**Export** (top right) saves the slideshow as an MP4 video. Pick a preset such as **YouTube 1080p**, **WhatsApp / e-mail (small)** or **TV / projector**, or set resolution, frame rate and quality yourself.

![The export dialog](export.jpg)

- Exports run in the background, one after another. You can keep working; the title bar shows the progress.
- Each export is a snapshot: later edits don't change it.
- After a crash or a restart, **Continue** in the **Exports** list picks up where it stopped.
- Graphics cards (NVIDIA, Intel, AMD) make exporting much faster. The PC doesn't go to sleep meanwhile.

![The list of exports](queue.jpg)

## Share over Wi-Fi {#share}

**⋯ → Share over Wi-Fi** exchanges photos and videos with phones: local network only, no internet, no app.

![Collecting photos from phones](share.jpg)

- **Collect photos:** the laptop shows a QR code. Pupils open a page with it and upload photos and videos. They are stored in `Documents\Diashow Studio\Uploads` and go straight into the show.
- **Hand out the video:** a finished export can be watched and saved on the phones. There is a small 720p version for phones.
- The server only runs while the dialog is open and only answers links with a random key.

> The first time, Windows asks whether the app may use the network: choose **Allow** (private network). On guest Wi-Fi that keeps devices apart, the Windows mobile hotspot helps.

## Showing it {#present}

- **Play** shows the slideshow fullscreen ([[Esc]] ends it).
- **Present** (**⋯** menu) shows the show on the projector, while the laptop shows the current and the next slide with time and controls.
- **Kiosk mode** (Settings) starts the app straight into a slideshow in a loop, e.g. for an open day.

## Saving and moving projects {#projects}

- **Restore an older version…** (**⋯** menu): before each save the previous version is kept (the last 20).
- **Pack project…** copies the project with all photos, videos and music into a folder, e.g. for a USB stick. On the other PC, open the `.dshow` file.
- If originals were moved (another folder, a new drive letter), **Search a folder…** in the yellow banner finds them again.

### Repairing a damaged project

If saving a project file was interrupted (e.g. by a power cut), the file is listed in red on the home screen with **Repair…**. The dialog offers two ways:

- **Rescue from the file:** everything still readable is taken over. A list says what was missing or repaired.
- **Automatic backups:** open an older, complete version.

The damaged file is kept either way. Smaller damage is repaired by the app itself when it opens the project; a notice then says what changed.

## Settings and system check {#settings}

Open **Settings** with the gear at the top right (or from the **⋯** menu).

![Settings](settings.jpg)

- **Appearance:** System, Light or Dark (see below).
- **Preview quality:** High, Medium or Low for slower laptops. Exports are not affected.
- **Storage:** shows how much space thumbnails and video versions take, and cleans up.
- **Kiosk mode:** see [Showing it](#present).
- **Updates:** if you like, the app asks GitHub once a day for a new version and then shows a hint. Nothing is installed automatically.
- **Troubleshooting:** the **System check** tests another PC (e.g. in the computer room): graphics card, video encoders, memory and a short export test. **Copy report** copies everything as text. There is also the **diagnostics package** (see below).

### Light or dark

Under **Appearance** you choose **System**, **Light** or **Dark**. **System** follows the Windows app mode (Settings → Personalisation → Colours). The preview, the fullscreen player and the large view in Review always stay dark, so the photos look their best.

### Diagnostics package

When something doesn't work, a **diagnostics package** helps whoever helps you: **Settings → Troubleshooting → Create diagnostics package…**. Before saving you see every file of the package; a click shows its content. It contains the error log, the system check, settings, versions and, of the open project, only counts, formats and sizes – no photos, videos, names or face data. **Save…** writes a zip file you can send by e-mail.

## Keyboard shortcuts {#shortcuts}

| [[Space]] | Play / pause the preview |
| [[←]] / [[→]] | Previous / next slide |
| [[Ctrl+Z]] / [[Ctrl+Y]] | Undo / redo |
| [[Del]] | Delete the selected slides |
| [[Ctrl]]+click, [[Shift]]+click | Select several slides |
| [[Ctrl+A]] | Select all slides |
| [[Alt+Enter]] | Play fullscreen |
| [[Esc]] | Leave fullscreen, presentation or a dialog |
| [[F1]] | This handbook |
| [[Alt+←]] / [[Alt+→]] | Move the slide in the filmstrip |
| [[Shift+F10]] | Open the slide's menu |

[All shortcuts and mouse tips](app:shortcuts)

## Using the keyboard {#keyboard}

Everything in Diashow Studio also works without a mouse:

- [[Tab]] and [[Shift+Tab]] move from control to control; the active one has a blue ring. [[Space]] or [[Enter]] presses a button.
- In the bar on the right, [[↑]] and [[↓]] switch between the tabs **Themes**, **Music**, **Duration** and **Slide**.
- The filmstrip is a single [[Tab]] stop: there [[←]] and [[→]] go from slide to slide and select it ([[Shift]] selects a range), [[Alt+←]] / [[Alt+→]] move the slide, [[Shift+F10]] opens its menu.
- Menus work with the arrow keys and [[Enter]]; [[Esc]] closes them.
- [[Esc]] closes every dialog; the focus then goes back to where you were.
- On a song's number, [[↑]] and [[↓]] move the song in the list. The handles for trimming videos and songs move with [[←]] and [[→]], with [[Shift]] in bigger steps.
- While you type in a text field, the shortcuts don't react.

> If "Animation effects" are switched off in Windows, the app leaves out movement in its interface too. The slideshow itself plays as usual.

## Troubleshooting {#trouble}

- **Windows warns when installing** ("Windows protected your PC"): choose **More info** and **Run anyway**. The app has no paid code signature.
- **The preview stutters:** lower the **Preview quality** in Settings. Exports don't get worse.
- **A video stays at "being prepared":** some phone videos (HEVC, HDR) are converted first. That takes a while, but only once.
- **Exporting is very slow:** check in the [System check](#settings) whether a hardware encoder is found. Without a graphics card, a smaller resolution (720p) helps.
- **Files are missing:** the originals were moved – choose **Search a folder…** in the yellow banner.
- **Files on a network drive stay blocked:** a project from another PC points to shares such as `\\server\photos`. Because Windows signs in there with your account, the app asks first at the top of the editor. Choose **Allow access** only if you trust the project; shares you import from yourself are trusted automatically.
- **Phones can't reach the laptop:** laptop and phones must be on the same Wi-Fi, and the Windows firewall must allow the app. Otherwise use the Windows mobile hotspot.
- **Anything else:** create a [diagnostics package](#settings) under **Settings → Troubleshooting** and send it with a description to whoever helps you.

## About, licences and updates {#about}

Diashow Studio is free software (MIT licence). It includes FFmpeg (GPL), fonts, face detection models and other libraries; their licences and the source of FFmpeg are under [About Diashow Studio](app:about). There you can also **Check for updates**.
