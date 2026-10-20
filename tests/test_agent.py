"""Task understanding: the rule engine, and that Claude's answers are kept in bounds."""

from __future__ import annotations

import pytest

from jiransync import agent

HUBS = [
    {"id": "kwasa", "name": "MRT Kwasa Damansara", "aliases": ["kwasa", "mrt"]},
    {"id": "sgbuloh", "name": "MRT/KTM Sungai Buloh", "aliases": ["sungai buloh", "ktm"]},
]


def test_a_ride_to_the_mrt_is_a_ride_with_a_destination():
    u = agent.rules("Need a ride to the MRT tomorrow 8am", HUBS)
    assert u.kind == "ride"
    assert u.destination == "kwasa"
    assert u.slot == "morning"
    assert u.skills == ["driving"]


def test_the_most_specific_station_name_wins():
    assert agent.rules("Need a lift to MRT Sungai Buloh", HUBS).destination == "sgbuloh"


def test_a_leak_is_urgent_expert_plumbing():
    u = agent.rules("My kitchen tap is leaking badly, urgent!", HUBS)
    assert u.kind == "help"
    assert u.skills == ["plumbing"]
    assert u.skill_level == 2
    assert u.urgency == 3


def test_bundled_jobs_are_decomposed_into_micro_tasks():
    u = agent.rules("Fix my leaking tap and help carry a new cabinet upstairs tonight", HUBS)
    assert len(u.subtasks) == 2
    assert u.subtasks[0].skills == ["plumbing"]
    assert "moving" in u.subtasks[1].skills
    assert u.slot == "evening"


def test_rules_are_deterministic():
    text = "Can someone tutor my son in SPM maths on weekday evenings?"
    assert agent.rules(text, HUBS).to_dict() == agent.rules(text, HUBS).to_dict()


def test_without_credentials_the_rule_engine_answers(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    u = agent.understand("Walk my dog this afternoon", HUBS)
    assert u.source == "rules"
    assert u.skills == ["pet care"]


def test_a_failing_claude_call_falls_back_to_rules(monkeypatch):
    monkeypatch.setattr(agent, "claude_available", lambda: True)

    def boom(text, hubs):
        raise RuntimeError("network down")

    monkeypatch.setattr(agent, "_ask_claude", boom)
    u = agent.understand("Walk my dog this afternoon", HUBS)
    assert u.source == "rules"
    assert "RuntimeError" in u.note


def test_claude_output_is_clamped_to_the_platform_vocabulary():
    u = agent._clamp({
        "title": "x" * 200, "kind": "help", "skills": ["plumbing", "hacking"],
        "skill_level": 9, "urgency": 0, "slot": "midnight", "est_minutes": 100000,
        "materials_rm": -5, "destination": "nowhere",
        "subtasks": [{"title": "only one", "skills": ["plumbing"], "est_minutes": 30}],
        "summary": "ok",
    }, HUBS)
    assert u.skills == ["plumbing"]
    assert u.skill_level == 2 and u.urgency == 1
    assert u.slot is None and u.destination is None
    assert u.est_minutes == 480 and u.materials_rm == 0.0
    assert len(u.title) <= 60
    assert u.subtasks == []          # a single "subtask" is not a decomposition
    assert u.source == "claude"


def test_an_empty_request_is_refused():
    with pytest.raises(ValueError):
        agent.understand("   ", HUBS)
