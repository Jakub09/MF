/**
 * Syntetyczne pliki po ekstrakcji DFSORT (SYSNAME;GROUPID;linia) - do testow dashboardu i --estimate.
 * Komunikaty wg skladni z HSM_ARC_KOMUNIKATY.md; wartosci losowe (powtarzalne - staly seed).
 * Trendy czasu trwania (do wykresow): rosna - backup wolumenow SYS1, backup CDS, space management,
 * FR copy poola CPDB2P2; maleje - EXPIREBV; stale - dump, ABACKUP, backup wolumenow SYS2.
 *
 *   tsx tools/gen-sample-logs.ts --out <katalog> [--days 14] [--end 2026-11-12] [--query-every 60]
 *
 * Na kazdy dzien i system (SYS1/host A, SYS2/host B): MIGLOG, BAKLOG, DMPLOG, CMDLOG, ABRLOG
 * oraz snapshoty QUERY ACTIVE co --query-every minut (HSMQRY.H<id>.QACTIVE.Dyyddd.Thhmmss).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
    options: {
        out: { type: 'string' },
        days: { type: 'string', default: '14' },
        end: { type: 'string', default: new Date().toISOString().slice(0, 10) },
        'query-every': { type: 'string', default: '60' },
    },
});
if (!opt.out) {
    console.error('Uzycie: tsx tools/gen-sample-logs.ts --out <katalog> [--days 14] [--end RRRR-MM-DD] [--query-every 60]');
    process.exit(1);
}

let seed = 20261112;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const p2 = (n: number) => String(n).padStart(2, '0');
const hms = (s: number) => `${p2(Math.floor(s / 3600) % 24)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;

const SYSTEMS = [{ sys: 'SYS1', host: 'A', vols: 40, prefix: 'PRD' }, { sys: 'SYS2', host: 'B', vols: 25, prefix: 'TST' }];
const end = new Date(`${opt.end}T00:00:00Z`);
const days = Number(opt.days);
fs.mkdirSync(opt.out, { recursive: true });
let files = 0;

for (let d = days - 1; d >= 0; d--) {
    const day = new Date(end.getTime() - d * 86_400_000);
    const yy = String(day.getUTCFullYear()).slice(2);
    const doy = Math.floor((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
    const ddd = String(doy).padStart(3, '0');
    const ymd = `${yy}/${p2(day.getUTCMonth() + 1)}/${p2(day.getUTCDate())}`;
    const dayIdx = days - 1 - d;

    for (const s of SYSTEMS) {
        let gid = 0;
        const logs: Record<string, string[]> = { MIGLOG: [], BAKLOG: [], DMPLOG: [], CMDLOG: [], ABRLOG: [] };
        const rec = (log: string, ...lines: string[]) => {
            gid++;
            for (const l of lines) logs[log].push(`${s.sys.padEnd(8)};${String(gid).padStart(8, '0')};${l}`);
        };
        const vol = (i: number) => `${s.prefix}${String(i).padStart(3, '0')}`;

        // --- MIGLOG: PSM 01:00, SM per wolumen ---
        rec('MIGLOG', 'ARC0520I PRIMARY SPACE MANAGEMENT STARTING');
        let t = 3600 + int(0, 60);
        for (let v = 0; v < s.vols; v++) {
            rec('MIGLOG', `ARC0522I SPACE MANAGEMENT STARTING ON VOLUME ${vol(v)}(SMS) AT ${hms(t)} ON ${ymd}, SYSTEM ${s.sys}`);
            const n = int(0, 6);
            for (let k = 0; k < n; k++) {
                rec('MIGLOG', `ARC0734I ACTION=MIGRATE FRVOL=${vol(v)} TOVOL=MIG${int(200, 203)} TRACKS=${String(int(15, 3000)).padStart(8)} RC=   0, REASON=   0, AGE=${String(int(30, 400)).padStart(4)}, DSN=${s.prefix}.APP${v}.DS${k}`);
            }
            const elapsed = Math.round(int(20, 600) * (1 + dayIdx * 0.03));
            if (rnd() < 0.02) {
                rec('MIGLOG', `ARC0570I PRIMARY SPACE MANAGEMENT FOR ${vol(v)} VOLUME(S) TERMINATED, RC=8, REASON=${int(1, 9)}`);
            } else {
                rec('MIGLOG', `ARC0523I SPACE MANAGEMENT ENDED ON VOLUME ${vol(v)}, ${n * int(3, 12)} DATA SET(S) MIGRATED/DELETED, ${int(500, 40000)} TRACK(S) FREED, MINAGE 30, 0% CLOUD DATA SETS, TIME ${hms(elapsed)}`);
            }
            t += elapsed + int(1, 30);
        }
        rec('MIGLOG', rnd() < 0.1 ? 'ARC0521I PRIMARY SPACE MANAGEMENT COMPLETED, ENDING TIME REACHED' : 'ARC0521I PRIMARY SPACE MANAGEMENT ENDED SUCCESSFULLY');
        if (dayIdx % 7 === 0) {
            rec('MIGLOG', 'ARC0517I SECONDARY SPACE MANAGEMENT STARTING');
            rec('MIGLOG', 'ARC0518I SECONDARY SPACE MANAGEMENT ENDED SUCCESSFULLY');
        }

        // --- BAKLOG: CDS backup 00:30, autobackup 02:00, EXPIREBV 05:00, FR 03:00 ---
        const cdsFail = s.sys === 'SYS1' && dayIdx === days - 4;
        t = 1800;
        rec('BAKLOG', `ARC0740I CDS BACKUP STARTING AT ${hms(t)} ON ${ymd}, SYSTEM ${s.sys}, TO DASD IN PARALLEL MODE, DATAMOVER = DSS`);
        for (const ds of ['MCDS', 'BCDS', 'OCDS']) rec('BAKLOG', `ARC0742I BACKUP FOR ${ds} STARTING AT ${hms(t + 1)} ON ${ymd}, BACKUP COPY TECHNIQUE IS CACHEPREFERRED.`);
        rec('BAKLOG', `ARC0750I BACKUP FOR JRNL STARTING AT ${hms(t + 1)} ON ${ymd}, BACKUP TECHNIQUE IS NON-INTRUSIVE`);
        const cdsBase: Record<string, number> = { JRNL: 10, OCDS: 15, MCDS: 45, BCDS: 80 };
        const cdsTime = (ds: string) => Math.round(cdsBase[ds] * (1 + dayIdx * 0.06)) + int(0, 5);
        let cdsEnd = 0;
        for (const ds of ['JRNL', 'OCDS', 'MCDS', 'BCDS']) {
            const dt = cdsTime(ds);
            cdsEnd = Math.max(cdsEnd, dt);
            if (cdsFail && ds === 'BCDS') {
                rec('BAKLOG', 'ARC0744E BCDS COULD NOT BE BACKED UP, RC=12, REAS=8', 'ARC0744E (CONT.) MIGRATION, BACKUP, FRBACKUP, DUMP, AND RECYCLE HELD');
            } else {
                rec('BAKLOG', `ARC0743I ${ds} SUCCESSFULLY BACKED UP TO HSM.${ds}.BACKUP.D${String(dayIdx).padStart(7, '0')}, ON VOLUME(S) HSMB0${int(1, 4)}, TIME=${hms(t + dt)}, DATE=${ymd}`);
            }
        }
        rec('BAKLOG', `ARC0741I CDS BACKUP ENDING AT ${hms(t + cdsEnd + 2)} ON ${ymd}, STATUS=${cdsFail ? 'UNSUCCESSFUL' : 'SUCCESSFUL'}`);
        if (!cdsFail) rec('BAKLOG', `ARC0748I LAST SUCCESSFUL CDS BACKUP - SET QUALIFIER IS 'D${String(dayIdx).padStart(7, '0')}'`);
        // journal zapelnia sie w ciagu dnia, kasowany po backupie CDS
        rec('BAKLOG', `ARC0909E JOURNAL DATA SET IS ABOUT ${Math.min(95, 60 + dayIdx * 3 + int(0, 5))}% FULL`);

        rec('BAKLOG', 'ARC0720I AUTOMATIC BACKUP STARTING');
        t = 7200;
        for (let v = 0; v < s.vols; v++) {
            rec('BAKLOG', `ARC0722I BACKUP STARTING ON VOLUME ${vol(v)}(SMS) AT ${hms(t)} ON ${ymd} SYSTEM ${s.sys}`);
            const dur = s.sys === 'SYS1' ? Math.round(int(30, 400) * (1 + dayIdx * 0.05)) : int(30, 400);
            t += dur;
            if (rnd() < 0.015) rec('BAKLOG', `ARC0570I AUTOMATIC BACKUP FOR ${vol(v)} VOLUME(S) TERMINATED, RC=17, REASON=0`);
            else rec('BAKLOG', `ARC0723I BACKUP ENDING ON VOLUME ${vol(v)} AT ${hms(t)}, ${int(0, 250)} DATA SETS BACKED UP`);
            t += int(1, 20);
        }
        rec('BAKLOG', 'ARC0721I AUTOMATIC BACKUP ENDING');

        if (s.sys === 'SYS1') {
            t = 10800;
            for (const cp of ['CPDB2P1', 'CPDB2P2']) {
                rec('BAKLOG', `ARC1801I FAST REPLICATION BACKUP IS STARTING FOR COPY POOL ${cp}, AT ${hms(t)} ON ${ymd}, TOKEN=${cp}BKP`);
                const failed = cp === 'CPDB2P2' && dayIdx % 5 === 2;
                if (failed) rec('BAKLOG', `ARC1806E FAST REPLICATION BACKUP HAS FAILED FOR COPY POOL ${cp}, RC=4`);
                const nvol = cp === 'CPDB2P1' ? 12 : 24;
                rec('BAKLOG', `ARC1802I FAST REPLICATION BACKUP HAS COMPLETED FOR COPY POOL ${cp}, AT ${hms(t + (cp === 'CPDB2P2' ? 20 + dayIdx * 4 + int(0, 5) : int(8, 15)))} ON ${ymd}, FUNCTION RC=${failed ? '0008' : '0000'}, MAXIMUM VOLUME RC=${failed ? '0008' : '0000'}`);
                const bad = failed ? 2 : 0;
                rec('BAKLOG', `ARC1805I THE FOLLOWING ${nvol - bad} VOLUME(S) WERE SUCCESSFULLY PROCESSED BY FAST REPLICATION BACKUP OF COPY POOL ${cp}`,
                    ...Array.from({ length: nvol - bad }, (_, i) => `ARC1805I (CONT.) DB${cp.slice(-1)}${String(i).padStart(3, '0')}`));
                if (bad) {
                    rec('BAKLOG', `ARC1803E THE FOLLOWING ${bad} VOLUME(S) FAILED DURING FAST REPLICATION BACKUP OF COPY POOL ${cp}`,
                        ...Array.from({ length: bad }, (_, i) => `ARC1803E (CONT.) DB${cp.slice(-1)}${String(nvol - 1 - i).padStart(3, '0')}`));
                }
                t += 120;
            }
        }

        t = 18000;
        rec('BAKLOG', `ARC0680I EXPIRE BACKUP VERSIONS STARTING AT ${hms(t)} ON ${ymd}, SYSTEM ${s.sys}`);
        if (dayIdx === days - 2 && s.sys === 'SYS2') {
            rec('BAKLOG', 'ARC0682I EXPIRE BACKUP VERSIONS TERMINATED PRIOR TO COMPLETION, EXPIREBV HELD');
        }
        rec('BAKLOG', `ARC0681I EXPIRE BACKUP VERSIONS ENDING AT ${hms(t + Math.round((3600 - dayIdx * 150) * (0.9 + rnd() * 0.2)))} ON ${ymd}, NUMBER OF VERSIONS EXPIRED= ${int(200, 2500)}, LAST BCDS KEY PROCESSED= ZZZ.LAST, PLANNED ENDING KEY WAS= ZZZ.LAST`);

        // --- DMPLOG: autodump 02:00 na co 4. wolumenie ---
        rec('DMPLOG', 'ARC0620I AUTOMATIC DUMP STARTING');
        t = 7200;
        for (let v = 0; v < s.vols; v += 4) {
            const task = `ARCDV${String(v).padStart(3, '0')}`;
            rec('DMPLOG', `ARC0622I FULL VOLUME DUMP STARTING ON VOLUME ${vol(v)}(SMS) AT ${hms(t)} ON ${ymd} SYSTEM ${s.sys}, TASK ID=${task}, TO DUMP CLASS(ES)= ONSITE`);
            const dur = int(120, 900);
            t += dur;
            const result = rnd() < 0.05 ? 'ERRORS OCCURRED' : rnd() < 0.02 ? 'FAILED' : 'SUCCESSFUL';
            rec('DMPLOG', `ARC0623I FULL VOLUME DUMP OF VOLUME ${vol(v)} ENDING AT ${hms(t)}, DCLASS=ONSITE, DGEN=${dayIdx}, DATE=${ymd}, PROCESSING ${result}`);
        }
        rec('DMPLOG', 'ARC0621I AUTOMATIC DUMP ENDING');

        // --- CMDLOG: zadania uzytkownikow, AUDIT w niedziele ---
        for (let k = 0; k < int(5, 25); k++) {
            const op = pick(['MIGRATE', 'RECALL', 'BACKDS', 'RECOVER']);
            if (rnd() < 0.1) rec('CMDLOG', `ARC1001I USER${int(1, 9)}.DATA.F${k} ${op} FAILED, RC=${pick(['0019', '0005', '0037'])} REAS=${p2(int(0, 20))}`);
            else rec('CMDLOG', `ARC1000I USER${int(1, 9)}.DATA.F${k} ${op} PROCESSING ENDED`);
        }
        if (day.getUTCDay() === 0) {
            rec('CMDLOG', 'ARC0801I DFSMSHSM AUDIT STARTING');
            if (rnd() < 0.5) rec('CMDLOG', 'ARC0813I INCOMPLETE AUDIT OF BACKUP CDS, RC=2, REAS=4');
            rec('CMDLOG', 'ARC0802I DFSMSHSM AUDIT ENDING');
        }

        // --- ABRLOG: ABACKUP 22:00 ---
        if (s.sys === 'SYS1') {
            const st = 79200 + int(0, 300);
            rec('ABRLOG', `ARC6054I AGGREGATE BACKUP STARTING FOR AGGREGATE GROUP PAYROLL, AT ${hms(st)}, STARTED TASK = DFHSMABR.ABAR${String(dayIdx).padStart(4, '0')}`);
            rec('ABRLOG', `ARC6055I AGGREGATE BACKUP HAS COMPLETED FOR AGGREGATE GROUP PAYROLL, AT ${hms(st + int(1200, 3000))}, RETCODE = ${dayIdx % 6 === 3 ? '008' : '000'}`);
        }

        for (const [log, lines] of Object.entries(logs)) {
            if (!lines.length) continue;
            fs.writeFileSync(path.join(opt.out, `HSMACT.H${s.host}.${log}.D${yy}${ddd}.T000000.txt`), `${lines.join('\n')}\n`);
            files++;
        }

        // --- QUERY ACTIVE co N minut ---
        const every = Number(opt['query-every']) * 60;
        for (let q = 0; q < 86400; q += every) {
            const held = (x: boolean) => (x ? 'HELD' : 'NOT HELD');
            const act = (x: boolean) => (x ? 'ACTIVE' : 'INACTIVE');
            const inWin = (a: number, b: number) => q >= a && q < b;
            const recycleHeld = cdsFail && q >= 1900; // po ARC0744E funkcje HELD do konca dnia
            const lines = [
                `ARC0101I QUERY ACTIVE COMMAND STARTING ON HOST=${s.host}`,
                `ARC0144I AUDIT=NOT HELD AND ${act(day.getUTCDay() === 0 && inWin(0, 3600))}, LIST=NOT HELD AND INACTIVE, RECYCLE=${held(recycleHeld)} AND INACTIVE, REPORT=NOT HELD AND INACTIVE, DDELETE=NOT HELD AND INACTIVE`,
                `ARC0160I MIGRATION=NOT HELD, RECALL=NOT HELD, VOLUME MIGRATION=${act(inWin(3600, 3600 + s.vols * 450))}`,
                `ARC0163I BACKUP=${held(recycleHeld)}, VOLUME BACKUP=${act(inWin(7200, 7200 + s.vols * 330))}`,
                `ARC0642I DUMP=${held(recycleHeld)}, VOLUME DUMP=${act(inWin(7200, 7200 + (s.vols / 4) * 520))}`,
                `ARC0415I EXPIREBV=NOT HELD AND ${act(inWin(18000, 21600))}, LAST STORED BACKUP VERSION KEY=PROD.K${q}, LAST STORED ABARS VERSION KEY=, LAST PLANNED END KEY= ZZZ.LAST`,
                `ARC1826I FRBACKUP=${held(recycleHeld)} AND ${act(s.sys === 'SYS1' && inWin(10800, 11100))}, FRRECOV=NOT HELD AND INACTIVE, FRBACKUP DUMP=NOT HELD AND INACTIVE`,
                `ARC6018I AGGREGATE BACKUP/RECOVERY = ${s.sys === 'SYS1' && inWin(79200, 82800) ? 'ACTIVE' : 'INACTIVE'}`,
                `ARC0101I QUERY ACTIVE COMMAND COMPLETED ON HOST=${s.host}`,
            ];
            const name = `HSMQRY.H${s.host}.QACTIVE.D${yy}${ddd}.T${hms(q).replace(/:/g, '')}.txt`;
            fs.writeFileSync(path.join(opt.out, name), `${lines.map((l, i) => `${s.sys.padEnd(8)};${String(i + 1).padStart(8, '0')};${l}`).join('\n')}\n`);
            files++;
        }
    }
}
console.log(`Zapisano ${files} plikow do ${opt.out}`);
