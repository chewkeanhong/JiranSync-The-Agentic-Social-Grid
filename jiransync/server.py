"""FastAPI server: owns the clock, streams state, serves the web app.

The browser is a pure renderer for the map. Static geometry (building footprints, roads,
terrain) goes over HTTP once and is cached; only the mutable state -- where residents
are, which tasks are live, the activity feed -- rides the WebSocket, at a few frames a
second. Actions (post, accept, redeem) are plain HTTP in ``api.py``.

Community state lives in SQLite at ``$JIRANSYNC_DB`` (default ``data/jiransync.db``) and
is seeded on first start, or whenever the township it was seeded against changes.

    python -m uvicorn jiransync.server:app --port 8000
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import seed as seeding
from .api import router
from .grid import TIME_SCALE, GridError, SocialGrid
from .routing import MODES, RoadNetwork
from .store import Store
from .township import Township

DATA_DIR = Path(os.environ.get("JIRANSYNC_DATA", "data"))
DB_PATH = os.environ.get("JIRANSYNC_DB", str(DATA_DIR / "jiransync.db"))
WEB_DIR = Path(__file__).resolve().parents[1] / "web"

# Wall-clock seconds between pushed frames.
FRAME_PERIOD_S = 0.25

# "manual" stops the clock advancing on its own -- for tests that step it themselves.
AUTO_CLOCK = os.environ.get("JIRANSYNC_CLOCK", "auto").lower() != "manual"


class Engine:
    """Holds the township and its road networks, and drives the clock."""

    def __init__(self) -> None:
        self.township: Township | None = None
        self.networks: dict[str, RoadNetwork] = {}
        self.grid: SocialGrid | None = None
        self.places: dict = {}
        self.clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    def load(self) -> None:
        self.township = Township.load(DATA_DIR)
        self.networks = {
            mode: RoadNetwork.load(DATA_DIR / "roads.geojson", self.township.frame,
                                   terrain=self.township.terrain, mode=mode)
            for mode in MODES
        }
        self.places = SocialGrid.load_places(DATA_DIR)
        self.grid = SocialGrid(self.township, self.networks, Store(DB_PATH), self.places,
                               auto_accept=os.environ.get("JIRANSYNC_AUTO_ACCEPT", "1") != "0")
        # Reseed when the database is empty or was built against a different township:
        # residents must live in buildings that exist on this map.
        signature = self._signature()
        if not self.grid.store.residents() or self.grid.store.get_meta("township") != signature:
            seeding.seed(self.grid)
            self.grid.store.set_meta("township", signature)
        seeding.backfill_profiles(self.grid.store)
        self.grid.resume_auto_accept()

    def _signature(self) -> str:
        """What the database was seeded for: this township, and this shape of community."""
        return (f"{self.places.get('name')}|{len(self.township.buildings)}"
                f"|seed{seeding.SEED_VERSION}")

    async def reseed(self) -> None:
        async with self._lock:
            seeding.seed(self.grid)
            self.grid.store.set_meta("township", self._signature())
        await self.push()

    def static_payload(self) -> dict:
        """Everything that never changes, fetched once by the client."""
        town = self.township
        buildings = json.loads((DATA_DIR / "buildings.geojson").read_text(encoding="utf-8"))
        # Parks, fields, lakes and drains from OSM (scripts/fetch_osm.py --kinds landcover).
        # Optional: a township without it simply has no green and blue layer.
        cover_path = DATA_DIR / "landcover.geojson"
        landcover = (json.loads(cover_path.read_text(encoding="utf-8")) if cover_path.exists()
                     else {"type": "FeatureCollection", "features": []})
        # The real surroundings of each off-map station (scripts/fetch_station_context.py):
        # drawn round the 3D stations, never routed through.
        stations_path = DATA_DIR / "stations.geojson"
        stations = (json.loads(stations_path.read_text(encoding="utf-8")) if stations_path.exists()
                    else {"type": "FeatureCollection", "features": []})
        lon, lat = town.centre_lonlat()
        return {
            "stations": stations,
            "name": self.places.get("name", "Township"),
            "developer": self.places.get("developer"),
            "buildings": buildings,
            "landcover": landcover,
            "roles": {b.id: b.role for b in town.buildings},
            "hubs": self.grid.hubs if self.grid else [],
            "tenants": self.grid.store.tenants() if self.grid else [],
            "centre": {"lon": lon, "lat": lat},
            # The projection origin, so the client measures distances in the same frame
            # the server does rather than in a slightly different one of its own.
            "frame": {"origin_lon": town.frame.origin_lon,
                      "origin_lat": town.frame.origin_lat},
            "centroids": {
                b.id: [round(float(v), 7) for v in town.frame.to_lonlat(*b.centroid_xy)]
                for b in town.buildings
            },
        }

    def snapshot(self) -> dict:
        return self.grid.snapshot() if self.grid else {"t": 0.0}

    async def push(self) -> None:
        """Send a frame now rather than waiting for the next tick."""
        async with self._lock:
            payload = self.snapshot()
        await self.broadcast(payload)

    async def broadcast(self, payload: dict) -> None:
        if not self.clients:
            return
        message = json.dumps(payload)
        dead = []
        for client in list(self.clients):
            try:
                await client.send_text(message)
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)

    async def run_loop(self) -> None:
        """Advance the clock in wall-clock time and push frames."""
        while True:
            await asyncio.sleep(FRAME_PERIOD_S)
            async with self._lock:
                if self.grid is not None and AUTO_CLOCK:
                    try:
                        self.grid.step(FRAME_PERIOD_S * TIME_SCALE)
                    except Exception as err:   # a bad tick must not kill the clock
                        print(f"tick failed: {err!r}")
                payload = self.snapshot()
            await self.broadcast(payload)


engine = Engine()


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine.load()
    task = asyncio.create_task(engine.run_loop())
    yield
    task.cancel()


app = FastAPI(title="JiranSync", lifespan=lifespan)
app.state.engine = engine
app.include_router(router)


@app.exception_handler(GridError)
async def grid_error(request: Request, err: GridError):
    return JSONResponse({"error": str(err)}, status_code=400)


@app.middleware("http")
async def always_revalidate(request, call_next):
    """Make the browser check with the server before reusing anything it has cached.

    `no-cache` does not disable caching: an unchanged file comes back as a cheap 304, but
    an edited app.js is never served stale from a heuristic cache lifetime.
    """
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.get("/api/world")
async def get_world():
    return JSONResponse(engine.static_payload())


@app.get("/api/roads")
async def get_roads():
    """Road geometry, drawn by the client instead of a basemap.

    Rendering our own roads rather than fetching map tiles is what makes the app work
    with no network at all.
    """
    return FileResponse(DATA_DIR / "roads.geojson", media_type="application/json")


@app.get("/api/terrain")
async def get_terrain():
    """The DEM grid, so the client can shade the ground it is drawing on."""
    path = DATA_DIR / "terrain.json"
    if not path.exists():
        return JSONResponse({"error": "no terrain baked"}, status_code=404)
    return FileResponse(path, media_type="application/json")


@app.get("/api/route")
async def route(from_lon: float, from_lat: float, to_lon: float, to_lat: float,
                mode: str = "walk"):
    """A walking or driving route between two points, as a GeoJSON Feature."""
    network = engine.networks.get(mode)
    if network is None:
        return JSONResponse({"error": f"mode must be one of {list(MODES)}"}, status_code=400)
    answer = network.get_resilient_route((from_lon, from_lat), (to_lon, to_lat),
                                         network.water_level)
    feature = answer.to_geojson(network.frame)
    feature["properties"]["mode"] = mode
    return feature


@app.websocket("/ws")
async def websocket_endpoint(socket: WebSocket):
    await socket.accept()
    engine.clients.add(socket)
    try:
        await socket.send_text(json.dumps(engine.snapshot()))
        while True:
            # The client never drives the clock; this just keeps the socket open and
            # notices when it goes away.
            await socket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        engine.clients.discard(socket)


@app.get("/")
async def index():
    return FileResponse(WEB_DIR / "index.html")


if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
