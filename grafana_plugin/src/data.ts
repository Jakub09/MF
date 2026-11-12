import { DataFrame, dateTimeFormat, Field, FieldType, formattedValueToString, getValueFormat, GrafanaTheme2 } from '@grafana/data';
import { MapConfig, Rule } from './config';
import { Change, ChangeStatus, ChangeType, Disk, DiskMapOptions, DiskRow, Issue, MapLine } from './types';

/** Ramka ze zmianami rozpoznawana po tym polu */
export const CHANGE_STATUS_FIELD = 'change_status';

interface Cell {
  field: Field;
  index: number;
}

interface Record {
  cells: Map<string, Cell>;
  collected: number;
  /** system -> czas wsadu, w którym dysk był raportowany */
  systems: Map<string, number>;
}

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function parseAddress(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') {
    return undefined;
  }
  // Liczba = już przeliczony numer urządzenia, tekst = zapis szesnastkowy (DEVNUM z DCOLLECT)
  const n = typeof v === 'number' ? v : parseInt(String(v).trim().replace(/^0x/i, ''), 16);
  return Number.isFinite(n) && n >= 0 && n <= 0xfffff ? n : undefined;
}

export const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

const fieldName = (f: Field) => f.config.displayName ?? f.name;

const findField = (frame: DataFrame, name: string) => frame.fields.find((f) => norm(fieldName(f)) === norm(name) || norm(f.name) === norm(name));

/**
 * Wiersze z formatu "Table" (InfluxQL GROUP BY "devnum","sysid").
 * Ten sam dysk widziany przez kilka systemów -> jeden rekord: wartości z najnowszego wsadu,
 * lista systemów ze wszystkich.
 */
function collectDisks(frames: DataFrame[], o: DiskMapOptions): Map<number, Record> {
  const byAddr = new Map<number, Record>();
  for (const frame of frames) {
    const addrF = findField(frame, o.addressField);
    // ramka ze zmianami też ma devnum - czyta ją collectChanges
    if (!addrF || findField(frame, CHANGE_STATUS_FIELD)) {
      continue;
    }
    const sysF = findField(frame, o.systemField);
    const colF = findField(frame, o.collectedField);
    for (let row = 0; row < frame.length; row++) {
      const addr = parseAddress(addrF.values[row]);
      if (addr === undefined) {
        continue;
      }
      const collected = Number(colF?.values[row] ?? 0) || 0;
      const sys = sysF ? String(sysF.values[row] ?? '').trim() : '';
      const cells = new Map<string, Cell>();
      for (const field of frame.fields) {
        const v = field.values[row];
        if (field === addrF || field.type === FieldType.time || v === null || v === undefined || v === '') {
          continue;
        }
        cells.set(fieldName(field), { field, index: row });
      }
      let rec = byAddr.get(addr);
      if (!rec) {
        rec = { cells, collected, systems: new Map() };
        byAddr.set(addr, rec);
      } else if (collected >= rec.collected) {
        rec.cells = cells;
        rec.collected = collected;
      }
      if (sys) {
        rec.systems.set(sys, Math.max(collected, rec.systems.get(sys) ?? 0));
      }
    }
  }
  return byAddr;
}

/** Aktualny stan zmian per DEVNUM (ramka z polem change_status) */
export function collectChanges(frames: DataFrame[], addressField: string): Change[] {
  const out: Change[] = [];
  for (const frame of frames) {
    const addrF = findField(frame, addressField);
    if (!addrF || !findField(frame, CHANGE_STATUS_FIELD)) {
      continue;
    }
    const get = (name: string, row: number) => {
      const v = findField(frame, name)?.values[row];
      return v === null || v === undefined ? '' : String(v);
    };
    for (let row = 0; row < frame.length; row++) {
      const addr = parseAddress(addrF.values[row]);
      if (addr === undefined) {
        continue;
      }
      out.push({
        devnum: hex4(addr),
        type: (get('change_type', row) || 'add') as ChangeType,
        volser: get('change_volser', row),
        storgrp: get('change_storgrp', row),
        model: get('change_model', row),
        systems: get('change_systems', row),
        comment: get('change_comment', row),
        user: get('change_user', row),
        status: get(CHANGE_STATUS_FIELD, row) as ChangeStatus,
        createdAt: Number(get('change_created', row)) || 0,
        updatedAt: Number(get('change_updated', row)) || Number(get('change_created', row)) || 0,
      });
    }
  }
  return out;
}

