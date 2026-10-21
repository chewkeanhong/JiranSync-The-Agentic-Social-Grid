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


def take(grid, task, helper):
    """Help is offered, then chosen: the requester picks ``helper``."""
    grid.offer(task["id"], helper)
    return grid.choose(task["id"], task["requester"], helper)


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
    [task] = post(grid, "asker", "Walk my dog")
    take(grid, task, "helper")
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
    [task] = post(grid, "asker", "Walk my dog")
    take(grid, task, "helper")
    grid.ghost(task["id"])
    assert run_until(grid, lambda: grid.store.task(task["id"])["status"] == "open",
                     limit_s=NO_SHOW_S + 30)
    assert grid.store.balance("asker") == credits.SEED_GRANT
    helper = grid.store.resident("helper")
    assert helper["strikes"] == 1 and helper["reliability"] < 0.9
    assert grid.store.task(task["id"])["provider"] is None


def test_cancel_refunds_and_only_the_requester_may(people):
    grid = people
    [task] = post(grid, "asker", "Walk my dog")
    take(grid, task, "helper")
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
    grid.store.post(0.0, "event", credits.MINT, "asker", 10, memo="earned elsewhere")
    created = post(grid, "asker", "Fix my leaking tap and help carry a new cabinet upstairs tonight")
    assert len(created) == 2
    parent = grid.store.task(created[0]["parent_id"])
    assert parent["kind"] == "bundle" and parent["credits"] == sum(c["credits"] for c in created)


def venue(grid, building="h5"):
    b = grid.town.building(building)
    return (float(v) for v in grid.town.frame.to_lonlat(*b.centroid_xy))


def test_event_pays_volunteers_gps_checked_in_and_not_no_shows(people):
    grid = people
    lon, lat = venue(grid)
    event = grid.create_event(title="Park clean-up", place_name="Park", lon=lon, lat=lat,
                              start_at=grid.now + 600, duration_min=60, slots=2, credits_each=4)
    assert event["status"] == "upcoming"
    grid.join_event(event["id"], "helper")
    grid.join_event(event["id"], "driver")
    with pytest.raises(GridError, match="taken"):
        grid.join_event(event["id"], "asker")
    with pytest.raises(GridError, match="already joined"):
        grid.join_event(event["id"], "helper")

    # The clock reaches the start: volunteers walk over and GPS checks them in.
    assert run_until(grid, lambda: grid.store.community_event(event["id"])["status"] == "live")
    assert run_until(grid, lambda: all(s["status"] == "checked_in"
                                       for s in grid.store.signups(event["id"])))
    # One of them goes home before the end: the GPS check-in still stands.
    ended = grid.end_event(event["id"])
    assert ended["status"] == "ended"
    assert grid.store.balance("helper") == credits.SEED_GRANT + 4
    assert grid.store.balance("driver") == credits.SEED_GRANT + 4
    assert sum(grid.store.all_balances().values()) == 0


def test_a_volunteer_who_never_arrives_is_not_paid(people):
    grid = people
    lon, lat = venue(grid)
    event = grid.create_event(title="Tree planting", place_name="Park", lon=lon, lat=lat,
                              start_at=grid.now + 600, duration_min=60, slots=3, credits_each=4)
    grid.join_event(event["id"], "helper")
    grid.start_event(event["id"])
    grid.movers.pop(f"e:{event['id']}:helper")     # their phone never leaves home
    grid.end_event(event["id"])
    assert grid.store.balance("helper") == credits.SEED_GRANT
    assert grid.store.signups(event["id"])[0]["status"] == "no_show"


def test_a_one_off_job_is_open_at_once_and_closes_when_its_volunteer_arrives(people):
    grid = people
    lon, lat = venue(grid)
    job = grid.create_event(title="Photograph the broken lamp", place_name="Lane", lon=lon,
                            lat=lat, start_at=None, duration_min=20, slots=1, credits_each=3)
    assert job["status"] == "live"
    grid.join_event(job["id"], "helper")
    assert run_until(grid, lambda: grid.store.community_event(job["id"])["status"] == "ended")
    assert grid.store.balance("helper") == credits.SEED_GRANT + 3
    assert credits.circulating(grid.store) == 3 * credits.SEED_GRANT + 3


