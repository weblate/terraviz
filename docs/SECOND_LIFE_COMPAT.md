# Second Life Compatibility — Can TerraViz Work Inside Second Life?

**Status: draft for review, now with in-world test results.** This
document answers whether TerraViz can run inside — or usefully
connect to — Second Life, and the OpenSimulator virtual worlds that
copy its design. The first version (August 2026) was desk research.
This version adds an afternoon of testing inside Second Life on
23 October 2026, and several of the first version's conclusions did
not survive it. Nothing here has been built or funded yet. It exists
so that whoever picks this up starts from what we know instead of
rediscovering it.

**Who this is for.** Someone who knows the TerraViz codebase but not
Second Life, someone who knows Second Life but not this codebase, or
someone new to both. §0 is a glossary covering both sides; skip it if
you don't need it. Every claim about TerraViz cites a file and line.
Every claim about Second Life cites a public source, the viewer's
source code, or a test result in §4, all collected in §11.

**Last reviewed:** 2026-10-24 (in-world, in Firestorm 7.2.4: the
output page's web mode played a TerraViz video on a globe driven by the
kit's globe script, and pausing and resuming it changed only the part
of the address after `#`, with no reload — §10 question 10 answered for
that viewer, §7's status note and §11 updated. Earlier the same day,
§7 item 4 was rewritten from an interview with Eric on what the shared
clock has to do, and the kit gained `/7 hash`. 2026-10-23: in-world testing
in the Firestorm viewer: the real TerraViz app ran in shared media, WebGL 2 stayed up
for 7½ minutes, a default sphere's texture mapping was worked out from
the viewer source and confirmed, and TerraViz's own LED-sphere output
page rendered a correct live Earth on an in-world sphere — §1, §6 and
§9 rewritten as a result. Earlier the same day: repository citations
refreshed after merging `main`, and API reply sizes measured against
production. Initial scoping 2026-08-09 from Eric's brief: years spent
building content and writing LSL in Second Life, and the question
whether TerraViz could be compatible with the platform).

**Revisit when any of the following becomes true:**

- **The output page gains a web mode** — loading a dataset from its
  own address (§7). Then §6 Option C stops being a plan, and this doc
  should point at that work instead of describing it. *Built on the
  Phase 1 branch and run in-world on 24 October; not yet merged.*
- **The `#` test runs on another viewer** (§10, question 10). It
  decides whether §7 item 4 needs a server, and so whether §8's
  "nothing in-world writes back" still holds. Firestorm 7.2.4 passed
  on 24 October. The official viewer and the phone app have not been
  tried, and a viewer that reloads would change the answer for its
  users.
- **Someone tests on a second machine or viewer** (§10, question 8).
  Every in-world result here comes from one machine — Firestorm on
  Windows with an RTX 4090 laptop GPU. The official Linden Lab viewer
  and a modest graphics card are the two configurations most likely
  to disagree.
- **[secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189)
  moves** — closes, or turns out to reproduce under TerraViz's own
  load. It reports WebGL crashing Second Life's embedded browser, and
  it did not reproduce in any test here (§4.3). If it starts firing
  for real visitors, §6 Option E and the output-page plan both depend
  on the answer.
- **SLua leaves beta, or Second Life's networking limits change.**
  Option A is designed around a 16 KB cap on what a script can
  receive and a 64 KB memory budget to hold it in (§4.1). Both are
  limits of the platform, not the language.
- **Someone confirms whether the Second Life phone app supports
  shared media** (§10, question 1). Every web-based option depends on
  it for phone users.
- **A real host is named** — a Second Life region, an OpenSimulator
  world, or a partner organisation with land. Several
  recommendations here weigh cost against audience, and we are still
  guessing at both.

**Supersedes when:** something TerraViz-related actually exists
in-world and is being maintained. At that point this becomes a record
of why it was built that way, and that project's own README takes
over.

---

## 0. Glossary

Terms used below, from both sides. Skip what you already know.

**Second Life side**

| Term | What it means |
|---|---|
| **Viewer** | The desktop or phone app you use to log in. Linden Lab ships one; third parties ship others. **Firestorm** is the most popular, and is what the tests in §4 used. |
| **Region** (or sim) | One 256 × 256 metre piece of the world, running on one server. Holds roughly 40–60 avatars before it struggles. |
| **Prim** | A primitive object — a cube, sphere, cylinder. The basic building block. A **mesh** is an imported 3D model used the same way. |
| **Face** | One surface of an object that can carry its own texture. A sphere has one; a cube has six. |
| **LSL** | Linden Scripting Language. The scripting language in-world objects have used since 2003. Event-driven, C-like, quite limited. |
| **SLua** | A newer scripting option based on Luau (the Lua dialect Roblox uses). In open beta since December 2025. LSL still works; you choose per script. |
| **Shared media** (also **media on a prim**, MOAP) | Second Life's feature for showing a live web page on an object's surface. Internally it runs a cut-down copy of Chrome inside each viewer. |
| **CEF** | Chromium Embedded Framework — the "Chrome as a building block" library that powers shared media. |
| **HTTP-in** | A web address a script can request for itself, so that a browser — including shared media — can talk *to* the script. Used by the test kit in `scripts/second-life-probe/` to serve its own test page. |
| **Local texture** | An image the viewer loads from your own disk and shows only to you. Nothing is uploaded and it costs nothing; it disappears when you log out. |
| **PBR** | Physically Based Rendering. The modern material system Second Life adopted. Gives you colour, shininess, bumpiness, and glow — but no custom programming. |
| **L$** | Linden dollars, the in-world currency. Roughly L$250 to US$1. Uploading a texture costs L$10. |
| **OpenSimulator** | Open-source server software that speaks Second Life's protocol. You can run your own world on your own hardware, and the same viewers connect to it. |

**TerraViz / web side**

| Term | What it means |
|---|---|
| **WebGL** | The browser feature that lets a web page use the graphics card to draw 3D. TerraViz's globe is entirely built on it — specifically on **WebGL 2**. |
| **Shader** | A small program that runs on the graphics card, deciding the colour of every pixel. This is how TerraViz recolours data live. |
| **Texture** | An image wrapped onto a 3D surface. |
| **Equirectangular** | The standard unrolled-world-map rectangle, exactly twice as wide as tall. Longitude runs left to right, latitude top to bottom. This is the shape all TerraViz data frames use. |
| **UV mapping** | The rule for how a flat image wraps onto a 3D shape. Which way a sphere's UV mapping runs turned out to matter a great deal (§5). |
| **Output page** | TerraViz's renderer for physical spheres (Science On a Sphere, LED globes). Instead of drawing a camera's view of a globe, it draws the *whole* globe as one 2:1 unwrapped image — exactly what a sphere needs. Built for the desktop app's multi-monitor feature, and also served on the website at `/output/output`. |
| **Framebuffer** | The image the output page draws, before the browser scales it to fit the page. |
| **Letterboxing** | Black bands added when a picture keeps its own shape inside a frame of a different shape. |
| **Data-encoded video** | TerraViz's technique of storing real measurements as brightness values in a video, so the app can read actual numbers back out of a pixel and recolour the data without re-downloading it. |
| **HLS** | The streaming video format TerraViz uses. Played in-browser by a library called hls.js. |
| **CORS** | The browser rule that decides whether a page from one website may read data from another. |

---

## 1. The question is really four questions

"Can TerraViz be compatible with Second Life?" sounds like one
question. It's four, and they had very different answers — some of
which changed once we tested instead of reasoned:

| # | Question | August answer (desk research) | October answer (tested) |
|---|---|---|---|
| 1 | Can the TerraViz web app run inside Second Life? | **No** — WebGL crashes there | **Yes.** It ran, video dataset included, on the machine tested. It draws a *picture* of a globe, so it belongs on a flat panel, not a sphere. §4.5 |
| 2 | Can TerraViz's data appear on an in-world globe? | Yes, with caveats | **Yes, demonstrated three ways**, once a default sphere is set up correctly. §5 |
| 3 | Can in-world objects talk to a TerraViz server? | Yes, pending one check | **Yes, verified.** Script memory is the tighter limit, not the reply cap. §4.1 |
| 4 | Can a *live* TerraViz globe exist in a Second-Life-style world? | Only on OpenSimulator | **Yes, in Second Life itself.** TerraViz's output page drew a live day/night Earth on an in-world sphere with no code changes. Showing *datasets* on it needs one TerraViz change. §4.7, §7 |

The first version of this doc said the trap was answering (1) and
stopping, because (1) looked both the hardest and the least useful.
Testing overturned the "hardest" half. The real app runs, and the
fastest route to something people can stand next to is now a flat
in-world screen running the app, or a sphere running the output page
— not the script bridge the first version recommended starting with.

