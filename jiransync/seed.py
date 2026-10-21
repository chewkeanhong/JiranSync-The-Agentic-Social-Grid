"""A deterministic demo community: residents, a little history, open tasks and SDP events.

Every resident lives in a real home footprint from the OSM data, near the centre of the
map so the walking radius has neighbours in it. Names are invented. Verification against
the SDP property roll is simulated -- every seeded resident is "verified" and receives
the welcome grant -- because there is no SDP database to check against in a prototype.

The first two residents are the demo personas the pitch's user flow is written around:

* ``R001`` Aisyah -- no car, needs a ride to the MRT;
* ``R002`` Daniel -- drives to MRT Kwasa Damansara every morning, a few streets away.

Aisyah also has a small circle, for the connectivity story: one neighbour has looked
after her baby twice, and she has tutored that neighbour's child twice in return (her
balance is still the welcome grant), and another is going to the Eco Lake clean-up with
her. When she asks for a baby-sitter, one is "Helped you twice before", one is "You're
both going to Eco Lake clean-up", and the third is a neighbour she has never met.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import numpy as np

from . import credits
from .grid import COMPLETED, PERSONAS, SocialGrid
from .township import ROLE_HOME

NAMES = [
    "Aisyah Rahman", "Daniel Tan", "Priya Nair", "Ahmad Faizal", "Mei Ling Wong",
    "Rajesh Kumar", "Nurul Huda", "Jason Lim", "Siti Aminah", "Kavitha Raj",
    "Hafiz Ismail", "Grace Chong", "Farah Zulkifli", "Vincent Ng", "Lakshmi Devi",
    "Amirul Hakim", "Chloe Teh", "Zainab Yusof", "Arjun Pillai", "Hui Min Lee",
    "Iskandar Shah", "Wei Jie Ong", "Nadia Aziz", "Suresh Menon", "Pei Shan Goh",
    "Khairul Anuar", "Deepa Krishnan", "Marcus Yap", "Liyana Hamid", "Kenneth Chua",
    "Aminah Salleh", "Ravi Shankar", "Sarah Lau", "Danial Hakimi", "Yasmin Osman",
    "Benjamin Koh", "Puteri Balqis", "Ganesh Murthy", "Jia Hui Tan", "Rosli Hassan",
]

SKILL_POOL = [
    ("errands", 9), ("groceries", 8), ("driving", 6), ("moving", 6), ("cleaning", 5),
    ("gardening", 5), ("cooking", 6), ("childcare", 4), ("eldercare", 4), ("pet care", 5),
    ("tutoring", 5), ("tech help", 5), ("repairs", 5), ("carpentry", 2), ("plumbing", 1),
    ("electrical", 1), ("sewing", 2), ("translation", 3), ("photography", 3),
    ("first aid", 2),
]

PERSONAS = {
    0: {"skills": ["cooking", "tutoring", "translation"], "has_car": 0, "commute": None,
        "availability": ["evening"], "reliability": 0.95},
    1: {"skills": ["driving", "tech help", "moving"], "has_car": 1, "commute": "kwasa",
        "availability": ["morning", "evening"], "reliability": 0.97},
    2: {"skills": ["plumbing", "repairs", "electrical"], "has_car": 1, "commute": None,
        "availability": ["afternoon", "evening"], "reliability": 0.93},
}

# What a neighbour shows on their profile beyond skills. Strengths and weaknesses carry a
# topic so one person is never both "great with kids" and "not comfortable with kids".
OCCUPATIONS = [
    "Teacher", "Nurse", "Software engineer", "Accountant", "Retiree", "University student",
    "Sales executive", "Engineer", "Homemaker", "Small business owner", "Graphic designer",
    "Mechanic", "Civil servant", "Chef", "Clinic assistant", "Freelance photographer",
    "Bank officer", "Logistics coordinator", "Property agent", "Lecturer",
]

STRENGTHS = [
    ("Always on time", "time"), ("Patient with kids", "kids"), ("Good with the elderly", "elders"),
    ("Can lift heavy items", "lifting"), ("Speaks Malay, English and Mandarin", "language"),
    ("Speaks Malay, English and Tamil", "language"), ("Calm in emergencies", "calm"),
    ("Handy with tools", "tools"), ("Great with pets", "pets"), ("Explains things clearly", "teach"),
    ("Tech-savvy", "tech"), ("Careful, safe driver", "driving"), ("Replies quickly", "reply"),
    ("Tidy and organised", "tidy"),
]

WEAKNESSES = [
    ("Often busy on weekdays", "time"), ("Not comfortable with young kids", "kids"),
    ("Can't lift heavy items (back injury)", "lifting"), ("Allergic to cats and dogs", "pets"),
    ("Not very good with gadgets", "tech"), ("Slow to reply at night", "reply"),
    ("New to the neighbourhood", "local"), ("Only free for short jobs", "short"),
    ("Doesn't drive at night", "driving"), ("Not confident with tools", "tools"),
]

PERSONA_PROFILES = {
    0: {"occupation": "University student",
        "strengths": ["Explains things clearly", "Speaks Malay, English and Mandarin"],
        "weaknesses": ["Often busy on weekdays"]},
    1: {"occupation": "Software engineer",
        "strengths": ["Always on time", "Tech-savvy", "Careful, safe driver"],
        "weaknesses": ["Slow to reply at night"]},
    2: {"occupation": "Maintenance technician",
        "strengths": ["Handy with tools", "Can lift heavy items"],
        "weaknesses": ["Only free for short jobs"]},
}


def profile_for(resident_id: str, has_car: bool) -> dict:
    """Occupation, strengths and weaknesses for one resident.

    Seeded from the resident id alone, not the community's shared random stream, so adding
    profiles changed nobody's home, skills or car, and an older database can be backfilled
    with exactly what a fresh seed would give.
    """
    index = int(resident_id[1:]) - 1
    if index in PERSONA_PROFILES:
        return dict(PERSONA_PROFILES[index])
    rng = random.Random(f"profile:{resident_id}")
    strengths = [s for s in STRENGTHS if has_car or s[1] != "driving"]
    picked = rng.sample(strengths, rng.randint(2, 3))
    clash = {topic for _, topic in picked} | ({"driving"} if not has_car else set())
    weaknesses = [w for w in WEAKNESSES if w[1] not in clash]
    return {
        "occupation": rng.choice(OCCUPATIONS),
        "strengths": [text for text, _ in picked],
        "weaknesses": [text for text, _ in rng.sample(weaknesses, rng.randint(1, 2))],
    }


def backfill_profiles(store) -> None:
    """Give residents seeded before profiles existed an occupation, strengths and weaknesses."""
    for r in store.residents():
        if not r.get("occupation"):
            store.update_resident(r["id"], **profile_for(r["id"], bool(r["has_car"])))

OPEN_TASKS = [
    # (requester index, text)
    (3, "Help carry a new sofa up to my second floor today 3pm"),
    (5, "Tutor my daughter in SPM maths on Saturday 10am"),
    (7, "Walk my dog this afternoon, I'm stuck at work"),
    (9, "Need a lift to MRT Sungai Buloh tomorrow 7:30am"),
    (11, "Set up the wifi router and printer for my parents this evening"),
    (13, "Buy groceries for my elderly mother today"),
    (16, "Water my garden and plants while I'm away this weekend"),
    (18, "Hem two pairs of school trousers by Friday"),
    (21, "Need a lift to MRT Kwasa Damansara this morning 9am"),
    (24, "Help me with my laptop and email setup tomorrow afternoon"),
]

# Seeded jobs a neighbour has already taken on, so the map opens with people moving:
# one walking over to help and one carpool on its way to the station.
STARTED = ("Walk my dog", "Ride to MRT Kwasa")

# Bump when the seeded community changes shape, so an older database is rebuilt.
SEED_VERSION = 4

# SDP community events: (title, place, day, "HH:MM", minutes, volunteers, credits each,
# already signed up, description). Day 0 is Monday, the day the demo clock starts. A
# place is a named area in the OSM land cover, or "streets" for a job near the homes.
# A day of None is a one-off job: one volunteer, any time, open at once.
EVENTS = [
    ("Eco Lake clean-up", "Eco Lake", 5, "08:00", 120, 10, 4, 3,
     "Gloves, bags and litter pickers are provided. Meet at the lakeside path."),
    ("Gotong-royong at Elmina Urban Park", "Elmina Urban Park", 6, "07:30", 90, 8, 3, 2,
     "Weed the flower beds and sweep the jogging track before the Sunday crowd."),
    ("Tree planting at Central Park West", "Elmina Central Park West", 2, "17:00", 90, 6, 4, 1,
     "Plant 40 saplings with SDP's landscape team. Tools and water provided."),
    ("Report a broken streetlight", "streets", None, None, 20, 1, 2, 0,
     "Walk the lane, photograph any streetlight that is out, and tag the pole number."),
    ("Check drain gratings after the storm", "streets", None, None, 30, 1, 3, 0,
     "Photograph any blocked grating near the playground so the contractor can clear it."),
]


def _named_places() -> dict[str, tuple[float, float]]:
    """Centroids of the named parks and lakes in the township's land cover."""
    path = Path(os.environ.get("JIRANSYNC_DATA", "data")) / "landcover.geojson"
    if not path.exists():
        return {}
    out = {}
    for f in json.loads(path.read_text(encoding="utf-8"))["features"]:
        name = f["properties"].get("name")
        if not name or f["geometry"]["type"] != "Polygon":
            continue
        ring = np.array(f["geometry"]["coordinates"][0], dtype=float)
        out[name] = (float(ring[:, 0].mean()), float(ring[:, 1].mean()))
    return out


