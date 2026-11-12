import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { colorManipulator, dateTimeFormat, GrafanaTheme2, PanelProps } from '@grafana/data';
import { getAppEvents, getDataSourceSrv, RefreshEvent } from '@grafana/runtime';
import { Button, Icon, Input, useStyles2, useTheme2 } from '@grafana/ui';
import { parseConfig } from '../config';
import { buildDisks, buildLines, collectChanges, hex4 } from '../data';
import { canEdit, mergeChanges, saveChanges } from '../changes';
import { formatDevnums, NamingSettings } from '../naming';
import { Change, Disk, DiskMapOptions, DiskRow } from '../types';
import { ChangeModal } from './ChangeModal';
import { ChangesListModal } from './ChangesListModal';
import { AlertRulesModal } from './AlertRulesModal';
import { ActiveAlert, AlertSettings, DasdRuleSpec, ruleStates } from '../alerts';

const ADDR_W = 64;
const MODEL_W = 60;
const SYS_W = 136;
const GAP = 3;
const COLUMNS = '0123456789ABCDEF'.split('');
const TYPE_LABEL: Record<string, string> = { add: 'Nowy dysk', modify: 'Zmiana', remove: 'Wycofanie' };

interface Hover {
  disk: Disk;
  x: number;
  y: number;
}

type Editing = { initial: Partial<Change> & { devnum: string }; existing?: Disk };