def test_events_validate_their_shape(people):
    grid = people
    lon, lat = venue(grid)
    with pytest.raises(GridError, match="volunteers"):
        grid.create_event(title="Too big", place_name="", lon=lon, lat=lat, start_at=None,
                          duration_min=30, slots=500, credits_each=2)
    with pytest.raises(GridError, match="passed"):
        grid.create_event(title="Yesterday", place_name="", lon=lon, lat=lat,
                          start_at=grid.now - 3600, duration_min=30, slots=2, credits_each=2)


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


def test_redeem_and_cash_out_through_the_grid(people):
    grid = people
    out = grid.redeem("asker", "cafe", 2)
    assert out["discount_rm"] == 4.0 and out["balance"] == 1
    paid = grid.cash_out("cafe")
    assert paid["credits"] == 2 and paid["rm"] == 4.0
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


def test_help_is_offered_then_chosen_and_credits_wait_for_the_choice(people):
    grid = people
    from .conftest import add_resident
    add_resident(grid.store, grid.town, "second", "h3", skills=["pet care"])
    [task] = post(grid, "asker", "Walk my dog")
    with pytest.raises(GridError, match="offer"):
        grid.accept(task["id"], "helper")
    grid.offer(task["id"], "helper")
    grid.offer(task["id"], "second")
    with pytest.raises(GridError, match="already offered"):
        grid.offer(task["id"], "helper")
    # Offers hold nothing.
    assert grid.store.balance("asker") == credits.SEED_GRANT
    with pytest.raises(GridError, match="requester"):
        grid.choose(task["id"], "helper", "second")
    grid.choose(task["id"], "asker", "second")
    assert grid.store.task(task["id"])["provider"] == "second"
    assert grid.store.balance(credits.escrow_account(task["id"])) == task["credits"]
    statuses = {o["resident"]: o["status"] for o in grid.store.offers(task["id"])}
    assert statuses == {"helper": "declined", "second": "chosen"}


def test_a_request_for_tomorrow_evening_is_booked_for_then(people):
    grid = people
    [task] = post(grid, "asker", "Walk my dog tomorrow evening")
    # Monday 07:30 now; tomorrow evening is Tuesday at 19:00.
    assert grid.minute_of(task["start_at"]) == (24 + 19) * 60
    take(grid, task, "helper")
    assert grid.store.task(task["id"])["status"] == "reserved"
    assert "m:" + task["id"] not in grid.movers


def test_past_favours_rank_higher_and_say_so(people):
    grid = people
    from .conftest import add_resident
    add_resident(grid.store, grid.town, "second", "h3", skills=["pet care", "moving"])
    # helper walked the asker's dog before.
    [old] = post(grid, "asker", "Walk my dog")
    take(grid, old, "helper")
    assert run_until(grid, lambda: grid.store.task(old["id"])["status"] == "arrived")
    grid.complete(old["id"], "asker")
    task = {"requester": "asker", "kind": "help", "skills": ["pet care"], "slot": None,
            "lon": grid.store.resident("asker")["lon"], "lat": grid.store.resident("asker")["lat"]}
    ranked = {c.resident_id: c for c in grid._rank(task)}
    assert ranked["helper"].familiar and "Helped you once before" in ranked["helper"].ties
    assert not ranked["second"].familiar


def test_the_draft_asks_when_and_takes_the_residents_answer(people):
    grid = people
    vague = grid.draft("asker", "Walk my dog")
    assert vague["needs_when"] and vague["task"]["start_at"] is None
    soon = grid.draft("asker", "Walk my dog", asap=True)
    assert not soon["needs_when"] and soon["task"]["when"] == "As soon as possible"
    later = grid.now + 26 * 3600
    picked = grid.draft("asker", "Walk my dog", when_at=later, minutes=90)
    assert picked["task"]["start_at"] == later and picked["task"]["est_minutes"] == 90
    # Ninety minutes is worth more than the half hour a dog walk usually takes.
    assert picked["valuation"]["suggested"] > vague["valuation"]["suggested"]
    [task] = grid.post("asker", understanding=picked["understanding"])
    assert task["start_at"] == later
    with pytest.raises(GridError, match="passed"):
        grid.draft("asker", "Walk my dog", when_at=grid.now - 60)