const raw = (c?: Cell) => (c ? c.field.values[c.index] : undefined);
const str = (c?: Cell) => {
  const v = raw(c);
  return v === undefined || v === null ? undefined : String(v).trim();
};
const num = (c?: Cell) => {
  const v = raw(c);
  const n = typeof v === 'number' ? v : v !== undefined ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function find(cells: Map<string, Cell>, name: string): Cell | undefined {
  const want = norm(name);
  if (!want) {
    return undefined;
  }
  for (const [k, c] of cells) {
    if (norm(k) === want || norm(c.field.name) === want) {
      return c;
    }
  }
  return undefined;
}

const kbFormat = getValueFormat('kbytes');

/** Czytelne formatowanie pól w dymku */
export function formatValue(name: string, v: unknown): string {
  if (typeof v === 'number') {
    const n = norm(name);
    if (n.endsWith('_kb')) {
      return formattedValueToString(kbFormat(v, 1));
    }
    if (n.startsWith('pct_') || n.endsWith('_pct')) {
      return `${v}%`;
    }
    if (n.endsWith('_at') || n.endsWith('_created') || n.endsWith('_updated')) {
      return dateTimeFormat(v, { format: 'YYYY-MM-DD HH:mm' });
    }
    return v.toLocaleString('pl-PL');
  }
  return String(v);
}

const globRe = (glob: string) =>
  new RegExp('^' + glob.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

function test(rule: Rule, v: unknown): boolean {
  const list = Array.isArray(rule.value) ? rule.value : [rule.value];
  const s = String(v).trim().toUpperCase();
  const n = Number(v);
  const target = Number(rule.value);
  switch (rule.op) {
    case 'eq':
      return s === String(rule.value).toUpperCase();
    case 'ne':
      return s !== String(rule.value).toUpperCase();
    case 'in':
      return list.some((x) => String(x).toUpperCase() === s);
    case 'notIn':
      return !list.some((x) => String(x).toUpperCase() === s);
    case 'gt':
      return n > target;
    case 'gte':
      return n >= target;
    case 'lt':
      return n < target;
    case 'lte':
      return n <= target;
    default:
      return false;
  }
}

function evaluate(rules: Rule[], cells: Map<string, Cell>): { issues: Issue[]; dim: boolean } {
  const issues: Issue[] = [];
  let dim = false;
  for (const rule of rules) {
    const re = globRe(rule.field);
    for (const [name, c] of cells) {
      const v = raw(c);
      if (!re.test(norm(name)) || !test(rule, v)) {
        continue;
      }
      issues.push({
        level: rule.level === 'warning' ? 'warning' : 'error',
        message: rule.message.replace(/\{value\}/g, String(v)).replace(/\{field\}/g, name),
      });
      dim = dim || !!rule.dim;
    }
  }
  return { issues, dim };
}

export function capacityColor(cfg: MapConfig, model: string | undefined, capacityKb: number | undefined): string {
  if (model && cfg.capacity.models[model]) {
    return cfg.capacity.models[model];
  }
  if (capacityKb !== undefined) {
    const gb = capacityKb / 1024 / 1024;
    const range = cfg.capacity.ranges.find((r) => gb <= r.maxGB);
    if (range) {
      return range.color;
    }
  }
  return cfg.capacity.default;
}

export function usageColor(cfg: MapConfig, usage: number): string {
  let color = cfg.usage.thresholds[0]?.color ?? 'green';
  for (const t of cfg.usage.thresholds) {
    if (usage >= t.from) {
      color = t.color;
    }
  }
  return color;
}

export function buildDisks(
  frames: DataFrame[],
  changes: Change[],
  o: DiskMapOptions,
  cfg: MapConfig,
  theme: GrafanaTheme2
): Disk[] {
  const color = (c: string) => theme.visualization.getColorByName(c);
  const tooltip = splitList(o.tooltipFields).map(norm);
  const records = collectDisks(frames, o);

  // Czas ostatniego wsadu każdego systemu
  const lastBatch = new Map<string, number>();
  for (const rec of records.values()) {
    for (const [sys, t] of rec.systems) {
      lastBatch.set(sys, Math.max(t, lastBatch.get(sys) ?? 0));
    }
  }
  const staleMs = cfg.staleHours * 3600 * 1000;

  const pending = new Map(changes.filter((c) => c.status === 'pending').map((c) => [parseInt(c.devnum, 16), c]));
  const disks: Disk[] = [];

  for (const [addr, rec] of records) {
    const { cells } = rec;
    const model = str(find(cells, o.modelField));
    const capacityKb = num(find(cells, o.capacityField));
    const usage = num(find(cells, cfg.usage.field));
    const trk = num(find(cells, cfg.usage.trackField));
    const cyl = num(find(cells, cfg.usage.cylinderField));
    const trkCap = num(find(cells, cfg.usage.trackCapacityField));
    const cylCap = num(find(cells, cfg.usage.cylinderCapacityField));
    const eav =
      trk !== undefined && cyl !== undefined
        ? {
            trk,
            cyl,
            trkColor: color(usageColor(cfg, trk)),
            cylColor: color(usageColor(cfg, cyl)),
            // proporcjonalnie do pojemności, ale min. 25% szerokości na segment - TMS bywa bardzo mały
            share: trkCap && cylCap ? Math.min(0.75, Math.max(0.25, trkCap / (trkCap + cylCap))) : 0.5,
          }
        : undefined;
    const { issues, dim } = evaluate(cfg.rules, cells);

    for (const [sys, t] of rec.systems) {
      if (t > 0 && (lastBatch.get(sys) ?? 0) - t > staleMs) {
        issues.unshift({
          level: 'error',
          message: `Brak w ostatnim DCOLLECT ${sys} (ostatnio ${dateTimeFormat(t, { format: 'YYYY-MM-DD' })})`,
        });
      }
    }

    const details = [...cells.entries()]
      .filter(([name]) => (!tooltip.length || tooltip.includes(norm(name))) && norm(name) !== norm(o.systemField))
      // konflikty są już na liście problemów na górze dymka
      .filter(([name]) => !norm(name).startsWith('conflict_'))
      .map(([name, c]) => ({ name, text: formatValue(name, raw(c)) }));

    disks.push({
      addr,
      hex: hex4(addr),
      label: str(find(cells, o.labelField)) || hex4(addr),
      model,
      capacityKb,
      storgrp: str(find(cells, 'storage_group')),
      usage,
      eav,
      systems: [...rec.systems.keys()].sort(),
      color: color(capacityColor(cfg, model, capacityKb)),
      usageColor: usage !== undefined ? color(usageColor(cfg, usage)) : undefined,
      issues,
      dim,
      details,
      values: Object.fromEntries([...cells.entries()].map(([name, c]) => [name, raw(c)])),
      alerts: [],
      change: pending.get(addr),
      ghost: false,
    });
    pending.delete(addr);
  }

  // Nowe dyski, których jeszcze nie ma w DCOLLECT
  for (const [addr, ch] of pending) {
    if (!Number.isFinite(addr)) {
      continue;
    }
    disks.push({
      addr,
      hex: hex4(addr),
      label: ch.volser || hex4(addr),
      model: ch.model || undefined,
      storgrp: ch.storgrp || undefined,
      systems: splitList(ch.systems).map((s) => s.toUpperCase()),
      color: color(capacityColor(cfg, ch.model, undefined)),
      issues: [],
      dim: false,
      details: [],
      values: {},
      alerts: [],
      change: ch,
      ghost: true,
    });
  }
  return disks.sort((a, b) => a.addr - b.addr);
}

function rowSummary(cells: Array<Disk | undefined>) {
  const models = new Map<string, number>();
  const systems = new Map<string, number>();
  let diskCount = 0;
  for (const d of cells) {
    if (!d) {
      continue;
    }
    // nowy dysk bez podanych systemów nie robi z systemu wiersza "częściowego"
    if (!(d.ghost && !d.systems.length)) {
      diskCount++;
    }
    // niepotwierdzony nowy dysk nie zmienia modelu wiersza
    if (d.model && !d.ghost) {
      models.set(d.model, (models.get(d.model) ?? 0) + 1);
    }
    d.systems.forEach((s) => systems.set(s, (systems.get(s) ?? 0) + 1));
  }
  const sorted = [...models.entries()].sort((a, b) => b[1] - a[1]);
  return {
    model: sorted.length === 0 ? undefined : sorted.length === 1 ? sorted[0][0] : 'mix',
    modelTitle: sorted.map(([m, n]) => `${m}×${n}`).join(', '),
    systems: [...systems.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    diskCount,
  };
}

/** Wiersze po 16 adresów (ostatnia cyfra hex = kolumna) */
export function buildLines(disks: Disk[], layout: 'compact' | 'full'): MapLine[] {
  const rows = new Map<number, Array<Disk | undefined>>();
  for (const d of disks) {
    const base = d.addr >> 4;
    let cells = rows.get(base);
    if (!cells) {
      cells = new Array(16).fill(undefined);
      rows.set(base, cells);
    }
    cells[d.addr & 0xf] = d;
  }
  const bases = [...rows.keys()].sort((a, b) => a - b);
  const lines: MapLine[] = [];
  const makeRow = (base: number): DiskRow => {
    const cells = rows.get(base) ?? new Array(16).fill(undefined);
    return { base, hex: hex4(base << 4), cells, ...rowSummary(cells) };
  };

  bases.forEach((base, i) => {
    const prev = bases[i - 1];
    if (prev !== undefined && base - prev > 1) {
      if (layout === 'full') {
        for (let b = prev + 1; b < base; b++) {
          lines.push({ kind: 'row', row: makeRow(b) });
        }
      } else {
        lines.push({ kind: 'gap', from: (prev + 1) << 4, to: (base << 4) - 1 });
      }
    }
    lines.push({ kind: 'row', row: makeRow(base) });
  });
  return lines;
}