export const DiskMapPanel: React.FC<PanelProps<DiskMapOptions>> = ({ data, options, width, height, onOptionsChange }) => {
  const theme = useTheme2();
  const styles = useStyles2(getStyles, options);
  const rootRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [search, setSearch] = useState('');
  const [local, setLocal] = useState<Change[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [listOpen, setListOpen] = useState(false);
  /** Zaznaczone wolne adresy (Ctrl/Shift+klik) - dodawanie wielu dysków naraz */
  const [selected, setSelected] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number>();
  /** Okno reguł alertów: true = lista, obiekt = nowa reguła z wypełnionym zakresem */
  const [alertsOpen, setAlertsOpen] = useState<Partial<DasdRuleSpec> | true | null>(null);
  const [activeAlerts, setActiveAlerts] = useState<ActiveAlert[]>([]);
  const [alertsTick, setAlertsTick] = useState(0);

  const { config: cfg, error: cfgError } = useMemo(() => parseConfig(options.config), [options.config]);
  const changes = useMemo(
    () => mergeChanges(collectChanges(data.series, options.addressField), local),
    [data.series, options.addressField, local]
  );
  // Reguły alertów: datasource zapytania z danymi dysków (A)
  const alertSettings = useMemo<AlertSettings | undefined>(() => {
    const ref = data.request?.targets?.find((t) => !JSON.stringify(t).includes('dasd_change'))?.datasource;
    const uid = ref ? getDataSourceSrv().getInstanceSettings(ref)?.uid : undefined;
    return options.alertsEnabled && uid
      ? {
          folderUid: options.alertFolderUid || 'mainframe-dasd',
          folderTitle: options.alertFolderTitle || 'Mainframe DASD',
          group: options.alertGroup || 'dasd-map',
          interval: options.alertInterval || '15m',
          windowHours: options.alertWindowHours || 30,
          datasourceUid: uid,
        }
      : undefined;
  }, [data.request, options.alertsEnabled, options.alertFolderUid, options.alertFolderTitle, options.alertGroup, options.alertInterval, options.alertWindowHours]);

  // Aktywne alerty: przy odświeżeniu danych, po zmianie reguł i co minutę
  useEffect(() => {
    if (!alertSettings) {
      setActiveAlerts([]);
      return;
    }
    let alive = true;
    const load = () =>
      ruleStates(alertSettings)
        .then((r) => alive && setActiveAlerts(r.active))
        .catch(() => alive && setActiveAlerts([]));
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [alertSettings, data.series, alertsTick]);

  const builtDisks = useMemo(() => buildDisks(data.series, changes, options, cfg, theme), [data.series, changes, options, cfg, theme]);
  // Aktywne alerty jako problemy dysku (znacznik w rogu + dymek)
  const disks = useMemo(() => {
    if (!activeAlerts.length) {
      return builtDisks;
    }
    const byDev = new Map<string, ActiveAlert[]>();
    activeAlerts.forEach((a) => byDev.set(a.devnum, [...(byDev.get(a.devnum) ?? []), a]));
    return builtDisks.map((d) => {
      const list = byDev.get(d.hex);
      if (!list || d.ghost) {
        return d;
      }
      const alerts = list.map((a) => ({ title: a.title, severity: a.severity, summary: a.summary }));
      return {
        ...d,
        alerts,
        issues: [
          ...list.map((a) => ({ level: a.severity === 'critical' ? ('error' as const) : ('warning' as const), message: `Alert: ${a.summary}` })),
          ...d.issues,
        ],
      };
    });
  }, [builtDisks, activeAlerts]);
  const lines = useMemo(() => buildLines(disks, options.rowLayout), [disks, options.rowLayout]);
  const pending = changes.filter((c) => c.status === 'pending');
  const editable = options.allowChanges && canEdit();

  const systems = useMemo(() => [...new Set(disks.flatMap((d) => d.systems))].sort(), [disks]);
  const sysColor = (s: string) => theme.visualization.palette[Math.max(0, systems.indexOf(s)) % theme.visualization.palette.length];

  const query = search.trim().toUpperCase();
  const matches = (d: Disk) =>
    !query ||
    [d.label, d.hex, d.model, d.storgrp, ...d.systems].some((x) => x?.toUpperCase().includes(query));

  const save = async (cs: Change[]) => {
    await saveChanges(data, cs);
    setLocal((prev) => [...prev, ...cs]);
    setSelected([]);
    getAppEvents().publish(new RefreshEvent());
  };

  /** Wzorzec VOLSER zapisany w JSON-ie konfiguracji (naming.groups.<SG>) - trwały po zapisaniu dashboardu */
  const savePattern = (sg: string, p: NamingSettings) => {
    let json: Record<string, unknown>;
    try {
      json = options.config?.trim() ? JSON.parse(options.config) : JSON.parse(JSON.stringify(cfg));
    } catch {
      json = JSON.parse(JSON.stringify(cfg));
    }
    // przez parseConfig, żeby dawny format naming.<SG> trafił do groups
    const naming = parseConfig(JSON.stringify({ naming: json.naming })).config.naming;
    json.naming = { ...naming, groups: { ...naming.groups, [sg]: p } };
    onOptionsChange({ ...options, config: JSON.stringify(json, null, 2) });
  };

  // Wolne adresy w widocznych wierszach - zakres Shift+klik
  const freeAddrs = lines.flatMap((l) =>
    l.kind === 'row' ? l.row.cells.map((d, col) => (d ? -1 : (l.row.base << 4) + col)).filter((a) => a >= 0) : []
  );
  const clickFree = (addr: number, e: React.MouseEvent) => {
    if (!editable) {
      return;
    }
    if (e.shiftKey && anchor !== undefined) {
      const [a, b] = anchor < addr ? [anchor, addr] : [addr, anchor];
      const range = freeAddrs.filter((x) => x >= a && x <= b);
      setSelected((prev) => [...new Set([...prev, ...range])].sort((x, y) => x - y));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => (prev.includes(addr) ? prev.filter((x) => x !== addr) : [...prev, addr].sort((x, y) => x - y)));
      setAnchor(addr);
    } else {
      setSelected([]);
      setAnchor(addr);
      setEditing({ initial: { devnum: hex4(addr), type: 'add' } });
    }
  };

  if (!disks.length) {
    return (
      <div className={styles.empty}>
        <Icon name="info-circle" /> Brak danych z polem adresu „{options.addressField}”. Sprawdź zapytanie (format Table) i
        opcje panelu.
      </div>
    );
  }

  const cellLook = (d: Disk): React.CSSProperties => {
    if (d.ghost) {
      return { color: theme.colors.text.primary };
    }
    if (options.cellStyle === 'solid') {
      return { background: d.color, color: theme.colors.getContrastText(d.color), borderColor: d.color };
    }
    return {
      background: colorManipulator.alpha(d.color, theme.isDark ? 0.28 : 0.22),
      color: theme.colors.text.primary,
      borderColor: colorManipulator.alpha(d.color, 0.9),
    };
  };

  const onMove = (e: React.MouseEvent, disk: Disk) => {
    const box = rootRef.current?.getBoundingClientRect();
    if (box) {
      setHover({ disk, x: e.clientX - box.left, y: e.clientY - box.top });
    }
  };

  const openDisk = (d: Disk) => {
    if (d.change) {
      setEditing({ initial: d.change, existing: d });
    } else if (editable) {
      setEditing({ initial: { devnum: d.hex }, existing: d });
    }
  };

  const real = disks.filter((d) => !d.ghost);
  const errors = real.filter((d) => d.issues.some((i) => i.level === 'error')).length;
  const warnings = real.filter((d) => d.issues.length && !d.issues.some((i) => i.level === 'error')).length;
  const models = summarize(real.map((d) => d.model));
  const pendingColor = theme.visualization.getColorByName(cfg.pending.color);
  const markerColor = (d: Disk) =>
    theme.visualization.getColorByName(d.issues.some((i) => i.level === 'error') ? cfg.markers.error : cfg.markers.warning);

  return (
    <div ref={rootRef} className={styles.root} style={{ width, height }}>
      {options.showToolbar && (
        <div className={styles.toolbar}>
          <div className={styles.summary}>
            <span>
              <strong>{real.length}</strong> dysków
            </span>
            <span>
              zakres <strong>{real[0]?.hex}</strong>–<strong>{real[real.length - 1]?.hex}</strong>
            </span>
            {models && <span>{models}</span>}
            {errors > 0 && (
              <span style={{ color: theme.visualization.getColorByName(cfg.markers.error) }}>
                <Icon name="exclamation-circle" size="sm" /> błędy: {errors}
              </span>
            )}
            {warnings > 0 && (
              <span style={{ color: theme.visualization.getColorByName(cfg.markers.warning) }}>
                <Icon name="exclamation-triangle" size="sm" /> ostrzeżenia: {warnings}
              </span>
            )}
            {cfgError && (
              <span className={styles.cfgError} title={cfgError}>
                <Icon name="bug" size="sm" /> błędny JSON konfiguracji
              </span>
            )}
          </div>
          <div className={styles.actions}>
            {selected.length > 0 && (
              <>
                <span className={styles.selInfo} title={formatDevnums(selected)}>
                  zaznaczono: <strong>{selected.length}</strong>
                </span>
                <Button size="sm" icon="plus" onClick={() => setEditing({ initial: { devnum: formatDevnums(selected), type: 'add' } })}>
                  Dodaj {selected.length} dysków
                </Button>
                <Button size="sm" variant="secondary" fill="text" icon="times" tooltip="Wyczyść zaznaczenie" onClick={() => setSelected([])} />
              </>
            )}
            {alertSettings && (
              <Button
                size="sm"
                variant={activeAlerts.length ? 'destructive' : 'secondary'}
                fill={activeAlerts.length ? 'solid' : 'outline'}
                icon={activeAlerts.length ? 'fire' : 'bell'}
                tooltip={
                  activeAlerts.length
                    ? [...new Set(activeAlerts.map((a) => `${a.vol || a.devnum} (${a.sysid}): ${a.title}`))].slice(0, 15).join('\n')
                    : 'Reguły alertów dla dysków'
                }
                onClick={() => setAlertsOpen(true)}
              >
                Alerty{activeAlerts.length ? `: ${new Set(activeAlerts.map((a) => a.devnum)).size}` : ''}
              </Button>
            )}
            {(pending.length > 0 || editable) && (
              <Button size="sm" variant="secondary" fill="outline" icon="clock-nine" onClick={() => setListOpen(true)}>
                Niepotwierdzone: {pending.length}
              </Button>
            )}
            {editable && (
              <Button size="sm" icon="plus" onClick={() => setEditing({ initial: { devnum: '', type: 'add' } })}>
                Dodaj zmianę
              </Button>
            )}
            <Input
              prefix={<Icon name="search" />}
              placeholder="VOLSER / adres / SG / system"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              width={30}
            />
          </div>
        </div>
      )}

      <div className={styles.scroll} onMouseLeave={() => setHover(null)}>
        <div className={styles.grid}>
          <div className={cx(styles.header, styles.stickyAddr)}>Adres</div>
          <div className={cx(styles.header, styles.stickyModel)}>Model</div>
          {COLUMNS.map((c) => (
            <div key={c} className={styles.header}>
              {c}
            </div>
          ))}
          <div className={cx(styles.header, styles.stickySys)}>System</div>

          {lines.map((line) =>
            line.kind === 'gap' ? (
              <div key={`gap-${line.from}`} className={styles.gap}>
                <span>
                  ⋯ {hex4(line.from)}–{hex4(line.to)} brak urządzeń ⋯
                </span>
              </div>
            ) : (
              <React.Fragment key={line.row.base}>
                <div className={cx(styles.rowHead, styles.stickyAddr, styles.mono)}>{line.row.hex}</div>
                <div className={cx(styles.rowHead, styles.stickyModel)} title={line.row.modelTitle}>
                  {line.row.model ?? '—'}
                </div>
                {line.row.cells.map((d, col) =>
                  d ? (
                    <div
                      key={col}
                      className={cx(
                        styles.disk,
                        d.ghost && styles.ghost,
                        d.change && !d.ghost && styles.changed,
                        d.dim && styles.dim,
                        (editable || d.change) && styles.clickable,
                        query && !matches(d) && styles.faded,
                        query && matches(d) && styles.match
                      )}
                      style={{ ...cellLook(d), ...(d.change ? { ['--pending' as string]: pendingColor } : {}) }}
                      onMouseMove={(e) => onMove(e, d)}
                      onClick={() => openDisk(d)}
                    >
                      {d.issues.length > 0 && <span className={styles.corner} style={{ borderTopColor: markerColor(d) }} />}
                      {d.change && (
                        <span className={styles.pendingIcon} style={{ color: pendingColor }}>
                          <Icon name="clock-nine" size="xs" />
                        </span>
                      )}
                      <span className={cx(styles.label, d.change?.type === 'remove' && styles.strike)}>
                        {d.change?.type === 'modify' && d.change.volser && d.change.volser !== d.label
                          ? `${d.label}→${d.change.volser}`
                          : d.label}
                      </span>
                      {d.eav ? (
                        <>
                          <span className={styles.usage} title={`suma: ${d.usage ?? '?'}%`}>
                            <UsageBar value={d.usage ?? 0} color={d.usageColor} styles={styles} />
                            <span className={styles.pct}>{d.usage !== undefined ? `${Math.round(d.usage)}%` : '?'}</span>
                          </span>
                          {/* TMS | CMS na całą szerokość - wartości w dymku */}
                          <span className={styles.split} title={`TMS: ${d.eav.trk}% · CMS: ${d.eav.cyl}%`}>
                            <span style={{ flex: d.eav.share }}>
                              <UsageBar value={d.eav.trk} color={d.eav.trkColor} styles={styles} />
                            </span>
                            <span style={{ flex: 1 - d.eav.share }}>
                              <UsageBar value={d.eav.cyl} color={d.eav.cylColor} styles={styles} />
                            </span>
                          </span>
                        </>
                      ) : d.usage !== undefined ? (
                        <span className={styles.usage}>
                          <UsageBar value={d.usage} color={d.usageColor} styles={styles} />
                          <span className={styles.pct}>{Math.round(d.usage)}%</span>
                        </span>
                      ) : (
                        d.ghost && <span className={styles.pct}>{d.storgrp ? `→ ${d.storgrp}` : 'nowy'}</span>
                      )}
                    </div>
                  ) : (
                    <div
                      key={col}
                      className={cx(
                        styles.free,
                        editable && styles.freeEditable,
                        selected.includes((line.row.base << 4) + col) && styles.freeSelected
                      )}
                      title={
                        editable
                          ? `${hex4((line.row.base << 4) + col)} – klik: dodaj dysk · Ctrl+klik: zaznacz · Shift+klik: zaznacz zakres`
                          : hex4((line.row.base << 4) + col)
                      }
                      onClick={(e) => clickFree((line.row.base << 4) + col, e)}
                    >
                      {editable &&
                        (selected.includes((line.row.base << 4) + col) ? (
                          <Icon name="check" className={styles.freeCheck} />
                        ) : (
                          <Icon name="plus" className={styles.freePlus} />
                        ))}
                    </div>
                  )
                )}
                <SystemsCell row={line.row} color={sysColor} />
              </React.Fragment>
            )
          )}
        </div>
      </div>

      {options.showLegend && (
        <div className={styles.legend}>
          {legendCapacity(cfg, real).map(([label, color]) => (
            <span key={label} className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: theme.visualization.getColorByName(color) }} />
              {label}
            </span>
          ))}
          <span className={styles.legendSep} />
          {cfg.usage.thresholds.map((t, i) => (
            <span key={i} className={styles.legendItem}>
              <span className={styles.barSwatch} style={{ background: theme.visualization.getColorByName(t.color) }} />
              {cfg.usage.thresholds[i + 1] ? `${t.from}–${cfg.usage.thresholds[i + 1].from}%` : `≥ ${t.from}%`}
            </span>
          ))}
          <span className={styles.legendSep} />
          <span className={styles.legendItem}>
            <span className={styles.cornerSwatch} style={{ borderTopColor: theme.visualization.getColorByName(cfg.markers.error) }} /> błąd
          </span>
          <span className={styles.legendItem}>
            <span className={styles.cornerSwatch} style={{ borderTopColor: theme.visualization.getColorByName(cfg.markers.warning) }} />{' '}
            ostrzeżenie
          </span>
          <span className={styles.legendItem}>
            <span className={cx(styles.swatch, styles.ghostSwatch)} style={{ ['--pending' as string]: pendingColor }} /> niepotwierdzony
          </span>
          <span className={styles.legendItem}>
            <span className={cx(styles.swatch, styles.dim)} /> offline
          </span>
        </div>
      )}

      {hover && !editing && <DiskTooltip hover={hover} width={width} height={height} sysColor={sysColor} />}

      {editing && (
        <ChangeModal
          initial={editing.initial}
          existing={editing.existing}
          disks={disks}
          naming={cfg.naming}
          models={Object.keys(cfg.capacity.models)}
          storageGroups={[...new Set(disks.map((d) => d.storgrp).filter((x): x is string => !!x))].sort()}
          systems={systems}
          onSave={save}
          onCancelChange={editable ? (c) => save([c]) : undefined}
          onSavePattern={editable ? savePattern : undefined}
          onAlertRule={
            alertSettings && editing.existing && !editing.existing.ghost
              ? () => {
                  const d = editing.existing!;
                  setEditing(null);
                  setAlertsOpen({ devnums: d.hex, systems: [] });
                }
              : undefined
          }
          onDismiss={() => setEditing(null)}
        />
      )}
      {alertsOpen && alertSettings && (
        <AlertRulesModal
          settings={alertSettings}
          disks={disks}
          storageGroups={[...new Set(disks.filter((d) => !d.ghost).map((d) => d.storgrp).filter((x): x is string => !!x))].sort()}
          systems={systems}
          editable={canEdit()}
          defaultReceiver={options.alertReceiver ?? ''}
          initial={alertsOpen === true ? undefined : alertsOpen}
          onChanged={() => setAlertsTick((t) => t + 1)}
          onDismiss={() => setAlertsOpen(null)}
        />
      )}
      {listOpen && (
        <ChangesListModal
          changes={pending}
          editable={editable}
          onOpen={(c) => {
            setListOpen(false);
            setEditing({ initial: c, existing: disks.find((d) => d.hex === c.devnum) });
          }}
          onDismiss={() => setListOpen(false)}
        />
      )}
    </div>
  );
};

