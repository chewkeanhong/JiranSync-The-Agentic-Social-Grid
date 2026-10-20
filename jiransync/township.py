"""The township: building footprints, terrain, and the projection frame.

This module is the single source of truth for *where things are*. Matching, the credit
ledger's location checks and the web layer all read from one :class:`Township` so they
cannot disagree about where a home is or how tall a shop-lot is.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .geo import LocalFrame, PolygonSet, ring_area, ring_centroid, ring_perimeter
from .terrain import Terrain

STOREY_HEIGHT = 3.2

# What a building is *for*, as far as the social grid is concerned. Derived from the
# OSM ``building`` / ``amenity`` / ``shop`` tags, which is enough to tell a terrace
# house from a shop-lot from a surau without a hand-labelled map.
ROLE_HOME = "home"
ROLE_SHOP = "shop"
ROLE_CIVIC = "civic"
ROLE_TRANSIT = "transit"
ROLE_OTHER = "other"

HOME_KINDS = {
    "house", "detached", "semidetached_house", "terrace", "residential", "apartments",
    "bungalow", "dormitory", "townhouse",
}
SHOP_KINDS = {"commercial", "retail", "supermarket", "mall", "kiosk", "office", "hotel"}
CIVIC_KINDS = {
    "school", "university", "college", "kindergarten", "hospital", "clinic", "mosque",
    "church", "temple", "public", "civic", "government", "community_centre",
    "sports_centre", "fire_station", "police",
}
TRANSIT_KINDS = {"train_station", "transportation"}
CIVIC_AMENITIES = {
    "school", "kindergarten", "place_of_worship", "community_centre", "clinic",
    "hospital", "doctors", "police", "fire_station", "library", "townhall",
}
SHOP_AMENITIES = {"cafe", "restaurant", "fast_food", "bank", "pharmacy", "marketplace"}


def classify_role(kind: str, amenity: str | None = None, shop: str | None = None) -> str:
    """Map OSM tags onto the roles the social grid cares about."""
    if kind in TRANSIT_KINDS or amenity in {"bus_station"}:
        return ROLE_TRANSIT
    if shop or amenity in SHOP_AMENITIES or kind in SHOP_KINDS:
        return ROLE_SHOP
    if amenity in CIVIC_AMENITIES or kind in CIVIC_KINDS:
        return ROLE_CIVIC
    if kind in HOME_KINDS:
        return ROLE_HOME
    if kind == "yes":
        # Untagged footprints in a township are overwhelmingly houses.
        return ROLE_HOME
    return ROLE_OTHER


@dataclass
class Building:
    """One footprint, with everything the map needs precomputed."""

    id: str
    index: int
    name: str | None
    kind: str
    height: float
    height_source: str          # "osm" or "imputed"
    area_m2: float
    perimeter_m: float
    centroid_xy: np.ndarray
    centroid_lonlat: tuple[float, float]
    role: str = ROLE_OTHER
    # Ground elevation under the footprint, from the Copernicus DEM. Zero when no
    # terrain has been baked, which reproduces flat-earth behaviour.
    ground_elev: float = 0.0
    ring_lonlat: list[list[float]] = field(repr=False, default_factory=list)

    @property
    def floors(self) -> int:
        return max(1, int(round(self.height / STOREY_HEIGHT)))

    @property
    def roof_z(self) -> float:
        """Roof altitude above sea level."""
        return self.ground_elev + self.height


class Township:
    """Loads GeoJSON into flat arrays and owns the projection frame."""

    def __init__(self, frame: LocalFrame, buildings: list[Building],
                 polygons: PolygonSet, terrain: "Terrain | None" = None):
        self.frame = frame
        self.buildings = buildings
        self.polygons = polygons
        # Falls back to a flat surface so every terrain-aware path stays live and
        # simply concludes the ground is level.
        self.terrain = terrain if terrain is not None else Terrain.flat()
        self._by_id = {b.id: b for b in buildings}

    # -- construction ----------------------------------------------------

    @classmethod
    def load(cls, data_dir: str | Path = "data") -> "Township":
        data_dir = Path(data_dir)
        raw = json.loads((data_dir / "buildings.geojson").read_text(encoding="utf-8"))
        features = raw["features"]
        if not features:
            raise ValueError(f"no buildings in {data_dir / 'buildings.geojson'}")

        all_lon = [c[0] for f in features for c in f["geometry"]["coordinates"][0]]
        all_lat = [c[1] for f in features for c in f["geometry"]["coordinates"][0]]
        frame = LocalFrame.from_bounds(min(all_lon), min(all_lat), max(all_lon), max(all_lat))

        buildings: list[Building] = []
        rings: list[np.ndarray] = []

        for index, feature in enumerate(features):
            props = feature["properties"]
            ring_lonlat = feature["geometry"]["coordinates"][0]
            lon = np.array([c[0] for c in ring_lonlat])
            lat = np.array([c[1] for c in ring_lonlat])
            x, y = frame.to_xy(lon, lat)
            ring = np.column_stack([x, y])

            height = props.get("height")
            if height is None:
                raise ValueError(
                    f"building {props.get('osm_id')} has no height -- "
                    "run scripts/impute_heights.py before loading the township"
                )
            height = float(height)

            kind = props.get("building") or "yes"
            area = float(props.get("area_m2") or ring_area(ring))

            buildings.append(Building(
                id=feature.get("id") or f"b{index}",
                index=index,
                name=props.get("name"),
                kind=kind,
                height=height,
                height_source=props.get("height_source", "osm"),
                area_m2=area,
                perimeter_m=ring_perimeter(ring),
                centroid_xy=np.array(ring_centroid(ring)),
                centroid_lonlat=(float(lon[:-1].mean()), float(lat[:-1].mean())),
                role=classify_role(kind, props.get("amenity"), props.get("shop")),
                ground_elev=float(props.get("ground_elev") or 0.0),
                ring_lonlat=ring_lonlat,
            ))
            rings.append(ring)

        polygons = PolygonSet(rings, np.array([b.roof_z for b in buildings]))

        terrain_path = data_dir / "terrain.json"
        terrain = Terrain.load(terrain_path) if terrain_path.exists() else None
        return cls(frame, buildings, polygons, terrain)

    # -- lookups ---------------------------------------------------------

    def building(self, building_id: str) -> Building:
        return self._by_id[building_id]

    def has_building(self, building_id: str) -> bool:
        return building_id in self._by_id

    def by_role(self, role: str) -> list[Building]:
        return [b for b in self.buildings if b.role == role]

    def bounds_lonlat(self) -> tuple[float, float, float, float]:
        lons = [b.centroid_lonlat[0] for b in self.buildings]
        lats = [b.centroid_lonlat[1] for b in self.buildings]
        return min(lons), min(lats), max(lons), max(lats)

    def centre_lonlat(self) -> tuple[float, float]:
        lon0, lat0, lon1, lat1 = self.bounds_lonlat()
        return (lon0 + lon1) / 2.0, (lat0 + lat1) / 2.0

    def summary(self) -> str:
        imputed = sum(1 for b in self.buildings if b.height_source == "imputed")
        roles: dict[str, int] = {}
        for b in self.buildings:
            roles[b.role] = roles.get(b.role, 0) + 1
        mix = ", ".join(f"{n} {r}" for r, n in sorted(roles.items(), key=lambda kv: -kv[1]))
        return (f"{len(self.buildings)} buildings "
                f"({len(self.buildings) - imputed} OSM heights, {imputed} imputed) | {mix}")
