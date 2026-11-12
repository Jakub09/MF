#!/bin/sh
# Build pluginu + (re)start Grafany ze środowiska grafana_automation_js z zamontowanym pluginem
# + dane przykładowe + dashboard.
#   sh dev/deploy.sh            - wszystko
#   sh dev/deploy.sh --no-data  - bez ładowania danych przykładowych
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="${GRAFANA_ENV_DIR:-$ROOT/../grafana_automation_js}"
GRAFANA="${GRAFANA_URL:-http://localhost:3000}"
export MAINFRAME_PLUGIN_DIST="$ROOT/grafana_plugin/dist"

(cd "$ROOT/grafana_plugin" && npm run build --silent)

# Plugin już zamontowany -> wystarczy build (dist/ jest bind-mountem), wystarczy odświeżyć przeglądarkę.
# W przeciwnym razie odtwarzamy Grafanę z nakładką (podman-compose sam nie odtworzy działającego kontenera).
# Kontener "app" zależy od grafany, więc trzeba go zatrzymać i usunąć razem z nią.
if ! podman exec grafana-automation_grafana_1 test -f /var/lib/grafana/plugins/mainframe-dasdmap-panel/plugin.json 2>/dev/null; then
    APP_RUNNING=$(podman ps --format '{{.Names}}' | grep -c '^grafana-automation_app_1$' || true)
    podman rm -f grafana-automation_app_1 >/dev/null 2>&1 || true
    (cd "$ENV_DIR" && podman compose -f compose.yaml -f "$ROOT/dev/grafana-plugin.override.yaml" \
        up -d --force-recreate --no-deps grafana)
    if [ "$APP_RUNNING" = "1" ]; then
        (cd "$ENV_DIR" && podman compose --profile app up -d --no-deps app)
    fi
fi

echo "czekam na Grafanę..."
until curl -sf "$GRAFANA/api/health" >/dev/null; do sleep 1; done

if [ "$1" != "--no-data" ]; then
    rm -f "$ROOT"/loader/sample/*.CSV
    python3 "$ROOT/loader/gen_sample_csv.py" --days 7 --out "$ROOT/loader/sample" >/dev/null
    python3 "$ROOT/loader/dcol2influx.py" --no-confirm "$ROOT"/loader/sample/*.CSV
fi

curl -sf -u admin:admin -H 'Content-Type: application/json' \
    -X POST "$GRAFANA/api/dashboards/db" --data @"$ROOT/dev/dashboard.json" >/dev/null
echo "gotowe: $GRAFANA/d/mainframe-dasd-map"
