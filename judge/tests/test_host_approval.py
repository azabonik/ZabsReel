"""The approval of network computers: only the user allows one, in the editor's window, and the answer is kept as
given. Port of the media-server approval gate in apps/desktop/scripts/smoke-savename.ts (the dialogs' flows: Allow,
Keep, Remove, and that a path never allows its computer by itself); the dialogs' wording stays with the UI overhaul
(judge/PORTING.md).

Computers are under the reserved .invalid domain, so nothing can reach them. The project's media is moved onto one by
text substitution in a project the editor saved (observe.substitute), so the test needs no knowledge of the file
format. approve_host / revoke_host are the window's own actions (PROTOCOL.md); add_host_outside is an edit of the
editor's files that the window did not make.

Every check is recorded on every path, so CHECKS is exact.
"""
import os

import driver as drv
import observe

PORT_BOUND = True
TIMEOUT = 600
CHECKS = 14

PICK = "zr-pick.invalid"
ASK = "zr-ask.invalid"
KEEP = "zr-keep.invalid"
REMOVE = "zr-remove.invalid"


def refused(fn):
    """(refused?, what happened): refused = the editor answered with an error (product_error or bad_request)."""
    try:
        r = fn()
        return False, f"accepted: {str(r)[:200]}"
    except (drv.ProductError, drv.BadRequest) as e:
        return True, f"refused: {e.message[:200]}"


def asset_of(d, path):
    return next((a for a in d.get_state().get("assets", []) if a.get("path") == path), None)


def run(t):
    d = t.driver()
    d.set_project(width=640, height=360, fps=30)
    a = t.media("a.mp4")
    asset = d.import_media(a)
    d.place_clip(asset, "v0", 0, 0, 60)
    legit = t.path("projects", "legit.aive")
    d.save_project(legit)

    # A path on a computer nobody allowed, given by the agent: refused, and the computer only waits for the user.
    ok, what = refused(lambda: d.import_media(f"//{ASK}/s/x.mp4", raw=True))
    t.check(f"importing //{ASK}/s/x.mp4 is refused", ok, what)
    h = d.list_hosts()
    t.check(f"…and {ASK} waits for the user (pending), not allowed", ASK in h["pending"] and ASK not in h["approved"], h)

    # A project whose media is on \\zr-pick.invalid: it loads, and the media waits for that computer.
    net_path = f"//{PICK}/s/a.mp4"
    crafted = t.path("projects", "pick.aive")
    n = observe.substitute(legit, crafted, [(a, net_path)])[0]
    loaded = False
    if n:
        try:
            d.load_project(crafted)
            loaded = True
        except drv.ProductError as e:
            what = str(e)
    x = asset_of(d, net_path) if loaded else None
    t.check(f"a project with its media on \\\\{PICK} loads, the media waiting for {PICK}",
            n > 0 and loaded and x is not None and x.get("offline") is True and x.get("waiting_host") == PICK,
            f"{n} substitution(s); {x if loaded else what}")

    # Allow, in upper case: kept as the lower-case name, and the media is no longer waiting after a re-check.
    d.approve_host(PICK.upper())
    h = d.list_hosts()
    t.check(f"allowing {PICK.upper()} keeps it as {PICK}", PICK in h["approved"]
            and not any(x != x.lower() for x in h["approved"]), h)
    d.recheck_media()
    x = asset_of(d, net_path)
    t.check("after a re-check its media no longer waits", x is not None and not x.get("waiting_host"), x)
    d.approve_host(PICK)
    h = d.list_hosts()
    t.check("allowing it again keeps one entry", h["approved"].count(PICK) == 1, h)

    # A name that cannot be a network computer: refused, nothing stored.
    before = d.list_hosts()
    ok, what = refused(lambda: d.approve_host("nas@SSL"))
    after = d.list_hosts()
    t.check("allowing 'nas@SSL' (not a computer name) is refused and stores nothing",
            ok and sorted(after["approved"]) == sorted(before["approved"]), f"{what}; {after}")

    # Revoke: no longer allowed, and the media waits again after a re-check.
    d.revoke_host(PICK)
    h = d.list_hosts()
    t.check(f"after a revoke {PICK} is not allowed", PICK not in h["approved"], h)
    d.recheck_media()
    x = asset_of(d, net_path)
    t.check("…and after a re-check its media waits again", x is not None and x.get("waiting_host") == PICK, x)

    # An entry added outside the window: listed as outside, not allowed, until the user keeps it.
    d.add_host_outside(KEEP)
    d.recheck_media()
    h = d.list_hosts()
    t.check(f"an entry for {KEEP} written outside the window is listed as outside, not allowed",
            KEEP in h["outside"] and KEEP not in h["approved"], h)
    d.approve_host(KEEP)
    d.recheck_media()
    h = d.list_hosts()
    t.check(f"keeping {KEEP} in the window allows it (no longer outside)",
            KEEP in h["approved"] and KEEP not in h["outside"], h)
    removed = d.revoke_host(KEEP, only_if_outside=True)
    h = d.list_hosts()
    t.check("the Remove of a Keep question removes nothing once the computer was kept",
            removed is False and KEEP in h["approved"], f"removed {removed}; {h}")
    d.add_host_outside(REMOVE)
    d.recheck_media()
    removed = d.revoke_host(REMOVE, only_if_outside=True)
    d.recheck_media()
    h = d.list_hosts()
    t.check(f"the Remove of a Keep question removes an entry still outside ({REMOVE})",
            removed is True and REMOVE not in h["outside"] and REMOVE not in h["approved"], f"removed {removed}; {h}")

    # Opening the computer's paths again never allows it.
    refused(lambda: d.load_project(crafted))
    refused(lambda: d.import_media(f"//{ASK}/s/y.mp4", raw=True))
    h = d.list_hosts()
    t.check(f"opening {PICK}'s project and {ASK}'s paths again allows neither",
            PICK not in h["approved"] and ASK not in h["approved"], h)
