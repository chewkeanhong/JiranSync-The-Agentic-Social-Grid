"""Helpers for building small, hand-checkable scenes.

The real township has thousands of buildings and nobody can reason about it. Every
geometric claim in these tests is made against a scene small enough to verify on paper.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from jiransync.geo import LocalFrame, PolygonSet, ring_centroid
from jiransync.routing import MODES, RoadNetwork
from jiransync.store import Store
from jiransync.township import Building, Township, classify_role


def square(cx: float, cy: float, size: float) -> np.ndarray:
    """A closed square ring centred on (cx, cy), in local metres."""
    h = size / 2.0
    return np.array([
        [cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h],
        [cx - h, cy + h], [cx - h, cy - h],
    ], dtype=np.float64)


def make_township(specs: list[dict]) -> Township:
    """Build a Township from square footprints.

    specs: [{"id", "cx", "cy", "size", "height", "kind"?, "amenity"?}, ...]
    """
    frame = LocalFrame(101.51, 3.18)
    rings, buildings, heights = [], [], []

    for index, spec in enumerate(specs):
        ring = square(spec["cx"], spec["cy"], spec["size"])
        centroid = np.array(ring_centroid(ring))
        lon, lat = frame.to_lonlat(centroid[0], centroid[1])
        kind = spec.get("kind", "house")
        buildings.append(Building(
            id=spec["id"],
            index=index,
            name=spec.get("name"),
            kind=kind,
            height=float(spec["height"]),
            height_source=spec.get("height_source", "osm"),
            area_m2=float(spec["size"] ** 2),
            perimeter_m=float(4 * spec["size"]),
            centroid_xy=centroid,
            centroid_lonlat=(float(lon), float(lat)),
            role=classify_role(kind, spec.get("amenity"), spec.get("shop")),
            ring_lonlat=[],
        ))
        rings.append(ring)
        heights.append(float(spec["height"]))

    polygons = PolygonSet(rings, np.array(heights), cell_size=50.0)
    return Township(frame, buildings, polygons)


# -- a small social-grid scene --------------------------------------------------
#
# A 600 m street grid with houses along it, one shop-lot, and a station 2 km east of the
# map. Small enough to reason about: every walk is a few hundred metres of known street.

GRID_STEP = 200.0


def street_grid(frame, size: int = 4, step: float = GRID_STEP) -> dict:
    """A FeatureCollection of residential streets on an (size x size) lattice."""
    features = []
    ticks = [j * step for j in range(size)]
    for i in range(size):
        for horizontal in (True, False):
            # A vertex at every crossing, so the streets actually meet.
            xs = [(t, i * step) for t in ticks] if horizontal else [(i * step, t) for t in ticks]
            coords = [list(map(float, frame.to_lonlat(x, y))) for x, y in xs]
            features.append({"type": "Feature",
                             "properties": {"highway": "residential", "name": f"Jalan {i}{'H' if horizontal else 'V'}"},
                             "geometry": {"type": "LineString", "coordinates": coords}})
    return {"type": "FeatureCollection", "features": features}


@pytest.fixture
def scene(tmp_path):
    """(township, networks, places) for the social-grid tests."""
    specs = []
    for n, (cx, cy) in enumerate([(10, 10), (30, 10), (210, 10), (410, 10), (10, 210),
                                  (210, 210), (410, 410), (590, 590), (10, 410), (390, 210)]):
        specs.append({"id": f"h{n}", "cx": cx, "cy": cy, "size": 12, "height": 8.0, "kind": "house"})
    specs.append({"id": "shop1", "cx": 230, "cy": 230, "size": 20, "height": 10.0, "kind": "retail"})
    town = make_township(specs)
    roads = tmp_path / "roads.geojson"
    roads.write_text(json.dumps(street_grid(town.frame)), encoding="utf-8")
    networks = {m: RoadNetwork.load(roads, town.frame, mode=m) for m in MODES}
    hub_lon, hub_lat = town.frame.to_lonlat(2600.0, 300.0)
    places = {
        "name": "Test Township",
        "hubs": [{"id": "mrt", "name": "MRT Test", "aliases": ["mrt"],
                  "lon": float(hub_lon), "lat": float(hub_lat)}],
        "tenants": [{"id": "cafe", "name": "Test Cafe", "category": "cafe",
                     "anchor": [float(v) for v in town.frame.to_lonlat(230, 230)],
                     "skills": ["plumbing"], "offer": "RM2 off", "lead_discount": 0.1,
                     "monthly_rent_rm": 1000}],
    }
    return town, networks, places


def add_resident(store: Store, town, rid: str, building: str, **values) -> dict:
    from jiransync import credits
    b = town.building(building)
    lon, lat = town.frame.to_lonlat(*b.centroid_xy)
    defaults = {"skills": [], "availability": ["morning", "afternoon", "evening"],
                "has_car": 0, "commute": None, "reliability": 0.9}
    defaults.update(values)
    store.add_resident(id=rid, name=f"Resident {rid}", home_building=building,
                       lon=float(lon), lat=float(lat), unit="No. 1", verified=1, **defaults)
    credits.grant_seed(store, rid)
    return store.resident(rid)


@pytest.fixture
def grid(scene):
    """A SocialGrid on the small scene with an in-memory store and no residents yet."""
    from jiransync.grid import SocialGrid
    town, networks, places = scene
    g = SocialGrid(town, networks, Store(), places)
    for tenant in g.place_tenants():
        g.store.add_tenant(**tenant)
    return g
