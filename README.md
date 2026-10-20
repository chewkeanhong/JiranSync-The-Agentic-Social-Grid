# JiranSync — The Agentic Social Grid

**A hyper-local, AI-driven time and resource exchange for Sime Darby Property townships.**
Prototype on a real 3D model of **City of Elmina, Shah Alam**.

Neighbours live metres apart and still don't know who could help them. JiranSync turns
the township into a live grid: a resident types what they need, an AI works out what it
means and what it's worth, the right neighbours nearby get pinged, credits are held in
escrow, and the job closes itself when GPS shows it's done. Credits earned can be spent
at SDP's own shop-lot tenants.

---

## Run it

```bash
pip install -r requirements.txt
python -m uvicorn jiransync.server:app --port 8000
# or: docker compose up
```

Open <http://localhost:8000>. The app works offline: deck.gl is vendored, and the map is
drawn from committed OSM geometry and terrain. There are no map tiles.

**Claude (optional).** Set `ANTHROPIC_API_KEY` and requests are understood by Claude
(`claude-opus-5-5` by default; override with `JIRANSYNC_MODEL`). With no key, a
deterministic rule engine answers instead. The header badge shows which engine is
active. Any API error falls back to rules for that request, so a draft is never lost.

| Variable | Default | Meaning |
|---|---|---|
| `JIRANSYNC_DATA` | `data` | Township data directory (another township is an env var, not a code change) |
| `JIRANSYNC_DB` | `data/jiransync.db` | SQLite file for residents, tasks and the ledger; seeded on first start |
| `JIRANSYNC_MODEL` | `claude-opus-5-5` | Model used for task understanding |
| `JIRANSYNC_AGENT` | — | Set to `rules` to force the rule engine |
| `JIRANSYNC_CLOCK` | `auto` | `manual` stops the simulated clock (used by tests) |

Developer details (connection, AI engine, counters, the SDP console, *Simulate no-show*) are
hidden from residents. Turn them on with the **Dev** button at the bottom of the left rail,
the account menu, or `?dev=1`.

## The demo, in six steps

The seeded community includes two personas written for the pitch's user flow.

1. You start as **Aisyah**, a verified resident with the 3-credit welcome grant. The map
   shows your neighbours as faces: green is free, amber is on a job, blue is on the move.
   Under **Ask the grid**, click the **Ride** chip, then **Ask JiranSync**.
2. The AI turns the request into a ride to MRT Kwasa Damansara and prices it at **3
   credits**: 15 min detour, plus RM4.68 of petrol and wear.
3. Neighbours who already drive to that station are ranked, with their reasons, and
   arcs fly from their homes on the map. Click **Post request**.
4. Open the account menu (your avatar, top right) and view the app as **Daniel**, who drives
   to the MRT. Tap Aisyah's ride pin; **Offer this ride** locks the 3 credits in escrow.
5. Daniel's car drives to Aisyah's door, picks her up and heads for the station. When GPS
   shows both have arrived, the task completes and the escrow is released.
6. Tap **Kopi Jiran Cafe** and **Redeem 3** for RM6 off. In developer mode, the SDP console
   (Community section) lets the cafe claim its rent rebate, capped at 5% of rent.

Other things to try:

- *"Fix my leaking tap and help carry a new cabinet upstairs tonight"* is split into a
  plumbing micro-task and a moving micro-task, each with its own price and neighbours.
- *"The wiring keeps tripping, need an electrician"* is offered to a commercial tenant
  when no one nearby has the skill.
- In developer mode, **Simulate no-show** on an accepted job: the helper's GPS freezes,
  the escrow is refunded, and the helper takes a reliability strike.
- Take an **SDP bounty**: the reward is minted by SDP and paid on a geo-tagged proof.

## Architecture

```
web/                         one page, no build step, no UI framework
  app.js      map core       deck.gl township: buildings + facade shader, roads, DEM
                             terrain, camera, picking, the floating card; exposes `hooks`
  facade.js   shader         windows, glass and night lighting on the 3D buildings
  jiran.js    app            state, who is on the map and in what state, deck overlays
                             (routes, match arcs, station arcs), selection, wiring
  components/
    icons.js                 self-drawn SVG icon set, the six categories, people states
    avatar.js                a stable illustrated portrait per resident id
    markers.js               people, request pins and places as HTML on the 3D map
    cards.js                 request / neighbour / shop / station cards
    panels.js                header, search, notifications, Ask JiranSync, lists,
                             wallet, rewards, activity, category filter, legend
jiransync/
  geo.py, terrain.py         local metre frame, polygons, Copernicus DEM
  routing.py                 street graph, A*, walk and drive modes, flood-aware
  township.py                buildings and their roles (home / shop / civic / transit)
  store.py                   SQLite: residents, tasks, tenants, events, double-entry ledger
  credits.py                 Jiran Credits rules: grant, escrow, release, refund,
                             redeem, 5%-capped rent rebate
  agent.py                   request -> structured task (Claude, or rules)
  valuation.py               time + capital cost x skill x urgency -> credit range
  matching.py                rank neighbours: skill, walking time, schedule, reliability
  fallback.py                route to an SDP tenant when nobody nearby can help
  fraud.py                   circular-trading flags, no-show strikes
  grid.py                    task lifecycle + simulated movement and GPS checks
  seed.py                    deterministic demo community (40 residents, tasks, bounties)
  api.py, server.py          FastAPI HTTP API + WebSocket snapshots at 4 Hz
```

