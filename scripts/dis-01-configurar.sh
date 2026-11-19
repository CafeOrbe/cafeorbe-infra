#!/usr/bin/env bash
# Configura la topología y las sondas explícitas del escenario DIS-01.
# Uso: ./scripts/dis-01-configurar.sh [qa|prod]
set -euo pipefail

AMBIENTE="${1:-qa}"
GRUPO_RECURSOS="${RESOURCE_GROUP:-cafeorbe-org}"

case "$AMBIENTE" in
  qa) SUFIJO="" ;;
  prod) SUFIJO="-prod" ;;
  *)
    echo "Uso: $0 [qa|prod]" >&2
    exit 2
    ;;
esac

command -v az >/dev/null || { echo "Falta Azure CLI (az)." >&2; exit 1; }
command -v jq >/dev/null || { echo "Falta jq." >&2; exit 1; }

az extension add --name containerapp --upgrade --only-show-errors

TEMPORALES=()
limpiar() {
  if ((${#TEMPORALES[@]})); then
    rm -f -- "${TEMPORALES[@]}"
  fi
}
trap limpiar EXIT

configurar() {
  local servicio="$1"
  local puerto="$2"
  local minimas="$3" maximas="$4" concurrencia="$5"
  local app="${servicio}${SUFIJO}"
  local actual actualizado
  actual="$(mktemp)"
  actualizado="$(mktemp)"
  TEMPORALES+=("$actual" "$actualizado")
  chmod 600 "$actual" "$actualizado"

  echo "→ $app: $minimas–$maximas réplicas y sondas HTTP en el puerto $puerto"
  az containerapp show --name "$app" --resource-group "$GRUPO_RECURSOS" --output json >"$actual"

  # Escalado: el ambiente express solo admite la regla HTTP (las reglas de CPU o TCP se rechazan con
  # ExpressCustomScaleRulesNotSupported). La CPU tampoco distingue la carga normal de la duplicada (12-20 % en las
  # dos, 19 nov): el límite es PostgreSQL y el bloqueo de la fila. Lo que sí crece es la concurrencia en auction:
  # cada puja llega de realtime como POST y, con la carga duplicada, hace fila en el bloqueo. Con 20 pujas/s hay
  # unas 3 peticiones concurrentes por réplica; el umbral de auction es 10 para que la carga duplicada escale.
  # Readiness cada 2 s y 2 fallos. En Express se observó tráfico hacia contenedores que
  # reiniciaban pese a estas sondas; con dos réplicas base queda una sana durante la caída y el escalado repone la otra.
  jq --argjson puerto "$puerto" --argjson minimas "$minimas" --argjson maximas "$maximas" --arg servicio "$servicio" \
    --arg concurrencia "$concurrencia" '
    .properties.template.scale.minReplicas = $minimas
    | .properties.template.scale.maxReplicas = $maximas
    | if $servicio == "auction-service" or $servicio == "realtime-gateway" then
        .properties.template.containers[0].resources.cpu = 0.5
        | .properties.template.containers[0].resources.memory = "1Gi"
      else . end
    | if $servicio == "auction-service" then
        .properties.template.containers[0].env = (
          (.properties.template.containers[0].env // [] | map(select(.name != "DB_POOL_MAX")))
          + [{"name": "DB_POOL_MAX", "value": "2"}]
        )
      else . end
    | .properties.template.scale.rules = [
        {
          "name": "http-concurrency",
          "http": {"metadata": {"concurrentRequests": $concurrencia}}
        }
      ]
    | .properties.template.containers[0].probes = [
        {
          "type": "Startup",
          "httpGet": {"path": "/actuator/health/liveness", "port": $puerto, "scheme": "HTTP"},
          "initialDelaySeconds": 5,
          "periodSeconds": 5,
          "timeoutSeconds": 3,
          "failureThreshold": 36,
          "successThreshold": 1
        },
        {
          "type": "Liveness",
          "httpGet": {"path": "/actuator/health/liveness", "port": $puerto, "scheme": "HTTP"},
          "initialDelaySeconds": 30,
          "periodSeconds": 10,
          "timeoutSeconds": 3,
          "failureThreshold": 3,
          "successThreshold": 1
        },
        {
          "type": "Readiness",
          "httpGet": {"path": "/actuator/health/readiness", "port": $puerto, "scheme": "HTTP"},
          "initialDelaySeconds": 10,
          "periodSeconds": 2,
          "timeoutSeconds": 2,
          "failureThreshold": 2,
          "successThreshold": 1
        }
      ]
  ' "$actual" >"$actualizado"

  az containerapp update \
    --name "$app" \
    --resource-group "$GRUPO_RECURSOS" \
    --yaml "$actualizado" \
    --only-show-errors >/dev/null
}

configurar api-gateway 8080 2 4 20
configurar auction-service 8082 2 4 10
configurar realtime-gateway 8085 2 4 20

echo "✓ DIS-01 configurado en $AMBIENTE. Ejecuta scripts/dis-01-verificar.sh $AMBIENTE para reunir evidencia."
