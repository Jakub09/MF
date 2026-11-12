/**
 * Wzorce nazw VOLSER w storage group: prefiks + numer + sufiks, np.
 *   SYS16F = SYS | 16F        TST1AS = TST | 1A | S        (numer: znaki 0-F, hex)
 * Wzorzec jest wykrywany z istniejących wolumenów SG albo ustawiony w konfiguracji (naming / naming.groups.<SG>).
 */
export type NumberType = 'x' | 'd';
/** next = kolejny wolny numer, devnum = numer z końcówki adresu (np. SYS106 na 9106) */
export type NumberMode = 'next' | 'devnum';

export interface NamingPattern {
  prefix: string;
  suffix: string;
  type: NumberType;
  /** Liczba cyfr numeru */
  width: number;
  mode: NumberMode;
}

export interface Detected {
  pattern?: NamingPattern;
  /** Liczba wolumenów, z których wykryto wzorzec */
  basis: number;
}

export interface Proposal {
  devnum: number;
  volser?: string;
  problem?: string;
}

export const MAX_VOLSER = 6;
const HEX_RE = /^[0-9A-F]+$/;
const DEC_RE = /^[0-9]+$/;
const isHexChar = (c: string) => /[0-9A-F]/.test(c);

/**
 * Ustawienia nazewnictwa: globalne (naming.*) i per SG (naming.groups.<SG>.*) - SG nadpisuje globalne.
 * minPrefix wpływa na wykrywanie; pola wzorca (prefix, suffix, type, width, mode) nadpisują wynik wykrywania.
 */
export interface NamingSettings extends Partial<NamingPattern> {
  /** Co najmniej tyle pierwszych znaków to prefiks */
  minPrefix?: number;
}

export interface NamingConfig extends NamingSettings {
  groups: Record<string, NamingSettings>;
}

export const DEFAULT_NAMING: NamingConfig = { minPrefix: 3, groups: {} };

const PATTERN_KEYS = ['prefix', 'suffix', 'type', 'width', 'mode'] as const;

/** Ustawienia dla SG: globalne + nadpisania SG */
export function settingsFor(cfg: NamingConfig, sg: string): NamingSettings {
  const { groups, ...global } = cfg;
  return { ...global, ...(groups?.[sg] ?? {}) };
}

/** Pola wzorca ustawione wprost (bez minPrefix) */
export function patternOverrides(s: NamingSettings): Partial<NamingPattern> {
  const out: Partial<NamingPattern> = {};
  for (const k of PATTERN_KEYS) {
    if (s[k] !== undefined) {
      (out as Record<string, unknown>)[k] = s[k];
    }
  }
  return out;
}

/**
 * Podział nazwy: min. minPrefix pierwszych znaków + kolejne znaki spoza 0-F to prefiks,
 * najdłuższy dalszy ciąg znaków 0-F to numer (zawsze hex), reszta to sufiks.
 *   TST1AS -> TST|1A|S    SYS16F -> SYS|16F    SYSX12 -> SYSX|12
 */
export function splitVolser(volser: string, minPrefix: number): { prefix: string; number: string; suffix: string } | undefined {
  const v = volser.trim().toUpperCase();
  let i = Math.min(Math.max(0, minPrefix), v.length);
  while (i < v.length && !isHexChar(v[i])) {
    i++;
  }
  let j = i;
  while (j < v.length && isHexChar(v[j])) {
    j++;
  }
  return j > i ? { prefix: v.slice(0, i), number: v.slice(i, j), suffix: v.slice(j) } : undefined;
}

export function detectPattern(vols: Array<{ volser: string; addr: number }>, minPrefix: number): Detected {
  // Każda nazwa dzielona osobno; wygrywa najczęstszy układ prefiks/cyfry/sufiks - odstające nazwy odpadają same
  const groups = new Map<string, Array<{ addr: number; number: string }>>();
  const seen = new Set<string>();
  for (const v of vols) {
    const name = v.volser.trim().toUpperCase();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const parts = splitVolser(name, minPrefix);
    if (!parts) {
      continue;
    }
    const key = `${parts.prefix}|${parts.number.length}|${parts.suffix}`;
    const list = groups.get(key) ?? [];
    list.push({ addr: v.addr, number: parts.number });
    groups.set(key, list);
  }
  if (!groups.size) {
    return { basis: 0 };
  }
  const [key, members] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const [prefix, width, suffix] = key.split('|');
  const w = Number(width);
  const mirrorsDevnum = members.length >= 2 && members.every((m) => parseInt(m.number, 16) === m.addr % 16 ** w);
  return {
    pattern: { prefix, suffix, type: 'x', width: w, mode: mirrorsDevnum ? 'devnum' : 'next' },
    basis: members.length,
  };
}