The framing still holds: **an in-world presence is a place to show
TerraViz, not a second copy of it.** Nothing here rebuilds the globe,
the catalog, or Orbit in LSL. What changed is how much of the real
TerraViz turns out to be showable directly. This is the same
conclusion [`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md)
reached about a completely different host.

---

## 2. Second Life today (mid-2026)

Worth stating plainly, because most people's mental image is from
2008: it's smaller than its peak, it is not dying, and the
engineering has moved more since 2023 than in the ten years before.

| | State as of August 2026 |
|---|---|
| **People online at once** | Peaked at 48,802 on 1 March 2026. Typical day runs 26,000–44,000. |
| **Accounts** | About 500,000 people log in monthly; 70 million accounts registered over the platform's life. |
| **World size** | Grew by 334 regions since January 2026. It is expanding, not contracting. |
| **Scripting** | SLua (a modern Lua) in open beta on the live world since December 2025. LSL is not deprecated — you pick per script. |
| **Graphics** | Modern PBR materials everywhere, plus reflections and mirrors. Importing whole 3D scenes is still not supported — only materials. |
| **Under the hood** | Still OpenGL. Moving to a modern graphics API is discussed as a multi-year problem with no date. |
| **Embedded browser** | Chromium **139.0.7258.139** in Firestorm 7.2.4 — the same build named in bug #5189 against Linden Lab's own viewer (§4.2). |
| **Voice** | Replaced with WebRTC across the whole world in May 2026. |
| **Phone app** | Free, on iOS and Android, still in public beta. Missing inventory, marketplace, building, and in-world dialog menus. |
| **Company** | Patch Linden, a ~20-year veteran, left in a May 2026 reorganisation. Pricing changed in June 2026: land got cheaper, Premium got more expensive. |

### What changed that matters if you last looked years ago

**SLua is the big one.** Luau brings proper data structures, multiple
timers, several event handlers in one script, and about half the
memory usage of the old runtime. If you know LSL, it all transfers —
the awkward parts are what's being replaced.

**But SLua doesn't change what scripts can do over the network.** The
limits in §4.1 come from Second Life's *servers*, not from the
language. A rewrite in SLua is nicer to write and no more capable at
the network edge. Design against the limits, not the language.

**Shared media has quietly become capable.** The embedded browser is a
current Chromium with hardware-accelerated WebGL 2 and H.264 video
(§4.2). Most of this document's revisions follow from that one fact.

---

## 3. What was tested, and how

All in-world results below come from one session on 23 October 2026:

| | |
|---|---|
| **Viewer** | Firestorm 7.2.4.80712, 64-bit, Windows |
| **Embedded browser** | Chromium 139.0.7258.139 |
| **Graphics** | NVIDIA GeForce RTX 4090 Laptop GPU, through ANGLE on Direct3D 11 |
| **Objects** | Two default prim spheres in a sandbox region |

So everything here is **one machine, one viewer** — and a very fast
graphics card. §10 question 8 lists what that leaves open.

**The method.** An LSL script asked the region for an HTTP-in address
(`llRequestSecureURL`) and served its own test page from it, marked
as HTML (`llSetContentType` with `CONTENT_TYPE_HTML`). It then put
that page on the sphere through shared media. The page ran browser
checks — Chrome version, WebGL, the graphics card, video formats, a
WebGL drawing test, HLS playback — and sent its results back to the
script, which said them in local chat. Chat commands switched the
sphere between the test page, a TerraViz image, a TerraViz video, a
long-running WebGL "soak", and the real TerraViz app.

The script also asked the production TerraViz node for data from
inside Second Life, and reported the reply sizes and its own memory
use.

Two properties of the method matter for reading the results:

- **A script-served page renders only for its owner.** Second Life
  treats a script's HTML as a web page only for the object's owner,
  in their own viewer, in the same region (the `llSetContentType`
  rule, §11). That suits a test kit and rules it out as an exhibit.
  Pages served from TerraViz's own site, like the app and the output
  page, have no such limit.
- **The test page was checked before it went in-world.** It was run
  through every mode in headless Chromium against a stand-in for the
  script, and the LSL was built from that tested page and passed
  `lslint` with no errors. That proves the test was sound. It proves
  nothing about Second Life's browser, which is what §4 is for.

**The kit is in [`scripts/second-life-probe/`](../scripts/second-life-probe/README.md)**,
with instructions for running it in-world. It has moved on from the
version that produced §4, so a rerun won't match those numbers line
for line:

- **Media at 2048×1024**, not 1024×512, now that the cap is known
  (§4.3), and the image mode shows the 2048-wide Nighttime Lights frame
  rather than the 1024 one §4.6 cites.
- **The node check is its own script** (`node-check.lsl`). Measured
  inside the probe, which carries its whole test page as string
  constants, one full reply took the script past its limit (§4.1). On
  its own, its memory reading is what a lean script pays. The probe
  reports its own peak instead, each time it serves its page.
- **The WebGL test stops before the video test starts.** The version
  that went silent at 11:40 left its WebGL loop running underneath the
  video (§4.3), so that overlap no longer happens.
- **A crash watchdog that can't misfire the way the first one could.**
  It used to be armed whenever the page was fetched. Every nearby
  viewer fetches it, and pages served by TerraViz itself never reach
  the script at all, so switching commands or another avatar arriving
  could produce "the page went quiet" with nothing wrong. Now a command
  arms it and the page's own reports confirm it. It also covers a soak
  that dies in its first seconds, which #5189 describes and the first
  version never reported.
- **An `sos` command** for the output page, and **a fresh address on
  every command**, because the viewer doesn't reload media whose
  address hasn't changed — repeating a command used to silently do
  nothing.

---

## 4. What the tests found

### 4.1 Talking to TerraViz from a script

**Verified: Second Life's servers can reach TerraViz, and LSL reads
its JSON natively.** The production node answered with HTTP 200 from
inside Second Life, so Cloudflare's bot protection did not get in the
way. `llJsonGetValue` read the events reply directly and pulled out
the event's title. *(An earlier version of this document said scripts
would need a hand-written JSON parser. LSL has had JSON functions since
May 2013.)*

**The reply cap is real.** `llHTTPRequest` limits:

| Limit | Value |
|---|---|
| **Reply size** | **2 KB by default, 16 KB maximum** — confirmed: the catalog arrived cut off at exactly 16,384 bytes |
| Request size | Up to 32 KB, bounded by the script's memory |
| Rate | 25 requests per 20 seconds per object; 1,000 per 20 seconds per owner |
| Timeout | 60 seconds, then discarded |

**But script memory is the tighter limit.** An LSL script gets
65,536 bytes in total, and a reply costs about **two bytes of memory
per character** while the script holds it:

| | Events reply (819 characters) | Catalog reply (16,384 characters) | Difference |
|---|---|---|---|
| First run | 33,362 bytes in use | 62,940 of 65,536 | 29,578 |
| Second run (script grew ~4.8 KB) | 38,212 | **67,790 of 65,536** | 29,578 |

The difference was identical to the byte in both runs. In the second
run the script was over its limit and kept going, so the limit
evidently isn't enforced at that exact moment — but a script that
does anything besides receive data cannot safely take a maximum-size
reply. That is the real argument for compact server replies.

Reply sizes measured from outside Second Life the same day:

| Endpoint | Reply size today | Usable in-world? |
|---|---|---|
| `/api/v1/events` | 820 bytes (1 event) | **Yes** — read in-world with `llJsonGetValue` |
| `/api/v1/featured?limit=24` | 15 bytes — empty, nothing curated yet | Today, yes. Full (roughly 14 KB) it would cost a script ~26 KB of memory |
| `/api/v1/featured-hero` | 13 bytes — `{"hero":null}`, no pin set | Yes, but see §6 Option A |
| `/api/v1/catalog` | **822 KB** (180 datasets, ~4.6 KB each) | **No** — 50× over the cap. The largest single dataset record is about 16 KB, the whole budget on its own |

### 4.2 Inside the embedded browser

The test page reported, on every run:

| Check | Result |
|---|---|
| Browser | Chromium 139.0.7258.139 |
| WebGL 1 / WebGL 2 | **Both available** |
| Graphics card | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU … Direct3D11 …)` — hardware-accelerated, not software rendering |
| H.264 video, at TerraViz's own codec strings (`avc1.4d4020`, `avc1.4d4033`) | **Supported** — "MSE yes, video tag probably" |
| AAC audio, VP9, AV1 | All supported |
| HLS played natively by the `<video>` tag | **No** — a page needs hls.js |
| hls.js playing a public test stream | **Played**, 1920×1080 |

The first version of this doc worried that stock builds of the
embedded Chrome leave out H.264 for licensing reasons. Firestorm's
build includes it, and Linden Lab's viewer reports the same Chromium
version — likely the same, unconfirmed (§10 question 8).

### 4.3 WebGL stability

TerraViz needs **WebGL 2 specifically**. The app checks for it before
anything else and shows a troubleshooting screen if it's missing
(`src/utils/webglSupport.ts`), because the map engine, MapLibre 6,
dropped WebGL 1 outright. The globe itself is a custom 3D sphere
(`src/services/mapRenderer.ts:1506-1508`), video frames go to the
graphics card every frame (`setVideoTexture`, `:1557`), and the
hover-value readout deliberately refuses any non-graphics fallback
(`src/services/glLumaSampler.ts:134-144`).

Bug [secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189),
filed on 28 December 2025 by a Linden Lab developer, reports that a
standard WebGL demo makes shared media go blank after a few seconds.
The media process (`SLPlugin.exe`) dies with an access violation
inside the embedded Chrome library (`libcef.dll`). As of October 2026
it is still open, unassigned, and labelled stale. The first version of
this doc took it as ruling out the real app.

**It did not reproduce here:**

| Test | Result |
|---|---|
| 10-second WebGL drawing test | 602 frames (60 fps), no lost context, pixel readback correct — on both runs that reported |
| Continuous WebGL "soak", reporting every 10 seconds | **450 seconds, 27,001 frames**, no lost context, stopped by hand |
| The real TerraViz app, with a video dataset playing on its globe | Ran (§4.5) |

One run did go silent. At 11:40 the viewer reloaded the test page on
its own — at a different, square size — and that run never reported
its WebGL result. An earlier version of the test page kept its WebGL
loop running underneath a playing video, which may matter. Whether
the media process crashed or the viewer simply unloaded the page is
unknown: the Windows crash log was not checked (§10 question 9).

So the honest summary is: **WebGL 2 works and stays up in Firestorm on
this machine, under light load and under the real app.** #5189's
reproduction used the WebGL Aquarium, a heavy demo, on a different
card. It may need more load than anything tried here, or a weaker
GPU, or the official viewer. It is a reason to test those, not a
reason to avoid WebGL.

The limits that remain are structural:

- **Size.** Shared media is capped at **2048 pixels on each side**.
  The constants are `MAX_WIDTH_PIXELS = 2048` and
  `MAX_HEIGHT_PIXELS = 2048` in the viewer source
  (`indra/llprimitive/llmediaentry.h:187-188`), and a script that asks
  for more gets `LSL_STATUS_BOUNDS_ERROR` rather than a smaller size
  (`llmediaentry.cpp:573`, `:580`). The Media Settings dialog clamps
  instead. **2048×1024 worked** on the test machine — four times the
  pixels of the 1024×512 this doc first assumed was the limit.
- **It runs once per person.** Every avatar's viewer runs its own
  copy of the page: its own GPU work, its own video stream, its own
  connections to TerraViz.
- **One face per call**, and an **address whitelist** capped at 64
  entries or 1024 characters. Neither came up in testing.

### 4.4 Video

| Test | Result |
|---|---|
| TerraViz's hurricane-season stream, from the script's test page | **Refused** — `networkError / manifestLoadError` |
| A public test stream, from the same page | Played, 1920×1080 |
| TerraViz's hurricane-season stream, inside the real app | **Played** (§4.5) |

The refusal is CORS, and it was predicted. TerraViz's video host
grants cross-origin access only to `https://terraviz.zyra-project.org`
(§11, Measurements). A page served from anywhere else — a script, a
partner's site, an OpenSimulator grid — can't load the streams through
hls.js. And with no native HLS in this browser, hls.js is the only way
in. So **a page that plays TerraViz video in-world has to be served
from TerraViz's own site.** The app is; the output page is too.

### 4.5 The real app

| Address | Result |
|---|---|
| `https://terraviz.zyra-project.org/?embed=1` | Ran |
| `https://terraviz.zyra-project.org/?embed=1&dataset=01KQG611HF8YXJNRBEHT0757KT` (Hurricane Season 2024, a video dataset) | **Ran, video playing on the globe** |

Both ran on a sphere, where they look wrong: the app draws a camera's
view of a globe, and wrapping that picture around a sphere gives you a
globe of a globe. On a flat panel it would be correct as it stands —
but that has not been tried yet, and neither has how long it runs
(§10 question 12).

This is the result that most changes the doc. The full app — including
the Analyze panel, the colour controls and the hover readout this doc
once said could never come in-world — is available on an in-world
screen today, with no TerraViz changes.

### 4.6 A TerraViz image on a sphere

The test page's image mode put the Nighttime Lights dataset's 1024×512 frame
(`https://d3sik7mbbzunjo.cloudfront.net/land/earth_night/2012/nightlights_1024.jpg`,
the address the TerraViz manifest gives) on the sphere through a plain
`<img>`. It loaded, and once the sphere was set up correctly (§5) it
looked right. A plain image needs no CORS permission, so any page can
show TerraViz's still-image datasets — 48 of the 180 in the catalog.

### 4.7 The output page on a sphere

TerraViz's output page — the renderer built for physical spheres —
is on the production site at
**`https://terraviz.zyra-project.org/output/output`**. Note the
address: `/output.html` falls through to the main app, because the
site serves the app for any path it doesn't recognise.

Outside the desktop app it skips its link to a control window
(`src/output/main.ts:233`) and draws its idle Earth: day/night line
for the current time, city lights, clouds, the atmosphere's tint. It
takes its drawing mode from its own address, and a bare address means
the LED-sphere unwrap (`src/output/main.ts:83`). The day/night line
moves as you watch; the clouds stay as they were when the page
loaded, although the image they come from is replaced every ten
minutes (§7 item 8).

**On the sphere it was correct** — continents upright, the day/night
line in the right place, the poles closed — once the media size was
2:1. The one problem on the way was instructive:

- **Black caps at both poles.** When the media was set through the
  Media Settings dialog, its size read 0 × 0, and the viewer gave the
  page a square shape. The output page keeps its picture 2:1 inside
  whatever window it gets (`object-fit: contain`,
  `src/output/output.css:35`) and fills the rest with black. On a
  sphere those bands become polar caps. Setting the size back to 2:1
  fixed it.

`contain` is right on a monitor, which is what it was written for. On a
sphere, stretching is better: the sphere's texture coordinates run
0 to 1 whatever the image's proportions, so a stretched picture still
wraps correctly and only loses some horizontal sharpness. And viewers
can fall back to a square page on their own — that is what happened at
11:40 — so an exhibit shouldn't depend on every viewer keeping the
size it was given. §7 item 2.

The page draws at **4096×2048** by default
(`src/services/multiOutput/protocol.ts:579`) whatever the page size,
because outside the desktop app nothing tells it otherwise. In a
2048×1024 media texture that is four times the pixels anyone can see,
drawn on every visitor's machine. It only redraws about once a second
while nothing moves, so it was no trouble here — but §7 item 3.

---

## 5. The lucky part — and the catch in it

TerraViz stores every dataset as **equirectangular** frames — that
unrolled-world-map rectangle, twice as wide as tall. The publisher
tools say so outright: "the dataset's data *is* a 2:1 equirectangular
image" (`src/ui/publisher/components/asset-uploader.ts:98`,
`src/ui/publisher/components/dataset-form.ts:1705`), and the globe
renderer wraps them that way rather than using a map projection
(`src/services/mapRenderer.ts:1506-1508`). That is the image shape a
sphere expects when you wrap a texture around it, which TerraViz's own
3D code relies on too (`src/services/photorealEarth.ts:206`).

**So there's no conversion work at all** — but a default Second Life
sphere doesn't expect it *the right way round.* A first test put a
TerraViz frame on a plain sphere and it came out sideways, with the
city lights running in streaks from pole to pole.

The viewer's own source explains why (`indra/llmath/llvolume.cpp`,
`secondlife/viewer` at `fd2040c`):

- A sphere is a **half-circle swept around an axis**. The half-circle
  is generated with its two ends at x = ±0.5 (`:490`, `:713`), and the
  path that sweeps it revolves around **`(1, 0, 0)`** — the X axis
  (`:1287`, `:1302`). So **a default sphere's poles point sideways**,
  along its own X axis, not up and down.
- Texture coordinates are set as `(ss, tt)` (`:7223`): the image's
  horizontal axis follows the half-circle, **pole to pole**, and its
  vertical axis follows the sweep, **around**. A world map needs the
  opposite. So it lands rotated 90°.

**The recipe**, confirmed with a labelled grid image on both shared
media and an ordinary (local) texture:

| Setting | Value |
|---|---|
| Object rotation | **X 0, Y 270, Z 0** (−90° about Y, which carries the poles upright) |
| Texture rotation | **90°** |
| Repeats / offsets | 1, 1 / 0, 0 |
| Mirroring | None |

