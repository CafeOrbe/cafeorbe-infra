#!/usr/bin/env bash
# REN-01 · Prueba de carga sostenida desde Azure (misma región que las apps), para no medir la latencia de internet.
#
# Uso, en Azure Cloud Shell (Bash):
#   ./scripts/ren-01-carga.sh preparar    # auction y realtime a 1 vCPU / 2 GiB con 2 réplicas fijas
#   ./scripts/ren-01-carga.sh restaurar   # borra el contenedor y devuelve CPU, memoria y réplicas a lo que había
#   ./scripts/ren-01-carga.sh resultado   # salida de un contenedor de carga antiguo, si quedó alguno
#
# La carga y la certificación ya NO se corren desde aquí: 'correr' y 'correr-aqui' usaban MODO=sostenida de
# verificacion/carga-sala.mjs, que el generador oficial retiró (infra #6), y daban un veredicto propio. El flujo
# oficial está en verificacion/ren01 (preparar-ren01.mjs + evidencia-ren01/EJECUTAR-QA.ps1, ver
# evidencia-ren01/EJECUCION-FORMAL.md): valida que el destino sea QA, exige la carga completa y certifica con
# aceptacion.json/INFORME.md. Variables opcionales: RESOURCE_GROUP, REGION.
set -euo pipefail

GRUPO="${RESOURCE_GROUP:-cafeorbe-org}"
REGION="${REGION:-eastus2}"
CONTENEDOR="cafeorbe-carga-ren01"
APPS=(auction-service realtime-gateway)
ESTADO="${HOME}/.cafeorbe-ren01-estado"

command -v az >/dev/null || { echo "Falta Azure CLI (az): usa Azure Cloud Shell." >&2; exit 1; }
az extension add --name containerapp --upgrade --only-show-errors >/dev/null
# La extensión avisa en cada comando que cambió su comportamiento: se ocultan solo esos avisos.
az() { command az "$@" --only-show-errors; }

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
    # Una línea por app: nombre, CPU, memoria, mínimo y máximo de réplicas (tsv de una lista da un valor por línea).
    az containerapp show -n "$app" -g "$GRUPO" --query "[name, properties.template.containers[0].resources.cpu, properties.template.containers[0].resources.memory, properties.template.scale.minReplicas, properties.template.scale.maxReplicas]" -o tsv | paste -sd' ' >> "$ESTADO"
  done
  echo "Configuración actual guardada en $ESTADO:"
  column -t "$ESTADO"
  for app in "${APPS[@]}"; do
    echo "→ $app: 1 vCPU / 2 GiB, 2 réplicas fijas"
    az containerapp update -n "$app" -g "$GRUPO" --cpu 1 --memory 2Gi --min-replicas 2 --max-replicas 2 -o none
  done
  # El ambiente express no informa revisiones: se confirma la CPU aplicada y que la app responda readiness.
  echo "Esperando a que las apps respondan con la configuración nueva…"
  local cpu fqdn listo
  for app in "${APPS[@]}"; do
    listo=no
    fqdn="$(url "$app")"
    for _ in $(seq 1 30); do
      cpu="$(az containerapp show -n "$app" -g "$GRUPO" --query "properties.template.containers[0].resources.cpu" -o tsv)"
      if [[ "$cpu" == 1* ]] && curl -fsS -m 10 -o /dev/null "https://$fqdn/actuator/health/readiness"; then
        listo=si
        break
      fi
      sleep 10
    done
    if [[ "$listo" == si ]]; then
      echo "  $app: ${cpu} vCPU y readiness UP"
    else
      echo "  $app: no se pudo confirmar (CPU ${cpu:-?}); revísalo en el portal antes de correr" >&2
    fi
  done
  echo "✓ Listo. Sigue con el flujo oficial: verificacion/ren01/evidencia-ren01/EJECUCION-FORMAL.md"
}

# Retirado: la carga y la certificación de REN-01 se hacen con el flujo oficial (ver cabecera).
retirado() {
  cat >&2 <<'AVISO'
'correr' y 'correr-aqui' se retiraron: usaban MODO=sostenida (ya no existe en el generador oficial) y
certificaban por su cuenta. Para REN-01 usa el flujo oficial, desde Cloud Shell:

  cd verificacion/ren01
  node preparar-ren01.mjs                     # 200 compradores y una subasta EN_CURSO
  export REN01_SUBASTA=$(cat .subasta-ren01)
  pwsh -NoProfile -File ./evidencia-ren01/EJECUTAR-QA.ps1

Detalle y criterios de aceptación: verificacion/ren01/evidencia-ren01/EJECUCION-FORMAL.md
AVISO
  exit 2
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
  # Se leen los valores de a cinco (nombre, CPU, memoria, mínimo, máximo), sin importar si están en una o varias
  # líneas: así también sirve el archivo de la primera versión del script, que guardaba un valor por línea.
  local -a valores
  read -r -d '' -a valores < "$ESTADO" || true
  for ((i = 0; i + 4 < ${#valores[@]}; i += 5)); do
    local app="${valores[i]}" cpu="${valores[i+1]}" memoria="${valores[i+2]}" minimo="${valores[i+3]}" maximo="${valores[i+4]}"
    echo "→ $app: ${cpu} vCPU / ${memoria}, réplicas ${minimo}–${maximo}"
    az containerapp update -n "$app" -g "$GRUPO" --cpu "$cpu" --memory "$memoria" --min-replicas "$minimo" --max-replicas "$maximo" -o none
  done
  rm -f "$ESTADO"
  echo "✓ Configuración restaurada."
}

case "${1:-}" in
  preparar) preparar ;;
  correr|correr-aqui) retirado ;;
  resultado) resultado ;;
  restaurar) restaurar ;;
  *) echo "Uso: $0 preparar|restaurar|resultado" >&2; exit 2 ;;
esac
