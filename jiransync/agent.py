"""Task understanding: turn a resident's free-text request into a structured task.

Two engines behind one function, :func:`understand`:

* **Claude** -- when ``ANTHROPIC_API_KEY`` (or another Anthropic credential) is present.
  One request with a JSON-schema structured output: the model reads "need someone to
  fix my leaking tap and help carry a new cabinet up, ideally tonight" and returns the
  title, the skills, the decomposition into micro-tasks, time and urgency.
* **Rules** -- keyword matching over the same vocabulary. Deterministic, offline, and
  what every test runs against. It is also the safety net: any API error, refusal or
  malformed answer falls back here, so the request is never lost.

The model only *proposes*. It never moves credits, never picks who gets pinged (that is
``matching.py``) and never sets the price (that is ``valuation.py``) -- its output is
clamped to the platform's own vocabulary before anything else reads it.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field

log = logging.getLogger("jiransync.agent")

MODEL = os.environ.get("JIRANSYNC_MODEL", "claude-opus-5-5")

# The skills a resident can list and a task can require. Closed on purpose: matching is
# set intersection, so free-form skills would never meet.
SKILLS = (
    "driving", "errands", "groceries", "moving", "cleaning", "gardening", "cooking",
    "childcare", "eldercare", "pet care", "tutoring", "tech help", "repairs",
    "carpentry", "plumbing", "electrical", "sewing", "translation", "photography",
    "first aid",
)

# Trades that need real expertise. Valued higher, and the ones the commercial fallback
# exists for.
EXPERT_SKILLS = {"plumbing", "electrical"}
SKILLED_SKILLS = {"tutoring", "tech help", "repairs", "carpentry", "sewing",
                  "translation", "photography", "first aid", "eldercare", "childcare"}


@dataclass
class Subtask:
    title: str
    skills: list[str]
    est_minutes: int


@dataclass
class Understanding:
    title: str
    kind: str                       # "help" or "ride"
    skills: list[str]
    skill_level: int                # 0 everyday, 1 skilled, 2 expert
    urgency: int                    # 1 flexible, 2 today, 3 now
    slot: str | None                # morning / afternoon / evening
    when: str | None                # human label, e.g. "Tomorrow · 8:00 AM"
    est_minutes: int
    materials_rm: float
    destination: str | None         # transit hub id, for rides
    subtasks: list[Subtask] = field(default_factory=list)
    summary: str = ""
    source: str = "rules"           # "claude" or "rules"
    note: str = ""                  # why the rules answered, when Claude was expected

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- rules

KEYWORDS: dict[str, tuple[str, ...]] = {
    "plumbing": ("pipe", "tap", "leak", "plumb", "toilet", "sink", "drain", "clog",
                 "water heater", "faucet"),
    "electrical": ("wiring", "socket", "fuse", "circuit", "electric", "power point",
                   "ceiling fan install", "trip"),
    "repairs": ("fix", "repair", "broken", "hinge", "door", "fan", "lamp", "bulb",
                "install", "assemble", "ikea", "mount"),
    "carpentry": ("shelf", "shelves", "wood", "furniture repair", "carpent",
                  "hinge"),
    "moving": ("carry", "move", "moving", "lift heavy", "sofa", "heavy", "boxes",
               "wardrobe", "cabinet"),
    "tutoring": ("tutor", "homework", "math", "maths", "science", "exam", "spm",
                 "teach", "lesson", "revision"),
    "tech help": ("computer", "laptop", "phone", "wifi", "router", "printer",
                  "email", "app", "online banking", "setup my"),
    "childcare": ("babysit", "kids", "child", "pick up my son", "pick up my daughter",
                  "school pickup", "nanny"),
    "eldercare": ("elderly", "grandma", "grandpa", "my mother", "my father", "nenek",
                  "atuk", "clinic appointment", "accompany"),
    "pet care": ("dog", "cat", "pet", "walk my", "feed my"),
    "groceries": ("grocer", "groceries", "supermarket", "market", "pasar"),
    "errands": ("parcel", "pick up", "collect", "post office", "pharmacy", "errand",
                "drop off", "buy"),
    "cleaning": ("clean", "sweep", "mop", "wash"),
    "gardening": ("garden", "plant", "grass", "lawn", "prune", "weed"),
    "cooking": ("cook", "meal", "bake", "food for", "kenduri"),
    "sewing": ("sew", "hem", "stitch", "alter", "tailor"),
    "translation": ("translate", "translation", "mandarin", "tamil", "malay letter",
                    "form in"),
    "photography": ("photo", "photograph", "camera", "picture"),
    "first aid": ("first aid", "injured", "bleeding", "fainted"),
}

RIDE_WORDS = ("ride", "lift", "carpool", "drive me", "car pool", "tumpang", "give me a lift",
              "send me to", "drop me")
HUB_WORDS = {
    # Matched against hub ids/aliases from places.json at runtime; these are defaults.
    "mrt": None, "lrt": None, "ktm": None, "station": None,
}
URGENT_WORDS = ("urgent", "asap", "emergency", "right now", "immediately", "now!",
                "flooding", "burst")
TODAY_WORDS = ("today", "tonight", "this evening", "this afternoon", "this morning",
               "soon", "later")

MINUTES = {
    "plumbing": 60, "electrical": 60, "repairs": 45, "carpentry": 60, "moving": 45,
    "tutoring": 60, "tech help": 40, "childcare": 120, "eldercare": 90, "pet care": 30,
    "groceries": 45, "errands": 30, "cleaning": 60, "gardening": 60, "cooking": 60,
    "sewing": 45, "translation": 30, "photography": 60, "first aid": 20, "driving": 20,
}


def _has(text: str, word: str) -> bool:
    return re.search(r"(?<![a-z])" + re.escape(word), text) is not None


def _slot(text: str) -> str | None:
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", text)
    if m:
        hour = int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0)
        return "morning" if 5 <= hour < 12 else ("afternoon" if hour < 18 else "evening")
    if any(_has(text, w) for w in ("morning", "breakfast", "subuh")):
        return "morning"
    if any(_has(text, w) for w in ("afternoon", "lunch", "after school")):
        return "afternoon"
    if any(_has(text, w) for w in ("evening", "tonight", "night", "dinner", "after work")):
        return "evening"
    return None


DAYS = {
    "this morning": "Today", "this afternoon": "Today", "this evening": "Today",
    "today": "Today", "tonight": "Tonight", "tomorrow": "Tomorrow", "esok": "Tomorrow",
    "this weekend": "This weekend", "weekend": "Weekend", "monday": "Mon", "tuesday": "Tue",
    "wednesday": "Wed", "thursday": "Thu", "friday": "Fri", "saturday": "Sat",
    "sunday": "Sun", "weekday": "Weekdays",
}


def _when(text: str, slot: str | None) -> str | None:
    """A short label a neighbour can scan: "Tomorrow · 8:00 AM", "Sat · Morning"."""
    day = next((label for word, label in DAYS.items() if _has(text, word)), None)
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", text)
    clock = f"{int(m.group(1))}:{m.group(2) or '00'} {m.group(3).upper()}" if m else None
    part = clock or (slot.capitalize() if slot and day != "Tonight" else None)
    bits = [b for b in (day, part) if b]
    return " · ".join(bits) if bits else None


def _clauses(text: str) -> list[str]:
    parts = re.split(r"\b(?:and then|then|and also|also|plus)\b|[;,]|\band\b", text)
    return [p.strip() for p in parts if p and len(p.strip()) > 3]


def _skills_in(text: str) -> list[str]:
    found = [skill for skill, words in KEYWORDS.items() if any(_has(text, w) for w in words)]
    # "fix my leaking tap" is plumbing, not generic repairs.
    if ("plumbing" in found or "electrical" in found) and "repairs" in found:
        found.remove("repairs")
    if "carpentry" in found and "repairs" in found and not any(
            _has(text, w) for w in ("fix", "repair", "broken")):
        found.remove("repairs")
    return found


def _title(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip().rstrip(".!?")
    text = re.sub(r"^(hi|hello|hey)[,!. ]+", "", text, flags=re.I)
    text = re.sub(r"^(i\s+)?(really\s+)?(need|want|would like|looking for)\s+(someone\s+to\s+|help\s+(with\s+|to\s+)?|a\s+)?",
                  "", text, flags=re.I)
    text = text[:1].upper() + text[1:] if text else "Help needed"
    return text if len(text) <= 60 else text[:57].rstrip() + "…"


def rules(text: str, hubs: list[dict] | None = None) -> Understanding:
    """Keyword understanding. Deterministic: the same text always gives the same task."""
    raw = text.strip()
    low = raw.lower()
    hubs = hubs or []

    # The most specific name wins: "MRT Sungai Buloh" must not match a hub whose alias
    # is just "mrt".
    destination, best = None, 0
    for hub in hubs:
        names = [hub["id"].lower(), hub["name"].lower(), *[a.lower() for a in hub.get("aliases", [])]]
        for n in names:
            if n and n in low and len(n) > best:
                destination, best = hub["id"], len(n)
    mentions_transit = any(_has(low, w) for w in ("mrt", "lrt", "ktm", "station", "train"))
    ride = any(w in low for w in RIDE_WORDS) or (mentions_transit and any(
        _has(low, w) for w in ("to the", "get to", "go to", "going to", "need to get")))
    if ride and destination is None and mentions_transit and hubs:
        destination = hubs[0]["id"]

    urgency = 3 if any(w in low for w in URGENT_WORDS) else (
        2 if any(_has(low, w) for w in TODAY_WORDS) else 1)
    slot = _slot(low)

    if ride:
        hub = next((h for h in hubs if h["id"] == destination), None)
        where = hub["name"] if hub else "the station"
        return Understanding(
            title=f"Ride to {where}", kind="ride", skills=["driving"], skill_level=0,
            urgency=urgency, slot=slot, when=_when(low, slot), est_minutes=15,
            materials_rm=0.0,
            destination=destination,
            subtasks=[], summary=f"Carpool to {where}" + (f", {slot}" if slot else ""),
        )

    subtasks: list[Subtask] = []
    seen: set[str] = set()
    for clause in _clauses(low):
        skills = [s for s in _skills_in(clause) if s not in seen]
        if not skills:
            continue
        seen.update(skills)
        subtasks.append(Subtask(_title(clause), skills,
                                max(MINUTES.get(s, 30) for s in skills)))
    skills = _skills_in(low) or ["errands"]
    for s in skills:
        seen.add(s)
    level = 2 if EXPERT_SKILLS & set(skills) else (1 if SKILLED_SKILLS & set(skills) else 0)
    minutes = sum(t.est_minutes for t in subtasks) if len(subtasks) > 1 else max(
        MINUTES.get(s, 30) for s in skills)
    if len(subtasks) < 2:
        subtasks = []
    return Understanding(
        title=_title(raw), kind="help", skills=skills, skill_level=level, urgency=urgency,
        slot=slot, when=_when(low, slot), est_minutes=int(minutes), materials_rm=0.0,
        destination=None,
        subtasks=subtasks,
        summary=("Split into " + " + ".join(t.title.lower() for t in subtasks)) if subtasks
        else f"Needs {', '.join(skills)}",
    )


# -------------------------------------------------------------------------- claude

SYSTEM = """You turn a resident's request for neighbourly help in a Malaysian housing \
township into a structured task for a community time-bank app. Residents write in \
English, Malay or a mix (Manglish); read them generously.

