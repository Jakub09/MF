#!/usr/bin/env python3
"""
Generuje przykładowy CSV w układzie z JCL/DCOLCSV.jcl (do testów bez mainframe).

  python3 gen_sample_csv.py --days 7 --out sample/
  -> sample/DCOLLECT.<SYSID>.YYYY-MM-DD.CSV, plik na system i dzień

Zakres 8080-80FF jest współdzielony przez SYSA i SYSB. Kilka dysków ma
celowo błędy (VTOC index wyłączony, duża fragmentacja, mało DSCB, offline),
a dwa znikają z ostatniego wsadu SYSA (nieaktualne dane).

Konflikty między systemami (SYSB, do testu dcol2influx.py):
  9100 BKP100   - ten sam DEVNUM co SYS100 na SYSA, inny wolumen
  A0F1 SYS101   - duplikat VOLSER (na SYSA SYS101 to M3 pod 9101, tu M9)
  A0F2 TST05S   - ten sam wolumen co na SYSA (9001), inny adres na SYSB
  8085          - SYSB raportuje inną storage group (SGPROD2)
"""
import argparse
import random
from datetime import date, timedelta
from pathlib import Path

HEADER = (
    "VOLSER;SYSID;DCOL_DATE;DCOL_TIME;REC_VERSION;DEVTYPE;DEVNUM;STORGRP;V_FLAG2_HEX;PCT_FREE;"
    "FREE_KB;ALLOC_KB;CAPACITY_KB;FRAG_INDEX;LARGEST_FREE_EXT_KB;FREE_EXTENTS;FREE_DSCBS;"
    "FREE_VIRS;CYLMG_FREE_KB;CYLMG_ALLOC_KB;CYLMG_CAPACITY_KB;CYLMG_FRAG_INDEX;"
    "CYLMG_LARGEST_FREE_KB;CYLMG_FREE_EXTENTS;IXVTOC_EXISTS;IXVTOC_ENABLED;USE_PRIVATE;"
    "USE_PUBLIC;USE_STORAGE;SHARED_DASD;VL_FOUND;VL_UPD_USER;VL_UPD_DATE;VL_UPD_TIME;"
    "SYS1_SMS;SYS1_MVS;SYS2_SMS;SYS2_MVS;SYS3_SMS;SYS3_MVS;SYS4_SMS;SYS4_MVS;"
    "SYS5_SMS;SYS5_MVS;SYS6_SMS;SYS6_MVS;SYS7_SMS;SYS7_MVS;SYS8_SMS;SYS8_MVS;"
    "CP_FOUND;CP_FLAGS_HEX;CP_DATE;CP_TARGET_OCC_PCT;CP_TRIGGER_OCC_PCT;CP_OCC_BEFORE_PCT;"
    "CP_OCC_AFTER_PCT;CP_NOT_MIGRATED_PCT;CP_INTERVAL_MIGR"
)
CYL_KB = 15 * 56664 / 1024
CYLS = {"M1": 1113, "M3": 3339, "M9": 10017, "M27": 32760, "M54": 65520, "EAV": 262668}

# (pierwszy adres, liczba wierszy po 16, modele wierszy, grupa SMS / None = non-SMS, prefiks VOLSER, systemy)
RANGES = [
    (0x8080, 8, ["M54", "M27", "M1", "M9", "EAV", "M54", "M27", "EAV"], "SGPROD", "PR", ["SYSA", "SYSB"]),
    (0x9000, 4, ["M9", "M9", "M27", "M27"], "SGTEST", "TS", ["SYSA"]),
    (0x9100, 2, ["M3", "M3"], None, "SY", ["SYSA"]),
    (0xA000, 3, ["M54", "M54", "M27"], "SGDB2", "DB", ["SYSB"]),
]
COLLECT_TIME = {"SYSA": "02:15", "SYSB": "03:10"}
# Dodatkowe wolumeny widoczne tylko w danym systemie: (system, DEVNUM, VOLSER, model, SG, "jak" - kopia danych innego dysku)
EXTRA = [
    ("SYSB", "9100", "BKP100", "M3", None, None),
    ("SYSB", "A0F1", "SYS101", "M9", None, None),
    ("SYSB", "A0F2", "TST05S", "M9", "SGTEST", "9001"),
]
# Inne wartości dla dysku w danym systemie
OVERRIDES = {("SYSB", "8085"): {"sg": "SGPROD2"}}
# Nazewnictwo VOLSER per zakres (do testu wykrywania wzorców w panelu):
#   PR080  - PR + 3 cyfry hex z adresu      TST04S - TST + kolejny numer hex + S
#   SYS106 - SYS + 3 cyfry hex z adresu     DB2001 - DB2 + kolejny numer hex
NAMES = {
    "PR": lambda addr, n: f"PR{addr & 0xFFF:03X}",
    "TS": lambda addr, n: f"TST{n + 4:02X}S",
    "SY": lambda addr, n: f"SYS1{addr & 0xFF:02X}",
    "DB": lambda addr, n: f"DB2{n + 1:03X}",
}


