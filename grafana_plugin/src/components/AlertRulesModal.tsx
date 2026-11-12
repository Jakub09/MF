import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  InlineSwitch,
  LinkButton,
  Modal,
  MultiSelect,
  RadioButtonGroup,
  Select,
  Spinner,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import {
  AlertSettings,
  DasdRuleSpec,
  deleteRule,
  describe,
  emptySpec,
  listReceivers,
  listRules,
  METRICS,
  ruleStates,
  saveRule,
  scopeText,
} from '../alerts';
import { parseDevnums } from '../naming';
import { Disk } from '../types';

interface Props {
  settings: AlertSettings;
  disks: Disk[];
  storageGroups: string[];
  systems: string[];
  editable: boolean;
  defaultReceiver: string;
  /** Otwórz od razu formularz nowej reguły (np. dla klikniętego dysku) */
  initial?: Partial<DasdRuleSpec>;
  onChanged: () => void;
  onDismiss: () => void;
}

const METRIC_OPTIONS: Array<SelectableValue<string>> = Object.entries(METRICS).map(([value, m]) => ({
  value,
  label: m.label,
  description: m.flag ? 'warunek tak/nie' : m.unit ? `w ${m.unit}` : undefined,
}));
const OPS = [
  { value: 'gt' as const, label: '>' },
  { value: 'lt' as const, label: '<' },
];
const SEVERITIES = [
  { value: 'critical' as const, label: 'Krytyczny' },
  { value: 'warning' as const, label: 'Ostrzeżenie' },
];
const CONFLICT_LEVELS = [
  { value: 1, label: 'Tylko błędy' },
  { value: 0, label: 'Błędy i ostrzeżenia' },
];

const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));
const splitList = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

/** Wartość metryki dysku z danych panelu (do podglądu) */
function metricValue(d: Disk, metric: string): number | undefined {
  const m = METRICS[metric];
  const raw = d.values[m.field];
  const n = typeof raw === 'number' ? raw : raw !== undefined ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return m.unit === 'GiB' ? n / 1048576 : n;
}

function inScope(d: Disk, spec: DasdRuleSpec, devnums: Set<number>, volRe?: RegExp): boolean {
  return (
    (!spec.storgrps.length || spec.storgrps.includes(d.storgrp ?? '')) &&
    (!spec.systems.length || d.systems.some((s) => spec.systems.includes(s))) &&
    (!devnums.size || devnums.has(d.addr)) &&
    (!volRe || volRe.test(d.label))
  );
}

