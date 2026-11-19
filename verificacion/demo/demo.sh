#!/usr/bin/env bash
# CaféOrbe · demostración en vivo de los escenarios de calidad en 15 minutos (Azure Cloud Shell, QA).
#
# Las pruebas formales (10 min de REN-01, tres corridas de caos) ya están certificadas en
# verificacion/dis01/RESULTADO-DIS01.md y verificacion/ren01. Aquí cada escenario corre en versión corta, con las
# mismas medidas del PDF, para verlo en tiempo real.
#
#   ./verificacion/demo/demo.sh preparar    # ANTES de la presentación (~8 min): 400 compradores con Orbes y subasta
#   ./verificacion/demo/demo.sh renovar     # si la subasta de carga venció: otra en segundos, mismos compradores
#   ./verificacion/demo/demo.sh seg         # SEG-01/02/03 · ~1 min
#   ./verificacion/demo/demo.sh ren         # REN-01 corto: 200 WebSocket, 20 pujas/s, 75 s (~2 min 40 s)
#   ./verificacion/demo/demo.sh caos        # DIS-01: cae 1 de 2 réplicas de auction y de realtime · ~2,5 min
#   ./verificacion/demo/demo.sh escalado    # DIS-01: carga duplicada; se detiene al escalar auction (tope 3 min)
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

# Cada paso muestra al final su duración y un veredicto; todos caben en 3 minutos.
INICIO_PASO=0
empezar() { INICIO_PASO=$SECONDS; negrita "$1"; }
veredicto() { # veredicto <ok:0|1> <texto>
  local s=$((SECONDS - INICIO_PASO))
  if [[ "$1" == 0 ]]; then printf '\n\033[1;32m✅ %s\033[0m  (%d min %02d s)\n' "$2" $((s / 60)) $((s % 60))
  else printf '\n\033[1;31m❌ %s\033[0m  (%d min %02d s)\n' "$2" $((s / 60)) $((s % 60)); fi
}

# Subasta de carga nueva con los mismos 400 compradores (segundos). Usar si la de 'preparar' ya venció.
renovar() {
  credenciales
  leer_estado
  negrita "Subasta de carga nueva (90 min) con los compradores ya preparados"
  (cd "$REN" && SIN_REGISTRO=1 node preparar-ren01.mjs --compradores 400 --minutos 90 --sufijo "$SUFIJO" | tail -1)
  cp "$REN/compradores.json" "$ESTADO/compradores-400.json"
  cat "$REN/.subasta-ren01" > "$ESTADO/subasta-carga"
}

seg() {
  credenciales
  empezar "SEG-01 · SEG-02 · SEG-03: tokens inválidos, matriz de permisos y abuso de pujas"
  local salida ok=1
  salida=$(cd "$RAIZ" && MUESTRAS="${MUESTRAS:-10}" SIN_REGISTRO=1 node seguridad-qa.mjs 2>&1) || true
  echo "$salida" | grep -E '^(✔|✘)|cumplen|fallida'
  # El p95 del login con Google necesita al menos un login real en la réplica (entrar a la web antes).
  local fallas; fallas=$(echo "$salida" | grep '^✘' | grep -vc 'aún no registra logins' || true)
  [[ "$fallas" == 0 ]] && ok=0
  veredicto $ok "SEG-01/02/03: $(echo "$salida" | grep -c '^✔') comprobaciones correctas, $fallas fallidas"
}

ren() {
  leer_estado
  usar_compradores 200
  local seg_carga="${REN_SEGUNDOS:-75}"
  empezar "REN-01 (corto): 200 WebSocket, 20 pujas/s durante $seg_carga s · p95 ≤ 800 ms, p99 ≤ 1,5 s, 0 caídas"
  rm -f "$ESTADO/ren-resultado.json"
  (cd "$REN" && REN01_SUBASTA="$SUBASTA_CARGA" node carga-sala.mjs --etapa demo --usuarios 200 --tasa 20 \
    --duracion "$seg_carga" --rampup 10 --salida "$ESTADO/ren-resultado.json" --html "$ESTADO/ren-resultado.html" 2>&1) \
    | grep --line-buffered -E 'Progreso|Conexiones listas' || true
  local p95 p99 caidas
  read -r p95 p99 caidas <<<"$(node -e '
    try { const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
      console.log(r.resumenLatencia.p95, r.resumenLatencia.p99, r.conexiones.desconexiones) } catch { console.log("") }' \
    "$ESTADO/ren-resultado.json")"
  replicas
  if [[ -n "$p95" ]] && awk -v a="$p95" -v b="$p99" -v c="$caidas" 'BEGIN{exit !(a<=800 && b<=1500 && c==0)}'; then
    veredicto 0 "REN-01: p95 $(printf %.0f "$p95") ms · p99 $(printf %.0f "$p99") ms · $caidas caídas"
  else
    veredicto 1 "REN-01: p95 ${p95:-?} ms · p99 ${p99:-?} ms · ${caidas:-?} caídas"
  fi
}

