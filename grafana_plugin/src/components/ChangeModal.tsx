import React, { useEffect, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import {
  Alert,
  Button,
  Field,
  Input,
  Modal,
  MultiSelect,
  RadioButtonGroup,
  Select,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import { Change, ChangeType, Disk } from '../types';
import { currentUser } from '../changes';
import { hex4 } from '../data';
import {
  detectPattern,
  formatNumber,
  NamingConfig,
  NamingPattern,
  NamingSettings,
  nextNumber,
  parseDevnums,
  parseFrom,
  patternOverrides,
  propose,
  settingsFor,
} from '../naming';

const TYPES: Array<SelectableValue<ChangeType>> = [
  { value: 'add', label: 'Nowy dysk (INIT + SG)' },
  { value: 'modify', label: 'Zmiana VOLSER / SG' },
  { value: 'remove', label: 'Wycofanie' },
];
const NUMBER_TYPES = [
  { value: 'x' as const, label: 'hex' },
  { value: 'd' as const, label: 'dec' },
];
const MODES = [
  { value: 'next' as const, label: 'Kolejne numery' },
  { value: 'devnum' as const, label: 'Z adresu' },
];

const VOLSER_RE = /^[A-Z0-9#$@]{1,6}$/;

interface Props {
  /** Edytowana zmiana albo szkic nowej; devnum może być listą / zakresem ("9106-910F") */
  initial: Partial<Change> & { devnum: string };
  existing?: Disk;
  /** Wszystkie dyski (z niepotwierdzonymi) - wykrywanie wzorców i kontrola konfliktów */
  disks: Disk[];
  naming: NamingConfig;
  models: string[];
  storageGroups: string[];
  systems: string[];
  onSave: (changes: Change[]) => Promise<void>;
  onCancelChange?: (c: Change) => Promise<void>;
  /** Zapamiętanie wzorca w konfiguracji panelu */
  onSavePattern?: (sg: string, s: NamingSettings) => void;
  /** Otwórz formularz reguły alertu dla tego dysku */
  onAlertRule?: () => void;
  onDismiss: () => void;
}

const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));

export const ChangeModal: React.FC<Props> = ({
  initial,
  existing,
  disks,
  naming,
  models,
  storageGroups,
  systems,
  onSave,
  onCancelChange,
  onSavePattern,
  onAlertRule,
  onDismiss,
}) => {
  const styles = useStyles2(getStyles);
  const [c, setC] = useState<Partial<Change> & { devnum: string }>({
    type: existing && !existing.ghost ? 'modify' : 'add',
    systems: existing?.systems.join(',') ?? '',
    ...initial,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [volserTouched, setVolserTouched] = useState(!!initial.volser);
  const [pattern, setPattern] = useState<NamingPattern>();
  const [patternSource, setPatternSource] = useState('');
  const [fromText, setFromText] = useState('');
  const [patternSaved, setPatternSaved] = useState(false);
  const [minPrefix, setMinPrefix] = useState(naming.minPrefix ?? 3);
  const set = (patch: Partial<Change>) => setC((prev) => ({ ...prev, ...patch }));

  const isPending = initial.status === 'pending';
  const type = c.type ?? 'add';
  const storgrp = (c.storgrp ?? '').trim().toUpperCase();
  const { devnums, error: devnumError } = useMemo(() => parseDevnums(c.devnum), [c.devnum]);
  const multi = devnums.length > 1;

  const used = useMemo(
    () =>
      new Set(
        disks
          .filter((d) => !initial.devnum.toUpperCase().includes(d.hex))
          .flatMap((d) => [d.label, d.change?.volser ?? ''])
          .filter(Boolean)
          .map((v) => v.toUpperCase())
      ),
    [disks, initial.devnum]
  );
  const sgVolumes = useMemo(
    () =>
      disks
        .filter((d) => (d.change?.storgrp || d.storgrp || '').toUpperCase() === storgrp)
        .map((d) => ({ volser: d.ghost ? d.change?.volser ?? '' : d.label, addr: d.addr })),
    [disks, storgrp]
  );

  // Ustawienia SG (globalne + naming.groups.<SG>): min. prefiks wraca do wartości z konfiguracji przy zmianie SG
  const settings = useMemo(() => settingsFor(naming, storgrp), [naming, storgrp]);
  useEffect(() => setMinPrefix(settings.minPrefix ?? 3), [settings]);

  // Wzorzec: wykryty z wolumenów SG (wg min. prefiksu), pola wzorca z konfiguracji mają pierwszeństwo
  useEffect(() => {
    if (type !== 'add' || !storgrp) {
      setPattern(undefined);
      return;
    }
    const detected = detectPattern(sgVolumes, minPrefix);
    const overrides = patternOverrides(settings);
    const base: NamingPattern = detected.pattern ?? { prefix: '', suffix: '', type: 'x', width: 2, mode: 'next' };
    const p = { ...base, ...overrides };
    const fromGroup = !!naming.groups?.[storgrp];
    setPattern(p);
    setPatternSaved(false);
    setPatternSource(
      [
        Object.keys(overrides).length
          ? `z konfiguracji (${fromGroup ? `naming.groups.${storgrp}` : 'naming'})`
          : detected.pattern
            ? `wykryty z ${detected.basis} z ${sgVolumes.length} wolumenów ${storgrp}`
            : sgVolumes.length
              ? `nie udało się wykryć z ${sgVolumes.length} wolumenów - ustaw ręcznie`
              : `${storgrp} nie ma jeszcze wolumenów - ustaw ręcznie`,
        `min. prefiks ${minPrefix}${minPrefix !== settings.minPrefix ? ' (zmieniony)' : fromGroup && naming.groups[storgrp].minPrefix !== undefined ? ` (${storgrp})` : ' (globalnie)'}`,
      ].join(' · ')
    );
    setFromText(formatNumber(p, nextNumber(p, sgVolumes.map((v) => v.volser))) ?? '');
  }, [type, storgrp, sgVolumes, naming, settings, minPrefix]);

  const setP = (patch: Partial<NamingPattern>) => {
    if (!pattern) {
      return;
    }
    const p = { ...pattern, ...patch };
    setPattern(p);
    setPatternSaved(false);
    // zmiana wzorca -> nowy proponowany początek
    if (patch.prefix !== undefined || patch.suffix !== undefined || patch.type !== undefined || patch.width !== undefined) {
      setFromText(formatNumber(p, nextNumber(p, sgVolumes.map((v) => v.volser))) ?? '');
    }
  };

  const from = pattern ? parseFrom(pattern, fromText) : undefined;
  const proposals = useMemo(
    () => (type === 'add' && pattern && (from !== undefined || pattern.mode === 'devnum') ? propose(pattern, devnums, from ?? 0, used) : []),
    [type, pattern, devnums, from, used]
  );

  // Pojedynczy dysk: propozycja trafia do pola VOLSER, dopóki użytkownik go nie zmieni
  const volser = (type === 'add' && !multi && !volserTouched ? proposals[0]?.volser ?? '' : c.volser ?? '').trim().toUpperCase();

  const occupied = devnums
    .map((a) => disks.find((d) => d.addr === a && !d.ghost))
    .filter((d): d is Disk => !!d);

  const problems: string[] = [];
  if (devnumError) {
    problems.push(devnumError);
  } else if (!devnums.length) {
    problems.push('Podaj DEVNUM (np. 9106 albo 9106-910F)');
  }
  if (multi && type !== 'add') {
    problems.push('Wiele adresów naraz tylko dla nowych dysków');
  }
  if (type === 'add' && !storgrp) {
    problems.push('Podaj storage group');
  }
  if (type === 'add' && multi) {
    if (occupied.length) {
      problems.push(`Zajęte adresy: ${occupied.map((d) => `${d.hex} (${d.label})`).join(', ')}`);
    }
    if (!pattern || (pattern.mode === 'next' && from === undefined)) {
      problems.push('Ustaw wzorzec i numer początkowy');
    } else if (proposals.some((p) => p.problem)) {
      problems.push('Popraw konflikty nazw');
    }
  }
  if (type === 'add' && !multi && !VOLSER_RE.test(volser)) {
    problems.push('VOLSER: 1–6 znaków A–Z 0–9 # $ @');
  }
  if (type === 'add' && !multi && used.has(volser)) {
    problems.push(`VOLSER ${volser} już istnieje`);
  }
  if (type === 'modify' && c.volser && !VOLSER_RE.test(volser)) {
    problems.push('VOLSER: 1–6 znaków A–Z 0–9 # $ @');
  }
  if (type === 'modify' && !c.volser && !storgrp) {
    problems.push('Podaj nowy VOLSER lub storage group');
  }

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const now = Date.now();
    const base = {
      type,
      model: type === 'add' ? c.model ?? '' : existing?.model ?? c.model ?? '',
      systems: (c.systems ?? '').toUpperCase(),
      comment: c.comment ?? '',
      user: currentUser(),
      status: 'pending' as const,
      createdAt: isPending && initial.createdAt ? initial.createdAt : now,
      updatedAt: now,
    };
    const changes: Change[] =
      type === 'add' && multi
        ? proposals.map((p) => ({ ...base, devnum: hex4(p.devnum), volser: p.volser ?? '', storgrp }))
        : [
            {
              ...base,
              devnum: hex4(devnums[0]),
              volser: type === 'remove' ? existing?.label ?? volser : volser,
              storgrp: type === 'remove' ? '' : storgrp,
            },
          ];
    try {
      await onSave(changes);
      onDismiss();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const cancelChange = async () => {
    if (!onCancelChange) {
      return;
    }
    setBusy(true);
    try {
      await onCancelChange({ ...(initial as Change), status: 'cancelled', updatedAt: Date.now() });
      onDismiss();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const selectedSystems = (c.systems ?? '').split(',').filter(Boolean);
  const okProposals = proposals.filter((p) => p.volser);
  const title = isPending
    ? `Niepotwierdzona zmiana ${c.devnum}`
    : multi
      ? `Nowe dyski (${devnums.length})`
      : `Nowa zmiana ${c.devnum}`;

  return (
    <Modal title={title} isOpen onDismiss={onDismiss} className={styles.modal}>
      <p className={styles.info}>
        Zmiana będzie widoczna na mapie jako <strong>niepotwierdzona</strong> do czasu wczytania nowego wsadu DCOLLECT,
        który ją potwierdzi.
      </p>
      {existing && !existing.ghost && !multi && (
        <p className={styles.info}>
          Obecnie: <strong>{existing.label}</strong> · {existing.model ?? '?'} · SG {existing.storgrp ?? '—'} ·{' '}
          {existing.systems.join(', ') || 'brak systemu'}
        </p>
      )}

      <Field label="Rodzaj">
        <RadioButtonGroup options={TYPES} value={type} onChange={(t) => set({ type: t })} disabled={multi} />
      </Field>
      <div className={styles.cols}>
        <Field label="DEVNUM" description={multi ? `${devnums.length} adresów` : 'Zakres: 9106-910F, lista po przecinku'}>
          <Input value={c.devnum} onChange={(e) => set({ devnum: e.currentTarget.value.toUpperCase() })} />
        </Field>
        {type !== 'remove' && (
          <Field label={type === 'modify' ? 'Nowa storage group (opcjonalnie)' : 'Storage group'}>
            <Select
              options={opts(storageGroups)}
              value={storgrp || null}
              allowCustomValue
              isClearable
              onChange={(v) => set({ storgrp: v?.value ?? '' })}
            />
          </Field>
        )}
      </div>

      {type === 'add' && pattern && (
        <div className={styles.pattern}>
          <div className={styles.patternHead}>
            <strong>Wzorzec VOLSER</strong>
            <span className={styles.muted}>{patternSource}</span>
          </div>
          <div className={styles.patternRow}>
            <Field label="Min. prefiks" className={styles.compact}>
              <Input
                width={6}
                type="number"
                min={0}
                max={5}
                value={minPrefix}
                onChange={(e) => setMinPrefix(Math.max(0, Math.min(5, Number(e.currentTarget.value) || 0)))}
              />
            </Field>
            <Field label="Prefiks" className={styles.compact}>
              <Input width={10} value={pattern.prefix} onChange={(e) => setP({ prefix: e.currentTarget.value.toUpperCase() })} />
            </Field>
            <Field label="Numer" className={styles.compact}>
              <RadioButtonGroup size="sm" options={NUMBER_TYPES} value={pattern.type} onChange={(t) => setP({ type: t })} />
            </Field>
            <Field label="Cyfr" className={styles.compact}>
              <Input
                width={6}
                type="number"
                min={1}
                max={5}
                value={pattern.width}
                onChange={(e) => setP({ width: Math.max(1, Math.min(5, Number(e.currentTarget.value) || 1)) })}
              />
            </Field>
            <Field label="Sufiks" className={styles.compact}>
              <Input width={8} value={pattern.suffix} onChange={(e) => setP({ suffix: e.currentTarget.value.toUpperCase() })} />
            </Field>
            <Field label="Numeracja" className={styles.compact}>
              <RadioButtonGroup
                size="sm"
                options={MODES}
                value={pattern.mode}
                onChange={(m) => setP({ mode: m, ...(m === 'devnum' ? { type: 'x' as const } : {}) })}
              />
            </Field>
            {pattern.mode === 'next' && (
              <Field label="Od" className={styles.compact} invalid={from === undefined}>
                <Input width={8} value={fromText} onChange={(e) => setFromText(e.currentTarget.value.toUpperCase())} />
              </Field>
            )}
          </div>

          {okProposals.length > 0 && (
            <div className={styles.range}>
              <span className={styles.chip}>prefix({pattern.prefix || '—'})</span>
              <span className={styles.chip}>
                {multi ? 'from' : 'nr'}({formatNumber(pattern, pattern.mode === 'devnum' ? okProposals[0].devnum % 16 ** pattern.width : from ?? 0)})
              </span>
              {multi && (
                <span className={styles.chip}>
                  to(
                  {formatNumber(
                    pattern,
                    pattern.mode === 'devnum'
                      ? okProposals[okProposals.length - 1].devnum % 16 ** pattern.width
                      : (from ?? 0) + devnums.length - 1
                  )}
                  )
                </span>
              )}
              {pattern.suffix && <span className={styles.chip}>suffix({pattern.suffix})</span>}
              <span className={styles.chip}>type({pattern.type})</span>
              <span className={styles.arrow}>→</span>
              <strong className={styles.mono}>
                {okProposals[0].volser}
                {multi && ` – ${okProposals[okProposals.length - 1].volser}`}
              </strong>
            </div>
          )}

          {multi && (
            <div className={styles.preview}>
              {proposals.map((p) => (
                <div key={p.devnum} className={cx(styles.previewItem, p.problem && styles.previewBad)} title={p.problem}>
                  <span className={styles.muted}>{hex4(p.devnum)}</span> {p.volser ?? '?'}
                  {p.problem && <span> · {p.problem}</span>}
                </div>
              ))}
            </div>
          )}

          {onSavePattern && storgrp && (
            <Button
              size="sm"
              variant="secondary"
              fill="text"
              icon={patternSaved ? 'check' : 'save'}
              disabled={patternSaved}
              onClick={() => {
                onSavePattern(storgrp, { minPrefix, ...pattern });
                setPatternSaved(true);
              }}
            >
              {patternSaved ? 'Zapamiętano (zapisz dashboard)' : `Zapamiętaj wzorzec dla ${storgrp}`}
            </Button>
          )}
        </div>
      )}

      <div className={styles.cols}>
        {type !== 'remove' && !multi && (
          <Field
            label={type === 'modify' ? 'Nowy VOLSER (opcjonalnie)' : 'VOLSER'}
            description={type === 'add' && !volserTouched && proposals[0]?.volser ? 'proponowany wg wzorca' : undefined}
          >
            <Input
              value={volser}
              onChange={(e) => {
                setVolserTouched(true);
                set({ volser: e.currentTarget.value.toUpperCase() });
              }}
              suffix={
                type === 'add' && volserTouched && proposals[0]?.volser ? (
                  <Button size="sm" fill="text" icon="history" tooltip="Przywróć proponowany" onClick={() => setVolserTouched(false)} />
                ) : undefined
              }
            />
          </Field>
        )}
        {type === 'add' && (
          <Field label="Model">
            <Select options={opts(models)} value={c.model || null} isClearable onChange={(v) => set({ model: v?.value ?? '' })} />
          </Field>
        )}
      </div>
      <Field label="Systemy" description="Puste = potwierdza wsad z dowolnego systemu">
        <MultiSelect
          options={opts([...new Set([...systems, ...selectedSystems])])}
          value={selectedSystems}
          allowCustomValue
          onChange={(v) => set({ systems: v.map((x) => x.value).join(',') })}
        />
      </Field>
      <Field label="Komentarz">
        <TextArea value={c.comment ?? ''} rows={2} onChange={(e) => set({ comment: e.currentTarget.value })} />
      </Field>

      {problems.length > 0 && <div className={styles.problems}>{problems.join(' · ')}</div>}
      {error && (
        <Alert severity="error" title="Nie udało się zapisać">
          {error}
        </Alert>
      )}

      <Modal.ButtonRow>
        {onAlertRule && !multi && (
          <Button variant="secondary" fill="text" icon="bell" onClick={onAlertRule}>
            Reguła alertu dla dysku
          </Button>
        )}
        {isPending && onCancelChange && (
          <Button variant="destructive" fill="outline" icon="trash-alt" disabled={busy} onClick={cancelChange}>
            Anuluj zmianę
          </Button>
        )}
        <Button variant="secondary" fill="outline" onClick={onDismiss}>
          Zamknij
        </Button>
        <Button icon={busy ? 'spinner' : 'save'} disabled={busy || problems.length > 0} onClick={submit}>
          {isPending ? 'Zapisz' : multi ? `Dodaj ${devnums.length} dysków` : 'Dodaj zmianę'}
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
};

function errorText(e: unknown): string {
  const err = e as { data?: { message?: string; error?: string }; message?: string; statusText?: string };
  return err?.data?.message ?? err?.data?.error ?? err?.message ?? err?.statusText ?? String(e);
}

const getStyles = (theme: GrafanaTheme2) => ({
  modal: css({ width: 760, maxWidth: '95vw' }),
  info: css({ color: theme.colors.text.secondary, marginBottom: theme.spacing(1.5) }),
  muted: css({ color: theme.colors.text.secondary }),
  mono: css({ fontFamily: theme.typography.fontFamilyMonospace }),
  cols: css({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: theme.spacing(2),
  }),
  pattern: css({
    marginBottom: theme.spacing(2),
    padding: theme.spacing(1, 1.5),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  patternHead: css({ display: 'flex', gap: theme.spacing(1), alignItems: 'baseline', marginBottom: theme.spacing(1) }),
  patternRow: css({ display: 'flex', flexWrap: 'wrap', gap: theme.spacing(1.5), alignItems: 'flex-end' }),
  compact: css({ marginBottom: 0 }),
  range: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(1),
  }),
  chip: css({
    padding: theme.spacing(0, 0.75),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  arrow: css({ color: theme.colors.text.secondary, margin: theme.spacing(0, 0.5) }),
  preview: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: theme.spacing(0.25, 1),
    maxHeight: 140,
    overflow: 'auto',
    marginTop: theme.spacing(1),
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  previewItem: css({ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
  previewBad: css({ color: theme.colors.error.text }),
  problems: css({ color: theme.colors.warning.text, fontSize: theme.typography.bodySmall.fontSize }),
});