export const AlertRulesModal: React.FC<Props> = ({
  settings,
  disks,
  storageGroups,
  systems,
  editable,
  defaultReceiver,
  initial,
  onChanged,
  onDismiss,
}) => {
  const styles = useStyles2(getStyles);
  const [rules, setRules] = useState<DasdRuleSpec[]>();
  const [states, setStates] = useState<Awaited<ReturnType<typeof ruleStates>>['rules']>(new Map());
  const [receivers, setReceivers] = useState<string[]>([]);
  const [editing, setEditing] = useState<DasdRuleSpec | null>(initial ? emptySpec({ receiver: defaultReceiver, ...initial }) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const [r, st] = await Promise.all([listRules(settings), ruleStates(settings).catch(() => ({ rules: new Map() }))]);
      setRules(r);
      setStates(st.rules);
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
      setRules([]);
    }
  }, [settings]);

  useEffect(() => {
    reload();
    listReceivers().then(setReceivers);
  }, [reload]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await reload();
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = (spec: DasdRuleSpec) => {
    if (spec.uid && window.confirm(`Usunąć regułę "${spec.title}"?`)) {
      run(() => deleteRule(settings, spec.uid!));
    }
  };

  return (
    <Modal
      title={editing ? (editing.uid ? `Reguła alertu: ${editing.title}` : 'Nowa reguła alertu') : 'Reguły alertów dysków'}
      isOpen
      onDismiss={onDismiss}
      className={styles.modal}
    >
      {error && (
        <Alert severity="error" title="Grafana Alerting">
          {error}
        </Alert>
      )}
      {editing ? (
        <RuleForm
          spec={editing}
          disks={disks}
          storageGroups={storageGroups}
          systems={systems}
          receivers={receivers}
          editable={editable}
          busy={busy}
          onCancel={() => (initial && !rules?.length ? onDismiss() : setEditing(null))}
          onDelete={editing.uid && editable ? () => remove(editing) : undefined}
          onSave={async (spec) => {
            if (await run(() => saveRule(settings, spec))) {
              setEditing(null);
            }
          }}
        />
      ) : (
        <>
          <p className={styles.muted}>
            Reguły Grafana Alerting w folderze <strong>{settings.folderTitle}</strong>, grupa <strong>{settings.group}</strong>{' '}
            (sprawdzane co {settings.interval}). Alert powstaje osobno dla każdego dysku w każdym systemie; powiadomienia
            wysyła wybrany punkt kontaktowy.
          </p>
          {!rules ? (
            <Spinner />
          ) : rules.length === 0 ? (
            <p>Brak reguł.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Nazwa</th>
                  <th>Warunek</th>
                  <th>Zakres</th>
                  <th>Stan</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const st = r.uid ? states.get(r.uid) : undefined;
                  const firing = st?.alerts?.filter((a) => /^alerting/i.test(a.state)).length ?? 0;
                  return (
                    <tr key={r.uid}>
                      <td>
                        <div className={styles.title}>{r.title}</div>
                        <span className={styles.muted}>
                          {r.severity === 'critical' ? 'krytyczny' : 'ostrzeżenie'} · {r.receiver || 'polityka powiadomień'}
                        </span>
                      </td>
                      <td>{describe(r)}</td>
                      <td className={styles.muted}>{scopeText(r)}</td>
                      <td>
                        {r.paused ? (
                          <Badge color="blue" text="wstrzymana" />
                        ) : st?.health === 'error' ? (
                          <Badge color="red" icon="exclamation-triangle" text="błąd" tooltip={st.lastError} />
                        ) : firing > 0 ? (
                          <Badge color={r.severity === 'critical' ? 'red' : 'orange'} icon="fire" text={`${firing} dysk.`} />
                        ) : st && !st.lastEvaluation?.startsWith('0001') ? (
                          <Badge color="green" text="OK" />
                        ) : (
                          <Badge color="darkgrey" text="oczekuje" />
                        )}
                      </td>
                      <td className={styles.actions}>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={editable ? 'pen' : 'eye'}
                          aria-label={editable ? 'Edytuj' : 'Pokaż'}
                          tooltip={editable ? 'Edytuj' : 'Pokaż'}
                          onClick={() => setEditing(r)}
                        />
                        {r.uid && (
                          <LinkButton
                            size="sm"
                            variant="secondary"
                            fill="text"
                            icon="external-link-alt"
                            tooltip="Otwórz w Grafana Alerting"
                            href={`/alerting/grafana/${r.uid}/view`}
                            target="_blank"
                          />
                        )}
                        {editable && (
                          <Button
                            size="sm"
                            variant="destructive"
                            fill="text"
                            icon="trash-alt"
                            aria-label="Usuń"
                            tooltip="Usuń"
                            disabled={busy}
                            onClick={() => remove(r)}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <Modal.ButtonRow>
            <Button variant="secondary" onClick={onDismiss}>
              Zamknij
            </Button>
            {editable && (
              <Button icon="plus" onClick={() => setEditing(emptySpec({ receiver: defaultReceiver }))}>
                Nowa reguła
              </Button>
            )}
          </Modal.ButtonRow>
        </>
      )}
    </Modal>
  );
};

interface FormProps {
  spec: DasdRuleSpec;
  disks: Disk[];
  storageGroups: string[];
  systems: string[];
  receivers: string[];
  editable: boolean;
  busy: boolean;
  onSave: (spec: DasdRuleSpec) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

const RuleForm: React.FC<FormProps> = ({ spec: initial, disks, storageGroups, systems, receivers, editable, busy, onSave, onCancel, onDelete }) => {
  const styles = useStyles2(getStyles);
  const [spec, setSpec] = useState(initial);
  const [volText, setVolText] = useState(initial.volsers.join(', '));
  const set = (patch: Partial<DasdRuleSpec>) => setSpec((p) => ({ ...p, ...patch }));
  const m = METRICS[spec.metric];
  const { devnums, error: devnumError } = useMemo(() => parseDevnums(spec.devnums, 65536), [spec.devnums]);
  const volsers = splitList(volText);
  const autoTitle = `${describe(spec)} · ${scopeText({ ...spec, volsers })}`;

  // Podgląd na danych panelu: ile dysków w zakresie spełnia teraz warunek
  const preview = useMemo(() => {
    const devSet = new Set(devnums);
    const volRe = volsers.length
      ? new RegExp(`^(${volsers.map((v) => v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|')})$`)
      : undefined;
    const scoped = disks.filter((d) => !d.ghost && inScope(d, { ...spec, volsers }, devSet, volRe));
    const withValue = scoped.filter((d) => metricValue(d, spec.metric) !== undefined);
    const threshold = m.flag ? (spec.metric === 'conflict' ? (spec.value >= 1 ? 1 : 0) : 0) : spec.value;
    const op = m.flag ? 'gt' : spec.op;
    const hits = withValue.filter((d) => {
      const v = metricValue(d, spec.metric)!;
      return op === 'gt' ? v > threshold : v < threshold;
    });
    return { scoped: scoped.length, withValue: withValue.length, hits };
  }, [disks, spec, devnums, volsers, m]);

  const problems: string[] = [];
  if (devnumError) {
    problems.push(devnumError);
  }
  if (!m.flag && !Number.isFinite(spec.value)) {
    problems.push('Podaj próg');
  }

  const changeMetric = (metric: string) => {
    const def = METRICS[metric];
    set({ metric, op: def.defaultOp, value: def.defaultValue });
  };

  return (
    <div>
      <Field label="Nazwa" description="Puste = opis warunku i zakresu">
        <Input value={spec.title} placeholder={autoTitle} onChange={(e) => set({ title: e.currentTarget.value })} disabled={!editable} />
      </Field>
      <div className={styles.row}>
        <Field label="Metryka" className={styles.grow}>
          <Select options={METRIC_OPTIONS} value={spec.metric} onChange={(v) => changeMetric(v.value!)} disabled={!editable} />
        </Field>
        {!m.flag && (
          <Field label="Warunek">
            <div className={styles.cond}>
              <RadioButtonGroup options={OPS} value={spec.op} onChange={(op) => set({ op })} disabled={!editable} />
              <Input
                width={12}
                type="number"
                value={Number.isFinite(spec.value) ? spec.value : ''}
                onChange={(e) => set({ value: parseFloat(e.currentTarget.value) })}
                suffix={m.unit || undefined}
                disabled={!editable}
              />
            </div>
          </Field>
        )}
        {spec.metric === 'conflict' && (
          <Field label="Konflikty">
            <RadioButtonGroup options={CONFLICT_LEVELS} value={spec.value >= 1 ? 1 : 0} onChange={(value) => set({ value })} disabled={!editable} />
          </Field>
        )}
        {m.flag && spec.metric !== 'conflict' && (
          <Field label="Warunek">
            <span className={styles.flagText}>gdy w co najmniej jednym systemie</span>
          </Field>
        )}
      </div>

      <div className={styles.section}>Zakres (puste = wszystkie)</div>
      <div className={styles.grid2}>
        <Field label="Storage group">
          <MultiSelect
            options={opts([...new Set([...storageGroups, ...spec.storgrps])])}
            value={spec.storgrps}
            allowCustomValue
            onChange={(v) => set({ storgrps: v.map((x) => x.value!) })}
            disabled={!editable}
          />
        </Field>
        <Field label="Systemy">
          <MultiSelect
            options={opts([...new Set([...systems, ...spec.systems])])}
            value={spec.systems}
            allowCustomValue
            onChange={(v) => set({ systems: v.map((x) => x.value!) })}
            disabled={!editable}
          />
        </Field>
        <Field label="Adresy" description="np. 9100-910F, 8080" invalid={!!devnumError}>
          <Input value={spec.devnums} onChange={(e) => set({ devnums: e.currentTarget.value.toUpperCase() })} disabled={!editable} />
        </Field>
        <Field label="VOLSER" description="lista, * = dowolne znaki (PR0*)">
          <Input value={volText} onChange={(e) => setVolText(e.currentTarget.value.toUpperCase())} disabled={!editable} />
        </Field>
      </div>

      <div className={styles.preview}>
        {preview.withValue < preview.scoped && preview.withValue === 0 ? (
          <span>Brak pola „{m.field}” w danych panelu - podgląd niedostępny (reguła i tak działa na danych z InfluxDB).</span>
        ) : (
          <span>
            Teraz spełnia warunek: <strong className={cx(preview.hits.length > 0 && styles.hit)}>{preview.hits.length}</strong> z{' '}
            {preview.scoped} dysków w zakresie
            {preview.hits.length > 0 && (
              <span className={styles.muted}>
                {' '}
                ({preview.hits.slice(0, 12).map((d) => d.label).join(', ')}
                {preview.hits.length > 12 ? ', …' : ''})
              </span>
            )}
          </span>
        )}
      </div>

      <div className={styles.grid2}>
        <Field label="Ważność">
          <RadioButtonGroup options={SEVERITIES} value={spec.severity} onChange={(severity) => set({ severity })} disabled={!editable} />
        </Field>
        <Field label="Punkt kontaktowy" description="Puste = wg polityki powiadomień Grafany">
          <Select
            options={[{ value: '', label: 'Polityka powiadomień' }, ...opts(receivers)]}
            value={spec.receiver}
            onChange={(v) => set({ receiver: v.value ?? '' })}
            disabled={!editable}
          />
        </Field>
      </div>
      <Field label="Opis (w powiadomieniu)">
        <TextArea rows={2} value={spec.description} onChange={(e) => set({ description: e.currentTarget.value })} disabled={!editable} />
      </Field>
      <InlineSwitch
        label="Wstrzymana"
        showLabel
        value={spec.paused}
        onChange={(e) => set({ paused: e.currentTarget.checked })}
        disabled={!editable}
      />
      {problems.length > 0 && <div className={styles.problems}>{problems.join(' · ')}</div>}

      <Modal.ButtonRow>
        {onDelete && (
          <Button variant="destructive" fill="outline" icon="trash-alt" disabled={busy} onClick={onDelete}>
            Usuń
          </Button>
        )}
        <Button variant="secondary" fill="outline" onClick={onCancel}>
          {editable ? 'Anuluj' : 'Wróć'}
        </Button>
        {editable && (
          <Button
            icon={busy ? 'spinner' : 'save'}
            disabled={busy || problems.length > 0}
            onClick={() => onSave({ ...spec, volsers, title: spec.title.trim() || autoTitle })}
          >
            Zapisz regułę
          </Button>
        )}
      </Modal.ButtonRow>
    </div>
  );
};

function errorText(e: unknown): string {
  const err = e as { data?: { message?: string; error?: string }; message?: string; status?: number; statusText?: string };
  const msg = err?.data?.message ?? err?.data?.error ?? err?.message ?? err?.statusText ?? String(e);
  return err?.status === 403 ? `Brak uprawnień do reguł alertów (${msg})` : msg;
}

const getStyles = (theme: GrafanaTheme2) => ({
  modal: css({ width: 900, maxWidth: '95vw' }),
  muted: css({ color: theme.colors.text.secondary }),
  title: css({ fontWeight: theme.typography.fontWeightMedium }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.75, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
      verticalAlign: 'top',
    },
    th: { color: theme.colors.text.secondary, fontWeight: theme.typography.fontWeightMedium },
  }),
  actions: css({ whiteSpace: 'nowrap', textAlign: 'right !important' as 'right' }),
  row: css({ display: 'flex', gap: theme.spacing(2), alignItems: 'flex-start', flexWrap: 'wrap' }),
  grow: css({ flex: 1, minWidth: 240 }),
  cond: css({ display: 'flex', gap: theme.spacing(1) }),
  flagText: css({ display: 'inline-block', paddingTop: theme.spacing(1), color: theme.colors.text.secondary }),
  section: css({
    margin: theme.spacing(1, 0),
    color: theme.colors.text.secondary,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  grid2: css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.spacing(0, 2) }),
  preview: css({
    marginBottom: theme.spacing(2),
    padding: theme.spacing(1, 1.5),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  hit: css({ color: theme.colors.error.text }),
  problems: css({ color: theme.colors.warning.text, fontSize: theme.typography.bodySmall.fontSize, marginTop: theme.spacing(1) }),
});
