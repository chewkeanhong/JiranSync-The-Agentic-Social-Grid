"""Two deterministic demo scenarios for spatial matching, kept apart from the live grid.

Each scenario is its own demo state: the people in it are the seeded personas by name,
but their positions here are set for the scenario and never written to the live
community. Nothing in the real City of Elmina data is modified.

**Vertical** -- "2D sees distance; JiranSync sees where people actually are." No building
in the OSM extract is tall enough for this (the tallest is about 23 m, and none carries a
floor count), so a fictional 14-storey "JiranSync Demo Tower" is placed on open ground
that no real footprint touches. Floors are positioned with the township's storey height:

    z = ground elevation (Copernicus DEM) + floor x 3.2 m

so every floor position is an *estimate*, and is labelled as one. Aisyah (Level 8),
Daniel (Level 7) and Sarah (Level 12) live in one stack of units, which a flat map
cannot tell apart; Priya lives in a real house about 120 m away. The matching engine
ranks them with stairs and lift time included (matching.spatial_access).

**Route** -- "closer does not always mean faster." Aisyah needs a ride to MRT Kwasa
Damansara. A demo roadworks stretch is applied to a *copy* of the drive graph -- the
real road data and the live network are untouched -- and the same ride matching the
live grid uses ranks the two drivers by their actual drive time on that copy.

The configuration (where Sarah and Daniel are, which stretch is under repair) is found
by searching the real street graph for one where the roadworks genuinely make the
nearer driver slower; every number shown is measured, not typed in.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import networkx as nx
import numpy as np

from . import agent, matching
from .geo import haversine_m, point_in_ring
from .routing import RoadNetwork
from .township import ROLE_HOME, STOREY_HEIGHT

TOWER_ID = "demo-tower"
TOWER_NAME = "JiranSync Demo Tower"
TOWER_FLOORS = 14                      # Ground (Level 0) to Level 13
TOWER_SIZE_M = (34.0, 16.0)            # a slab block: long side x depth
# Every unit in the scenario is in one stack, this far along the slab from its centre.
UNIT_OFFSET_M = 9.0
TOWER_CLEARANCE_M = 8.0                # open ground kept around the tower

PERSONAS = {"aisyah": "R001", "daniel": "R002", "priya": "R003", "sarah": "R033"}
DEMO_RELIABILITY = 0.95

VERTICAL_TEXT = "Can someone help me carry a parcel?"
ROUTE_TEXT = "Need a ride to MRT."

# The demo roadworks: one lane closed under stop/go traffic control. Drivers wait for
# the green flag (an average 4-minute hold) and crawl through the works at 10 km/h.
WORKS_HOLD_S = 240.0
WORKS_KMH = 10.0
# "Heading to the station": picking Aisyah up adds at most this to a driver's own trip.
MAX_PICKUP_DETOUR_S = 300.0

ASSUMPTIONS = [
    f"Storey height {STOREY_HEIGHT} m (the township model's own figure); "
    "z = ground elevation + floor x storey height. Floor positions are estimated.",
    f"Stairs ~{matching.STAIR_S_PER_FLOOR:.0f} s per floor; lift ~{matching.LIFT_WAIT_S:.0f} s "
    f"wait + {matching.LIFT_S_PER_FLOOR} s per floor; people take whichever is quicker.",
    f"Demo state: everyone is free, able to help, and equally reliable "
    f"({DEMO_RELIABILITY:.0%}), so only where they are decides the match.",
]


# ------------------------------------------------------------------ helpers

def _lonlat(town, xy) -> list[float]:
    lon, lat = town.frame.to_lonlat(float(xy[0]), float(xy[1]))
    return [round(float(lon), 7), round(float(lat), 7)]


def _resident(store, key: str) -> dict:
    """A persona for a demo state: real name and verification, and the same reliability
    for everyone, so each scenario isolates one thing -- floors, or roads -- and comes
    out the same whatever the live community's history."""
    r = store.resident(PERSONAS[key]) or {}
    return {"id": PERSONAS[key], "name": r.get("name", key.title()),
            "verified": bool(r.get("verified", True)), "reliability": DEMO_RELIABILITY}


