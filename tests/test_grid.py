"""The task lifecycle end to end on a small street grid, driven by the simulated clock."""

from __future__ import annotations

import pytest

from jiransync import agent, credits, fraud
from jiransync.grid import NO_SHOW_S, GridError

from .conftest import add_resident


def run_until(grid, predicate, limit_s=3000.0, dt=2.5):
    t = 0.0
    while t < limit_s:
        grid.step(dt)
        t += dt
        if predicate():
            return True
    return False


def post(grid, actor, text, **kw):
    u = agent.rules(text, grid.hubs).to_dict()
    return grid.post(actor, understanding=u, **kw)


@pytest.fixture
def people(grid):
    town = grid.town
    add_resident(grid.store, town, "asker", "h0")
    add_resident(grid.store, town, "driver", "h2", has_car=1, skills=["driving"], commute="mrt")
    add_resident(grid.store, town, "helper", "h1", skills=["moving", "pet care"])
    return grid


def test_a_carpool_completes_itself_when_gps_shows_both_arrived(people):
    grid = people
    [task] = post(grid, "asker", "Need a ride to the MRT tomorrow 8am")
    assert task["kind"] == "ride" and task["dest_id"] == "mrt"
    grid.accept(task["id"], "driver")
    assert grid.store.balance(credits.escrow_account(task["id"])) == task["credits"]

    legs = set()

    def done():
        for m in grid.movers.values():
            legs.add(m.leg)
        return grid.store.task(task["id"])["status"] == "completed"

    assert run_until(grid, done)
    assert {"pickup", "ride"} <= legs
    assert grid.store.balance("driver") == credits.SEED_GRANT + task["credits"]
    assert grid.store.balance("asker") == credits.SEED_GRANT - task["credits"]
    assert sum(grid.store.all_balances().values()) == 0


def test_help_needs_arrival_then_the_requesters_confirmation(people):
    grid = people
    [task] = post(grid, "asker", "Walk my dog this afternoon")
    grid.accept(task["id"], "helper")
    with pytest.raises(GridError):
        grid.complete(task["id"], "asker")                 # not there yet
    assert run_until(grid, lambda: grid.store.task(task["id"])["status"] == "arrived")
    with pytest.raises(GridError):
        grid.complete(task["id"], "helper")                # only the requester confirms
    grid.complete(task["id"], "asker")
    assert grid.store.task(task["id"])["status"] == "completed"
    assert grid.store.balance("helper") == credits.SEED_GRANT + task["credits"]


def test_a_no_show_refunds_escrow_strikes_the_provider_and_reopens(people):
    grid = people
    [task] = post(grid, "asker", "Walk my dog this afternoon")
    grid.accept(task["id"], "helper")
    grid.ghost(task["id"])
    assert run_until(grid, lambda: grid.store.task(task["id"])["status"] == "open",
                     limit_s=NO_SHOW_S + 30)
    assert grid.store.balance("asker") == credits.SEED_GRANT
    helper = grid.store.resident("helper")
    assert helper["strikes"] == 1 and helper["reliability"] < 0.9
    assert grid.store.task(task["id"])["provider"] is None


def test_cancel_refunds_and_only_the_requester_may(people):
    grid = people
    [task] = post(grid, "asker", "Walk my dog this afternoon")
    grid.accept(task["id"], "helper")
    with pytest.raises(GridError):
        grid.cancel(task["id"], "helper")
    grid.cancel(task["id"], "asker")
    assert grid.store.balance("asker") == credits.SEED_GRANT
    assert grid.store.task(task["id"])["status"] == "cancelled"


def test_you_cannot_promise_more_than_you_hold(people):
    grid = people
    post(grid, "asker", "Help carry a sofa upstairs")              # 2 cr, still open
    with pytest.raises(GridError, match="credits free"):
        post(grid, "asker", "Walk my dog this afternoon", credits_offered=2)


def test_rules_against_self_dealing_and_carless_rides(people):
    grid = people
    [ride] = post(grid, "asker", "Need a ride to the MRT")
    with pytest.raises(GridError):
        grid.accept(ride["id"], "asker")
    with pytest.raises(GridError, match="car"):
        grid.accept(ride["id"], "helper")


def test_bundles_split_into_separately_funded_micro_tasks(people):
    grid = people
    grid.store.post(0.0, "bounty", credits.MINT, "asker", 10, memo="earned elsewhere")
    created = post(grid, "asker", "Fix my leaking tap and help carry a new cabinet upstairs tonight")
    assert len(created) == 2
    parent = grid.store.task(created[0]["parent_id"])
    assert parent["kind"] == "bundle" and parent["credits"] == sum(c["credits"] for c in created)


def test_bounties_need_geotagged_proof_at_the_spot(people):
    grid = people
    b = grid.town.building("h5")
    lon, lat = grid.town.frame.to_lonlat(*b.centroid_xy)
    bounty = grid.create_bounty(title="Photograph the broken lamp", skills=["errands"],
                                credits_amount=3, lon=float(lon), lat=float(lat))
    grid.accept(bounty["id"], "helper")
    with pytest.raises(GridError, match="geo-tagged"):
        grid.complete(bounty["id"], "helper", proof={"lon": lon + 0.01, "lat": lat})
    # On arrival the phone's photo is geo-tagged where the helper stands, and it pays.
    assert run_until(grid, lambda: grid.store.task(bounty["id"])["status"] == "completed")
    assert grid.store.balance("helper") == credits.SEED_GRANT + 3
    assert credits.circulating(grid.store) == 3 * credits.SEED_GRANT + 3


def test_circular_trading_is_flagged_and_suspends_both(people):
    grid = people
    store = grid.store
    for n in range(fraud.CIRCULAR_MIN_EACH_WAY):
        for a, b in (("asker", "helper"), ("helper", "asker")):
            tid = f"X{n}{a}"
            store.add_task(id=tid, requester=a, title="favour", kind="help", skills=[],
                           lon=0.0, lat=0.0, credits=1, status="in_progress", provider=b)
            t = store.task(tid)
            credits.lock_escrow(store, t, grid.t)
            credits.release(store, t, grid.t)
    assert fraud.flag_circular(store, "asker", "helper", grid.t)
    assert store.resident("asker")["suspended"] and store.resident("helper")["suspended"]
    with pytest.raises(GridError, match="suspended"):
        post(grid, "asker", "Walk my dog")


def test_three_strikes_suspends(people):
    store = people.store
    for _ in range(fraud.STRIKES_TO_SUSPEND):
        standing = fraud.strike(store, "helper", 0.0, "test")
    assert standing["suspended"]


def test_redeem_and_rebate_through_the_grid(people):
    grid = people
    out = grid.redeem("asker", "cafe", 2)
    assert out["discount_rm"] == 4.0 and out["balance"] == 1
    rebate = grid.claim_rebate("cafe")
    assert rebate["credits"] == 2 and rebate["cap_rm"] == 50.0
    with pytest.raises(GridError):
        grid.redeem("asker", "cafe", 5)


def test_snapshot_carries_movers_tasks_and_stats(people):
    grid = people
    [task] = post(grid, "asker", "Need a ride to the MRT")
    grid.accept(task["id"], "driver")
    grid.step(5.0)
    snap = grid.snapshot()
    assert snap["stats"]["active"] == 1
    assert any(m["task_id"] == task["id"] and m["route"] for m in snap["movers"])
    assert snap["clock"]["time"] == "07:30"
