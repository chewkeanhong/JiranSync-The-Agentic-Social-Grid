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

## Two views: resident and SDP admin

The account menu (your avatar, top right) switches who you are. `?admin=1` opens the admin view.

| | Resident | SDP admin |
|---|---|---|
| Neighbours on the map | Anonymous dots, plus the neighbour on your own job (face and route) while it runs | Everyone, by name and status |
| Requests | Open requests, pinned on the street rather than at a door; ones you were picked for glow *Good match for you* | Every request, with who asked, who was pinged and who took it (arcs) |
| Shops | What each one offers, and how far away it is | Credits collected, and what they cash out for |
| SDP events | Join or leave; *You're going* | Create, start, end and pay, cancel; see every volunteer |
| Left panel | Ask the grid, My tasks, Community (events + anonymous highlights), Credits | Live, Merchants, Events, Economy, 3D Demo |

Developer details (connection, AI engine, counters, *Simulate no-show*) belong to the admin
side. Turn them on with the **Dev** button at the bottom of the admin rail, or `?dev=1`.

## Asking for help: offers, then you choose

Most neighbourly help is planned, not urgent: *look after my baby tomorrow evening*. So
help is not first-come. It runs in four steps:

1. **Ask.** The AI reads the request (what, when, how long). The formula prices it, and
   "tomorrow evening" becomes a booking for tomorrow at 19:00. The draft shows **When**
   and **How long** filled in from the text; you can change either, and the price follows.
   When the request doesn't say when, you must pick a day (or *As soon as possible*)
   before you can post. A request too vague to match ("help me") is nudged to say what
   the help is.
2. **Ping three.** Matching ranks neighbours on skill, walking time, free time and
   reliability, plus *who you know*, and pings three. When one of the top two is someone
   you already know, the third is the best match you have **never** dealt with, tagged
   *New to you · meet a neighbour*. The grid keeps introducing people.
3. **Offers.** The three, or anyone nearby, tap **Offer to help**. Nothing is held yet.
4. **Choose.** The requester sees each offer with its reasons and what connects them:
   - *Helped you twice before*
   - *You're both going to Eco Lake clean-up*
   - *Lives around the corner*
   - *New to you*

   The best fit is marked **Recommended**. Choosing holds the credits in escrow and books
   the job; the other offers close politely.

The job then runs as before: GPS arrival, the requester confirms, credits are released.
A no-show refunds the credits and reopens the other offers. A request nobody was chosen for
expires an hour after its time, and nothing was ever charged.

Rides keep first-to-accept, and so does asking one neighbour by name: a lift is urgent,
and any driver going that way will do. In demo mode the pinged neighbours send their offers
by themselves, a few seconds apart, and the presenter chooses.

## SDP community events

SDP hosts events (a lake clean-up, a gotong-royong, tree planting) and one-off civic jobs
(photograph a broken streetlight). A one-off job is an event with one place and no start time.

