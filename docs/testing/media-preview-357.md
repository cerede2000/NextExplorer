# Test plan — media preview (PR #357 integration)

This plan exists because the media preview was **rebuilt**, not extended. The
image viewer and the video player were two separate components; they are now one
gallery. Everything the old components did has to still work, and the things
that were added have to work too.

Two halves, and the first one matters more: a new feature that fails is a
disappointment, an old one that stops working is a regression.

- **Fixtures** — a folder holding at least: 3 photos (one portrait, one
  landscape, one large — 4000 px or more), 2 videos (one landscape, one
  **portrait**), 1 PDF and 1 text file. The portrait video is not optional: it is
  the file that could not be closed before.
- **Where** — desktop browser, and a real phone or tablet. The touch half cannot
  be judged from a desktop with emulation alone.
- **Before starting** — note the build you are testing.

---

## Part 1 — What already existed, and must still work

### 1.1 Opening images

| #   | Action                          | Expected                                                |
| --- | ------------------------------- | ------------------------------------------------------- |
| 1   | Open a photo from the file list | It opens full screen, fitted to the window, not cropped |
| 2   | Look at the header              | The file name is shown                                  |
| 3   | Open a portrait photo           | Fitted to height, no distortion                         |
| 4   | Open a 4000 px photo            | Displayed whole, no scrollbars                          |

### 1.2 Browsing between images

| #   | Action                            | Expected                      |
| --- | --------------------------------- | ----------------------------- |
| 5   | Press the right arrow key         | The next image is shown       |
| 6   | Press the left arrow key          | Back to the previous one      |
| 7   | Press the arrows at the last item | Wraps to the first — it loops |
| 8   | Click the on-screen arrows        | Same as the keyboard          |

### 1.3 Videos

| #   | Action                                              | Expected                                                 |
| --- | --------------------------------------------------- | -------------------------------------------------------- |
| 9   | Open a landscape video                              | It plays automatically, with the native controls         |
| 10  | Look for the poster                                 | The thumbnail is shown before playback starts            |
| 11  | Use the video's own controls                        | Play, pause, seek, volume and full screen all work       |
| 12  | Press the right arrow **while the video has focus** | The video seeks — the gallery does **not** change item   |
| 13  | Move to another item while a video is playing       | The sound stops. Nothing keeps playing in the background |
| 14  | Close the preview during playback                   | The sound stops                                          |
| 15  | Open a `.mkv`, a `.webm`, a `.mov`                  | Each plays, or fails visibly — never silently            |

### 1.4 Closing

| #   | Action                 | Expected                                                     |
| --- | ---------------------- | ------------------------------------------------------------ |
| 16  | Press Escape           | The preview closes                                           |
| 17  | Click the close button | The preview closes                                           |
| 18  | After closing          | The file list is where it was, with the same scroll position |

### 1.5 Downloading

| #   | Action                                | Expected                                                     |
| --- | ------------------------------------- | ------------------------------------------------------------ |
| 19  | Click download on the item you opened | That file is downloaded                                      |
| 20  | Move two items along, then download   | **The file on screen** is downloaded, not the one you opened |

### 1.6 Untouched by this work

| #   | Action                          | Expected                                |
| --- | ------------------------------- | --------------------------------------- |
| 21  | Open a PDF                      | The PDF viewer opens as before          |
| 22  | Open a text file                | The editor opens as before              |
| 23  | Open an office document         | ONLYOFFICE or Collabora opens as before |
| 24  | Open a photo from a shared link | Works, with the share's own permissions |

---

## Part 2 — What is new

### 2.1 Swiping (touch)

| #   | Action                                 | Expected                                                      |
| --- | -------------------------------------- | ------------------------------------------------------------- |
| 25  | Swipe right-to-left across a photo     | The next item is shown                                        |
| 26  | Swipe left-to-right                    | The previous item                                             |
| 27  | Swipe from a photo to a video and back | The gallery mixes both — this is new                          |
| 28  | Swipe a few pixels and release         | Nothing happens. A short movement is not a swipe              |
| 29  | Swipe vertically                       | Nothing happens — the page scrolls, the gallery does not move |
| 30  | Swipe on a video                       | The next item, exactly as on a photo                          |

### 2.2 Zoom (touch)

| #   | Action                                | Expected                                                   |
| --- | ------------------------------------- | ---------------------------------------------------------- |
| 31  | Pinch two fingers apart on a photo    | It zooms in, centred                                       |
| 32  | Pinch together                        | It zooms back out, no smaller than fitted                  |
| 33  | Double-tap a photo                    | It zooms in                                                |
| 34  | Double-tap again                      | Back to fitted, centred                                    |
| 35  | Drag with one finger **while zoomed** | The picture moves under the finger                         |
| 36  | Drag to the edge and keep going       | It stops at the edge — the picture never leaves the screen |
| 37  | Pinch a **video**                     | Nothing happens, and the gallery does **not** change item  |

### 2.3 The rule that makes both work

This is the heart of the change, and it is what #354 complained about: dragging
used to move the picture instead of turning the page.

| #   | Action                                  | Expected                                             |
| --- | --------------------------------------- | ---------------------------------------------------- |
| 38  | At fitted size, drag sideways           | The gallery moves to the next item                   |
| 39  | Zoom in, then drag sideways             | The **picture** moves. The gallery stays put         |
| 40  | While zoomed, tap the on-screen arrow   | The next item — the arrows always work               |
| 41  | Check the item you just arrived at      | It is at fitted size, not carrying the previous zoom |
| 42  | Zoom back out fully, then drag sideways | The gallery moves again                              |

### 2.4 Zoom (desktop)

| #   | Action                                 | Expected                         |
| --- | -------------------------------------- | -------------------------------- |
| 43  | Ctrl (or ⌘) and the wheel over a photo | It zooms                         |
| 44  | Wheel **without** the modifier         | Nothing zooms — normal scrolling |
| 45  | Trackpad pinch (macOS)                 | It zooms                         |
| 46  | Double-click a photo                   | It zooms in, then back out       |

### 2.5 The bug from #354

| #   | Action                                    | Expected                                          |
| --- | ----------------------------------------- | ------------------------------------------------- |
| 47  | On **Android**, open a **portrait** video | It is displayed whole                             |
| 48  | Look for the close button                 | Visible, and reachable                            |
| 49  | Close it                                  | The preview closes **without reloading the page** |

Test 49 is the whole reason the issue was raised: the portrait video could not be
closed at all.

### 2.6 Labels

| #   | Action                                       | Expected                                               |
| --- | -------------------------------------------- | ------------------------------------------------------ |
| 50  | Switch the interface to French, open a photo | The buttons are in French                              |
| 51  | Check with a screen reader, or inspect       | The buttons carry a translated label, not English text |

---

## Part 3 — Edge cases worth a minute

| #   | Action                                | Expected                                       |
| --- | ------------------------------------- | ---------------------------------------------- |
| 52  | Open the only photo in a folder       | It opens; no arrows, no counter                |
| 53  | Open a photo in a folder of 500 items | It opens promptly                              |
| 54  | Open a corrupt or truncated image     | Fails visibly; the preview can still be closed |
| 55  | Rotate the phone while zoomed         | Nothing is lost; the picture stays usable      |
| 56  | Open a photo, close, reopen another   | No zoom carried over from the first            |

---

## What to report

For anything that fails, note the number, the file involved, the device and
browser, and what happened instead. Numbers 12, 13, 20, 39, 41 and 49 are the
ones to check first if time is short: each one covers something that was either
broken before or is easy to break again.
