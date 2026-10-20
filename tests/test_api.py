"""The pitch's user flow, end to end over HTTP, on the real City of Elmina data.

1. A verified resident starts with the 3-credit welcome grant.
2. "Need a ride to the MRT" is understood and priced at about 3 credits.
3. Neighbours heading that way are pinged.
4. A neighbour accepts; the credits are locked in escrow.
5. GPS shows both arrived at the station; the driver is paid.
6. The driver redeems the credits at a local cafe for an RM discount, and the cafe
   claims its capped rent rebate from SDP.
"""

from __future__ import annotations

import os

import pytest

# Before the server module is imported: an in-memory database, the rule engine (so the
# test is deterministic and offline), and a clock only this test advances.
os.environ["JIRANSYNC_DB"] = ":memory:"
os.environ["JIRANSYNC_CLOCK"] = "manual"
os.environ["JIRANSYNC_AGENT"] = "rules"
# The pitch flow below accepts by hand; demo auto-accept has a test of its own.
os.environ["JIRANSYNC_AUTO_ACCEPT"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from jiransync.server import app, engine  # noqa: E402

ASKER, DRIVER = "R001", "R002"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def advance(seconds: float, step: float = 2.5) -> None:
    for _ in range(int(seconds / step)):
        engine.grid.step(step)


def test_world_serves_the_township_and_its_places(client):
    world = client.get("/api/world").json()
    assert world["name"] == "City of Elmina"
    assert len(world["buildings"]["features"]) > 500
    assert {h["id"] for h in world["hubs"]} == {"kwasa", "sgbuloh"}
    assert all(h["gateway"] for h in world["hubs"])
    assert len(world["tenants"]) == 4
    assert client.get("/api/agent").json()["engine"] == "rules"


def test_the_pitch_user_flow(client):
    # 1. Onboarding: verified, seeded with 3 credits.
    me = client.get("/api/me", params={"resident": ASKER}).json()
    assert me["verified"] and me["balance"] == 3

    # 2. Task creation: the AI understands and prices it.
    draft = client.post("/api/tasks/draft",
                        json={"actor": ASKER, "text": "Need a ride to the MRT tomorrow 8am"}).json()
    assert draft["understanding"]["kind"] == "ride"
    assert draft["task"]["dest_id"] == "kwasa"
    assert draft["valuation"]["suggested"] == 3

    # 3. Agentic match: drivers already heading to that station are pinged.
    assert draft["candidates"], "somebody must be pinged"
    assert DRIVER in {c["resident_id"] for c in draft["candidates"]}
    assert all(c["direction"] for c in draft["candidates"][:3])
    created = client.post("/api/tasks", json={"actor": ASKER,
                                              "understanding": draft["understanding"]}).json()
    task_id = created["created"][0]["id"]

    # 4. Escrow: the neighbour accepts, the credits lock.
    accepted = client.post(f"/api/tasks/{task_id}/accept", json={"actor": DRIVER})
    assert accepted.status_code == 200, accepted.text
    assert client.get(f"/api/tasks/{task_id}").json()["escrow"] == 3
    assert client.get("/api/me", params={"resident": ASKER}).json()["balance"] == 0

    # 5. Resolution: GPS shows both at the station; the driver is paid automatically.
    for _ in range(60):
        advance(30)
        if client.get(f"/api/tasks/{task_id}").json()["status"] == "completed":
            break
    assert client.get(f"/api/tasks/{task_id}").json()["status"] == "completed"
    assert client.get("/api/me", params={"resident": DRIVER}).json()["balance"] == 6
    events = [e["text"] for e in engine.grid.snapshot()["events"]]
    assert any("GPS confirmed both arrived" in e for e in events)

    # 6. The O2O loop: credits become a discount at an SDP tenant ...
    redeemed = client.post("/api/tenants/kopi/redeem", json={"actor": DRIVER, "credits": 3}).json()
    assert redeemed["discount_rm"] == 6.0
    # ... and the tenant hands them back to SDP for rent, inside the 5% cap.
    rebate = client.post("/api/tenants/kopi/rebate").json()
    assert rebate["credits"] == 3 and rebate["rebate_rm"] <= rebate["cap_rm"]

    economy = client.get("/api/economy").json()
    assert economy["ledger_sums_to_zero"]


def test_rule_violations_are_400s_with_readable_messages(client):
    draft = client.post("/api/tasks/draft",
                        json={"actor": "R005", "text": "Walk my dog this afternoon"}).json()
    task_id = client.post("/api/tasks", json={"actor": "R005",
                                              "understanding": draft["understanding"]}).json()["created"][0]["id"]
    r = client.post(f"/api/tasks/{task_id}/accept", json={"actor": "R005"})
    assert r.status_code == 400 and "own request" in r.json()["error"]
    r = client.post(f"/api/tasks/{task_id}/cancel", json={"actor": "R006"})
    assert r.status_code == 400 and "requester" in r.json()["error"]
    r = client.post("/api/tenants/kopi/redeem", json={"actor": "R005", "credits": 50})
    assert r.status_code == 400


def test_sdp_can_issue_a_bounty(client):
    world = client.get("/api/world").json()
    building = world["buildings"]["features"][0]["id"]
    r = client.post("/api/bounties", json={"title": "Photograph the broken swing",
                                           "credits": 3, "building": building})
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "bounty"
    assert any(b["title"] == "Photograph the broken swing"
               for b in client.get("/api/bounties").json())


def test_websocket_streams_snapshots(client):
    with client.websocket_connect("/ws") as ws:
        frame = ws.receive_json()
    assert {"t", "clock", "movers", "tasks", "events", "stats"} <= frame.keys()


def test_profiles_show_car_work_traits_and_helping_record(client):
    residents = {r["id"]: r for r in client.get("/api/residents").json()}
    aisyah, daniel = residents[ASKER], residents[DRIVER]
    assert not aisyah["has_car"] and daniel["has_car"]
    assert daniel["occupation"] == "Software engineer"
    assert daniel["strengths"] and daniel["weaknesses"]
    for r in residents.values():
        assert r["occupation"] and r["strengths"] and r["weaknesses"]
        # Nobody without a car is praised, or faulted, for their driving.
        if not r["has_car"]:
            assert not any("driv" in t.lower() for t in r["strengths"] + r["weaknesses"])
    # The seeded history means somebody has already helped a neighbour, and the
    # record adds up with the jobs it lists.
    helpers = [r["experience"] for r in residents.values() if r["experience"]["jobs"]]
    assert helpers
    for e in helpers:
        assert sum(n for _, n in e["for"]) == e["jobs"]
        assert 1 <= e["neighbours"] <= e["jobs"] and e["credits"] >= e["jobs"]


def test_a_neighbour_who_is_not_free_now_can_only_be_booked_for_their_free_time(client):
    grid = engine.grid
    # Late Monday night: nobody is in their free time.
    night = client.post("/api/clock", json={"day": 0, "time": "23:00"}).json()
    assert (night["day"], night["time"], night["slot"]) == ("Mon", "23:00", None)

    rich = max((r for r in client.get("/api/residents").json() if r["id"] != DRIVER),
               key=lambda r: r["balance"])
    ask = {"actor": rich["id"], "text": "Need help with my laptop", "invitee": DRIVER}
    refused = client.post("/api/tasks/draft", json=ask)
    assert refused.status_code == 400 and "isn't free right now" in refused.json()["error"]

    # Daniel is free mornings and evenings, not afternoons.
    tue = lambda hhmm: grid.demo_t_at(24 * 60 + hhmm)  # noqa: E731
    afternoon = client.post("/api/tasks/draft", json={**ask, "start_at": tue(14 * 60)})
    assert afternoon.status_code == 400 and "only free" in afternoon.json()["error"]

    draft = client.post("/api/tasks/draft", json={**ask, "start_at": tue(7 * 60)}).json()
    assert draft["invitee"]["id"] == DRIVER and draft["invitee"]["when"] == "Tomorrow 07:00"
    assert draft["fallback"] is None
    task = client.post("/api/tasks", json={"actor": rich["id"],
                                           "understanding": draft["understanding"]}
                       ).json()["created"][0]
    assert task["invitee"] == DRIVER and task["slot"] == "morning"

    # Only the booked neighbour can take it, and confirming does not start it yet.
    other = next(r["id"] for r in client.get("/api/residents").json()
                 if r["id"] not in {DRIVER, rich["id"]})
    assert client.post(f"/api/tasks/{task['id']}/accept", json={"actor": other}).status_code == 400
    booked = client.post(f"/api/tasks/{task['id']}/accept", json={"actor": DRIVER}).json()
    assert booked["status"] == "reserved"
    assert client.get(f"/api/tasks/{task['id']}").json()["escrow"] == task["credits"]
    advance(30)
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "reserved"

    # When the clock reaches the slot, Daniel sets off on his own.
    client.post("/api/clock", json={"day": 1, "time": "07:00"})
    advance(5)
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "in_progress"

    # In his free time he can be asked for right now.
    now = client.post("/api/tasks/draft", json=ask).json()
    assert now["invitee"]["when"] == "Now" and now["task"]["slot"] == "morning"



def test_vertical_demo_matches_on_floors_inside_a_fictional_tower(client):
    import numpy as np
    from jiransync.geo import point_in_ring
    v = client.get("/api/demo/spatial").json()["vertical"]
    tower, me = v["tower"], v["requester"]
    assert tower["fictional"] and tower["name"] == "JiranSync Demo Tower"
    assert 10 <= tower["floors"] <= 15
    # It stands on open ground: no real footprint overlaps it.
    town = engine.grid.town
    corners = np.array([town.frame.to_xy(*c) for c in tower["polygon"] + tower["polygon"][:1]])
    for b in town.buildings:
        ring = town.polygons.ring(b.index)
        assert not any(point_in_ring(float(x), float(y), corners) for x, y in ring)
        assert not any(point_in_ring(float(x), float(y), ring) for x, y in corners)
    # Real altitudes: ground + floor x storey height.
    people = {p["name"].split()[0]: p for p in v["people"]}
    for p in [me] + [q for q in v["people"] if q["building"] == tower["id"]]:
        assert abs(p["z"] - (tower["base_elev"] + p["floor"] * tower["floor_height"])) < 0.01
        assert p["floor_estimated"]
    daniel, sarah, priya = people["Daniel"], people["Sarah"], people["Priya"]
    assert v["best"] == daniel["id"] and daniel["rank"] == 1
    assert (daniel["floor"], sarah["floor"], me["floor"]) == (7, 12, 8)
    assert daniel["floors_apart"] == 1 and daniel["horizontal_m"] == 0 and daniel["same_building"]
    assert sarah["floors_apart"] == 4 and not priya["same_building"]
    assert 100 <= priya["horizontal_m"] <= 140
    # A flat map cannot tell Daniel and Sarah apart; the 3D model can.
    assert set(v["flat_view"]["tied"]) == {"Daniel", "Sarah"}
    assert daniel["access_s"] < sarah["access_s"] < priya["access_s"]


def test_route_demo_prefers_the_driver_who_arrives_first_not_the_nearest(client):
    live = engine.grid.networks["drive"]
    before = {(a, b): d["time"] for a, b, d in live.graph.edges(data=True)}
    r = client.get("/api/demo/spatial").json()["route"]
    people = {p["name"].split()[0]: p for p in r["people"]}
    sarah, daniel = people["Sarah"], people["Daniel"]
    assert r["closest"] == sarah["id"] and sarah["crow_m"] < daniel["crow_m"]
    assert sarah["through_works"] or sarah["route"]["min"] > sarah["normal_route"]["min"]
    assert sarah["normal_route"]["min"] < daniel["route"]["min"] < sarah["route"]["min"]
    assert r["best"] == daniel["id"] and r["faster_by_min"] > 2
    # Straight-line matching would have picked Sarah; road-aware matching picks Daniel.
    assert sarah["straight_line_rank"] == 1 and daniel["rank"] == 1
    # The roadworks live on a copy: the real network is untouched.
    assert before == {(a, b): d["time"] for a, b, d in live.graph.edges(data=True)}



def test_demo_auto_accept_hands_a_new_request_to_the_best_match(client):
    assert client.post("/api/demo/auto-accept", json={"on": True}).json()["auto_accept"]
    try:
        rich = max((r for r in client.get("/api/residents").json()), key=lambda r: r["balance"])
        draft = client.post("/api/tasks/draft",
                            json={"actor": rich["id"], "text": "Need help carrying a cabinet"}).json()
        best = draft["candidates"][0]["resident_id"]
        task = client.post("/api/tasks", json={"actor": rich["id"],
                                               "understanding": draft["understanding"]}).json()["created"][0]
        assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "open"
        advance(60)
        after = client.get(f"/api/tasks/{task['id']}").json()
        assert after["status"] in ("in_progress", "arrived", "completed")
        assert after["provider"] == best
    finally:
        client.post("/api/demo/auto-accept", json={"on": False})



def test_a_ride_can_go_to_any_building_not_only_the_mrt(client):
    grid = engine.grid
    rich = max(client.get("/api/residents").json(), key=lambda r: r["balance"])
    # Somewhere in town at least a few hundred metres from home: a real building.
    target = next(b for b in sorted(grid.town.buildings, key=lambda b: b.id)
                  if 400 < __import__("jiransync.geo", fromlist=["haversine_m"]).haversine_m(
                      rich["lon"], rich["lat"], *grid.town.frame.to_lonlat(*b.centroid_xy)) < 1500)
    lon, lat = (float(v) for v in grid.town.frame.to_lonlat(*target.centroid_xy))
    draft = client.post("/api/tasks/draft", json={
        "actor": rich["id"], "text": "Need a ride",
        "dest": {"lon": lon, "lat": lat, "name": "Test Building"}}).json()
    task = draft["task"]
    assert task["kind"] == "ride" and task["dest_id"] is None and task["dest_name"] == "Test Building"
    assert draft["understanding"]["title"] == "Ride to Test Building"
    # Stops on the road at the building, not at a station gateway.
    assert __import__("jiransync.geo", fromlist=["haversine_m"]).haversine_m(
        lon, lat, task["dest_lon"], task["dest_lat"]) < 120
    assert all(h["gateway"] != [task["dest_lon"], task["dest_lat"]] for h in grid.hubs)
    assert draft["candidates"], "drivers are ranked for it"
    created = client.post("/api/tasks", json={"actor": rich["id"],
                                              "understanding": draft["understanding"]}).json()["created"][0]
    driver = draft["candidates"][0]["resident_id"]
    assert client.post(f"/api/tasks/{created['id']}/accept", json={"actor": driver}).status_code == 200
    advance(1800)
    assert client.get(f"/api/tasks/{created['id']}").json()["status"] == "completed"
