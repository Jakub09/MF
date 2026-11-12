/**
 * Dashboardy Grafany dla danych hsm-load - osobny dashboard dla kazdego systemu (sysname).
 *
 *   tsx tools/build-dashboards.ts --systems SYS1,SYS2 [--out ../grafana] [--config config/hsm-map.json]
 *
 * Wynik: <out>/mf-hsm-<SYS>.json (UID mf-hsm-<sys>, tytul "<SYS> - HSM") do importu w Grafanie 12.
 * Teksty na dashboardzie (tytuly, opisy, legendy, zmienne) sa po angielsku.
 * sysname jest ukryta stala w dashboardzie; zrodlo danych (zmienna ds) i host HSM wybiera sie na dashboardzie.
 * Zapytania zaleza od nazw z config/ (measurementy, tagi, pola, zadania z durations.json) - po zmianach
 * w konfiguracji wygeneruj dashboardy ponownie.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

const { values: opt } = parseArgs({
    options: {
        systems: { type: 'string' },
        out: { type: 'string', default: path.join(__dirname, '..', '..', 'grafana') },
        config: { type: 'string', default: path.join(__dirname, '..', 'config', 'hsm-map.json') },
    },
});
const systems = (opt.systems ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (!systems.length || systems.some(s => !/^[A-Z0-9@#$]{1,8}$/.test(s))) {
    console.error('Uzycie: tsx tools/build-dashboards.ts --systems SYS1,SYS2 [--out ../grafana] [--config config/hsm-map.json]');
    process.exit(1);
}
const timezone: string = JSON.parse(fs.readFileSync(opt.config!, 'utf8')).timezone ?? 'UTC';

const DS = { type: 'influxdb', uid: '${ds}' };
const E = '"MF.HSM.EVENT"', Q = '"MF.HSM.QUERY"', D = '"MF.HSM.DURATION"', C = '"MF.HSM.TASK_CHECK"';
const F = `"sysname" = '$sysname' AND "host_id" =~ /^$host_id$/ AND $timeFilter`;
const FD = `"sysname" = '$sysname' AND "host_id" =~ /^$host_id$/`;
const TZ = ` tz('${timezone}')`;
/** Tylko udane przebiegi (trendy czasu nie maja byc zanizane przez przerwane) */
const OKS = `"status" !~ /^(TERMINATED|FAILED|UNSUCCESSFUL|ENDED PRIOR TO COMPLETION)$/`;
const DAILY = `GROUP BY time(1d)`;