With that, north is up, east and west are the right way round, and
text reads left to right. The face's texture rotation applies to
shared media too, which the source alone couldn't settle. The Nighttime
Lights image and the output page both looked right under it.

A **custom mesh sphere** is still the better choice for anything
permanent: correct with no settings to explain, so nobody "fixes" the
rotation back, and portable to OpenSimulator. Use a **UV sphere**
(latitude/longitude rings) — Blender's default UV Sphere is correct
out of the box — not a geosphere or icosphere, whose triangles don't
follow latitude and longitude, so a world-map image tears along seams
and distorts near the poles. The default sphere plus the recipe is a
fine fallback that needs no file to distribute.

### What doesn't come along — on a sphere

On a *sphere*, TerraViz is a picture of the data. Palette switching,
contrast stretch and the hover readout all run as programs on the
graphics card (`src/types/color-scale.ts:176`, `:230`), and Second
Life materials can't run programs. The output page doesn't carry
them either. On a flat panel running the full app (§6 Option E),
they all come along, because it is the real app.

---

## 6. The options, re-ranked

| Option | What you get | Status after testing | Who can see it |
|---|---|---|---|
| **E. The full app on a flat panel** *(new)* | The real TerraViz, interactive, measurement tools included | **Works today**, no TerraViz changes; typing confirmed in Firestorm | Anyone with a viewer that runs it — not yet confirmed with a second avatar |
| **C. A live globe from the output page** *(reshaped)* | A correctly wrapped, live Earth on a sphere | **Idle Earth works today.** Datasets need one TerraViz change (§7) | Same as E |
| **A. Scripts talk to the server** | Links out, event boards, kiosks | **Verified.** One small endpoint worth adding | Everyone |
| **B. Flipbook globe** | An animated globe from uploaded frames | **Mapping verified.** Uploads cost L$ | Everyone, likely phones too |
| **D. OpenSimulator** | A globe on a world you host | No longer the only route to "live" | A much smaller audience |

Options A–D keep the letters the first version gave them.

### Option E — the full app on a flat panel

