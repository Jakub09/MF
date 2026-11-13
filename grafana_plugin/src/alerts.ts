/**
 * Reguły alertów dla dysków = reguły Grafana Alerting (ruler API, jak w UI Grafany - edytowalne też tam).
 * Folder i grupa z opcji panelu; każda reguła to zapytanie InfluxQL last(pole) per dysk
 * (GROUP BY devnum, sysid, vol, storgrp -> instancja alertu na dysk w systemie) + próg.
 * Ustawienia formularza panelu są w adnotacji dasd_rule (JSON), żeby dało się je edytować z powrotem.
 */
import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { parseDevnums } from './naming';

export type Severity = 'critical' | 'warning';
export type Op = 'gt' | 'lt';

export interface MetricDef {
  label: string;
  /** Pole w dasd_volume (last(field)) */
  field: string;
  /** Wyrażenie wartości w zapytaniu (domyślnie last(field)) */
  select?: string;
  unit: string;
  defaultOp: Op;
  defaultValue: number;
  /** Warunek "jest / nie ma" (próg 0) - bez pola wartości w formularzu */
  flag?: boolean;
}

export const METRICS: Record<string, MetricDef> = {
  pct_used: { label: 'Zajętość', field: 'pct_used', unit: '%', defaultOp: 'gt', defaultValue: 90 },
  pct_used_trk: { label: 'Zajętość EAV - TMS', field: 'pct_used_trk', unit: '%', defaultOp: 'gt', defaultValue: 90 },
  pct_used_cyl: { label: 'Zajętość EAV - CMS', field: 'pct_used_cyl', unit: '%', defaultOp: 'gt', defaultValue: 90 },
  free_gb: {
    label: 'Wolne miejsce',
    field: 'free_kb',
    select: 'last("free_kb") / 1048576',
    unit: 'GiB',
    defaultOp: 'lt',
    defaultValue: 5,
  },
  largest_free_gb: {
    label: 'Największy wolny extent',
    field: 'largest_free_ext_kb',
    select: 'last("largest_free_ext_kb") / 1048576',
    unit: 'GiB',
    defaultOp: 'lt',
    defaultValue: 1,
  },
  frag_index: { label: 'Fragmentacja', field: 'frag_index', unit: '', defaultOp: 'gt', defaultValue: 800 },
  free_dscbs: { label: 'Wolne DSCB (VTOC)', field: 'free_dscbs', unit: '', defaultOp: 'lt', defaultValue: 100 },
  mvs_offline: { label: 'Offline (MVS)', field: 'mvs_offline', unit: 'syst.', defaultOp: 'gt', defaultValue: 0, flag: true },
  sms_disabled: { label: 'SMS DISABLE', field: 'sms_disabled', unit: 'syst.', defaultOp: 'gt', defaultValue: 0, flag: true },
  sms_quiesced: { label: 'SMS QUIESCE', field: 'sms_quiesced', unit: 'syst.', defaultOp: 'gt', defaultValue: 0, flag: true },
  conflict: {
    label: 'Konflikt między systemami',
    field: 'conflict_level',
    unit: '',
    defaultOp: 'gt',
    defaultValue: 1,
    flag: true,
  },
};

/** Ustawienia reguły z formularza panelu */
export interface DasdRuleSpec {
  uid?: string;
  title: string;
  metric: keyof typeof METRICS | string;
  op: Op;
  value: number;
  storgrps: string[];
  systems: string[];
  /** "9100-910F, 8080" */
  devnums: string;
  /** Lista VOLSER, * = dowolne znaki (PR0*) */
  volsers: string[];
  severity: Severity;
  /** Punkt kontaktowy; puste = polityka powiadomień Grafany */
  receiver: string;
  description: string;
  paused: boolean;
}

export interface AlertSettings {
  folderUid: string;
  folderTitle: string;
  group: string;
  /** Co ile Grafana sprawdza regułę, np. "15m" */
  interval: string;
  /** Ile godzin wstecz szukać ostatniego wsadu */
  windowHours: number;
  datasourceUid: string;
}

