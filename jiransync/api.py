"""JiranSync HTTP API: residents, tasks, credits, tenants and SDP community events.

Every action names its ``actor`` -- the resident doing it. There is no real login in the
prototype: the web app's "Login as" picker stands in for SDP's resident verification,
which in production would check the property roll and issue a session.

Rule violations (insufficient credits, accepting your own task, joining a full event) come back as ``400 {"error": "..."}`` with a message written for the
resident, not the developer.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import agent, credits, spatial_demo, valuation
from .grid import COMPLETED, LIVE, GridError

router = APIRouter(prefix="/api")


def _engine(request: Request):
    return request.app.state.engine


def _grid(request: Request):
    grid = _engine(request).grid
    if grid is None:
        raise GridError("the township is still loading")
    return grid


async def _changed(request: Request) -> None:
    """Push a fresh frame after any action, so every open map updates at once."""
    await _engine(request).push()


def _fail(err: Exception) -> JSONResponse:
    return JSONResponse({"error": str(err)}, status_code=400)


# ------------------------------------------------------------------- models

class Actor(BaseModel):
    actor: str


class DraftIn(Actor):
    text: str = Field(min_length=3, max_length=2000)
    # Asking one neighbour directly; with start_at, booking them for a later slot.
    invitee: str | None = None
    start_at: float | None = None
    # A ride to any place on the map: {lon, lat, name}.
    dest: dict | None = None
    # Picked on the draft: when (demo-clock seconds) or as soon as possible, and how long.
    when_at: float | None = None
    asap: bool = False
    minutes: int | None = Field(default=None, ge=10, le=480)


class ToggleIn(BaseModel):
    on: bool


class ClockIn(BaseModel):
    day: int = Field(ge=0, le=6)          # 0 = Monday
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class PostIn(Actor):
    understanding: dict
    credits: int | None = None
    description: str = ""


class ChooseIn(Actor):
    helper: str


class RedeemIn(Actor):
    credits: int = Field(gt=0, le=valuation.MAX_CREDITS * 5)


class EventIn(BaseModel):
    title: str = Field(min_length=3, max_length=80)
    description: str = Field(default="", max_length=600)
    place_name: str = Field(default="", max_length=120)
    lon: float
    lat: float
    # Demo-clock seconds; None is a one-off job open right away.
    start_at: float | None = None
    duration_min: int = 60
    slots: int = 1
    credits: int


# ---------------------------------------------------------------- residents

def _helping(grid) -> dict[str, dict]:
    """Each resident's record as a helper: jobs completed, credits earned, and for what."""
    out: dict[str, dict] = {}
    for t in grid.store.tasks([COMPLETED]):
        if not t["provider"] or t["kind"] == "bundle":
            continue
        h = out.setdefault(t["provider"], {"jobs": 0, "credits": 0, "helped": set(), "for": {}})
        h["jobs"] += 1
        h["credits"] += t["credits"]
        h["helped"].add(t["requester"])
        # Seeded history is titled "Past favour"; the skill says what the favour was.
        what = "rides" if t["kind"] == "ride" else (t["skills"] or [t["kind"]])[0]
        h["for"][what] = h["for"].get(what, 0) + 1
    return {rid: {"jobs": h["jobs"], "credits": h["credits"], "neighbours": len(h["helped"]),
                  "for": sorted(h["for"].items(), key=lambda kv: -kv[1])}
            for rid, h in out.items()}


NO_HELP = {"jobs": 0, "credits": 0, "neighbours": 0, "for": []}


def _resident_view(grid, r: dict, helping: dict | None = None) -> dict:
    if helping is None:
        helping = _helping(grid)
    return {
        "id": r["id"], "name": r["name"], "unit": r["unit"], "home_building": r["home_building"],
        "lon": r["lon"], "lat": r["lat"], "verified": r["verified"], "skills": r["skills"],
        "availability": r["availability"], "has_car": r["has_car"], "commute": r["commute"],
        "commute_name": (grid.hub(r["commute"]) or {}).get("name"),
        "occupation": r.get("occupation"), "strengths": r.get("strengths") or [],
        "weaknesses": r.get("weaknesses") or [], "experience": helping.get(r["id"], NO_HELP),
        "reliability": r["reliability"], "strikes": r["strikes"], "suspended": r["suspended"],
        "flagged": r["flagged"], "balance": credits.balance(grid.store, r["id"]),
    }


@router.get("/residents")
async def residents(request: Request):
    grid = _grid(request)
    helping = _helping(grid)
    return [_resident_view(grid, r, helping) for r in grid.store.residents()]


@router.get("/me")
async def me(request: Request, resident: str):
    grid = _grid(request)
    r = grid.store.resident(resident)
    if r is None:
        return JSONResponse({"error": f"unknown resident {resident}"}, status_code=404)
    offered = {o["task_id"] for o in grid.store.offers_by(resident) if o["status"] != "withdrawn"}
    mine = [grid.task_view(t) for t in grid.store.tasks()
            if t["kind"] != "bundle" and (resident in (t["requester"], t["provider"], t["invitee"])
                                          or t["id"] in offered)]
    in_escrow = sum(credits.balance(grid.store, credits.escrow_account(t["id"]))
                    for t in grid.store.tasks(LIVE) if t["requester"] == resident)
    return {
        **_resident_view(grid, r),
        "escrow": in_escrow,
        "committed": grid._requester_balance_committed(resident),
        "ledger": _ledger_view(grid, resident),
        "tasks": mine[:30],
    }