Put `https://terraviz.zyra-project.org/?embed=1` (or with
`&dataset=<id>`) on a flattened box face, through the Build tool's
Media settings, at 2048×1024. The embed address format is stable and
documented ([`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md)); `embed=1`
hides the app's chrome, and `&chat=1` brings Orbit back through the
existing chat path.

What to know:

- **Each visitor's copy is their own.** Shared media shares the page's
  *address* between viewers, not what happens inside it — so one
  visitor turning the globe doesn't turn it for anyone else. That's
  fine for a self-serve kiosk, wrong for a presenter.
- **Who can interact** is the media's interaction permission
  (`PRIM_MEDIA_PERMS_INTERACT`): owner, group or anyone.
- **Every visitor needs WebGL 2 in their viewer**, and pays for the
  rendering on their own machine.
- **Typing works.** Eric typed into the full app at
  `terraviz.zyra-project.org` on a flat panel in Firestorm 7.2.4 on
  24 October, which is what search and Orbit need. That was the first
  time anyone typed into the app in-world.
- **A navigation is shared, though, and that is the panel's one
  catch.** If a visitor does something that loads a *different page*,
  such as the Privacy page, the blog or "Meet Orbit", their viewer
  sends the new address to the region. Every viewer near the panel then
  follows it, reloading at that page and losing whatever its visitor
  was doing (`mediaNavigated`, §11). This is from the viewer's source
  and not yet seen in-world. Loading a dataset only rewrites the app's
  own address (`pushState` in `main.ts` and `datasetLoader.ts`) rather
  than navigating, so it is expected not to spread, but that is
  unconfirmed too. Both are one check with a second avatar: the first
  clicks the Privacy link, then loads a dataset, and the second watches
  their own panel.
- **The panel runs the full app's telemetry**, Essential on by default,
  unlike a globe, which reports nothing unless its owner turns it on.
  The concern the privacy review raised for globes applies here too: a
  venue matching its own log of avatar arrivals to `session_start`'s
  locale, OS and screen. It is worth settling before a public
  installation.

**Setting up a self-serve kiosk.** A face showing the app's homepage,
with no script, is a kiosk: every visitor explores on their own. The
face's Media Settings should then be:
- **Permissions → Interact: Anyone**, so visitors can click and type.
- **Permissions → Control bar: Owner only.** Otherwise anyone can type
  a new address into the media bar, and it goes to everyone.
- **Security → whitelist on**, with `terraviz.zyra-project.org` only.
  A click on an outside link, such as a dataset's source, then can't
  move everyone's panel off-site.
- **General: Auto play and Auto scale on.** Auto zoom is a choice: on a
  large panel it pulls each visitor's camera in when they click.
- **An optional reset.** A few lines of LSL can read the face's current
  address every minute or so and, after a few idle minutes away from
  the homepage, put the homepage back, so one visitor's click on the
  Privacy page doesn't stay there for the next.

**A panel everyone shares** is not something the homepage can do,
since nothing inside the app is shared between viewers. The shared path
is the one Phase 1 built: the output page steered by a script. It
doesn't need a sphere. On a flat 2:1 face it draws the same picture as
a world map, in step for every visitor and driven by the same address.
The globe script's spin and its texture recipe for spheres don't apply
to a flat face, so a flat-panel mode is a small addition to the Phase 2
controller. An exhibit can have both: the shared globe for the room,
and a kiosk panel beside it where visitors explore and ask Orbit on
their own.

### Option C — a live globe from the output page

The first version proposed a separate video-only page for spheres.
Testing showed something better already exists. TerraViz's output
page draws exactly the unwrapped image a sphere needs, plays
datasets, and is served from TerraViz's own site, so the video host's
CORS rule lets it through. Today it shows the idle Earth only. In the
desktop app it gets its dataset from the control window; on the web
there is no control window, so it needs to get the dataset from
somewhere every visitor's copy can read — its own address. §7 is that
plan.

Setup today: the output page's address in a sphere's media, at
**2048×1024** (or 1024×512), with the §5 recipe applied.

### Option A — in-world scripts talk to TerraViz

Verified end to end in §4.1. What you can build, easiest first:

- **A handoff link** — `llLoadURL` opening
  `https://<node>/?embed=1&dataset=<id>` in the visitor's own browser.
  No code changes.
- **An events board** reading `/api/v1/events` directly with
  `llJsonGetValue`. Verified in-world.
- **A "Right now" kiosk.** This one needs a server change. The hero on
  the catalog's landing page isn't stored anywhere a script can ask
  for it: `src/services/heroService.ts` *computes* it in the browser,
  from a curator pin if one is live, else the freshest approved
  current event, else a real-time dataset updated in the last 24
  hours. The server's `/api/v1/featured-hero` returns only the raw
  pin, deliberately without checking its date window
  (`functions/api/v1/featured-hero.ts`). So a kiosk would have to
  rebuild that chain in LSL — or ask an endpoint that resolves it.

The proposal is one small, purpose-built reply that moves that logic
to the server:

```
GET /api/v1/lsl/hero    → id|title|iso_time|thumb_url    (the resolved pick)
```

Pipe-separated, so one `llParseString2List` call splits it, and small
enough that the memory cost in §4.1 doesn't arise. A server-resolved
hero would help other non-browser hosts too — kiosk displays, the
WordPress plugin — so it may deserve a less Second-Life-specific name.
Production currently has no featured datasets and no hero pin, so a
kiosk today could only show the approved-event or real-time fallbacks.

### Option B — the flipbook globe

Upload equirectangular frames as ordinary textures and swap them on a
timer. The mapping is verified (§5, with a local texture standing in
for an upload). What remains is cost and size:

- Uploads cost **L$10 each**, so a 30-frame loop is about L$300,
  roughly US$1.20. Someone's account has to be in good standing to pay
  for them — for an institution, a question of which account and who
  funds it.
- Uploaded textures are believed to be capped at **1024×1024**, so a
  frame lands around 1024×512. That figure is unverified: the 2048
  limit in §4.3 belongs to shared media, a separate system. The Beta
  grid (Aditi) has historically made uploads free, which is the cheap
  way to settle it.

What it still offers that nothing else does: no browser, no WebGL, no
dependence on TerraViz being up — and, most likely, the phone app,
which shows ordinary textures whatever it does about shared media.

### Option D — OpenSimulator

OpenSimulator's `osSetDynamicTextureURL` puts an image straight onto
an object from a web address: no upload fee, no per-person browser.
The first version called this the only route to a live globe; the
output page (Option C) now gives Second Life one directly. OpenSimulator
remains the self-hosted route — a world on your own hardware pulling
from your own TerraViz node, the architecture in
[`SELF_HOSTING.md`](SELF_HOSTING.md) and
[`architecture/federation-scoping.md`](architecture/federation-scoping.md)
wearing a different client — for a much smaller audience.

---

## 7. The plan: the output page as an in-world globe

This is the one piece of TerraViz work the testing points to. It
extends a direction the multi-monitor plan already left room for:
[`MULTI_MONITOR_PLAN.md`](MULTI_MONITOR_PLAN.md) §8 ships the outputs
desktop-only in v1 and says the architecture lets a web implementation
replace the desktop link "without touching the output rendering code"
(its Phase 5). That plan pictured two windows in one browser.
Second Life is a different host: every avatar's viewer runs its own
copy, with no control window to talk to. So the state comes from the
page's own address.

The work, smallest first:

1. **Load a dataset from the address** (`?dataset=<id>`). The page asks
   the node for the dataset record and its manifest — `hls` for a
   video, `variants` for an image (§11) — builds the `MirroredDataset`
   it already plays, and hands it to `createDatasetMirror`
   (`src/output/datasetMirror.ts`), the same object the desktop link
   supplies. The compositing — bounding box, longitude origin, flip,
   palette — is `layerStack`'s, unchanged. The control side already has
   this mapping, written to take plain values
   (`src/services/multiOutput/mirrorState.ts`: `toMirroredDataset`,
   `overlayForMirror`). The constraint is the bundle boundary: the
   output bundle is kept clear of the main app's loader graph, so this
   cannot simply import `dataService`.
2. **Fill instead of letterbox** (`?fit=fill`), switching
   `object-fit: contain` (`src/output/output.css:35`) to `fill`. Keep
   `contain` as the default, which is right for the monitors it was
   written for.
3. **Choose the render size** (`?width=2048`). The ladder is already
   1024 / 2048 / 4096 / 8192, defaulting to 4096
   (`src/services/multiOutput/protocol.ts:573`, `:579`). 2048 matches
   the largest media texture Second Life allows.
4. **A shared clock.** Without a control window, each visitor's copy
   starts wherever it happened to load. Two people looking at the same
   hurricane then see different days, which is fatal the moment
   someone points at it and says "here".

   **What the clock has to do** was agreed with Eric on 24 October
   2026, in an interview about how a globe is used:
   - **A globe is a permanent exhibit**, there all the time, like one
     in a museum.
   - **During a talk, a presenter controls it.** The presenter comes
     from a named list of people, such as staff or volunteer
     educators. Anyone else's clicks do nothing until the talk ends.
   - **Outside a talk, anyone who walks up can control it.**
   - **Everyone at a globe sees the same moment.** Anything one person
     does — pause, jump to a date, switch dataset — shows for
     everyone there.
   - **Paused, everyone sees exactly the same frame.** Playing, close
     is enough, as long as everyone lands on the same frame when it
     pauses.
   - **Five minutes after the last visitor leaves, it goes back to the
     live Earth**, with today's clouds and the real day/night line.
     - It's timed from the visitor leaving, not from the last control
       touched, so someone watching a long dataset without touching
       anything isn't cut off partway through.
     - It never happens during a talk.
     - The five minutes is a setting on the in-world object, so an
       exhibit can change it without new code.
     - Agreed with Eric on 24 October.
   - **In a field of globes, each globe is its own experience.**

   **The rest was decided with Eric on 24 October 2026**, in a second
   round of the same interview. Each number below is a setting on the
   in-world object, like the five minutes, so an exhibit can change it
   without new code.
   - **Sharing between walk-up visitors is a must.** Everyone at a
     globe always sees the same dataset and moment. Shared media
     already gives this: the address the script sets reaches every
     viewer.
   - **"Close" while playing means about a second.** Today's behaviour
     meets it (the status note below has the numbers). Copies agree to
     the millisecond once settled, differ briefly after a jump or a
     slow first load, and land on the same frame when paused.
   - **Someone is "at" a globe when they are within a set distance of
     it**, checked every few seconds. The default is 15 m, about as far
     as the media stays legible. The same check decides when the last
     visitor has left. Anyone on the parcel was ruled out: in a field
     of globes, no globe would ever reset.
   - **When two walk-up visitors reach for one globe, a short hold
     decides.** Whoever acts keeps control until 60 s after their last
     action. Anyone else who reaches for it is told who has it, and
     when it frees up.
   - **The date shows in the hover text**, readable from every side and
     leaving the picture alone. It is exact when paused and updated
     every few seconds while playing, worked out from the record's
     start time and the position in the clip.
   - **A visitor whose viewer can't keep up sees the right moment at a
     lower quality.** That is the Video Streaming Engineer's
     recommendation, in the status note below.
   - **The presenter list is a notecard inside the globe**, one name per
     line, reread when it changes. It needs no server, and each globe
     can have its own list.
   - **Credit has two parts.**
     - **A short credit goes in the hover text**, from the record's
       attribution, such as `Credit: NOAA · CC BY 4.0`.
     - **A touch gives the abstract and the full credit.** If the globe
       holds a notecard named by the dataset's id, the visitor is given
       that. Otherwise the script sends the abstract, the credit and
       the licence link to that visitor alone, in private chat, in
       pieces of about 1 KB, with a link to the dataset's page. A
       script can't write a notecard at runtime in Second Life, so
       notecards are for curated datasets and chat covers the rest.
   - **A presenter starts a talk** from the globe's menu with "Start
     talk". It ends on "End talk", or once no presenter has been at the
     globe for 2 minutes, so a presenter who logs off doesn't lock the
     globe.

   **What those decisions bring with them:**
   - **List presenters by username, not display name.** A display name
     can be changed, and two avatars can share one, so a visitor could
     take a presenter's display name and get control.
   - **The date needs the clip's length, and the wire didn't always
     carry it.** The record has a start and an end time, but the
     manifest reported a duration of 0 for videos the node hosts
     itself. Without the length a script can't turn a position into a
     date. Phase 2 does both of these:
     - fill in the manifest's `duration`. The Federation reviewer
       classed it as a behaviour change, since the field already
       existed, and found no blocker. *Done for `r2:` HLS bundles, which is
       what the node hosts itself:* the manifest now reads the length
       from the bundle's own playlists
       (`functions/api/v1/_lib/hls-duration.ts`), and 0 still means
       unknown (`CATALOG_BACKEND_PLAN.md` beside the manifest's shape).
       Hurricane Season 2024 reads 183 s, the same on all three
       renditions. `vimeo:` already carried Vimeo's figure, which is
       whole seconds and so not quite the stream's: 12 for the
       real-time sea surface temperature's 12.1 s
       (`CATALOG_BACKEND_PLAN.md` says so beside the manifest). Every
       copy of the page plays the `hls` stream and loops on its length,
       so a date worked out from Vimeo's drifts from the picture with
       every loop, months on a year-long clip after a few minutes. The
       controller therefore shows those datasets' range. It knows one
       by a `player.vimeo.com` address in the manifest, since only the
       node knows a row is `vimeo:`, so a proxy that rewrote that
       address would defeat it. The fix belongs on the node: report 0
       for `vimeo:`, or sum the Vimeo playlist as `hls-duration.ts`
       sums the node's own, which would give those datasets a moving
       date. `stream:`
       and single files still report 0, and any reading can be 0 for
       a moment when the bucket is slow, which the manifest caches for
       15 s rather than five minutes;
     - show the dataset's date range when the exact date can't be
       worked out, which covers those.
   - **The slow-link behaviour is page work, not the controller's.** It
     lives in the clock steering and the HLS player, plus a 1024×512
     rendition in the transcode pipeline. That is two pull requests
     apart from Phase 2's, with the Video Streaming Engineer reviewing.
   - **Touch on the globe itself is unconfirmed.** From the viewer's
     source, a left-click on a face showing media goes to the media,
     and only right-click → Touch reaches the script. If visitors'
     left-clicks don't arrive, the controls and the credit move to a
     touchable stand beside the globe. One in-world check settles it:
     a second avatar left-clicks the globe, and the smoke-test script,
     which answers a touch in chat, shows whether it arrived.
   - **The hover text holds 254 bytes**, shared by the title, the date,
     the credit and any telemetry notice. Phase 2 needs a fixed order
     for them and a rule for shortening. *Set in the controller:* the
     notice comes first, under the globe's name, then the title, the
     date and the credit, then a talk if one is on and how to touch the
     globe. Only the title and the credit are ever cut, sharing what the
     rest leave, so the notice never is: the title keeps at least 32
     bytes and the credit 48 where both fit, and the title's come first
     where they don't, as behind a preview node's longer address.

   **What that means for the design.** The first version of this item
   had each copy work out its position from the time of day. That only
   covers playback nobody touches: a pause, a jump or a switch has to
   reach every visitor's copy. Second Life already has one channel
   that does.
   - **The globe's media address reaches every viewer near it.** The
     in-world script sets the address, and it knows who touched the
     globe, so it can check the presenter list.
   - **So all control has to go through the script.**
     - Inside the page, what one visitor does stays in their own copy.
     - A *navigation* doesn't: a visitor whose interaction permission
       allows it can move the page to a new address, and their viewer
       broadcasts it to everyone (`LLVOVolume::mediaNavigated`, §11),
       limited only by the media's URL whitelist.
     - So the globe's media has to be non-interactive (interaction
       permission "none"), or one click could go around the presenter
       list.
   - **The address can carry the whole clock**: the dataset; when
     paused, the exact time it is paused at; when playing, a position
     in the clip, the moment that position was current, and the rate.
     - Each copy works out where it should be as that position, plus
       the time since that moment multiplied by the rate.
     - Every pause, resume and jump writes a new position and moment.
       Resuming at 40 s and at 70 s are then different addresses,
       which "the moment play was pressed" on its own can't tell
       apart.
     - Each copy reads the time since that moment from its own
       computer's clock. That keeps copies close as long as visitors'
       clocks are set from internet time, which most are.
     - This also settles the worry about datasets with a real time
       axis. A hurricane season is anchored to the moment someone
       pressed play, not to the time of day. Only the idle live Earth
       follows the real clock, and it should.
   - **"Exactly the same frame" needs a new paused path.**
     - The output's existing steering moves a video toward its target.
       That's `syncByRatio` in `src/output/outputSync.ts`, or, for a
       dataset with a time axis, the `computeSiblingSyncCorrection`
       it calls from `src/utils/time.ts`.
     - But it leaves anything within 0.15 s of the target alone,
       paused or not (`outputSync.ts:290`, `:372-374`;
       `SIBLING_HARD_SEEK_THRESHOLD_S`, `src/utils/time.ts:259`).
       Two paused viewers could then sit several frames apart at
       30 fps.
     - A paused globe should instead seek to the paused time whatever
       the drift, and stay there.
     - The desktop outputs' tolerance stays as it is; it's measured
       for playback, and nobody asked them for a frame.
   - **The catch is reloading.** Changing the address makes every
     viewer reload the page and re-buffer its video. Changing only the
     part after `#` might avoid that (§10 question 10). The viewer's
     source predicts it does. The kit's `/7 hash` tests it in-world.
     - **If the `#` test passes,** the design is the address alone,
       with no server.
     - **If it fails,** there is a choice to make. One option is to
       accept a reload on every pause, jump and switch. The other is a
       small service on the node that holds each globe's state. §8
       rules that out today, since it says nothing in-world writes
       back to TerraViz, so it would be a change to the plan, not a
       detail.
   - **The page's half is the same either way.** It reads the clock
     from its address when it loads, and again whenever the part after
     `#` changes. A reload just reads the same address from scratch.
     The test decides what each change costs visitors, not what the
     page does.
   - **A field of globes degrades with distance** (§10 question 13).
     - **Each visitor's viewer runs only a few globes properly.** The
       viewer's source caps how many web pages run at once (8 by
       default), and only the 2 that look largest on that visitor's
       screen run at full priority. The rest are scaled down, update
       only now and then, or don't load.
     - **So past about six globes,** the distant ones in a field will
       barely move.
     - **The clock makes that harmless.** A globe that drops out and
       loads again reads its address and lands on the shared moment,
       so it falls back into step rather than drifting.
5. **Cap the video quality to what the texture can show.** TerraViz's
   stream offers 4096×2048 at 27.7 Mbps, 2160×1080 at 9.0 Mbps and
   1440×720 at 4.6 Mbps (§11). At 2048×1024 the middle one is
   indistinguishable from the top one at a third of the bandwidth —
   and every visitor streams separately, so a 40-avatar event at
   9 Mbps each is about 360 Mbps from TerraViz's video host. The HLS
   wrapper already caps renditions (`autoLevelCapping`,
   `src/services/hlsService.ts`).
6. **Rotation.** *Spinning* the globe needs no TerraViz work at all: spin
   the prim with `llTargetOmega`, which Second Life does smoothly and
   for free. *Which longitude faces front* is a setting the output
   already has (the rotation offset, `normalizeRotationOffset` in
   `src/services/multiOutput/outputPersistence.ts`), so `?rotation=`
   is a small addition.
7. **Zoom, and bringing a place to the front.** The output already has
   both, from the LED-sphere work (`followCamera` and the camera
   offset in `src/output/equirectRtt.ts`). Fixing a view in
   the address is easy. Changing it *live* is the hard part: changing a
   prim's media address makes every viewer reload the page and
   re-buffer its video. One possible way round it is to change only
   the part after `#`, which browsers don't reload for — if Second Life
   passes such a change through to every viewer (§10 question 10).
   It is the same question item 4 turns on, so one test answers both,
   and it comes before either is designed in detail. The kit's
   `/7 hash` runs it.
8. **Keep the clouds current.** The output page loads its cloud image
   once, at startup (`src/output/outputScene.ts:983`), and never again.
   The image it loads is replaced upstream every ten minutes:
   `clouds_8192.jpg` and `clouds_4096.jpg` on the Science On a Sphere
   Explorer bucket (`src/utils/deviceCapability.ts:103`) changed at
   21:15:04 and again at 21:25:04 UTC on 23 October (§11). So a page left
   open shows the sky from whenever it loaded — and in Second Life,
   where every visitor's copy loads on its own, two visitors at one
   globe can see different skies.

   Refreshing is the easy half. The hard half is where every refresh
   comes from. Today each copy of the page downloads straight from that
   bucket, which TerraViz doesn't run, and it takes the 8192-wide image
   (4.9 MB) on anything that isn't a phone (`deviceCapability.ts:106`).
   Second Life's browser isn't a phone. At one download every ten
   minutes that is about 29 MB an hour per copy, so a 40-avatar event
   pulls roughly 1.2 GB an hour from someone else's bucket.

   So the plan is to **keep a copy of the clouds in TerraViz's own
   storage** and have every page read that copy. Four parts:

   - **A small scheduled job copies the clouds into R2.** R2 is the
     Cloudflare storage TerraViz already uses for its datasets (one
     bucket, `terraviz-assets`, bound as `CATALOG_R2`;
     `wrangler.toml:145-147`). Visitors' reads of it cost no egress
     fees. The job checks upstream every couple of minutes with a
     conditional request: the server sends an ETag, so a check costs
     almost nothing when nothing has changed. It copies both sizes
     only when they have. That is about 5.9 MB every ten minutes, or
     roughly 850 MB a day, however many people are watching. That is
     less than one 40-avatar event's hour.
     - It has to be a **Cloudflare Worker with a cron trigger**, which
       is a new thing to deploy. Pages Functions, where the rest of
       TerraViz's server code lives, can't run on a schedule.
       GitHub Actions can (`zyra-scheduler.yml` runs every 15
       minutes), but its schedules are best-effort and can run late,
       which matters for a ten-minute product.
     - It has to **stream** each image from upstream straight into R2,
       never hold the whole file in memory first. On the Workers Free
       plan a run gets 10 ms of CPU. Time spent waiting on the network
       doesn't count, so a streamed copy should fit, but one that
       buffers 4.9 MB could fail on every update. That is an estimate,
       not a measurement, so test it on a free account before relying
       on it.
   - **Each copy gets its own name, plus a tiny pointer file.** The
     images are stored as, for example, `clouds/4096/<time>.jpg` and
     never overwritten. A name that never changes can be cached at
     Cloudflare's edge indefinitely, so most reads never reach R2.
     That matters because R2 charges per read. A small
     `clouds/latest.json` names the newest images.
     - Pages check the pointer every minute or two, and download an
       image only when the pointer names a new one. Every visitor's
       copy therefore changes within a minute or two of the others,
       with no clock alignment and no conditional requests in the
       page.
     - The pointer cache must be short (a minute or so). The images
       can cache forever. Cloudflare caches `.jpg` files by default but
       never JSON, so the pointer needs a cache rule. Without one,
       every poll by every visitor is an R2 read.
     - Visitors read the pointer and the images **straight from the
       bucket's public address**, never through a Pages Function or
       the Worker. On the free plan this is what keeps the copy from
       using up the node's daily request allowance (see "What it
       costs" below).
     - A rule on the bucket deletes copies older than a day, which
       keeps storage near 1 GB.
   - **The page falls back to upstream if the copy stops.** The pointer
     records when the job last checked upstream, as well as when the
     images last changed. If the last check is more than about 30
     minutes old, the job has stopped. The page then reads the upstream
     bucket directly, as it does today. It does the same if the pointer
     can't be read at all.
     - The page has to use the check time, not the change time, for
       this. If the producer itself stops updating, the copy is still
       as current as upstream, and switching to upstream gains nothing.
   - **Fetch the size the render can use.** Up to a 2048-wide render,
     the 4096 image (1.0 MB) already holds more detail than can be
     shown. That covers all of Second Life, whose media can't exceed
     2048 wide (§4.3). There is no 2048 image. The 8192 image is only
     worth its size on LED-sphere outputs set to a 4096 or 8192
     framebuffer, and on the main app on a large screen. The output
     page knows its framebuffer width, so it should choose by that
     rather than by whether the device is a phone. For the 40-avatar
     event, that drops the transfer from about 1.2 GB to 240 MB an hour.

   **Who runs a copy.** Most nodes shouldn't need one. A basic viewer
   node may have no R2 bucket at all: the bucket's public address
   (`R2_PUBLIC_BASE`) arrives at Phase 8.5 of the setup guide, with
   publishing ([`SELF_HOSTING.md`](SELF_HOSTING.md), `:1246`). So:
   - **TerraViz's own node runs the copy.** It serves Orbit to the
     public, which the setup guide says is what the paid plan is for
     ([`SELF_HOSTING.md`](SELF_HOSTING.md) §0.6).
   - **Other nodes read TerraViz's copy by default**, or read upstream
     as they do today. Either way there is no Worker, no bucket and
     nothing to deploy. This needs TerraViz's copy to allow every site
     to use it. The page asks for the clouds with `crossOrigin`
     (`outputScene.ts:334`), so the browser draws them as a WebGL
     texture only if the response's CORS headers allow the page's
     site. TerraViz's videos appear to come from this same bucket's
     public address (it serves `videos/…` paths, the key prefix
     `functions/api/v1/_lib/r2-store.ts:319` gives video bundles),
     and that address allows only TerraViz's own site (§4.4). So the
     clouds need a bucket of their own, or a header rule on their own
     path. Allowing every site on the whole bucket would allow it for
     the videos too.
   - **A node that wants to be independent runs its own copy**, and
     points the cloud-address setting (below) at it. The job fits the
     free plan if it streams.

   **What it costs.** Almost nothing on either Cloudflare plan. The
   figures assume a check every 2 minutes, a pointer write on every
   check, both sizes copied on each change, and copies kept for a day.

   | What gets used | Per month | Free or included | Past the allowance |
   |---|---|---|---|
   | Worker runs | about 21,600 | 10M on Paid; 100,000 a day on Free | Paid: $0.30 per million. Free: never billed |
   | Worker CPU | a few ms a run (estimate) | 30M ms on Paid; 10 ms a run on Free | Paid: $0.02 per million ms |
   | R2 writes | about 30,000 | 1M | about $0.14 |
   | R2 storage | about 0.85 GB | 10 GB | about $0.01 |
   | R2 reads | about 52,000 for each Cloudflare location where someone watches all day, with the pointer cached a minute | 10M | about $0.02 per such location |
   | Egress | — | R2 charges none | $0 |

   R2's allowances are per account, and R2 bills the same on either
   plan ([`SELF_HOSTING.md`](SELF_HOSTING.md), `:539`). An account
   whose datasets already use them up pays the right-hand column:
   cents a month. Two mistakes would cost more, one in money and one
   in an outage on the free plan. The design above avoids both:
   - **A pointer with no cache rule.** Then 40 avatars polling once a
     minute make about 1.7M R2 reads a month, around $0.60 past the
     free allowance.
   - **Visitors reading through a Function.** On **Workers Free** the
     whole account shares 100,000 requests a day with every API call,
     map tile and page view on the node (`SELF_HOSTING.md:540`,
     `:550-559`). When it runs out, the API and map tiles stop until
     midnight UTC, or the whole app goes down if the project is set to
     fail closed (`:566-577`). Those same 40 avatars, reading through
     a Function, would spend about 57,600 a day on clouds alone.
     Reading from the bucket's address, they spend none. The job's
     own checks cost about 720 a day, or 144 if it checks every ten
     minutes. Cloudflare's own pricing example counts cron runs as
     requests. On Free, the job also uses one of the account's five
     cron triggers.

   The copy also costs **upstream**. It pulls about 26 GB a month from
   the Science On a Sphere Explorer bucket whether or not anyone is
   watching. Today each desktop page load pulls one 4.9 MB image from
   it. The two break even at about 175 desktop page loads a day: above
   that, the copy saves them bandwidth, and below it the copy costs
   them more. Say so when asking.

   Two things to settle before building it:
   - **Ask the Science On a Sphere Explorer team** before mirroring
     their product, and credit them. The Credits panel doesn't name the
     cloud source today (`src/ui/creditsPanel.ts` has no mention of
     clouds), so this is the moment to add it.
   - **Make the cloud address a setting**, with three choices:
     TerraViz's copy (the default), the node's own copy, or upstream.
     This works the way `VITE_EARTH_ASSET_BASE` already redirects the
     other Earth images (`src/config/endpoints.ts:132-135`). The clouds
     ignore that setting today: their address is fixed in
     `deviceCapability.ts:103`.

   The day/night line needs none of this. The page works out the sun's
   position from the clock on every frame it draws
   (`outputScene.ts:1046`), and draws at least once a second.

   **The main app has the same gap, and would read the same copy.** Its
   globe also loads its clouds once (`src/services/earthTileLayer.ts:1700`,
   from the address set at `earthTileLayer.ts:87`), so a museum kiosk or
   a browser tab left open all day shows the morning's clouds. Fixing
   it is a separate change, in a different renderer and nothing to do
   with Second Life. It is a small one, and far more people see this
   case. With the copy in place it uses the same pointer and the same
   fallback as the output page.

Things this touches beyond the code:

- **The address options become a public contract**, because in-world
  objects will depend on them. They belong in
  [`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md), versioned the same
  way, which brings in the TerraViz Federation Reviewer.
- **The web output page can report its own Essential telemetry, when
  the globe's owner turns it on.** This reverses what the plan first
  said here, at the maintainer's request on 24 October 2026, because a
  globe's use is worth counting the way the app's is: which datasets
  are shown on globes, by how many visitors, and what fails there. The multi-monitor design keeps
  *desktop* outputs silent, and they still are: their control window
  reports for them, including a stream that died, which they now tell
  it over IPC. A web output has no control window, so it reports for
  itself (`src/output/webTelemetry.ts`):
  - **Off unless the owner turns it on with `telemetry=1`.** This was
    the maintainer's choice over on-by-default. The page loads for
    everyone in range of a globe and shows no notice, and anyone can
    point a globe at a public node. Every event carries a timestamp
    and a country, and land owners commonly log avatar arrivals, so
    anyone holding both could attach a country to a named avatar in a
    quiet region. Opt-in keeps that to globes someone chose to measure,
    whose owners can say so in-world. Embed mode's rule (the page that
    places TerraViz owns consent) was the first model; it fits poorly
    here, because a globe's visitor neither went to the page nor can see
    a notice on it.
  - **Two things, in the first minute only.** `layer_loaded` with
    `trigger: 'output'` when a dataset reaches the picture, and `error`
    under `category: 'output'` with a one-word `code`, both within
    sixty seconds of the page loading, and nothing sent after about 66
    s even on a retry. The privacy review found two problems with the
    first version, and the maintainer chose this design over keeping a
    slimmed session event:
    - **No session event.** `session_start` put the visitor's locale, OS
      and screen beside their arrival time, which is the match an
      arrival log invites.
    - **The first minute, in page time.** Every event carries its time
      since the page started reporting, and a copy keeps running for as
      long as its visitor stays. So later rows, a batch retried after an
      outage, or the batch sent as the page closes would each bound how
      long a visitor stayed. Copies reporting one change together link
      visitors who were together. Counting from page load, rather than
      from a later `#telemetry=1`, keeps a late switch-on from opening a
      minute on every copy in range at once.

    Visitors are still countable, as the distinct session ids on these
    rows.
  - **Steer a measured globe after the `#`.** A change before it
    reloads every viewer's copy at once, and each reload starts a new
    session and a new first minute. That brings back the "who was
    together" link, and a chain of sessions that bounds a stay. The
    maintainer chose to document this rather than keep a marker on the
    visitor's device, since this page shows no notice. On a
    query-steered globe, distinct session ids overcount visitors.
  - **Never the address's text,** the globe's location, or anything
    about who set it up or who is looking. `layer_id` is the id the
    node returned, and a record without one is refused. An error's
    message is fixed text per code, and its stack is dropped, so no
    Research-tier `error_detail` follows.
  - **What is left is country and arrival time.** The server stamps
    country on every event, and a row from the first minute is close
    to the arrival. With a venue's arrival log that can still attach a
    real-world country to a named avatar. A venue that runs its own node
    holds the raw rows and can do this for its own globes, which the
    maintainer accepted on the record. Removing country would change the
    ingest path, which is an escalation, so it is not done
    (`PRIVACY_ANALYSIS.md` §9k).
  - **The visitor's controls are thin.** A Second Life viewer keeps its
    own browser, so an Off setting from the app never reaches it. The
    viewer's media settings can stop the page loading, picture and all.
    Global Privacy Control, where a viewer sends it, turns it off.
  - **Volume is bounded.** At most 30 `layer_loaded` per copy (a
    controller script sets that rate, not a visitor), and the error
    reporter's per-signature caps on a dataset that keeps failing.
- **Video CORS travels with the node.** A page on
  `terraviz.zyra-project.org` can play that node's streams; a partner
  node's output page needs its own video host to allow it.

Items 1–6 and the page's half of item 8 (refreshing, choosing a size,
reading the copy) are one code PR. Item 4's page half is in it too,
because it works whichever way the `#` test comes out. The cloud copy
itself is a separate change: it is a new Worker, and the main app reads
it too. It is best landed first, so the page can be tested against it.
It doesn't have to be, though, because a page that finds no pointer
reads upstream. Item 7 waits for the `#` test, and the test should run
before Phase 1 starts (§9).

**Status, 24 October 2026: Phase 1's page half is built** (branch
`claude/terraviz-second-life-compat-us9ba4`). The `#` test hasn't run
in-world yet, so this was built on the page half working whichever way
it comes out. The parameters are in
[`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md) as an additive v1
change. Four review agents read it twice, and their findings are
fixed, or listed below with the reason they are not. This was AI
review, and no person outside the session that wrote it has reviewed it
yet.
- **Items 1–3, 5 and 6 are in.** The parameters are `dataset`,
  `fit=fill`, `width` and `rotation`. The video stream is capped at the
  narrowest rendition at least as wide as the picture.
  `src/output/webMode.ts` reads the address, `webDataset.ts` asks the
  node for the dataset, and `webOutput.ts` puts them together.
  - **`rotation` names the longitude at the centre of the picture.**
    The first version passed it straight to the scene, whose offset
    turns the picture the other way, so `rotation=90` showed 90°W.
  - **An address with no `width` gets the narrowest size that covers
    the page as displayed**, up to 4096. A Second Life face is at most
    2048 wide, so a globe gets the 2160 stream rather than the
    27.7 Mbps 4096 one without anyone writing `width=2048`.
- **Item 4 changed in two places.** The clock is in the address as
  planned (`t`, `at`, `rate`, `paused`), read again on every change to
  the part after `#`, and paused copies seek to the exact time.
  - **Dated, not by ratio.** Playing copies were to reuse
    `syncByRatio`, but the first browser run showed that path holds
    whatever offset its seek leaves: 2.7 s, and a different amount on
    every visitor's copy. The clip's own seconds now go to the dated
    law, `computeSiblingSyncCorrection`, which trims the offset away.
  - **Round the loop.** That law measures error along a line, and
    these clips loop. Just past a wrap it read a copy 0.7 s behind as
    15 s ahead, and trimmed the wrong way. The law now sees the video
    measured round the loop (`src/output/webClock.ts`).
  - **Measured:** against a local file, a copy settles within a few
    milliseconds in about ten seconds, across the loop point too.
  - **Not measured on TerraViz's stream.** The build sandbox's network
    gave about 4.5 Mbps, below the 9 Mbps rendition, so the video kept
    stalling. Its proxy hands each transfer over whole, which the
    player's bandwidth probe reads as a fast link, so the player never
    stepped down to a rendition the link could carry. A visitor on a
    slow connection would step down, but stall the same way below the
    lowest one.
- **Copies converge when something fails.** A dataset that will not
  show leaves the live Earth up on every copy. Before, a copy that had
  been showing A kept it while a fresh one showed nothing. A failure
  that may pass is retried, every 5 minutes at the slowest, so copies
  can differ for up to that long after the node recovers. An image tries
  its other sizes, and a video its single file, before giving up, as the
  main app does. A stream that fails *after* it started playing is not
  noticed: it keeps its last frame, which is the multi-monitor plan's
  rung 13 (a stream rebuild) for desktop and web alike.
- **Item 8, the page's half, is partly in.** The output re-fetches its
  clouds on the producer's schedule, timed from the image's own
  `Last-Modified` so visitors' copies change together. It fetches the
  4096 image for pictures up to 2048 wide (`src/output/cloudRefresh.ts`).
  It does this on desktop too.
  - **Reading TerraViz's copy and the cloud-address setting are left
    to the cloud-copy change,** because there is no copy to read yet.
    Until then every page reads upstream, which is the fallback the
    plan already gives it.
  - **The copy can make visitors' clocks irrelevant here.** Each copy
    times its next check from its own computer's clock, so a clock
    that is wrong costs alignment with other visitors (bounded, never
    the refresh itself). The response's `Date` header would remove
    that, but a page can read it only if the server exposes it.
    TerraViz's copy can expose it (`Access-Control-Expose-Headers`).
- **Telemetry, added in the same PR.** With `telemetry=1` the page
  reports the two Essential events listed under "Things this touches"
  above, in its first minute only. The control window now reports a
  desktop output's dead stream as `output_failure` with `kind:
  'hls-stalled'`. The privacy policy, its analysis (§9k), the analytics
  catalog, the query reference and a dashboard row (Globes) cover them.
  Nothing has been sent from a real globe yet.
- **An in-world script to smoke-test it**,
  [`terraviz-globe.lsl`](../scripts/second-life-probe/README.md#the-globe),
  writes these addresses from chat commands: setup before the `#`, the
  dataset, clock, width, rotation and debug readout after it. It is
  checked with `lslint`, and `globe.test.ts` holds the keys and values
  it writes, and which half of the address each goes in, to what
  `webMode.ts` reads. With telemetry on it refuses to steer before the
  `#`, which the privacy policy asks of a measured globe. It hasn't run
  in-world yet.
- **First in-world run, 24 October**, in The Science Circle region,
  with the globe script pointed at the branch's preview deploy. Viewer:
  Firestorm 7.2.4 (80712), CEF 139 / Chromium 139.0.7258.139, on
  Windows 11 with an RTX 4090 laptop GPU.
  - **Hurricane Season 2024 played on the globe.** The picture was
    upright, with North America and the Pacific where they belong.
  - **Pause and play worked, with no reload.** The video froze and
    resumed, with no plain-Earth interval: §10 question 10, answered
    for this viewer.
  - **The debug readout** showed `buf 2048×1024`, `link live`, and
    `gpu` as the RTX 4090 through Direct3D 11. Second Life's built-in
    browser draws on the discrete card here.
  - **`/8 show hurricane`**, a misspelling, was refused by the node
    before any visitor's globe changed.
  - **It found a bug in the output's frame gate**, shared with desktop.
    After any change the loop drew on every callback for good: the
    readout showed `fps 60.0 (raf 60.0)` over a paused frame. The fix
    is in `outputScene.ts` (`advanceFrameDeadline`), and in-world
    afterwards the globe read 30 fps playing. Paused it read 1.5,
    which is unexplained. The readout's fps meter misread the 1 Hz
    floor, but by simulation it never read a clean floor below about
    1.9, so 1.5 means either extra draws or a reading caught in
    passing. The meter now measures between frames. On 25 October,
    with that meter and the later gate commits on this branch's
    preview, Eric reported the playing and paused readings looked
    right. The expected values are about 30 playing and 1.0 paused
    against `raf 60`; the exact figures were not recorded, so what
    drew the 1.5 is still not known.
  - **The rest of the smoke test worked**, as reported from the
    session: jump, rate, a still image (Nighttime Lights), the
    data-encoded smoke forecast clipped to the United States, rotation,
    and the refusal of a tour.
  - **A second avatar and spin worked too**, as reported: a second
    avatar at the globe saw it as the first did, and `/8 spin` turned
    it.
  - **Not yet confirmed in-world:** a visitor's touch, and telemetry.
- **"How close is close"** (above, decided as about a second) has
  numbers behind it: milliseconds once settled, and seconds after a
  seek, for as long as
  the visitor's connection can play the stream at all. One exception:
  on a short loop, a seek costing a third of the clip or more (a slow
  first seek, with its network fetch) ends seeking for that copy, since
  round the loop no error is ever bigger than the floor that seek sets.
  The copy then converges by speeding up alone, which takes up to about
  twice the clip's length, around half a minute for a 16 s loop.
  Capping the floor was tried and does not help: a cap just under half
  the clip lets almost nothing through, and a lower one brings back the
  seek loop on the slow links that make seeks slow.
- **"What does a visitor see when their viewer can't keep up?"**
  (above) is decided: the Video Streaming Engineer's recommendation
  below, which Eric chose on 24 October. It is page work, in two pull
  requests of its own. Today a copy of a long clip on a
  link too slow for its rendition seeks every few seconds, landing
  behind each time; a short loop stops seeking and speeds up instead
  (above). Either way the rate trim asks for up to 25% more bandwidth
  exactly when there is too little. The recommendation is to give up
  resolution first, then smooth motion, and never show the wrong
  moment:
  - **Short loops: buffer, then join.** Hold the frame at the clock's
    target while the clip downloads in order, then join with one seek
    inside what is buffered. From then on the link no longer matters.
  - **Long clips:** let hls.js adapt, trim upward only with a segment
    buffered ahead, and aim each seek at where the target will be when
    it lands, on a segment boundary.
  - **Below the lowest rendition: step.** Pause, and every few seconds
    seek exactly to the clock's target, so visitors see the right moment
    at a low frame rate.
  - **A lower rendition**, around 1024×512 at 1.5–2 Mbps, would suit
    1024-wide faces and slow links. Data-encoded datasets have one
    rendition by design, so they would always need buffering or stepping.
- **Found in review and not yet done:**
  - **Each copy loops on its own idea of the clip's length.** With
    hls.js, `duration` is the playlist's total until the stream ends,
    then the furthest buffered end across tracks, so it can differ
    between copies, and on one copy before and after its last segment.
    Copies then wrap on different periods, and the gap grows with
    every loop since the `at` anchor, not since the page loaded: in
    simulation, a 1 ms difference on a 16 s loop with a day-old anchor
    put copies 5.4 s apart. A copy's own target also jumps when its
    `duration` updates. The difference is unmeasured: logging
    `duration` before and after the last segment on the production
    stream would settle it. The fix is one period every copy agrees on
    whichever rendition it plays, such as the playlist's total
    duration, used both where the target wraps (`clockTargetS`) and
    where the error is measured round the loop (`loopView`). The
    manifest now carries that number for the node's own bundles (item
    4 above), to the microsecond, so the page can read it alongside the
    stream. A page using it still needs the element's own length
    whenever the manifest says 0.
  - **A copy that fell back to a video's single file stays on it.**
    Its stream is not tried again once the file has loaded, and the clock
    wraps on each element's own length. If the file and the stream differ
    in length, that copy loops on a different period from the others,
    the same drift as above, and the same fix (one agreed period) covers
    it.
  - **Startup costs a segment it throws away.** hls.js downloads a
    probe segment to measure bandwidth, about 3.4 MB at 1440, before
    loading from the start and then seeking to the clock.
    - Starting at the clock's target saves bytes only on a long clip.
      On a short loop every segment is fetched anyway, so what it
      saves is time to the first correct frame.
    - Skipping the probe is not free in general, because `hlsService`
      keeps it so a short loop buffers at one resolution. It is free
      when the cap leaves one rendition, which the new default makes
      common: a 1024 face caps to the bottom rendition (1440×720), and
      the probe then downloads the very segment fetched again next.
    - Data-encoded streams have no probe, since hls.js skips it for a
      single rendition.
  - **Credit.** A CC-BY dataset on a prim reaches every visitor with no
    credit, because the page shows nothing but the picture. Decided on
    24 October: the Phase 2 controller carries a short credit in its
    hover text, and a touch gives the full one (item 4 above).
  - **The manifest has no published schema**, and the output page is
    now a third reader of it. A `manifest.schema.json` beside the other
    v1 schemas would pin what Second Life globes rely on.
  - **No way to tell whether a node supports web mode.** An older node
    ignores the parameters and shows the live Earth.
  - **No test pins the overlay** against the control window's
    `overlayForMirror(wireToDataset(…))`. A renamed wire field would not
    fail type-check in `webDataset.ts`, which reads fields by name.

