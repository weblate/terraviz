// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit globe - the info script.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS SCRIPT DOES
// It is one of the exhibit's three scripts, and the one that says what the
// globe shows. terraviz-exhibit.lsl tells it what that is after every
// change. From the node it reads the dataset's record and, for a video,
// the clip's length, and from those it keeps two things:
// - The hover text over the globe, in this order:
//     TerraViz globe
//     the telemetry notice, while the owner has telemetry on
//     the title
//     the date: exact when paused, every couple of seconds while playing,
//       and the dataset's range when the clip's length isn't known
//     a short credit, such as "Credit: NOAA · CC-BY-4.0"
//     "A talk is in progress", during one
//     how to touch the globe
//   Hover text holds 254 bytes. The title and the credit share what the
//   other lines leave, the title keeping at least 32 bytes and the credit
//   48 where both fit, the title's first where they don't, and either is
//   cut with "..." when it has to be. Nothing else is cut, so the notice
//   is never lost.
// - "About", from the touch menu. If the globe holds a notecard named by
//   the dataset's id, the visitor is given it. Otherwise they get the
//   abstract, the full credit, the licence and a link to the dataset's
//   page, in their own chat, in pieces of about 1 KB. A very long
//   abstract is cut, and the link has the rest.
//
// A DATE is the dataset's start time plus the share of its span that the
// clip has played, the arithmetic of the app's videoTimeToDate. How it is
// shown is this script's own: to the period's precision, the year for a
// yearly dataset ("P1Y"), the month for a monthly one, the time for one
// with a period under a day, and the day for the rest, all in UTC. The
// app shows the day, or for a period under a day the time, in the
// viewer's time zone. A day,
// month or year is counted from the start's own, so on data stamped at
// noon the day changes with the frame rather than at midnight between.
// A video on Vimeo shows its range: Vimeo gives its length in whole
// seconds, the page loops on the stream's own, and a date worked out
// from the first drifts from the picture with every loop. Only the node
// knows a dataset is on Vimeo; this script recognises one by a
// player.vimeo.com address anywhere in its manifest. A node whose proxy
// rewrote that address would be missed, and its Vimeo datasets' dates
// would drift.
//
// The owner can ask "/9 memory": each of the three scripts says how much
// of its 64 KB it uses, and this one also says the most it has used while
// reading a record, which is when it needs the most.

integer CHAN = 9;

integer MSG_STATE   = 271001;  // globe to all: what the globe shows, as JSON
integer MSG_HELLO   = 271003;  // any to globe: say the state again (a script reset)
integer MSG_TALK    = 271004;  // visitors to info: "1" during a talk, "0" otherwise
integer MSG_ABOUT   = 271005;  // visitors to info: tell the key about what the globe shows

// How much of a record is read, in bytes. Every field this script uses
// comes before the record's `createdAt`, which began at byte 8,356 (UTF-8,
// measured to that key) in the longest record on the node in October 2026. That order is this node's
// serializer's, not a promise of the protocol (docs/protocol/README.md);
// exhibit.test.ts fails if it changes. A record longer than this is read
// as far as it goes: a value cut short ends "...", a field past the cut is
// missing, and "About" says the rest is at the dataset's page.
integer BODY_MAX = 9000;
// How much of a manifest: its length and stream address come before its
// list of files, which for a Vimeo video is long, and this leaves room for
// a long title and address before them.
integer MANIFEST_MAX = 4096;
integer ABSTRACT_MAX = 2500;   // characters of an abstract kept for "About"
integer PIECE = 1000;          // bytes of a chat piece; a chat line holds 1024
float   TICK = 2.0;            // how often a playing clip's date is worked out again
integer MIN_CREDIT = 48;       // bytes the credit keeps when the hover text is full
integer MIN_TITLE = 32;        // bytes the title keeps, first, when there isn't room for both
string  TAG_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ/!";

string  LIVE_LINE = "The live Earth: today's clouds and the real day and night";
string  LIVE_CREDIT = "Credit: NASA Blue Marble, Black Marble";
string  LIVE_ABOUT = "The live Earth: NASA's Blue Marble by day and its Black Marble city lights at night, under today's clouds, lit by the Sun as it stands right now. The globe rests on it when nobody has chosen a dataset.";
string  TOUCH_LINE = "Right-click, Touch for more";
string  TALK_LINE = "A talk is in progress";