/** Aktywny (firing) alert dysku */
export interface ActiveAlert {
  ruleUid: string;
  title: string;
  severity: Severity;
  devnum: string;
  sysid: string;
  vol: string;
  summary: string;
}

export interface RuleState {
  spec: DasdRuleSpec;
  firing: number;
  health: string;
  lastError?: string;
}

const SOURCE_LABEL = 'dasd-map';
/** Measurement z mf-load dcollect (repo mf-loader) */
const MEASUREMENT = 'dasd_volume';

// --------------------------------------------------------------------------- zapytanie InfluxQL

const reEscape = (s: string) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&');
const alternation = (xs: string[]) => `/^(${xs.join('|')})$/`;

/** DEVNUM-y jako zwarty regex: całe wiersze (16 adresów) jako "910." */
function devnumRegex(text: string): string | undefined {
  const { devnums } = parseDevnums(text, 65536);
  if (!devnums.length) {
    return undefined;
  }
  const rows = new Map<number, number[]>();
  devnums.forEach((d) => rows.set(d >> 4, [...(rows.get(d >> 4) ?? []), d & 0xf]));
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  const parts = [...rows.entries()].map(([row, cols]) => {
    const r = hex(row, devnums[0] > 0xffff ? 4 : 3);
    return cols.length === 16 ? `${r}[0-9A-F]` : cols.length === 1 ? `${r}${hex(cols[0], 1)}` : `${r}[${cols.map((c) => hex(c, 1)).join('')}]`;
  });
  return alternation(parts);
}

export function buildQuery(spec: DasdRuleSpec): string {
  const m = METRICS[spec.metric];
  const where = ['$timeFilter'];
  if (spec.storgrps.length) {
    where.push(`"storgrp" =~ ${alternation(spec.storgrps.map(reEscape))}`);
  }
  if (spec.systems.length) {
    where.push(`"sysid" =~ ${alternation(spec.systems.map(reEscape))}`);
  }
  const dev = devnumRegex(spec.devnums);
  if (dev) {
    where.push(`"devnum" =~ ${dev}`);
  }
  if (spec.volsers.length) {
    where.push(`"vol" =~ ${alternation(spec.volsers.map((v) => reEscape(v.toUpperCase()).replace(/\*/g, '.*')))}`);
  }
  const select = m.select ?? `last("${m.field}")`;
  return `SELECT ${select} AS "value" FROM "${MEASUREMENT}" WHERE ${where.join(' AND ')} GROUP BY "devnum", "sysid", "vol", "storgrp"`;
}

export function describe(spec: DasdRuleSpec): string {
  const m = METRICS[spec.metric];
  if (!m) {
    return spec.metric;
  }
  if (m.flag) {
    return spec.metric === 'conflict' ? (spec.value >= 1 ? 'konflikt (błąd)' : 'konflikt (dowolny)') : m.label;
  }
  return `${m.label} ${spec.op === 'gt' ? '>' : '<'} ${spec.value}${m.unit ? ' ' + m.unit : ''}`;
}