function build(sys: string): Obj {
    let id = 0;
    let y = 0;
    const panels: Obj[] = [];
    const t = (refId: string, query: string, extra: Obj = {}) => ({ refId, datasource: DS, query, rawQuery: true, resultFormat: 'time_series', ...extra });
    const row = (title: string) => {
        panels.push({ type: 'row', id: ++id, title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
        y += 1;
    };
    const place = (p: Obj, w: number, h: number, x: number, nextRow = false) => {
        p.gridPos = { h, w, x, y };
        if (nextRow) y += h;
        panels.push(p);
        return p;
    };
    const thr = (steps: [number | null, string][]) => ({ mode: 'absolute', steps: steps.map(([value, color]) => ({ value, color })) });
    const byName = (name: string, properties: Obj[]) => ({ matcher: { id: 'byName', options: name }, properties });
    const byRegex = (re: string, properties: Obj[]) => ({ matcher: { id: 'byRegexp', options: re }, properties });

    const stat = (title: string, desc: string, query: string, unit: string, steps: [number | null, string][]) => ({
        type: 'stat', id: ++id, title, description: desc, datasource: DS, targets: [t('A', query)],
        fieldConfig: { defaults: { unit, color: { mode: 'thresholds' }, thresholds: thr(steps), noValue: '0' }, overrides: [] },
        options: { reduceOptions: { calcs: ['sum'], fields: '', values: false }, colorMode: 'background', graphMode: 'none', textMode: 'value', justifyMode: 'center' },
    });
    const ts = (title: string, desc: string, targets: Obj[], o: Obj = {}) => ({
        type: 'timeseries', id: ++id, title, description: desc, datasource: DS, targets, interval: o.interval,
        fieldConfig: {
            defaults: {
                unit: o.unit, min: o.min ?? (o.bars ? 0 : undefined), max: o.max, decimals: o.decimals,
                color: { mode: 'palette-classic' }, thresholds: thr(o.steps ?? [[null, 'green']]),
                custom: {
                    drawStyle: o.bars ? 'bars' : 'line', fillOpacity: o.fill ?? (o.bars ? 80 : 10), lineWidth: 1, pointSize: 5,
                    showPoints: o.bars ? 'never' : 'auto', spanNulls: o.spanNulls ?? false, stacking: { mode: o.stack ? 'normal' : 'none', group: 'A' },
                    thresholdsStyle: { mode: o.thresholdLines ? 'dashed' : 'off' }, barAlignment: 0, axisLabel: o.axisLabel,
                },
            },
            overrides: o.overrides ?? [],
        },
        options: { legend: o.legend ?? { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } },
    });
    const table = (title: string, desc: string, targets: Obj[], o: Obj = {}) => ({
        type: 'table', id: ++id, title, description: desc, datasource: DS, targets,
        transformations: o.transformations ?? [],
        fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides: o.overrides ?? [] },
        options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
    });
    const colorCell = (name: string, extra: Obj[]) => byName(name, [{ id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } }, ...extra]);
    const hideCols = (...names: string[]) => ({ id: 'organize', options: { excludeByName: Object.fromEntries(names.map(n => [n, true])), renameByName: {} } });
    const rcCell = (name: string) => colorCell(name, [{ id: 'thresholds', value: thr([[null, 'green'], [4, 'orange'], [8, 'red']]) }]);
    /** Seria na prawej osi (licznik obok czasu trwania) */
    const rightAxis = (re: string, label: string, unit = 'short') => byRegex(re, [
        { id: 'custom.axisPlacement', value: 'right' }, { id: 'unit', value: unit }, { id: 'custom.axisLabel', value: label },
        { id: 'custom.drawStyle', value: 'bars' }, { id: 'custom.fillOpacity', value: 25 }, { id: 'custom.lineWidth', value: 0 }, { id: 'min', value: 0 },
    ]);
    const stateTl = (title: string, desc: string, targets: Obj[], onText: string, onColor: string, offText: string) => ({
        type: 'state-timeline', id: ++id, title, description: desc, datasource: DS, targets, interval: '15m',
        fieldConfig: {
            defaults: {
                color: { mode: 'thresholds' }, thresholds: thr([[null, 'green']]), custom: { fillOpacity: 80, lineWidth: 0 },
                mappings: [{ type: 'value', options: { true: { text: onText, color: onColor, index: 0 }, false: { text: offText, color: 'transparent', index: 1 } } }],
            },
            overrides: [],
        },
        options: { showValue: 'never', mergeValues: true, alignValue: 'left', rowHeight: 0.8, legend: { showLegend: false, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'single' } },
    });

    // --- Przeglad (teksty na dashboardzie po angielsku) ---
    row('Overview');
    place(stat('Events', 'All ARC* messages stored in InfluxDB (field events)', `SELECT sum("events") FROM ${E} WHERE ${F}`, 'short', [[null, 'blue']]), 4, 4, 0);
    place(stat('Errors (ARCnnnnE)', 'Messages with severity E (last character of the message ID)', `SELECT sum("events") FROM ${E} WHERE "msg_id" =~ /E$/ AND ${F}`, 'short', [[null, 'green'], [1, 'red']]), 4, 4, 4);
    place(stat('Interrupted functions', 'ARC0570I, ARC0682I, ARC0625I, ARC1818I, ARC1837I and PSM / SSM "ENDED PRIOR TO COMPLETION"',
        `SELECT sum("events") FROM ${E} WHERE ("msg_id" =~ /^ARC(0570|0682|0625|1818|1837)I$/ OR "status" = 'ENDED PRIOR TO COMPLETION') AND ${F}`, 'short', [[null, 'green'], [1, 'orange']]), 4, 4, 8);
    place(stat('Critical (HSM functions HELD)', 'ARC0744E (CDS backup failed - functions HELD), ARC0026E (journaling disabled), ARC1819I (FlashCopy relationship left on devices)',
        `SELECT sum("events") FROM ${E} WHERE "msg_id" =~ /^ARC(0744E|0026E|1819I)$/ AND ${F}`, 'short', [[null, 'green'], [1, 'red']]), 4, 4, 12);
    place(stat('Data sets backed up', 'Sum of DATA SETS BACKED UP from ARC0723I', `SELECT sum("ds_backed_up") FROM ${E} WHERE "msg_id" = 'ARC0723I' AND ${F}`, 'short', [[null, 'blue']]), 4, 4, 16);
    place(stat('Space freed (space management)', 'TRACK(S) FREED from ARC0523I converted to bytes (56,664 bytes per 3390 track)', `SELECT sum("freed_bytes") FROM ${E} WHERE "msg_id" = 'ARC0523I' AND ${F}`, 'decbytes', [[null, 'blue']]), 4, 4, 20, true);

    // --- Kontrola zakonczenia zadan (expectedEnd) ---
    row('Task completion check');
    place(stat('ERROR - no end in 2nd extract', 'expectedEnd check: task still without an end message in the next extract (MF.HSM.TASK_CHECK level=ERROR) in the selected time range',
        `SELECT count("level_num") FROM ${C} WHERE "level" = 'ERROR' AND ${F}`, 'short', [[null, 'green'], [1, 'red']]), 4, 7, 0);
    place(stat('WARNING - no end in extract', 'First extract after the expectedEnd deadline without an end message (level=WARNING) in the selected time range',
        `SELECT count("level_num") FROM ${C} WHERE "level" = 'WARNING' AND ${F}`, 'short', [[null, 'green'], [1, 'orange']]), 4, 7, 4);
    const levelCell = colorCell('level', [{ id: 'mappings', value: [{ type: 'value', options: { OK: { color: 'green', index: 0 }, WARNING: { color: 'orange', index: 1 }, ERROR: { color: 'red', index: 2 } } }] }]);
    const stateCell = byName('state', [{ id: 'mappings', value: [{ type: 'value', options: {
        RUNNING: { text: 'running', index: 0 }, NOT_STARTED: { text: 'not started', index: 1 },
        COMPLETED: { text: 'completed', index: 2 }, COMPLETED_LATE: { text: 'completed late', index: 3 } } }] }]);
    const secCell = (n: string, label: string) => byName(n, [{ id: 'unit', value: 's' }, { id: 'displayName', value: label }]);
    place(table('Task completion check - latest', 'Result of the expectedEnd check for every extract: deadline, state, level. "end vs deadline" = end time relative to the deadline (negative = before), "running for" = how long the task had been running at extract time.',
        [t('A', `SELECT "task", "host_id", "deadline", "state", "level", "late_s", "running_s" FROM ${C} WHERE ${F} ORDER BY time DESC LIMIT 100`, { resultFormat: 'table' })],
        { overrides: [levelCell, stateCell, secCell('late_s', 'end vs deadline'), secCell('running_s', 'running for'), byName('Time', [{ id: 'displayName', value: 'extract' }])] }), 16, 7, 8, true);

    // --- Aktywnosc ---
    row('Activity');
    place(ts('Events by message', 'Number of messages per time interval', [t('A', `SELECT sum("events") FROM ${E} WHERE ${F} GROUP BY time($__interval), "msg_id" fill(none)`, { alias: '$tag_msg_id' })],
        { bars: true, stack: true, interval: '1h', legend: { displayMode: 'table', placement: 'right', showLegend: true, calcs: ['sum'], sortBy: 'Total', sortDesc: true } }), 24, 9, 0, true);

    // --- Czas trwania zadan ---
    row('Task duration');
    const pctCell = byName('change', [{ id: 'unit', value: 'percentunit' }, { id: 'decimals', value: 1 },
        { id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } }, { id: 'thresholds', value: thr([[null, 'green'], [0.1, 'orange'], [0.25, 'red']]) }]);
    place(table('Average duration: last 7 days vs previous 7', 'Average duration of successful runs of whole tasks. Fixed windows counted from now - independent of the dashboard time range. Red = 25% longer or more, green = shorter.', [
        t('A', `SELECT mean("duration") AS "last 7 d" FROM ${D} WHERE ${OKS} AND ${FD} AND time > now() - 7d GROUP BY "task"`, { resultFormat: 'table' }),
        t('B', `SELECT mean("duration") AS "previous 7 d" FROM ${D} WHERE ${OKS} AND ${FD} AND time > now() - 14d AND time <= now() - 7d GROUP BY "task"`, { resultFormat: 'table' }),
    ], {
        transformations: [hideCols('Time'), { id: 'merge', options: {} },
            { id: 'calculateField', options: { mode: 'binary', binary: { left: 'last 7 d', operator: '-', right: 'previous 7 d' }, alias: 'diff', replaceFields: false } },
            { id: 'calculateField', options: { mode: 'binary', binary: { left: 'diff', operator: '/', right: 'previous 7 d' }, alias: 'change', replaceFields: false } },
            hideCols('diff'), { id: 'sortBy', options: { sort: [{ field: 'change', desc: true }] } }],
        overrides: [pctCell, ...['last 7 d', 'previous 7 d'].map(n => byName(n, [{ id: 'unit', value: 's' }, { id: 'decimals', value: 0 }]))],
    }), 10, 10, 0);
    place(ts('Task duration (daily)', 'Maximum duration per day, all runs. PSM, AUTOBACKUP, AUTODUMP - start / end messages have no time: measured from the first to the last volume message (exact=false).',
        [t('A', `SELECT max("duration") FROM ${D} WHERE ${F} ${DAILY}, "task", "host_id" fill(none)${TZ}`, { alias: '$tag_task ($tag_host_id)' })],
        { unit: 's', fill: 0, spanNulls: true, legend: { displayMode: 'table', placement: 'right', showLegend: true, calcs: ['min', 'max', 'lastNotNull'] } }), 14, 10, 10, true);

    /** Panel zadania: czas trwania (lewa os) + licznik (prawa os, slupki) */
    const taskPanel = (task: string, title: string, desc: string, counters: [string, string][], counterLabel: string, counterUnit = 'short') => ts(title, desc, [
        t('A', `SELECT max("duration") AS "duration" FROM ${D} WHERE "task" = '${task}' AND ${OKS} AND ${F} ${DAILY}, "host_id" fill(none)${TZ}`, { alias: 'duration ($tag_host_id)' }),
        ...counters.map(([field, label], i) => t(String.fromCharCode(66 + i),
            `SELECT sum("${field}") FROM ${D} WHERE "task" = '${task}' AND ${F} ${DAILY}, "host_id" fill(none)${TZ}`, { alias: `${label} ($tag_host_id)` })),
    ], { unit: 's', min: 0, fill: 0, spanNulls: true, axisLabel: 'duration', overrides: [rightAxis(`^(${counters.map(c => c[1]).join('|')}) .*`, counterLabel, counterUnit)] });
    place(taskPanel('PSM', 'PSM - duration and volumes', 'Primary Space Management: duration (left axis) and processed volumes (right axis). Approximate - from the first to the last ARC0522I.',
        [['volumes', 'volumes']], 'volumes'), 12, 8, 0);
    place(taskPanel('AUTOBACKUP', 'Automatic backup - duration and volumes', 'Duration (left axis) and backed up volumes (right axis).',
        [['volumes', 'volumes']], 'volumes'), 12, 8, 12, true);
    place(taskPanel('AUTODUMP', 'Automatic dump - duration and volumes', 'Duration (left axis) and dumped volumes (right axis).',
        [['volumes', 'volumes']], 'volumes'), 12, 8, 0);
    place(taskPanel('CDSBACKUP', 'CDS backup - duration', 'Backup of MCDS, BCDS, OCDS and journal: duration (left axis) and number of CDS data sets backed up (right axis).',
        [['datasets', 'CDS data sets']], 'data sets'), 12, 8, 12, true);
    place(taskPanel('EXPIREBV', 'EXPIREBV - duration and expired versions', 'Duration (left axis) and number of expired backup versions (right axis).',
        [['versions', 'versions']], 'versions'), 12, 8, 0);
    place(ts('Fast Replication - duration per copy pool', 'FRBACKUP: ARC1801I -> ARC1802I (logical completion, without background copy), successful runs',
        [t('A', `SELECT max("duration") FROM ${D} WHERE "task" = 'FRBACKUP' AND ${OKS} AND ${F} ${DAILY}, "copy_pool", "fr_function" fill(none)${TZ}`, { alias: '$tag_copy_pool $tag_fr_function' })],
        { unit: 's', min: 0, fill: 0, spanNulls: true }), 12, 8, 12, true);

    // --- Wolumeny i zbiory ---
    row('Volumes and data sets');
    place(ts('Volumes processed per task (daily)', 'Field volumes in MF.HSM.DURATION: PSM (ARC0523I), AUTOBACKUP (ARC0723I), AUTODUMP (ARC0623I), FRBACKUP (ARC1805I)',
        [t('A', `SELECT sum("volumes") FROM ${D} WHERE ${F} ${DAILY}, "task" fill(none)${TZ}`, { alias: '$tag_task' })], { min: 0, fill: 0, spanNulls: true }), 8, 8, 0);
    place(ts('Failed volumes per task (daily)', 'Field volumes_failed: ARC0570I, ARC0623I ERRORS OCCURRED / FAILED, ARC1803E, ARC1818I',
        [t('A', `SELECT sum("volumes_failed") FROM ${D} WHERE ${F} ${DAILY}, "task" fill(0)${TZ}`, { alias: '$tag_task' })],
        { bars: true, stack: true }), 8, 8, 8);
    place(ts('Data sets processed per task (daily)', 'Field datasets: PSM - migrated / deleted (ARC0523I), AUTOBACKUP - backed up (ARC0723I)',
        [t('A', `SELECT sum("datasets") FROM ${D} WHERE "task" =~ /^(PSM|AUTOBACKUP)$/ AND ${F} ${DAILY}, "task" fill(none)${TZ}`, { alias: '$tag_task' })], { min: 0, fill: 0, spanNulls: true }), 8, 8, 16, true);

    // --- Backup ---
    row('Backup');
    place(ts('Volume backup - data sets per day', 'ARC0723I: sum of DATA SETS BACKED UP per day', [t('A', `SELECT sum("ds_backed_up") FROM ${E} WHERE "msg_id" = 'ARC0723I' AND ${F} ${DAILY}, "host_id" fill(0)${TZ}`, { alias: '$tag_host_id' })], { bars: true, stack: true }), 12, 8, 0);
    place(table('CDS backup - latest runs', 'ARC0741I: result of the whole CDS backup', [t('A', `SELECT "status", "kind", "host_id", "events" FROM ${E} WHERE "msg_id" = 'ARC0741I' AND ${F} ORDER BY time DESC LIMIT 30`, { resultFormat: 'table' })],
        { transformations: [hideCols('events')], overrides: [colorCell('status', [{ id: 'mappings', value: [{ type: 'value', options: { SUCCESSFUL: { color: 'green', index: 0 }, UNSUCCESSFUL: { color: 'red', index: 1 }, TESTMODE: { color: 'blue', index: 2 }, SHUTDOWN: { color: 'orange', index: 3 } } }] }])] }), 12, 8, 12, true);
    place(ts('CDS / journal utilization [%]', 'ARC0909E (SETSYS MONITOR threshold); lines at 80% and 90%', [t('A', `SELECT max("percent") FROM ${E} WHERE "msg_id" = 'ARC0909E' AND ${F} GROUP BY time($__interval), "dsid" fill(none)`, { alias: '$tag_dsid' })],
        { unit: 'percent', min: 0, max: 100, steps: [[null, 'green'], [80, 'orange'], [90, 'red']], thresholdLines: true, interval: '1h', spanNulls: true }), 12, 8, 0);
    place(ts('EXPIREBV - expired versions per day', 'ARC0681I: NUMBER OF VERSIONS EXPIRED', [t('A', `SELECT sum("versions_expired") FROM ${E} WHERE "msg_id" = 'ARC0681I' AND ${F} ${DAILY}, "host_id" fill(0)${TZ}`, { alias: '$tag_host_id' })], { bars: true }), 12, 8, 12, true);

    // --- Space management ---
    row('Space management');
    place(ts('Space freed per day', 'ARC0523I: TRACK(S) FREED converted to bytes (56,664 bytes per 3390 track)', [t('A', `SELECT sum("freed_bytes") FROM ${E} WHERE "msg_id" = 'ARC0523I' AND ${F} ${DAILY}, "host_id" fill(0)${TZ}`, { alias: '$tag_host_id' })],
        { bars: true, unit: 'decbytes' }), 12, 8, 0);
    place(ts('Data sets migrated / deleted per day', 'ARC0523I: DATA SET(S) MIGRATED/DELETED', [t('A', `SELECT sum("ds_count") FROM ${E} WHERE "msg_id" = 'ARC0523I' AND ${F} ${DAILY}, "host_id" fill(0)${TZ}`, { alias: '$tag_host_id' })], { bars: true }), 12, 8, 12, true);

    // --- Dump i FR ---
    row('Dump and Fast Replication');
    const dump = ts('Volume dumps by result per day', 'ARC0623I: PROCESSING SUCCESSFUL / ERRORS OCCURRED / FAILED', [t('A', `SELECT sum("events") FROM ${E} WHERE "msg_id" = 'ARC0623I' AND ${F} ${DAILY}, "result" fill(0)${TZ}`, { alias: '$tag_result' })],
        { bars: true, stack: true, overrides: [['SUCCESSFUL', 'green'], ['ERRORS OCCURRED', 'orange'], ['FAILED', 'red']].map(([n, c]) => byName(n, [{ id: 'color', value: { mode: 'fixed', fixedColor: c } }])) });
    place(dump, 12, 8, 0);
    place(table('Fast Replication - latest', 'ARC1802I: FUNCTION RC and MAXIMUM VOLUME RC per copy pool', [t('A', `SELECT "copy_pool", "fr_function", "host_id", "function_rc", "max_volume_rc", "partialok" FROM ${E} WHERE "msg_id" = 'ARC1802I' AND ${F} ORDER BY time DESC LIMIT 30`, { resultFormat: 'table' })],
        { overrides: [rcCell('function_rc'), rcCell('max_volume_rc')] }), 12, 8, 12, true);

    // --- Bledy ---
    row('Errors and interruptions');
    place(table('Latest errors, interruptions and RC > 0', 'Messages ...E, interrupted functions and all events with rc > 0 (e.g. ARC1001I)', [t('A',
        `SELECT "msg_id", "host_id", "function", "operation", "volser", "dsid", "copy_pool", "rc", "reason" FROM ${E} WHERE ("msg_id" =~ /E$/ OR "rc" > 0 OR "msg_id" =~ /^ARC(0570|0682|0625|1818|1837)I$/) AND ${F} ORDER BY time DESC LIMIT 200`, { resultFormat: 'table' })],
    { overrides: [rcCell('rc'), colorCell('msg_id', [{ id: 'mappings', value: [{ type: 'regex', options: { pattern: '.*E$', result: { color: 'red', index: 0 } } }] }, { id: 'color', value: { mode: 'fixed', fixedColor: 'transparent' } }])] }), 24, 9, 0, true);

    // --- Stan HSM ---
    row('HSM status (QUERY ACTIVE)');
    const q = (refId: string, field: string, msg: string, label: string) =>
        t(refId, `SELECT last("${field}") FROM ${Q} WHERE "msg_id" = '${msg}' AND ${F} GROUP BY time($__interval), "host_id" fill(previous)`, { alias: `${label} ($tag_host_id)` });
    place(stateTl('Functions held', 'QUERY ACTIVE snapshots: red = HELD', [
        q('A', 'recycle_held', 'ARC0144I', 'RECYCLE'), q('B', 'audit_held', 'ARC0144I', 'AUDIT'),
        q('C', 'expirebv_held', 'ARC0415I', 'EXPIREBV'), q('D', 'frbackup_held', 'ARC1826I', 'FRBACKUP')], 'HELD', 'red', 'OK'), 12, 7, 0);
    place(stateTl('Functions active', 'QUERY ACTIVE snapshots: blue = ACTIVE', [
        q('A', 'volume_migration_active', 'ARC0160I', 'MIGRATION'), q('B', 'volume_backup_active', 'ARC0163I', 'BACKUP'),
        q('C', 'volume_dump_active', 'ARC0642I', 'DUMP'), q('D', 'expirebv_active', 'ARC0415I', 'EXPIREBV'),
        q('E', 'frbackup_active', 'ARC1826I', 'FRBACKUP')], 'ACTIVE', 'blue', '-'), 12, 7, 12, true);

    return {
        uid: `mf-hsm-${sys.toLowerCase()}`,
        title: `${sys} - HSM`,
        description: `DFSMShsm on ${sys}: data from HSM_monitoring/loader (MF.HSM.EVENT, MF.HSM.QUERY, MF.HSM.DURATION, MF.HSM.TASK_CHECK). Generated by loader/tools/build-dashboards.ts.`,
        tags: ['mf', 'hsm', 'mainframe', sys.toLowerCase()],
        timezone: 'browser',
        editable: true,
        graphTooltip: 1,
        refresh: '',
        time: { from: 'now-14d', to: 'now' },
        schemaVersion: 41,
        version: 1,
        annotations: {
            list: [
                { builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' },
                {
                    name: 'Critical events', datasource: DS, enable: true, iconColor: 'red',
                    target: { refId: 'Anno', query: `SELECT "msg_id", "host_id", "events" FROM ${E} WHERE "msg_id" =~ /^ARC(0744E|0026E|1819I|0001I|0002I)$/ AND "sysname" = '$sysname' AND $timeFilter`, rawQuery: true, resultFormat: 'table' },
                    textColumn: 'msg_id', tagsColumn: 'host_id',
                },
            ],
        },
        templating: {
            list: [
                { type: 'datasource', name: 'ds', label: 'Data source', query: 'influxdb', current: {}, hide: 0, options: [], refresh: 1, regex: '' },
                { type: 'constant', name: 'sysname', label: 'System', query: sys, hide: 2, current: { text: sys, value: sys }, options: [{ text: sys, value: sys, selected: true }] },
                {
                    type: 'query', name: 'host_id', label: 'HSM host', datasource: DS, refresh: 1, sort: 1, multi: true, includeAll: true, hide: 0,
                    query: `SHOW TAG VALUES FROM ${E} WITH KEY = "host_id" WHERE "sysname" = '$sysname'`,
                    definition: `SHOW TAG VALUES FROM ${E} WITH KEY = "host_id" WHERE "sysname" = '$sysname'`,
                    current: { text: ['All'], value: ['$__all'] }, options: [],
                },
            ],
        },
        panels,
    };
}

fs.mkdirSync(opt.out!, { recursive: true });
for (const sys of systems) {
    const file = path.join(opt.out!, `mf-hsm-${sys}.json`);
    const dash = build(sys);
    fs.writeFileSync(file, `${JSON.stringify(dash, null, 2)}\n`);
    console.log(`${file}: ${dash.panels.filter((p: Obj) => p.type !== 'row').length} paneli, UID ${dash.uid}`);
}
