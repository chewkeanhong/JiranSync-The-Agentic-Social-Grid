"""The Jiran Credits ledger: zero-sum peer to peer, escrow, redemption, the rebate cap."""

from __future__ import annotations

import pytest

from jiransync import credits
from jiransync.store import Store


def wallet(store: Store, *ids: str) -> None:
    for rid in ids:
        credits.grant_seed(store, rid)


def task(task_id="T1", requester="A", provider="B", amount=2, kind="help"):
    return {"id": task_id, "requester": requester, "provider": provider,
            "credits": amount, "kind": kind}


def test_seed_grant_is_issued_once_and_comes_from_the_mint():
    store = Store()
    credits.grant_seed(store, "A")
    credits.grant_seed(store, "A")
    assert store.balance("A") == credits.SEED_GRANT
    assert store.balance(credits.MINT) == -credits.SEED_GRANT
    assert credits.circulating(store) == credits.SEED_GRANT


def test_escrow_moves_credits_and_release_pays_the_provider():
    store = Store()
    wallet(store, "A", "B")
    t = task(amount=2)
    credits.lock_escrow(store, t, 1.0)
    assert store.balance("A") == 1
    assert store.balance(credits.escrow_account("T1")) == 2
    assert credits.release(store, t, 2.0) == 2
    assert store.balance("B") == 5
    assert store.balance(credits.escrow_account("T1")) == 0


def test_peer_to_peer_is_zero_sum():
    """Helping a neighbour moves credits; it never creates them."""
    store = Store()
    wallet(store, "A", "B", "C")
    before = credits.circulating(store)
    for n, (a, b) in enumerate([("A", "B"), ("B", "C"), ("C", "A")]):
        t = task(f"T{n}", a, b, 1)
        credits.lock_escrow(store, t, 0)
        credits.release(store, t, 0)
    assert credits.circulating(store) == before
    assert sum(store.all_balances().values()) == 0


def test_cannot_lock_more_than_you_hold():
    store = Store()
    wallet(store, "A")
    with pytest.raises(credits.CreditError):
        credits.lock_escrow(store, task(amount=credits.SEED_GRANT + 1), 0)
    assert store.balance("A") == credits.SEED_GRANT


def test_cannot_release_twice_or_lock_twice():
    store = Store()
    wallet(store, "A")
    t = task(amount=1)
    credits.lock_escrow(store, t, 0)
    with pytest.raises(credits.CreditError):
        credits.lock_escrow(store, t, 0)
    credits.release(store, t, 0)
    with pytest.raises(credits.CreditError):
        credits.release(store, t, 0)


def test_refund_returns_escrow_to_the_requester():
    store = Store()
    wallet(store, "A")
    t = task(amount=2)
    credits.lock_escrow(store, t, 0)
    assert credits.refund(store, t, 1) == 2
    assert store.balance("A") == credits.SEED_GRANT
    assert credits.refund(store, t, 2) == 0


def test_bounties_are_minted_by_sdp_not_paid_by_a_resident():
    store = Store()
    t = task(requester="sdp", amount=4, kind="bounty")
    credits.lock_escrow(store, t, 0)
    credits.release(store, t, 0)
    assert store.balance("B") == 4
    assert credits.circulating(store) == 4


def test_redeem_converts_credits_to_a_ringgit_discount():
    store = Store()
    wallet(store, "A")
    tenant = {"id": "cafe", "name": "Cafe", "monthly_rent_rm": 1000}
    assert credits.redeem(store, "A", tenant, 2, 0) == 2 * credits.RM_PER_CREDIT
    assert store.balance("A") == 1
    assert store.balance(credits.tenant_account("cafe")) == 2
    with pytest.raises(credits.CreditError):
        credits.redeem(store, "A", tenant, 5, 0)


def test_rent_rebate_is_capped_at_five_percent_and_holds_the_rest_over():
    store = Store()
    tenant = {"id": "cafe", "name": "Cafe", "monthly_rent_rm": 100.0}   # cap RM5 = 2 credits
    for rid in "ABCD":
        credits.grant_seed(store, rid)
        credits.redeem(store, rid, tenant, 1, 0)
    first = credits.claim_rebate(store, tenant, "M1", 0)
    assert first["credits"] == 2
    assert first["rebate_rm"] <= 0.05 * 100.0
    assert first["held_over"] == 2
    # The month's cap is used up: nothing more moves until next month.
    assert credits.claim_rebate(store, tenant, "M1", 1)["credits"] == 0
    assert credits.claim_rebate(store, tenant, "M2", 2)["credits"] == 2
    assert sum(store.all_balances().values()) == 0
