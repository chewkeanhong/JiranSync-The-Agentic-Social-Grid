"""Collusion and reliability guards.

Two abuses the pitch names, two checks:

* **Circular trading.** Two accounts passing the same credits back and forth to farm
  completions (and, with them, reputation or bounty eligibility). Flagged when a pair
  has paid each other repeatedly in both directions inside a short window.
* **Ghosting.** A provider accepts, then never moves. The escrow is refunded and the
  provider takes a reliability strike; three strikes suspends the account.
"""

from __future__ import annotations

from .store import Store

CIRCULAR_WINDOW_S = 6 * 3600.0
CIRCULAR_MIN_EACH_WAY = 3

STRIKE_RELIABILITY_FACTOR = 0.8
STRIKES_TO_SUSPEND = 3


def circular_pair(store: Store, a: str, b: str, now: float) -> bool:
    """Have ``a`` and ``b`` paid each other suspiciously often, in both directions?

    Payments are escrow releases: the provider is the credit side, and the requester is
    found through the task the escrow belongs to.
    """
    rows = store.execute(
        "SELECT l.credit AS provider, t.requester AS requester FROM ledger l "
        "JOIN tasks t ON t.id = l.task_id "
        "WHERE l.kind = 'release' AND l.t >= ? AND t.kind != 'bounty' "
        "AND ((l.credit = ? AND t.requester = ?) OR (l.credit = ? AND t.requester = ?))",
        (now - CIRCULAR_WINDOW_S, a, b, b, a)).fetchall()
    a_paid_b = sum(1 for r in rows if r["requester"] == a)
    b_paid_a = sum(1 for r in rows if r["requester"] == b)
    return a_paid_b >= CIRCULAR_MIN_EACH_WAY and b_paid_a >= CIRCULAR_MIN_EACH_WAY


def flag_circular(store: Store, a: str, b: str, now: float) -> bool:
    """Check a pair after a payment; suspend both and log it if they are trading in a loop."""
    if not circular_pair(store, a, b, now):
        return False
    note = f"circular trading with {{other}} ({CIRCULAR_MIN_EACH_WAY}+ each way)"
    for me, other in ((a, b), (b, a)):
        store.update_resident(me, suspended=1, flagged=note.format(other=other))
    store.log(now, "fraud", f"{a} and {b} suspended pending review: credits passed back and "
                            f"forth {CIRCULAR_MIN_EACH_WAY}+ times each way")
    return True


def strike(store: Store, resident_id: str, now: float, reason: str) -> dict:
    """Record a no-show. Returns the resident's updated standing."""
    r = store.resident(resident_id)
    strikes = int(r["strikes"]) + 1
    reliability = round(float(r["reliability"]) * STRIKE_RELIABILITY_FACTOR, 3)
    suspended = strikes >= STRIKES_TO_SUSPEND
    store.update_resident(resident_id, strikes=strikes, reliability=reliability,
                          suspended=int(suspended or r["suspended"]))
    store.log(now, "strike", f"{r['name']}: reliability strike {strikes} ({reason})"
                             + (" — account suspended" if suspended else ""),
              actor=resident_id)
    return {"strikes": strikes, "reliability": reliability, "suspended": suspended}