def _ledger_view(grid, account: str, limit: int = 25) -> list[dict]:
    rows = []
    for e in grid.store.entries(account, limit=limit):
        incoming = e["credit"] == account
        other = e["debit"] if incoming else e["credit"]
        rows.append({"id": e["id"], "t": e["t"], "kind": e["kind"],
                     "amount": e["amount"] if incoming else -e["amount"],
                     "counterparty": other, "task_id": e["task_id"], "memo": e["memo"]})
    return rows


@router.get("/credits/{resident}")
async def credit_history(request: Request, resident: str):
    grid = _grid(request)
    return {"balance": credits.balance(grid.store, resident),
            "ledger": _ledger_view(grid, resident, 100)}


@router.get("/economy")
async def economy(request: Request):
    """The books, in one place: issued, in circulation, returned, and that they balance."""
    grid = _grid(request)
    balances = grid.store.all_balances()
    return {
        "issued": -balances.get(credits.MINT, 0),
        "returned_to_sdp": balances.get(credits.TREASURY, 0),
        "circulating": credits.circulating(grid.store),
        "in_escrow": sum(v for k, v in balances.items() if k.startswith("escrow:")),
        "held_by_tenants": sum(v for k, v in balances.items() if k.startswith("tenant:")),
        "paid_for_events": int(grid.store.execute(
            "SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE kind = 'event'").fetchone()["n"]),
        "ledger_sums_to_zero": sum(balances.values()) == 0,
        "rm_per_credit": credits.RM_PER_CREDIT,
        "seed_grant": credits.SEED_GRANT,
    }


# -------------------------------------------------------------------- tasks

@router.get("/agent")
async def agent_status():
    on = agent.claude_available()
    return {"engine": "claude" if on else "rules", "model": agent.MODEL if on else None,
            "skills": list(agent.SKILLS)}


@router.post("/tasks/draft")
async def draft(request: Request, body: DraftIn):
    grid = _grid(request)
    try:
        # The Claude call blocks on the network; keep it off the event loop.
        return await asyncio.to_thread(grid.draft, body.actor, body.text,
                                       invitee=body.invitee, start_at=body.start_at,
                                       dest=body.dest, when_at=body.when_at, asap=body.asap,
                                       minutes=body.minutes)
    except (GridError, ValueError) as err:
        return _fail(err)


@router.post("/demo/auto-accept")
async def auto_accept(request: Request, body: ToggleIn):
    """Demo control: the best match accepts new requests automatically."""
    grid = _grid(request)
    grid.auto_accept = body.on
    if body.on:
        grid.resume_auto_accept()
    else:
        grid._auto_due.clear()
    await _changed(request)
    return {"auto_accept": grid.auto_accept}


@router.post("/clock")
async def set_clock(request: Request, body: ClockIn):
    """Demo control: set the township clock to a day and time."""
    grid = _grid(request)
    hours, minutes = (int(x) for x in body.time.split(":"))
    return await _act(request, grid.set_clock, body.day, hours * 60 + minutes)


@router.post("/tasks")
async def post_task(request: Request, body: PostIn):
    grid = _grid(request)
    try:
        created = grid.post(body.actor, understanding=body.understanding,
                            credits_offered=body.credits, description=body.description)
    except (GridError, KeyError, ValueError) as err:
        return _fail(err)
    await _changed(request)
    return {"created": created}


@router.get("/tasks")
async def list_tasks(request: Request, status: str | None = None, kind: str | None = None):
    grid = _grid(request)
    statuses = status.split(",") if status else None
    return [grid.task_view(t) for t in grid.store.tasks(statuses, kind=kind)
            if t["kind"] != "bundle"]


@router.get("/tasks/{task_id}")
async def get_task(request: Request, task_id: str):
    grid = _grid(request)
    task = grid.store.task(task_id)
    if task is None:
        return JSONResponse({"error": f"unknown task {task_id}"}, status_code=404)
    view = grid.task_view(task)
    if task["status"] == "open" and task["kind"] != "bundle":
        cands = grid._rank(task)
        view["candidates"] = [c.to_dict() for c in cands]
        view["fallback"] = grid._fallback(task, cands)
    if grid.uses_offers(task):
        view["offer_cards"] = grid.offer_cards(task)
    if task.get("parent_id"):
        view["siblings"] = [grid.task_view(t) for t in grid.store.tasks(parent_id=task["parent_id"])]
    view["escrow"] = credits.balance(grid.store, credits.escrow_account(task_id))
    return view


async def _act(request: Request, fn, *args, **kwargs):
    try:
        result = fn(*args, **kwargs)
    except GridError as err:
        return _fail(err)
    await _changed(request)
    return result


