// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz in-world probe - the shared-media half of the kit.
// Results and what they mean: docs/SECOND_LIFE_COMPAT.md, sections 3-5.
// How to run it: scripts/second-life-probe/README.md.
//
// terraviz-probe.lsl is generated from probe.template.lsl and probe.html
// by `npx tsx scripts/second-life-probe`. Edit those two, never the
// generated file: a test fails when it drifts from them.
//
// Drop this into a sphere you own, in a region where scripts run. It
// serves its own test page onto the sphere through shared media. The
// page checks WebGL, video codecs and HLS playback, and reports back to
// you in local chat. Its companion, node-check.lsl, asks the TerraViz
// node for data and reports what that costs a script; put both in the
// same prim, or either one alone.
//
// Commands, said on channel 7 (owner only):
//   /7 probe    the test page and a labelled grid (the default)
//   /7 image    a real TerraViz dataset frame (Nighttime Lights)
//   /7 video    a real TerraViz video (Hurricane Season 2024), if it can play
//   /7 app      the actual TerraViz web app
//   /7 sos      TerraViz's LED-sphere output page: a live, correctly wrapped Earth
//   /7 soak     keep WebGL drawing and report every 10 s until it stops
//   /7 soak2d   the same animation without WebGL - the comparison for soak
//   /7 globe    stand the sphere's poles upright and rotate its texture 90
//               degrees. A default prim sphere has its poles on its local
//               X axis and its texture wrapped pole-to-pole, so a world map
//               lands sideways (indra/llmath/llvolume.cpp: the half-circle
//               profile ends on X, the path revolves about X, and texture
//               U follows the profile). Confirmed in-world, October 2026.
//   /7 turn     rotate the texture another 90 degrees
//   /7 mirror   flip the texture left-to-right
//   /7 reset    back to the default rotation and texture mapping
//   /7 face N   move the media to face N (a sphere only has face 0)
//
// The page renders as a web page only for the object's owner, in their
// own viewer, in the same region (llSetContentType) - a test kit, not an
// exhibit. The app and the output page come from TerraViz's own site and
// have no such limit.

integer CHAN = 7;
string  NODE = "https://terraviz.zyra-project.org";

// Shared media is capped at 2048 pixels a side (indra/llprimitive/
// llmediaentry.h); a script asking for more gets a bounds error, not a
// smaller size. 2:1, because everything shown here is a world map.
integer MEDIA_W = 2048;
integer MEDIA_H = 1024;

integer gFace = 0;
string  gBase;          // this script's own web address
key     gUrlReq;
integer gLoads;         // makes every address unique, so every command reloads
integer gAwaitFrames;   // waiting for the page's WebGL frame report
integer gSoaking;       // a soak page is sending 10-second heartbeats
string  gSoakLast;      // the most recent heartbeat, reported if they stop
integer gTexRot;        // texture rotation in degrees: 0, 90, 180 or 270
integer gMirror;        // texture flipped left-to-right

string HELP = "Commands on /7: probe, image, video, app, sos, soak, soak2d, globe, turn, mirror, reset, face N";

string page()
{
    string s = "";
//@@PAGE@@
    return s;
}

// The viewer does not reload media whose address has not changed, so a
// repeated command would otherwise silently do nothing. Every address
// gets a counter; the pages read only their own parameters and ignore it.
string fresh(string url)
{
    ++gLoads;
    if (llSubStringIndex(url, "?") == -1) return url + "?n=" + (string)gLoads;
    return url + "&n=" + (string)gLoads;
}

setMedia(string url)
{
    integer r = llSetPrimMediaParams(gFace, [
        PRIM_MEDIA_CURRENT_URL, url,
        PRIM_MEDIA_HOME_URL, url,
        PRIM_MEDIA_AUTO_PLAY, TRUE,
        PRIM_MEDIA_AUTO_SCALE, FALSE,
        PRIM_MEDIA_WIDTH_PIXELS, MEDIA_W,
        PRIM_MEDIA_HEIGHT_PIXELS, MEDIA_H,
        PRIM_MEDIA_PERMS_INTERACT, PRIM_MEDIA_PERM_OWNER,
        PRIM_MEDIA_PERMS_CONTROL, PRIM_MEDIA_PERM_NONE]);
    if (r != STATUS_OK)
        llOwnerSay("[probe] Could not set media on face " + (string)gFace + " (status " + (string)r + ").");
    else
        llOwnerSay("[probe] Face " + (string)gFace + " now shows " + url);
}

