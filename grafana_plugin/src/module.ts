import { FieldConfigProperty, PanelPlugin } from '@grafana/data';
import { DiskMapPanel } from './components/DiskMapPanel';
import { ConfigEditor } from './components/ConfigEditor';
import { DEFAULT_CONFIG_JSON } from './config';
import { DiskMapOptions } from './types';

const FIELDS = 'Pola danych';
const COLORS = 'Kolory i błędy';
const CHANGES = 'Zmiany';
const LOOK = 'Wygląd';
const ALERTS = 'Alerty';

export const plugin = new PanelPlugin<DiskMapOptions>(DiskMapPanel)
  // Kolory i progi są w JSON-ie konfiguracji, standardowe opcje pól nie mają tu zastosowania
  .useFieldConfig({
    disableStandardOptions: [
      FieldConfigProperty.Color,
      FieldConfigProperty.Thresholds,
      FieldConfigProperty.Mappings,
      FieldConfigProperty.Min,
      FieldConfigProperty.Max,
      FieldConfigProperty.Decimals,
      FieldConfigProperty.Unit,
      FieldConfigProperty.NoValue,
      FieldConfigProperty.Links,
    ],
  })
  .setPanelOptions((b) =>
    b
      .addCustomEditor({
        id: 'config',
        path: 'config',
        name: 'Konfiguracja JSON',
        description:
          'capacity: kolory wg modelu / przedziałów GB · usage: pole i progi paska zajętości · ' +
          'markers / pending: kolory znaczników · staleHours · rules: reguły błędów (field z *, op eq|ne|in|notIn|gt|gte|lt|lte, level error|warning, dim) · ' +
          'naming: minPrefix i wzorce VOLSER (globalnie, nadpisania w naming.groups.<SG>)',
        defaultValue: DEFAULT_CONFIG_JSON,
        editor: ConfigEditor,
        category: [COLORS],
      })
      .addBooleanSwitch({
        path: 'allowChanges',
        name: 'Rejestrowanie zmian',
        description:
          'Edytorzy mogą dodać nowy dysk / zmianę SG. Zapis do dasd_change w InfluxDB, potwierdza loader po wczytaniu wsadu DCOLLECT.',
        defaultValue: true,
        category: [CHANGES],
      })
      .addBooleanSwitch({
        path: 'alertsEnabled',
        name: 'Reguły alertów',
        description: 'Zarządzanie regułami Grafana Alerting dla dysków z panelu i aktywne alerty na mapie',
        defaultValue: true,
        category: [ALERTS],
      })
      .addTextInput({
        path: 'alertFolderTitle',
        name: 'Folder reguł',
        defaultValue: 'Mainframe DASD',
        category: [ALERTS],
        showIf: (o) => o.alertsEnabled,
      })
      .addTextInput({
        path: 'alertFolderUid',
        name: 'UID folderu',
        description: 'Folder zostanie utworzony przy zapisie pierwszej reguły',
        defaultValue: 'mainframe-dasd',
        category: [ALERTS],
        showIf: (o) => o.alertsEnabled,
      })
      .addTextInput({ path: 'alertGroup', name: 'Grupa reguł', defaultValue: 'dasd-map', category: [ALERTS], showIf: (o) => o.alertsEnabled })
      .addTextInput({
        path: 'alertInterval',
        name: 'Interwał sprawdzania',
        description: 'Np. 15m, 1h - dane DCOLLECT przychodzą raz dziennie',
        defaultValue: '15m',
        category: [ALERTS],
        showIf: (o) => o.alertsEnabled,
      })
      .addNumberInput({
        path: 'alertWindowHours',
        name: 'Okno danych (h)',
        description: 'Jak daleko wstecz reguła szuka ostatniego wsadu (> odstęp między wsadami)',
        defaultValue: 30,
        settings: { min: 1, max: 24 * 14 },
        category: [ALERTS],
        showIf: (o) => o.alertsEnabled,
      })
      .addTextInput({
        path: 'alertReceiver',
        name: 'Domyślny punkt kontaktowy',
        description: 'Dla nowych reguł; puste = polityka powiadomień Grafany',
        defaultValue: '',
        category: [ALERTS],
        showIf: (o) => o.alertsEnabled,
      })
      .addFieldNamePicker({
        path: 'addressField',
        name: 'Adres urządzenia',
        description: 'DEVNUM w hex (np. 8080). Wiersz = 3 pierwsze cyfry, kolumna = ostatnia.',
        defaultValue: 'devnum',
        category: [FIELDS],
      })
      .addFieldNamePicker({ path: 'labelField', name: 'Etykieta', defaultValue: 'volser', category: [FIELDS] })
      .addFieldNamePicker({ path: 'modelField', name: 'Model', defaultValue: 'model', category: [FIELDS] })
      .addFieldNamePicker({ path: 'capacityField', name: 'Pojemność (KB)', defaultValue: 'capacity_kb', category: [FIELDS] })
      .addFieldNamePicker({ path: 'systemField', name: 'System', defaultValue: 'sysid', category: [FIELDS] })
      .addFieldNamePicker({
        path: 'collectedField',
        name: 'Czas wsadu',
        description: 'ms od epoki - wykrywanie dysków nieobecnych w ostatnim wsadzie',
        defaultValue: 'collected_at',
        category: [FIELDS],
      })
      .addTextInput({
        path: 'tooltipFields',
        name: 'Pola w dymku',
        description: 'Lista po przecinku, puste = wszystkie',
        defaultValue: '',
        category: [FIELDS],
      })
      .addRadio({
        path: 'cellStyle',
        name: 'Kolor kafelka',
        defaultValue: 'solid',
        settings: {
          options: [
            { value: 'solid', label: 'Pełny' },
            { value: 'tinted', label: 'Przyciemniony' },
          ],
        },
        category: [LOOK],
      })
      .addRadio({
        path: 'rowLayout',
        name: 'Przerwy w adresacji',
        defaultValue: 'compact',
        settings: {
          options: [
            { value: 'compact', label: 'Zwiń' },
            { value: 'full', label: 'Pokaż puste wiersze' },
          ],
        },
        category: [LOOK],
      })
      .addBooleanSwitch({ path: 'showToolbar', name: 'Podsumowanie i wyszukiwarka', defaultValue: true, category: [LOOK] })
      .addBooleanSwitch({ path: 'showLegend', name: 'Legenda', defaultValue: true, category: [LOOK] })
      .addSliderInput({
        path: 'cellMinWidth',
        name: 'Min. szerokość kafelka',
        defaultValue: 64,
        settings: { min: 40, max: 160, step: 4 },
        category: [LOOK],
      })
      .addSliderInput({
        path: 'cellHeight',
        name: 'Wysokość kafelka',
        defaultValue: 42,
        settings: { min: 28, max: 100, step: 2 },
        category: [LOOK],
      })
  );
