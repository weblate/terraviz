# TerraViz in-world probe (Second Life)

Two LSL scripts that test, from inside Second Life, what TerraViz can do
there, and report the answers in local chat. They produced the results in
[`docs/SECOND_LIFE_COMPAT.md`](../../docs/SECOND_LIFE_COMPAT.md) §3–§5;
read that first if you want to know what the answers *mean*. This page is
how to run them, which is mostly useful on a machine or viewer nobody has
tried yet (that doc's §10, question 8).

| File | What it is |
|---|---|
| `terraviz-probe.lsl` | **The script you paste.** Serves its own test page onto the prim through shared media and switches it between tests on chat commands. Generated; don't edit it. |
| `node-check.lsl` | **Optional second script.** Asks the TerraViz node for data and says what that costs a script's memory. |
| `probe.html`, `probe.template.lsl` | What `terraviz-probe.lsl` is generated from. Edit these. |
| `build.ts`, `index.ts`, `harness.ts`, `build.test.ts` | The generator, its command line, a headless-browser check of the page, and the tests that keep the generated script in step. |

## Before you start

- A region where you can rez objects and run scripts. A sandbox is fine.
- Shared media switched on in your viewer, with auto-play allowed. In
  Firestorm: Preferences → Sound & Media.
- No L$. Nothing here uploads anything.
- If your viewer asks whether to allow media from an address ending
  `secondlife.io`, allow it: that's the script's own test page.

## Setting up

1. Rez a sphere. A default prim sphere is fine.
2. In the sphere's Content tab, make a **New Script**, replace its text
   with all of `terraviz-probe.lsl`, and save.
3. Optionally, make a second new script and paste `node-check.lsl` into
   it.

Within a few seconds chat shows `[probe] Starting…`, then
`[probe] Face 0 now shows …`, `[probe] Served the page …`, and `[page]`
lines from the test page itself. If no `[page]` lines come, click the
sphere to start its media. `node-check.lsl` reports `[node]` lines
straight away.

## Commands

Said in local chat on channel 7, by the object's owner only.

| Command | What it shows | What it answers |
|---|---|---|
| `/7 probe` | The test page and a labelled grid (the default) | Browser version, WebGL 1/2, the graphics card, video formats, a 10-second WebGL drawing test, HLS playback |
| `/7 image` | A real TerraViz dataset frame (Nighttime Lights) | Can TerraViz's still images go on a sphere? |
| `/7 video` | A real TerraViz video, if it can play | Can this page play TerraViz's streams? From a script-served page it usually can't — see the table below |
| `/7 app` | The actual TerraViz web app | Does the real app run in-world? |
| `/7 sos` | TerraViz's LED-sphere output page | A live, correctly wrapped Earth on a sphere |
| `/7 soak` | WebGL drawing continuously, reporting every 10 s | Does WebGL stay up? Watch for `Heartbeats stopped`, and for `context lost` rising above 0x |
| `/7 soak2d` | The same animation without WebGL | The comparison for `soak` |
| `/7 globe` | Stands the sphere's poles upright and rotates its texture 90° | Fixes a default sphere's sideways mapping (below) |
| `/7 turn`, `/7 mirror`, `/7 reset` | Rotate the texture a further 90°, flip it, or undo `globe` | For checking orientation against the grid |
| `/7 face N` | Moves the media to face N | Only needed on a box; a sphere has just face 0 |
| `/7 hash` | Changes only the part of the address after `#`, on whatever the face shows | Can a globe be steered live, for every visitor, without each viewer reloading? (The doc's §7, items 4 and 7.) Run it after `/7 video` to see whether a playing video survives it |
| `/7 api` | Asks the node again | Needs `node-check.lsl` in the prim |

Every command that shows a page loads it fresh, so repeating one reruns
it.

## A default sphere is sideways

A default prim sphere has its poles on its own X axis and wraps a texture
pole to pole, so a world map lands rotated 90°. `/7 globe` fixes it.
By hand, in the Build tool:

| Tab | Setting |
|---|---|
| Object | Rotation **X 0, Y 270, Z 0** |
| Texture | Rotation **90°**, repeats 1 and 1, offsets 0 |

Check it against the grid: north pole on top, the red **NW** square
upper-left when you face the yellow and cyan crossing, text reading left
to right. Why it's needed is in the doc's §5.

## The same test with an ordinary texture

To compare shared media with an ordinary texture on a second sphere,
make the grid as an image:

```
npx tsx scripts/second-life-probe --grid grid.png
```

The page's own code draws it, so its lines and colours match the probe
sphere exactly; only the label font may differ. On the second sphere,
apply the recipe above, then in the texture picker choose **Local**
rather than Upload, **Add** `grid.png`, and select it. Only you see a
local texture, and it costs nothing.

## Reading the results

| You see | It means |
|---|---|
| `[node] events: HTTP 200 … llJsonGetValue read 1 event(s)` | Second Life's servers reached TerraViz and LSL read its JSON |
| `[node] catalog: … cut off at 16384 bytes, so not parsed. Script memory in use: …` | The reply cap, and what holding a full reply costs a lean script |
| `[node] … HTTP 403` or `503`, or `Not JSON`, with a reply starting `<!DOCTYPE` | Bot protection turned the request away, or the node answered with a web page |
| `[probe] Served the page. Peak script memory while building it: …` | How close the probe itself comes to its 64 KB. Worth reporting |
| `[page] webgl frames: 600 in 10s, context lost 0x, readback ok` | WebGL works; about 600 frames is 60 fps |
| `[probe] No WebGL frame report within 45 seconds` | The page started, then stopped or was unloaded during the WebGL test. Worth checking whether the viewer's media process crashed: on Windows, Event Viewer → Application, an *Application Error* naming `SLPlugin.exe` |
| `[probe] The page never reported starting` | Usually media auto-play is off. Click the face |
| `[probe] The page started again without a command` | The viewer reloaded the page on its own. It has done this at a different size, which is worth noting |
| `[probe] Heartbeats stopped. Last one: soak webgl: …` | How long the soak lasted before the page went quiet — unless a `Heartbeats resumed` line follows, in which case it was a gap (a dropped report, region lag) and the soak is still being watched |
| `[probe] The soak sent no heartbeat within 25 seconds of starting` | It went quiet in its first seconds — the failure bug #5189 describes |
| `[page] soak webgl: no WebGL 2 context` | This viewer's browser has no WebGL 2, so the soak can't run. An answer in itself; TerraViz needs WebGL 2 |
| `[probe] Soak ended by a new command` | You switched away; nothing went wrong |
| `[probe] The page took the change without reloading, at most … ms after the script made it. The video kept playing.` followed by `[page] hash: #h=N, video t=…, playing, readyState 4` | **The answer the clock plan hopes for.** A change after `#` reached the page with no reload, and the video was still playing when it did. The time includes the report's trip back, so the page saw it sooner. Anything up to about 1,000 ms just means "within the second the script itself pauses after changing media" |
| The same, but `But the video wasn't playing normally`, with `paused` or a low `readyState` in the `[page]` line | No reload, but the change stalled the video. That still costs every visitor a pause, so it isn't the clean answer |
| `[probe] The viewer then reloaded the page anyway, … ms after the # change` | It took the change, then reloaded within the half minute. Count it as costing a reload |
| `[probe] The viewer reloaded the page to apply the change, … ms after the # change`, then `[page] mode: … #h=N` | The change arrived, but by reloading the page, so the video starts over. Steering a globe this way costs every viewer a reload |
| `[probe] The viewer reloaded the page … but the reload lost the # part` | It reloaded, and the change didn't arrive at all |
| No answer about the change within half a minute of `/7 hash` (other `[page]` lines may still arrive) | The viewer didn't pass the change on. After the half minute a report is no longer counted as an answer: the face's address still carries the `#`, so every later reload carries it too |
| `[page] TerraViz stream via hls.js: failed, networkError / manifestLoadError` | Expected. TerraViz's video host only lets pages from TerraViz's own site load its streams through hls.js, so the page falls back to a public test stream to check that video plays at all. (The page tries the browser's own HLS player first, which isn't held to that rule; Second Life's browser had none in October 2026, so that path didn't run) |

When you report results, say which viewer and version (Help → About),
which graphics card, and which operating system. Every result so far
comes from one machine.

## Things that will trip you up

- **Only you see the test page.** Second Life renders a script-served page
  as a web page only for the object's owner, in their own viewer, in the
  same region. `/7 app` and `/7 sos` come from TerraViz's site and have
  no such limit.
- **The Media Settings dialog can lose the size.** If a page shows black
  bands, or the poles go black, check Media Settings → Size. It should be
  2048 × 1024. 0 × 0 makes the viewer use a square page.
- **Shared media tops out at 2048 a side.** The dialog clamps a bigger
  number; a script asking for one gets a bounds error and no change.
- **The output page's address is `/output/output`.** `/output.html` is
  answered by the main app.
- **For `/7 hash`, your own viewer speaks for every viewer of its
  kind.** A script's change reaches every viewer the same way, yours
  included: as an update to the object. So the test page answers for
  everyone running the same viewer.
  - **To test a different viewer** (the official one, or the phone
    app), its user runs their own copy of the probe. The test page
    only renders for its owner.
  - **A second avatar watching `/7 app` or `/7 sos` can confirm a
    reload, nothing more.** Those pages can't report, and nothing on
    them changes visibly with the `#`. So a restart means "costs a
    reload", while no restart could mean the change arrived quietly or
    never arrived.
- **Don't click inside `/7 app` before `/7 hash`.** A click can move the
  app to another address. `/7 hash` reads the face's own address
  rather than the one it set, which copes, but there is no point
  testing a navigation you didn't mean.
- **`/7 hash` before the page has started tells you nothing.** If the
  page hasn't reported starting (media auto-play off, say), the script
  says so. Click the face and try again.

## Changing the kit

Edit `probe.html` or `probe.template.lsl`, never `terraviz-probe.lsl`.
Then:

```
npx tsx scripts/second-life-probe              # regenerate terraviz-probe.lsl
npx tsx scripts/second-life-probe --test-page  # run the page through every mode
```

The page is embedded in the script verbatim, so it can't contain a double
quote or a backslash; the generator refuses it if it does. Use
`String.fromCharCode(34)` and `String.fromCharCode(10)` for a quote or a
newline. The tests fail if the generated script falls out of step with
its sources, or if the page grows past what the script can safely build.

`--test-page` serves the page as the script would and drives it in
headless Chromium until each mode reports its last line, so it shows the
page itself is sound. It says nothing about Second Life's own browser.
Set `PLAYWRIGHT_CHROMIUM_PATH` to use a particular Chromium; the image and
video modes need the network. LSL compiles only in-world, so to catch
syntax errors first, run [`lslint`](https://github.com/Makopo/lslint)
over both scripts.

`NODE` at the top of each script names the TerraViz node. Point it at
your own to test a self-hosted node; video from it plays in the app only
if that node's video host allows its own site.
