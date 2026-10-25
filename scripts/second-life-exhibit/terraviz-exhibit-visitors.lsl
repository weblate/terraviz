// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit globe - the visitors script.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS SCRIPT DOES
// It is one of the exhibit's three scripts, and the one that deals with
// people. terraviz-exhibit.lsl decides what the globe shows, and this one
// decides who may change it:
// - A touch opens a menu for whoever touched. "About" is always there.
//   The controls are there when that visitor may act.
// - Outside a talk, anyone may act, one at a time: whoever acts holds the
//   globe until "hold seconds" after their last action, or until they
//   leave it, and anyone else is told who has it and when it frees up.
// - During a talk, only the presenters may act. A presenter starts a talk
//   from the menu, whoever holds the globe. It ends when one chooses "End
//   talk", or once no presenter has been at the globe for "talk minutes".
// - "idle minutes" after the last visitor leaves the globe, it goes back
//   to the live Earth, but never during a talk.
// Everyone at the globe sees every change, since there is one globe.
//
// TOUCHING THE GLOBE
// A left-click on a face showing a web page goes to the page, not to a
// script (lltoolpie.cpp), and this globe's page takes no clicks. So a
// visitor right-clicks the globe and chooses Touch. Whether a plain
// left-click reaches the script in your viewer is worth checking with a
// second avatar; if it doesn't, a touchable stand beside the globe is
// the remedy, and isn't built yet.
//
// NOTECARDS, all optional, put in the globe's Content tab beside the
// scripts and re-read whenever they change. A line starting with # is a
// comment.
//   presenters  one username a line, such as eric.hackathorn. A legacy
//               name such as "Eric Hackathorn" works too. A display name
//               never does: anyone can take one.
//   datasets    the menu, one "Name = dataset id" a line, in the order it
//               shows them. Without it the menu offers five built in.
//   settings    "name = value" lines, any of:
//                 radius = 15         metres that count as at the globe
//                 idle minutes = 5    before the live Earth comes back
//                 hold seconds = 60   one visitor's hold after acting
//                 talk minutes = 2    no presenter nearby ends a talk
//
// Nothing about a visitor leaves the object. Who is at the globe is read
// from the region every few seconds and kept only as a time; the holder
// and the presenters are known by key while they are here.
//
// The owner may always act, and has two commands on channel 9 beside the
// globe script's: /9 talk (whether one is on; "/9 talk start" and "/9 talk
// end" start and end one) and /9 presenters (what the notecards gave).

integer CHAN = 9;

// The link messages the three scripts share. exhibit.test.ts holds the
// numbers to the globe script's.
integer MSG_STATE   = 271001;  // globe to all: what the globe shows, as JSON
integer MSG_CONTROL = 271002;  // visitors to globe: a control, for the key who asked
integer MSG_HELLO   = 271003;  // any to globe: say the state again (a script reset)
integer MSG_TALK    = 271004;  // visitors to info: "1" during a talk, "0" otherwise
integer MSG_ABOUT   = 271005;  // visitors to info: tell the key about what the globe shows

// The settings, and what the "settings" notecard may set them to.
float   gRadius = 15.0;
integer gIdleS = 300;
integer gHoldS = 60;
integer gTalkS = 120;

// The menu without a "datasets" notecard: the globe script's presets.
list    DEFAULT_MENU = [
    "Hurricanes 2024",      "01KQG611HF8YXJNRBEHT0757KT",
    "Sea temperature",      "01KQG65ZW1JC7M27EQ1CYD8YZ7",
    "Wildfire smoke, US",   "01KYJDXB4909JWG8DP257D3D0Z",
    "Earthquakes 2001-15",  "01KQG62M0Z3EC0T9EXFH1MVXDV",
    "Nighttime lights",     "01KQG629957NPZN7NTW4VK6FW0"
];

float   TICK = 5.0;          // how often presence, holds and talks are checked
integer PAGE = 9;            // datasets a menu page shows, beside its three moves
integer CTX_TTL = 300;       // seconds a menu stays answerable
integer CTX_MAX = 8;         // menus open at once
float   NUDGE = 10.0;

string  BTN_ABOUT = "About";
string  BTN_DATASETS = "Datasets";
string  BTN_PAUSE = "Pause";
string  BTN_PLAY = "Play";
string  BTN_BACK = "Back 10 s";
string  BTN_FWD = "Forward 10 s";
string  BTN_RESTART = "Start over";
string  BTN_EARTH = "Live Earth";
string  BTN_JUMP = "Jump to...";
string  BTN_START_TALK = "Start talk";
string  BTN_END_TALK = "End talk";
string  BTN_CLOSE = "Close";
string  BTN_PREV = "< Previous";
string  BTN_NEXT = "Next >";
string  BTN_MENU = "Main menu";