def _road_bearing(network: RoadNetwork, xy: np.ndarray) -> float:
    """Direction (radians) of the street edge nearest a point, so the tower faces it."""
    best, angle = math.inf, 0.0
    for a, b in network.graph.edges():
        mid = (network.node_xy[a] + network.node_xy[b]) / 2
        d = float(np.hypot(*(mid - xy)))
        if d < best:
            best = d
            dx, dy = network.node_xy[b] - network.node_xy[a]
            angle = math.atan2(dy, dx)
    return angle


def _rect(centre: np.ndarray, angle: float, size=TOWER_SIZE_M) -> np.ndarray:
    u = np.array([math.cos(angle), math.sin(angle)])
    v = np.array([-u[1], u[0]])
    hl, hw = size[0] / 2, size[1] / 2
    return np.array([centre + u * hl + v * hw, centre - u * hl + v * hw,
                     centre - u * hl - v * hw, centre + u * hl - v * hw])


def _footprint_boxes(town) -> np.ndarray:
    """Bounding box of every real footprint, for a cheap first cut."""
    rings = [town.polygons.ring(b.index) for b in town.buildings]
    return np.array([[r[:, 0].min(), r[:, 1].min(), r[:, 0].max(), r[:, 1].max()] for r in rings])


def _edge_distance(ring: np.ndarray, p: np.ndarray) -> float:
    """Shortest distance from a point to a footprint's outline."""
    a, b = ring[:-1], ring[1:]
    ab = b - a
    t = np.clip(((p - a) * ab).sum(1) / np.maximum((ab * ab).sum(1), 1e-9), 0, 1)
    nearest = a + ab * t[:, None]
    return float(np.min(np.hypot(*(nearest - p).T)))


def _site_is_open(town, boxes: np.ndarray, centre: np.ndarray, radius: float) -> bool:
    """No real footprint within ``radius`` of the site: the site is not inside one, and no
    outline -- not just no corner; a warehouse wall can be long -- comes that close."""
    near = np.where((boxes[:, 0] - radius <= centre[0]) & (boxes[:, 2] + radius >= centre[0])
                    & (boxes[:, 1] - radius <= centre[1]) & (boxes[:, 3] + radius >= centre[1]))[0]
    for i in near:
        ring = town.polygons.ring(int(town.buildings[int(i)].index))
        if point_in_ring(float(centre[0]), float(centre[1]), ring):
            return False
        if _edge_distance(ring, centre) < radius:
            return False
    return True


# Ground a tower may not stand on, from the OSM land cover: water, rivers and drains,
# playing fields and playgrounds.
NO_BUILD = {"water", "river", "drain", "pitch", "playground"}


def _no_build_zones(town) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """(areas, lines) in local metres where the tower must not go. Empty if the township
    has no land cover file."""
    path = Path(os.environ.get("JIRANSYNC_DATA", "data")) / "landcover.geojson"
    if not path.exists():
        return [], []
    areas, lines = [], []
    for f in json.loads(path.read_text(encoding="utf-8"))["features"]:
        if f["properties"].get("class") not in NO_BUILD:
            continue
        coords = f["geometry"]["coordinates"]
        pts = coords[0] if f["geometry"]["type"] == "Polygon" else coords
        xy = np.array([town.frame.to_xy(lon, lat) for lon, lat in pts], dtype=float)
        (areas if f["geometry"]["type"] == "Polygon" else lines).append(xy)
    return areas, lines


def _clear_of(zones, site: np.ndarray, radius: float) -> bool:
    areas, lines = zones
    for ring in areas:
        if point_in_ring(float(site[0]), float(site[1]), ring) or _edge_distance(ring, site) < radius:
            return False
    for line in lines:
        # A river line is its centre; keep its banks clear too.
        if len(line) > 1 and _edge_distance(line, site) < radius + 10:
            return False
    return True


