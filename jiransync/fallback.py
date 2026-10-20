"""Commercial fallback: when no neighbour can do it, a verified SDP tenant can.

If the matcher finds nobody in reach with the skill (a burst pipe, not a leaky tap), the
request is not left to rot on a board. It becomes a warm lead for the tenant whose trade
covers it, with a resident discount -- which is also how JiranSync sends business to the
township's own shop-lots instead of to a platform outside it.
"""

from __future__ import annotations

from .geo import haversine_m


def offer(task: dict, tenants: list[dict]) -> dict | None:
    """The best tenant for a task, or None if no tenant trade covers it."""
    required = {s.lower() for s in task.get("skills") or []}
    if not required:
        return None
    best, best_key = None, None
    for tenant in tenants:
        covered = required & {s.lower() for s in tenant.get("skills") or []}
        if not covered:
            continue
        distance = float(haversine_m(task["lon"], task["lat"], tenant["lon"], tenant["lat"]))
        key = (-len(covered), distance, tenant["id"])
        if best_key is None or key < best_key:
            best, best_key = tenant, key
    if best is None:
        return None
    pct = round(float(best.get("lead_discount", 0.1)) * 100)
    return {
        "tenant_id": best["id"],
        "name": best["name"],
        "category": best["category"],
        "discount_pct": pct,
        "distance_m": round(best_key[1]),
        "lon": best["lon"],
        "lat": best["lat"],
        "message": (f"No neighbour nearby lists {', '.join(sorted(required))}. "
                    f"{best['name']} can help — JiranSync residents get {pct}% off."),
    }