// What the globe shows, from the globe script.
string  gDataset;
string  gTitle;
integer gPaused;

list    gPresenters;         // usernames, lowercase
list    gMenu;               // name, id, name, id...
integer gTalk;
integer gTalkSeen;           // when a presenter was last at the globe
key     gHolder = NULL_KEY;
integer gHoldUntil;
string  gHolderName;
integer gLastSeen;           // when anyone was last at the globe
integer gIdleSent;
integer gNear;               // avatars at the globe at the last check

integer gDlg;                // the menus' channel
list    gCtx;                // who, what menu, page, when: one entry per open menu

list    gCards = ["settings", "presenters", "datasets"];
integer gCard;               // the notecard being read, as an index into gCards
integer gLine;
key     gCardReq;
list    gNewPresenters;
list    gNewMenu;

integer unix() { return llGetUnixTime(); }

// "Eric Hackathorn" and "eric.hackathorn" are one username; so are
// "Brent Resident" and "brent". Second Life gives usernames in lowercase,
// with a dot for the space, and drops a last name of Resident.
string username(string s)
{
    s = llToLower(llStringTrim(s, STRING_TRIM));
    if (llGetSubString(s, -9, -1) == " resident") s = llGetSubString(s, 0, -10);
    if (llGetSubString(s, -9, -1) == ".resident") s = llGetSubString(s, 0, -10);
    return llDumpList2String(llParseString2List(s, [" "], []), ".");
}

integer isPresenter(key who)
{
    if (who == llGetOwner()) return TRUE;
    string u = llGetUsername(who);
    return u != "" && llListFindList(gPresenters, [llToLower(u)]) != -1;
}

// May this visitor change the globe now?
integer mayAct(key who)
{
    if (who == llGetOwner()) return TRUE;
    if (gTalk) return isPresenter(who);
    return gHolder == NULL_KEY || gHolder == who || unix() >= gHoldUntil;
}

// Why not, in a line for the menu or for chat.
string whyNot()
{
    if (gTalk) return "A talk is in progress. Only its presenters can change the globe until it ends.";
    integer left = gHoldUntil - unix();
    string name = gHolderName;
    if (name == "") name = "Another visitor";
    return name + " is using the globe. It frees up in " + (string)left + " s, or when they choose something.";
}

// The visitor who acts holds the globe a while, outside a talk.
hold(key who)
{
    if (gTalk || who == llGetOwner()) return;
    gHolder = who;
    gHoldUntil = unix() + gHoldS;
    gHolderName = llGetDisplayName(who);
}

ask(key who, string cmd)
{
    hold(who);
    llMessageLinked(LINK_THIS, MSG_CONTROL, cmd, who);
}

// The bytes a string takes in UTF-8, which is what a menu's limits count:
// 24 for a button, 512 for the message.
integer bytes(string s)
{
    string b = llStringToBase64(s);
    integer n = llStringLength(b);
    integer pad = 0;
    if (llGetSubString(b, -2, -1) == "==") pad = 2;
    else if (llGetSubString(b, -1, -1) == "=") pad = 1;
    return n / 4 * 3 - pad;
}

// A string cut to fit, since a menu past either limit isn't shown at all.
// A character takes at least a byte, so the first cut is by characters.
string fit(string s, integer max)
{
    if (bytes(s) <= max) return s;
    s = llGetSubString(s, 0, max - 1);
    while (bytes(s) > max) s = llDeleteSubString(s, -1, -1);
    return s;
}

string label(string name) { return fit(name, 24); }

// A menu draws its buttons from the bottom row up. These are in reading
// order, so the rows go in reversed, with the odd ones out on top.
list layout(list b)
{
    integer n = llGetListLength(b);
    integer top = n % 3;
    if (top == 0) top = 3;
    list out = llList2List(b, 0, top - 1);
    integer i;
    for (i = top; i < n; i += 3) out = llList2List(b, i, i + 2) + out;
    return out;
}

menu(key who, string text, list b)
{
    llDialog(who, fit(text, 500), layout(b), gDlg);
}

remember(key who, string kind, integer page)
{
    integer at = llListFindList(gCtx, [who]);
    if (at != -1) gCtx = llDeleteSubList(gCtx, at, at + 3);
    gCtx += [who, kind, page, unix()];
    while (llGetListLength(gCtx) > CTX_MAX * 4) gCtx = llDeleteSubList(gCtx, 0, 3);
}

