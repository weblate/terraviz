# TerraViz in Second Life: the exhibit globe

[TerraViz](https://terraviz.zyra-project.org) is a free, open-source
globe for environmental data, most of it from NOAA's
[Science On a Sphere](https://sos.noaa.gov/) collection. In Second Life
a sphere can show a web page on its surface, and TerraViz's output page
draws the whole Earth unwrapped for exactly that. The page reads what to
show from its own address, so a script that writes the address controls
the globe for everyone at once.

The [probe kit's globe](../second-life-probe/README.md#the-globe) is the
smoke test: its owner drives it in chat. This folder is the exhibit, a
globe that stays up all the time:

- **Anyone who walks up can use it.** A touch opens a menu of datasets
  and controls, and everyone at the globe sees what they choose.
- **Two visitors don't fight over it.** Whoever acts holds the globe for
  a minute after their last choice, and anyone else is told who has it.
- **A presenter can take it over for a talk.** The presenters are named
  in a notecard. During a talk only they can change the globe.
- **It goes back to the live Earth** five minutes after the last visitor
  leaves, never during a talk.
- **It says what it shows.** The floating text gives the title, the date
  in the animation, and a short credit. "About" in the menu gives the
  abstract, the full credit and the licence.

Why it works this way, and what was decided when, is in
[`docs/SECOND_LIFE_COMPAT.md`](../../docs/SECOND_LIFE_COMPAT.md), §7
item 4 and §9 Phase 2.

| File | What it is |
|---|---|
| `terraviz-exhibit.lsl` | **The globe script.** Owns the address, the clock and the media: the smoke test's globe, taking requests from the other two. The only one with settings to edit. |
| `terraviz-exhibit-visitors.lsl` | **The visitors script.** Touches and menus, the hold, talks, and who is at the globe. |
| `terraviz-exhibit-info.lsl` | **The info script.** The floating text, and "About". |
| `exhibit.test.ts` | Holds the three scripts to each other and to the node: their link messages, the state they share, the commands a visitor may send, the record fields read. `../second-life-probe/globe.test.ts` holds the globe script's address to the output page. |

A script in Second Life has 64 KB in all, which is why there are three:
one script reading a dataset's record while also holding menus,
notecards and the visitor list would run out.

## Before you start

- A region where you can rez objects and run scripts, and where
  visitors can reach the globe.
- Shared media on in your viewer, with auto-play allowed. In Firestorm:
  Preferences → Sound & Media. Visitors need the same.
- No L$. Nothing here uploads anything.
- **Which node the globe shows.** `NODE`, at the top of
  `terraviz-exhibit.lsl`, is `https://terraviz.zyra-project.org`. The
  probe kit's README says how to point it at a preview deploy instead.
  The other two scripts take the node from the globe script.

## Setting it up

1. Rez a sphere. A default prim sphere is fine.
2. In its Content tab, make three **New Script**s and replace their
   text with the three `.lsl` files here, one each, saving each. Set
   `NODE` in the globe script first if you need to. The order doesn't
   matter: each asks the others for what it missed.
3. Within a few seconds the sphere stands its poles upright and shows
   the live Earth, and the floating text reads `TerraViz globe`, the
   live Earth's line and its credit. Chat shows the visitors script's
   summary of what the notecards gave: with none, no presenters and the
   five built-in datasets.
4. Add any of the notecards below, and say `/9 presenters` to check what
   was read.

The media is deliberately not clickable, for anyone. A visitor who could
click it could move it to another page, and their viewer would move it
for everyone near the globe.

## What visitors do

A visitor **right-clicks the globe and chooses Touch**. A left-click on
a face showing a web page goes to the page rather than to a script,
which is why the floating text says "Right-click, Touch for more". The
menu that opens is theirs alone:

| Button | Who gets it | What it does |
|---|---|---|
| About | everyone | The abstract, credit and licence, in their own chat, or a notecard the owner wrote. |
| Datasets | whoever may act | The menu of datasets, nine to a page. |
| Pause / Play | whoever may act, a dataset showing | Every visitor stops on, or starts from, the same frame. |
| Back 10 s, Forward 10 s, Start over | the same | Move through the animation. |
| Live Earth | the same | Back to today's clouds and the real day and night. |
| Turn west, Turn east | whoever may act | Turn the globe 30°. East is the way the Earth turns: the places facing you move to your right. Everyone sees the same turn. |
| Jump to... | presenters | Type a time in the clip, such as `90` or `1:30`. |
| Start talk, End talk | presenters, whoever holds the globe | See below. |

**Who may act.** Outside a talk, anyone, one at a time. Whoever chooses
something holds the globe until `hold seconds` after their last choice,
or until they walk away from it. Anyone else who touches it is told who
has it and when it frees up, and gets only "About". A menu answers for
five minutes after it opens, and each answer is checked again against
the hold and any talk.

**Talks.** A presenter chooses Start talk, and everyone near the globe
is told a talk is starting. Until it ends, only presenters can change
the globe, and the floating text says a talk is on. It ends when a
presenter chooses End talk, or once no presenter has been at the globe
for `talk minutes`, so a presenter who logs off doesn't lock it. The
owner counts as a presenter, and can end a talk from chat.

**The live Earth comes back** once nobody has been within `radius` of
the globe for `idle minutes`, turned back to the owner's
`/9 rotation`, so a visitor's turn doesn't outlast their visit. Never
during a talk. Every change to the globe starts the clock again, as
does the end of a talk, so a choice made from beyond the radius isn't
undone at once.

**Turning with the mouse doesn't work yet.** A drag on the globe never
reaches a script, for the same reason a left-click doesn't, so the menu
turns it instead. A drag handle beside the globe is planned
(`docs/SECOND_LIFE_COMPAT.md` §9, Phase 2, "Left out for now").

**The floating text** holds 254 bytes, in this order:

```
TerraViz globe
Counts anonymous use: https://terraviz.zyra-project.org/privacy   (only with telemetry on)
Earthquakes - 2001-2015
14 Sep 2004
Credit: NOAA Pacific Tsunami Warning Center, USGS National Earthquake Information Cent...
A talk is in progress                                              (only during one)
Right-click, Touch for more
```

The title and the credit share what the other lines leave. The title
keeps at least 32 bytes and the credit 48 where both fit, and the
title's come first where they don't, as on a preview node, whose longer
address makes the telemetry notice longer. Either is cut with `...` when
it must be: above, with both optional lines showing, the credit loses
its end. Nothing else is ever cut, so the telemetry notice can't be
lost.

The date is the dataset's start time plus the share of its span the
animation has played, the same arithmetic as the app's. It is exact when paused
and updated every couple of seconds while playing. It shows to the
dataset's period: the year for a yearly dataset, the month for a monthly
one, the time in UTC for one updated more often than daily, and the day
otherwise. Each is counted from the dataset's own start, so on data
stamped at noon the day changes with the frame rather than at midnight
in between. Until the node has said how long the clip is, and for an
image, it shows the dataset's range instead. So does a video hosted on
Vimeo, such as Sea temperature: the node gives its length in whole
seconds, which isn't quite the file's, and a date worked out from it
would drift from the picture with every loop.

The credit is the record's attribution, or else its rights holder, or
else its organization, with the licence after it. A record that names
none of them, as some imported ones don't, has no credit line; "About"
still gives its licence statement.

## Notecards

All optional. Put them in the globe's Content tab beside the scripts. A
change is read at once. In each, a line starting with `#` is a comment
and blank lines are skipped.

### `presenters`

One **username** a line, as in a profile's URL or under the name in a
profile. A legacy name works too and is read as its username. A display
name never works, since anyone can take any display name.

```
# Presenters at the Zyra globe
eric.hackathorn
Brent Resident
```

`Brent Resident` is read as `brent`, which is what Second Life calls
that avatar now.

### `datasets`

The menu, one `Name = dataset id` a line, in the order it shows them. A
dataset's id is 26 capital letters and digits, its `id` in the node's
catalog (`https://terraviz.zyra-project.org/api/v1/catalog`, searched
for the title). A TerraViz link's `/dataset/` part is usually the
dataset's slug, such as `hurricane-season-2024`, which the node's API
doesn't take. A name is cut to a menu button's 24 bytes, so keep names
short and different in their first twenty characters or so.

```
# The Zyra globe's datasets
Hurricanes 2024 = 01KQG611HF8YXJNRBEHT0757KT
Sea temperature = 01KQG65ZW1JC7M27EQ1CYD8YZ7
Wildfire smoke, US = 01KYJDXB4909JWG8DP257D3D0Z
Earthquakes 2001-15 = 01KQG62M0Z3EC0T9EXFH1MVXDV
Nighttime lights = 01KQG629957NPZN7NTW4VK6FW0
```

That is also the menu without the notecard. A line that isn't
`Name = id`, with an id of letters, digits, `-` and `_`, is left out,
and so is a name that cuts to a menu button's own (`< Previous`,
`Next >`, `Main menu`). The owner is told which.

### `settings`

`name = value` lines, any of:

```
radius = 15
idle minutes = 5
hold seconds = 60
talk minutes = 2
```

| Setting | What it is | Allowed |
|---|---|---|
| `radius` | metres from the globe's surface that count as at it | 2 to 96 |
| `idle minutes` | how long after the last visitor leaves before the live Earth comes back | 1 to 1440 |
| `hold seconds` | how long a visitor holds the globe after their last choice | 10 to 3600 |
| `talk minutes` | how long with no presenter at the globe before a talk ends | 1 to 120 |

A value outside its range is ignored, with a word to the owner.

### A notecard named by a dataset's id

If the globe holds a notecard named exactly by a dataset's id, such as
`01KQG611HF8YXJNRBEHT0757KT`, a visitor choosing "About" for that
dataset is given the notecard instead of chat. It is for the datasets an
exhibit features, where a curator wants to say more than the abstract
does. A script can't write a notecard, so every other dataset gets chat.
The notecard needs copy and transfer permission for its owner: without
copy the first visitor would take it, and without transfer it can't be
given at all. Such a notecard is skipped, the visitor gets chat, and
the owner is told why.

## The owner's commands

Said in local chat on channel 9, by the object's owner only. The globe
script takes the smoke test's commands, on 9 rather than 8, so one
command never reaches both kinds of globe:

`/9 show <name or id>`, `/9 list`, `/9 earth`, `/9 pause`, `/9 play`,
`/9 jump <s or m:ss>`, `/9 rate <speed>`, `/9 rotation <degrees>`,
`/9 spin <degrees a second>` or `/9 spin off`, `/9 debug on|off`,
`/9 width 1024|2048`, `/9 telemetry on|off`, `/9 steer hash|query`,
`/9 status`, `/9 upright`.

The probe kit's README describes each, under
[Commands](../second-life-probe/README.md#commands). Here `/9 rotation`
also sets where the globe goes back to once visitors leave. The owner
can always act, and doesn't take the hold. Besides those:

| Command | What it does |
|---|---|
| `/9 turn <degrees>` | Turns the globe that far east, the way the Earth turns, or west for a negative number, as the menu's turn buttons do. Unlike `/9 rotation`, it doesn't move where the globe goes back to. |
| `/9 presenters` | What the notecards gave: how many presenters and datasets, and the four settings. |
| `/9 talk` | Whether a talk is on, and when none is, how many avatars are at the globe. `/9 talk start` and `/9 talk end` start and end one. |
| `/9 memory` | How much of its 64 KB each script uses. The info script also says the most it has used reading a record. |
| `/9 help` | The globe script's list. |

## What leaves the object

Nothing about a visitor reaches the node. The visitors script reads the
region's avatar list every five seconds and keeps only how many are
near and when someone last was. It knows the holder by key, and by
display name to tell others who has the globe, only while the hold
lasts, and anyone with a menu open by key, for the five minutes the
menu answers. The info script keeps the key of the last visitor who
asked for "About", so a double press is answered once, and tells a
visitor about a dataset in their own chat, which no one else sees.
Nothing is kept across a reset.

What each visitor's viewer loads is the output page, from the node, like
any web page. With `/9 telemetry on` that page reports, anonymously and
only in the first minute after it loads, which dataset it showed and
anything that failed. The probe kit's README has the details; the
floating text and the object's description say so while it is on.

## Smoke-testing the exhibit

You need a second avatar, or a friend, for most of this. Have them
stand at the globe.

1. **Setup.** `/9 presenters` lists what was read. `/9 debug on` should
   show the readout on the globe.
2. **Does a left-click reach the script?** The second avatar left-clicks
   the globe. If a menu opens, a left-click works in their viewer and
   the floating text's "Right-click" is more than they need. If not,
   that is what the plan expected, and a touchable stand beside the
   globe is the remedy, which isn't built. Say which viewer it was.
3. **A visitor's menu.** They right-click and Touch: About, Datasets and
   the controls. They choose Datasets and Earthquakes 2001-15. Everyone
   at the globe should see it start, and the floating text should show
   its title, a date moving from 1 Jan 2001 to 2 Dec 2015 across the
   three-minute clip, updated every couple of seconds, and a credit
   starting `Credit: NOAA Pacific Tsunami Warning Center`. Hurricanes
   2024 shows a date and no credit, since its record names none.
4. **The hold.** A third avatar touches the globe within a minute of the
   second one's choice. (The owner can't test this: the owner may always
   act.) They should get only About, and be told who has the globe and
   for how long. Once the second avatar walks out of range, the globe
   should free up within five seconds.
5. **Pause.** They pause. The date should stop and match the frame, and
   both views should show the same frame.
6. **About.** They choose About. They should get the abstract, the
   credit, the licence and a link, in their own chat, in a few pieces.
   Nobody else should see it. Then add a notecard named
   `01KQG611HF8YXJNRBEHT0757KT` and choose About again: they should be
   offered the notecard.
7. **A talk.** Add yourself to `presenters` and choose Start talk. The
   other avatar's menu should lose its controls, and the floating text
   should say a talk is on. Leave the globe for longer than
   `talk minutes`, or use a short one in `settings`: the talk should end
   with a word in chat.
8. **Turning, and the idle return.** `/9 rotation 0`. The other avatar
   chooses Turn east: whichever side each of you faces, the places on it
   should move to your right. Set `idle minutes = 1`, show a dataset, and
   have everyone leave the globe. About a minute later it should go back
   to the live Earth, facing as it did before the turn. It shouldn't
   during a talk.
9. **Memory, and a date with a time.** `/9 show 01KQG61S53Y319P64XSKMXMZT1`,
   Aurora, which has the longest record on the node and a frame every
   five minutes. The floating text should show a date and a UTC time,
   from 30 Sep 2012, 12:00 UTC to 1 Oct 2012, 11:35 UTC across the clip.
   Then `/9 memory`. Every script should report well under 64 KB. The
   info script's peak is the number that matters: say what it was.

When you report results, say which viewer and version (Help → About)
each avatar used, and what steps 2 and 9 showed.

## Things that will trip you up

- **A visitor's change takes a second.** Second Life pauses the globe
  script for a second whenever it sets media.
- **A long dataset name in `datasets` is cut** to a button's 24 bytes.
  Two names that cut alike answer as the first.
- **The date is UTC**, and follows the clip as the region's clock says:
  a second or so from the picture while playing, exact when paused. On
  a clip left looping for hours it can drift further, since the script
  wraps on the length the node reports and each viewer's page on the
  video's own, which can differ slightly (`SECOND_LIFE_COMPAT.md` §7).
- **A long record is read only in part.** The info script reads its
  first 9,000 bytes, which today holds every field it needs for every
  record on the node, the longest needing 8,356. It keeps 2,500
  characters of an abstract, 600 of a licence statement and 300 of a
  credit. A value cut short ends `...`, and "About" then says the rest
  is at the dataset's page. In a record longer than 9,000 bytes, a field
  past the cut is missing: the licence is lost first, then the dates.
  The credit then doesn't fall back to the organization, which might
  not be the credit the record gives.
- **Display names don't make presenters.** If someone in `presenters`
  isn't recognised, check their username in their profile.

## Changing the scripts

The scripts are written by hand: edit them directly. `npx vitest run
scripts/second-life-exhibit scripts/second-life-probe` runs the tests
that keep them in step with each other, with the output page and with
the node, and [lslint](https://github.com/Makopo/lslint) checks each
script's syntax, since LSL compiles only in-world.