caos() {
  credenciales
  leer_estado
  empezar "DIS-01: se detiene 1 de 2 réplicas de auction y 1 de 2 de realtime a los 15 s (mirar Grafana)"
  (cd "$REN" && SIN_REGISTRO=1 node preparar-ren01.mjs --compradores 60 --minutos 3 --sufijo "$SUFIJO" | tail -1)
  cat "$REN/.subasta-ren01" > "$ESTADO/subasta-caos"
  replicas
  local salida
  salida=$(cd "$RAIZ" && REN01_SUBASTA="$(cat "$ESTADO/subasta-caos")" node dis01/caos-bajo-carga.mjs --antes 15 \
    --despues 45 --reposicion "${REPOSICION_S:-90}" 2>&1)
  echo "$salida" | grep -E '^(REST|WebSocket|Pujas):|✅|❌|Falla|Reposici'
  replicas
  if echo "$salida" | grep -q '❌' || ! echo "$salida" | grep -q '✅'; then
    veredicto 1 "DIS-01 caída de réplicas: algún criterio no se cumplió"
  else
    veredicto 0 "DIS-01 caída de réplicas: REST < 2 %, reconexión < 10 s, 0 pujas perdidas, réplicas repuestas"
  fi
  echo "La subasta del caos cierra a los 3 min de creada; luego: ./verificacion/demo/demo.sh cierre"
}

escalado() {
  leer_estado
  usar_compradores 400
  local tope="${ESCALADO_TOPE_S:-175}"
  empezar "DIS-01 escalado: carga duplicada (400 WebSocket, 40 pujas/s) · auction de 2 hacia 4 réplicas"
  (cd "$REN" && REN01_SUBASTA="$SUBASTA_CARGA" exec node carga-sala.mjs --etapa escalado --usuarios 400 --tasa 40 \
    --duracion "$tope" --rampup 10 --salida "$ESTADO/escalado.json" --html "$ESTADO/escalado.html" \
    > "$ESTADO/escalado.log" 2>&1) &
  local carga=$! subasta=2 n
  while ((SECONDS - INICIO_PASO < tope)); do
    n=$(az containerapp replica list -g $GRUPO -n auction-service --query 'length(@)' -o tsv --only-show-errors 2>/dev/null || echo "?")
    echo "$(date -u +%T) +$((SECONDS - INICIO_PASO)) s · auction-service=$n réplicas · $(grep -o 'WS Activos: [0-9]*' "$ESTADO/escalado.log" | tail -1)"
    if [[ "$n" =~ ^[0-9]+$ ]] && ((n > 2)); then subasta=$n; break; fi
    sleep 10
  done
  kill "$carga" 2>/dev/null || true
  wait "$carga" 2>/dev/null || true
  usar_compradores 200
  if ((subasta > 2)); then veredicto 0 "DIS-01 escalado: auction pasó de 2 a $subasta réplicas con la carga duplicada"
  else veredicto 1 "DIS-01 escalado: auction no escaló en $tope s"; fi
}

cierre() {
  [[ -f "$ESTADO/subasta-caos" ]] || { echo "Primero corre 'caos'." >&2; exit 1; }
  empezar "DIS-01: exactamente 1 cierre y 1 cobro en la subasta del caos"
  local salida; salida=$(bash "$RAIZ/dis01/verificar-cierre.sh" "$(cat "$ESTADO/subasta-caos")" 2>&1 | tail -1)
  echo "$salida"
  if echo "$salida" | grep -q '"cumple": true'; then veredicto 0 "DIS-01: 1 cierre, 1 COBRO y 1 ABONO_VENTA"
  else veredicto 1 "DIS-01: el cierre aún no cuadra (¿la subasta ya cerró?)"; fi
}

case "${1:-}" in
  preparar) preparar ;;
  renovar) renovar ;;
  seg) seg ;;
  ren) ren ;;
  caos) caos ;;
  escalado) escalado ;;
  cierre) cierre ;;
  todo) seg; ren; caos; escalado; sleep 20; cierre ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
