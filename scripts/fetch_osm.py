"""One-time OpenStreetMap fetch for the JiranSync township map.

Overpass is unreliable (observed 504s and read timeouts), so this script is built to
survive it: the AOI is split into tiles, every tile response is cached to disk, and a
re-run picks up exactly where the last one stopped. Mirrors rotate on failure.

Run this once, then commit data/. The demo itself never touches the network.

    python scripts/fetch_osm.py --bbox 3.169,101.502,3.191,101.526 --out data/   # City of Elmina

Land cover (parks, playing fields, grass, woodland, lakes, drains) is a separate kind,
so the map can show the township's real green and blue spaces instead of inventing them:

    python scripts/fetch_osm.py --kinds landcover --out data/
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

import requests

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

HEADERS = {"User-Agent": "JiranSync/0.2 (SDP township prototype)"}

# Road classes a car can actually drive on (walking uses the same graph).
DRIVABLE = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "living_street|service|motorway_link|trunk_link|primary_link|secondary_link|"
    "tertiary_link"
)

QUERIES = {
    "buildings": '[out:json][timeout:{t}];(way["building"]({bbox}););out geom;',
    "roads": '[out:json][timeout:{t}];(way["highway"~"^({classes})$"]({bbox}););out geom;',
    # Training labels only: buildings that already carry a height. Filtering server-side
    # keeps the response small enough to pull a much wider area without timing out,
    # which is the cheapest way to give the height model more to learn from.
    "building_labels": (
        '[out:json][timeout:{t}];('
        'way["building"]["height"]({bbox});'
        'way["building"]["building:levels"]({bbox});'
        ');out geom;'
    ),
}

# Land cover worth drawing in a township twin, by the OSM key that carries it.
LEISURE = "park|garden|playground|pitch|recreation_ground|golf_course|nature_reserve|common|dog_park"
LANDUSE = ("grass|forest|meadow|recreation_ground|village_green|cemetery|reservoir|basin|"
           "orchard|plantation|construction|brownfield|greenfield")
NATURAL = "water|wood|scrub|wetland|grassland|heath"
WATERWAY = "river|stream|canal|drain|ditch"
QUERIES["landcover"] = (
    '[out:json][timeout:{t}];('
    f'way["leisure"~"^({LEISURE})$"]({{bbox}});relation["leisure"~"^({LEISURE})$"]({{bbox}});'
    f'way["landuse"~"^({LANDUSE})$"]({{bbox}});relation["landuse"~"^({LANDUSE})$"]({{bbox}});'
    f'way["natural"~"^({NATURAL})$"]({{bbox}});relation["natural"~"^({NATURAL})$"]({{bbox}});'
    f'way["waterway"~"^({WATERWAY})$"]({{bbox}});'
    ');out geom;'
)

# Which GeoJSON file each query kind produces.
OUTPUT_NAMES = {
    "buildings": "buildings.geojson",
    "roads": "roads.geojson",
    "building_labels": "train_buildings.geojson",
    "landcover": "landcover.geojson",
}

FEET_PER_METRE = 0.3048
DEFAULT_STOREY_HEIGHT = 3.2


# --------------------------------------------------------------------------- fetch


def tile_bbox(bbox: tuple[float, float, float, float], rows: int, cols: int):
    """Split (south, west, north, east) into rows*cols sub-boxes."""
    south, west, north, east = bbox
    dlat = (north - south) / rows
    dlon = (east - west) / cols
    for r in range(rows):
        for c in range(cols):
            yield r, c, (
                south + r * dlat,
                west + c * dlon,
                south + (r + 1) * dlat,
                west + (c + 1) * dlon,
            )


def run_query(query: str, timeout: int, max_attempts: int = 24) -> dict:
    """Execute an Overpass query, rotating mirrors with exponential backoff."""
    last_error = "no attempt made"
    for attempt in range(max_attempts):
        endpoint = MIRRORS[attempt % len(MIRRORS)]
        try:
            response = requests.post(
                endpoint, data={"data": query}, headers=HEADERS, timeout=timeout + 20
            )
            if response.status_code == 200:
                return response.json()
            # 429 = rate limited, 504 = gateway timeout: both are worth retrying.
            last_error = f"HTTP {response.status_code}"
        except Exception as exc:  # network flake, JSON decode, whatever
            last_error = f"{type(exc).__name__}"

        delay = min(60.0, 2.0 * (2**attempt)) * (0.5 + random.random())
        host = endpoint.split("//")[1].split("/")[0]
        print(f"      retry {attempt + 1}/{max_attempts} ({host}: {last_error}) "
              f"sleeping {delay:.0f}s", flush=True)
        time.sleep(delay)

    raise RuntimeError(f"all mirrors failed after {max_attempts} attempts: {last_error}")


def fetch_tiles(kind: str, bbox, rows: int, cols: int, cache_dir: Path, timeout: int):
    """Fetch every tile for one feature kind, caching each to disk as it lands."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    elements: list[dict] = []
    tiles = list(tile_bbox(bbox, rows, cols))

    for index, (r, c, tb) in enumerate(tiles, start=1):
        cache_file = cache_dir / f"{kind}_r{r}c{c}.json"
        if cache_file.exists():
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
            print(f"  [{index}/{len(tiles)}] {kind} r{r}c{c}: cached "
                  f"({len(payload.get('elements', []))} elements)", flush=True)
        else:
            bbox_str = ",".join(f"{v:.5f}" for v in tb)
            query = QUERIES[kind].format(t=timeout, bbox=bbox_str, classes=DRIVABLE)
            print(f"  [{index}/{len(tiles)}] {kind} r{r}c{c}: fetching...", flush=True)
            payload = run_query(query, timeout)
            cache_file.write_text(json.dumps(payload), encoding="utf-8")
            print(f"      got {len(payload.get('elements', []))} elements", flush=True)
            time.sleep(1.5)  # be a good citizen between tile requests

        elements.extend(payload.get("elements", []))

    return elements


