"""The social grid: task lifecycle and the township's live movement.

One object owns everything that changes: who has asked for what, who is on their way,
where every moving resident is, and when a job is done. The server calls it from the
event loop -- HTTP actions and the tick both -- so there is exactly one writer.

Lifecycle of a task::

    open --accept--> in_progress --GPS arrival--> arrived --confirm--> completed
      \\                  |                                    (rides complete on arrival)
       cancel         no-show: refund + strike, back to open

Credits move only through ``credits.py``: escrow is locked on accept, released on
completion, refunded on cancel or no-show.

Movement is simulated: residents walk or drive along the real street graph at real
speeds, run ``TIME_SCALE`` times faster than the wall clock so a carpool to the MRT
plays out in under a minute. The "GPS" checks read these simulated positions -- the
same checks a phone's location would feed in production.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import agent, credits, fallback, fraud, matching, valuation
from .geo import haversine_m
from .routing import RoadNetwork
from .store import Store
from .township import ROLE_SHOP, Township

# Simulated seconds per wall-clock second.
TIME_SCALE = 10.0
# The simulated clock starts on a Monday at 07:30, the morning commute.
START_HOUR = 7.5
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
# How far ahead a neighbour can be booked.
MAX_BOOKING_S = 7 * 24 * 3600
# Demo auto-accept: how long (simulated seconds) after a request is posted the best match
# takes it -- a few real seconds, long enough to see the request appear first.
AUTO_ACCEPT_S = 40.0

WALK_MPS = 1.35
DRIVE_MPS = 8.5

# "Arrived" means within this many metres of the destination, for both parties.
ARRIVAL_M = 30.0
# Bounty proof-of-work must be geo-tagged within this distance of the bounty.
PROOF_RADIUS_M = 60.0
# A provider whose position has not changed for this long is a no-show.
NO_SHOW_S = 300.0
# Help tasks auto-confirm after the job's own estimate on site, unless confirmed sooner.
AUTO_CONFIRM_FACTOR = 1.0

# Background life on the map: commuters and shoppers who are not part of any task.
AMBIENT_MAX = 6
AMBIENT_EVERY_S = 70.0

OPEN = "open"
RESERVED = "reserved"          # a booked neighbour has confirmed; starts at its slot
IN_PROGRESS = "in_progress"
ARRIVED = "arrived"
COMPLETED = "completed"
CANCELLED = "cancelled"
SPLIT = "split"
LIVE = (OPEN, RESERVED, IN_PROGRESS, ARRIVED)


class GridError(ValueError):
    """A request the rules do not allow. The message is safe to show the user."""


@dataclass
class Mover:
    id: str
    resident_id: str
    mode: str                     # "walk" or "drive"
    path: np.ndarray              # (n, 2) lon/lat
    xy: np.ndarray                # (n, 2) local metres
    speed: float
    task_id: str | None = None
    leg: str = "go"               # "go", "pickup", "ride", "ambient"
    passenger: str | None = None
    progress: float = 0.0
    frozen: bool = False
    still_since: float | None = None
    done: bool = False
    linger_until: float | None = None
    cum: np.ndarray = field(init=False)

    def __post_init__(self):
        seg = np.hypot(*np.diff(self.xy, axis=0).T) if len(self.xy) > 1 else np.zeros(0)
        self.cum = np.concatenate([[0.0], np.cumsum(seg)])

    @property
    def length(self) -> float:
        return float(self.cum[-1])

    def position(self) -> tuple[float, float]:
        if len(self.path) == 1 or self.progress <= 0:
            return float(self.path[0][0]), float(self.path[0][1])
        if self.progress >= self.length:
            return float(self.path[-1][0]), float(self.path[-1][1])
        i = int(np.searchsorted(self.cum, self.progress, side="right")) - 1
        i = min(max(i, 0), len(self.path) - 2)
        span = self.cum[i + 1] - self.cum[i]
        f = 0.0 if span <= 0 else (self.progress - self.cum[i]) / span
        a, b = self.path[i], self.path[i + 1]
        return float(a[0] + (b[0] - a[0]) * f), float(a[1] + (b[1] - a[1]) * f)

    def remaining(self) -> list[list[float]]:
        if self.progress >= self.length:
            return []
        i = int(np.searchsorted(self.cum, self.progress, side="right"))
        here = list(self.position())
        return [here] + [[round(float(p[0]), 7), round(float(p[1]), 7)] for p in self.path[i:]]


class SocialGrid:
    def __init__(self, township: Township, networks: dict[str, RoadNetwork], store: Store,
                 places: dict, *, seed: int = 42, auto_accept: bool = False):
        self.town = township
        # Demo mode: the best-ranked neighbour accepts each new request by themselves, so
        # a presenter does not have to switch accounts. Off by default; the server turns
        # it on (JIRANSYNC_AUTO_ACCEPT) and the clock menu toggles it.
        self.auto_accept = auto_accept
        self._auto_due: dict[str, float] = {}
        self.networks = networks
        self.store = store
        self.places = places
        self.rng = random.Random(seed)
        self.t = float(store.get_meta("clock", "0") or 0.0)
        # The demo clock is the simulation clock plus an offset the presenter can set, so
        # jumping to "Tuesday evening" never makes a moving car teleport or a helper look
        # like a no-show: the simulation itself only ever runs forward.
        self.clock_offset = float(store.get_meta("clock_offset", "0") or 0.0)
        self.movers: dict[str, Mover] = {}
        self._next_ambient = self.t + 5.0
        self._arrived_at: dict[str, float] = {}
        self.hubs = self._prepare_hubs(places.get("hubs", []))

    # ------------------------------------------------------------------ setup

    @classmethod
    def load_places(cls, data_dir: Path) -> dict:
        path = Path(data_dir) / "places.json"
        if not path.exists():
            return {"name": "Township", "hubs": [], "tenants": []}
        return json.loads(path.read_text(encoding="utf-8"))

    def _prepare_hubs(self, hubs: list[dict]) -> list[dict]:
        """Each off-map station gets a gateway: the routable road node nearest to it.

        Trips to the MRT drive to the gateway -- the point where the township's roads
        leave the map towards the station -- and the client draws the rest as an arc.
        """
        drive = self.networks.get("drive")
        out = []
        for hub in hubs:
            hx, hy = self.town.frame.to_xy(hub["lon"], hub["lat"])
            gateway = None
            if drive is not None and len(drive.node_xy):
                nodes = drive.routable if len(drive.routable) else np.arange(len(drive.node_xy))
                pts = drive.node_xy[nodes]
                best = int(np.argmin(np.hypot(pts[:, 0] - hx, pts[:, 1] - hy)))
                gx, gy = pts[best]
                glon, glat = self.town.frame.to_lonlat(gx, gy)
                gateway = [float(glon), float(glat)]
            distance_km = (float(haversine_m(*self.town.centre_lonlat(), hub["lon"], hub["lat"]))
                           * 1.3 / 1000.0)
            out.append({**hub, "gateway": gateway, "road_km": round(distance_km, 1)})
        return out

    def hub(self, hub_id: str | None) -> dict | None:
        return next((h for h in self.hubs if h["id"] == hub_id), None)

    def place_tenants(self) -> list[dict]:
        """Pin each tenant to the shop-lot nearest its anchor (any building if none)."""
        shops = self.town.by_role(ROLE_SHOP) or self.town.buildings
        placed = []
        used: set[str] = set()
        for tenant in self.places.get("tenants", []):
            ax, ay = self.town.frame.to_xy(*tenant["anchor"])
            ranked = sorted(shops, key=lambda b: float(np.hypot(b.centroid_xy[0] - ax,
                                                                 b.centroid_xy[1] - ay)))
            building = next((b for b in ranked if b.id not in used), ranked[0])
            used.add(building.id)
            lon, lat = self.town.frame.to_lonlat(*building.centroid_xy)
            placed.append({
                "id": tenant["id"], "name": tenant["name"], "category": tenant["category"],
                "building": building.id, "lon": float(lon), "lat": float(lat),
                "skills": tenant.get("skills", []), "offer": tenant.get("offer", ""),
                "lead_discount": float(tenant.get("lead_discount", 0.1)),
                "monthly_rent_rm": float(tenant["monthly_rent_rm"]),
            })
        return placed

    # ------------------------------------------------------------------ clock

    @property
    def now(self) -> float:
        """Demo-clock seconds since the start (Monday 07:30)."""
        return self.t + self.clock_offset

    @staticmethod
    def minute_of(demo_t: float) -> float:
        """Minutes since Monday 00:00 of the first week, for a demo-clock time."""
        return START_HOUR * 60 + demo_t / 60.0

    @staticmethod
    def demo_t_at(minute: float) -> float:
        return (minute - START_HOUR * 60) * 60.0

    def slot_at(self, demo_t: float) -> str | None:
        return matching.free_slot((self.minute_of(demo_t) % (24 * 60)) / 60.0)

    def clock(self) -> dict:
        minutes = self.minute_of(self.now)
        day = int(minutes // (24 * 60))
        hm = minutes % (24 * 60)
        return {"t": round(self.t, 1), "day": DAY_NAMES[day % 7], "day_index": day % 7,
                "time": f"{int(hm // 60):02d}:{int(hm % 60):02d}",
                "now": round(self.now, 1), "slot": matching.free_slot(hm / 60.0)}

    def set_clock(self, day: int, minute_of_day: int) -> dict:
        """Demo control: jump the clock to a day of this week and a time of day."""
        if not 0 <= day <= 6 or not 0 <= minute_of_day < 24 * 60:
            raise GridError("pick a day Mon-Sun and a time between 00:00 and 23:59")
        week = int(self.minute_of(self.now) // (7 * 24 * 60))
        target = self.demo_t_at(week * 7 * 24 * 60 + day * 24 * 60 + minute_of_day)
        # Earlier than the very first moment would be a negative clock; use next week.
        if target < 0:
            target += 7 * 24 * 3600
        self.clock_offset = target - self.t
        self.store.set_meta("clock_offset", f"{self.clock_offset:.1f}")
        c = self.clock()
        self.store.log(self.t, "clock", f"Demo clock set to {c['day']} {c['time']}")
        return c

    def free_now(self, resident: dict) -> bool:
        slot = self.slot_at(self.now)
        return slot is not None and slot in (resident.get("availability") or [])

    def when_label(self, demo_t: float) -> str:
        minutes = self.minute_of(demo_t)
        day = int(minutes // (24 * 60))
        today = int(self.minute_of(self.now) // (24 * 60))
        hm = minutes % (24 * 60)
        name = ("Today" if day == today else "Tomorrow" if day == today + 1
                else DAY_NAMES[day % 7])
        return f"{name} {int(hm // 60):02d}:{int(hm % 60):02d}"

    # ---------------------------------------------------------------- helpers

    def _resident(self, resident_id: str) -> dict:
        r = self.store.resident(resident_id)
        if r is None:
            raise GridError(f"unknown resident {resident_id}")
        return r

    def _task(self, task_id: str) -> dict:
        task = self.store.task(task_id)
        if task is None:
            raise GridError(f"unknown task {task_id}")
        return task

    def position_of(self, resident_id: str) -> tuple[float, float]:
        """Where a resident is now: moving, riding along, just arrived, or at home."""
        lingering = None
        for m in self.movers.values():
            mine = m.resident_id == resident_id or (m.passenger == resident_id and m.leg == "ride")
            if not mine:
                continue
            if not m.done:
                return m.position()
            lingering = m.position()
        if lingering is not None:
            return lingering
        r = self._resident(resident_id)
        return r["lon"], r["lat"]

    def _route_path(self, mode: str, a: tuple[float, float], b: tuple[float, float]):
        """A lon/lat polyline from a to b along the street graph (straight line if none)."""
        frame = self.town.frame
        a_xy = np.array(frame.to_xy(*a), dtype=float)
        b_xy = np.array(frame.to_xy(*b), dtype=float)
        route = self.networks[mode].route(a_xy, b_xy) if mode in self.networks else None
        xy = [a_xy] + (list(route.xy) if route is not None else []) + [b_xy]
        xy = np.array(xy, dtype=float)
        # Drop zero-length steps so interpolation never divides by zero.
        keep = [0] + [i for i in range(1, len(xy)) if np.hypot(*(xy[i] - xy[i - 1])) > 0.05]
        xy = xy[keep] if len(keep) > 1 else np.vstack([xy[0], xy[0] + 0.1])
        lon, lat = frame.to_lonlat(xy[:, 0], xy[:, 1])
        return np.column_stack([lon, lat]), xy

    def _spawn(self, mover_id: str, resident_id: str, mode: str, a, b, **kw) -> Mover:
        path, xy = self._route_path(mode, a, b)
        mover = Mover(mover_id, resident_id, mode, path, xy,
                      DRIVE_MPS if mode == "drive" else WALK_MPS, **kw)
        self.movers[mover_id] = mover
        return mover

    def _distance_km(self, task: dict) -> float:
        if task["kind"] != "ride":
            return 0.0
        hub = self.hub(task.get("dest_id"))
        if hub:
            return hub["road_km"]
        # A destination inside the township: the real drive from the pickup.
        drive = self.networks.get("drive")
        if drive is not None and task.get("dest_lon") is not None:
            route = drive.route(np.array(self.town.frame.to_xy(task["lon"], task["lat"])),
                                np.array(self.town.frame.to_xy(task["dest_lon"], task["dest_lat"])))
            if route is not None:
                return round(route.distance_m / 1000.0, 2)
        return 5.0

    def _requester_balance_committed(self, resident_id: str) -> int:
        """Credits a requester has promised on open, unfunded tasks."""
        return sum(int(t["credits"]) for t in self.store.tasks([OPEN])
                   if t["requester"] == resident_id and t["kind"] != "bounty")

    # ------------------------------------------------------------- drafting

    def draft(self, actor: str, text: str, *, invitee: str | None = None,
              start_at: float | None = None, dest: dict | None = None) -> dict:
        """Understand a request, price it and preview who would be pinged. Nothing is saved.

        ``dest`` ({lon, lat, name}) makes it a ride to that place -- any building on the map,
        not only a station."""
        requester = self._resident(actor)
        understanding = agent.understand(text, self.hubs).to_dict()
        if dest:
            understanding.update(kind="ride", destination=None, subtasks=[],
                                 skills=understanding.get("skills") or ["driving"],
                                 title=f"Ride to {dest.get('name') or 'a place in Elmina'}",
                                 dest_point={"lon": float(dest["lon"]), "lat": float(dest["lat"]),
                                             "name": dest.get("name") or "a place in Elmina"})
        if invitee:
            understanding.update(invitee=invitee, start_at=start_at)
        return self.preview(requester, understanding)

    def preview(self, requester: dict, u: dict) -> dict:
        task = self._shape_task(requester, u)
        invitee = self._check_invitee(requester, task, u)
        if invitee:
            # A direct request goes to one person as one job; it is never split.
            u = {**u, "subtasks": []}
        value = valuation.value(task["est_minutes"], skill_level=task["skill_level"],
                                urgency=task["urgency"], distance_km=self._distance_km(task),
                                materials_rm=u.get("materials_rm", 0.0))
        subtasks = []
        for sub in u.get("subtasks") or []:
            sub_task = {**task, "skills": sub["skills"], "kind": "help",
                        "est_minutes": sub["est_minutes"],
                        "skill_level": 2 if set(sub["skills"]) & agent.EXPERT_SKILLS
                        else (1 if set(sub["skills"]) & agent.SKILLED_SKILLS else 0)}
            sub_value = valuation.value(sub["est_minutes"], skill_level=sub_task["skill_level"],
                                        urgency=task["urgency"])
            cands = self._rank(sub_task)
            subtasks.append({"title": sub["title"], "skills": sub["skills"],
                             "est_minutes": sub["est_minutes"],
                             "valuation": sub_value.to_dict(),
                             "candidates": [c.to_dict() for c in cands[:3]],
                             "fallback": self._fallback(sub_task, cands)})
        cands = self._rank(task)
        balance = credits.balance(self.store, requester["id"])
        cost = (sum(s["valuation"]["suggested"] for s in subtasks) if subtasks
                else value.suggested)
        return {
            "understanding": u,
            "task": {k: task[k] for k in ("title", "kind", "skills", "skill_level", "urgency",
                                          "slot", "when", "est_minutes", "lon", "lat", "dest_id",
                                          "dest_name", "dest_lon", "dest_lat", "invitee",
                                          "start_at")},
            "valuation": value.to_dict(),
            "subtasks": subtasks,
            "candidates": [c.to_dict() for c in cands
                           if not invitee or c.resident_id == invitee["id"]],
            "fallback": None if subtasks or invitee else self._fallback(task, cands),
            "invitee": ({"id": invitee["id"], "name": invitee["name"],
                         "start_at": task["start_at"], "when": task["when"]}
                        if invitee else None),
            "balance": balance,
            "available": balance - self._requester_balance_committed(requester["id"]),
            "cost": cost,
        }

    def _shape_task(self, requester: dict, u: dict) -> dict:
        point = u.get("dest_point") if u.get("kind") == "ride" else None
        hub = self.hub(u.get("destination")) if u.get("kind") == "ride" and not point else None
        if u.get("kind") == "ride" and hub is None and self.hubs and not point:
            hub = self.hubs[0]
        dest = (hub or {}).get("gateway") or [None, None]
        dest_name = hub["name"] if hub else None
        if point:
            # Any building: the car stops at the drivable road point nearest its door, so
            # the GPS arrival check has somewhere it can actually reach.
            drive = self.networks.get("drive")
            xy = np.array(self.town.frame.to_xy(point["lon"], point["lat"]), dtype=float)
            node = drive.nearest_node(xy) if drive is not None else None
            if node is None:
                raise GridError("that place is not reachable by road")
            dest = [float(v) for v in self.town.frame.to_lonlat(*drive.node_xy[node])]
            dest_name = point["name"]
            here = (requester["lon"], requester["lat"])
            if haversine_m(here[0], here[1], dest[0], dest[1]) < 60:
                raise GridError("that is right next to your home")
        return {
            "requester": requester["id"], "title": u["title"], "kind": u["kind"],
            "skills": list(u["skills"]), "skill_level": int(u["skill_level"]),
            # No time given means now: match on who is free in the current slot.
            "urgency": int(u["urgency"]),
            "slot": u.get("slot") or (None if u.get("when") else self.slot_at(self.now)),
            "when": u.get("when"),
            "invitee": u.get("invitee"), "start_at": u.get("start_at"),
            "est_minutes": int(u["est_minutes"]), "lon": requester["lon"],
            "lat": requester["lat"], "building": requester["home_building"],
            "dest_id": hub["id"] if hub else None, "dest_name": dest_name,
            "dest_lon": dest[0], "dest_lat": dest[1],
        }

    def _check_invitee(self, requester: dict, task: dict, u: dict) -> dict | None:
        """Rules for asking one neighbour directly. Fills in the task's slot and time.

        A neighbour who is free right now can be asked for now. One who is not can only be
        booked for a later slot in their own free time.
        """
        if not u.get("invitee"):
            task["start_at"] = None
            return None
        invitee = self.store.resident(u["invitee"])
        if invitee is None:
            raise GridError("that neighbour isn't on the grid")
        first = invitee["name"].split()[0]
        if invitee["id"] == requester["id"]:
            raise GridError("you cannot ask yourself")
        if invitee["suspended"]:
            raise GridError(f"{first} can't take requests right now")
        if task["kind"] == "ride" and not invitee["has_car"]:
            raise GridError(f"{first} doesn't have a car")
        free = [s for s in matching.SLOTS if s in (invitee["availability"] or [])]
        start = u.get("start_at")
        if start is None:
            if not self.free_now(invitee):
                raise GridError(f"{first} isn't free right now. Book them for a slot in "
                                f"their free time: {', '.join(free) or 'none listed'}.")
            task["slot"] = self.slot_at(self.now)
            task["when"] = "Now"
            task["start_at"] = None
            return invitee
        start = float(start)
        if start <= self.now:
            raise GridError("that time has already passed; pick a later slot")
        if start - self.now > MAX_BOOKING_S:
            raise GridError("bookings can be made up to a week ahead")
        slot = self.slot_at(start)
        if slot is None or slot not in free:
            raise GridError(f"{first} is only free {', '.join(free) or 'at no listed time'}; "
                            "pick one of those slots")
        task["slot"] = slot
        task["when"] = self.when_label(start)
        task["start_at"] = start
        return invitee

    def _rank(self, task: dict, exclude: set[str] | None = None):
        return matching.rank(task, self.store.residents(), network=self.networks.get("walk"),
                             frame=self.town.frame, exclude=exclude,
                             drive=self.networks.get("drive"))

    def _fallback(self, task: dict, candidates) -> dict | None:
        if not matching.needs_fallback(task, candidates):
            return None
        return fallback.offer(task, self.store.tenants())

    # -------------------------------------------------------------- posting

    def post(self, actor: str, *, understanding: dict, credits_offered: int | None = None,
             description: str = "") -> list[dict]:
        """Create a task (or one per micro-task) from a draft's understanding."""
        requester = self._resident(actor)
        if requester["suspended"]:
            raise GridError("this account is suspended pending review")
        preview = self.preview(requester, understanding)
        base = preview["task"]
        source = understanding.get("source", "rules")

        parts = preview["subtasks"] or [None]
        total = 0
        planned = []
        for sub in parts:
            if sub is None:
                v = preview["valuation"]
                amount = int(credits_offered) if credits_offered else v["suggested"]
                if not v["low"] <= amount <= v["high"]:
                    raise GridError(f"offer between {v['low']} and {v['high']} credits")
                planned.append((None, amount, v))
            else:
                v = sub["valuation"]
                planned.append((sub, v["suggested"], v))
            total += planned[-1][1]

        available = credits.balance(self.store, actor) - self._requester_balance_committed(actor)
        if total > available:
            raise GridError(f"you have {available} credits free; this needs {total}. "
                            "Earn more by helping a neighbour or taking an SDP bounty.")

        created = []
        parent_id = None
        if len(planned) > 1:
            parent_id = self.store.next_task_id()
            self.store.add_task(id=parent_id, requester=actor, title=base["title"],
                                description=description, kind="bundle",
                                skills=sorted({s for sub, _, _ in planned for s in sub["skills"]}),
                                skill_level=base["skill_level"], lon=base["lon"],
                                lat=base["lat"], building=requester["home_building"],
                                slot=base["slot"], urgency=base["urgency"],
                                est_minutes=base["est_minutes"], credits=total, status=SPLIT,
                                source=source, valuation=preview["valuation"],
                                created_t=self.t, updated_t=self.t)
        for sub, amount, v in planned:
            task_id = self.store.next_task_id()
            fields = dict(base)
            if sub is not None:
                fields.update(title=sub["title"], skills=sub["skills"], kind="help",
                              est_minutes=sub["est_minutes"])
                fields["skill_level"] = (2 if set(sub["skills"]) & agent.EXPERT_SKILLS else
                                         1 if set(sub["skills"]) & agent.SKILLED_SKILLS else 0)
            self.store.add_task(id=task_id, requester=actor, title=fields["title"],
                                description=description, kind=fields["kind"],
                                skills=fields["skills"], skill_level=fields["skill_level"],
                                lon=fields["lon"], lat=fields["lat"],
                                building=requester["home_building"],
                                dest_id=fields["dest_id"], dest_name=fields["dest_name"],
                                dest_lon=fields["dest_lon"], dest_lat=fields["dest_lat"],
                                slot=fields["slot"], when_label=fields.get("when"),
                                invitee=fields.get("invitee"), start_at=fields.get("start_at"),
                                urgency=fields["urgency"],
                                est_minutes=fields["est_minutes"], credits=amount, status=OPEN,
                                parent_id=parent_id, source=source, valuation=v,
                                created_t=self.t, updated_t=self.t)
            task = self.store.task(task_id)
            if task.get("invitee"):
                if self.auto_accept:
                    self._auto_due[task_id] = self.t + AUTO_ACCEPT_S
                who = self._resident(task["invitee"])["name"]
                verb = (f"booked {who} for {task['when_label']}"
                        if task.get("start_at") is not None else f"asked {who} directly")
                self.store.log(self.t, "posted", f"{requester['name']} {verb}: "
                               f"{task['title']} ({amount} cr)", task_id, actor)
                created.append({**task, "pinged": preview["candidates"]})
                continue
            if self.auto_accept:
                self._auto_due[task_id] = self.t + AUTO_ACCEPT_S
            pinged = self._rank(task)[:3]
            names = ", ".join(c.name.split()[0] for c in pinged) or "nobody in reach yet"
            self.store.log(self.t, "posted",
                           f"{requester['name']} asked: {task['title']} ({amount} cr) "
                           f"— pinged {names}", task_id, actor)
            created.append({**task, "pinged": [c.to_dict() for c in pinged]})
        return created

    def create_bounty(self, *, title: str, skills: list[str], credits_amount: int,
                      lon: float | None = None, lat: float | None = None,
                      building: str | None = None, est_minutes: int = 30,
                      description: str = "", when: str | None = None) -> dict:
        """SDP property management posts a paid civic micro-task. Funded from the mint."""
        if building and self.town.has_building(building):
            b = self.town.building(building)
            lon, lat = (float(v) for v in self.town.frame.to_lonlat(*b.centroid_xy))
        if lon is None or lat is None:
            raise GridError("a bounty needs a location")
        credits_amount = int(credits_amount)
        if not 1 <= credits_amount <= valuation.MAX_CREDITS:
            raise GridError(f"bounties pay 1-{valuation.MAX_CREDITS} credits")
        task_id = self.store.next_task_id()
        self.store.add_task(id=task_id, requester="sdp", title=title, description=description,
                            kind="bounty", skills=skills, skill_level=0, lon=lon, lat=lat,
                            when_label=when or "Any time",
                            building=building, urgency=1, est_minutes=est_minutes,
                            credits=credits_amount, status=OPEN, source="sdp",
                            valuation={"explanation": "set by SDP property management"},
                            created_t=self.t, updated_t=self.t)
        self.store.log(self.t, "bounty", f"SDP bounty: {title} ({credits_amount} cr)", task_id)
        return self.store.task(task_id)

    # ------------------------------------------------------------ execution

    def accept(self, task_id: str, actor: str) -> dict:
        task = self._task(task_id)
        provider = self._resident(actor)
        if task["status"] != OPEN:
            raise GridError(f"{task_id} is {task['status'].replace('_', ' ')}, not open")
        if task["requester"] == actor:
            raise GridError("you cannot accept your own request")
        if provider["suspended"]:
            raise GridError("this account is suspended pending review")
        if task["kind"] == "ride" and not provider["has_car"]:
            raise GridError("rides need a neighbour with a car")
        if task.get("invitee") and task["invitee"] != actor:
            raise GridError("this request is only for "
                            f"{self._resident(task['invitee'])['name'].split()[0]}")

        task = {**task, "provider": actor}
        try:
            credits.lock_escrow(self.store, task, self.t)
        except credits.CreditError as err:
            raise GridError(str(err)) from err
        if task.get("start_at") is not None and task["start_at"] > self.now:
            self.store.update_task(task_id, status=RESERVED, provider=actor, updated_t=self.t)
            self.store.log(self.t, "booked",
                           f"{provider['name']} confirmed {task['title']} for "
                           f"{self.when_label(task['start_at'])} — {task['credits']} cr held "
                           "in escrow", task_id, actor)
            return self.store.task(task_id)
        return self._dispatch(task, provider)

    def _dispatch(self, task: dict, provider: dict) -> dict:
        """Send the helper on their way: the job starts now."""
        task_id, actor = task["id"], provider["id"]
        self.store.update_task(task_id, status=IN_PROGRESS, provider=actor, updated_t=self.t)

        home = (provider["lon"], provider["lat"])
        if task["kind"] == "ride":
            self._spawn(f"m:{task_id}", actor, "drive", home, (task["lon"], task["lat"]),
                        task_id=task_id, leg="pickup", passenger=task["requester"])
            verb = "is driving over to collect"
        else:
            self._spawn(f"m:{task_id}", actor, "walk", home, (task["lon"], task["lat"]),
                        task_id=task_id, leg="go")
            verb = "is on the way for"
        who = "SDP" if task["requester"] == "sdp" else self._resident(task["requester"])["name"]
        self.store.log(self.t, "accepted",
                       f"{provider['name']} accepted {task['title']} — {task['credits']} cr "
                       f"locked in escrow; {provider['name'].split()[0]} {verb} {who}",
                       task_id, actor)
        return self.store.task(task_id)

    def complete(self, task_id: str, actor: str, proof: dict | None = None) -> dict:
        """Confirm a job. Requesters confirm help; bounty takers submit geo-tagged proof."""
        task = self._task(task_id)
        if task["status"] not in (IN_PROGRESS, ARRIVED):
            raise GridError(f"{task_id} is {task['status'].replace('_', ' ')}")
        if task["kind"] == "bounty":
            if actor != task["provider"]:
                raise GridError("only the resident doing the bounty can submit proof")
            lon, lat = (proof["lon"], proof["lat"]) if proof else self.position_of(actor)
            off = float(haversine_m(lon, lat, task["lon"], task["lat"]))
            if off > PROOF_RADIUS_M:
                raise GridError(f"proof photo is geo-tagged {off:.0f} m from the bounty; "
                                f"it must be within {PROOF_RADIUS_M:.0f} m")
            how = "geo-tagged proof accepted"
        elif task["kind"] == "ride":
            raise GridError("rides complete automatically when GPS shows you have both arrived")
        else:
            if actor not in (task["requester"], "system"):
                raise GridError("the requester confirms the job is done")
            if task["status"] != ARRIVED:
                raise GridError("the helper has not arrived yet")
            how = "confirmed by requester" if actor != "system" else "auto-confirmed on site"
        return self._finish(task, how)

    def _finish(self, task: dict, how: str) -> dict:
        try:
            paid = credits.release(self.store, task, self.t)
        except credits.CreditError as err:
            raise GridError(str(err)) from err
        self.store.update_task(task["id"], status=COMPLETED, updated_t=self.t)
        provider = self._resident(task["provider"])
        # Turning up is what reliability measures; it recovers slowly after a strike.
        self.store.update_resident(provider["id"],
                                   reliability=round(min(0.99, provider["reliability"] + 0.01), 3))
        self.store.log(self.t, "completed",
                       f"{task['title']}: {how} — {paid} cr released to {provider['name']}",
                       task["id"], provider["id"])
        mover = self.movers.get(f"m:{task['id']}")
        if mover:
            mover.done = True
        if task["kind"] != "bounty":
            fraud.flag_circular(self.store, task["requester"], task["provider"], self.t)
        self._close_bundle(task)
        return self.store.task(task["id"])

    def _close_bundle(self, task: dict) -> None:
        if not task.get("parent_id"):
            return
        siblings = self.store.tasks(parent_id=task["parent_id"])
        if siblings and all(s["status"] == COMPLETED for s in siblings):
            self.store.update_task(task["parent_id"], status=COMPLETED, updated_t=self.t)

    def cancel(self, task_id: str, actor: str) -> dict:
        task = self._task(task_id)
        if actor != task["requester"]:
            raise GridError("only the requester can cancel")
        if task["status"] not in LIVE:
            raise GridError(f"{task_id} is already {task['status']}")
        refunded = credits.refund(self.store, task, self.t, "cancelled by requester")
        self.store.update_task(task_id, status=CANCELLED, updated_t=self.t)
        self.movers.pop(f"m:{task_id}", None)
        self.store.log(self.t, "cancelled", f"{task['title']} cancelled"
                       + (f" — {refunded} cr refunded" if refunded else ""), task_id, actor)
        return self.store.task(task_id)

    def ghost(self, task_id: str) -> dict:
        """Demo control: the provider stops moving, as a no-show would."""
        mover = self.movers.get(f"m:{task_id}")
        if mover is None or mover.done:
            raise GridError(f"nobody is travelling for {task_id}")
        mover.frozen = True
        mover.still_since = self.t
        return {"task_id": task_id, "frozen": True, "no_show_after_s": NO_SHOW_S / TIME_SCALE}

    def _no_show(self, mover: Mover) -> None:
        task = self.store.task(mover.task_id)
        self.movers.pop(mover.id, None)
        if task is None or task["status"] not in (IN_PROGRESS,):
            return
        refunded = credits.refund(self.store, task, self.t, "provider no-show")
        self.store.update_task(task["id"], status=OPEN, provider=None, updated_t=self.t)
        self.store.log(self.t, "no_show",
                       f"GPS shows {self._resident(mover.resident_id)['name']} has not moved "
                       f"— {refunded} cr refunded, {task['title']} re-opened",
                       task["id"], mover.resident_id)
        fraud.strike(self.store, mover.resident_id, self.t, f"no-show on {task['id']}")

    # -------------------------------------------------------------- commerce

    def redeem(self, actor: str, tenant_id: str, amount: int) -> dict:
        tenant = self.store.tenant(tenant_id)
        if tenant is None:
            raise GridError(f"unknown tenant {tenant_id}")
        resident = self._resident(actor)
        try:
            discount = credits.redeem(self.store, actor, tenant, amount, self.t)
        except credits.CreditError as err:
            raise GridError(str(err)) from err
        self.store.log(self.t, "redeemed", f"{resident['name']} redeemed {amount} cr at "
                       f"{tenant['name']} — RM{discount:.2f} off", actor=actor)
        return {"tenant": tenant["name"], "credits": int(amount), "discount_rm": discount,
                "balance": credits.balance(self.store, actor)}

    def claim_rebate(self, tenant_id: str) -> dict:
        tenant = self.store.tenant(tenant_id)
        if tenant is None:
            raise GridError(f"unknown tenant {tenant_id}")
        month = f"M{int(self.t // (30 * 86400)) + 1}"   # the cap is per rent month
        result = credits.claim_rebate(self.store, tenant, month, self.t)
        if result["credits"]:
            self.store.log(self.t, "rebate", f"{tenant['name']} returned {result['credits']} cr "
                           f"to SDP — RM{result['rebate_rm']:.2f} off rent "
                           f"(cap RM{result['cap_rm']:.0f})")
        return result

    # ----------------------------------------------------------------- tick

    def step(self, dt: float) -> None:
        """Advance the simulated clock by ``dt`` simulated seconds."""
        self.t += dt
        for mover in list(self.movers.values()):
            self._advance(mover, dt)
        self._auto_confirm()
        self._auto_accept_due()
        self._start_bookings()
        self._ambient()
        self.store.set_meta("clock", f"{self.t:.1f}")

    def _advance(self, mover: Mover, dt: float) -> None:
        if mover.done:
            if mover.linger_until is not None and self.t >= mover.linger_until:
                self.movers.pop(mover.id, None)
            elif mover.linger_until is None:
                mover.linger_until = self.t + 20.0
            return
        if mover.frozen:
            since = mover.still_since if mover.still_since is not None else self.t
            if mover.task_id and self.t - since >= NO_SHOW_S:
                self._no_show(mover)
            return
        mover.progress = min(mover.length, mover.progress + mover.speed * dt)
        if mover.progress < mover.length:
            return
        # -- arrival -------------------------------------------------------
        if mover.leg == "ambient":
            mover.done = True
            return
        task = self.store.task(mover.task_id) if mover.task_id else None
        if task is None or task["status"] not in LIVE:
            mover.done = True
            return
        if mover.leg == "pickup":
            # Collected the passenger; now drive both to the station gateway.
            requester = task["requester"]
            start = mover.position()
            self.movers.pop(mover.id, None)
            self._spawn(mover.id, mover.resident_id, "drive", start,
                        (task["dest_lon"], task["dest_lat"]), task_id=task["id"], leg="ride",
                        passenger=requester)
            self.store.log(self.t, "pickup", f"{self._resident(mover.resident_id)['name']} "
                           f"picked up {self._resident(requester)['name']} — heading to "
                           f"{task['dest_name']}", task["id"], mover.resident_id)
            return
        if mover.leg == "ride":
            here = mover.position()
            gap = float(haversine_m(here[0], here[1], task["dest_lon"], task["dest_lat"]))
            passenger = self.position_of(task["requester"])
            gap_p = float(haversine_m(passenger[0], passenger[1],
                                      task["dest_lon"], task["dest_lat"]))
            if gap <= ARRIVAL_M and gap_p <= ARRIVAL_M:
                mover.done = True
                self._finish(task, "GPS confirmed both arrived")
            return
        if mover.leg == "go":
            mover.done = True
            self.store.update_task(task["id"], status=ARRIVED, updated_t=self.t)
            self._arrived_at[task["id"]] = self.t
            self.store.log(self.t, "arrived", f"{self._resident(mover.resident_id)['name']} "
                           f"arrived for {task['title']} (GPS)", task["id"], mover.resident_id)

    def _auto_confirm(self) -> None:
        for task_id, since in list(self._arrived_at.items()):
            task = self.store.task(task_id)
            if task is None or task["status"] != ARRIVED:
                self._arrived_at.pop(task_id, None)
                continue
            due = (task["kind"] == "bounty"   # the phone uploads its geo-tagged photo
                   or self.t - since >= task["est_minutes"] * 60 * AUTO_CONFIRM_FACTOR)
            if not due:
                continue
            self._arrived_at.pop(task_id, None)
            try:
                self.complete(task_id, task["provider"] if task["kind"] == "bounty" else "system")
            except GridError as err:
                self.store.log(self.t, "warning", f"{task['title']}: {err}", task_id)

    def resume_auto_accept(self) -> None:
        """After a restart, queue the open requests people posted (the seeded community's
        own open requests date from t = 0 and stay open for neighbours to browse)."""
        if not self.auto_accept:
            return
        for task in self.store.tasks([OPEN]):
            if task["kind"] not in ("bounty", "bundle") and task["created_t"] > 0:
                self._auto_due.setdefault(task["id"], self.t + AUTO_ACCEPT_S)

    def _auto_accept_due(self) -> None:
        """Demo mode: hand each new request to the best match who can take it -- the same
        ranking the requester saw, skipping anyone already on a job. A direct request or
        booking goes to the neighbour it names."""
        for task_id, due in list(self._auto_due.items()):
            if self.t < due:
                continue
            self._auto_due.pop(task_id, None)
            task = self.store.task(task_id)
            if task is None or task["status"] != OPEN:
                continue
            if task.get("invitee"):
                order = [task["invitee"]]
            else:
                busy = {t["provider"] for t in self.store.tasks([RESERVED, IN_PROGRESS, ARRIVED])
                        if t["provider"]}
                order = [c.resident_id for c in self._rank(task) if c.resident_id not in busy]
            for resident_id in order:
                try:
                    self.accept(task_id, resident_id)
                    break
                except GridError:
                    continue

    def _start_bookings(self) -> None:
        """A confirmed booking starts by itself when the clock reaches its slot."""
        for task in self.store.tasks([RESERVED]):
            if task["start_at"] is not None and task["start_at"] <= self.now:
                self._dispatch(task, self._resident(task["provider"]))

    def _ambient(self) -> None:
        """Neighbours going about their day, so the town is alive between tasks."""
        if self.t < self._next_ambient:
            return
        self._next_ambient = self.t + AMBIENT_EVERY_S * (0.6 + 0.8 * self.rng.random())
        ambient = [m for m in self.movers.values() if m.leg == "ambient" and not m.done]
        if len(ambient) >= AMBIENT_MAX:
            return
        busy = {m.resident_id for m in self.movers.values() if not m.done}
        # Only people in their free time are out and about; at night the town sleeps.
        residents = [r for r in self.store.residents()
                     if r["id"] not in busy and self.free_now(r)]
        if not residents:
            return
        r = self.rng.choice(residents)
        home = (r["lon"], r["lat"])
        hub = self.hub(r.get("commute"))
        if r.get("has_car") and hub and hub.get("gateway") and self.rng.random() < 0.6:
            self._spawn(f"a:{r['id']}:{int(self.t)}", r["id"], "drive", home,
                        tuple(hub["gateway"]), leg="ambient")
        else:
            tenants = self.store.tenants()
            if not tenants:
                return
            shop = self.rng.choice(tenants)
            self._spawn(f"a:{r['id']}:{int(self.t)}", r["id"], "walk", home,
                        (shop["lon"], shop["lat"]), leg="ambient")

    # ------------------------------------------------------------- snapshot

    def task_view(self, task: dict) -> dict:
        requester = None if task["requester"] == "sdp" else self.store.resident(task["requester"])
        provider = self.store.resident(task["provider"]) if task.get("provider") else None
        return {
            "id": task["id"], "title": task["title"], "kind": task["kind"],
            "status": task["status"], "credits": task["credits"], "urgency": task["urgency"],
            "skills": task["skills"], "slot": task["slot"], "when": task.get("when_label"),
            "invitee": task.get("invitee"), "start_at": task.get("start_at"),
            "est_minutes": task["est_minutes"],
            "lon": task["lon"], "lat": task["lat"], "building": task["building"],
            "dest_id": task["dest_id"], "dest_name": task["dest_name"],
            "dest_lon": task["dest_lon"], "dest_lat": task["dest_lat"],
            "requester": task["requester"],
            "requester_name": requester["name"] if requester else "SDP Property Management",
            "provider": task.get("provider"),
            "provider_name": provider["name"] if provider else None,
            "parent_id": task.get("parent_id"), "source": task["source"],
            "valuation": task["valuation"], "created_t": task["created_t"],
            "updated_t": task["updated_t"], "description": task["description"],
        }

    def snapshot(self) -> dict:
        names = {r["id"]: r["name"] for r in self.store.residents()}
        movers = []
        for m in self.movers.values():
            lon, lat = m.position()
            movers.append({
                "id": m.id, "resident": m.resident_id, "name": names.get(m.resident_id, ""),
                "lon": round(lon, 7), "lat": round(lat, 7), "mode": m.mode, "leg": m.leg,
                "task_id": m.task_id, "passenger": m.passenger,
                "passenger_name": names.get(m.passenger) if m.passenger else None,
                "frozen": m.frozen, "done": m.done,
                "route": [] if m.done or m.leg == "ambient" else m.remaining(),
            })
        recent = self.t - 600.0
        tasks = [self.task_view(t) for t in self.store.tasks()
                 if t["kind"] != "bundle"
                 and (t["status"] in LIVE or (t["status"] == COMPLETED and t["updated_t"] >= recent))]
        live = [t for t in tasks if t["status"] in LIVE]
        return {
            "t": round(self.t, 2),
            "clock": self.clock(),
            "movers": movers,
            "tasks": tasks,
            "events": self.store.events(limit=30),
            "demo": {"auto_accept": self.auto_accept},
            "stats": {
                "open": sum(1 for t in live if t["status"] == OPEN),
                "active": sum(1 for t in live if t["status"] != OPEN),
                "completed": int(self.store.execute(
                    "SELECT COUNT(*) AS n FROM tasks WHERE status = 'completed' "
                    "AND kind != 'bundle'").fetchone()["n"]),
                "circulating": credits.circulating(self.store),
                "residents": len(names),
                "moving": sum(1 for m in movers if not m["done"]),
            },
        }
