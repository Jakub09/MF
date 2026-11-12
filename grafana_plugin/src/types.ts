import { IssueLevel } from './config';

export type CellStyle = 'tinted' | 'solid';
export type RowLayout = 'compact' | 'full';

export interface DiskMapOptions {
  /** Pole z numerem urządzenia (DEVNUM, hex np. "8080") */
  addressField: string;
  /** Tekst w kafelku (VOLSER) */
  labelField: string;
  modelField: string;
  capacityField: string;
  /** System, który raportuje dysk (tag sysid) */
  systemField: string;
  /** Czas wsadu DCOLLECT (ms) - wykrywanie dysków nieobecnych w ostatnim wsadzie */
  collectedField: string;
  /** JSON z kolorami, progami i regułami błędów (patrz config.ts) */
  config: string;
  /** Edytorzy mogą rejestrować zmiany (dasd_change) */
  allowChanges: boolean;

  /** Reguły alertów (Grafana Alerting) zarządzane z panelu */
  alertsEnabled: boolean;
  alertFolderUid: string;
  alertFolderTitle: string;
  alertGroup: string;
  alertInterval: string;
  alertWindowHours: number;
  /** Domyślny punkt kontaktowy nowych reguł (puste = polityka powiadomień) */
  alertReceiver: string;

  cellStyle: CellStyle;
  cellMinWidth: number;
  cellHeight: number;
  rowLayout: RowLayout;
  showToolbar: boolean;
  showLegend: boolean;
  /** Pola w dymku (lista po przecinku, puste = wszystkie) */
  tooltipFields: string;
}

export interface DetailItem {
  name: string;
  text: string;
}

export interface Issue {
  level: IssueLevel;
  message: string;
}

export type ChangeType = 'add' | 'modify' | 'remove';
export type ChangeStatus = 'pending' | 'confirmed' | 'cancelled';

/** Zmiana wprowadzona ręcznie, czekająca na potwierdzenie przez wsad DCOLLECT */
export interface Change {
  devnum: string;
  type: ChangeType;
  volser: string;
  storgrp: string;
  model: string;
  /** Lista po przecinku */
  systems: string;
  comment: string;
  user: string;
  status: ChangeStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Disk {
  addr: number;
  hex: string;
  label: string;
  model?: string;
  capacityKb?: number;
  storgrp?: string;
  usage?: number;
  /** EAV: zajętość TMS i CMS, share = udział TMS w szerokości podzielonego paska (0-1) */
  eav?: { trk: number; cyl: number; trkColor: string; cylColor: string; share: number };
  systems: string[];
  /** Kolor wg pojemności (rozwiązany przez motyw) */
  color: string;
  usageColor?: string;
  issues: Issue[];
  dim: boolean;
  details: DetailItem[];
  /** Surowe wartości pól (najnowszy wsad) - podgląd reguł alertów */
  values: Record<string, unknown>;
  /** Aktywne alerty Grafany dla dysku */
  alerts: Array<{ title: string; severity: 'critical' | 'warning'; summary: string }>;
  /** Niepotwierdzona zmiana dla tego adresu */
  change?: Change;
  /** Dysk istnieje tylko jako niepotwierdzona zmiana "add" */
  ghost: boolean;
}

export interface DiskRow {
  /** addr >> 4 */
  base: number;
  hex: string;
  model?: string;
  modelTitle?: string;
  /** System -> liczba dysków w wierszu */
  systems: Array<{ name: string; count: number }>;
  diskCount: number;
  cells: Array<Disk | undefined>;
}

/** Wiersz mapy albo separator przerwy w adresacji */
export type MapLine = { kind: 'row'; row: DiskRow } | { kind: 'gap'; from: number; to: number };
