#!/usr/bin/env bash
# CaféOrbe · demostración en vivo de los escenarios de calidad en 15 minutos (Azure Cloud Shell, QA).
#
# Las pruebas formales (10 min de REN-01, tres corridas de caos) ya están certificadas en
# verificacion/dis01/RESULTADO-DIS01.md y verificacion/ren01. Aquí cada escenario corre en versión corta, con las
# mismas medidas del PDF, para verlo en tiempo real.
#
#   ./verificacion/demo/demo.sh preparar    # ANTES de la presentación (~8 min): 400 compradores con Orbes y subasta
#   ./verificacion/demo/demo.sh seg         # SEG-01/02/03 · ~1 min
#   ./verificacion/demo/demo.sh ren         # REN-01 corto: 200 WebSocket, 20 pujas/s, 2 min
#   ./verificacion/demo/demo.sh caos        # DIS-01: cae 1 de 2 réplicas de auction y de realtime · ~2,5 min
#   ./verificacion/demo/demo.sh escalado    # DIS-01: carga duplicada, réplicas de 2 hacia 4 · ~3 min
#   ./verificacion/demo/demo.sh cierre      # DIS-01: 1 cierre y 1 cobro de la subasta del caos (cuando cierre)
#   ./verificacion/demo/demo.sh todo        # seg, ren, caos, escalado y cierre seguidos (~11 min)
#
# OBS-01 se muestra en Grafana durante caos y escalado; MAN-01, con un PR bloqueado y el Quality Gate en SonarCloud.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # verificacion/
REN="$RAIZ/ren01"
ESTADO="${HOME}/.cafeorbe-demo"
GRUPO=cafeorbe-org
export API_URL="${API_URL:-https://api-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io}"
export WS_URL="${WS_URL:-wss://realtime-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io}"
export CAFEORBE_AMBIENTE=qa

negrita() { printf '\n\033[1;36m══ %s ══\033[0m  (%s UTC)\n' "$1" "$(date -u +%T)"; }

# Credenciales de QA leídas de las Container Apps; nunca se imprimen.
valor() {
  local app=$1 nombre=$2 v ref
  v=$(az containerapp show -g $GRUPO -n "$app" --query "properties.template.containers[0].env[?name=='$nombre'] | [0].value" -o tsv --only-show-errors)
  if [[ -z "$v" ]]; then
    ref=$(az containerapp show -g $GRUPO -n "$app" --query "properties.template.containers[0].env[?name=='$nombre'] | [0].secretRef" -o tsv --only-show-errors)
    v=$(az containerapp secret show -g $GRUPO -n "$app" --secret-name "$ref" --query value -o tsv --only-show-errors)
  fi
  printf '%s' "$v"
}
credenciales() {
  [[ -n "${JWT_SECRET:-}" && -n "${INTERNAL_TOKEN:-}" && -n "${BROKER_PASSWORD:-}" ]] && return
  echo "Cargando credenciales de QA (no se muestran)..."
  JWT_SECRET=$(valor identity-service JWT_SECRET); export JWT_SECRET
  INTERNAL_TOKEN=$(valor auction-service INTERNAL_TOKEN); export INTERNAL_TOKEN
  BROKER_API_URL="https://$(valor wallet-service RABBIT_HOST)"; export BROKER_API_URL
  BROKER_USER=$(valor wallet-service RABBIT_USER); export BROKER_USER
  BROKER_PASSWORD=$(valor wallet-service RABBIT_PASSWORD); export BROKER_PASSWORD
  BROKER_VHOST=$(valor wallet-service RABBIT_VHOST); export BROKER_VHOST
}

leer_estado() {
  [[ -f "$ESTADO/sufijo" ]] || { echo "Falta preparar: ./verificacion/demo/demo.sh preparar" >&2; exit 1; }
  SUFIJO=$(cat "$ESTADO/sufijo")
  SUBASTA_CARGA=$(cat "$ESTADO/subasta-carga")
}

# Deja en ren01/compradores.json los primeros N de los 400 preparados (los generadores leen ese archivo).
usar_compradores() { node -e "const f=require('fs');f.writeFileSync('$REN/compradores.json',JSON.stringify(JSON.parse(f.readFileSync('$ESTADO/compradores-400.json')).slice(0,$1)))"; }

replicas() {
  local linea=""
  for app in api-gateway auction-service realtime-gateway; do
    linea+="$app=$(az containerapp replica list -g $GRUPO -n "$app" --query 'length(@)' -o tsv --only-show-errors 2>/dev/null || echo ?)  "
  done
  echo "$(date -u +%T) réplicas: $linea"
}