const UsageBar: React.FC<{ value: number; color?: string; styles: ReturnType<typeof getStyles> }> = ({
  value,
  color,
  styles,
}) => (
  <span className={styles.bar}>
    <span className={styles.fill} style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
  </span>
);

const SystemsCell: React.FC<{ row: DiskRow; color: (s: string) => string }> = ({ row, color }) => {
  const styles = useStyles2(getStyles);
  return (
    <div
      className={cx(styles.rowHead, styles.stickySys, styles.systems)}
      title={row.systems.map((s) => `${s.name}: ${s.count}/${row.diskCount} dysków`).join('\n')}
    >
      {row.systems.length === 0
        ? '—'
        : row.systems.map((s) => (
            <span key={s.name} className={cx(styles.sysChip, s.count < row.diskCount && styles.sysPartial)}>
              <span className={styles.sysDot} style={{ background: color(s.name) }} />
              {s.name}
              {s.count < row.diskCount && <span className={styles.sysCount}>{s.count}</span>}
            </span>
          ))}
    </div>
  );
};

const DiskTooltip: React.FC<{ hover: Hover; width: number; height: number; sysColor: (s: string) => string }> = ({
  hover,
  width,
  height,
  sysColor,
}) => {
  const styles = useStyles2(getTooltipStyles);
  const theme = useTheme2();
  const { disk, x, y } = hover;
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => setH(ref.current?.offsetHeight ?? 0), [disk]);
  // Poziomo po stronie z większą ilością miejsca, pionowo przy kursorze, ale w granicach panelu
  const top = Math.max(0, Math.min(y < height / 2 ? y + 16 : y - h - 16, height - h));
  const style: React.CSSProperties = {
    left: x < width / 2 ? x + 16 : undefined,
    right: x >= width / 2 ? width - x + 16 : undefined,
    top,
    visibility: h ? 'visible' : 'hidden',
  };
  const ch = disk.change;
  return (
    <div ref={ref} className={styles.tooltip} style={style}>
      <div className={styles.title}>
        <strong>{disk.label}</strong>
        <span className={styles.addr}>{disk.hex}</span>
      </div>
      {disk.systems.length > 0 && (
        <div className={styles.systems}>
          {disk.systems.map((s) => (
            <span key={s} className={styles.sys}>
              <span className={styles.dot} style={{ background: sysColor(s) }} />
              {s}
            </span>
          ))}
        </div>
      )}
      {disk.eav && (
        <div className={styles.eav}>
          Σ {disk.usage ?? '?'}% · TMS {disk.eav.trk}% · CMS {disk.eav.cyl}%
        </div>
      )}
      {disk.issues.map((i, n) => (
        <div key={n} className={styles.issue} style={{ color: i.level === 'error' ? theme.colors.error.text : theme.colors.warning.text }}>
          <Icon name={i.level === 'error' ? 'exclamation-circle' : 'exclamation-triangle'} size="sm" /> {i.message}
        </div>
      ))}
      {ch && (
        <div className={styles.change}>
          <div>
            <Icon name="clock-nine" size="sm" /> <strong>Niepotwierdzone:</strong> {TYPE_LABEL[ch.type] ?? ch.type}
            {ch.volser && ` · ${ch.volser}`}
            {ch.storgrp && ` · SG ${ch.storgrp}`}
            {ch.model && ` · ${ch.model}`}
          </div>
          <div className={styles.muted}>
            {ch.user} · {dateTimeFormat(ch.createdAt, { format: 'YYYY-MM-DD HH:mm' })}
            {ch.systems && ` · ${ch.systems}`}
          </div>
          {ch.comment && <div className={styles.muted}>{ch.comment}</div>}
          <div className={styles.muted}>Potwierdzi go następny wsad DCOLLECT.</div>
        </div>
      )}
      {disk.details.length > 0 && (
        <table className={styles.table}>
          <tbody>
            {disk.details.map((d) => (
              <tr key={d.name}>
                <td className={styles.key}>{d.name}</td>
                <td>{d.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

function summarize(values: Array<string | undefined>): string {
  const counts = new Map<string, number>();
  values.forEach((v) => v && counts.set(v, (counts.get(v) ?? 0) + 1));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}×${n}`)
    .join(' · ');
}

/** Legenda pojemności: modele obecne w danych, a gdy brak modeli - przedziały GB */
function legendCapacity(cfg: ReturnType<typeof parseConfig>['config'], disks: Disk[]): Array<[string, string]> {
  const present = new Set(disks.map((d) => d.model));
  const models = Object.entries(cfg.capacity.models).filter(([m]) => present.has(m));
  if (models.length) {
    return models;
  }
  return cfg.capacity.ranges.map((r) => [r.label ?? `≤ ${r.maxGB} GB`, r.color]);
}

const getStyles = (theme: GrafanaTheme2, o?: DiskMapOptions) => {
  const stickyBg = theme.colors.background.secondary;
  const cellMin = o?.cellMinWidth ?? 64;
  const cellH = o?.cellHeight ?? 40;
  return {
    root: css({
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(1),
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    empty: css({
      display: 'flex',
      gap: theme.spacing(1),
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: theme.colors.text.secondary,
    }),
    toolbar: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing(1),
    }),
    summary: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: theme.spacing(2),
      color: theme.colors.text.secondary,
      strong: { color: theme.colors.text.primary, fontWeight: theme.typography.fontWeightMedium },
    }),
    cfgError: css({ color: theme.colors.error.text }),
    actions: css({ display: 'flex', gap: theme.spacing(1), alignItems: 'center', marginLeft: 'auto' }),
    scroll: css({
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.primary,
    }),
    grid: css({
      display: 'grid',
      // Shift+klik (zaznaczanie zakresu) nie zaznacza tekstu
      userSelect: 'none',
      gridTemplateColumns: `${ADDR_W}px ${MODEL_W}px repeat(16, minmax(${cellMin}px, 1fr)) ${SYS_W}px`,
      gap: GAP,
      padding: GAP,
      minWidth: ADDR_W + MODEL_W + SYS_W + 16 * cellMin + 20 * GAP,
    }),
    header: css({
      position: 'sticky',
      top: 0,
      zIndex: 3,
      padding: theme.spacing(0.75, 0.5),
      textAlign: 'center',
      background: stickyBg,
      color: theme.colors.text.secondary,
      fontWeight: theme.typography.fontWeightMedium,
      borderRadius: theme.shape.radius.default,
      boxShadow: `0 ${-GAP}px 0 ${GAP}px ${theme.colors.background.primary}`,
    }),
    stickyAddr: css({ position: 'sticky', left: 0, zIndex: 2 }),
    stickyModel: css({ position: 'sticky', left: ADDR_W + GAP, zIndex: 2 }),
    stickySys: css({ position: 'sticky', right: 0, zIndex: 2 }),
    rowHead: css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: stickyBg,
      color: theme.colors.text.primary,
      fontWeight: theme.typography.fontWeightMedium,
      borderRadius: theme.shape.radius.default,
      boxShadow: `0 0 0 ${GAP}px ${theme.colors.background.primary}`,
    }),
    mono: css({ fontFamily: theme.typography.fontFamilyMonospace }),
    systems: css({
      flexWrap: 'wrap',
      gap: theme.spacing(0.5),
      padding: theme.spacing(0.25, 0.5),
      fontWeight: theme.typography.fontWeightRegular,
    }),
    sysChip: css({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '0 6px',
      borderRadius: theme.shape.radius.pill,
      border: `1px solid ${theme.colors.border.medium}`,
      background: theme.colors.background.primary,
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: 11,
      lineHeight: '18px',
    }),
    sysPartial: css({ borderStyle: 'dashed', color: theme.colors.text.secondary }),
    sysDot: css({ width: 7, height: 7, borderRadius: '50%' }),
    sysCount: css({ color: theme.colors.text.secondary }),
    gap: css({
      gridColumn: '1 / -1',
      textAlign: 'center',
      padding: theme.spacing(0.25),
      color: theme.colors.text.disabled,
      fontFamily: theme.typography.fontFamilyMonospace,
      span: { position: 'sticky', left: theme.spacing(2) },
    }),
    disk: css({
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      justifyContent: 'center',
      gap: 3,
      minHeight: cellH,
      padding: theme.spacing(0.25, 0.75),
      border: '1px solid',
      borderRadius: theme.shape.radius.default,
      overflow: 'hidden',
      cursor: 'default',
      lineHeight: 1.2,
      transition: theme.transitions.create(['opacity', 'box-shadow'], { duration: 100 }),
      '&:hover': {
        boxShadow: `0 0 0 2px ${theme.colors.primary.border}`,
        zIndex: 1,
      },
    }),
    clickable: css({ cursor: 'pointer' }),
    label: css({
      textAlign: 'center',
      fontFamily: theme.typography.fontFamilyMonospace,
      fontWeight: theme.typography.fontWeightMedium,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }),
    strike: css({ textDecoration: 'line-through' }),
    usage: css({ display: 'flex', alignItems: 'center', gap: 4 }),
    // EAV: pasek podzielony TMS|CMS - dwa segmenty z przerwą
    split: css({ display: 'flex', gap: 2, '& > span': { display: 'flex', minWidth: 0 } }),
    bar: css({
      flex: 1,
      height: 4,
      borderRadius: 2,
      overflow: 'hidden',
      // ciemne tło + obwódka: zielony/pomarańczowy pasek widoczny także na kafelku w tym samym kolorze
      background: 'rgba(0, 0, 0, 0.35)',
      boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 35%, transparent)',
    }),
    fill: css({ display: 'block', height: '100%', borderRadius: 2 }),
    pct: css({ fontSize: 10, lineHeight: 1, opacity: 0.85, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }),
    corner: css({
      position: 'absolute',
      top: 0,
      right: 0,
      width: 0,
      height: 0,
      borderTop: '11px solid',
      borderLeft: '11px solid transparent',
    }),
    pendingIcon: css({ position: 'absolute', top: 1, left: 2, lineHeight: 1 }),
    ghost: css({
      border: '1px dashed var(--pending)',
      background: `repeating-linear-gradient(135deg, color-mix(in srgb, var(--pending) 18%, transparent) 0 6px, transparent 6px 12px)`,
      fontStyle: 'italic',
    }),
    changed: css({ outline: '2px dashed var(--pending)', outlineOffset: -2 }),
    dim: css({
      backgroundImage: `repeating-linear-gradient(135deg, transparent 0 5px, ${colorManipulator.alpha(
        theme.colors.text.primary,
        0.18
      )} 5px 10px)`,
      opacity: 0.55,
    }),
    free: css({
      minHeight: cellH,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: `1px dashed ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
    }),
    freeEditable: css({
      cursor: 'pointer',
      '&:hover': { borderColor: theme.colors.primary.border, svg: { opacity: 1 } },
    }),
    freePlus: css({ opacity: 0, color: theme.colors.text.secondary }),
    freeSelected: css({
      borderStyle: 'solid',
      borderColor: theme.colors.primary.border,
      background: colorManipulator.alpha(theme.colors.primary.main, 0.18),
    }),
    freeCheck: css({ color: theme.colors.primary.text }),
    selInfo: css({ color: theme.colors.text.secondary, strong: { color: theme.colors.text.primary } }),
    faded: css({ opacity: 0.2 }),
    match: css({ boxShadow: `0 0 0 2px ${theme.colors.primary.main}` }),
    legend: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.spacing(1.5),
      color: theme.colors.text.secondary,
    }),
    legendSep: css({ width: 1, height: 14, background: theme.colors.border.medium }),
    legendItem: css({ display: 'inline-flex', alignItems: 'center', gap: theme.spacing(0.5) }),
    swatch: css({
      display: 'inline-block',
      width: 14,
      height: 12,
      borderRadius: theme.shape.radius.default,
      border: `1px solid ${theme.colors.border.medium}`,
    }),
    barSwatch: css({ display: 'inline-block', width: 16, height: 4, borderRadius: 2 }),
    cornerSwatch: css({
      display: 'inline-block',
      width: 0,
      height: 0,
      borderTop: '10px solid',
      borderLeft: '10px solid transparent',
    }),
    ghostSwatch: css({
      border: '1px dashed var(--pending)',
      background: `repeating-linear-gradient(135deg, color-mix(in srgb, var(--pending) 35%, transparent) 0 3px, transparent 3px 6px)`,
    }),
  };
};

const getTooltipStyles = (theme: GrafanaTheme2) => ({
  tooltip: css({
    position: 'absolute',
    zIndex: theme.zIndex.tooltip,
    pointerEvents: 'none',
    maxWidth: 420,
    maxHeight: '100%',
    overflow: 'hidden',
    padding: theme.spacing(1),
    background: theme.components.tooltip.background,
    color: theme.components.tooltip.text,
    borderRadius: theme.shape.radius.default,
    boxShadow: theme.shadows.z3,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  title: css({
    display: 'flex',
    justifyContent: 'space-between',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(0.5),
    paddingBottom: theme.spacing(0.5),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    fontFamily: theme.typography.fontFamilyMonospace,
  }),
  addr: css({ color: theme.colors.text.secondary }),
  systems: css({ display: 'flex', gap: theme.spacing(1), marginBottom: theme.spacing(0.5) }),
  sys: css({ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: theme.typography.fontFamilyMonospace }),
  dot: css({ width: 7, height: 7, borderRadius: '50%' }),
  issue: css({ marginBottom: 2 }),
  eav: css({ marginBottom: theme.spacing(0.5), fontVariantNumeric: 'tabular-nums' }),
  change: css({
    margin: theme.spacing(0.5, 0),
    padding: theme.spacing(0.5),
    borderLeft: `3px solid ${theme.colors.warning.main}`,
    background: colorManipulator.alpha(theme.colors.warning.main, 0.1),
  }),
  muted: css({ color: theme.colors.text.secondary }),
  table: css({
    marginTop: theme.spacing(0.5),
    borderCollapse: 'collapse',
    td: { padding: '1px 0', verticalAlign: 'top' },
  }),
  key: css({ color: theme.colors.text.secondary, paddingRight: `${theme.spacing(2)} !important` }),
});