list    MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
integer RES_DAY = 0;
integer RES_MONTH = 1;
integer RES_YEAR = 2;
integer RES_TIME = 3;

// What the globe shows, from the globe script.
string  gDataset;
string  gTitle;
float   gPos;
integer gAtS;
integer gAtMs;
float   gRate = 1.0;
integer gPaused;
integer gTelemetry;
string  gNode;
integer gTalk;

// What the node says about it.
string  gFor;          // the dataset the fields below describe
integer gHaveRec;
string  gRef;          // the dataset's slug, or its id, for its page's link
integer gVideo;
integer gDated;
integer gStartDay;     // days since 1970, and seconds into that day
integer gStartSec;
integer gEndDay;
integer gEndSec;
integer gRes;
integer gSnapS;        // a sub-daily period in seconds, or 0
float   gDuration;     // the clip's length in seconds, 0 while unknown
string  gWho;
string  gSpdx;
string  gLicUrl;
string  gStatement;
string  gAbstract;
integer gCut;          // a value was cut short, or the record wasn't read to the end
integer gLastCut;      // the last field() read was cut short
integer gCuts;         // which of the abstract (1), credit (2), licence id (4) and statement (8) were

key     gRecReq;
key     gManReq;
integer gRecTries;
integer gManTries;
integer gRetryAt;

string  gShown;        // the hover text as last set
integer gPeak;         // the most memory used reading a record
key     gLastAbout;
integer gLastAboutAt;