applyTexture()
{
    llRotateTexture(gTexRot * DEG_TO_RAD, gFace);
    llScaleTexture(llList2Float([1.0, -1.0], gMirror), 1.0, gFace);
    llOwnerSay("[probe] Texture rotation " + (string)gTexRot + " degrees, "
        + llList2String(["not mirrored", "mirrored"], gMirror)
        + ". Prim rotation (degrees): " + (string)(llRot2Euler(llGetRot()) * RAD_TO_DEG));
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        llOwnerSay("[probe] Starting. " + HELP);
        gUrlReq = llRequestSecureURL();
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        // Region restarts and crossings take the script's web address away.
        if (c & (CHANGED_OWNER | CHANGED_REGION | CHANGED_REGION_START)) llResetScript();
    }

    listen(integer ch, string name, key id, string msg)
    {
        list w = llParseString2List(llToLower(llStringTrim(msg, STRING_TRIM)), [" "], []);
        string cmd = llList2String(w, 0);
        if (cmd == "api") return;   // node-check.lsl's command
        if (cmd == "globe")
        {
            // Rotating -90 degrees about Y carries local +X to world up.
            llSetRot(llEuler2Rot(<0.0, -PI_BY_TWO, 0.0>));
            gTexRot = 90;
            applyTexture();
            return;
        }
        if (cmd == "turn") { gTexRot = (gTexRot + 90) % 360; applyTexture(); return; }
        if (cmd == "mirror") { gMirror = !gMirror; applyTexture(); return; }
        if (cmd == "reset")
        {
            llSetRot(ZERO_ROTATION);
            gTexRot = 0;
            gMirror = FALSE;
            applyTexture();
            return;
        }
        if (cmd == "app") { setMedia(fresh(NODE + "/?embed=1")); return; }
        // `/output.html` falls through to the main app; this is the page.
        if (cmd == "sos") { setMedia(fresh(NODE + "/output/output")); return; }
        if (gBase == "") { llOwnerSay("[probe] Still waiting for a web address from the region."); return; }
        if (cmd == "probe") setMedia(fresh(gBase + "?probe"));
        else if (cmd == "image") setMedia(fresh(gBase + "?image"));
        else if (cmd == "video") setMedia(fresh(gBase + "?video"));
        else if (cmd == "soak") setMedia(fresh(gBase + "?soak"));
        else if (cmd == "soak2d") setMedia(fresh(gBase + "?soak2d"));
        else if (cmd == "face")
        {
            llClearPrimMedia(gFace);
            gFace = llList2Integer(w, 1);
            setMedia(fresh(gBase + "?probe"));
        }
        else llOwnerSay("[probe] " + HELP);
    }

    http_request(key id, string method, string body)
    {
        if (id == gUrlReq)
        {
            if (method == URL_REQUEST_DENIED)
            {
                llOwnerSay("[probe] The region would not give this script a web address: " + body);
                return;
            }
            gBase = body;
            setMedia(fresh(gBase + "?probe"));
            return;
        }
        if (method == "GET")
        {
            // Headers have to be read before responding.
            string path  = llGetHTTPHeader(id, "x-path-info");
            string mode  = llList2String(llParseString2List(llGetHTTPHeader(id, "x-query-string"), ["&"], []), 0);
            if (path != "" && path != "/") { llHTTPResponse(id, 404, ""); return; }   // favicon etc.
            llSetContentType(id, CONTENT_TYPE_HTML);
            llHTTPResponse(id, 200, page());
            // A fresh page load means a fresh run: say so, since the
            // viewer sometimes reloads media on its own.
            llOwnerSay("[probe] Page loaded (" + mode + ")");
            gSoaking = FALSE;
            gAwaitFrames = (mode == "probe");
            if (gAwaitFrames) llSetTimerEvent(45.0); else llSetTimerEvent(0.0);
            return;
        }
        if (method == "POST")
        {
            llHTTPResponse(id, 200, "ok");
            list lines = llParseString2List(body, ["~"], []);
            integer i;
            integer n = llGetListLength(lines);
            for (i = 0; i < n; ++i)
            {
                string line = llList2String(lines, i);
                if (llSubStringIndex(line, "webgl frames") == 0) gAwaitFrames = FALSE;
                if (llSubStringIndex(line, "soak ") == 0 && llSubStringIndex(line, "s, ") != -1)
                {
                    gSoaking = TRUE;
                    gSoakLast = line;
                    llSetTimerEvent(25.0);   // two missed heartbeats and change
                }
                llOwnerSay("[page] " + line);
            }
            return;
        }
        llHTTPResponse(id, 405, "");
    }

    timer()
    {
        llSetTimerEvent(0.0);
        if (gAwaitFrames)
            llOwnerSay("[probe] No WebGL frame report after 45 seconds. The page stopped responding or was unloaded.");
        if (gSoaking)
        {
            gSoaking = FALSE;
            llOwnerSay("[probe] Heartbeats stopped. Last one: " + gSoakLast);
        }
    }
}