---

## 8. What we're deliberately not doing

Written down so these don't get re-proposed in six months.

- **Measurement features on a sphere.** §5: no programs in Second
  Life materials, and the output page doesn't carry them. They're
  available on a flat panel running the full app (Option E) instead.
- **Building a custom viewer.** Second Life's viewer is open source
  and third-party viewers are common, so this is *possible*. It would
  also be a product with no users and permanent maintenance. No.
- **Rebuilding the catalog in LSL.** Option A is read-only. In-world
  objects display TerraViz state; nothing in-world writes back.
- **An in-world Orbit chatbot driven by scripts, through today's chat
  endpoint.** The first version gave the reason as "Orbit streams its
  replies and scripts can't consume a stream". That is out of date:
  the endpoint also answers in one reply when asked (`stream: false`,
  `functions/api/chat/completions.ts`). What stands in the way is
  this:
  - **The prompt is built in the visitor's browser.** Orbit's
    instructions and catalog are put together by `docentContext.ts`,
    which a script can't run, and the catalog alone is far past the
    reply and memory limits in §4.1.
  - **The endpoint refuses a request without an allowed `Origin`
    header.** A script would have to fake one, which defeats the check.
  - **Its rate limit is per IP address**, 30 requests a minute. Scripts'
    requests come from Linden Lab's simulator hosts, so every globe on
    a host would share one budget.

  Option E brings the real Orbit to a flat panel today, through the
  existing chat path, with each visitor's conversation their own. Orbit
  steering a globe for everyone at it needs a narrow endpoint of its
  own, built under [`CONTRIBUTING.md`](../CONTRIBUTING.md) §LLM
  Integrations. It is entry 10 in
  [`LLM_INTEGRATION_OPPORTUNITIES.md`](LLM_INTEGRATION_OPPORTUNITIES.md),
  and comes after Phase 2, whose touch, presenter and hold rules it
  uses.