# A weakness that contradicts a skill someone offers: a babysitter who is "not
# comfortable with young kids" would undermine the profile a requester chooses from.
CONTRADICTS = {
    "childcare": "kids", "pet care": "Allergic", "tech help": "gadgets",
    "repairs": "tools", "carpentry": "tools", "moving": "lift",
}


def _coherent_profiles(store) -> None:
    """Drop any weakness a resident's own skills contradict."""
    for r in store.residents():
        clash = [word for skill, word in CONTRADICTS.items() if skill in r["skills"]]
        kept = [w for w in r["weaknesses"] if not any(word in w for word in clash)]
        # Everyone keeps one honest weakness; this one no skill contradicts.
        kept = kept or ["Slow to reply at night"]
        if kept != r["weaknesses"]:
            store.update_resident(r["id"], weaknesses=kept)


def _favour(store, requester: dict, provider: dict, what: str, amount: int) -> None:
    """A favour already done and paid: a completed task, its escrow locked and released."""
    task_id = store.next_task_id()
    store.add_task(id=task_id, requester=requester["id"], title="Past favour", kind="help",
                   skills=[what], skill_level=0, lon=requester["lon"], lat=requester["lat"],
                   building=requester["home_building"], urgency=1, est_minutes=30,
                   credits=amount, status=COMPLETED, provider=provider["id"], source="seed",
                   created_t=0.0, updated_t=0.0)
    task = store.task(task_id)
    credits.lock_escrow(store, task, 0.0)
    credits.release(store, task, 0.0)
    store.log(0.0, "completed", f"{provider['name']} helped {requester['name']} with {what} — "
              f"{amount} cr", task_id, provider["id"],
              public=f"A neighbour helped with {what} · {amount} cr")