Rules:
- kind is "ride" only when the person needs to be driven somewhere (a lift, a carpool, \
"tumpang", a ride to a train station); everything else is "help".
- For rides, set destination to one of the listed transit hub ids if the request names \
or clearly implies it, else null. Rides need skills ["driving"].
- skills must come only from the allowed list. Pick the fewest that cover the job.
- skill_level: 0 everyday task anyone can do, 1 needs practice (tutoring, repairs), \
2 needs a trade (plumbing, electrical).
- urgency: 1 flexible, 2 should happen today, 3 urgent right now (leak, emergency).
- slot: the part of day it should happen (morning before 12, afternoon 12-6, evening \
after 6), or null if unstated.
- when: a short label of when it is needed, as the resident said it, like "Tomorrow · \
8:00 AM", "Sat · Morning" or "Today"; null if unstated.
- est_minutes: realistic hands-on minutes for one neighbour, excluding travel. For a \
carpool, the driver's detour only (usually 10-20).
- materials_rm: out-of-pocket ringgit the helper would spend on parts or supplies, \
0 if none or if the requester supplies them.
- subtasks: if the request bundles jobs that need different people (e.g. fix a tap \
AND carry a cabinet), split it into micro-tasks, each with its own skills and minutes. \
Otherwise return an empty list.
- title: short, neutral, under 60 characters, no personal names or unit numbers.
- summary: one plain sentence a neighbour would read before accepting."""


def _schema(hub_ids: list[str]) -> dict:
    nullable_hubs = {"anyOf": [{"type": "string", "enum": hub_ids}, {"type": "null"}]} \
        if hub_ids else {"type": "null"}
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "kind": {"type": "string", "enum": ["help", "ride"]},
            "skills": {"type": "array", "items": {"type": "string", "enum": list(SKILLS)}},
            "skill_level": {"type": "integer", "enum": [0, 1, 2]},
            "urgency": {"type": "integer", "enum": [1, 2, 3]},
            "slot": {"anyOf": [{"type": "string", "enum": ["morning", "afternoon", "evening"]},
                               {"type": "null"}]},
            "when": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "est_minutes": {"type": "integer"},
            "materials_rm": {"type": "number"},
            "destination": nullable_hubs,
            "subtasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "skills": {"type": "array",
                                   "items": {"type": "string", "enum": list(SKILLS)}},
                        "est_minutes": {"type": "integer"},
                    },
                    "required": ["title", "skills", "est_minutes"],
                    "additionalProperties": False,
                },
            },
            "summary": {"type": "string"},
        },
        "required": ["title", "kind", "skills", "skill_level", "urgency", "slot", "when",
                     "est_minutes", "materials_rm", "destination", "subtasks", "summary"],
        "additionalProperties": False,
    }


def _clamp(data: dict, hubs: list[dict]) -> Understanding:
    """Never trust the shape blindly: coerce everything into the platform's vocabulary."""
    hub_ids = {h["id"] for h in hubs}
    allowed = set(SKILLS)
    skills = [s for s in data.get("skills") or [] if s in allowed] or ["errands"]
    kind = "ride" if data.get("kind") == "ride" else "help"
    if kind == "ride":
        skills = ["driving"]
    subtasks = []
    for item in data.get("subtasks") or []:
        sub_skills = [s for s in item.get("skills") or [] if s in allowed]
        if sub_skills:
            subtasks.append(Subtask(str(item.get("title") or "Subtask")[:60], sub_skills,
                                    int(min(480, max(5, item.get("est_minutes") or 30)))))
    slot = data.get("slot") if data.get("slot") in ("morning", "afternoon", "evening") else None
    destination = data.get("destination") if data.get("destination") in hub_ids else None
    return Understanding(
        title=str(data.get("title") or "Help needed")[:60],
        kind=kind,
        skills=skills,
        skill_level=int(min(2, max(0, data.get("skill_level") or 0))),
        urgency=int(min(3, max(1, data.get("urgency") or 1))),
        slot=slot,
        when=str(data["when"])[:40] if data.get("when") else None,
        est_minutes=int(min(480, max(5, data.get("est_minutes") or 30))),
        materials_rm=float(min(500.0, max(0.0, data.get("materials_rm") or 0.0))),
        destination=destination if kind == "ride" else None,
        subtasks=subtasks if len(subtasks) > 1 else [],
        summary=str(data.get("summary") or "")[:200],
        source="claude",
    )