@router.post("/tasks/{task_id}/accept")
async def accept(request: Request, task_id: str, body: Actor):
    grid = _grid(request)
    return await _act(request, lambda: grid.task_view(grid.accept(task_id, body.actor)))


@router.post("/tasks/{task_id}/offer")
async def offer(request: Request, task_id: str, body: Actor):
    """A neighbour offers to help; the requester chooses among the offers."""
    grid = _grid(request)
    return await _act(request, lambda: grid.task_view(grid.offer(task_id, body.actor)))


@router.post("/tasks/{task_id}/withdraw")
async def withdraw(request: Request, task_id: str, body: Actor):
    grid = _grid(request)
    return await _act(request, lambda: grid.task_view(grid.withdraw(task_id, body.actor)))


@router.post("/tasks/{task_id}/choose")
async def choose(request: Request, task_id: str, body: ChooseIn):
    """The requester picks who helps; their credits are held from now."""
    grid = _grid(request)
    return await _act(request, lambda: grid.task_view(grid.choose(task_id, body.actor, body.helper)))


@router.post("/tasks/{task_id}/complete")
async def complete(request: Request, task_id: str, body: Actor):
    grid = _grid(request)
    return await _act(request, lambda: grid.task_view(grid.complete(task_id, body.actor)))


@router.post("/tasks/{task_id}/cancel")
async def cancel(request: Request, task_id: str, body: Actor):
    grid = _grid(request)
    return await _act(request, lambda: grid.task_view(grid.cancel(task_id, body.actor)))


@router.post("/tasks/{task_id}/ghost")
async def ghost(request: Request, task_id: str):
    """Demo control: make the provider a no-show, to show the escrow refund and strike."""
    grid = _grid(request)
    return await _act(request, grid.ghost, task_id)


# ------------------------------------------------------------------ tenants

@router.get("/tenants")
async def tenants(request: Request):
    grid = _grid(request)
    out = []
    for t in grid.store.tenants():
        held = credits.balance(grid.store, credits.tenant_account(t["id"]))
        out.append({**t, "held_credits": held, "rm_per_credit": credits.RM_PER_CREDIT})
    return out


@router.post("/tenants/{tenant_id}/redeem")
async def redeem(request: Request, tenant_id: str, body: RedeemIn):
    grid = _grid(request)
    return await _act(request, grid.redeem, body.actor, tenant_id, body.credits)


@router.post("/tenants/{tenant_id}/cashout")
async def cash_out(request: Request, tenant_id: str):
    """A shop cashes its collected credits out with SDP, RM2 each."""
    grid = _grid(request)
    return await _act(request, grid.cash_out, tenant_id)


# ------------------------------------------------------- SDP community events

@router.get("/community-events")
async def community_events(request: Request):
    grid = _grid(request)
    return [grid.event_view(e) for e in grid.store.community_events()]


@router.post("/community-events")
async def create_event(request: Request, body: EventIn):
    """SDP property management hosts a community event, or posts a one-off civic job."""
    grid = _grid(request)
    return await _act(request, lambda: grid.event_view(grid.create_event(
        title=body.title, place_name=body.place_name, lon=body.lon, lat=body.lat,
        start_at=body.start_at, duration_min=body.duration_min, slots=body.slots,
        credits_each=body.credits, description=body.description)))


@router.post("/community-events/{event_id}/join")
async def join_event(request: Request, event_id: str, body: Actor):
    grid = _grid(request)
    return await _act(request, lambda: grid.event_view(grid.join_event(event_id, body.actor)))


@router.post("/community-events/{event_id}/leave")
async def leave_event(request: Request, event_id: str, body: Actor):
    grid = _grid(request)
    return await _act(request, lambda: grid.event_view(grid.leave_event(event_id, body.actor)))


@router.post("/community-events/{event_id}/start")
async def start_event(request: Request, event_id: str):
    """SDP opens the event now; volunteers set off for the venue."""
    grid = _grid(request)
    return await _act(request, lambda: grid.event_view(grid.start_event(event_id)))


@router.post("/community-events/{event_id}/end")
async def end_event(request: Request, event_id: str):
    """SDP closes the event; everyone GPS checked in is paid."""
    grid = _grid(request)
    return await _act(request, lambda: grid.event_view(grid.end_event(event_id)))


@router.post("/community-events/{event_id}/cancel")
async def cancel_event(request: Request, event_id: str):
    grid = _grid(request)
    return await _act(request, lambda: grid.event_view(grid.cancel_event(event_id)))


@router.post("/admin/reset")
async def reset(request: Request):
    """Reseed the demo community from scratch."""
    await _engine(request).reseed()
    return {"ok": True}


# ------------------------------------------------------------- spatial demos

_spatial_cache: dict = {}


@router.get("/demo/spatial")
async def spatial(request: Request):
    """The two spatial-matching demo scenarios. Built once from the township and roads;
    each is its own demo state and changes nothing in the live community."""
    grid = _grid(request)
    if "data" not in _spatial_cache:
        _spatial_cache["data"] = await asyncio.to_thread(spatial_demo.build, grid)
    return _spatial_cache["data"]