# ------------------------------------------------------------------------ convert


def parse_height(tags: dict) -> tuple[float | None, str]:
    """Return (height_in_metres, source) from OSM tags. Source is 'osm' or 'none'."""
    raw = tags.get("height") or tags.get("building:height")
    if raw:
        text = str(raw).strip().lower()
        try:
            if text.endswith("'"):  # feet, e.g. 120'
                return float(text.rstrip("'")) * FEET_PER_METRE, "osm"
            if "ft" in text:
                return float(text.replace("ft", "").strip()) * FEET_PER_METRE, "osm"
            value = float(text.replace("m", "").strip())
            if 1.0 <= value <= 900.0:
                return value, "osm"
        except ValueError:
            pass

    levels = tags.get("building:levels")
    if levels:
        try:
            value = float(str(levels).split(";")[0].strip()) * DEFAULT_STOREY_HEIGHT
            if 1.0 <= value <= 900.0:
                return value, "osm"
        except ValueError:
            pass

    return None, "none"


def ring_from_geometry(geometry: list[dict]) -> list[list[float]] | None:
    """Overpass 'out geom' gives [{lat, lon}, ...]; convert to a closed GeoJSON ring."""
    if not geometry or len(geometry) < 4:
        return None
    ring = [[round(p["lon"], 7), round(p["lat"], 7)] for p in geometry if "lon" in p]
    if len(ring) < 4:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    if len(ring) < 4:
        return None
    return ring


def ring_area_m2(ring: list[list[float]]) -> float:
    """Shoelace area in m^2, using a local equirectangular projection."""
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    mx = 111320.0 * math.cos(lat0)
    my = 110540.0
    total = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * mx, ring[i][1] * my
        x2, y2 = ring[i + 1][0] * mx, ring[i + 1][1] * my
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def buildings_to_geojson(elements: list[dict]) -> dict:
    features, seen = [], set()
    for element in elements:
        if element.get("type") != "way" or element["id"] in seen:
            continue
        ring = ring_from_geometry(element.get("geometry", []))
        if ring is None:
            continue
        area = ring_area_m2(ring)
        if area < 20.0:  # sheds, bin stores: noise in a city-scale twin
            continue

        seen.add(element["id"])
        tags = element.get("tags", {})
        height, source = parse_height(tags)
        features.append({
            "type": "Feature",
            "id": f"b{element['id']}",
            "properties": {
                "osm_id": element["id"],
                "name": tags.get("name"),
                "building": tags.get("building", "yes"),
                "amenity": tags.get("amenity"),
                "shop": tags.get("shop"),
                "height": height,
                "height_source": source,
                "area_m2": round(area, 1),
            },
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })
    return {"type": "FeatureCollection", "features": features}


def roads_to_geojson(elements: list[dict]) -> dict:
    features, seen = [], set()
    for element in elements:
        if element.get("type") != "way" or element["id"] in seen:
            continue
        geometry = element.get("geometry") or []
        if len(geometry) < 2:
            continue
        seen.add(element["id"])
        tags = element.get("tags", {})
        line = [[round(p["lon"], 7), round(p["lat"], 7)] for p in geometry if "lon" in p]
        features.append({
            "type": "Feature",
            "id": f"r{element['id']}",
            "properties": {
                "osm_id": element["id"],
                "name": tags.get("name"),
                "highway": tags.get("highway"),
                "oneway": tags.get("oneway", "no"),
                "maxspeed": tags.get("maxspeed"),
            },
            "geometry": {"type": "LineString", "coordinates": line},
        })
    return {"type": "FeatureCollection", "features": features}