def _place_tower(town, walk: RoadNetwork) -> dict:
    """Open ground near the township centre, beside a street, with a house about 120 m
    away for the comparison. Deterministic: the same data always gives the same site."""
    cx, cy = town.frame.to_xy(*town.centre_lonlat())
    centre = np.array([cx, cy], dtype=float)
    radius = math.hypot(*TOWER_SIZE_M) / 2 + TOWER_CLEARANCE_M
    homes = [b for b in town.by_role(ROLE_HOME) if b.height < 15]
    home_xy = np.array([b.centroid_xy for b in homes])
    nodes = walk.node_xy[walk.routable] if len(walk.routable) else walk.node_xy
    boxes = _footprint_boxes(town)
    zones = _no_build_zones(town)

    sites = []
    for dx in np.arange(-700, 701, 15.0):
        for dy in np.arange(-700, 701, 15.0):
            sites.append((float(np.hypot(dx, dy)), centre + np.array([dx, dy])))
    sites.sort(key=lambda s: s[0])
    for _, site in sites:
        road = float(np.min(np.hypot(nodes[:, 0] - site[0], nodes[:, 1] - site[1])))
        if not radius - 2 <= road <= radius + 25:
            continue
        if not _site_is_open(town, boxes, site, radius) or not _clear_of(zones, site, radius):
            continue
        angle = _road_bearing(walk, site)
        unit = site + np.array([math.cos(angle), math.sin(angle)]) * UNIT_OFFSET_M
        d = np.hypot(home_xy[:, 0] - unit[0], home_xy[:, 1] - unit[1])
        near = np.where((d > 105) & (d < 135))[0]
        if not len(near):
            continue
        priya = homes[int(near[np.argmin(np.abs(d[near] - 120))])]
        return {"centre": site, "angle": angle, "rect": _rect(site, angle), "priya_home": priya}
    raise RuntimeError("no open ground for the demo tower")


# ----------------------------------------------------------------- vertical

def vertical(grid) -> dict:
    town, store = grid.town, grid.store
    walk = grid.networks["walk"]
    site = _place_tower(town, walk)
    centre, angle = site["centre"], site["angle"]
    base = float(town.terrain.elevation_at(*centre))
    unit_xy = centre + np.array([math.cos(angle), math.sin(angle)]) * UNIT_OFFSET_M

    def z_at(ground: float, floor: int) -> float:
        return round(ground + floor * STOREY_HEIGHT, 2)

    u = agent.rules(VERTICAL_TEXT, grid.hubs).to_dict()
    aisyah = _resident(store, "aisyah")
    lonlat = _lonlat(town, unit_xy)
    task = {"id": "DEMO-V", "requester": aisyah["id"], "kind": u["kind"], "skills": u["skills"],
            "slot": None, "lon": lonlat[0], "lat": lonlat[1], "building": TOWER_ID,
            "floor": 8, "z": z_at(base, 8)}

    priya_home = site["priya_home"]
    p_lonlat = _lonlat(town, priya_home.centroid_xy)
    # The demo state: all three are home and free, and all could carry a parcel.
    people = []
    for key, floor, where, ground, building_name in (
            ("daniel", 7, lonlat, base, TOWER_NAME),
            ("sarah", 12, lonlat, base, TOWER_NAME),
            ("priya", 0, p_lonlat, priya_home.ground_elev,
             priya_home.name or "A house nearby (real building)")):
        r = _resident(store, key)
        people.append({**r, "lon": where[0], "lat": where[1], "floor": floor,
                       "z": z_at(ground, floor),
                       "building": TOWER_ID if building_name == TOWER_NAME else priya_home.id,
                       "building_name": building_name,
                       "skills": ["moving", "errands"], "availability": [],
                       "has_car": False, "suspended": False})

    ranked = matching.rank(task, people, network=walk, frame=town.frame, limit=10)
    by_id = {c.resident_id: c for c in ranked}
    out_people = []
    for p in people:
        c = by_id[p["id"]]
        out_people.append({
            "id": p["id"], "name": p["name"], "verified": p["verified"],
            "building": p["building"], "building_name": p["building_name"],
            "floor": p["floor"], "lon": p["lon"], "lat": p["lat"], "z": p["z"],
            "floor_estimated": True, "available": True, "compatible": c.skill > 0,
            "score": round(c.score, 3), "reasons": c.reasons, **c.spatial,
            "rank": ranked.index(c) + 1,
        })
    out_people.sort(key=lambda q: q["rank"])
    flat = sorted(out_people, key=lambda q: q["horizontal_m"])
    tie = [q["name"].split()[0] for q in flat if q["horizontal_m"] == flat[0]["horizontal_m"]]
    return {
        "id": "vertical", "demo": True, "text": VERTICAL_TEXT, "task": u,
        "tower": {
            "id": TOWER_ID, "name": TOWER_NAME, "fictional": True,
            "note": "Fictional demo building. No building in the City of Elmina data is tall "
                    "enough; this one is placed on open ground that touches no real footprint, "
                    "water body, river or playing field.",
            "polygon": [_lonlat(town, q) for q in site["rect"]], "centre": _lonlat(town, centre),
            "base_elev": round(base, 2), "floors": TOWER_FLOORS,
            "floor_height": STOREY_HEIGHT, "height": round(TOWER_FLOORS * STOREY_HEIGHT, 1),
            "unit": lonlat,
        },
        "requester": {**aisyah, "building": TOWER_ID, "building_name": TOWER_NAME, "floor": 8,
                      "lon": lonlat[0], "lat": lonlat[1], "z": task["z"],
                      "floor_estimated": True},
        "people": out_people,
        "best": out_people[0]["id"],
        "flat_view": {"distances": [{"id": q["id"], "name": q["name"],
                                     "horizontal_m": q["horizontal_m"]} for q in flat],
                      "tied": tie if len(tie) > 1 else []},
        "assumptions": ASSUMPTIONS,
    }