def volumes(rng: random.Random):
    for start, rows, models, sg, prefix, systems in RANGES:
        for r in range(rows):
            for c in range(16):
                n = r * 16 + c
                if sg is None and n % 7 == 6:
                    continue  # dziury w adresacji
                addr = start + n
                yield {
                    "devnum": f"{addr:04X}",
                    "volser": NAMES[prefix](addr, n),
                    "model": models[r],
                    "sg": sg,
                    "base_used": rng.uniform(20, 95),
                    "trend": rng.uniform(-0.4, 1.2),
                    "offline": rng.random() < 0.03,
                    "quiesced": sg is not None and rng.random() < 0.04,
                    "ixvtoc_off": rng.random() < 0.02,
                    "fragmented": rng.random() < 0.03,
                    "low_dscb": rng.random() < 0.02,
                    "vanishes": addr in (0x9013, 0x902A),
                    # EAV: zajętość części cylinder-managed inna niż track-managed
                    "eav_delta": rng.uniform(-45, 25),
                    "systems": systems,
                }


def row(v, day: date, k: int, sysid: str, seed: int) -> str:
    # wartości zależne tylko od dysku i dnia - wspólny dysk ma te same dane w obu systemach
    rng = random.Random(f"{seed}-{v.get('seed_devnum', v['devnum'])}-{k}")
    cyls = CYLS[v["model"]]
    cap = int(cyls * CYL_KB)
    used = min(99.5, max(1.0, v["base_used"] + v["trend"] * k + rng.uniform(-1.5, 1.5)))
    eav = v["model"] == "EAV"
    cylmg_cap = int((cyls - 65520) * CYL_KB) if eav else 0
    cyl_used = min(99.5, max(1.0, used + v["eav_delta"])) if eav else 0
    cylmg_alloc = int(cylmg_cap * cyl_used / 100)
    cylmg_free = cylmg_cap - cylmg_alloc
    # used = zajętość części track-managed, suma liczona z obu części
    alloc = int((cap - cylmg_cap) * used / 100) + cylmg_alloc
    free = cap - alloc
    pct_free = int(free * 100 / cap)
    frag = rng.randint(850, 990) if v["fragmented"] else rng.randint(0, 600)
    sms = v["sg"] is not None
    mvs = "OFFLINE" if v["offline"] else "ONLINE"
    smsst = "QUINEW" if v["quiesced"] else "ENABLE"
    systems = [smsst, mvs, smsst, mvs] + [""] * 12 if sms else [""] * 16
    vl = ["Y", "SMSADM", "2026-09-30", "12:00:00", *systems] if sms else ["N"] + [""] * 19
    cp = (
        ["Y", "80", day.isoformat(), "70", "85", f"{int(used)}", f"{max(0, int(used) - 8)}", "3", "1"]
        if sms
        else ["N"] + [""] * 8
    )
    fields = [
        v["volser"], sysid, day.isoformat(), f"{COLLECT_TIME[sysid]}:3{rng.randint(0, 9)}", "2", "3390",
        v["devnum"], v["sg"] or "", "00", str(pct_free),
        str(free), str(alloc), str(cap), str(frag), str(int(free * rng.uniform(0.2, 0.9))),
        str(rng.randint(1, 400)), str(rng.randint(5, 40) if v["low_dscb"] else rng.randint(300, 4000)),
        str(rng.randint(10, 400)),
        str(cylmg_free), str(cylmg_cap - cylmg_free), str(cylmg_cap), str(frag if eav else 0),
        str(int(cylmg_free * 0.6)), str(rng.randint(1, 50) if eav else 0),
        "Y", "N" if v["ixvtoc_off"] else "Y", "N" if sms else "Y", "N", "Y" if sms else "N", "Y",
        *vl, *cp,
    ]
    return ";".join(fields)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--out", default="sample")
    p.add_argument("--seed", type=int, default=42)
    a = p.parse_args()
    rng = random.Random(a.seed)
    vols = list(volumes(rng))
    by_devnum = {v["devnum"]: v for v in vols}
    for sysid, devnum, volser, model, sg, like in EXTRA:
        base = dict(by_devnum[like]) if like else dict(vols[0], offline=False, quiesced=False, vanishes=False)
        # "like": ten sam wolumen - dane liczone z DEVNUM oryginału, więc identyczne w obu systemach
        vols.append(dict(base, devnum=devnum, seed_devnum=like or devnum, volser=volser, model=model, sg=sg, systems=[sysid]))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    today = date.today()
    for k in range(a.days):
        day = today - timedelta(days=a.days - 1 - k)
        last = k == a.days - 1
        for sysid in COLLECT_TIME:
            rows = [
                row(dict(v, **OVERRIDES.get((sysid, v["devnum"]), {})), day, k, sysid, a.seed)
                for v in vols
                if sysid in v["systems"] and not (last and v["vanishes"])
            ]
            path = out / f"DCOLLECT.{sysid}.{day.isoformat()}.CSV"
            path.write_text("\n".join([HEADER] + rows) + "\n")
            print(path)


if __name__ == "__main__":
    main()