def landcover_class(tags: dict) -> str | None:
    """One drawing class per feature: what it looks like from the air."""
    leisure, landuse, natural = tags.get("leisure"), tags.get("landuse"), tags.get("natural")
    if tags.get("waterway"):
        return "drain" if tags["waterway"] in {"drain", "ditch"} else "river"
    if natural in {"water", "wetland"} or landuse in {"reservoir", "basin"}:
        return "water"
    if leisure == "pitch":
        return "pitch"
    if leisure in {"playground"}:
        return "playground"
    if leisure in {"park", "garden", "recreation_ground", "common", "dog_park", "nature_reserve",
                   "golf_course"} or landuse in {"recreation_ground", "village_green"}:
        return "park"
    if natural in {"wood"} or landuse in {"forest", "orchard", "plantation"}:
        return "wood"
    if landuse in {"grass", "meadow", "greenfield", "cemetery"} or natural in {"scrub", "grassland", "heath"}:
        return "grass"
    if landuse in {"construction", "brownfield"}:
        return "construction"
    return None


def landcover_to_geojson(elements: list[dict]) -> dict:
    """Areas become Polygons (a multipolygon relation contributes its outer rings);
    waterways stay LineStrings."""
    features, seen = [], set()
    for element in elements:
        key = (element.get("type"), element.get("id"))
        if key in seen:
            continue
        seen.add(key)
        tags = element.get("tags", {})
        cls = landcover_class(tags)
        if cls is None:
            continue
        props = {"osm_id": element["id"], "class": cls, "name": tags.get("name"),
                 "leisure": tags.get("leisure"), "landuse": tags.get("landuse"),
                 "natural": tags.get("natural"), "sport": tags.get("sport")}
        if element["type"] == "way" and cls in {"drain", "river"}:
            line = [[round(q["lon"], 7), round(q["lat"], 7)] for q in element.get("geometry", [])
                    if "lon" in q]
            if len(line) >= 2:
                features.append({"type": "Feature", "id": f"w{element['id']}", "properties": props,
                                 "geometry": {"type": "LineString", "coordinates": line}})
            continue
        if element["type"] == "way":
            rings = [ring_from_geometry(element.get("geometry", []))]
        else:
            rings = [ring_from_geometry(m.get("geometry", [])) for m in element.get("members", [])
                     if m.get("type") == "way" and m.get("role") in ("outer", "")]
        for i, ring in enumerate(r for r in rings if r):
            area = ring_area_m2(ring)
            if area < 50.0:
                continue
            features.append({"type": "Feature", "id": f"{element['type'][0]}{element['id']}-{i}",
                             "properties": {**props, "area_m2": round(area, 1)},
                             "geometry": {"type": "Polygon", "coordinates": [ring]}})
    # Big areas first, so smaller ones (a pitch inside a park) draw on top.
    features.sort(key=lambda f: -f["properties"].get("area_m2", 0))
    return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------- main


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fetch OSM data for the JiranSync township map.")
    parser.add_argument("--bbox", default="3.169,101.502,3.191,101.526",
                        help="south,west,north,east")
    parser.add_argument("--out", default="data", type=Path)
    parser.add_argument("--rows", type=int, default=3)
    parser.add_argument("--cols", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--kinds", default="buildings,roads",
                        help=f"comma-separated subset of {sorted(QUERIES)}")
    args = parser.parse_args(argv)

    bbox = tuple(float(v) for v in args.bbox.split(","))
    if len(bbox) != 4:
        parser.error("--bbox needs exactly 4 comma-separated numbers")

    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
    unknown = set(kinds) - set(QUERIES)
    if unknown:
        parser.error(f"unknown kind(s): {sorted(unknown)}")

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = out_dir / "raw"

    print(f"AOI {bbox}  ->  {args.rows}x{args.cols} tiles, kinds={kinds}\n")

    written = []
    for kind in kinds:
        print(kind.replace("_", " ").title())
        elements = fetch_tiles(kind, bbox, args.rows, args.cols, cache_dir, args.timeout)
        if kind == "roads":
            collection = roads_to_geojson(elements)
        elif kind == "landcover":
            collection = landcover_to_geojson(elements)
        else:
            collection = buildings_to_geojson(elements)

        path = out_dir / OUTPUT_NAMES[kind]
        path.write_text(json.dumps(collection), encoding="utf-8")
        written.append(path)

        features = collection["features"]
        print(f"\n  {kind}: {len(features)} features")
        if kind == "landcover":
            from collections import Counter
            print("    " + ", ".join(f"{k} {n}" for k, n in
                                     Counter(f["properties"]["class"] for f in features).most_common()))
        if kind not in ("roads", "landcover"):
            tagged = sum(1 for f in features
                         if f["properties"]["height_source"] == "osm")
            print(f"    with height  {tagged} ({100 * tagged / max(len(features), 1):.1f}%)"
                  f" -> {len(features) - tagged} need imputation")
            tallest = sorted(
                ((f["properties"]["height"], f["properties"].get("name") or "unnamed")
                 for f in features if f["properties"]["height"]),
                reverse=True,
            )[:5]
            for height, name in tallest:
                print(f"      {height:6.1f} m  {name}")
        print()

    print("=" * 58)
    for path in written:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