# -------------------------------------------------------------------- route

def _works_stretch(net: RoadNetwork, path: list[int]) -> list[tuple[int, int]] | None:
    """A 60-160 m run of one street in the middle of a route: where the repair goes."""
    lengths = [net.graph[a][b]["length"] for a, b in zip(path[:-1], path[1:])]
    total = sum(lengths)
    run, run_len, along = [], 0.0, 0.0
    for (a, b), length in zip(zip(path[:-1], path[1:]), lengths):
        along += length
        data = net.graph[a][b]
        if along < total * 0.25 or along > total * 0.8 or \
                data.get("highway") not in {"residential", "tertiary", "unclassified",
                                            "secondary", "living_street"}:
            if 60 <= run_len:
                return run
            run, run_len = [], 0.0
            continue
        if run and data.get("name") != net.graph[run[0][0]][run[0][1]].get("name"):
            if 60 <= run_len:
                return run
            run, run_len = [], 0.0
        run.append((a, b))
        run_len += length
        if run_len >= 160:
            return run
    return run if run_len >= 60 else None


def _apply_works(graph: nx.DiGraph, stretch, on: bool) -> None:
    edges = set(stretch) | {(b, a) for a, b in stretch}
    total = sum(graph[a][b]["length"] for a, b in stretch) or 1.0
    for a, b in edges:
        if not graph.has_edge(a, b):
            continue
        data = graph[a][b]
        if on:
            data["time"] = (data["length"] / (WORKS_KMH / 3.6)
                            + WORKS_HOLD_S * data["length"] / total)
        else:
            data["time"] = data["base_time"]


def _path(net: RoadNetwork, a: int, b: int) -> list[int] | None:
    try:
        return nx.astar_path(net.graph, a, b, heuristic=net._heuristic, weight="time")
    except nx.NetworkXNoPath:
        return None


def _measure(net: RoadNetwork, path: list[int]) -> tuple[float, float]:
    pairs = list(zip(path[:-1], path[1:]))
    return (sum(net.graph[a][b]["length"] for a, b in pairs),
            sum(net.graph[a][b]["time"] for a, b in pairs))


