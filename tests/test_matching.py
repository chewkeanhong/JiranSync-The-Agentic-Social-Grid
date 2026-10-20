"""Matching: skills, real walking distance, schedules, reliability, and the fallback."""

from __future__ import annotations

from jiransync import fallback, matching

from .conftest import add_resident


def help_task(town, building="h0", skills=("plumbing",), slot=None, requester="R0"):
    b = town.building(building)
    lon, lat = town.frame.to_lonlat(*b.centroid_xy)
    return {"id": "T1", "requester": requester, "kind": "help", "skills": list(skills),
            "slot": slot, "lon": float(lon), "lat": float(lat)}


def test_the_skilled_neighbour_outranks_a_closer_unskilled_one(grid):
    town = grid.town
    add_resident(grid.store, town, "R0", "h0")
    add_resident(grid.store, town, "near", "h1", skills=["cooking"])
    add_resident(grid.store, town, "plumber", "h2", skills=["plumbing"])
    ranked = matching.rank(help_task(town), grid.store.residents(),
                           network=grid.networks["walk"], frame=town.frame)
    assert ranked[0].resident_id == "plumber"
    assert "plumbing" in ranked[0].reasons[0]


def test_walking_minutes_follow_the_street_graph(grid):
    """h0 to h5 is 200 m east then 200 m north on the grid, not the 283 m diagonal."""
    town = grid.town
    add_resident(grid.store, town, "R0", "h0")
    add_resident(grid.store, town, "far", "h5", skills=["plumbing"])
    [c] = matching.rank(help_task(town), grid.store.residents(),
                        network=grid.networks["walk"], frame=town.frame)
    assert 400 / 80 < c.walk_min < 480 / 80 + 1      # ~400 m at 4.8 km/h, plus doorsteps


def test_nobody_beyond_walking_range_is_pinged(grid):
    town = grid.town
    add_resident(grid.store, town, "R0", "h0")
    add_resident(grid.store, town, "faraway", "h7", skills=["plumbing"])   # ~1.2 km by street
    ranked = matching.rank(help_task(town), grid.store.residents(),
                           network=grid.networks["walk"], frame=town.frame)
    assert ranked == []


def test_schedule_and_suspension_are_respected(grid):
    town = grid.town
    add_resident(grid.store, town, "R0", "h0")
    add_resident(grid.store, town, "evening", "h1", skills=["plumbing"], availability=["evening"])
    add_resident(grid.store, town, "morning", "h2", skills=["plumbing"], availability=["morning"])
    add_resident(grid.store, town, "banned", "h3", skills=["plumbing"])
    grid.store.update_resident("banned", suspended=1)
    ranked = matching.rank(help_task(town, slot="morning"), grid.store.residents(),
                           network=grid.networks["walk"], frame=town.frame)
    ids = [c.resident_id for c in ranked]
    assert "banned" not in ids
    assert ids.index("morning") < ids.index("evening")


def test_rides_prefer_drivers_already_heading_to_that_station(grid):
    town = grid.town
    add_resident(grid.store, town, "R0", "h0")
    add_resident(grid.store, town, "walker", "h1")
    add_resident(grid.store, town, "driver", "h3", has_car=1, skills=["driving"])
    add_resident(grid.store, town, "commuter", "h4", has_car=1, skills=["driving"], commute="mrt")
    task = {**help_task(town, skills=["driving"]), "kind": "ride", "dest_id": "mrt",
            "dest_name": "MRT Test"}
    ranked = matching.rank(task, grid.store.residents())
    ids = [c.resident_id for c in ranked]
    assert "walker" not in ids
    assert ids[0] == "commuter" and ranked[0].direction


def test_no_skilled_neighbour_triggers_the_commercial_fallback(grid):
    town = grid.town
    add_resident(grid.store, town, "R0", "h0")
    add_resident(grid.store, town, "cook", "h1", skills=["cooking"])
    task = help_task(town)
    ranked = matching.rank(task, grid.store.residents(), network=grid.networks["walk"],
                           frame=town.frame)
    assert matching.needs_fallback(task, ranked)
    offer = fallback.offer(task, grid.store.tenants())
    assert offer["tenant_id"] == "cafe" and offer["discount_pct"] == 10


def test_fallback_offers_nothing_when_no_tenant_covers_the_skill(grid):
    task = help_task(grid.town, skills=["sewing"])
    assert fallback.offer(task, grid.store.tenants()) is None
