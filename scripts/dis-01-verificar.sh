#!/usr/bin/env bash
# Verificación no destructiva de la topología DIS-01.
# Uso: INTERNAL_TOKEN=... ./scripts/dis-01-verificar.sh [qa|prod]
set -euo pipefail

AMBIENTE="${1:-qa}"
GRUPO_RECURSOS="${RESOURCE_GROUP:-cafeorbe-org}"

case "$AMBIENTE" in
  qa) SUFIJO="" ;;
  prod) SUFIJO="-prod" ;;
  *) echo "Uso: $0 [qa|prod]" >&2; exit 2 ;;
esac

command -v az >/dev/null || { echo "Falta Azure CLI (az)." >&2; exit 1; }
command -v jq >/dev/null || { echo "Falta jq." >&2; exit 1; }
: "${INTERNAL_TOKEN:?Define INTERNAL_TOKEN para comprobar el reparto sin exponer su valor}"

fallos=0
for servicio in api-gateway auction-service realtime-gateway; do
  app="${servicio}${SUFIJO}"
  min_esperado=2 max_esperado=4
  configuracion="$(az containerapp show --name "$app" --resource-group "$GRUPO_RECURSOS" --output json)"
  minimas="$(jq -r '.properties.template.scale.minReplicas' <<<"$configuracion")"
  maximas="$(jq -r '.properties.template.scale.maxReplicas' <<<"$configuracion")"
  cpu="$(jq -r '.properties.template.containers[0].resources.cpu' <<<"$configuracion")"
  memoria="$(jq -r '.properties.template.containers[0].resources.memory' <<<"$configuracion")"
  pool="$(jq -r '.properties.template.containers[0].env[]? | select(.name == "DB_POOL_MAX") | .value' <<<"$configuracion")"
  fqdn="$(jq -r '.properties.configuration.ingress.fqdn' <<<"$configuracion")"
  revision="$(az containerapp revision list --name "$app" --resource-group "$GRUPO_RECURSOS" \
    --query '[?properties.active].name | [0]' --output tsv)"
  replicas="$(az containerapp replica list --name "$app" --resource-group "$GRUPO_RECURSOS" \
    --revision "$revision" --output json | jq '[.[] | select(.properties.containers[0].ready == true)] | length')"
  sondas="$(jq '[.properties.template.containers[0].probes[]?.type] | sort' <<<"$configuracion")"
  concurrencia="$(jq -r '.properties.template.scale.rules[]? | select(.name == "http-concurrency") | .http.metadata.concurrentRequests' <<<"$configuracion")"
  umbral_cpu="$(jq -r '.properties.template.scale.rules[]? | select(.name == "cpu-utilizacion") | .custom.metadata.value' <<<"$configuracion")"
  estado="$(curl --fail --silent --show-error --max-time 10 "https://$fqdn/actuator/health/readiness" || true)"

  printf '%-20s min=%s max=%s listas=%s cpu=%s memoria=%s pool=%s concurrencia=%s escala-cpu=%s sondas=%s readiness=%s\n' \
    "$app" "$minimas" "$maximas" "$replicas" "$cpu" "$memoria" "${pool:--}" "$concurrencia" "${umbral_cpu:--}" "$sondas" "$estado"

  if [[ "$minimas" != "$min_esperado" || "$maximas" != "$max_esperado" || "$replicas" -lt "$min_esperado" || "$replicas" -gt "$max_esperado" || "$concurrencia" != "20" || "$umbral_cpu" != "50" \
      || "$sondas" != *'"Startup"'* || "$sondas" != *'"Liveness"'* || "$sondas" != *'"Readiness"'* \
      || "$estado" != *'"UP"'* \
      || ( "$servicio" != api-gateway && ( "$cpu" != "0.5" || "$memoria" != "1Gi" ) ) \
      || ( "$servicio" == auction-service && "$pool" != "2" ) ]]; then
    fallos=$((fallos + 1))
  fi
done

if ((fallos)); then
  echo "DIS-01 no cumple en $fallos servicio(s)." >&2
  exit 1
fi

echo "✓ API, auction y realtime: 2–4 réplicas (auction y realtime de 0,5 vCPU / 1 GiB); sondas y readiness UP."

# Medida del PDF: con 2 réplicas, al menos 30 % de las peticiones llega a cada una.
# Si en ese momento hay más réplicas por escalado, se informa la distribución sin exigir el 30 %.
auction="auction-service${SUFIJO}"
auction_fqdn="$(az containerapp show --name "$auction" --resource-group "$GRUPO_RECURSOS" \
  --query properties.configuration.ingress.fqdn --output tsv)"
declare -A atendidas=()
muestras=60
for ((i = 0; i < muestras; i++)); do
  metricas="$(curl --fail --silent --show-error --max-time 10 \
    --header "X-Internal-Token: $INTERNAL_TOKEN" "https://$auction_fqdn/actuator/prometheus")"
  instancia="$(awk -F'instancia="' '/instancia="/ { split($2, parte, "\""); print parte[1]; exit }' <<<"$metricas")"
  if [[ -z "$instancia" ]]; then
    echo "No se encontró la etiqueta instancia en las métricas de auction." >&2
    exit 1
  fi
  atendidas["$instancia"]=$(( ${atendidas["$instancia"]:-0} + 1 ))
done

if ((${#atendidas[@]} < 2)); then
  echo "La prueba de reparto exige al menos 2 instancias y observó ${#atendidas[@]}." >&2
  exit 1
fi
reparto_bajo=0
for instancia in "${!atendidas[@]}"; do
  porcentaje=$((atendidas["$instancia"] * 100 / muestras))
  echo "auction instancia=$instancia peticiones=${atendidas[$instancia]}/$muestras (${porcentaje} %)"
  if ((porcentaje < 30)); then reparto_bajo=1; fi
done

if ((${#atendidas[@]} == 2 && reparto_bajo)); then
  echo "Con 2 réplicas, una recibió menos del 30 % de las peticiones." >&2
  exit 1
fi
echo "✓ Se observó tráfico en ${#atendidas[@]} instancias de auction."