def _aisyah_circle(grid) -> str | None:
    """Neighbours Aisyah already knows. Returns the one going to an SDP event with her."""
    store = grid.store
    me = store.resident("R001")
    if me is None:
        return None
    probe = {"requester": me["id"], "kind": "help", "skills": ["childcare"], "slot": "evening",
             "lon": me["lon"], "lat": me["lat"], "building": me["home_building"]}
    near = [c for c in grid._rank(probe, limit=12) if c.resident_id not in PERSONAS]
    # The few closest can look after a child, so a baby-sitting request has real matches.
    for c in near[:4]:
        r = store.resident(c.resident_id)
        if "childcare" not in r["skills"]:
            store.update_resident(r["id"], skills=r["skills"] + ["childcare"])
    _coherent_profiles(store)
    near = [c for c in grid._rank(probe, limit=12) if c.resident_id not in PERSONAS]
    if len(near) < 2:
        return None
    friend = store.resident(near[0].resident_id)
    # Two favours each way, a credit each: Aisyah ends where she started.
    for _ in range(2):
        _favour(store, me, friend, "childcare", 1)
    for _ in range(2):
        _favour(store, friend, me, "tutoring", 1)
    return near[1].resident_id


def _pick_skills(rng: random.Random) -> list[str]:
    names = [s for s, _ in SKILL_POOL]
    weights = [w for _, w in SKILL_POOL]
    picked: list[str] = []
    while len(picked) < rng.randint(2, 4):
        s = rng.choices(names, weights)[0]
        if s not in picked:
            picked.append(s)
    return picked