def _search(net: RoadNetwork, a_xy: np.ndarray, gw_node: int):
    """Positions for Sarah and Daniel, and a stretch of road to repair, around one
    starting point -- or None if this street layout cannot show the effect."""
    a_node = net.nearest_node(a_xy)
    if a_node is None:
        return None
    rev = net.graph.reverse(copy=False)
    to_a = nx.single_source_dijkstra_path_length(rev, a_node, weight="time")
    to_mrt = nx.single_source_dijkstra_path_length(rev, gw_node, weight="time")
    nodes = [int(n) for n in net.routable]
    crow = {n: float(np.hypot(*(net.node_xy[n] - a_xy))) for n in nodes}
    # Daniel: about 700 m away and heading for the station: further from it than Aisyah,
    # and collecting her adds no more than a few minutes to his own trip.
    def heading(n):
        return (n in to_a and n in to_mrt and to_mrt[n] > to_mrt[a_node] + 60
                and to_a[n] + to_mrt[a_node] - to_mrt[n] <= MAX_PICKUP_DETOUR_S)
    daniels = sorted((n for n in nodes if 640 <= crow[n] <= 760 and heading(n)),
                     key=lambda n: to_a[n])[:12]
    # Sarah: about 450 m away -- and, on a normal day, quicker to reach Aisyah than Daniel.
    sarahs = sorted((n for n in nodes if 400 <= crow[n] <= 500 and heading(n)),
                    key=lambda n: abs(crow[n] - 450))[:80]
    if not daniels or not sarahs:
        return None

    best = None
    for s in sarahs:
        base_path = _path(net, s, a_node)
        if not base_path:
            continue
        stretch = _works_stretch(net, base_path)
        if not stretch:
            continue
        _apply_works(net.graph, stretch, True)
        works_nodes = {n for e in stretch for n in e}
        s_path = _path(net, s, a_node)
        s_len, s_time = _measure(net, s_path)
        for d in daniels:
            if to_a[d] < to_a[s] + 30:
                continue                      # on a normal day Sarah must be quicker
            d_path = _path(net, d, a_node)
            if works_nodes & set(d_path):
                continue
            d_len, d_time = _measure(net, d_path)
            gap = s_time - d_time
            if gap < 150:
                continue
            key = (gap, -abs(crow[s] - 450) - abs(crow[d] - 700))
            if best is None or key > best[0]:
                best = (key, s, d, stretch, base_path, s_path, d_path)
            break
        _apply_works(net.graph, stretch, False)
    return None if best is None else (a_node, *best[1:])