- **Patching around #5189 inside TerraViz.** Nothing here reproduced
  it, and there is nothing in TerraViz to change if it does fire — it
  is a crash in the viewer's own embedded browser.

---

## 9. Suggested order of work

**Available now, no code:**

- **Option E**, a flat in-world screen running the full app, and the
  **idle-Earth globe** from Option C. Both are a media address plus
  settings (§6, §5). The cheapest way to put TerraViz in front of
  people in-world, and the cheapest way to answer §10 questions 8 and
  11.

**Before or alongside Phase 1 — the cloud copy** (§7 item 8). The
scheduled Worker that keeps the clouds in TerraViz's own R2, with its
pointer file. A new deployable, so it is its own PR. Nothing in it
depends on Second Life, and everything after it that draws clouds reads
from it.

**First, the `#` test** (§10 question 10). One in-world session with
the kit's `/7 hash`, on each viewer that matters. It changes none of
Phase 1's code. It does decide whether each pause, jump and switch
costs every visitor a reload, and so whether Phase 2 needs a server.
*Firestorm 7.2.4 passed on 24 October, with the globe script rather
than the probe: no reload, so no server for its users. The official
viewer is next.*

**Phase 1 — the output page's web mode** (§7, items 1–6 and the page's
half of 8). One code PR. It turns the idle-Earth globe into a TerraViz
dataset globe that every visitor sees in step, under current clouds.
*Built, apart from reading the cloud copy; see the status note at the
end of §7.*

