/**
 * Konfiguracja kolorów, pasków zajętości i reguł błędów - edytowana w panelu jako JSON
 * (opcja "Konfiguracja JSON"). Brakujące klucze uzupełniane są wartościami domyślnymi.
 * Kolory: nazwy z palety Grafany (green, dark-blue, semi-dark-orange, ...) albo #hex / rgb().
 */
import { DEFAULT_NAMING, NamingConfig, NamingSettings } from './naming';

export type RuleOp = 'eq' | 'ne' | 'in' | 'notIn' | 'gt' | 'gte' | 'lt' | 'lte';
export type IssueLevel = 'error' | 'warning';

export interface Rule {
  /** Nazwa pola, można użyć * (np. "sys*_mvs") */
  field: string;
  op: RuleOp;
  value: string | number | Array<string | number>;
  level: IssueLevel;
  /** {value} i {field} są podstawiane */
  message: string;
  /** Wyszarz kafelek (np. dysk offline) */
  dim?: boolean;
}

export interface MapConfig {
  capacity: {
    /** Kolor kafelka wg modelu (pole "model") */
    models: Record<string, string>;
    /** Gdy modelu brak na liście: pierwszy przedział z capacity <= maxGB */
    ranges: Array<{ maxGB: number; color: string; label?: string }>;
    default: string;
  };
  usage: {
    /** Zajętość całkowita (dla EAV: suma) */
    field: string;
    /** EAV: zajętość części track-managed i cylinder-managed - gdy są, kafelek ma pasek sumy + pasek podzielony TMS|CMS */
    trackField: string;
    cylinderField: string;
    /** Pojemność części TMS / CMS (KB) - szerokość segmentów podzielonego paska */
    trackCapacityField: string;
    cylinderCapacityField: string;
    /** Kolor paska: ostatni próg z from <= wartość */
    thresholds: Array<{ from: number; color: string }>;
  };
  pending: { color: string };
  markers: { error: string; warning: string };
  /** Dysk nie raportowany przez system w wsadzie nowszym o tyle godzin = błąd */
  staleHours: number;
  rules: Rule[];
  /**
   * Nazewnictwo VOLSER: ustawienia globalne + nadpisania per SG, np.
   * { "minPrefix": 3, "groups": { "SGDB2": { "minPrefix": 2 }, "SGTEST": { "prefix": "TST", "suffix": "S", "width": 2 } } }
   */
  naming: NamingConfig;
}

export const DEFAULT_CONFIG: MapConfig = {
  capacity: {
    models: {
      M1: 'green',
      M3: 'light-green',
      M9: 'light-blue',
      M27: 'blue',
      M54: 'orange',
      EAV: 'purple',
    },
    ranges: [
      { maxGB: 1, color: 'green', label: '≤ 1 GB' },
      { maxGB: 3, color: 'light-green', label: '≤ 3 GB' },
      { maxGB: 9, color: 'light-blue', label: '≤ 9 GB' },
      { maxGB: 28, color: 'blue', label: '≤ 28 GB' },
      { maxGB: 56, color: 'orange', label: '≤ 56 GB' },
      { maxGB: 1000000, color: 'purple', label: '> 56 GB' },
    ],
    default: 'gray',
  },
  usage: {
    field: 'pct_used',
    trackField: 'pct_used_trk',
    cylinderField: 'pct_used_cyl',
    trackCapacityField: 'trk_capacity_kb',
    cylinderCapacityField: 'cylmg_capacity_kb',
    thresholds: [
      { from: 0, color: 'green' },
      { from: 80, color: 'orange' },
      { from: 90, color: 'red' },
    ],
  },
  pending: { color: 'yellow' },
  markers: { error: 'red', warning: 'orange' },
  staleHours: 20,
  rules: [
    {
      field: 'sys*_mvs',
      op: 'in',
      value: ['OFFLINE', 'PEND_OFF', 'BOXED', 'NOT_READY'],
      level: 'error',
      message: 'MVS {value} ({field})',
      dim: true,
    },
    { field: 'sys*_sms', op: 'in', value: ['DISALL', 'DISNEW'], level: 'error', message: 'SMS {value} ({field})' },
    { field: 'sys*_sms', op: 'in', value: ['QUIALL', 'QUINEW'], level: 'warning', message: 'SMS {value} ({field})' },
    { field: 'ixvtoc_enabled', op: 'eq', value: 'N', level: 'error', message: 'VTOC index wyłączony' },
    { field: 'pct_used', op: 'gte', value: 95, level: 'error', message: 'Zajętość {value}%' },
    { field: 'frag_index', op: 'gte', value: 800, level: 'warning', message: 'Fragmentacja {value}' },
    { field: 'free_dscbs', op: 'lt', value: 50, level: 'warning', message: 'Mało wolnych DSCB ({value})' },
    // konflikty między systemami - wynik uzgadniania w loader/dcol2influx.py
    { field: 'conflict_error', op: 'ne', value: '', level: 'error', message: '{value}' },
    { field: 'conflict_warning', op: 'ne', value: '', level: 'warning', message: '{value}' },
  ],
  naming: DEFAULT_NAMING,
};

export const DEFAULT_CONFIG_JSON = JSON.stringify(DEFAULT_CONFIG, null, 2);

export function parseConfig(json: string | undefined): { config: MapConfig; error?: string } {
  if (!json?.trim()) {
    return { config: DEFAULT_CONFIG };
  }
  try {
    const c = JSON.parse(json) as Partial<MapConfig>;
    return {
      config: {
        capacity: { ...DEFAULT_CONFIG.capacity, ...c.capacity },
        usage: { ...DEFAULT_CONFIG.usage, ...c.usage },
        pending: { ...DEFAULT_CONFIG.pending, ...c.pending },
        markers: { ...DEFAULT_CONFIG.markers, ...c.markers },
        staleHours: c.staleHours ?? DEFAULT_CONFIG.staleHours,
        rules: Array.isArray(c.rules) ? c.rules : DEFAULT_CONFIG.rules,
        naming: parseNaming(c.naming),
      },
    };
  } catch (e) {
    return { config: DEFAULT_CONFIG, error: `Błędny JSON konfiguracji: ${(e as Error).message}` };
  }
}

const GLOBAL_KEYS = ['minPrefix', 'prefix', 'suffix', 'type', 'width', 'mode', 'groups'];

/** Zgodność wstecz: dawny format { "<SG>": {...} } traktowany jak groups */
function parseNaming(n: unknown): NamingConfig {
  if (!n || typeof n !== 'object') {
    return DEFAULT_NAMING;
  }
  const obj = n as Record<string, unknown>;
  const groups: Record<string, NamingSettings> = { ...((obj.groups as Record<string, NamingSettings>) ?? {}) };
  const global: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (GLOBAL_KEYS.includes(k)) {
      if (k !== 'groups') {
        global[k] = v;
      }
    } else if (v && typeof v === 'object') {
      groups[k] = v as NamingSettings;
    }
  }
  return { ...DEFAULT_NAMING, ...global, groups };
}
