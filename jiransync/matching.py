"""Agentic matching: who should be pinged for this task, and why.

Deterministic and explainable on purpose. The language model (``agent.py``) decides what
a request *means*; deciding who gets asked is arithmetic over facts the platform holds --
skills, where people live, when they are free, whether they turn up -- so the same task
always ranks the same neighbours, and every rank comes with its reasons.

Who you already know counts too. Neighbours who have helped you, or whom you have helped,
rank a little higher and say so ("Helped you twice before"); so do neighbours you are
volunteering beside at an SDP event. Trust is what makes someone hand over their baby.

Distance is a walking time over the real street graph, not a radius: the neighbour across
the monsoon drain may be 40 m away as the crow flies and ten minutes on foot. A driver is
ranked by how long the drive to the pickup actually takes on the current roads, and when
the platform knows which floor people live on, the stairs and lift are part of the distance.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

from .geo import haversine_m
from .routing import RoadNetwork

# How far the grid reaches for a task, in minutes of walking. "Hyper-local" is the
# product: past this, it is no longer a neighbour helping.
MAX_WALK_MIN = 12.0
# Rides are matched on direction rather than doorstep distance: the driver collects you.
MAX_PICKUP_KM = 2.5
# With a drive network, a pickup further than this many minutes away is not a neighbour.
MAX_PICKUP_MIN = 20.0

# Vertical access inside a building. Assumptions, stated rather than measured: a 3.2 m
# storey (township.STOREY_HEIGHT) climbed on foot with its landings takes about 15 s;
# a residential lift averages a 45 s wait and moves at about 1.3 m/s. People take
# whichever is quicker -- the stairs for a floor or two, the lift for more.
STAIR_S_PER_FLOOR = 15.0
LIFT_WAIT_S = 45.0
LIFT_S_PER_FLOOR = 2.5
INDOOR_MPS = 1.2

WEIGHTS = {"skill": 0.40, "proximity": 0.25, "schedule": 0.20, "reliability": 0.15}
DIRECTION_BONUS = 0.20
# Familiarity: each past favour between you, either way, up to two; and an SDP event you
# share. Small on purpose -- a stranger with the right skill still outranks a friend without.
FAMILIAR_BONUS = 0.06
SHARED_EVENT_BONUS = 0.04
# Homes this close are "around the corner".
NEAR_M = 150.0

# Below this, nobody in reach can genuinely do the job and the commercial fallback offers
# a verified tenant instead.
MIN_MATCH_SCORE = 0.45

SLOTS = ("morning", "afternoon", "evening")


@dataclass
class Candidate:
    resident_id: str
    name: str
    score: float
    skill: float
    proximity: float
    schedule: float
    reliability: float
    walk_min: float | None
    direction: bool
    reasons: list[str]
    lon: float
    lat: float
    # Where they are relative to the task in 3D, when floors are known.
    spatial: dict | None = None
    # Drive time to the pickup, for rides ranked on the road network.
    pickup_min: float | None = None
    # What connects you: "Helped you twice before", "Lives around the corner".
    ties: list[str] | None = None
    # Has helped you or been helped by you before.
    familiar: bool = False
    # Picked as the one new face among the three a request pings.
    ties_new: bool = False

    def to_dict(self) -> dict:
        out = asdict(self)
        out["score"] = round(self.score, 3)
        return out


# The hours a resident means by "free mornings" and so on. Outside them (22:00-07:00) is
# night: nobody is free, so a neighbour can only be booked for a slot later on.
SLOT_HOURS = {"morning": (7, 12), "afternoon": (12, 18), "evening": (18, 22)}


def free_slot(hour: float) -> str | None:
    """The availability slot an hour of the day falls in, or None at night."""
    for slot, (start, end) in SLOT_HOURS.items():
        if start <= hour < end:
            return slot
    return None


def slot_for_hour(hour: float) -> str:
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 18:
        return "afternoon"
    return "evening"


def skill_overlap(required: list[str], offered: list[str]) -> float:
    """Share of the required skills the resident has. No requirement means anyone."""
    required = {s.lower() for s in required}
    if not required:
        return 1.0
    offered = {s.lower() for s in offered}
    return len(required & offered) / len(required)


def _walk_minutes(network: RoadNetwork | None, frame, a_lonlat, b_lonlat) -> float:
    """Walking minutes over the street graph, falling back to 1.3x the straight line."""
    straight = float(haversine_m(a_lonlat[0], a_lonlat[1], b_lonlat[0], b_lonlat[1]))
    if network is not None and frame is not None:
        a = np.array(frame.to_xy(*a_lonlat), dtype=float)
        b = np.array(frame.to_xy(*b_lonlat), dtype=float)
        route = network.route(a, b)
        if route is not None:
            # Add the doorstep legs the graph does not see: home to kerb, kerb to door.
            legs = (float(np.hypot(*(route.xy[0] - a))) + float(np.hypot(*(route.xy[-1] - b)))
                    if len(route.xy) else straight)
            return (route.travel_time_s + legs / (4.8 / 3.6)) / 60.0
    return straight * 1.3 / (4.8 / 3.6) / 60.0


def vertical_seconds(floors: int) -> float:
    """Time to climb (or descend) ``floors`` storeys: stairs or lift, whichever is quicker."""
    if floors <= 0:
        return 0.0
    return min(floors * STAIR_S_PER_FLOOR, LIFT_WAIT_S + floors * LIFT_S_PER_FLOOR)


def spatial_access(task: dict, r: dict, network: RoadNetwork | None, frame) -> dict:
    """How far a neighbour really is from a task in 3D: same building or not, floors
    apart, horizontal and vertical metres, and the time to get there door to door.

    ``floor`` and ``z`` (altitude in metres) come from the building model; a resident with
    no floor on record is taken to be at ground level.
    """
    here, home = (task["lon"], task["lat"]), (r["lon"], r["lat"])
    horizontal = float(haversine_m(here[0], here[1], home[0], home[1]))
    task_floor, their_floor = int(task.get("floor") or 0), int(r.get("floor") or 0)
    floors = abs(task_floor - their_floor)
    same = bool(task.get("building")) and task.get("building") == r.get("building")
    if task.get("z") is not None and r.get("z") is not None:
        vertical = abs(float(task["z"]) - float(r["z"]))
    else:
        vertical = floors * 3.2
    if same:
        seconds = horizontal / INDOOR_MPS + vertical_seconds(floors)
    else:
        # Down from their floor, across the street grid, up to the task's floor.
        seconds = (vertical_seconds(their_floor) + _walk_minutes(network, frame, home, here) * 60
                   + vertical_seconds(task_floor))
    return {"same_building": same, "floors_apart": floors, "horizontal_m": round(horizontal, 1),
            "vertical_m": round(vertical, 1),
            "distance_3d_m": round(math.hypot(horizontal, vertical), 1),
            "access_s": round(seconds, 1)}


def _times(n: int) -> str:
    return {1: "once", 2: "twice"}.get(n, f"{n}×")


def social_ties(social: dict | None, straight_m: float, ride: bool) -> tuple[list[str], bool, float]:
    """What links a neighbour to the requester, whether they know each other, and the bonus.

    ``social`` is {"helped_me": n, "i_helped": n, "events": [(title, upcoming)]}.
    """
    ties, bonus = [], 0.0
    social = social or {}
    helped_me, i_helped = social.get("helped_me", 0), social.get("i_helped", 0)
    if helped_me:
        ties.append(f"Helped you {_times(helped_me)} before")
    if i_helped:
        ties.append(f"You helped them {_times(i_helped)}")
    bonus += FAMILIAR_BONUS * min(2, helped_me + i_helped)
    events = social.get("events") or []
    if events:
        title, upcoming = events[0]
        ties.append(f"You’re both going to {title}" if upcoming else f"You both volunteered at {title}")
        bonus += SHARED_EVENT_BONUS
    if not ride and straight_m <= NEAR_M:
        ties.append("Lives around the corner")
    return ties, bool(helped_me or i_helped), bonus


def rank(task: dict, residents: list[dict], *, network: RoadNetwork | None = None,
         frame=None, limit: int = 5, exclude: set[str] | None = None,
         drive: RoadNetwork | None = None, social: dict | None = None) -> list[Candidate]:
    """Score every eligible neighbour for a task, best first.

    ``network`` is the walking graph. ``drive``, when given, ranks drivers for a ride by
    their real drive time to the pickup -- including any roadworks or flooding on it --
    instead of by straight-line distance. ``social`` maps a resident id to what links them
    to the requester (see ``social_ties``).
    """
    exclude = set(exclude or ()) | {task.get("requester")}
    here = (task["lon"], task["lat"])
    ride = task["kind"] == "ride"
    three_d = task.get("floor") is not None
    out: list[Candidate] = []
    pickup_times: dict[int, float] = {}
    if ride and drive is not None and frame is not None:
        here_xy = np.array(frame.to_xy(*here), dtype=float)
        pickup_times = drive.times_to(here_xy)

    for r in residents:
        if r["id"] in exclude or r.get("suspended") or not r.get("verified"):
            continue
        home = (r["lon"], r["lat"])
        straight = float(haversine_m(here[0], here[1], home[0], home[1]))
        reasons: list[str] = []
        direction = False
        spatial = None
        pickup_min = None

        if ride:
            if not r.get("has_car"):
                continue
            if straight > MAX_PICKUP_KM * 1000:
                continue
            walk = None
            if pickup_times:
                node = drive.nearest_node(np.array(frame.to_xy(*home), dtype=float))
                seconds = pickup_times.get(node) if node is not None else None
                if seconds is None or seconds / 60 > MAX_PICKUP_MIN:
                    continue
                pickup_min = round(seconds / 60, 1)
                # On the road network the time to reach you is what counts, not the
                # straight line: the nearest driver may be stuck behind roadworks.
                proximity = max(0.0, 1.0 - pickup_min / MAX_PICKUP_MIN)
                reasons.append(f"has a car · {max(1, round(pickup_min))} min drive to you")
            else:
                proximity = max(0.0, 1.0 - straight / (MAX_PICKUP_KM * 1000))
                reasons.append(f"has a car · {straight / 1000:.1f} km away")
            direction = bool(task.get("dest_id")) and r.get("commute") == task.get("dest_id")
            if direction:
                reasons.append(f"already drives to {task.get('dest_name') or 'that hub'}")
        else:
            # Cheap straight-line prefilter before paying for A*.
            if straight > MAX_WALK_MIN * 80 * 1.2:
                continue
            if three_d:
                spatial = spatial_access(task, r, network, frame)
                walk = spatial["access_s"] / 60
            else:
                walk = _walk_minutes(network, frame, home, here)
            if walk > MAX_WALK_MIN:
                continue
            proximity = max(0.0, 1.0 - walk / MAX_WALK_MIN)
            if spatial and spatial["same_building"]:
                n = spatial["floors_apart"]
                reasons.append("same building · " + ("same floor" if n == 0 else
                               f"{n} floor{'s' if n > 1 else ''} away"))
            else:
                reasons.append(f"{max(1, round(walk))} min walk")

        skill = skill_overlap(task.get("skills") or [], r.get("skills") or [])
        if task.get("skills"):
            matched = sorted({s.lower() for s in task["skills"]}
                             & {s.lower() for s in r.get("skills") or []})
            if matched:
                reasons.insert(0, " + ".join(matched))
            elif not ride:
                reasons.insert(0, "no matching skill")

        slot = task.get("slot")
        free = r.get("availability") or []
        schedule = 1.0 if not slot or slot in free else 0.0
        if slot:
            reasons.append(f"free {slot}s" if schedule else f"busy {slot}s")

        reliability = float(r.get("reliability", 0.9))
        reasons.append(f"{round(reliability * 100)}% reliable")

        score = (WEIGHTS["skill"] * skill + WEIGHTS["proximity"] * proximity
                 + WEIGHTS["schedule"] * schedule + WEIGHTS["reliability"] * reliability
                 + (DIRECTION_BONUS if direction else 0.0))
        if ride:
            # Skills mean little for a lift; a car heading the right way means everything.
            score = (0.45 * proximity + 0.25 * schedule + 0.30 * reliability
                     + (DIRECTION_BONUS * 2 if direction else 0.0))
        ties, familiar, bonus = social_ties((social or {}).get(r["id"]), straight, ride)
        score += bonus

        out.append(Candidate(r["id"], r["name"], score, skill, proximity, schedule,
                             reliability, None if walk is None else round(walk, 1),
                             direction, reasons, r["lon"], r["lat"], spatial, pickup_min,
                             ties, familiar))

    out.sort(key=lambda c: (-c.score, c.resident_id))
    return out[:limit]


def needs_fallback(task: dict, candidates: list[Candidate]) -> bool:
    """True when nobody in reach is a genuine match for the job."""
    if not candidates:
        return True
    best = candidates[0]
    if task.get("skills") and task["kind"] != "ride" and best.skill <= 0.0:
        return True
    return best.score < MIN_MATCH_SCORE and not math.isclose(best.score, MIN_MATCH_SCORE)