string showing()
{
    if (gDataset == "") return "The globe shows the live Earth: today's clouds and the real day and night.";
    string t = gTitle;
    if (llStringLength(t) > 100) t = llGetSubString(t, 0, 96) + "...";
    return "The globe shows " + t + ", " + llList2String(["playing", "paused"], gPaused) + ".";
}

// The main menu, in reading order: About and the datasets, the talk and
// the jump, the transport, and the way out.
mainMenu(key who)
{
    integer can = mayAct(who);
    integer presenter = isPresenter(who);
    integer clip = gDataset != "";
    list b = [BTN_ABOUT];
    if (can) b += [BTN_DATASETS];
    if (can && presenter && clip) b += [BTN_JUMP];
    // A presenter can start a talk whoever holds the globe, since the
    // talk is what a hold gives way to.
    if (presenter) b += [llList2String([BTN_START_TALK, BTN_END_TALK], gTalk)];
    if (can && clip) b += [llList2String([BTN_PAUSE, BTN_PLAY], gPaused), BTN_BACK, BTN_FWD, BTN_RESTART, BTN_EARTH];
    b += [BTN_CLOSE];

    string text = showing();
    if (!can) text += "\n" + whyNot();
    else if (gTalk) text += "\nA talk is in progress.";
    else if (who != llGetOwner()) text += "\nEveryone at the globe sees what you choose. It's yours for "
        + (string)gHoldS + " s after each choice.";
    remember(who, "main", 0);
    menu(who, text, b);
}

datasetsMenu(key who, integer page)
{
    integer count = llGetListLength(gMenu) / 2;
    integer pages = (count + PAGE - 1) / PAGE;
    if (pages < 1) pages = 1;
    if (page < 0) page = pages - 1;
    if (page >= pages) page = 0;
    list b = [];
    integer i;
    for (i = page * PAGE; i < count && i < (page + 1) * PAGE; ++i) b += [label(llList2String(gMenu, i * 2))];
    if (pages > 1) b += [BTN_PREV, BTN_MENU, BTN_NEXT];
    else b += [BTN_MENU];
    string text = "Choose a dataset for the globe.";
    if (pages > 1) text += " Page " + (string)(page + 1) + " of " + (string)pages + ".";
    remember(who, "datasets", page);
    menu(who, text, b);
}

startTalk()
{
    gTalk = TRUE;
    gTalkSeen = unix();
    gHolder = NULL_KEY;
    llMessageLinked(LINK_THIS, MSG_TALK, "1", NULL_KEY);
    llSay(0, "A talk is starting at this globe. Until it ends, its presenters change what it shows.");
}

endTalk(string why)
{
    if (!gTalk) return;
    gTalk = FALSE;
    gHolder = NULL_KEY;
    // Timed from now, so the idle return doesn't follow the moment a talk
    // ends: whoever stayed for it hasn't left.
    gLastSeen = unix();
    llMessageLinked(LINK_THIS, MSG_TALK, "0", NULL_KEY);
    llSay(0, "The talk at this globe has ended" + why + ". Anyone can use the globe again: right-click it and choose Touch.");
}

// Every few seconds: who is at the globe, whether a hold or a talk has
// run out, and whether the globe has stood empty long enough to go back
// to the live Earth.
check()
{
    vector here = llGetPos();
    list agents = llGetAgentList(AGENT_LIST_REGION, []);
    integer n = llGetListLength(agents);
    integer near = 0;
    integer presenterNear = FALSE;
    integer holderNear = FALSE;
    integer i;
    for (i = 0; i < n; ++i)
    {
        key a = llList2Key(agents, i);
        list d = llGetObjectDetails(a, [OBJECT_POS]);
        if (d != [] && llVecDist(llList2Vector(d, 0), here) <= gRadius)
        {
            ++near;
            if (a == gHolder) holderNear = TRUE;
            if (gTalk && !presenterNear && isPresenter(a)) presenterNear = TRUE;
        }
    }
    gNear = near;
    integer t = unix();
    if (near > 0) { gLastSeen = t; gIdleSent = FALSE; }
    // A hold ends when it runs out, or when its holder walks away from it.
    if (gHolder != NULL_KEY && (t >= gHoldUntil || !holderNear)) gHolder = NULL_KEY;
    if (gTalk)
    {
        if (presenterNear) gTalkSeen = t;
        else if (t - gTalkSeen >= gTalkS) endTalk(", since no presenter has been here for a while");
    }
    else if (near == 0 && gDataset != "" && !gIdleSent && t - gLastSeen >= gIdleS)
    {
        gIdleSent = TRUE;
        gHolder = NULL_KEY;
        llMessageLinked(LINK_THIS, MSG_CONTROL, "earth", NULL_KEY);
    }
}