def route(grid) -> dict:
    town, store = grid.town, grid.store
    live = grid.networks["drive"]
    # A private copy: the roadworks exist only in this scenario.
    net = RoadNetwork(live.graph.copy(), live.node_xy, live.frame, mode="drive")
    hub = grid.hub("kwasa") or grid.hubs[0]
    gw_node = net.nearest_node(np.array(town.frame.to_xy(*hub["gateway"]), dtype=float))

    # Starting point A: a real house, tried outward from the township centre until the
    # street layout around it can show the effect. Independent of the live community,
    # so the scenario is the same on every database.
    cx, cy = town.frame.to_xy(*town.centre_lonlat())
    homes = sorted((b for b in town.by_role(ROLE_HOME) if b.height < 15),
                   key=lambda b: (float(np.hypot(b.centroid_xy[0] - cx, b.centroid_xy[1] - cy)), b.id))
    found = None
    for home in homes[::7][:40]:
        found = _search(net, np.asarray(home.centroid_xy, dtype=float), gw_node)
        if found:
            break
    if found is None:
        raise RuntimeError("no road configuration shows the effect on this network")
    a_node, s, d, stretch, s_base_path, s_path, d_path = found
    a_lonlat = _lonlat(town, home.centroid_xy)
    s_base_len, s_base_time = _measure(net, s_base_path)
    _apply_works(net.graph, stretch, True)

    u = agent.rules(ROUTE_TEXT, grid.hubs).to_dict()
    me = _resident(store, "aisyah")
    me_lonlat = a_lonlat
    task = {"id": "DEMO-R", "requester": me["id"], "kind": "ride", "skills": u["skills"],
            "slot": None, "lon": me_lonlat[0], "lat": me_lonlat[1],
            "dest_id": hub["id"], "dest_name": hub["name"]}
    drivers = []
    for key, node in (("sarah", s), ("daniel", d)):
        r = _resident(store, key)
        drivers.append({**r, **dict(zip(("lon", "lat"), _lonlat(town, net.node_xy[node]))),
                        "has_car": True, "commute": hub["id"], "skills": ["driving"],
                        "availability": [], "suspended": False, "node": node})
    ranked = matching.rank(task, drivers, frame=town.frame, drive=net, limit=10)
    plain = matching.rank(task, drivers, frame=town.frame, limit=10)   # straight-line only
    by_id = {c.resident_id: c for c in ranked}

    def leg(path):
        length, seconds = _measure(net, path)
        return {"path": [_lonlat(town, net.node_xy[n]) for n in path],
                "km": round(length / 1000, 2), "min": round(seconds / 60, 1)}

    onward = _path(net, a_node, gw_node)
    works_set = {n for e in stretch for n in e}
    people = []
    for drv, path in ((drivers[0], s_path), (drivers[1], d_path)):
        c = by_id[drv["id"]]
        affected = drv is drivers[0]
        people.append({
            "id": drv["id"], "name": drv["name"], "verified": drv["verified"],
            "lon": drv["lon"], "lat": drv["lat"],
            "crow_m": round(float(haversine_m(drv["lon"], drv["lat"], *me_lonlat))),
            "route": leg(path), "through_works": bool(works_set & set(path)),
            "affected": affected, "heading_to": hub["name"],
            "score": round(c.score, 3), "reasons": c.reasons, "pickup_min": c.pickup_min,
            "rank": ranked.index(c) + 1,
            "straight_line_rank": [q.resident_id for q in plain].index(drv["id"]) + 1,
        })
    people.sort(key=lambda q: q["rank"])
    sarah = next(q for q in people if q["id"] == PERSONAS["sarah"])
    daniel = next(q for q in people if q["id"] == PERSONAS["daniel"])
    sarah["normal_route"] = {"km": round(s_base_len / 1000, 2), "min": round(s_base_time / 60, 1)}
    return {
        "id": "route", "demo": True, "text": ROUTE_TEXT, "task": u,
        "requester": {**me, "lon": me_lonlat[0], "lat": me_lonlat[1]},
        "destination": {"id": hub["id"], "name": hub["name"], "gateway": hub["gateway"],
                        "lon": hub["lon"], "lat": hub["lat"]},
        "onward": leg(onward) if onward else None,
        "works": {
            "label": "Road under repair", "demo": True,
            "street": net.graph[stretch[0][0]][stretch[0][1]].get("name") or "Local road",
            "path": [_lonlat(town, net.node_xy[stretch[0][0]])]
                    + [_lonlat(town, net.node_xy[b]) for _, b in stretch],
            "length_m": round(sum(live.graph[a][b]["length"] for a, b in stretch)),
            "model": f"One lane closed, stop/go control: ~{WORKS_HOLD_S / 60:.0f} min hold, "
                     f"{WORKS_KMH:.0f} km/h through the works",
        },
        "people": people,
        "best": people[0]["id"],
        "closest": min(people, key=lambda q: q["crow_m"])["id"],
        "faster_by_min": round(sarah["route"]["min"] - daniel["route"]["min"], 1),
        "assumptions": ["Demo road condition: applied to a copy of the road graph only; the "
                        "real City of Elmina road data is unchanged.",
                        "Positions are set for this scenario (point A is a real house) and are "
                        "not the residents' homes in the live community.",
                        f"Both drivers are free, heading to {hub['name']} and equally reliable "
                        f"({DEMO_RELIABILITY:.0%}): only the roads decide the match."],
    }


def build(grid) -> dict:
    return {"vertical": vertical(grid), "route": route(grid)}
