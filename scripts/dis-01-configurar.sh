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
  local app="${servicio}${SUFIJO}"
  local actual actualizado
  actual="$(mktemp)"
  actualizado="$(mktemp)"
  TEMPORALES+=("$actual" "$actualizado")
  chmod 600 "$actual" "$actualizado"

  echo "→ $app: 2–4 réplicas y sondas HTTP en el puerto $puerto"
  az containerapp show --name "$app" --resource-group "$GRUPO_RECURSOS" --output json >"$actual"

  jq --argjson puerto "$puerto" '
    .properties.template.scale.minReplicas = 2
    | .properties.template.scale.maxReplicas = 4
    | .properties.template.scale.rules = [
        {
          "name": "http-concurrency",
          "http": {"metadata": {"concurrentRequests": "20"}}
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
          "periodSeconds": 5,
          "timeoutSeconds": 3,
          "failureThreshold": 3,
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

configurar api-gateway 8080
configurar auction-service 8082
configurar realtime-gateway 8085

echo "✓ DIS-01 configurado en $AMBIENTE. Ejecuta scripts/dis-01-verificar.sh $AMBIENTE para reunir evidencia."
