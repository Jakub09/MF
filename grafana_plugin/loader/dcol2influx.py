#!/usr/bin/env python3
"""
Ładuje CSV z JCL/DCOLCSV.jcl (DCOLLECT -> DFSORT, separator ';') z wielu systemów do InfluxDB 1.x
i rozwiązuje konflikty między systemami.

Measurement dasd_volume - punkt na (system, DEVNUM, wsad):
  tagi : sysid, devnum, storgrp (pusty -> NONSMS), vol (= VOLSER - etykieta w alertach Grafany)
  pola : volser, devtype, model, pct_free, pct_used, *_kb, flagi Y/N, sys1_sms..sys8_mvs, cp_*,
         storage_group, collected_at (ms), EAV: pct_used_trk / pct_used_cyl,
         conflict_error / conflict_warning (wynik uzgadniania systemów, "" = brak),
         liczbowe pod reguły alertów: conflict_level (0 brak, 1 ostrzeżenie, 2 błąd),
         mvs_offline / sms_disabled / sms_quiesced (w ilu systemach SMS taki status)
  czas : DCOL_DATE + DCOL_TIME (strefa --tz)

Każdy system ładuje się niezależnie (pliki mogą spływać w dowolnej kolejności i o różnych porach).
Po zapisie skrypt bierze z InfluxDB OSTATNI wsad każdego aktywnego systemu i uzgadnia je:

  konflikt                                                  poziom
  ten sam DEVNUM, różne VOLSER w różnych systemach          error    (inne urządzenie pod tym adresem)
  ten sam VOLSER pod różnymi DEVNUM, inna pojemność         error    (duplikat VOLSER - dwa różne wolumeny)
  ten sam VOLSER pod różnymi DEVNUM, ta sama pojemność      warning  (ten sam wolumen, inna adresacja w systemie)
  ten sam dysk, różna pojemność / typ urządzenia            error
  ten sam dysk, różna storage group                         warning  (różne konfiguracje SMS)
  duplikat DEVNUM / VOLSER w jednym wsadzie                 error

Wynik trafia do pól conflict_* ostatnich punktów zaangażowanych systemów (nadpisanie pól w istniejącym
punkcie), a konflikt, którego już nie ma, jest czyszczony (""). Wartości dysku widzianego przez kilka
systemów: panel bierze najnowszy wsad, listę systemów składa ze wszystkich.
System aktywny = jego ostatni wsad jest najwyżej --stale-hours starszy od najnowszego wsadu.

Jeden VOLSER może mieć kilka wierszy (N rekordów C z HSM) - zostaje ostatni (JCL sortuje po dacie C).

Potwierdzanie zmian (measurement dasd_change, zapisywane z panelu mapy): zmiana "pending" starsza niż
wczytany wsad dostaje status "confirmed", gdy wsad to potwierdza (add/modify: DEVNUM jest i zgadza się
VOLSER/SG, remove: DEVNUM zniknął). Zmiany z listą systemów sprawdzane są tylko we wsadach z tych systemów.

Użycie:
  python3 dcol2influx.py DCOLLECT.SYSA.CSV DCOLLECT.SYSB.CSV [--url http://localhost:8086] [--db metrics]
  python3 dcol2influx.py plik.csv --sysid SYSC     # plik bez kolumny SYSID / z innym SYSID
  python3 dcol2influx.py *.CSV --dry-run           # line protocol + raport konfliktów (tylko z plików)
  python3 dcol2influx.py --reconcile-only          # samo uzgodnienie systemów (bez plików)
Kod wyjścia: 0 = OK, 1 = błąd, 2 = OK, ale są konflikty typu error (--fail-on-conflict).
Plik z mainframe przesłany jako tekst (FTP ASCII / iconv z IBM-1047).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

MEASUREMENT = "dasd_volume"
CHANGE_MEASUREMENT = "dasd_change"

# Nagłówek z JCL (HEADER1) - używany, gdy plik go nie ma
DEFAULT_HEADER = (
    "VOLSER;SYSID;DCOL_DATE;DCOL_TIME;REC_VERSION;DEVTYPE;DEVNUM;STORGRP;V_FLAG2_HEX;PCT_FREE;"
    "FREE_KB;ALLOC_KB;CAPACITY_KB;FRAG_INDEX;LARGEST_FREE_EXT_KB;FREE_EXTENTS;FREE_DSCBS;"
    "FREE_VIRS;CYLMG_FREE_KB;CYLMG_ALLOC_KB;CYLMG_CAPACITY_KB;CYLMG_FRAG_INDEX;"
    "CYLMG_LARGEST_FREE_KB;CYLMG_FREE_EXTENTS;IXVTOC_EXISTS;IXVTOC_ENABLED;USE_PRIVATE;"
    "USE_PUBLIC;USE_STORAGE;SHARED_DASD;VL_FOUND;VL_UPD_USER;VL_UPD_DATE;VL_UPD_TIME;"
    "SYS1_SMS;SYS1_MVS;SYS2_SMS;SYS2_MVS;SYS3_SMS;SYS3_MVS;SYS4_SMS;SYS4_MVS;"
    "SYS5_SMS;SYS5_MVS;SYS6_SMS;SYS6_MVS;SYS7_SMS;SYS7_MVS;SYS8_SMS;SYS8_MVS;"
    "CP_FOUND;CP_FLAGS_HEX;CP_DATE;CP_TARGET_OCC_PCT;CP_TRIGGER_OCC_PCT;CP_OCC_BEFORE_PCT;"
    "CP_OCC_AFTER_PCT;CP_NOT_MIGRATED_PCT;CP_INTERVAL_MIGR"
).split(";")

# Kolumny liczbowe (całkowite) - nazwa pola = nazwa kolumny małymi literami
INT_COLUMNS = [
    "REC_VERSION", "PCT_FREE", "FREE_KB", "ALLOC_KB", "CAPACITY_KB", "FRAG_INDEX",
    "LARGEST_FREE_EXT_KB", "FREE_EXTENTS", "FREE_DSCBS", "FREE_VIRS",
    "CYLMG_FREE_KB", "CYLMG_ALLOC_KB", "CYLMG_CAPACITY_KB", "CYLMG_FRAG_INDEX",
    "CYLMG_LARGEST_FREE_KB", "CYLMG_FREE_EXTENTS",
    "CP_TARGET_OCC_PCT", "CP_TRIGGER_OCC_PCT", "CP_OCC_BEFORE_PCT",
    "CP_OCC_AFTER_PCT", "CP_NOT_MIGRATED_PCT", "CP_INTERVAL_MIGR",
]
# Kolumny tekstowe
STR_COLUMNS = [
    "VOLSER", "DEVTYPE", "V_FLAG2_HEX",
    "IXVTOC_EXISTS", "IXVTOC_ENABLED", "USE_PRIVATE", "USE_PUBLIC", "USE_STORAGE", "SHARED_DASD",
    "VL_FOUND", "VL_UPD_USER", "VL_UPD_DATE", "VL_UPD_TIME",
    *[f"SYS{i}_{k}" for i in range(1, 9) for k in ("SMS", "MVS")],
    "CP_FOUND", "CP_FLAGS_HEX", "CP_DATE",
]

DEVNUM_RE = re.compile(r"^[0-9A-F]{4,5}$")
VOLSER_RE = re.compile(r"^[A-Z0-9#$@]{1,6}$")

# 3390: 15 ścieżek x 56664 B na cylinder
BYTES_PER_CYL_3390 = 15 * 56664
# (max cylindrów, model) - z zapasem na zaokrąglenia
MODELS_3390 = [(1200, "M1"), (3500, "M3"), (10100, "M9"), (33000, "M27"), (65600, "M54")]

MVS_OFFLINE = {"OFFLINE", "PEND_OFF", "BOXED", "NOT_READY"}
SMS_DISABLED = {"DISALL", "DISNEW"}
SMS_QUIESCED = {"QUIALL", "QUINEW"}

# Różnica pojemności traktowana jako "ta sama" (zaokrąglenia między poziomami z/OS)
CAPACITY_TOLERANCE = 0.01


# --------------------------------------------------------------------------- mapowanie CSV


@dataclass
class Volume:
    """Jeden wolumen z jednego wsadu jednego systemu"""

    sysid: str
    devnum: str
    volser: str
    storgrp: str
    devtype: str
    capacity_kb: int | None
    time_ms: int
    row: dict = field(default_factory=dict, repr=False)


def model_of(devtype: str, capacity_kb: int | None, cylmg_capacity_kb: int | None) -> str:
    if not devtype.startswith("3390"):
        return devtype or "?"
    if cylmg_capacity_kb:
        return "EAV"
    if not capacity_kb:
        return "?"
    cyls = capacity_kb * 1024 / BYTES_PER_CYL_3390
    for limit, model in MODELS_3390:
        if cyls <= limit:
            return model
    return "EAV"


def esc_tag(v: str) -> str:
    return v.replace("\\", "\\\\").replace(",", r"\,").replace("=", r"\=").replace(" ", r"\ ")


def esc_str(v: str) -> str:
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def to_int(v: str | None) -> int | None:
    v = (v or "").strip()
    if not v:
        return None
    try:
        return int(v)
    except ValueError:
        return None


def read_csv(path: str, encoding: str, sysid: str | None, tz: ZoneInfo, log) -> list[Volume]:
    """CSV -> wolumeny. Odrzuca wiersze z błędnym DEVNUM / VOLSER / datą (z komunikatem)."""
    with open(path, newline="", encoding=encoding) as f:
        lines = f.read().splitlines()
    if not lines:
        return []
    first = [c.strip().upper() for c in lines[0].split(";")]
    has_header = "VOLSER" in first and "DEVNUM" in first
    header = first if has_header else DEFAULT_HEADER
    body = lines[1:] if has_header else lines

    latest: dict[tuple[str, str], dict] = {}
    for n, values in enumerate(csv.reader(body, delimiter=";"), start=2 if has_header else 1):
        if not any(v.strip() for v in values):
            continue
        row = {h: (values[i].strip() if i < len(values) else "") for i, h in enumerate(header)}
        if sysid:
            row["SYSID"] = sysid
        row["SYSID"] = (row.get("SYSID") or "").upper()
        row["DEVNUM"] = (row.get("DEVNUM") or "").upper().zfill(4)
        row["VOLSER"] = (row.get("VOLSER") or "").upper()
        if not row["SYSID"]:
            log(f"{path}:{n}: brak SYSID - użyj --sysid")
            continue
        if not DEVNUM_RE.match(row["DEVNUM"]) or not VOLSER_RE.match(row["VOLSER"]):
            log(f"{path}:{n}: pominięto - DEVNUM {row['DEVNUM']!r} / VOLSER {row['VOLSER']!r}")
            continue
        # ostatni wiersz wolumenu w danym dniu = najnowszy rekord C
        latest[(row["VOLSER"], row.get("DCOL_DATE", ""))] = row

    out = []
    for row in latest.values():
        try:
            ts = datetime.strptime(f'{row["DCOL_DATE"]} {row["DCOL_TIME"]}', "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz)
        except (KeyError, ValueError):
            log(f"{path}: pominięto {row['VOLSER']} - data/czas {row.get('DCOL_DATE')!r} {row.get('DCOL_TIME')!r}")
            continue
        out.append(
            Volume(
                sysid=row["SYSID"],
                devnum=row["DEVNUM"],
                volser=row["VOLSER"],
                storgrp=(row.get("STORGRP") or "").upper() or "NONSMS",
                devtype=row.get("DEVTYPE", ""),
                capacity_kb=to_int(row.get("CAPACITY_KB")),
                time_ms=int(ts.timestamp() * 1000),
                row=row,
            )
        )
    return out


def volume_tags(sysid: str, devnum: str, storgrp: str, vol: str | None) -> dict[str, str]:
    """Tagi punktu - vol tylko gdy znany (punkty sprzed dodania tagu nie mają go w kluczu serii)"""
    tags = {"sysid": sysid, "devnum": devnum, "storgrp": storgrp}
    if vol:
        tags["vol"] = vol
    return tags


def to_line(v: Volume) -> str:
    row = v.row
    tags = volume_tags(v.sysid, v.devnum, v.storgrp, v.volser)
    fields: dict[str, str] = {}
    ints = {c: to_int(row.get(c)) for c in INT_COLUMNS}
    for c, val in ints.items():
        if val is not None:
            fields[c.lower()] = f"{val}i"
    for c in STR_COLUMNS:
        val = (row.get(c) or "").strip()
        if val:
            fields[c.lower()] = esc_str(val)

    fields["storage_group"] = esc_str(v.storgrp)
    fields["collected_at"] = f"{v.time_ms}i"
    # puste pola od razu - inaczej last() w zapytaniu sięgnąłby po konflikt z wcześniejszego wsadu
    fields["conflict_error"] = esc_str("")
    fields["conflict_warning"] = esc_str("")
    fields["conflict_level"] = "0i"
    # statusy ze wszystkich systemów konfiguracji SMS (SYS1..SYS8) jako liczby - pod reguły alertów
    status = lambda kind: [(row.get(f"SYS{i}_{kind}") or "").strip().upper() for i in range(1, 9)]
    fields["mvs_offline"] = f"{sum(s in MVS_OFFLINE for s in status('MVS'))}i"
    fields["sms_disabled"] = f"{sum(s in SMS_DISABLED for s in status('SMS'))}i"
    fields["sms_quiesced"] = f"{sum(s in SMS_QUIESCED for s in status('SMS'))}i"
    fields["model"] = esc_str(model_of(v.devtype, ints["CAPACITY_KB"], ints["CYLMG_CAPACITY_KB"]))
    if ints["PCT_FREE"] is not None:
        fields["pct_used"] = f"{100 - ints['PCT_FREE']}i"
    if ints["CAPACITY_KB"] and ints["ALLOC_KB"] is not None:
        # dokładniejszy procent niż całkowity PCT_FREE z DCOLLECT
        fields["pct_used_exact"] = f"{100 * ints['ALLOC_KB'] / ints['CAPACITY_KB']:.2f}"
    # EAV: osobno track-managed (całość minus część cylinder-managed) i cylinder-managed
    cyl_cap, cyl_alloc = ints["CYLMG_CAPACITY_KB"], ints["CYLMG_ALLOC_KB"]
    if cyl_cap and cyl_alloc is not None and ints["CAPACITY_KB"] and ints["ALLOC_KB"] is not None:
        trk_cap = ints["CAPACITY_KB"] - cyl_cap
        trk_alloc = ints["ALLOC_KB"] - cyl_alloc
        fields["pct_used_cyl"] = f"{100 * cyl_alloc / cyl_cap:.1f}"
        if trk_cap > 0:
            fields["trk_capacity_kb"] = f"{trk_cap}i"
            fields["trk_alloc_kb"] = f"{trk_alloc}i"
            fields["pct_used_trk"] = f"{100 * trk_alloc / trk_cap:.1f}"
    return point(tags, fields, v.time_ms)


def point(tags: dict[str, str], fields: dict[str, str], time_ms: int, measurement: str = MEASUREMENT) -> str:
    tag_str = ",".join(f"{k}={esc_tag(val)}" for k, val in sorted(tags.items()))
    field_str = ",".join(f"{k}={val}" for k, val in fields.items())
    return f"{measurement},{tag_str} {field_str} {time_ms}"


# --------------------------------------------------------------------------- InfluxDB


def write(url: str, db: str, lines: list[str], batch: int = 5000) -> None:
    for i in range(0, len(lines), batch):
        body = ("\n".join(lines[i : i + batch]) + "\n").encode()
        req = urllib.request.Request(f"{url.rstrip('/')}/write?db={db}&precision=ms", data=body, method="POST")
        with urllib.request.urlopen(req) as resp:
            if resp.status not in (200, 204):
                raise RuntimeError(f"InfluxDB: HTTP {resp.status} {resp.read()[:300]!r}")


def query(url: str, db: str, q: str) -> list[dict]:
    params = urllib.parse.urlencode({"db": db, "q": q, "epoch": "ms"})
    with urllib.request.urlopen(f"{url.rstrip('/')}/query?{params}") as resp:
        res = json.load(resp)["results"][0]
    if "error" in res:
        raise RuntimeError(f"InfluxDB: {res['error']}")
    rows = []
    for serie in res.get("series", []):
        for values in serie["values"]:
            rows.append({**serie.get("tags", {}), **dict(zip(serie["columns"], values))})
    return rows


def quote_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


@dataclass
class Snapshot:
    """Ostatni wsad systemu (z InfluxDB: z obecnymi polami conflict_*)"""

    sysid: str
    batch_ms: int
    volumes: list[Volume]
    current: dict[tuple[str, str], tuple[str, str]]  # (devnum, storgrp) -> (conflict_error, conflict_warning)
    vol_tags: dict[str, str | None] = field(default_factory=dict)  # devnum -> tag vol zapisanego punktu


def load_snapshots(url: str, db: str, lookback_days: int, window_hours: float, stale_hours: float, log) -> list[Snapshot]:
    """Ostatni wsad każdego aktywnego systemu"""
    last = query(
        url, db, f'SELECT last("collected_at") AS t FROM "{MEASUREMENT}" WHERE time > now() - {lookback_days}d GROUP BY "sysid"'
    )
    batches = {r["sysid"]: int(r["t"]) for r in last if r.get("t")}
    if not batches:
        return []
    newest = max(batches.values())
    out = []
    for sysid, batch_ms in sorted(batches.items()):
        if newest - batch_ms > stale_hours * 3600_000:
            log(f"system {sysid}: ostatni wsad {fmt_ms(batch_ms)} - nieaktywny (> {stale_hours:g} h), pomijam w uzgadnianiu")
            continue
        start = batch_ms - int(window_hours * 3600_000)
        rows = query(
            url,
            db,
            'SELECT "volser", "capacity_kb", "devtype", "conflict_error", "conflict_warning", "devnum", "storgrp", "vol" '
            f'FROM "{MEASUREMENT}" WHERE "sysid" = {quote_str(sysid)} AND time >= {start}ms AND time <= {batch_ms}ms',
        )
        # najnowszy punkt per DEVNUM w oknie wsadu
        per_dev: dict[str, dict] = {}
        for r in rows:
            if r.get("volser") and (r["devnum"] not in per_dev or r["time"] >= per_dev[r["devnum"]]["time"]):
                per_dev[r["devnum"]] = r
        vols, current, vol_tags = [], {}, {}
        for r in per_dev.values():
            vol_tags[r["devnum"]] = r.get("vol")
            storgrp = r.get("storgrp") or "NONSMS"
            vols.append(
                Volume(
                    sysid=sysid,
                    devnum=r["devnum"],
                    volser=r["volser"],
                    storgrp=storgrp,
                    devtype=r.get("devtype") or "",
                    capacity_kb=int(r["capacity_kb"]) if r.get("capacity_kb") is not None else None,
                    time_ms=int(r["time"]),
                )
            )
            current[(r["devnum"], storgrp)] = (r.get("conflict_error") or "", r.get("conflict_warning") or "")
        out.append(Snapshot(sysid, batch_ms, vols, current, vol_tags))
    return out


def snapshots_from_files(volumes: list[Volume]) -> list[Snapshot]:
    """--dry-run: ostatni wsad każdego systemu tylko z wczytanych plików"""
    by_sys: dict[str, list[Volume]] = defaultdict(list)
    for v in volumes:
        by_sys[v.sysid].append(v)
    out = []
    for sysid, vols in sorted(by_sys.items()):
        batch_day = max(v.row.get("DCOL_DATE", "") for v in vols)
        latest = [v for v in vols if v.row.get("DCOL_DATE", "") == batch_day]
        out.append(Snapshot(sysid, max(v.time_ms for v in latest), latest, {}))
    return out


# --------------------------------------------------------------------------- uzgadnianie systemów


@dataclass
class Conflicts:
    errors: dict[tuple[str, str], list[str]] = field(default_factory=lambda: defaultdict(list))
    warnings: dict[tuple[str, str], list[str]] = field(default_factory=lambda: defaultdict(list))
    report: list[tuple[str, str]] = field(default_factory=list)  # (poziom, opis) - raz na konflikt

    def add(self, level: str, volumes: list[Volume], message_for, summary: str) -> None:
        target = self.errors if level == "error" else self.warnings
        for v in volumes:
            target[(v.sysid, v.devnum)].append(message_for(v))
        self.report.append((level, summary))


def gib(kb: int | None) -> str:
    return "?" if kb is None else f"{kb / 1024 / 1024:.1f} GiB"


def same_capacity(a: int | None, b: int | None) -> bool:
    if a is None or b is None:
        return True
    return abs(a - b) <= CAPACITY_TOLERANCE * max(a, b)


def others(v: Volume, group: list[Volume], show) -> str:
    return ", ".join(f"{o.sysid}: {show(o)}" for o in group if o is not v)


def reconcile(snapshots: list[Snapshot]) -> Conflicts:
    c = Conflicts()
    vols = [v for s in snapshots for v in s.volumes]

    # 1. duplikaty w jednym wsadzie (nie powinny wystąpić - błąd danych / JCL)
    for key_name, key in (("DEVNUM", lambda v: (v.sysid, v.devnum)), ("VOLSER", lambda v: (v.sysid, v.volser))):
        groups: dict[tuple, list[Volume]] = defaultdict(list)
        for v in vols:
            groups[key(v)].append(v)
        for (sysid, k), group in groups.items():
            if len(group) > 1:
                desc = ", ".join(f"{o.volser}@{o.devnum}" for o in group)
                c.add(
                    "error",
                    group,
                    lambda v, k=k, sysid=sysid, desc=desc: f"Duplikat {key_name} {k} w wsadzie {sysid}: {desc}",
                    f"{sysid}: {key_name} {k} występuje {len(group)}x w jednym wsadzie ({desc})",
                )

    # 2. ten sam DEVNUM w różnych systemach
    by_dev: dict[str, list[Volume]] = defaultdict(list)
    for v in vols:
        by_dev[v.devnum].append(v)
    for devnum, group in sorted(by_dev.items()):
        if len({v.sysid for v in group}) < 2:
            continue
        if len({v.volser for v in group}) > 1:
            c.add(
                "error",
                group,
                lambda v, g=group, d=devnum: f"DEVNUM {d}: inny wolumen w " + others(v, g, lambda o: o.volser),
                f"DEVNUM {devnum}: różne wolumeny - " + ", ".join(f"{v.sysid}={v.volser}" for v in group),
            )
            continue
        name = f"{group[0].volser}@{devnum}"
        if not all(same_capacity(group[0].capacity_kb, v.capacity_kb) for v in group):
            c.add(
                "error",
                group,
                lambda v, g=group: f"Różna pojemność: {v.sysid} {gib(v.capacity_kb)}, " + others(v, g, lambda o: gib(o.capacity_kb)),
                f"{name}: różna pojemność - " + ", ".join(f"{v.sysid}={gib(v.capacity_kb)}" for v in group),
            )
        if len({v.devtype for v in group if v.devtype}) > 1:
            c.add(
                "error",
                group,
                lambda v, g=group: f"Różny typ urządzenia: {v.sysid} {v.devtype}, " + others(v, g, lambda o: o.devtype),
                f"{name}: różny typ urządzenia - " + ", ".join(f"{v.sysid}={v.devtype}" for v in group),
            )
        if len({v.storgrp for v in group}) > 1:
            c.add(
                "warning",
                group,
                lambda v, g=group: f"Różna SG: {v.sysid} {v.storgrp}, " + others(v, g, lambda o: o.storgrp),
                f"{name}: różna storage group - " + ", ".join(f"{v.sysid}={v.storgrp}" for v in group),
            )

    # 3. ten sam VOLSER pod różnymi DEVNUM w różnych systemach
    by_vol: dict[str, list[Volume]] = defaultdict(list)
    for v in vols:
        by_vol[v.volser].append(v)
    for volser, group in sorted(by_vol.items()):
        cross = [v for v in group if any(o.devnum != v.devnum and o.sysid != v.sysid for o in group)]
        if not cross:
            continue
        if all(same_capacity(cross[0].capacity_kb, v.capacity_kb) for v in cross):
            c.add(
                "warning",
                cross,
                lambda v, g=cross, vs=volser: f"{vs} widoczny też pod innym adresem: " + others(v, g, lambda o: o.devnum),
                f"VOLSER {volser}: ten sam wolumen pod różnymi adresami - " + ", ".join(f"{v.sysid}={v.devnum}" for v in cross),
            )
        else:
            c.add(
                "error",
                cross,
                lambda v, g=cross, vs=volser: f"Duplikat VOLSER {vs}: " + others(v, g, lambda o: f"{o.devnum} ({gib(o.capacity_kb)})"),
                f"VOLSER {volser}: dwa różne wolumeny - "
                + ", ".join(f"{v.sysid}={v.devnum} ({gib(v.capacity_kb)})" for v in cross),
            )
    return c


def stale_conflict_lines(url: str, db: str, snapshots: list[Snapshot], lookback_days: int) -> list[str]:
    """Czyści konflikty w punktach spoza bieżących wsadów (wolumen zniknął, system nieaktywny, starszy wsad)"""
    current = {(v.sysid, v.devnum, v.time_ms) for s in snapshots for v in s.volumes}
    rows = query(
        url,
        db,
        'SELECT "conflict_error", "conflict_warning", "sysid", "devnum", "storgrp", "vol" '
        f"FROM \"{MEASUREMENT}\" WHERE time > now() - {lookback_days}d AND (\"conflict_error\" <> '' OR \"conflict_warning\" <> '')",
    )
    empty = {"conflict_error": esc_str(""), "conflict_warning": esc_str(""), "conflict_level": "0i"}
    return [
        point(volume_tags(r["sysid"], r["devnum"], r.get("storgrp") or "NONSMS", r.get("vol")), empty, int(r["time"]))
        for r in rows
        if (r["sysid"], r["devnum"], int(r["time"])) not in current
    ]


def conflict_lines(snapshots: list[Snapshot], c: Conflicts) -> list[str]:
    """Pola conflict_* w ostatnim punkcie każdego dysku - tylko tam, gdzie wynik się zmienił"""
    lines = []
    for s in snapshots:
        for v in s.volumes:
            err = "; ".join(dict.fromkeys(c.errors.get((v.sysid, v.devnum), [])))
            warn = "; ".join(dict.fromkeys(c.warnings.get((v.sysid, v.devnum), [])))
            if s.current.get((v.devnum, v.storgrp), ("", "")) != (err, warn):
                tags = volume_tags(v.sysid, v.devnum, v.storgrp, s.vol_tags.get(v.devnum, v.volser))
                level = 2 if err else 1 if warn else 0
                fields = {"conflict_error": esc_str(err), "conflict_warning": esc_str(warn), "conflict_level": f"{level}i"}
                lines.append(point(tags, fields, v.time_ms))
    return lines


# --------------------------------------------------------------------------- potwierdzanie zmian

CHANGE_FIELDS = ["type", "volser", "storgrp", "model", "systems", "comment", "user", "status", "created_at", "updated_at"]


def pending_changes(url: str, db: str) -> dict[str, dict]:
    """Aktualny stan zmian: ostatni punkt per DEVNUM (każdy punkt ma komplet pól)."""
    latest: dict[str, dict] = {}
    for row in query(url, db, f'SELECT * FROM "{CHANGE_MEASUREMENT}"'):
        latest[row["devnum"]] = row  # wyniki rosnąco po czasie
    return {d: r for d, r in latest.items() if r.get("status") == "pending"}


def confirms(change: dict, batch: dict[str, Volume]) -> bool:
    v = batch.get(change["devnum"])
    if change.get("type") == "remove":
        return v is None
    if v is None:
        return False
    want_vol = (change.get("volser") or "").strip().upper()
    want_sg = (change.get("storgrp") or "").strip().upper()
    return (not want_vol or want_vol == v.volser) and (not want_sg or want_sg == v.storgrp)


def confirm_changes(url: str, db: str, volumes: list[Volume], log) -> list[str]:
    changes = pending_changes(url, db)
    if not changes:
        return []
    # wsady: (system, dzień) -> DEVNUM -> wolumen
    batches: dict[tuple[str, str], dict[str, Volume]] = defaultdict(dict)
    for v in volumes:
        batches[(v.sysid, v.row.get("DCOL_DATE", ""))][v.devnum] = v
    lines = []
    now_ms = int(datetime.now().timestamp() * 1000)
    for devnum, ch in changes.items():
        systems = [s.strip().upper() for s in (ch.get("systems") or "").split(",") if s.strip()]
        for (sysid, day), batch in sorted(batches.items(), key=lambda kv: kv[0][1]):
            if systems and sysid not in systems:
                continue
            batch_ms = max(v.time_ms for v in batch.values())
            if batch_ms <= int(ch.get("created_at") or 0) or not confirms(ch, batch):
                continue
            fields = {k: ch.get(k) for k in CHANGE_FIELDS}
            fields["status"] = "confirmed"
            fields["updated_at"] = now_ms
            fields["confirmed_batch"] = f"{sysid} {day}"
            parts = {
                k: f"{int(val or 0)}i" if k in ("created_at", "updated_at") else esc_str(str(val or ""))
                for k, val in fields.items()
            }
            lines.append(point({"devnum": devnum}, parts, now_ms, CHANGE_MEASUREMENT))
            log(f"potwierdzono zmianę {ch.get('type')} {devnum} {ch.get('volser') or ''} ({sysid} {day})")
            break
    return lines


# --------------------------------------------------------------------------- main


def fmt_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", nargs="*")
    p.add_argument("--url", default="http://localhost:8086")
    p.add_argument("--db", default="metrics")
    p.add_argument("--tz", default="Europe/Warsaw", help="strefa czasowa DCOL_DATE/DCOL_TIME")
    p.add_argument("--encoding", default="utf-8")
    p.add_argument("--sysid", help="SYSID dla wszystkich plików (nadpisuje kolumnę SYSID)")
    p.add_argument("--dry-run", action="store_true", help="bez zapisu: line protocol na stdout, raport na stderr")
    p.add_argument("--no-confirm", action="store_true", help="nie potwierdzaj zmian z dasd_change")
    p.add_argument("--no-reconcile", action="store_true", help="bez uzgadniania systemów")
    p.add_argument("--reconcile-only", action="store_true", help="tylko uzgadnianie (bez plików)")
    p.add_argument("--stale-hours", type=float, default=48, help="system bez wsadu dłużej = nieaktywny (domyślnie 48)")
    p.add_argument("--window-hours", type=float, default=6, help="okno czasowe jednego wsadu (domyślnie 6)")
    p.add_argument("--lookback-days", type=int, default=30, help="jak daleko szukać ostatnich wsadów (domyślnie 30)")
    p.add_argument("--fail-on-conflict", action="store_true", help="kod wyjścia 2, gdy są konflikty typu error")
    p.add_argument("-q", "--quiet", action="store_true", help="tylko błędy i podsumowanie")
    a = p.parse_args()
    if not a.csv and not a.reconcile_only:
        p.error("podaj pliki CSV albo --reconcile-only")

    log = lambda msg: print(msg, file=sys.stderr)
    verbose = (lambda msg: None) if a.quiet else log
    tz = ZoneInfo(a.tz)

    volumes: list[Volume] = []
    for path in a.csv:
        vols = read_csv(path, a.encoding, a.sysid.upper() if a.sysid else None, tz, log)
        verbose(f"{path}: {len(vols)} wolumenów, system {', '.join(sorted({v.sysid for v in vols})) or '?'}")
        volumes.extend(vols)

    lines = [to_line(v) for v in volumes]
    if a.dry_run:
        print("\n".join(lines))
        snapshots = snapshots_from_files(volumes)
    else:
        if lines:
            write(a.url, a.db, lines)
            log(f"zapisano {len(lines)} punktów do {a.url} db={a.db}")
        if not a.no_confirm and volumes:
            confirmed = confirm_changes(a.url, a.db, volumes, verbose)
            if confirmed:
                write(a.url, a.db, confirmed)
        snapshots = [] if a.no_reconcile else load_snapshots(a.url, a.db, a.lookback_days, a.window_hours, a.stale_hours, log)

    if a.no_reconcile:
        return 0
    conflicts = reconcile(snapshots)
    if not a.dry_run:
        updates = stale_conflict_lines(a.url, a.db, snapshots, a.lookback_days) + conflict_lines(snapshots, conflicts)
        if updates:
            write(a.url, a.db, updates)
        verbose(f"zaktualizowano pola conflict_* w {len(updates)} punktach")

    log("uzgodniono systemy: " + ", ".join(f"{s.sysid} ({len(s.volumes)} wol., wsad {fmt_ms(s.batch_ms)})" for s in snapshots))
    errors = [r for lvl, r in conflicts.report if lvl == "error"]
    warnings = [r for lvl, r in conflicts.report if lvl == "warning"]
    for r in errors:
        log(f"  BŁĄD       {r}")
    for r in warnings:
        verbose(f"  OSTRZEŻ.   {r}")
    log(f"konflikty: {len(errors)} błędów, {len(warnings)} ostrzeżeń")
    return 2 if a.fail_on_conflict and errors else 0


if __name__ == "__main__":
    sys.exit(main())
