"""Dynamic valuation: what a favour is worth, in Jiran Credits.

Replaces the rigid "1 hour = 1 credit" time bank with four factors the pitch names --
time, capital cost, skill and urgency -- combined in a formula anyone can check by hand:

    value = (time_credits + capital_credits) x skill_multiplier x urgency_multiplier

The engine suggests a range, not a price. The requester can post anywhere inside it;
the breakdown is shown so a neighbour can see *why* a ride is worth three credits.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from .credits import RM_PER_CREDIT

# Credits per hour of someone's time. 1 credit = RM2, so this values an hour of
# neighbourly help at RM4 -- a token of thanks, deliberately well below a market wage.
CREDITS_PER_HOUR = 2.0

# Out-of-pocket running cost per km for a private car in Malaysia: RON95 petrol plus a
# share of wear, roughly in line with common mileage-claim rates.
CAR_COST_RM_PER_KM = 0.55

SKILL_MULTIPLIER = {0: 1.0, 1: 1.5, 2: 2.0}      # everyday, skilled, expert
SKILL_NAMES = {0: "everyday", 1: "skilled", 2: "expert"}
URGENCY_MULTIPLIER = {1: 1.0, 2: 1.25, 3: 1.5}   # flexible, today, right now
URGENCY_NAMES = {1: "flexible", 2: "today", 3: "urgent"}

MIN_CREDITS = 1
MAX_CREDITS = 20


@dataclass(frozen=True)
class Valuation:
    suggested: int
    low: int
    high: int
    time_credits: float
    capital_credits: float
    capital_rm: float
    skill_multiplier: float
    urgency_multiplier: float
    explanation: str

    def to_dict(self) -> dict:
        return asdict(self)


def _clamp(n: float) -> int:
    return max(MIN_CREDITS, min(MAX_CREDITS, int(n)))


def value(est_minutes: float, *, skill_level: int = 0, urgency: int = 1,
          distance_km: float = 0.0, materials_rm: float = 0.0) -> Valuation:
    """Suggest a credit range for a task.

    ``distance_km`` is driving the helper does *for* the task (a carpool's shared leg);
    ``materials_rm`` is anything they pay for out of pocket. Both are capital cost.
    """
    skill_level = int(min(2, max(0, skill_level)))
    urgency = int(min(3, max(1, urgency)))
    time_credits = max(0.0, est_minutes) / 60.0 * CREDITS_PER_HOUR
    capital_rm = max(0.0, distance_km) * CAR_COST_RM_PER_KM + max(0.0, materials_rm)
    capital_credits = capital_rm / RM_PER_CREDIT
    skill = SKILL_MULTIPLIER[skill_level]
    rush = URGENCY_MULTIPLIER[urgency]

    raw = (time_credits + capital_credits) * skill * rush
    suggested = _clamp(round(raw) if raw >= MIN_CREDITS else MIN_CREDITS)
    low = _clamp(math.floor(raw * 0.75))
    high = _clamp(math.ceil(raw * 1.3))
    low, high = min(low, suggested), max(high, suggested)

    parts = [f"{est_minutes:.0f} min of time = {time_credits:.1f} cr"]
    if capital_rm > 0:
        parts.append(f"RM{capital_rm:.2f} costs = {capital_credits:.1f} cr")
    parts.append(f"x{skill:g} {SKILL_NAMES[skill_level]}")
    parts.append(f"x{rush:g} {URGENCY_NAMES[urgency]}")
    return Valuation(suggested, low, high, round(time_credits, 2), round(capital_credits, 2),
                     round(capital_rm, 2), skill, rush, " · ".join(parts))