**Who decides what.** The language model only *proposes* a structured task, and its
output is clamped to the platform's own vocabulary. Who gets pinged (`matching.py`), the
price range (`valuation.py`) and every credit movement (`credits.py`) are deterministic
code, so the same request always ranks the same neighbours, and every rank comes with
its reasons.

### Jiran Credits

- The ledger is append-only double entry; balances are sums, and the books always total
  zero (`/api/economy`).
- Credits enter circulation only from SDP: the 3-credit welcome grant, and bounties.
  Peer-to-peer help moves credits and never creates them.
- 1 credit = RM2 off at a tenant. A tenant can return credits to SDP for a rent rebate
  capped at 5% of monthly rent. Credits over the cap stay with the tenant.

### API

| Method & path | Purpose |
|---|---|
| `GET /api/world`, `/api/roads`, `/api/terrain` | Township geometry, hubs, tenants |
| `GET /api/residents`, `/api/me?resident=` | Roster; one resident's wallet, ledger, tasks |
| `POST /api/tasks/draft` `{actor, text}` | Understand, value and preview matches (saves nothing) |
| `POST /api/tasks` `{actor, understanding, credits?}` | Post (bundles become micro-tasks) |
| `GET /api/tasks[?status=]`, `/api/tasks/{id}` | Tasks; one task with candidates, escrow |
| `POST /api/tasks/{id}/accept\|complete\|cancel` `{actor}` | Lifecycle |
| `POST /api/tasks/{id}/ghost` | Demo: make the helper a no-show |
| `GET /api/tenants`, `POST /api/tenants/{id}/redeem\|rebate` | Rewards and rebates |
| `GET\|POST /api/bounties` | SDP bounties |
| `GET /api/economy`, `GET /api/agent` | Ledger totals; which AI engine is on |
| `GET /api/route?mode=walk\|drive` | A route over the street graph |
| `WS /ws` | Snapshots: clock, moving neighbours, live tasks, activity |
| `POST /api/admin/reset` | Reseed the demo community |

Rule violations return `400 {"error": "..."}`, with a message written for the resident.

## Data

| File | Source |
|---|---|
| `data/buildings.geojson`, `roads.geojson` | OpenStreetMap, City of Elmina (bbox 3.169,101.502 to 3.191,101.526), `scripts/fetch_osm.py` |
| `data/terrain.json` | Copernicus GLO-30 DEM, `scripts/fetch_dem.py` |
| `data/places.json` | Hand-authored: two real stations, and four tenants pinned to the nearest real shop-lot |
| `data/train_buildings.geojson` | Labelled buildings from the wider Klang Valley, used to train the height imputer |

Only 15 Elmina footprints carry a surveyed height. The rest are imputed by
`scripts/impute_heights.py`, with low-rise homes capped at two storeys, and are marked
`height_source: "imputed"`.

Rebuild the data:

```bash
pip install -r requirements-dev.txt
python scripts/fetch_osm.py --bbox 3.169,101.502,3.191,101.526 --out data
python scripts/impute_heights.py --train-extra data/train_buildings.geojson
python scripts/fetch_dem.py --data data
```

## What is simulated

This is a prototype. It does not pretend otherwise.

| Simulated | How |
|---|---|
| **Verification** | The account menu's "view as" list stands in for checking residents against the SDP property roll. Seeded residents count as verified. Names are invented. |
| **GPS** | Residents walk and drive along the real street graph at real speeds, played 10x faster. The arrival, no-show and geo-tagged proof checks read these simulated positions, the same checks a phone's location would feed. |
| **Tenants** | The four tenants are fictional businesses, placed in real shop-lot footprints. |
| **Stations** | The stations are off the map. Trips drive to the road where the township meets them, and an arc shows the rest. |
| **Help tasks** | Help tasks auto-confirm once the helper has been on site for the job's estimated time, unless the requester confirms sooner. |

## Tests

```bash
pip install pytest httpx
pytest tests/ -q
```

The suite covers:

- the ledger rules: zero-sum, escrow, the rebate cap;
- valuation;
- the rule engine and the clamping of Claude's output;
- matching over a hand-built street grid;
- fraud and no-show handling;
- the whole task lifecycle;
- the pitch's six-step flow end to end over HTTP on the real Elmina data (`tests/test_api.py`);
- the kept map-core tests (geometry, terrain, routing).

## License

MIT, see [LICENSE](LICENSE).