**Phase 2 — an in-world globe controller.** An LSL object that applies
the §5 recipe, sets the media at 2048×1024 and spins the globe. It also
carries the controls §7 item 4 asks for: the presenter list, talks,
pause, jump, a dataset menu, the short hold between walk-up visitors,
the date and credit in the hover text, the abstract on touch, and the
return to the live Earth five minutes after the last visitor leaves.
Each control rewrites the media address, and the media itself stays
non-interactive so that the controls are the only way in. Its first
check is whether a visitor's left-click reaches the script at all,
since that decides whether the controls sit on the globe or on a stand
beside it. The manifest gains a clip duration for the date (*built for
the node's own HLS bundles*), and the slow-link work is two page PRs
beside it (§7 item 4).
It is the in-world half of Phase 1.
*Written, and not yet run in-world.* The controller is the three scripts
in [`scripts/second-life-exhibit/`](../scripts/second-life-exhibit/README.md),
whose README carries the in-world checklist, the left-click test among
it. LSL compiles only in-world, so what has been checked is its syntax
(lslint), its date arithmetic against the calendar for every day from
year 1 to 2100, and, by tests, that its scripts agree with each other,
with the output page and with the node's serializer. How much of a
record it can read rests on one measurement of the node's records, in
October. The smoke-test script,
[`terraviz-globe.lsl`](../scripts/second-life-probe/README.md#the-globe),
stays for testing the page by hand: it does the recipe and the media,
driven by its owner in chat, with none of the visitor controls.

*How the controller is built* (in
[`scripts/second-life-exhibit/`](../scripts/second-life-exhibit/README.md)):
- **Three scripts in the globe prim, talking by link messages.** A
  script gets 64 KB in all, and a dataset record costs about 1.8 bytes
  of it per character while held (§4.1). One script doing everything
  would hold a record while it also holds menus, notecards and visitor
  lists, so the work is split three ways:
  - **globe** owns the address, the clock and the media. It is the
    smoke-test script's core, unchanged in what it writes, and it is
    the only script that changes what visitors see. It takes the
    owner's chat commands, as before, and control requests from the
    visitors script. After every change it tells the other two what
    the globe now shows.
  - **visitors** owns people. It turns touches into menus, keeps the
    presenter list, runs talks and the short hold, watches who is at
    the globe, and asks the globe to go back to the live Earth once
    the last visitor has been gone for the idle time.
  - **info** owns what the globe says about itself. It reads the
    record and the manifest for each dataset. From them it keeps the
    hover text (any telemetry notice, the title, the date and a short
    credit, in that fixed order, in 254 bytes: §7 item 4 has the
    shortening rule). It also gives the abstract and full credit on
    request.
- **What visitors can do.** A touch opens a menu for whoever touched.
  "About" is always there, since reading changes nothing. The
  controls are pause or play, back and forward ten seconds, start
  over, a dataset, the live Earth, and a Turn menu (added on 25
  October). Turn east and Turn west turn the picture 30° about the
  poles: east is the way the Earth turns, so the places facing a
  visitor move to their right. South Pole to me and North Pole to me
  tip the sphere itself 30° a press so that pole comes round toward
  whoever pressed, until it faces them, so a presenter can put the
  ozone hole on the equator in front of their audience; Upright again
  undoes it. A tilt is the prim's rotation, which the region sends
  every viewer, so all see one angle; turning the picture to put a pole
  at the front instead is Phase 4's (§7 item 7). The controls are
  offered when that
  visitor may act: outside a talk, nobody else holds the globe;
  during one, they are a presenter. A hold ends when it runs out or
  when its holder leaves the globe. Presenters also get "Start talk"
  and "End talk", and "Jump to", which takes a time. A presenter can
  start a talk whoever holds the globe. A visitor
  doesn't change the rate, the width or the telemetry, which stay the
  owner's, in chat. Nor does a turn change the owner's rotation: that
  is where the globe goes back to, upright and with the live Earth,
  once the last visitor has gone.
- **Notecards in the globe, all optional, re-read when they change:**
  - `presenters`: one username a line. A legacy name such as "Eric
    Hackathorn" is read as its username. A display name never is.
  - `datasets`: the menu, one `Name = id` a line. Without it the menu
    offers the smoke-test script's five.
  - `settings`: the four numbers, as `name = value` lines:
    - `radius`: the distance that counts as at the globe, in metres
      (15);
    - `idle minutes`: how long after the last visitor leaves before
      the live Earth comes back (5);
    - `hold seconds`: how long the short hold lasts after a visitor's
      last action (60);
    - `talk minutes`: how long with no presenter at the globe before a
      talk ends (2).
  - a notecard named by a dataset's id, given to a visitor who asks
    about that dataset in place of the chat abstract.
- **Who is at the globe** comes from the region's avatar list and each
  avatar's distance from the globe's surface, every five seconds. That costs less than a sensor
  and isn't capped at 16 avatars. Nothing about a visitor leaves the
  object: no name or key reaches the node.
- **Left out for now:** a stand beside the globe for left-clicks. It
  waits on the left-click test, and until then visitors right-click
  and choose Touch, which the viewer's source says always reaches the
  script. Rate control for visitors is also left out.
- **For later: a drag handle, to turn the globe with the mouse.** A
  drag on the globe itself can't reach a script: a left-click on a
  face showing media goes to the media, and Touch from the right-click
  menu is a single touch. A ring or stand linked to the globe, showing
  no media, can feel a drag, since `touch` repeats while the button is
  held and `llDetectedTouchST` says where the pointer is on the
  surface. There are two ways to turn from it:
  - **The sphere prim itself**, through its local rotation
    (`llSetLinkPrimitiveParamsFast` with `PRIM_ROT_LOCAL`) so the
    handle doesn't turn with it. The region sends the rotation to
    every viewer, so all see one angle. The menu's pole buttons already
    tip the sphere this way, ending any `/9 spin` first, since
    `llTargetOmega` is drawn by each viewer for itself; a handle would
    drag the same rotation smoothly instead of in 30° steps.
  - **The address's `rotation`**, as the turn buttons use. Every viewer
    applies it after the `#` with no reload, but the globe script
    sleeps a second after each media change, so a drag would move in
    one-second steps.

  The first follows the hand more closely, and the second keeps the
  picture's own longitude as the one thing turned. Either way, a
  drag goes through the visitors script's hold and talk rules like
  any other control. Until then, the Turn menu does the job in steps.

**Phase 3 — the resolved-hero endpoint** (Option A), when someone wants
a "Right now" kiosk.

**Phase 4 — live zoom, and bringing a place to the front** (§7 item 7),
designed on whatever the `#` test found.

Options B and D only if a host needs what they uniquely offer: phones
or no-browser exhibits for B, a self-hosted world for D.

**Separately, at any time — the main app's clouds** (§7 item 8). The
main globe gets the same refresh, reading the same copy and falling
back the same way. It is a small change of its own, useful wherever
TerraViz is left running for hours, and nothing in it depends on Second
Life.

---

## 10. Open questions

Numbering is kept from the first version, so a reference like
"question 6" means the same thing everywhere.

1. **Does the Second Life phone app support shared media?** Still
   unknown. The beta FAQ lists inventory, marketplace, building and
   dialog menus as unsupported and doesn't mention shared media. It
   decides whether Options C and E reach phone users at all.
2. ~~Does a sphere's default texture wrapping match our frames?~~
   **Answered: no, it's rotated 90° — and the §5 recipe fixes it.**
3. **What does an upload cost now, and at what size?** L$10 and
   1024×1024 are the long-standing figures; neither was checked
   (§6 Option B).
4. **Is there a real host?** Still the question that would change the
   ordering most.
5. **What does an event cost the server?** Partly answered: each
   visitor streams the video separately, about 9 Mbps at 2160×1080,
   so ~360 Mbps for 40 avatars (§7 item 5). Page and API traffic per
   visitor are unmeasured.
6. ~~Can the embedded browser play H.264?~~ **Answered: yes, in
   Firestorm** (§4.2).
7. ~~Will the node answer requests from Second Life's servers?~~
   **Answered: yes** (§4.1).
8. **Do the results hold on the official viewer and on a modest
   GPU?** Everything here is one machine with a very fast card. The
   official viewer reports the same Chromium build, which suggests it
   behaves the same, but nobody has run it. The kit in
   `scripts/second-life-probe/` reruns §4 anywhere.
9. **What happened at 11:40?** The one test run that went silent
   (§4.3). Windows Event Viewer → Application, around that time: an
   *Application Error* naming `SLPlugin.exe` and `libcef.dll` would
   mean a crash matching #5189; its absence would point at the viewer
   unloading the page.
10. **Does changing only the `#` part of a media address reach every
    viewer without a reload?** It decides how a globe is steered live,
    for the clock (§7 item 4) and the camera (item 7) alike. The kit's
    `/7 hash` tests it.
    - The test page answers for every viewer of the kind you run. A
      script's change reaches every viewer the same way, the owner's
      included: as an update to the object.
    - Another kind of viewer (the official one, the phone app) needs
      its user to run their own copy of the probe. A second avatar
      watching `/7 app` or `/7 sos` can confirm a reload but not a
      quiet success, since nothing on those pages changes visibly.
    - **The viewer's source predicts no reload** (§11). Any change to
      an object's media address makes every viewer that has the page
      loaded, or set to play automatically, navigate to the new
      address. Along the way:
      - it asks the page's server for its headers only, to learn the
        page's type;
      - it keeps the same browser process, since the type hasn't
        changed;
      - it passes the `#` part through untouched;
      - it hands the address to the embedded Chromium.

      The viewer has nothing specific for a `#` change. Chromium then
      treats an address that differs only after `#` as the same page.
    - **In headless Chromium,** a `#` change mid-video arrives without
      a reload, and the video keeps playing (§11).
    - **Answered for Firestorm 7.2.4, in-world on 24 October.** Its
      embedded browser is CEF 139 (Chromium 139.0.7258.139). The kit's
      globe script paused and resumed a playing TerraViz video by
      changing only the part of the address after `#`, and the video
      froze and resumed with no reload. A reload is easy to see there:
      the page shows the plain live Earth for a few seconds while the
      dataset loads again, and the readout's `data` line reads `—`.
      Neither happened.
      - Seen by eye on the globe rather than measured with `/7 hash`,
        and from one viewer on one machine.
      - **Still open** for the official Linden Lab viewer and the phone
        app, each of which needs its own run.
11. **Does a second avatar see the app and the output page?** It
    should — they come from TerraViz's site, not from a script.
    **Answered for the output page** on 24 October: a second avatar at
    the globe saw what the first did (§7 status note). **Still open for
    the app on a flat panel**, together with whether one visitor's
    navigation moves the other's panel (§6 Option E).
12. **How long does the full app run with a video playing?** It ran;
    it wasn't timed, and it wasn't tried on a flat panel (§4.5).
13. **How many globes can stand in one field?** **Answered from the
    official viewer's source**, not yet seen in-world (§11). Each globe
    is a live web page, with video, in every visitor's viewer. Each
    viewer ranks those pages by how large they look on that visitor's
    screen. By default:
    - at most **8 load at once**, or 6 on a machine with under 8 GB of
      memory;
    - the **2 largest on screen run at full priority**;
    - the **next 4 run at low priority**, scaled down to the size
      they're shown at;
    - any others update only occasionally, and past 8 nothing loads;
    - globes off screen are hidden;
    - switching away from the viewer window drops every page to low
      priority, which matters for a presenter checking their notes.

    These are viewer settings (`PluginInstancesTotal`, `…Normal`,
    `…Low`) a visitor can raise, but the defaults are what an audience
    has. Firestorm may differ. §7 item 4 says why the clock keeps a
    field in step anyway.

---

## 11. Evidence

**In-world results** (local chat from the test session, 23 Oct 2026)
- `[node] events: HTTP 200, 819 characters received. llJsonGetValue read 1 event(s)` · `[node] catalog: HTTP 200, 16384 characters received, cut off at 16384 bytes. Script memory in use: 62940 of 65536 bytes` (a later run: `38212` after events, `67790 of 65536` after the catalog)
- `[page] chrome: 139.0.7258.139` · `WebGL 1: true` · `WebGL 2: true` · `GPU: ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU (0x00002717) Direct3D11 vs_5_0 ps_5_0, D3D11)`
- `[page] H.264 720p (TerraViz): MSE yes, video tag probably` · `native HLS: no` · `hls.js test stream: PLAYING 1920x1080`
- `[page] webgl frames: 602 in 10s, context lost 0x, readback ok` · `[probe] Heartbeats stopped. Last one: soak webgl: 450s, 27001 frames, context lost 0x, viewport 1024x512`
- `[page] TerraViz stream via hls.js: failed, networkError / manifestLoadError` · `test stream via hls.js (not TerraViz data): PLAYING 1920x1080`
- `[page] TerraViz image: loaded 1024x512` · `[probe] Texture rotation 90 degrees, not mirrored. Prim rotation (degrees): <0.00000, -90.00000, 0.00000>`
- Observed, not logged: the real app at `?embed=1` and `?embed=1&dataset=01KQG611HF8YXJNRBEHT0757KT` ran with video playing; the output page at `/output/output` rendered correctly on the sphere at a 2:1 media size and with black polar caps at 0 × 0; the Media Settings dialog clamped sizes above 2048, and 2048×1024 worked

**Second Life viewer source** (`secondlife/viewer` at `fd2040c`)
- `indra/llmath/llvolume.cpp:490` — profile points are `(cos, sin)` in the XY plane, with the profile parameter carried alongside
- `indra/llmath/llvolume.cpp:713` — the sphere's half-circle profile, offset 0.5 at half sweep: ends at x = ±0.5
- `indra/llmath/llvolume.cpp:1287`, `:1302` — the circular path revolves about `(1, 0, 0)`; path points sit at `(0, cos, sin)`
- `indra/llmath/llvolume.cpp:7223` — texture coordinates `(ss, tt)`: U along the profile, V along the path
- `indra/llprimitive/llmediaentry.h:187-188` — `MAX_WIDTH_PIXELS = 2048`, `MAX_HEIGHT_PIXELS = 2048`
- `indra/llprimitive/llmediaentry.cpp:573`, `:580` — larger sizes return `LSL_STATUS_BOUNDS_ERROR`
- `indra/newview/llviewermedia.cpp:333`, `:352`, `:382` (`updateMediaImpl`) — when an object's media update changes its current address, a viewer whose copy is loaded or auto-playing calls `navigateTo(url, "", true, true)`, with nothing specific for a `#` change. `indra/newview/llvovolume.cpp:2709` (`syncMediaData`) is the caller
- `indra/newview/llviewermedia.cpp:2582`, `:2611` (`navigateTo`) — the new address is recorded first, and a page whose priority is "unloaded" returns there, so it loads the latest address when it next gets priority; `:2692` starts a headers-only request to learn the type; `:2775` treats a missing type as `text/html`
- `indra/newview/llviewermedia.cpp:1702` (`initializeMedia`) — the browser plugin is kept unless the new type needs a different plugin
- `indra/newview/llviewermedia.cpp:1977` (`loadURI`) and `indra/llcommon/lluri.cpp:291`, `:185` — the address is escaped part by part, and the `#` part keeps `#` and `=`, so `#h=1` reaches the browser as written
- `indra/newview/llvovolume.cpp:2825`, `:2842`, `:2846`, `:2868` (`mediaNavigated`) — a navigation made inside a viewer's copy of the page is checked against the media's URL whitelist and the visitor's interaction permission. If either refuses it, it bounces back (`:2861`). If both allow it, it is broadcast as the object's new address, for every viewer
- `indra/newview/llviewermedia.cpp:3530` — the viewer already recognises a `#`-only change of location reported by the browser as internal navigation (its comment cites SL-1005)
- `indra/newview/llviewermedia.cpp:86-87`, `:258-271` (`setMaxInstances`) — 8 in-world media at once by default, 2 fewer on a machine with under 8 GB of memory, never below 6
- `indra/newview/llviewermedia.cpp:727`, `:769`, `:779`, `:785`, `:798`, `:813`, `:818` (`updateMedia`) — past the limit, unloaded; off screen, hidden; the first `PluginInstancesNormal` at normal priority; the next `PluginInstancesLow` at low priority, scaled to their on-screen size; any more as "slideshow"; with the viewer window minimised, everything hidden; with it out of focus, nothing above low. `:599` (`priorityComparitor`) ranks larger on-screen area first
- `indra/newview/app_settings/settings.xml:6651-6684` — defaults `PluginInstancesLow` 4, `PluginInstancesNormal` 2, `PluginInstancesTotal` 8

**Platform state**
- [SLua open beta announcement](https://community.secondlife.com/news/featured-news/announcing-the-slua-open-beta-modern-scripting-comes-to-second-life-r11237/) — Luau, 2 Dec 2025, runtime selection, memory claim
- [Lua Alpha](https://wiki.secondlife.com/wiki/Lua_Alpha) — language feature list
- [Grid statistics, mid-June 2026](https://danielvoyager.wordpress.com/2026/06/17/second-life-grid-statistics-mid-june-2026-update/) — concurrency, region growth
- [Technology Report, June 2026](http://blog.nalates.net/2026/07/01/second-life-technology-report-june-2026/) and [SL23B engineering team](https://danielvoyager.wordpress.com/2026/06/25/sl23b-meet-the-lindens-second-life-engineering-team/) — graphics API plans, WebRTC voice, Lua timelines
- [PBR Materials Are Here](https://community.secondlife.com/news/tools-and-technology/pbr-materials-are-here-r3900/) and [GLTF Material Import release notes](https://releasenotes.secondlife.com/viewer/7.0.0.581368.html) — materials shipped, scene import not
- [Phone app public beta FAQ](https://lindenlab.freshdesk.com/support/solutions/articles/31000173486-second-life-mobile-public-beta-faq) — unsupported feature list (§10 q1)
- [June 2026 fee changes](https://modemworld.me/2026/06/08/ll-announces-second-life-fee-changes-reductions-increases/) — pricing movement (§10 q3)

**Constraints**
- [secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189) — the WebGL crash; filed by a Linden Lab developer 28 Dec 2025; `SLPlugin.exe` access violation in `libcef.dll`; CEF 139.0.7258.139, Dullahan 1.24.0; reproduced with the WebGL Aquarium; still open and unassigned as of 23 Oct 2026, stale-labelled Feb 2026
- [Project Valhalla, 2015](https://modemworld.me/2015/10/08/vallhalla-cef-comes-to-second-life/) — Chrome comes to Second Life's shared media, with a WebGL promise
- [`llSetPrimMediaParams`](https://wiki.secondlife.com/wiki/LlSetPrimMediaParams) — size parameters, whitelist cap, one-face-per-call, permissions
- [`llHTTPRequest`](https://wiki.secondlife.com/wiki/LlHTTPRequest) — reply and request size limits, rate limits, timeout, header rules
- [`llJsonGetValue`](https://wiki.secondlife.com/wiki/LlJsonGetValue) — native JSON parsing in LSL since 20 May 2013 (server 13.05.20)
- [`llSetContentType`](https://wiki.secondlife.com/wiki/LlSetContentType) and [`llHTTPResponse`](https://wiki.secondlife.com/wiki/LlHTTPResponse) — a script-served page renders as HTML only for the object's owner, in their viewer, in the same region; no size limit beyond script memory; 25 seconds to answer
- [`osSetDynamicTextureURL`](http://opensimulator.org/wiki/OsSetDynamicTextureURL) and [OpenSimulator](https://en.wikipedia.org/wiki/OpenSimulator) — dynamic textures, 0.9.3.0, linked worlds

**This repository**
- `src/services/mapRenderer.ts:1506-1508,1557` — the equirectangular globe; per-frame video texture upload
- `src/services/glLumaSampler.ts:134-144` — graphics card required, no fallback by design
- `src/utils/webglSupport.ts` — the WebGL 2 preflight; no WebGL 1 fallback, because MapLibre 6 dropped it
- `src/types/color-scale.ts:176,230` — the colour lookup table; brightness-to-measurement conversion
- `src/ui/publisher/components/asset-uploader.ts:98`, `components/dataset-form.ts:1705` — the 2:1 equirectangular contract
- `src/services/photorealEarth.ts:206` — the same sphere-wrapping alignment in TerraViz's own 3D code
- `src/output/main.ts:83`, `:233` — the output page reads its mode from its address, and attaches its control-window link only on desktop
- `src/output/output.css:35` — `object-fit: contain`, the letterboxing behind the black polar caps
- `src/output/datasetMirror.ts`, `src/output/outputSync.ts` — what plays a dataset on an output and steers its playhead (§7 items 1 and 4)
- `src/output/outputScene.ts:983`, `:1046` — the output loads its cloud image once; it computes the sun from the clock on every drawn frame (§7 item 8)
- `src/output/outputScene.ts:334` — the cloud image is requested with `crossOrigin = 'anonymous'`, so any copy must send CORS headers
- `src/utils/deviceCapability.ts:103`, `:106` — the cloud images' bucket, fixed in code, and the 8192-wide choice for anything not a phone
- `src/services/earthTileLayer.ts:87`, `:1700` — the main globe takes the same cloud address, and loads its clouds once too
- `src/config/endpoints.ts:132-135` — `VITE_EARTH_ASSET_BASE` redirects the other Earth images; the cloud address doesn't read it
- `src/ui/creditsPanel.ts` — no mention of clouds or their source
- `wrangler.toml:145-147` — TerraViz's one R2 bucket, `terraviz-assets`, bound as `CATALOG_R2`; the file declares no cron triggers, and Pages Functions can't have them
- `.github/workflows/zyra-scheduler.yml:26` — the repo's existing schedule, `*/15 * * * *` on GitHub Actions
- `functions/api/v1/_lib/r2-store.ts:319` — video bundles are stored under `videos/{datasetId}/…` in R2
- `docs/SELF_HOSTING.md:539` (R2 billed the same on either plan), `:540` and `:550-559` (Workers Free's 100,000 requests a day, shared by every Pages Function request), `:566-577` (what fail open and fail closed do at the limit), `:1246` (`R2_PUBLIC_BASE` arrives at Phase 8.5)
- Cloudflare's [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) pages, read 23 Oct 2026, for the cost table in §7 item 8. They give: Paid $5 a month with 10M requests and 30M CPU ms; Free 100,000 requests a day and 10 ms CPU a run; network waits don't count as CPU; 5 cron triggers on Free; R2 $0.015 per GB-month, $4.50 per million writes, $0.36 per million reads, free allowances of 10 GB, 1M and 10M, no egress fees; JPG cached by default, JSON never. The R2 page doesn't say whether lifecycle deletions are charged; even as writes, 288 a day is a few cents a month
- `src/services/multiOutput/mirrorState.ts` — the control side's dataset-to-output mapping (§7 item 1)
- `src/services/multiOutput/protocol.ts:573`, `:579` — framebuffer widths 1024 / 2048 / 4096 / 8192, default 4096
- `src/services/heroService.ts`, `functions/api/v1/featured-hero.ts` — the "Right now" pick is computed in the browser; the endpoint returns the raw pin only
- `functions/api/v1/featured.ts`, `functions/api/v1/_lib/featured-datasets.ts:182` — the featured reply shape; 280-character summary cap
- `cli/lib/ffmpeg-hls.ts:24,286` — TerraViz's streams are H.264 (`libx264`)
- [`MULTI_MONITOR_PLAN.md`](MULTI_MONITOR_PLAN.md) §8 (lines 492–502) — outputs ship desktop-only in v1, with a web layer anticipated in Phase 5
- [`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md) — the stable embed address format

**Measurements** (from outside Second Life, 23 Oct 2026)
- Reply sizes in §4.1: `curl` against `https://terraviz.zyra-project.org`. `/api/v1/events` 820 B; `/api/v1/featured?limit=24` 15 B; `/api/v1/featured-hero` 13 B; `/api/v1/catalog` 822,125 B over 180 datasets (mean 4,574 B per record re-serialised compactly, largest 16,170 B)
- Video CORS in §4.4: `https://video.zyra-project.org/videos/<id>/master.m3u8` returns `Access-Control-Allow-Origin: https://terraviz.zyra-project.org` for that origin and no CORS headers for any other. Renditions 4096×2048 (`avc1.4d4033`, 27,711,200 bps), 2160×1080 (`avc1.4d4032`, 9,011,200 bps), 1440×720 (`avc1.4d4020`, 4,611,200 bps), all with AAC
- Clouds in §7 item 8: `https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg` (4,886,981 B) and `clouds_4096.jpg` (1,029,784 B), `Last-Modified` 21:15:04 then 21:25:04 UTC, each with an `ETag` and no `Cache-Control`; `clouds_2048.jpg` returns 404
- Manifests: a video dataset's `/api/v1/datasets/<id>/manifest` returns `{"kind":"video", …, "hls": "<master.m3u8>"}`; an image dataset's returns `{"kind":"image", "variants": [{ "width", "url" }, …]}` (Nighttime Lights: 4096, 2048 and 1024 variants)
- The output page: `/output/output.html` redirects (308) to `/output/output`, titled "Output — Terraviz"; `/output.html` serves the main app. In headless Chromium at 1024×512 the page draws a 2:1 Earth with no errors, at a 4096×2048 drawing buffer
- The `#` test in a browser (24 Oct 2026): the kit's harness plays the probe's video in headless Chromium and changes only the address's `#` part mid-video. The page reported `hash: #h=1, video t=14.3s, playing, readyState 4`, and it had still loaded only once 3 s later. The check fails on each way this could go wrong: a changed query, which reloads the page; a reload half a second after the report; a change that pauses the video; and a page with no `#` listener. This is Chromium's behaviour, not Second Life's (§10 question 10)

**In-world results, 24 Oct 2026** (Firestorm 7.2.4 (80712), CEF 139.0.40 / Chromium 139.0.7258.139, Windows 11, RTX 4090 laptop GPU, The Science Circle; the globe script against `https://claude-terraviz-second-life.terraviz.pages.dev`)
- `[globe] Address: https://claude-terraviz-second-life.terraviz.pages.dev/output/output?fit=fill#dataset=01KQG611HF8YXJNRBEHT0757KT&t=0&at=…&width=2048&rotation=0&debug=1` · `[globe] Showing Hurricane Season - 2024 from its start, at its own speed.`
- `[globe] The node has no dataset hurricane. The globe is unchanged.`
- The readout before the frame-gate fix: `fps 60.0 (raf 60.0)` playing and paused, `draw 0.1 ms`, `buf 2048×1024`, `gpu ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU (0x00002717) Direct3D11 vs_5_0 ps_5_0, D3D11)`. After it: `fps 30` playing, `fps 1.5` paused. The paused figure is unexplained: the meter then in use never read a clean 1 Hz floor below about 1.9, by simulation. It has since been replaced, and on 25 October Eric reported the playing and paused readings with the new meter looked right (figures not recorded)
- Pause and play by `#` alone: the video froze and resumed with no plain-Earth interval, which is how a reload shows on this page (§10 question 10). Seen by eye, not measured with `/7 hash`
- Reported working afterwards: `/8 jump`, `/8 rate`, `/8 show lights`, `/8 show smoke`, `/8 rotation`, the tour refusal, `/8 spin`, and a second avatar at the globe
- An earlier attempt left `NODE` at `https://terraviz.zyra-project.org`, whose output page has no web mode yet, and showed the live Earth whatever was asked. That is the README's first trip-up
