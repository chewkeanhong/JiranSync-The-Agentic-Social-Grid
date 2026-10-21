"""Jiran Credits: the township's time-bank currency.

The rules, in one place:

* Peer-to-peer is **zero-sum**. A resident can only pay with credits they hold; helping a
  neighbour moves credits, it never creates them.
* Credits enter circulation two ways only, both issued by SDP from ``sdp:mint``: the
  seed grant a verified resident gets on joining, and the reward for volunteering at an
  SDP community event, paid to each volunteer GPS checked in at the venue.
* A task's reward is locked in ``escrow:<task>`` when someone accepts it, released to the
  provider on completion, and refunded on cancellation or a no-show.
* Tenants accept credits as a discount (1 credit = RM2 off) and cash them out with SDP at
  the same rate: every credit a shop collected is handed back to SDP's treasury, and SDP
  pays the shop RM2 for it.
"""

from __future__ import annotations

from .store import Store

SEED_GRANT = 3
RM_PER_CREDIT = 2.0

MINT = "sdp:mint"
TREASURY = "sdp:treasury"


class CreditError(ValueError):
    """A ledger rule was violated: insufficient balance, double release, and so on."""


def escrow_account(task_id: str) -> str:
    return f"escrow:{task_id}"


def tenant_account(tenant_id: str) -> str:
    return f"tenant:{tenant_id}"


def balance(store: Store, account: str) -> int:
    return store.balance(account)


def grant_seed(store: Store, resident_id: str, t: float = 0.0) -> None:
    """The welcome grant for a verified resident. Issued once."""
    already = store.execute(
        "SELECT 1 FROM ledger WHERE kind = 'seed' AND credit = ?", (resident_id,)).fetchone()
    if already:
        return
    store.post(t, "seed", MINT, resident_id, SEED_GRANT, memo="welcome grant")


def lock_escrow(store: Store, task: dict, t: float) -> None:
    """Lock a task's reward, paid by the requester."""
    escrow = escrow_account(task["id"])
    amount = int(task["credits"])
    with store.transaction():
        if store.balance(escrow) > 0:
            raise CreditError(f"{task['id']} already has credits in escrow")
        payer = task["requester"]
        held = store.balance(payer)
        if held < amount:
            raise CreditError(f"{payer} holds {held} credits; this task needs {amount}")
        store.post(t, "escrow", payer, escrow, amount, task["id"], "locked in escrow")


def release(store: Store, task: dict, t: float) -> int:
    """Pay the provider everything held in the task's escrow."""
    if not task.get("provider"):
        raise CreditError(f"{task['id']} has no provider to pay")
    escrow = escrow_account(task["id"])
    with store.transaction():
        amount = store.balance(escrow)
        if amount <= 0:
            raise CreditError(f"nothing in escrow for {task['id']}")
        store.post(t, "release", escrow, task["provider"], amount, task["id"],
                   "escrow released on completion")
    return amount


def refund(store: Store, task: dict, t: float, memo: str = "refunded") -> int:
    """Return escrow to whoever funded it. A no-op if nothing is locked."""
    escrow = escrow_account(task["id"])
    with store.transaction():
        amount = store.balance(escrow)
        if amount <= 0:
            return 0
        store.post(t, "refund", escrow, task["requester"], amount, task["id"], memo)
    return amount


def pay_volunteer(store: Store, event: dict, resident_id: str, t: float) -> int:
    """SDP mints an event's reward to one volunteer. Paid once per event and person."""
    with store.transaction():
        already = store.execute("SELECT 1 FROM ledger WHERE kind = 'event' AND task_id = ? "
                                "AND credit = ?", (event["id"], resident_id)).fetchone()
        if already:
            raise CreditError(f"{resident_id} was already paid for {event['id']}")
        store.post(t, "event", MINT, resident_id, int(event["credits"]), event["id"],
                   f"SDP event: {event['title']}")
    return int(event["credits"])


def redeem(store: Store, resident_id: str, tenant: dict, credits: int, t: float) -> float:
    """Spend credits at a tenant. Returns the RM discount the resident receives."""
    credits = int(credits)
    if credits <= 0:
        raise CreditError("redeem a positive number of credits")
    with store.transaction():
        held = store.balance(resident_id)
        if held < credits:
            raise CreditError(f"{resident_id} holds {held} credits; cannot redeem {credits}")
        discount = credits * RM_PER_CREDIT
        store.post(t, "redeem", resident_id, tenant_account(tenant["id"]), credits,
                   memo=f"RM{discount:.2f} off at {tenant['name']}")
    return discount


def cash_out(store: Store, tenant: dict, t: float) -> dict:
    """A shop hands every credit it has collected back to SDP, which pays RM2 each."""
    account = tenant_account(tenant["id"])
    with store.transaction():
        held = store.balance(account)
        if held > 0:
            store.post(t, "cashout", account, TREASURY, held,
                       memo=f"cash-out: RM{held * RM_PER_CREDIT:.2f} paid by SDP")
    return {"credits": held, "rm": held * RM_PER_CREDIT}


def circulating(store: Store) -> int:
    """Credits SDP has issued and not taken back: exactly what the mint is short."""
    return -store.balance(MINT) - store.balance(TREASURY)
