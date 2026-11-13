#!/bin/sh
# Build pluginu + (re)start Grafany ze srodowiska grafana_automation_js z zamontowanym pluginem
# + dane przykladowe (mf-loader: mf-load dcollect, baza mfmetrics) + dashboard.
#   sh dev/deploy.sh            - wszystko
#   sh dev/deploy.sh --no-data  - bez ladowania danych przykladowych
# Zmienne: GRAFANA_ENV_DIR (domyslnie ~/Documents/projects/grafana_automation_js),
#          MF_LOADER_DIR (domyslnie ~/Documents/projects/mf-loader), GRAFANA_URL, INFLUXDB_URL.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="${GRAFANA_ENV_DIR:-$HOME/Documents/projects/grafana_automation_js}"
MF_LOADER_DIR="${MF_LOADER_DIR:-$HOME/Documents/projects/mf-loader}"
GRAFANA="${GRAFANA_URL:-http://localhost:3000}"
export INFLUXDB_URL="${INFLUXDB_URL:-http://localhost:8086}"
export MAINFRAME_PLUGIN_DIST="$ROOT/dist"

(cd "$ROOT" && npm run build --silent)

# Plugin juz zamontowany -> wystarczy build (dist/ jest bind-mountem), wystarczy odswiezyc przegladarke.
# W przeciwnym razie odtwarzamy Grafane z nakladka (podman-compose sam nie odtworzy dzialajacego kontenera).
# Kontener "app" zalezy od grafany, wiec trzeba go zatrzymac i usunac razem z nia.
if ! podman exec grafana-automation_grafana_1 test -f /var/lib/grafana/plugins/mainframe-dasdmap-panel/plugin.json 2>/dev/null; then
    APP_RUNNING=$(podman ps --format '{{.Names}}' | grep -c '^grafana-automation_app_1$' || true)
    podman rm -f grafana-automation_app_1 >/dev/null 2>&1 || true
    (cd "$ENV_DIR" && podman compose -f compose.yaml -f "$ROOT/dev/grafana-plugin.override.yaml" \
        up -d --force-recreate --no-deps grafana)
    if [ "$APP_RUNNING" = "1" ]; then
        (cd "$ENV_DIR" && podman compose --profile app up -d --no-deps app)
    fi
fi

echo "czekam na Grafane..."
until curl -sf "$GRAFANA/api/health" >/dev/null; do sleep 1; done

if [ "$1" != "--no-data" ]; then
    SAMPLE="$(mktemp -d)"
    curl -sf -XPOST "$INFLUXDB_URL/query" --data-urlencode 'q=CREATE DATABASE "mfmetrics"' >/dev/null
    (cd "$MF_LOADER_DIR" && npx tsx tools/dcollect/gen-sample-csv.ts --days 7 --out "$SAMPLE" >/dev/null \
        && npx tsx src/cli.ts dcollect --db mfmetrics --no-confirm "$SAMPLE"/*.CSV)
    rm -rf "$SAMPLE"
fi

curl -sf -u admin:admin -H 'Content-Type: application/json' \
    -X POST "$GRAFANA/api/dashboards/db" --data @"$ROOT/dev/dashboard.json" >/dev/null
echo "gotowe: $GRAFANA/d/mainframe-dasd-map"