1. **Create** (admin, Events tab): title, what volunteers do, where (a named park or lake,
   any building's card, or *Pick on map*), day and time, length, places, credits each.
2. **Join** (resident, Community tab or the event's pin): the places count down.
3. **Start**: at its time, or with *Start now*. Everyone who joined walks to the venue, and
   GPS checks each one in on arrival.
4. **End & pay**: at its end time, or with *End & pay*. SDP mints the reward to everyone
   checked in. Anyone who never arrived is not paid. A one-off job pays as soon as its
   volunteer arrives.

In demo mode (the clock menu's *Best match accepts automatically*), neighbours also sign up
for events on their own, always leaving a place free for the presenter.

## The demo, in six steps

The seeded community includes two personas written for the pitch's user flow.

1. You start as **Aisyah**, a verified resident with the 3-credit welcome grant. Around her
   home, neighbours are anonymous dots; requests and SDP events are pins.
   Under **Ask the grid**, click the **Ride** chip, then **Ask JiranSync**.
2. The AI turns the request into a ride to MRT Kwasa Damansara and prices it at **3
   credits**: 15 min detour, plus RM4.68 of petrol and wear.
3. Neighbours who already drive to that station are ranked, with their reasons, and
   arcs fly from their homes on the map. Click **Post request**.
4. Open the account menu (your avatar, top right) and view the app as **Daniel**, who drives
   to the MRT. Tap Aisyah's ride pin; **Offer this ride** locks the 3 credits in escrow.
5. Daniel's car drives to Aisyah's door, picks her up and heads for the station. When GPS
   shows both have arrived, the task completes and the escrow is released.
6. Tap **Kopi Jiran Cafe** and **Redeem 3** for RM6 off. As **SDP Admin**, the Merchants
   tab shows what the cafe collected and lets it cash the credits out with SDP, RM2 each.

Other things to try:

- The **Babysit** chip: *"Look after my baby for an hour tomorrow evening"* (3 credits,
  booked for tomorrow 19:00). Aisyah's seeded circle makes the three pings tell the
  connectivity story: Rajesh has *helped you twice before*, Nadia is *going to the Eco Lake
  clean-up with you*, and Liyana is *new to you*. Offers arrive by themselves; open the
  request and **Choose**.
- *"Fix my leaking tap and help carry a new cabinet upstairs tonight"* is split into a
  plumbing micro-task and a moving micro-task, each with its own price and neighbours.
- *"The wiring keeps tripping, need an electrician"* is offered to a commercial tenant
  when no one nearby has the skill.
- As SDP Admin in developer mode, **Simulate no-show** on an accepted job: the helper's GPS
  freezes, the escrow is refunded, and the helper takes a reliability strike.
- Join **Report a broken streetlight** (Community tab): Aisyah walks over, GPS checks her in,
  and SDP pays her 2 credits on arrival.

## Architecture

```
web/                         one page, no build step, no UI framework
  app.js      map core       deck.gl township: buildings + facade shader, roads, DEM
                             terrain, camera, picking, the floating card; exposes `hooks`
  facade.js   shader         windows, glass and night lighting on the 3D buildings
  jiran.js    app            state, the resident and admin views, who is on the map and in
                             what state, deck overlays (routes, arcs, anonymous dots), wiring
  components/
    icons.js                 self-drawn SVG icon set, the six categories, people states
    avatar.js                a stable illustrated portrait per resident id
    markers.js               people, request pins and places as HTML on the 3D map
    cards.js                 request / neighbour / shop / station / SDP event cards
    panels.js                header, search, notifications, Ask JiranSync, lists, wallet,
                             rewards, community highlights; admin Live / Merchants /
                             Events / Economy; category filter, legend
jiransync/
  geo.py, terrain.py         local metre frame, polygons, Copernicus DEM
  routing.py                 street graph, A*, walk and drive modes, flood-aware
  township.py                buildings and their roles (home / shop / civic / transit)
  store.py                   SQLite: residents, tasks, tenants, SDP events and sign-ups,
                             the activity log, double-entry ledger
  credits.py                 Jiran Credits rules: grant, escrow, release, refund,
                             event rewards, redeem, shop cash-out
  agent.py                   request -> structured task (Claude, or rules)
  valuation.py               time + capital cost x skill x urgency -> credit range
  matching.py                rank neighbours: skill, walking time, schedule, reliability,
                             and who you know (past favours, shared SDP events)
  fallback.py                route to an SDP tenant when nobody nearby can help
  fraud.py                   circular-trading flags, no-show strikes
  grid.py                    task and SDP event lifecycles + simulated movement and GPS checks
  seed.py                    deterministic demo community (40 residents, tasks, SDP events)
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
- Credits enter circulation only from SDP: the 3-credit welcome grant, and the reward for
  volunteering at an SDP event. Peer-to-peer help moves credits and never creates them.
- 1 credit = RM2 off at a tenant. A tenant cashes its credits out with SDP at the same
  RM2, so a discount given in credits never costs the shop. The credits go back to SDP's
  treasury and leave circulation.

### API

| Method & path | Purpose |
|---|---|
| `GET /api/world`, `/api/roads`, `/api/terrain` | Township geometry, hubs, tenants |
| `GET /api/residents`, `/api/me?resident=` | Roster; one resident's wallet, ledger, tasks |
| `POST /api/tasks/draft` `{actor, text}` | Understand, value and preview matches (saves nothing) |
| `POST /api/tasks` `{actor, understanding, credits?}` | Post (bundles become micro-tasks) |
| `GET /api/tasks[?status=]`, `/api/tasks/{id}` | Tasks; one task with candidates, escrow |
| `POST /api/tasks/{id}/offer\|withdraw` `{actor}` | A neighbour offers to help, or takes it back |
| `POST /api/tasks/{id}/choose` `{actor, helper}` | The requester chooses an offer; credits are held from now |
| `POST /api/tasks/{id}/accept\|complete\|cancel` `{actor}` | Lifecycle (accept is for rides and direct asks) |
| `POST /api/tasks/{id}/ghost` | Demo: make the helper a no-show |
| `GET /api/tenants`, `POST /api/tenants/{id}/redeem\|cashout` | Spending credits; a shop cashing them out |
| `GET\|POST /api/community-events` | SDP events; create one `{title, place_name, lon, lat, start_at?, duration_min, slots, credits}` |
| `POST /api/community-events/{id}/join\|leave` `{actor}` | A resident signs up or drops out |
| `POST /api/community-events/{id}/start\|end\|cancel` | SDP runs the event; `end` pays everyone checked in |
| `GET /api/economy`, `GET /api/agent` | Ledger totals; which AI engine is on |
| `GET /api/route?mode=walk\|drive` | A route over the street graph |
| `WS /ws` | Snapshots: clock, moving neighbours, live tasks, SDP events, activity, anonymous highlights |
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

- the ledger rules: zero-sum, escrow, event rewards, shop cash-out;
- valuation;
- the rule engine and the clamping of Claude's output;
- matching over a hand-built street grid;
- fraud and no-show handling;
- the whole task lifecycle: offers, choosing, booking a time, and SDP events (join, GPS
  check-in, pay, no-shows);
- connectivity: past favours rank higher and say so;
- the pitch's six-step flow end to end over HTTP on the real Elmina data (`tests/test_api.py`);
- the kept map-core tests (geometry, terrain, routing).

## License

MIT, see [LICENSE](LICENSE).
