import { lastValueFrom } from 'rxjs';
import { PanelData } from '@grafana/data';
import { config, getBackendSrv, getDataSourceSrv } from '@grafana/runtime';
import { Change } from './types';

/** Measurement ze zmianami - ten sam, który czyta i potwierdza loader/dcol2influx.py */
export const CHANGE_MEASUREMENT = 'dasd_change';

export function canEdit(): boolean {
  const u = config.bootData.user;
  return u.isGrafanaAdmin || u.orgRole === 'Admin' || u.orgRole === 'Editor';
}

export const currentUser = () => config.bootData.user.login;

/** Datasource zapytania o zmiany (InfluxDB 1.x) - tam też zapisujemy */
function target(data: PanelData): { uid: string; db: string } {
  const targets = data.request?.targets ?? [];
  const t = targets.find((x) => JSON.stringify(x).includes(CHANGE_MEASUREMENT)) ?? targets[0];
  const ref = t?.datasource ?? data.request?.targets?.[0]?.datasource;
  const settings = getDataSourceSrv().getInstanceSettings(ref ?? undefined);
  if (!settings) {
    throw new Error('Nie znaleziono źródła danych panelu');
  }
  const json = settings.jsonData as { dbName?: string };
  const db = json.dbName || (settings as unknown as { database?: string }).database;
  if (!db) {
    throw new Error(`Źródło "${settings.name}" nie ma ustawionej bazy InfluxDB`);
  }
  return { uid: settings.uid, db };
}

const esc = (v: string) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const escTag = (v: string) => v.replace(/[,= \\]/g, (m) => '\\' + m);

/** Każdy punkt ma komplet pól - ostatni punkt per DEVNUM = aktualny stan zmiany */
export function toLine(c: Change): string {
  const fields = [
    `type=${esc(c.type)}`,
    `volser=${esc(c.volser)}`,
    `storgrp=${esc(c.storgrp)}`,
    `model=${esc(c.model)}`,
    `systems=${esc(c.systems)}`,
    `comment=${esc(c.comment)}`,
    `user=${esc(c.user)}`,
    `status=${esc(c.status)}`,
    `created_at=${Math.round(c.createdAt)}i`,
    `updated_at=${Math.round(c.updatedAt)}i`,
  ];
  return `${CHANGE_MEASUREMENT},devnum=${escTag(c.devnum)} ${fields.join(',')} ${Math.round(c.updatedAt)}`;
}

export async function saveChanges(data: PanelData, changes: Change[]): Promise<void> {
  const { uid, db } = target(data);
  await lastValueFrom(
    getBackendSrv().fetch({
      method: 'POST',
      url: `/api/datasources/proxy/uid/${uid}/write`,
      params: { db, precision: 'ms' },
      data: changes.map(toLine).join('\n'),
      headers: { 'Content-Type': 'text/plain' },
      // InfluxDB odpowiada 204 bez treści - bez tego backendSrv próbuje parsować JSON
      responseType: 'text',
      showSuccessAlert: false,
    })
  );
}

/** Lokalne zmiany (zapisane przed odświeżeniem danych) mają pierwszeństwo, jeśli są nowsze */
export function mergeChanges(fromData: Change[], local: Change[]): Change[] {
  const map = new Map<string, Change>();
  for (const c of [...fromData, ...local]) {
    const prev = map.get(c.devnum);
    if (!prev || c.updatedAt >= prev.updatedAt) {
      map.set(c.devnum, c);
    }
  }
  return [...map.values()];
}
