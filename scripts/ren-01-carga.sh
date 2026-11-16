#!/usr/bin/env bash
# REN-01 · Prueba de carga sostenida desde Azure (misma región que las apps), para no medir la latencia de internet.
#
# Uso, en Azure Cloud Shell (Bash):
#   ./scripts/ren-01-carga.sh preparar    # auction y realtime a 1 vCPU / 2 GiB con 2 réplicas fijas
#   ./scripts/ren-01-carga.sh correr      # contenedor en East US 2 con carga-sala.mjs (200 compradores, 20 pujas/s, 10 min)
#   ./scripts/ren-01-carga.sh resultado   # salida del contenedor (se puede repetir mientras corre)
#   ./scripts/ren-01-carga.sh restaurar   # borra el contenedor y devuelve CPU, memoria y réplicas a lo que había
#
# Los secretos (JWT_SECRET y la clave del broker) se leen de las Container Apps y se pasan al contenedor como
# variables seguras: no se imprimen ni se guardan. Variables opcionales: RESOURCE_GROUP, REGION, COMPRADORES,
# PUJAS_POR_SEG, SOSTENIDA_MIN, RAMA (rama de cafeorbe-infra de donde se descargan los scripts).
set -euo pipefail

GRUPO="${RESOURCE_GROUP:-cafeorbe-org}"
REGION="${REGION:-eastus2}"
CONTENEDOR="cafeorbe-carga-ren01"
APPS=(auction-service realtime-gateway)
ESTADO="${HOME}/.cafeorbe-ren01-estado"
RAMA="${RAMA:-main}"
SCRIPTS="https://raw.githubusercontent.com/CafeOrbe/cafeorbe-infra/${RAMA}/verificacion"

command -v az >/dev/null || { echo "Falta Azure CLI (az): usa Azure Cloud Shell." >&2; exit 1; }
az extension add --name containerapp --upgrade --only-show-errors >/dev/null

variable() { # variable <app> <NOMBRE>: valor de una variable de entorno del primer contenedor de la app
  az containerapp show -n "$1" -g "$GRUPO" --query "properties.template.containers[0].env[?name=='$2'].value | [0]" -o tsv
}
url() { az containerapp show -n "$1" -g "$GRUPO" --query properties.configuration.ingress.fqdn -o tsv; }

preparar() {
  if [[ -f "$ESTADO" ]]; then
    echo "Ya hay una ventana de prueba preparada ($ESTADO). Ejecuta 'restaurar' antes de volver a preparar." >&2
    exit 1
  fi
  : > "$ESTADO"
  for app in "${APPS[@]}"; do
    az containerapp show -n "$app" -g "$GRUPO" --query "[name, properties.template.containers[0].resources.cpu, properties.template.containers[0].resources.memory, properties.template.scale.minReplicas, properties.template.scale.maxReplicas]" -o tsv >> "$ESTADO"
  done
  echo "Configuración actual guardada en $ESTADO:"
  column -t "$ESTADO"
  for app in "${APPS[@]}"; do
    echo "→ $app: 1 vCPU / 2 GiB, 2 réplicas fijas"
    az containerapp update -n "$app" -g "$GRUPO" --cpu 1 --memory 2Gi --min-replicas 2 --max-replicas 2 -o none
  done
  echo "Esperando a que las revisiones nuevas estén listas…"
  for app in "${APPS[@]}"; do
    for _ in $(seq 1 30); do
      estado="$(az containerapp show -n "$app" -g "$GRUPO" --query "[properties.latestRevisionName, properties.latestReadyRevisionName]" -o tsv | tr '\t' ' ')"
      read -r ultima lista <<< "$estado"
      [[ "$ultima" == "$lista" ]] && break
      sleep 10
    done
    echo "  $app: revisión lista $lista"
  done
  echo "✓ Listo. Sigue con: $0 correr"
}

correr() {
  local jwt broker_clave api ws
  jwt="$(variable identity-service JWT_SECRET)"
  broker_clave="$(variable realtime-gateway RABBIT_PASSWORD)"
  [[ -n "$jwt" && "$jwt" != None && -n "$broker_clave" && "$broker_clave" != None ]] || { echo "No se pudieron leer JWT_SECRET o RABBIT_PASSWORD de las Container Apps." >&2; exit 1; }
  api="https://$(url api-gateway)"
  ws="wss://$(url realtime-gateway)"
  az provider register --namespace Microsoft.ContainerInstance --wait -o none
  az container delete -g "$GRUPO" -n "$CONTENEDOR" -y -o none 2>/dev/null || true
  echo "→ Contenedor $CONTENEDOR en $REGION contra $api"
  az container create -g "$GRUPO" -n "$CONTENEDOR" -l "$REGION" \
    --image mcr.microsoft.com/devcontainers/javascript-node:22 --os-type Linux --cpu 2 --memory 4 --restart-policy Never \
    --environment-variables API_URL="$api" WS_URL="$ws" MODO=sostenida \
      COMPRADORES="${COMPRADORES:-200}" PUJAS_POR_SEG="${PUJAS_POR_SEG:-20}" SOSTENIDA_MIN="${SOSTENIDA_MIN:-10}" \
      BROKER_API_URL=https://toucan.lmq.cloudamqp.com BROKER_USER=ebmfpsvi BROKER_VHOST=ebmfpsvi \
    --secure-environment-variables JWT_SECRET="$jwt" BROKER_PASSWORD="$broker_clave" \
    --command-line "bash -c 'cd /tmp && curl -fsSLO $SCRIPTS/carga-sala.mjs && curl -fsSLO $SCRIPTS/sesiones-de-prueba.mjs && node carga-sala.mjs'" \
    -o none
  echo "✓ La prueba arrancó (dura unos 12 minutos). Mira el avance con: $0 resultado"
  echo "  Mientras corre, revisa en Grafana el tablero técnico (REN-01) y en Azure la CPU de auction y realtime."
}

resultado() {
  az container show -g "$GRUPO" -n "$CONTENEDOR" --query "containers[0].instanceView.currentState.{estado:state, codigo:exitCode, inicio:startTime, fin:finishTime}" -o table
  az container logs -g "$GRUPO" -n "$CONTENEDOR"
}

restaurar() {
  az container delete -g "$GRUPO" -n "$CONTENEDOR" -y -o none 2>/dev/null && echo "→ Contenedor $CONTENEDOR borrado" || true
  if [[ ! -f "$ESTADO" ]]; then
    echo "No hay configuración guardada ($ESTADO): no se cambia CPU ni réplicas." >&2
    exit 0
  fi
  while read -r app cpu memoria minimo maximo; do
    echo "→ $app: ${cpu} vCPU / ${memoria}, réplicas ${minimo}–${maximo}"
    az containerapp update -n "$app" -g "$GRUPO" --cpu "$cpu" --memory "$memoria" --min-replicas "$minimo" --max-replicas "$maximo" -o none
  done < "$ESTADO"
  rm -f "$ESTADO"
  echo "✓ Configuración restaurada."
}

case "${1:-}" in
  preparar) preparar ;;
  correr) correr ;;
  resultado) resultado ;;
  restaurar) restaurar ;;
  *) echo "Uso: $0 preparar|correr|resultado|restaurar" >&2; exit 2 ;;
esac