// Days since 1970-01-01 (Howard Hinnant's days_from_civil), as the globe
// script counts them.
integer days(integer y, integer mo, integer d)
{
    integer mp = mo - 3;
    if (mo <= 2) { y -= 1; mp = mo + 9; }
    integer era = y / 400;
    integer yoe = y - era * 400;
    integer doy = (153 * mp + 2) / 5 + d - 1;
    return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

// [year, month, day] for a day since 1970 (civil_from_days), from year 1 on.
list civil(integer z)
{
    z += 719468;
    integer era = z / 146097;
    integer doe = z - era * 146097;
    integer yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    integer doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    integer mp = (5 * doy + 2) / 153;
    integer d = doy - (153 * mp + 2) / 5 + 1;
    integer m = mp + 3;
    if (mp >= 10) m = mp - 9;
    integer y = yoe + era * 400;
    if (m <= 2) ++y;
    return [y, m, d];
}

// Unix time from the region's clock, as [seconds, milliseconds], as the
// globe script reads it.
list now()
{
    string ts = llGetTimestamp();
    integer s = (integer)llGetSubString(ts, 11, 12) * 3600 + (integer)llGetSubString(ts, 14, 15) * 60
        + (integer)llGetSubString(ts, 17, 18);
    integer d = days((integer)llGetSubString(ts, 0, 3), (integer)llGetSubString(ts, 5, 6), (integer)llGetSubString(ts, 8, 9));
    string frac = llList2String(llParseString2List(ts, [".", "Z"], []), 1) + "000";
    return [d * 86400 + s, (integer)llGetSubString(frac, 0, 2)];
}

// [day, second] for an ISO time such as 2024-06-01T12:00:00Z, or [] if it
// isn't one.
list instant(string t)
{
    if (llStringLength(t) < 19 || llGetSubString(t, 4, 4) != "-" || llGetSubString(t, 10, 10) != "T") return [];
    integer y = (integer)llGetSubString(t, 0, 3);
    integer mo = (integer)llGetSubString(t, 5, 6);
    integer d = (integer)llGetSubString(t, 8, 9);
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return [];
    return [days(y, mo, d), (integer)llGetSubString(t, 11, 12) * 3600 + (integer)llGetSubString(t, 14, 15) * 60
        + (integer)llGetSubString(t, 17, 18)];
}

// What a period says about the date's precision, read as the ISO 8601
// durations the app's parseISO8601Duration takes: P, then any of nY nM nW
// nD, then T and any of nH nM nS. The node doesn't check a period when
// it's written, so one that doesn't parse shows the day.
period(string p)
{
    gRes = RES_DAY;
    gSnapS = 0;
    if (llGetSubString(p, 0, 1) == "PT") gRes = RES_TIME;
    if (llGetSubString(p, 0, 0) != "P") return;
    string units = "YMWD";
    string num = "";
    integer inT = FALSE;
    integer last = -1;
    string seen = "";
    integer secs = 0;
    integer i;
    integer n = llStringLength(p);
    for (i = 1; i < n; ++i)
    {
        string c = llGetSubString(p, i, i);
        if (llSubStringIndex("0123456789.", c) != -1) num += c;
        else if (c == "T" && !inT && num == "") { inT = TRUE; units = "HMS"; last = -1; }
        else
        {
            integer at = llSubStringIndex(units, c);
            if (num == "" || at <= last) { gSnapS = 0; if (gRes != RES_TIME) gRes = RES_DAY; return; }
            last = at;
            if (inT) secs += (integer)((float)num * llList2Float([3600.0, 60.0, 1.0], at));
            else seen += c;
            num = "";
        }
    }
    if (num != "") return;
    if (gRes == RES_TIME) { gSnapS = secs; return; }
    if (inT) return;
    if (seen == "Y") gRes = RES_YEAR;
    else if (seen == "M") gRes = RES_MONTH;
}

string pad(integer n)
{
    if (n < 10) return "0" + (string)n;
    return (string)n;
}

string when(integer day, integer sec)
{
    list c = civil(day);
    string y = (string)llList2Integer(c, 0);
    string mon = llList2String(MONTHS, llList2Integer(c, 1) - 1);
    if (gRes == RES_YEAR) return y;
    if (gRes == RES_MONTH) return mon + " " + y;
    string s = (string)llList2Integer(c, 2) + " " + mon + " " + y;
    if (gRes == RES_TIME) s += ", " + pad(sec / 3600) + ":" + pad(sec % 3600 / 60) + " UTC";
    return s;
}

string range()
{
    if (!gDated) return "";
    string a = when(gStartDay, gStartSec);
    string b = when(gEndDay, gEndSec);
    if (a == b) return a;
    if (gRes == RES_TIME) a = llGetSubString(a, 0, -5);   // one " UTC" says it for both
    return a + " to " + b;
}

// Where the clip is now, round the loop, as each visitor's page puts it.
float position()
{
    float p = gPos;
    if (!gPaused)
    {
        list t = now();
        p += ((float)(llList2Integer(t, 0) - gAtS) + (float)(llList2Integer(t, 1) - gAtMs) / 1000.0) * gRate;
    }
    return p - gDuration * llFloor(p / gDuration);
}

// The date on the globe now, or the dataset's range when the clip's
// length isn't known, as for an image.
string date()
{
    if (!gDated) return "";
    if (gDuration <= 0.0) return range();
    float f = position() / gDuration;
    if (f < 0.0) f = 0.0;
    if (f > 1.0) f = 1.0;
    float into = f * ((float)(gEndDay - gStartDay) * 86400.0 + (float)(gEndSec - gStartSec));
    // Days, months and years count from the start's own, with a hair of
    // slack so a frame landed on exactly isn't read as the one before.
    if (gRes == RES_DAY) return when(gStartDay + llFloor(into / 86400.0 + 0.0001), 0);
    list a = civil(gStartDay);
    list b = civil(gEndDay);
    integer sy = llList2Integer(a, 0);
    if (gRes == RES_YEAR)
        return (string)(sy + llFloor(f * (float)(llList2Integer(b, 0) - sy) + 0.0001));
    if (gRes == RES_MONTH)
    {
        integer m0 = sy * 12 + llList2Integer(a, 1) - 1;
        integer months = llList2Integer(b, 0) * 12 + llList2Integer(b, 1) - 1 - m0;
        m0 += llFloor(f * (float)months + 0.0001);
        return llList2String(MONTHS, m0 % 12) + " " + (string)(m0 / 12);
    }
    float off = (float)gStartSec + into;
    integer dd = llFloor(off / 86400.0);
    integer day = gStartDay + dd;
    integer sec = (integer)(off - (float)dd * 86400.0);
    if (sec < 0) sec = 0;
    if (sec > 86399) sec = 86399;
    // A time: to the period when a day holds a whole number of them, as the
    // app snaps it, else to the minute.
    integer step = 60;
    if (gSnapS > 0 && 86400 % gSnapS == 0) step = gSnapS;
    sec = (sec + step / 2) / step * step;
    if (sec >= 86400) { sec -= 86400; ++day; }
    if (day > gEndDay || (day == gEndDay && sec > gEndSec)) { day = gEndDay; sec = gEndSec; }
    if (day < gStartDay || (day == gStartDay && sec < gStartSec)) { day = gStartDay; sec = gStartSec; }
    return when(day, sec);
}

// The bytes a string takes in UTF-8, which is what the hover text's and
// a chat line's limits count.
integer bytes(string s)
{
    string b = llStringToBase64(s);
    integer pads = 0;
    if (llGetSubString(b, -2, -1) == "==") pads = 2;
    else if (llGetSubString(b, -1, -1) == "=") pads = 1;
    return llStringLength(b) / 4 * 3 - pads;
}

// A string cut to fit, with "..." to say so. A character takes at least a
// byte, so the first cut is by characters and the rest is only for text
// that isn't ASCII.
string fit(string s, integer max)
{
    if (bytes(s) <= max) return s;
    if (max < 4) return "";
    s = llGetSubString(s, 0, max - 4);
    while (bytes(s) > max - 3) s = llDeleteSubString(s, -1, -1);
    return llStringTrim(s, STRING_TRIM_TAIL) + "...";
}

hover()
{
    string title = gTitle;
    string credit = LIVE_CREDIT;
    string stamp = "";
    if (gDataset == "") title = LIVE_LINE;
    else
    {
        credit = "";
        if (gFor == gDataset && gHaveRec)
        {
            string lic = gSpdx;
            if (gWho != "" && lic != "") credit = "Credit: " + gWho + " · " + lic;
            else if (gWho != "" || lic != "") credit = "Credit: " + gWho + lic;
            stamp = date();
        }
    }
    string top = "TerraViz globe\n";
    if (gTelemetry) top += "Counts anonymous use: " + gNode + "/privacy\n";
    string tail = "";
    if (stamp != "") tail += "\n" + stamp;
    string end = "";
    if (gTalk) end += "\n" + TALK_LINE;
    end += "\n" + TOUCH_LINE;

    integer avail = 254 - bytes(top) - bytes(tail) - bytes(end);
    if (credit != "") avail -= 1;
    integer t = bytes(title);
    integer c = bytes(credit);
    if (t + c > avail)
    {
        integer keepC = c;
        if (keepC > MIN_CREDIT) keepC = MIN_CREDIT;
        integer keepT = avail - keepC;
        if (keepT < MIN_TITLE) keepT = MIN_TITLE;
        if (keepT > t) keepT = t;
        title = fit(title, keepT);
        credit = fit(credit, avail - bytes(title));
    }
    string s = top + title + tail;
    if (credit != "") s += "\n" + credit;
    s += end;
    if (bytes(s) > 254) s = fit(s, 254);
    if (s == gShown) return;
    gShown = s;
    llSetText(s, <1.0, 1.0, 1.0>, 1.0);
}

// The timer runs while a clip's date moves, and while a request waits to
// be made again.
pace()
{
    integer moving = gDataset != "" && !gPaused && gDated && gDuration > 0.0 && gFor == gDataset;
    if (moving || gRetryAt) llSetTimerEvent(TICK);
    else llSetTimerEvent(0.0);
}

later(integer s)
{
    integer at = llGetUnixTime() + s;
    if (gRetryAt == 0 || at < gRetryAt) gRetryAt = at;
}

fetch()
{
    if (gDataset == "" || gNode == "") return;
    string base = gNode + "/api/v1/datasets/" + llEscapeURL(gDataset);
    if (!gHaveRec && gRecTries < 3)
    {
        ++gRecTries;
        gRecReq = llHTTPRequest(base, [HTTP_METHOD, "GET", HTTP_ACCEPT, "application/json",
            HTTP_BODY_MAXLENGTH, BODY_MAX], "");
    }
    else if (gHaveRec && gVideo && gDuration <= 0.0 && gManTries < 4)
    {
        ++gManTries;
        gManReq = llHTTPRequest(base + "/manifest", [HTTP_METHOD, "GET", HTTP_ACCEPT, "application/json",
            HTTP_BODY_MAXLENGTH, MANIFEST_MAX], "");
    }
    else return;
    // A request Second Life throttled gets no key and never an answer.
    if (gRecReq == NULL_KEY && gManReq == NULL_KEY) later(30);
}

// A field's string value from a record that may have been cut short, up
// to `max` characters of it. Only matches before `stop` count: every field
// read comes before `createdAt`, and nothing before it is an object, so no
// key inside one (probingInfo's, enriched's) can be taken for a field.
string field(string body, integer stop, string name, integer max)
{
    gLastCut = FALSE;
    string tag = "\"" + name + "\":\"";
    integer i = llSubStringIndex(body, tag);
    if (i == -1 || (stop != -1 && i > stop)) return "";
    i += llStringLength(tag);
    string raw = llGetSubString(body, i, i + max + 16);
    // The closing quote is the first one not escaped. JSON can't hold a raw
    // tab, so two tabs stand in for each escaped backslash and then each
    // escaped quote, which keeps every index, and the first quote left is
    // the one that closes the value.
    integer at = llSubStringIndex(llReplaceSubString(llReplaceSubString(raw, "\\\\", "\t\t", 0),
        "\\\"", "\t\t", 0), "\"");
    if (at == 0) return "";
    if (at > 0 && at <= max) raw = llGetSubString(raw, 0, at - 1);
    else
    {
        // Longer than kept, or cut off by BODY_MAX: end at a space, which
        // can't fall inside an escape. A value with no space, such as a
        // time or a long link, is dropped rather than read cut, and
        // "About" says some of the record is at its page.
        raw = llGetSubString(raw, 0, max - 1);
        integer sp = llStringLength(raw) - 1;
        while (sp > 0 && llGetSubString(raw, sp, sp) != " ") --sp;
        if (sp <= 0) { gCut = TRUE; return ""; }
        raw = llGetSubString(raw, 0, sp - 1);
        gLastCut = TRUE;
        gCut = TRUE;
    }
    string v = llJsonGetValue("[\"" + raw + "\"]", [0]);
    if (v == JSON_INVALID) return "";
    return v;
}

// Text from HTML, as some records' organizations and abstracts are:
// tags go, the common entities are read, and runs of spaces fold.
string plain(string s)
{
    // A tag is a < before a letter, / or !, up to its >, or to the end
    // when a cut left it open. Any other <, as in "size < 2.5", is text.
    string out = "";
    integer a = llSubStringIndex(s, "<");
    while (a != -1)
    {
        string next = "";
        if (a + 1 < llStringLength(s)) next = llGetSubString(s, a + 1, a + 1);
        if (a > 0) out += llGetSubString(s, 0, a - 1);
        if (next == "" || llSubStringIndex(TAG_START, next) == -1)
        {
            out += "<";
            s = llDeleteSubString(s, 0, a);
        }
        else
        {
            integer b = llSubStringIndex(llGetSubString(s, a, -1), ">");
            if (b == -1) s = "";
            else
            {
                out += " ";
                s = llDeleteSubString(s, 0, a + b);
            }
        }
        a = llSubStringIndex(s, "<");
    }
    s = out + s;
    out = "";
    s = llReplaceSubString(s, "&nbsp;", " ", 0);
    s = llReplaceSubString(s, "&nbsp", " ", 0);
    s = llReplaceSubString(s, "&quot;", "\"", 0);
    s = llReplaceSubString(s, "&#39;", "'", 0);
    s = llReplaceSubString(s, "&lt;", "<", 0);
    s = llReplaceSubString(s, "&gt;", ">", 0);
    s = llReplaceSubString(s, "&amp;", "&", 0);
    s = llReplaceSubString(s, "\t", " ", 0);
    while (llSubStringIndex(s, "  ") != -1) s = llReplaceSubString(s, "  ", " ", 0);
    return llStringTrim(s, STRING_TRIM);
}

// The canonical page for a dataset names its slug when it has a usable
// one, as the app builds the link, and its id otherwise.
string ref(string slug)
{
    integer n = llStringLength(slug);
    if (n < 3 || n > 64 || llSubStringIndex("abcdefghijklmnopqrstuvwxyz", llGetSubString(slug, 0, 0)) == -1) return gDataset;
    integer i;
    for (i = 1; i < n; ++i)
        if (llSubStringIndex("abcdefghijklmnopqrstuvwxyz0123456789-", llGetSubString(slug, i, i)) == -1) return gDataset;
    return slug;
}

record(string body)
{
    // Where the fields this script reads end. A record without it was cut
    // before it by BODY_MAX, so a field not found may be one not read.
    integer stop = llSubStringIndex(body, ",\"createdAt\":");
    integer whole = stop != -1;
    if (!whole) gCut = TRUE;
    gRef = ref(field(body, stop, "slug", 70));
    gVideo = llSubStringIndex(field(body, stop, "format", 40), "video/") == 0;
    gCuts = 0;
    gAbstract = field(body, stop, "abstractTxt", ABSTRACT_MAX);
    if (gLastCut) gCuts = gCuts | 1;
    gWho = field(body, stop, "attributionText", 300);
    if (gWho == "") gWho = field(body, stop, "rightsHolder", 300);
    // The organization, which comes first, is the credit only when the
    // record says nothing later: it may not be the credit a record cut
    // short would have given.
    if (gWho == "" && whole) gWho = field(body, stop, "organization", 400);
    if (gLastCut) gCuts = gCuts | 2;
    gSpdx = field(body, stop, "licenseSpdx", 120);
    if (gLastCut) gCuts = gCuts | 4;
    gLicUrl = field(body, stop, "licenseUrl", 300);
    gStatement = field(body, stop, "licenseStatement", 600);
    if (gLastCut) gCuts = gCuts | 8;
    list a = instant(field(body, stop, "startTime", 40));
    list b = instant(field(body, stop, "endTime", 40));
    gDated = a != [] && b != [];
    if (gDated)
    {
        gStartDay = llList2Integer(a, 0); gStartSec = llList2Integer(a, 1);
        gEndDay = llList2Integer(b, 0); gEndSec = llList2Integer(b, 1);
        if (gEndDay < gStartDay || (gEndDay == gStartDay && gEndSec < gStartSec)) gDated = FALSE;
    }
    period(field(body, stop, "period", 40));
    gHaveRec = TRUE;
}

// The HTML out of the text a record carries, done once the record itself
// has been let go, since it is the most this script ever holds. A value
// cut short says so after the HTML has gone, since a cut can fall inside a
// tag, which goes with it.
tidy()
{
    gAbstract = plain(gAbstract) + llList2String(["", "..."], (gCuts & 1) != 0);
    gWho = plain(gWho) + llList2String(["", "..."], (gCuts & 2) != 0);
    gSpdx = plain(gSpdx) + llList2String(["", "..."], (gCuts & 4) != 0);
    gStatement = plain(gStatement) + llList2String(["", "..."], (gCuts & 8) != 0);
}

// Chat to one visitor, in pieces that fit a chat line, cut between words.
say(key av, string text)
{
    while (text != "")
    {
        integer n = llStringLength(text);
        if (n > 900) n = 900;
        while (n > 1 && bytes(llGetSubString(text, 0, n - 1)) > PIECE) n = n * 3 / 4;
        if (n < llStringLength(text))
        {
            integer sp = n - 1;
            while (sp > n / 2 && llSubStringIndex(" \n", llGetSubString(text, sp, sp)) == -1) --sp;
            if (sp > n / 2) n = sp + 1;
        }
        llRegionSayTo(av, 0, llStringTrim(llGetSubString(text, 0, n - 1), STRING_TRIM));
        text = llStringTrim(llDeleteSubString(text, 0, n - 1), STRING_TRIM_HEAD);
    }
}

about(key av)
{
    // A visitor pressing About twice is answered once.
    integer t = llGetUnixTime();
    if (av == gLastAbout && t - gLastAboutAt < 10) return;
    gLastAbout = av;
    gLastAboutAt = t;

    if (gDataset == "") { say(av, LIVE_ABOUT + " TerraViz: " + gNode); return; }
    if (llGetInventoryType(gDataset) == INVENTORY_NOTECARD)
    {
        // Without copy it would move to the first visitor, and without
        // transfer it can't be given at all.
        integer perms = llGetInventoryPermMask(gDataset, MASK_OWNER);
        if ((perms & PERM_COPY) && (perms & PERM_TRANSFER))
        {
            llRegionSayTo(av, 0, "Here is a notecard about " + gTitle + ".");
            llGiveInventory(av, gDataset);
            return;
        }
        llOwnerSay("[exhibit] The notecard " + gDataset + " needs copy and transfer permission to be given. "
            + "The visitor got the chat version instead.");
    }
    string link = gNode + "/dataset/" + gDataset;
    if (gFor != gDataset || !gHaveRec)
    {
        say(av, gTitle + ". More about it: " + link);
        return;
    }
    link = gNode + "/dataset/" + gRef;
    string text = gTitle;
    string r = range();
    if (r != "") text += " (" + r + ")";
    if (gAbstract != "") text += "\n" + gAbstract;
    if (gWho != "") text += "\nCredit: " + gWho;
    string lic = llDumpList2String(llParseString2List(llDumpList2String([gSpdx, gStatement, gLicUrl], "\n"), ["\n"], []), " ");
    if (lic != "") text += "\nLicence: " + lic;
    if (gCut) text += "\nSome of this was too long to give here. All of it is at " + link;
    else text += "\nMore about it: " + link;
    say(av, text);
}

forget()
{
    gFor = gDataset;
    gHaveRec = FALSE;
    gVideo = FALSE;
    gDated = FALSE;
    gDuration = 0.0;
    gRef = gDataset;
    gWho = ""; gSpdx = ""; gLicUrl = ""; gStatement = ""; gAbstract = "";
    gCut = FALSE;
    gRecTries = 0;
    gManTries = 0;
    gRetryAt = 0;
    gRecReq = NULL_KEY;
    gManReq = NULL_KEY;
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        llSetText("TerraViz globe", <1.0, 1.0, 1.0>, 1.0);
        gShown = "";
        llMessageLinked(LINK_THIS, MSG_HELLO, "", NULL_KEY);
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
    }

    link_message(integer sender, integer n, string str, key id)
    {
        if (n == MSG_TALK) { gTalk = str == "1"; hover(); return; }
        if (n == MSG_ABOUT) { about(id); return; }
        if (n != MSG_STATE) return;
        string dataset = llJsonGetValue(str, ["dataset"]);
        if (dataset == JSON_INVALID) return;
        gDataset = dataset;
        gTitle = llJsonGetValue(str, ["title"]);
        gPos = (float)llJsonGetValue(str, ["pos"]);
        gAtS = (integer)llJsonGetValue(str, ["atS"]);
        gAtMs = (integer)llJsonGetValue(str, ["atMs"]);
        gRate = (float)llJsonGetValue(str, ["rate"]);
        gPaused = (integer)llJsonGetValue(str, ["paused"]);
        gTelemetry = (integer)llJsonGetValue(str, ["telemetry"]);
        gNode = llJsonGetValue(str, ["node"]);
        if (gDataset != gFor)
        {
            forget();
            fetch();
        }
        hover();
        pace();
    }

    http_response(key req, integer status, list meta, string body)
    {
        if (req == gRecReq)
        {
            gRecReq = NULL_KEY;
            if (status != 200) { later(30); pace(); return; }
            llScriptProfiler(PROFILE_SCRIPT_MEMORY);
            record(body);
            body = "";
            tidy();
            llScriptProfiler(PROFILE_NONE);
            if (llGetSPMaxMemory() > gPeak) gPeak = llGetSPMaxMemory();
            fetch();
        }
        else if (req == gManReq)
        {
            gManReq = NULL_KEY;
            integer i = llSubStringIndex(body, "\"duration\":");
            if (status == 200 && i != -1) gDuration = (float)llGetSubString(body, i + 11, i + 40);
            if (gDuration < 0.0) gDuration = 0.0;
            // Vimeo's length is whole seconds and the file's isn't (12 for
            // a clip of 12.1 s), so a date from it drifts with every loop
            // the page plays: unknown, and the range shows, which the
            // plan's fallback for an unknown length is.
            if (llSubStringIndex(body, "player.vimeo.com/") != -1) { gDuration = 0.0; gManTries = 4; }
            // A length of 0 is unknown, and can be the node's for a moment
            // while its bucket is slow, which it keeps for 15 s: so ask again,
            // then show the range.
            if (gDuration == 0.0 && gManTries < 4) later(16 << (gManTries - 1));
        }
        else return;
        hover();
        pace();
    }

    timer()
    {
        if (gRetryAt && llGetUnixTime() >= gRetryAt)
        {
            gRetryAt = 0;
            fetch();
        }
        hover();
        pace();
    }

    listen(integer ch, string name, key who, string msg)
    {
        if (llToLower(llStringTrim(msg, STRING_TRIM)) != "memory") return;
        string peak = "";
        if (gPeak) peak = ", and at most " + (string)(gPeak / 1024) + " KB while reading a record";
        llOwnerSay("[exhibit] Info script: " + (string)(llGetUsedMemory() / 1024) + " KB used of 64" + peak + ".");
    }
}