export function scopeText(spec: DasdRuleSpec): string {
  const parts = [
    spec.storgrps.length ? `SG ${spec.storgrps.join(', ')}` : '',
    spec.systems.length ? `systemy ${spec.systems.join(', ')}` : '',
    spec.devnums.trim() ? `adresy ${spec.devnums.trim()}` : '',
    spec.volsers.length ? `VOLSER ${spec.volsers.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'wszystkie dyski';
}

// --------------------------------------------------------------------------- reguła Grafany <-> formularz

const expr = { type: '__expr__', uid: '__expr__', name: 'Expression' };

function toGrafanaRule(spec: DasdRuleSpec, s: AlertSettings) {
  const m = METRICS[spec.metric];
  // flagi: konflikt "błąd" = level > 1, "dowolny" = level > 0; pozostałe: > 0 systemów
  const threshold = m.flag ? (spec.metric === 'conflict' ? (spec.value >= 1 ? 1 : 0) : 0) : spec.value;
  const op = m.flag ? 'gt' : spec.op;
  const unit = m.unit && !m.flag ? ` ${m.unit}` : '';
  return {
    for: '0s',
    labels: { source: SOURCE_LABEL, severity: spec.severity, metric: String(spec.metric) },
    annotations: {
      summary: m.flag
        ? `{{ $labels.vol }} ({{ $labels.devnum }}, {{ $labels.sysid }}, {{ $labels.storgrp }}): ${describe(spec)}`
        : `{{ $labels.vol }} ({{ $labels.devnum }}, {{ $labels.sysid }}, {{ $labels.storgrp }}): ${m.label} {{ humanize $values.B.Value }}${unit} (próg ${op === 'gt' ? '>' : '<'} ${threshold}${unit})`,
      description: spec.description,
      dasd_rule: JSON.stringify({ ...spec, uid: undefined }),
    },
    grafana_alert: {
      ...(spec.uid ? { uid: spec.uid } : {}),
      title: spec.title,
      condition: 'C',
      // brak danych = brak dysków w zakresie, nie awaria
      no_data_state: 'OK',
      exec_err_state: 'Error',
      is_paused: spec.paused,
      ...(spec.receiver ? { notification_settings: { receiver: spec.receiver } } : {}),
      data: [
        {
          refId: 'A',
          queryType: '',
          relativeTimeRange: { from: Math.round(s.windowHours * 3600), to: 0 },
          datasourceUid: s.datasourceUid,
          model: { refId: 'A', rawQuery: true, resultFormat: 'time_series', query: buildQuery(spec) },
        },
        {
          refId: 'B',
          queryType: '',
          relativeTimeRange: { from: 0, to: 0 },
          datasourceUid: '__expr__',
          model: { refId: 'B', datasource: expr, type: 'reduce', expression: 'A', reducer: 'last', settings: { mode: 'dropNN' } },
        },
        {
          refId: 'C',
          queryType: '',
          relativeTimeRange: { from: 0, to: 0 },
          datasourceUid: '__expr__',
          model: {
            refId: 'C',
            datasource: expr,
            type: 'threshold',
            expression: 'B',
            conditions: [{ evaluator: { type: op, params: [threshold] } }],
          },
        },
      ],
    },
  };
}

type GrafanaRule = ReturnType<typeof toGrafanaRule> & { grafana_alert: { uid?: string } };

function fromGrafanaRule(r: GrafanaRule): DasdRuleSpec | undefined {
  try {
    const spec = JSON.parse(r.annotations?.dasd_rule ?? '') as DasdRuleSpec;
    return {
      ...spec,
      uid: r.grafana_alert.uid,
      // tytuł / pauza / kontakt mogły zostać zmienione w UI Grafany
      title: r.grafana_alert.title,
      paused: !!r.grafana_alert.is_paused,
      receiver: (r.grafana_alert as { notification_settings?: { receiver?: string } }).notification_settings?.receiver ?? '',
    };
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------------- API Grafany

const api = <T>(method: string, url: string, data?: unknown) =>
  lastValueFrom(getBackendSrv().fetch<T>({ method, url, data, showErrorAlert: false, showSuccessAlert: false })).then(
    (r) => r.data
  );

async function folderExists(s: AlertSettings): Promise<boolean> {
  try {
    await api('GET', `/api/folders/${encodeURIComponent(s.folderUid)}`);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      return false;
    }
    throw e;
  }
}

async function ensureFolder(s: AlertSettings): Promise<void> {
  if (!(await folderExists(s))) {
    await api('POST', '/api/folders', { uid: s.folderUid, title: s.folderTitle });
  }
}

const groupUrl = (s: AlertSettings) =>
  `/api/ruler/grafana/api/v1/rules/${encodeURIComponent(s.folderUid)}/${encodeURIComponent(s.group)}?subtype=cortex`;

async function loadGroup(s: AlertSettings): Promise<{ interval: string; rules: GrafanaRule[] }> {
  try {
    const g = await api<{ interval: string; rules: GrafanaRule[] }>('GET', groupUrl(s));
    return { interval: g.interval || s.interval, rules: g.rules ?? [] };
  } catch (e) {
    const status = (e as { status?: number }).status;
    // brak grupy = 404, ale brak folderu ruler zgłasza jako 403 - wtedy po prostu nie ma jeszcze reguł
    if (status === 404 || (status === 403 && !(await folderExists(s)))) {
      return { interval: s.interval, rules: [] };
    }
    throw e;
  }
}

/** Grupa zapisywana w całości (ruler API) - pozostałe reguły grupy bez zmian */
async function saveGroup(s: AlertSettings, rules: unknown[]): Promise<void> {
  if (!rules.length) {
    await api('DELETE', groupUrl(s).replace('?subtype=cortex', ''));
    return;
  }
  await api('POST', `/api/ruler/grafana/api/v1/rules/${encodeURIComponent(s.folderUid)}?subtype=cortex`, {
    name: s.group,
    interval: s.interval,
    rules,
  });
}

export async function listRules(s: AlertSettings): Promise<DasdRuleSpec[]> {
  const { rules } = await loadGroup(s);
  return rules.map(fromGrafanaRule).filter((x): x is DasdRuleSpec => !!x);
}

export async function saveRule(s: AlertSettings, spec: DasdRuleSpec): Promise<void> {
  await ensureFolder(s);
  const { rules } = await loadGroup(s);
  const next = toGrafanaRule(spec, s);
  const idx = spec.uid ? rules.findIndex((r) => r.grafana_alert.uid === spec.uid) : -1;
  await saveGroup(s, idx >= 0 ? rules.map((r, i) => (i === idx ? next : r)) : [...rules, next]);
}

export async function deleteRule(s: AlertSettings, uid: string): Promise<void> {
  const { rules } = await loadGroup(s);
  await saveGroup(
    s,
    rules.filter((r) => r.grafana_alert.uid !== uid)
  );
}

export async function listReceivers(): Promise<string[]> {
  try {
    const r = await api<Array<{ name: string }>>('GET', '/api/alertmanager/grafana/config/api/v1/receivers');
    return r.map((x) => x.name).sort();
  } catch {
    return [];
  }
}

interface PromRule {
  name: string;
  uid?: string;
  state: string;
  health: string;
  lastError?: string;
  /** "0001-01-01T00:00:00Z" = jeszcze nie sprawdzana */
  lastEvaluation?: string;
  labels?: Record<string, string>;
  alerts?: Array<{ state: string; labels: Record<string, string>; annotations: Record<string, string> }>;
}

/** Stan reguł grupy i aktywne alerty dysków */
export async function ruleStates(s: AlertSettings): Promise<{ rules: Map<string, PromRule>; active: ActiveAlert[] }> {
  const res = await api<{ data: { groups: Array<{ name: string; folderUid?: string; rules: PromRule[] }> } }>(
    'GET',
    `/api/prometheus/grafana/api/v1/rules?folder_uid=${encodeURIComponent(s.folderUid)}&rule_group=${encodeURIComponent(s.group)}`
  );
  const rules = new Map<string, PromRule>();
  const active: ActiveAlert[] = [];
  for (const g of res.data?.groups ?? []) {
    if (g.name !== s.group || (g.folderUid && g.folderUid !== s.folderUid)) {
      continue;
    }
    for (const r of g.rules) {
      rules.set(r.uid ?? r.name, r);
      for (const a of r.alerts ?? []) {
        if (!/^alerting/i.test(a.state) || !a.labels?.devnum) {
          continue;
        }
        active.push({
          ruleUid: r.uid ?? r.name,
          title: r.name,
          severity: a.labels.severity === 'warning' ? 'warning' : 'critical',
          devnum: a.labels.devnum.toUpperCase(),
          sysid: a.labels.sysid ?? '',
          vol: a.labels.vol ?? '',
          summary: a.annotations?.summary ?? r.name,
        });
      }
    }
  }
  return { rules, active };
}

export function emptySpec(partial: Partial<DasdRuleSpec> = {}): DasdRuleSpec {
  const metric = (partial.metric as string) ?? 'pct_used';
  const m = METRICS[metric];
  return {
    title: '',
    metric,
    op: m.defaultOp,
    value: m.defaultValue,
    storgrps: [],
    systems: [],
    devnums: '',
    volsers: [],
    severity: 'critical',
    receiver: '',
    description: '',
    paused: false,
    ...partial,
  };
}