export function formatNumber(p: NamingPattern, n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0) {
    return undefined;
  }
  const digits = p.type === 'x' ? n.toString(16).toUpperCase() : String(n);
  return digits.length > p.width ? undefined : digits.padStart(p.width, '0');
}

export function formatVolser(p: NamingPattern, n: number): string | undefined {
  const digits = formatNumber(p, n);
  const v = digits === undefined ? undefined : `${p.prefix}${digits}${p.suffix}`;
  return v && v.length <= MAX_VOLSER ? v : undefined;
}

export function parseNumber(p: NamingPattern, volser: string): number | undefined {
  const v = volser.trim().toUpperCase();
  if (!v.startsWith(p.prefix) || !v.endsWith(p.suffix) || v.length !== p.prefix.length + p.width + p.suffix.length) {
    return undefined;
  }
  const digits = v.slice(p.prefix.length, v.length - p.suffix.length);
  if (!(p.type === 'x' ? HEX_RE : DEC_RE).test(digits)) {
    return undefined;
  }
  return parseInt(digits, p.type === 'x' ? 16 : 10);
}

export function parseFrom(p: NamingPattern, text: string): number | undefined {
  const t = text.trim().toUpperCase();
  if (!t || !(p.type === 'x' ? HEX_RE : DEC_RE).test(t)) {
    return undefined;
  }
  return parseInt(t, p.type === 'x' ? 16 : 10);
}

/** Pierwszy numer po najwyższym zajętym w SG */
export function nextNumber(p: NamingPattern, sgVolsers: string[]): number {
  const used = sgVolsers.map((v) => parseNumber(p, v)).filter((n): n is number => n !== undefined);
  return used.length ? Math.max(...used) + 1 : 0;
}

/** Nazwy dla kolejnych adresów: kolejne numery od "from" albo numer z adresu */
export function propose(p: NamingPattern, devnums: number[], from: number, used: Set<string>): Proposal[] {
  const seen = new Set<string>();
  return devnums.map((devnum, i) => {
    const n = p.mode === 'devnum' ? devnum % 16 ** p.width : from + i;
    const volser = formatVolser(p, n);
    let problem: string | undefined;
    if (!volser) {
      problem = `numer ${n.toString(p.type === 'x' ? 16 : 10).toUpperCase()} nie mieści się we wzorcu`;
    } else if (used.has(volser)) {
      problem = 'VOLSER już istnieje';
    } else if (seen.has(volser)) {
      problem = 'powtórzony VOLSER';
    }
    if (volser) {
      seen.add(volser);
    }
    return { devnum, volser, problem };
  });
}

/** "9106-9109, 9120" -> [0x9106..0x9109, 0x9120] */
export function parseDevnums(text: string, max = 256): { devnums: number[]; error?: string } {
  const out: number[] = [];
  for (const token of text.toUpperCase().split(/[\s,;]+/).filter(Boolean)) {
    const m = /^([0-9A-F]{4,5})(?:-([0-9A-F]{4,5}))?$/.exec(token);
    if (!m) {
      return { devnums: [], error: `Niepoprawny adres "${token}" (np. 9106 albo 9106-910F)` };
    }
    const a = parseInt(m[1], 16);
    const b = m[2] ? parseInt(m[2], 16) : a;
    if (b < a) {
      return { devnums: [], error: `Odwrotny zakres "${token}"` };
    }
    for (let x = a; x <= b; x++) {
      out.push(x);
      if (out.length > max) {
        return { devnums: [], error: `Maksymalnie ${max} adresów naraz` };
      }
    }
  }
  return { devnums: [...new Set(out)].sort((x, y) => x - y) };
}

/** [0x9106, 0x9107, 0x9108, 0x9120] -> "9106-9108, 9120" */
export function formatDevnums(devnums: number[]): string {
  const sorted = [...new Set(devnums)].sort((a, b) => a - b);
  const parts: string[] = [];
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) {
      j++;
    }
    parts.push(i === j ? hex(sorted[i]) : `${hex(sorted[i])}-${hex(sorted[j])}`);
    i = j;
  }
  return parts.join(', ');
}
