import React, { useState } from 'react';
import { StandardEditorProps } from '@grafana/data';
import { Alert, Button, CodeEditor } from '@grafana/ui';
import { DEFAULT_CONFIG_JSON, parseConfig } from '../config';

/** Edytor JSON z kolorami / progami / regułami (opcja "config") */
export const ConfigEditor: React.FC<StandardEditorProps<string>> = ({ value, onChange }) => {
  const [error, setError] = useState(parseConfig(value).error);
  const apply = (text: string) => {
    setError(parseConfig(text).error);
    onChange(text);
  };
  return (
    <div>
      <CodeEditor
        value={value || DEFAULT_CONFIG_JSON}
        language="json"
        height={420}
        showLineNumbers
        showMiniMap={false}
        onBlur={apply}
        onSave={apply}
      />
      {error && (
        <Alert severity="error" title="JSON" style={{ marginTop: 8 }}>
          {error}
        </Alert>
      )}
      <Button size="sm" variant="secondary" icon="history" style={{ marginTop: 8 }} onClick={() => apply(DEFAULT_CONFIG_JSON)}>
        Przywróć domyślne
      </Button>
    </div>
  );
};
