"""Fetch the real surroundings of each transit hub from OpenStreetMap.

The hubs in data/places.json are real stations outside the township's map area. To draw
them as stations rather than floating labels, the map needs what is around them: the
rail lines (and whether they are on a viaduct), the platforms, the station buildings,
and the roads and buildings nearby.

This is display context only. None of it joins the township's road graph or the routing:
the station area is drawn, not routed through.

    python scripts/fetch_station_context.py --data data

Writes data/stations.geojson. Every feature carries the hub id it belongs to.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_osm import DRIVABLE, parse_height, ring_from_geometry, ring_area_m2, run_query  # noqa: E402

# Half the side of the box fetched round each station, in degrees (~0.005 = 550 m).
RADIUS_DEG = 0.005

QUERY = (
    '[out:json][timeout:{t}];('
    'way["railway"~"^(rail|subway|light_rail|platform)$"]({bbox});'
    'way["public_transport"="platform"]({bbox});'
    'way["building"]({bbox});'
    'way["highway"~"^({classes})$"]({bbox});'
    'node["railway"~"^(station|halt)$"]({bbox});'
    'way["railway"="station"]({bbox});'
    ');out geom;'
)


def convert(elements: list[dict], hub: str) -> list[dict]:
    out, seen = [], set()
    for e in elements:
        key = (e["type"], e["id"])
        if key in seen:
            continue
        seen.add(key)
        tags = e.get("tags", {})
        props = {"hub": hub, "osm_id": e["id"], "name": tags.get("name")}
        if e["type"] == "node":
            props.update(kind="station_node", network=tags.get("network"), operator=tags.get("operator"))
            out.append({"type": "Feature", "properties": props,
                        "geometry": {"type": "Point", "coordinates": [e["lon"], e["lat"]]}})
            continue
        geom = e.get("geometry") or []
        line = [[round(p["lon"], 7), round(p["lat"], 7)] for p in geom if "lon" in p]
        rail = tags.get("railway")
        if rail in ("rail", "subway", "light_rail"):
            elevated = tags.get("bridge") in ("yes", "viaduct") or str(tags.get("layer", "0")) not in ("0", "", "-1")
            props.update(kind="rail", railway=rail, elevated=elevated, service=tags.get("service"),
                         usage=tags.get("usage"))
            out.append({"type": "Feature", "properties": props,
                        "geometry": {"type": "LineString", "coordinates": line}})
        elif rail == "platform" or tags.get("public_transport") == "platform":
            props.update(kind="platform")
            ring = ring_from_geometry(geom)
            out.append({"type": "Feature", "properties": props,
                        "geometry": ({"type": "Polygon", "coordinates": [ring]} if ring
                                     else {"type": "LineString", "coordinates": line})})
        elif tags.get("building") or rail == "station":
            ring = ring_from_geometry(geom)
            if not ring or ring_area_m2(ring) < 20:
                continue
            height, source = parse_height(tags)
            props.update(kind="building", building=tags.get("building", "yes"), station=rail == "station",
                         height=height, height_source=source, area_m2=round(ring_area_m2(ring), 1))
            out.append({"type": "Feature", "properties": props,
                        "geometry": {"type": "Polygon", "coordinates": [ring]}})
        elif tags.get("highway"):
            props.update(kind="road", highway=tags["highway"])
            out.append({"type": "Feature", "properties": props,
                        "geometry": {"type": "LineString", "coordinates": line}})
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data", default="data", type=Path)
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args(argv)
    places = json.loads((args.data / "places.json").read_text(encoding="utf-8"))
    cache = args.data / "raw"
    cache.mkdir(parents=True, exist_ok=True)
    features = []
    for hub in places.get("hubs", []):
        cache_file = cache / f"station_{hub['id']}.json"
        if cache_file.exists():
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
            print(f"{hub['name']}: cached")
        else:
            lat, lon = hub["lat"], hub["lon"]
            bbox = (f"{lat - RADIUS_DEG:.5f},{lon - RADIUS_DEG:.5f},"
                    f"{lat + RADIUS_DEG:.5f},{lon + RADIUS_DEG:.5f}")
            print(f"{hub['name']}: fetching...", flush=True)
            payload = run_query(QUERY.format(t=args.timeout, bbox=bbox, classes=DRIVABLE), args.timeout)
            cache_file.write_text(json.dumps(payload), encoding="utf-8")
        got = convert(payload.get("elements", []), hub["id"])
        kinds = {}
        for f in got:
            kinds[f["properties"]["kind"]] = kinds.get(f["properties"]["kind"], 0) + 1
        print(f"  {kinds}")
        features.extend(got)
    out = args.data / "stations.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    print(f"wrote {out} ({len(features)} features)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
