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
| `build.ts`, `index.ts`, `harness.ts`, `build.test.ts` | The generator, its command line, a headless-browser check of the page, and the test that keeps the generated script in step. |

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

Within a few seconds, chat shows `[probe] Starting…`, then
`[probe] Page loaded (probe)`, then `[page]` lines from the test page.
If the media doesn't start, click the sphere. `node-check.lsl` reports
`[node]` lines straight away.

## Commands

Said in local chat on channel 7, by the object's owner only.

| Command | What it shows | What it answers |
|---|---|---|
| `/7 probe` | The test page and a labelled grid (the default) | Browser version, WebGL 1/2, the graphics card, video formats, a 10-second WebGL drawing test, HLS playback |
| `/7 image` | A real TerraViz dataset frame (Nighttime Lights) | Can TerraViz's still images go on a sphere? |
| `/7 video` | A real TerraViz video, if it can play | Can this page play TerraViz's streams? (From a script-served page it can't, by design — see below.) |
| `/7 app` | The actual TerraViz web app | Does the real app run in-world? |
| `/7 sos` | TerraViz's LED-sphere output page | A live, correctly wrapped Earth on a sphere |
| `/7 soak` | WebGL drawing continuously, reporting every 10 s | Does WebGL stay up? Wait until `Heartbeats stopped`, or as long as you like |
| `/7 soak2d` | The same animation without WebGL | The comparison for `soak` |
| `/7 globe` | Stands the sphere's poles upright and rotates its texture 90° | Fixes a default sphere's sideways mapping (below) |
| `/7 turn`, `/7 mirror`, `/7 reset` | Rotate the texture a further 90°, flip it, or undo `globe` | For checking orientation against the grid |
| `/7 face N` | Moves the media to face N | Only needed on a box; a sphere has just face 0 |
| `/7 api` | Asks the node again | (`node-check.lsl`) |

Every command loads a fresh page, so repeating one reruns it.

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

The page draws it, so it's identical to the one on the probe sphere. On
the second sphere, apply the recipe above, then in the texture picker
choose **Local** rather than Upload, **Add** `grid.png`, and select it.
Only you see a local texture, and it costs nothing.

## Reading the results

| You see | It means |
|---|---|
| `[node] events: HTTP 200 … llJsonGetValue read 1 event(s)` | Second Life's servers reached TerraViz and LSL read its JSON |
| `[node] catalog: … cut off at 16384 bytes. Script memory in use: …` | The reply cap, and what holding a full reply costs a script |
| `[node] … HTTP 403` or `503`, with a reply starting `<!DOCTYPE` | Bot protection turned the request away |
| `[page] webgl frames: 600 in 10s, context lost 0x, readback ok` | WebGL works; about 600 frames is 60 fps |
| `[probe] No WebGL frame report after 45 seconds` | The page stopped or was unloaded during the WebGL test. Worth checking whether the viewer's media process crashed: on Windows, Event Viewer → Application, an *Application Error* naming `SLPlugin.exe` |
| `[probe] Heartbeats stopped. Last one: soak webgl: …` | How long the soak lasted. Also appears when you switch to another command |
| `[page] TerraViz stream via hls.js: failed, networkError / manifestLoadError` | Expected from this page. TerraViz's video host only lets pages from TerraViz's own site load its streams, so the page falls back to a public test stream to check that video plays at all |

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
newline. `build.test.ts` fails if the generated script falls out of step
with its sources.

`--test-page` serves the page as the script would and drives it in
headless Chromium, so it shows the page itself is sound. It says nothing
about Second Life's own browser. Set `PLAYWRIGHT_CHROMIUM_PATH` to use a
particular Chromium. LSL compiles only in-world, so to catch syntax
errors first, run [`lslint`](https://github.com/Makopo/lslint) over both
scripts.

`NODE` at the top of each script names the TerraViz node. Point it at
your own to test a self-hosted node; video from it plays in the app only
if that node's video host allows its own site.