// A setting from the "settings" notecard, kept only within its range.
setting(string line)
{
    integer eq = llSubStringIndex(line, "=");
    if (eq < 1) return;
    string name = llToLower(llStringTrim(llGetSubString(line, 0, eq - 1), STRING_TRIM));
    float v = (float)llStringTrim(llGetSubString(line, eq + 1, -1), STRING_TRIM);
    if (name == "radius" && v >= 2.0 && v <= 96.0) gRadius = v;
    else if (name == "idle minutes" && v >= 1.0 && v <= 1440.0) gIdleS = (integer)(v * 60.0);
    else if (name == "hold seconds" && v >= 10.0 && v <= 3600.0) gHoldS = (integer)v;
    else if (name == "talk minutes" && v >= 1.0 && v <= 120.0) gTalkS = (integer)(v * 60.0);
    else llOwnerSay("[exhibit] The settings notecard's line \"" + line + "\" isn't a setting this script "
        + "knows, or is out of its range. It is ignored.");
}

// The next notecard, or the end of reading them all.
nextCard()
{
    while (gCard < llGetListLength(gCards))
    {
        string name = llList2String(gCards, gCard);
        if (llGetInventoryType(name) == INVENTORY_NOTECARD)
        {
            gLine = 0;
            gCardReq = llGetNotecardLine(name, gLine);
            return;
        }
        ++gCard;
    }
    gCardReq = NULL_KEY;
    gPresenters = gNewPresenters;
    gMenu = gNewMenu;
    if (gMenu == []) gMenu = DEFAULT_MENU;
    llOwnerSay("[exhibit] " + summary());
}

readCards()
{
    gCard = 0;
    gNewPresenters = [];
    gNewMenu = [];
    gRadius = 15.0; gIdleS = 300; gHoldS = 60; gTalkS = 120;
    nextCard();
}

string summary()
{
    string menu = (string)(llGetListLength(gMenu) / 2) + " datasets in the menu";
    if (llGetInventoryType("datasets") != INVENTORY_NOTECARD) menu += " (the built-in five: no \"datasets\" notecard)";
    return (string)llGetListLength(gPresenters) + " presenters, " + menu + ". At the globe means within "
        + (string)((integer)gRadius) + " m. The live Earth returns " + (string)(gIdleS / 60) + " min after the last "
        + "visitor leaves. A hold lasts " + (string)gHoldS + " s, and a talk ends after " + (string)(gTalkS / 60)
        + " min with no presenter here.";
}

