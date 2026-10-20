"""Dynamic valuation: time, capital cost, skill and urgency, checkable by hand."""

from __future__ import annotations

from jiransync import valuation


def test_an_hour_of_everyday_help_is_two_credits():
    v = valuation.value(60)
    assert v.suggested == 2
    assert v.low <= v.suggested <= v.high


def test_a_carpool_to_the_mrt_is_about_three_credits():
    """The pitch's worked example: a 15-minute detour plus ~8.5 km of petrol."""
    v = valuation.value(15, distance_km=8.5)
    assert v.suggested == 3
    assert v.capital_rm > 0


def test_skill_and_urgency_raise_the_price():
    base = valuation.value(60).suggested
    expert = valuation.value(60, skill_level=2).suggested
    urgent = valuation.value(60, skill_level=2, urgency=3).suggested
    assert base < expert < urgent


def test_suggestions_are_clamped_to_a_sane_range():
    assert valuation.value(0).suggested == valuation.MIN_CREDITS
    assert valuation.value(10_000, skill_level=2, urgency=3).suggested == valuation.MAX_CREDITS


def test_the_explanation_names_every_factor():
    v = valuation.value(30, skill_level=1, urgency=2, distance_km=3)
    for word in ("min", "RM", "skilled", "today"):
        assert word in v.explanation