def claude_available() -> bool:
    if os.environ.get("JIRANSYNC_AGENT", "").lower() == "rules":
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _ask_claude(text: str, hubs: list[dict]) -> Understanding:
    import anthropic

    client = anthropic.Anthropic(timeout=30.0, max_retries=1)
    hub_lines = "\n".join(f"- {h['id']}: {h['name']}" for h in hubs) or "- (none)"
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=4000,
        # A short extraction: low effort keeps it quick and cheap.
        output_config={"effort": "low",
                       "format": {"type": "json_schema", "schema": _schema([h["id"] for h in hubs])}},
        # If a safety classifier declines, let the API retry on its default fallback model
        # rather than dropping the request.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM,
        messages=[{"role": "user", "content":
                   f"Transit hubs:\n{hub_lines}\n\nRequest:\n{text.strip()[:2000]}"}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("model declined the request")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("answer was cut off")
    body = next(b.text for b in response.content if b.type == "text")
    return _clamp(json.loads(body), hubs)


def understand(text: str, hubs: list[dict] | None = None) -> Understanding:
    """Structured understanding of a request. Claude when available, rules otherwise."""
    hubs = hubs or []
    if not text or not text.strip():
        raise ValueError("describe what you need help with")
    if claude_available():
        try:
            return _ask_claude(text, hubs)
        except Exception as err:  # noqa: BLE001 -- any failure must fall back, not 500
            log.warning("Claude task understanding failed, using rules: %s", err)
            result = rules(text, hubs)
            result.note = f"Claude unavailable ({type(err).__name__}); rule engine answered"
            return result
    return rules(text, hubs)