def _homes_near_centre(grid: SocialGrid, n: int, rng: random.Random):
    town = grid.town
    homes = town.by_role(ROLE_HOME) or town.buildings
    cx, cy = town.frame.to_xy(*town.centre_lonlat())
    ranked = sorted(homes, key=lambda b: float(np.hypot(b.centroid_xy[0] - cx,
                                                         b.centroid_xy[1] - cy)))
    # The nearest few hundred homes: dense enough that walking matches exist, spread
    # enough that the map does not look like one street.
    pool = ranked[:max(n * 11, 60)]
    rng.shuffle(pool)
    return pool[:n]


def seed(grid: SocialGrid, *, n_residents: int = 40, seed_value: int = 42) -> None:
    """Wipe and rebuild the demo community. Deterministic for a given township and seed."""
    from . import agent

    store = grid.store
    rng = random.Random(seed_value)
    store.reset()
    grid.t = 0.0
    grid.clock_offset = 0.0
    grid.movers.clear()
    grid._arrived_at.clear()
    store.set_meta("clock", "0")

    for tenant in grid.place_tenants():
        store.add_tenant(**tenant)

    homes = _homes_near_centre(grid, n_residents, rng)
    # Put the two demo personas a short drive apart: Daniel lives in the home nearest
    # to Aisyah's among the rest, so his commute plausibly passes her door.
    if len(homes) > 2:
        a = homes[0].centroid_xy
        rest = sorted(homes[1:], key=lambda b: float(np.hypot(*(b.centroid_xy - a))))
        homes = [homes[0], rest[min(4, len(rest) - 1)]] + [b for b in rest
                                                           if b is not rest[min(4, len(rest) - 1)]]

    hub_ids = [h["id"] for h in grid.hubs]
    for i, building in enumerate(homes):
        lon, lat = grid.town.frame.to_lonlat(*building.centroid_xy)
        has_car = int(rng.random() < 0.55)
        persona = PERSONAS.get(i, {})
        values = {
            "skills": _pick_skills(rng),
            "has_car": has_car,
            "commute": (rng.choice(hub_ids) if has_car and hub_ids and rng.random() < 0.7
                        else None),
            "availability": sorted(rng.sample(["morning", "afternoon", "evening"],
                                              rng.randint(1, 3))),
            "reliability": round(rng.uniform(0.82, 0.99), 2),
        }
        values.update(persona)
        if values["has_car"] and "driving" not in values["skills"]:
            values["skills"] = values["skills"] + ["driving"]
        floors = building.floors
        unit = (f"{rng.randint(1, max(1, floors))}-{rng.randint(1, 12):02d}"
                if floors >= 4 else f"No. {rng.randint(1, 80)}")
        rid = f"R{i + 1:03d}"
        values.update(profile_for(rid, bool(values["has_car"])))
        store.add_resident(id=rid, name=NAMES[i % len(NAMES)], home_building=building.id,
                           lon=float(lon), lat=float(lat), unit=unit, verified=1, **values)
        credits.grant_seed(store, rid, 0.0)

    _coherent_profiles(store)
    residents = store.residents()
    # A little history, so balances and reliability are not all identical: past favours,
    # paid peer to peer out of the seed grants. Zero-sum, like everything else.
    # The demo personas keep a clean slate: the pitch's flow starts from the welcome grant.
    others = [r for r in residents if r["id"] not in {"R001", "R002", "R003"}]
    for _ in range(18):
        a, b = rng.sample(others, 2)
        if credits.balance(store, a["id"]) < 2:
            continue
        _favour(store, a, b, (b["skills"][:1] or ["errands"])[0], rng.randint(1, 2))
    co_volunteer = _aisyah_circle(grid)

    for idx, text in OPEN_TASKS:
        u = agent.rules(text, grid.hubs).to_dict()
        # The intended requester first; if history left them short, the next neighbour
        # (never a demo persona) who can afford it asks instead.
        order = residents[idx:] + residents[3:idx]
        for requester in order:
            if requester["id"] in {"R001", "R002", "R003"}:
                continue
            try:
                grid.post(requester["id"], understanding=u)
                break
            except Exception:
                continue
    # The community's own requests stay open for neighbours to browse; the demo's
    # auto-accept is for what the presenter posts.
    grid._auto_due.clear()

    places = _named_places()
    for (title, place, day, at, minutes, slots, amount, joined,
         description) in EVENTS:
        if place in places:
            lon, lat = places[place]
        else:
            # A job out on the streets: near a home, on the nearest walkable road.
            r = rng.choice(residents)
            lon, lat = r["lon"] + rng.uniform(-0.0015, 0.0015), r["lat"] + rng.uniform(-0.0015, 0.0015)
            place = "Near the homes"
        start_at = None
        if day is not None:
            hours, mins = (int(v) for v in at.split(":"))
            start_at = grid.demo_t_at(day * 24 * 60 + hours * 60 + mins)
        event = grid.create_event(title=title, place_name=place, lon=float(lon), lat=float(lat),
                                  start_at=start_at, duration_min=minutes, slots=slots,
                                  credits_each=amount, description=description)
        volunteers = [r for r in residents if r["id"] not in PERSONAS]
        for r in rng.sample(volunteers, joined):
            grid.join_event(event["id"], r["id"])
        if place == "Eco Lake" and co_volunteer:
            for rid in ("R001", co_volunteer):
                if not any(g["resident"] == rid for g in store.signups(event["id"])):
                    grid.join_event(event["id"], rid)

    for prefix in STARTED:
        task = next((t for t in store.tasks(["open"]) if t["title"].startswith(prefix)), None)
        if task is None:
            continue
        for candidate in grid._rank(task):
            if candidate.resident_id in {"R001", "R002"}:
                continue
            try:
                if grid.uses_offers(task):
                    # Help is offered and chosen; the seeded job is already under way.
                    grid.offer(task["id"], candidate.resident_id)
                    grid.choose(task["id"], task["requester"], candidate.resident_id)
                    booked = store.task(task["id"])
                    if booked["status"] == "reserved":
                        store.update_task(task["id"], start_at=None)
                        grid._dispatch(store.task(task["id"]), store.resident(candidate.resident_id))
                else:
                    grid.accept(task["id"], candidate.resident_id)
                break
            except Exception:
                continue

    store.log(0.0, "system", f"{len(residents)} verified residents joined "
                             f"{grid.places.get('name', 'the township')} — "
                             f"{credits.SEED_GRANT} cr welcome grant each")
