"""SQLite persistence: residents, tasks, tenants, the credit ledger and the activity feed.

One file, stdlib only. The ledger is append-only double entry -- every movement of Jiran
Credits is a row with a debit account and a credit account -- so a balance is a sum, not
a mutable number someone can overwrite, and the books always add up to zero.

Accounts are plain strings:

* ``<resident id>``    a resident's wallet
* ``escrow:<task id>`` credits locked against one task
* ``tenant:<id>``      credits a commercial tenant has collected
* ``sdp:mint``         SDP's issuing account; it runs negative by exactly the credits in
                       circulation (seed grants and bounties are the only way in)
* ``sdp:treasury``     credits tenants have handed back for their rent rebate
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS residents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    home_building TEXT NOT NULL,
    lon           REAL NOT NULL,
    lat           REAL NOT NULL,
    unit          TEXT,
    verified      INTEGER NOT NULL DEFAULT 0,
    skills        TEXT NOT NULL DEFAULT '[]',
    availability  TEXT NOT NULL DEFAULT '[]',
    has_car       INTEGER NOT NULL DEFAULT 0,
    commute       TEXT,
    occupation    TEXT,
    strengths     TEXT NOT NULL DEFAULT '[]',
    weaknesses    TEXT NOT NULL DEFAULT '[]',
    reliability   REAL NOT NULL DEFAULT 0.9,
    strikes       INTEGER NOT NULL DEFAULT 0,
    suspended     INTEGER NOT NULL DEFAULT 0,
    flagged       TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    requester    TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL,
    skills       TEXT NOT NULL DEFAULT '[]',
    skill_level  INTEGER NOT NULL DEFAULT 0,
    lon          REAL NOT NULL,
    lat          REAL NOT NULL,
    building     TEXT,
    dest_id      TEXT,
    dest_name    TEXT,
    dest_lon     REAL,
    dest_lat     REAL,
    slot         TEXT,
    when_label   TEXT,
    urgency      INTEGER NOT NULL DEFAULT 1,
    est_minutes  INTEGER NOT NULL DEFAULT 30,
    credits      INTEGER NOT NULL,
    status       TEXT NOT NULL,
    provider     TEXT,
    parent_id    TEXT,
    invitee      TEXT,
    start_at     REAL,
    source       TEXT NOT NULL DEFAULT 'rules',
    valuation    TEXT NOT NULL DEFAULT '{}',
    created_t    REAL NOT NULL DEFAULT 0,
    updated_t    REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tenants (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL,
    building        TEXT NOT NULL,
    lon             REAL NOT NULL,
    lat             REAL NOT NULL,
    skills          TEXT NOT NULL DEFAULT '[]',
    offer           TEXT NOT NULL DEFAULT '',
    lead_discount   REAL NOT NULL DEFAULT 0.1,
    monthly_rent_rm REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    t        REAL NOT NULL,
    kind     TEXT NOT NULL,
    debit    TEXT NOT NULL,
    credit   TEXT NOT NULL,
    amount   INTEGER NOT NULL CHECK (amount > 0),
    task_id  TEXT,
    memo     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ledger_debit  ON ledger(debit);
CREATE INDEX IF NOT EXISTS ledger_credit ON ledger(credit);

CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    t       REAL NOT NULL,
    kind    TEXT NOT NULL,
    text    TEXT NOT NULL,
    task_id TEXT,
    actor   TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

JSON_FIELDS = {"skills", "availability", "valuation", "strengths", "weaknesses"}


def _decode(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    out = dict(row)
    for key in JSON_FIELDS & out.keys():
        out[key] = json.loads(out[key]) if out[key] else ([] if key != "valuation" else {})
    for key in ("verified", "has_car", "suspended"):
        if key in out:
            out[key] = bool(out[key])
    return out


def _encode(values: dict) -> dict:
    return {k: (json.dumps(v) if k in JSON_FIELDS else v) for k, v in values.items()}


class Store:
    """Thin, thread-safe wrapper over one SQLite connection.

    The server is single-process; one connection behind a lock is simpler and faster
    than a pool, and keeps the ledger's read-then-write checks atomic.
    """

    def __init__(self, path: str | Path = ":memory:"):
        self.path = str(path)
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        if self.path != ":memory:":
            self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.lock = threading.RLock()

    def _migrate(self) -> None:
        """Columns added after a database was first created. Idempotent."""
        have = {r["name"] for r in self.conn.execute("PRAGMA table_info(tasks)")}
        if "when_label" not in have:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN when_label TEXT")
        for column, decl in (("invitee", "TEXT"), ("start_at", "REAL")):
            if column not in have:
                self.conn.execute(f"ALTER TABLE tasks ADD COLUMN {column} {decl}")
        have = {r["name"] for r in self.conn.execute("PRAGMA table_info(residents)")}
        for column, decl in (("occupation", "TEXT"),
                             ("strengths", "TEXT NOT NULL DEFAULT '[]'"),
                             ("weaknesses", "TEXT NOT NULL DEFAULT '[]'")):
            if column not in have:
                self.conn.execute(f"ALTER TABLE residents ADD COLUMN {column} {decl}")

    # -- plumbing ---------------------------------------------------------

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self.lock:
            return self.conn.execute(sql, tuple(params))

    def transaction(self):
        """``with store.transaction():`` -- all-or-nothing, and holds the lock."""
        return _Transaction(self)

    def reset(self) -> None:
        with self.lock:
            for table in ("ledger", "events", "tasks", "tenants", "residents", "meta"):
                self.conn.execute(f"DELETE FROM {table}")
            self.conn.execute("DELETE FROM sqlite_sequence")

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.execute("INSERT INTO meta(key, value) VALUES (?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    def _insert(self, table: str, values: dict) -> None:
        values = _encode(values)
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        self.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", values.values())

    def _update(self, table: str, key: str, values: dict) -> None:
        if not values:
            return
        values = _encode(values)
        assignments = ", ".join(f"{k} = ?" for k in values)
        self.execute(f"UPDATE {table} SET {assignments} WHERE id = ?", [*values.values(), key])

    # -- residents --------------------------------------------------------

    def add_resident(self, **values) -> None:
        self._insert("residents", values)

    def resident(self, resident_id: str) -> dict | None:
        return _decode(self.execute("SELECT * FROM residents WHERE id = ?",
                                    (resident_id,)).fetchone())

    def residents(self) -> list[dict]:
        return [_decode(r) for r in self.execute("SELECT * FROM residents ORDER BY id")]

    def update_resident(self, resident_id: str, **values) -> None:
        self._update("residents", resident_id, values)

    # -- tasks ------------------------------------------------------------

    def add_task(self, **values) -> None:
        self._insert("tasks", values)

    def task(self, task_id: str) -> dict | None:
        return _decode(self.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())

    def tasks(self, statuses: Iterable[str] | None = None, *, kind: str | None = None,
              parent_id: str | None = None) -> list[dict]:
        sql, params = "SELECT * FROM tasks WHERE 1 = 1", []
        if statuses:
            statuses = list(statuses)
            sql += f" AND status IN ({', '.join('?' for _ in statuses)})"
            params += statuses
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        if parent_id:
            sql += " AND parent_id = ?"
            params.append(parent_id)
        sql += " ORDER BY created_t DESC, id DESC"
        return [_decode(r) for r in self.execute(sql, params)]

    def update_task(self, task_id: str, **values) -> None:
        self._update("tasks", task_id, values)

    def next_task_id(self) -> str:
        with self.lock:
            n = int(self.get_meta("task_seq", "0")) + 1
            self.set_meta("task_seq", str(n))
            return f"T{n:04d}"

    # -- tenants ----------------------------------------------------------

    def add_tenant(self, **values) -> None:
        self._insert("tenants", values)

    def tenant(self, tenant_id: str) -> dict | None:
        return _decode(self.execute("SELECT * FROM tenants WHERE id = ?",
                                    (tenant_id,)).fetchone())

    def tenants(self) -> list[dict]:
        return [_decode(r) for r in self.execute("SELECT * FROM tenants ORDER BY id")]

    # -- ledger -----------------------------------------------------------

    def post(self, t: float, kind: str, debit: str, credit: str, amount: int,
             task_id: str | None = None, memo: str = "") -> int:
        cur = self.execute(
            "INSERT INTO ledger (t, kind, debit, credit, amount, task_id, memo) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)", (t, kind, debit, credit, int(amount), task_id, memo))
        return int(cur.lastrowid)

    def balance(self, account: str) -> int:
        row = self.execute(
            "SELECT COALESCE((SELECT SUM(amount) FROM ledger WHERE credit = ?), 0) - "
            "COALESCE((SELECT SUM(amount) FROM ledger WHERE debit = ?), 0) AS b",
            (account, account)).fetchone()
        return int(row["b"])

    def entries(self, account: str | None = None, *, limit: int = 50,
                kind: str | None = None, since_t: float | None = None) -> list[dict]:
        sql, params = "SELECT * FROM ledger WHERE 1 = 1", []
        if account:
            sql += " AND (debit = ? OR credit = ?)"
            params += [account, account]
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        if since_t is not None:
            sql += " AND t >= ?"
            params.append(since_t)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.execute(sql, params)]

    def all_balances(self) -> dict[str, int]:
        rows = self.execute(
            "SELECT acct, SUM(delta) AS b FROM ("
            " SELECT credit AS acct, amount AS delta FROM ledger"
            " UNION ALL SELECT debit AS acct, -amount AS delta FROM ledger"
            ") GROUP BY acct")
        return {r["acct"]: int(r["b"]) for r in rows}

    # -- events -----------------------------------------------------------

    def log(self, t: float, kind: str, text: str, task_id: str | None = None,
            actor: str | None = None) -> None:
        self.execute("INSERT INTO events (t, kind, text, task_id, actor) VALUES (?, ?, ?, ?, ?)",
                     (t, kind, text, task_id, actor))

    def events(self, limit: int = 40, after_id: int = 0) -> list[dict]:
        rows = self.execute("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?",
                            (after_id, limit))
        return [dict(r) for r in rows]


class _Transaction:
    def __init__(self, store: Store):
        self.store = store

    def __enter__(self):
        self.store.lock.acquire()
        self.store.conn.execute("BEGIN IMMEDIATE")
        return self.store

    def __exit__(self, exc_type, exc, tb):
        try:
            self.store.conn.execute("ROLLBACK" if exc_type else "COMMIT")
        finally:
            self.store.lock.release()
        return False
