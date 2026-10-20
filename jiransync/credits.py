"""Jiran Credits: the township's time-bank currency.

The rules, in one place:

* Peer-to-peer is **zero-sum**. A resident can only pay with credits they hold; helping a
  neighbour moves credits, it never creates them.
* Credits enter circulation two ways only, both issued by SDP from ``sdp:mint``: the
  seed grant a verified resident gets on joining, and developer-sponsored bounties.
* A task's reward is locked in ``escrow:<task>`` when someone accepts it, released to the
  provider on completion, and refunded on cancellation or a no-show.
* Tenants accept credits as a discount (1 credit = RM2 off) and hand them back to SDP for
  a rent rebate, **capped at 5% of their monthly rent**. Credits above the cap stay with
  the tenant; they are not paid out.
"""

from __future__ import annotations

from .store import Store

SEED_GRANT = 3
RM_PER_CREDIT = 2.0
REBATE_CAP = 0.05

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
    """Lock a task's reward. Peer tasks are paid by the requester; bounties by SDP."""
    escrow = escrow_account(task["id"])
    amount = int(task["credits"])
    with store.transaction():
        if store.balance(escrow) > 0:
            raise CreditError(f"{task['id']} already has credits in escrow")
        if task["kind"] == "bounty":
            store.post(t, "bounty", MINT, escrow, amount, task["id"], "SDP bounty issued")
            return
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
    payer = MINT if task["kind"] == "bounty" else task["requester"]
    with store.transaction():
        amount = store.balance(escrow)
        if amount <= 0:
            return 0
        store.post(t, "refund", escrow, payer, amount, task["id"], memo)
    return amount


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


def rebate_claimed_rm(store: Store, tenant_id: str, month: str) -> float:
    row = store.execute(
        "SELECT COALESCE(SUM(amount), 0) AS c FROM ledger "
        "WHERE kind = 'rebate' AND debit = ? AND memo LIKE ?",
        (tenant_account(tenant_id), f"rebate {month}%")).fetchone()
    return int(row["c"]) * RM_PER_CREDIT


def claim_rebate(store: Store, tenant: dict, month: str, t: float) -> dict:
    """Hand collected credits back to SDP for a rent rebate, up to the 5% cap.

    Only as many credits as fit under the cap move; the rest stay with the tenant for
    next month. Returns what moved and what the cap left over.
    """
    account = tenant_account(tenant["id"])
    cap_rm = REBATE_CAP * float(tenant["monthly_rent_rm"])
    with store.transaction():
        held = store.balance(account)
        headroom_rm = max(0.0, cap_rm - rebate_claimed_rm(store, tenant["id"], month))
        credits = min(held, int(headroom_rm // RM_PER_CREDIT))
        if credits > 0:
            store.post(t, "rebate", account, TREASURY, credits,
                       memo=f"rebate {month}: RM{credits * RM_PER_CREDIT:.2f} off rent")
    return {"credits": credits, "rebate_rm": credits * RM_PER_CREDIT, "cap_rm": cap_rm,
            "held_over": held - credits}


def circulating(store: Store) -> int:
    """Credits SDP has issued and not taken back: exactly what the mint is short."""
    return -store.balance(MINT) - store.balance(TREASURY)