preparar() {
  credenciales
  mkdir -p "$ESTADO"
  local sufijo; sufijo="demo$(date -u +%m%d%H%M)"
  negrita "Preparando 400 compradores con Orbes y la subasta de carga (90 min)"
  (cd "$REN" && node preparar-ren01.mjs --compradores 400 --minutos 90 --sufijo "$sufijo")
  cp "$REN/compradores.json" "$ESTADO/compradores-400.json"
  cat "$REN/.subasta-ren01" > "$ESTADO/subasta-carga"
  echo "$sufijo" > "$ESTADO/sufijo"
  replicas
  echo "Listo. La subasta de carga dura 90 min: preparar como máximo 1 hora antes de la presentación."
}

seg() {
  credenciales
  negrita "SEG-01 · SEG-02 · SEG-03: tokens inválidos, matriz de permisos y abuso de pujas"
  (cd "$RAIZ" && MUESTRAS="${MUESTRAS:-10}" SIN_REGISTRO=1 node seguridad-qa.mjs)
}

ren() {
  leer_estado
  usar_compradores 200
  negrita "REN-01 (corto): 200 WebSocket, 20 pujas/s durante ${REN_SEGUNDOS:-120} s · p95 ≤ 800 ms, p99 ≤ 1,5 s"
  replicas
  (cd "$REN" && REN01_SUBASTA="$SUBASTA_CARGA" node carga-sala.mjs --etapa demo --usuarios 200 --tasa 20 \
    --duracion "${REN_SEGUNDOS:-120}" --rampup 15 --salida "$ESTADO/ren-resultado.json" --html "$ESTADO/ren-resultado.html") \
    | grep -E 'Progreso|RESUMEN|Conexiones|Pujas|Latencia|Eventos|Gaps|====' || true
  replicas
}

caos() {
  credenciales
  leer_estado
  negrita "DIS-01: subasta de 3 min para el caos (compradores ya preparados)"
  (cd "$REN" && SIN_REGISTRO=1 node preparar-ren01.mjs --compradores 60 --minutos 3 --sufijo "$SUFIJO" | tail -1)
  cat "$REN/.subasta-ren01" > "$ESTADO/subasta-caos"
  negrita "DIS-01: a los 15 s se detiene 1 de 2 réplicas de auction y 1 de 2 de realtime (mirar Grafana)"
  replicas
  (cd "$RAIZ" && REN01_SUBASTA="$(cat "$ESTADO/subasta-caos")" node dis01/caos-bajo-carga.mjs --antes 15 --despues 45 \
    --reposicion "${REPOSICION_S:-120}") | grep -Ev '^ +[0-9]+ ms \(corte|^    '
  replicas
  echo "La subasta del caos cierra a los 3 min de creada: después correr './verificacion/demo/demo.sh cierre'."
}

escalado() {
  leer_estado
  usar_compradores 400
  negrita "DIS-01 escalado: carga duplicada (400 WebSocket, 40 pujas/s) · réplicas de 2 hacia 4"
  replicas
  rm -f "$ESTADO/fin-escalado"
  ( while [[ ! -f "$ESTADO/fin-escalado" ]]; do replicas; sleep 15; done ) &
  local observador=$!
  (cd "$REN" && REN01_SUBASTA="$SUBASTA_CARGA" node carga-sala.mjs --etapa escalado --usuarios 400 --tasa 40 \
    --duracion "${ESCALADO_SEGUNDOS:-150}" --rampup 30 --salida "$ESTADO/escalado.json" --html "$ESTADO/escalado.html") \
    | grep -E 'RESUMEN|Conexiones|Pujas env|Latencia p9|====' || true
  touch "$ESTADO/fin-escalado"
  wait "$observador" 2>/dev/null || true
  usar_compradores 200
}

cierre() {
  [[ -f "$ESTADO/subasta-caos" ]] || { echo "Primero corre 'caos'." >&2; exit 1; }
  negrita "DIS-01: exactamente 1 cierre y 1 cobro en la subasta del caos"
  bash "$RAIZ/dis01/verificar-cierre.sh" "$(cat "$ESTADO/subasta-caos")"
}

case "${1:-}" in
  preparar) preparar ;;
  seg) seg ;;
  ren) ren ;;
  caos) caos ;;
  escalado) escalado ;;
  cierre) cierre ;;
  todo) seg; ren; caos; escalado; sleep 20; cierre ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
