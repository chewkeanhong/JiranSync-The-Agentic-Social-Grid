"""A deterministic demo community: residents, a little history, open tasks and bounties.

Every resident lives in a real home footprint from the OSM data, near the centre of the
map so the walking radius has neighbours in it. Names are invented. Verification against
the SDP property roll is simulated -- every seeded resident is "verified" and receives
the welcome grant -- because there is no SDP database to check against in a prototype.

The first two residents are the demo personas the pitch's user flow is written around:

* ``R001`` Aisyah -- no car, needs a ride to the MRT;
* ``R002`` Daniel -- drives to MRT Kwasa Damansara every morning, a few streets away.
"""

from __future__ import annotations

import random

import numpy as np

from . import credits
from .grid import COMPLETED, SocialGrid
from .township import ROLE_CIVIC, ROLE_HOME, ROLE_SHOP

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

BOUNTIES = [
    ("Report a broken streetlight", ["errands"], 2, "road", 20,
     "Walk the lane, photograph any streetlight that is out, and tag the pole number."),
    ("Join the Saturday park cleanup", ["cleaning"], 4, "civic", 90,
     "Bring gloves; bags and tongs are provided at the community hall."),
    ("Check drain gratings after the storm", ["errands"], 3, "home", 30,
     "Photograph any blocked grating near the playground so the contractor can clear it."),
]


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

    residents = store.residents()
    # A little history, so balances and reliability are not all identical: past favours,
    # paid peer to peer out of the seed grants. Zero-sum, like everything else.
    # The demo personas keep a clean slate: the pitch's flow starts from the welcome grant.
    others = [r for r in residents if r["id"] not in {"R001", "R002", "R003"}]
    for _ in range(18):
        a, b = rng.sample(others, 2)
        if credits.balance(store, a["id"]) < 2:
            continue
        amount = rng.randint(1, 2)
        task_id = store.next_task_id()
        store.add_task(id=task_id, requester=a["id"], title="Past favour", kind="help",
                       skills=b["skills"][:1], skill_level=0, lon=a["lon"], lat=a["lat"],
                       building=a["home_building"], urgency=1, est_minutes=30,
                       credits=amount, status=COMPLETED, provider=b["id"], source="seed",
                       created_t=0.0, updated_t=0.0)
        task = store.task(task_id)
        credits.lock_escrow(store, task, 0.0)
        credits.release(store, task, 0.0)

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

    town = grid.town
    civic = town.by_role(ROLE_CIVIC) or town.by_role(ROLE_SHOP) or town.buildings
    for title, skills, amount, where, minutes, description in BOUNTIES:
        if where == "civic":
            cx, cy = town.frame.to_xy(*town.centre_lonlat())
            b = min(civic, key=lambda x: float(np.hypot(x.centroid_xy[0] - cx,
                                                       x.centroid_xy[1] - cy)))
            lon, lat = town.frame.to_lonlat(*b.centroid_xy)
        else:
            r = rng.choice(residents)
            lon, lat = r["lon"] + rng.uniform(-0.0015, 0.0015), r["lat"] + rng.uniform(-0.0015, 0.0015)
            # Snap to the nearest walkable road so the bounty sits on the street.
            net = grid.networks.get("walk")
            if net is not None:
                node = net.nearest_node(np.array(town.frame.to_xy(lon, lat)))
                if node is not None:
                    lon, lat = town.frame.to_lonlat(*net.node_xy[node])
        grid.create_bounty(title=title, skills=skills, credits_amount=amount,
                           lon=float(lon), lat=float(lat), est_minutes=minutes,
                           description=description,
                           when="Sat · 8:00 AM" if "Saturday" in title else None)

    for prefix in STARTED:
        task = next((t for t in store.tasks(["open"]) if t["title"].startswith(prefix)), None)
        if task is None:
            continue
        for candidate in grid._rank(task):
            if candidate.resident_id in {"R001", "R002"}:
                continue
            try:
                grid.accept(task["id"], candidate.resident_id)
                break
            except Exception:
                continue

    store.log(0.0, "system", f"{len(residents)} verified residents joined "
                             f"{grid.places.get('name', 'the township')} — "
                             f"{credits.SEED_GRANT} cr welcome grant each")