default
{
    state_entry()
    {
        gDlg = -1 - (integer)llFrand(1000000000.0);
        llListen(gDlg, "", NULL_KEY, "");
        llListen(CHAN, "", llGetOwner(), "");
        gLastSeen = unix();
        gMenu = DEFAULT_MENU;   // until the notecards have been read
        readCards();
        llSetTimerEvent(TICK);
        llMessageLinked(LINK_THIS, MSG_HELLO, "", NULL_KEY);
        llMessageLinked(LINK_THIS, MSG_TALK, "0", NULL_KEY);
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
        if (c & CHANGED_INVENTORY) readCards();
    }

    touch_start(integer n)
    {
        integer i;
        for (i = 0; i < n; ++i) mainMenu(llDetectedKey(i));
    }

    timer()
    {
        check();
        // Menus nobody answered.
        integer t = unix();
        while (gCtx != [] && t - llList2Integer(gCtx, 3) > CTX_TTL) gCtx = llDeleteSubList(gCtx, 0, 3);
    }

    dataserver(key q, string data)
    {
        if (q != gCardReq) return;
        if (data == EOF) { ++gCard; nextCard(); return; }
        string card = llList2String(gCards, gCard);
        string line = llStringTrim(data, STRING_TRIM);
        if (line != "" && llGetSubString(line, 0, 0) != "#")
        {
            if (card == "settings") setting(line);
            else if (card == "presenters") gNewPresenters += [username(line)];
            else
            {
                integer eq = llSubStringIndex(line, "=");
                string name = llStringTrim(llGetSubString(line, 0, eq - 1), STRING_TRIM);
                string id = llStringTrim(llGetSubString(line, eq + 1, -1), STRING_TRIM);
                if (eq > 0 && name != "" && id != "" && llSubStringIndex(id, " ") == -1)
                    gNewMenu += [name, id];
                else
                    llOwnerSay("[exhibit] The datasets notecard's line \"" + line + "\" isn't \"Name = dataset id\". "
                        + "It is left out of the menu.");
            }
        }
        ++gLine;
        gCardReq = llGetNotecardLine(card, gLine);
    }

    link_message(integer sender, integer n, string str, key id)
    {
        if (n == MSG_HELLO)
        {
            // A script reset: the info script needs to know about a talk.
            llMessageLinked(LINK_THIS, MSG_TALK, llList2String(["0", "1"], gTalk), NULL_KEY);
            return;
        }
        if (n != MSG_STATE) return;
        string dataset = llJsonGetValue(str, ["dataset"]);
        if (dataset == JSON_INVALID) return;
        gDataset = dataset;
        gTitle = llJsonGetValue(str, ["title"]);
        gPaused = (integer)llJsonGetValue(str, ["paused"]);
    }

    listen(integer ch, string name, key who, string msg)
    {
        if (ch == CHAN)
        {
            list w = llParseString2List(llToLower(llStringTrim(msg, STRING_TRIM)), [" "], []);
            string cmd = llList2String(w, 0);
            if (cmd == "presenters") llOwnerSay("[exhibit] " + summary());
            else if (cmd == "memory")
                llOwnerSay("[exhibit] Visitors script: " + (string)(llGetUsedMemory() / 1024) + " KB used of 64.");
            else if (cmd == "talk")
            {
                string what = llList2String(w, 1);
                if (what == "end") endTalk(" at the owner's request");
                else if (what == "start" && !gTalk) startTalk();
                else if (gTalk) llOwnerSay("[exhibit] A talk is in progress. /" + (string)CHAN + " talk end ends it.");
                else llOwnerSay("[exhibit] No talk. " + (string)gNear + " avatars at the globe.");
            }
            return;
        }

        integer at = llListFindList(gCtx, [who]);
        if (at == -1 || at % 4 != 0) return;   // no menu of theirs is open
        string kind = llList2String(gCtx, at + 1);
        integer page = llList2Integer(gCtx, at + 2);
        gCtx = llDeleteSubList(gCtx, at, at + 3);

        if (msg == BTN_CLOSE) return;
        if (msg == BTN_ABOUT) { llMessageLinked(LINK_THIS, MSG_ABOUT, "", who); return; }
        if (msg == BTN_MENU) { mainMenu(who); return; }
        if (kind == "main" && msg == BTN_START_TALK && isPresenter(who)) { if (!gTalk) startTalk(); return; }
        if (kind == "main" && msg == BTN_END_TALK && isPresenter(who)) { endTalk(""); return; }

        // Everything below changes the globe, so the menu's offer is
        // checked again: a hold or a talk may have started since it opened.
        if (!mayAct(who)) { llRegionSayTo(who, 0, whyNot()); return; }

        if (kind == "jump")
        {
            ask(who, "jump " + llStringTrim(msg, STRING_TRIM));
            return;
        }
        if (kind == "datasets")
        {
            if (msg == BTN_PREV) { datasetsMenu(who, page - 1); return; }
            if (msg == BTN_NEXT) { datasetsMenu(who, page + 1); return; }
            integer count = llGetListLength(gMenu) / 2;
            integer i;
            for (i = page * PAGE; i < count && i < (page + 1) * PAGE; ++i)
            {
                if (label(llList2String(gMenu, i * 2)) == msg)
                {
                    ask(who, "show " + llList2String(gMenu, i * 2 + 1) + " " + llList2String(gMenu, i * 2));
                    return;
                }
            }
            return;
        }
        if (msg == BTN_DATASETS) { datasetsMenu(who, 0); return; }
        if (msg == BTN_PAUSE) { ask(who, "pause"); return; }
        if (msg == BTN_PLAY) { ask(who, "play"); return; }
        if (msg == BTN_BACK) { ask(who, "nudge -" + (string)((integer)NUDGE)); return; }
        if (msg == BTN_FWD) { ask(who, "nudge " + (string)((integer)NUDGE)); return; }
        if (msg == BTN_RESTART) { ask(who, "restart"); return; }
        if (msg == BTN_EARTH) { ask(who, "earth"); return; }
        if (msg == BTN_JUMP && isPresenter(who))
        {
            remember(who, "jump", 0);
            llTextBox(who, "Jump to where in the clip? Seconds, like 90, or minutes and seconds, like 1:30.", gDlg);
        }
    }
}
