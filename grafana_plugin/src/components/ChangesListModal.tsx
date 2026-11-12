import React from 'react';
import { css } from '@emotion/css';
import { dateTimeFormat, GrafanaTheme2 } from '@grafana/data';
import { Button, Modal, useStyles2 } from '@grafana/ui';
import { Change } from '../types';

const TYPE_LABEL: Record<string, string> = { add: 'nowy dysk', modify: 'zmiana', remove: 'wycofanie' };

interface Props {
  changes: Change[];
  editable: boolean;
  onOpen: (c: Change) => void;
  onDismiss: () => void;
}

export const ChangesListModal: React.FC<Props> = ({ changes, editable, onOpen, onDismiss }) => {
  const styles = useStyles2(getStyles);
  return (
    <Modal title={`Niepotwierdzone zmiany (${changes.length})`} isOpen onDismiss={onDismiss}>
      {changes.length === 0 ? (
        <p>Brak zmian czekających na potwierdzenie.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>DEVNUM</th>
              <th>Rodzaj</th>
              <th>VOLSER</th>
              <th>SG</th>
              <th>Systemy</th>
              <th>Kto / kiedy</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...changes]
              .sort((a, b) => a.devnum.localeCompare(b.devnum))
              .map((c) => (
                <tr key={c.devnum}>
                  <td className={styles.mono}>{c.devnum}</td>
                  <td>{TYPE_LABEL[c.type] ?? c.type}</td>
                  <td className={styles.mono}>{c.volser || '—'}</td>
                  <td>{c.storgrp || '—'}</td>
                  <td>{c.systems || 'dowolny'}</td>
                  <td className={styles.muted}>
                    {c.user} · {dateTimeFormat(c.createdAt, { format: 'YYYY-MM-DD HH:mm' })}
                    {c.comment && <div>{c.comment}</div>}
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" icon={editable ? 'pen' : 'eye'} onClick={() => onOpen(c)}>
                      {editable ? 'Edytuj' : 'Pokaż'}
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <Modal.ButtonRow>
        <Button variant="secondary" onClick={onDismiss}>
          Zamknij
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
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
  mono: css({ fontFamily: theme.typography.fontFamilyMonospace }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
});
