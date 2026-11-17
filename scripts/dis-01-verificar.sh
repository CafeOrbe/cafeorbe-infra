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
  min_esperado=4 max_esperado=6
  if [[ "$servicio" == api-gateway ]]; then min_esperado=2 max_esperado=4; fi
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
  estado="$(curl --fail --silent --show-error --max-time 10 "https://$fqdn/actuator/health/readiness" || true)"

  printf '%-20s min=%s max=%s listas=%s cpu=%s memoria=%s pool=%s concurrencia=%s sondas=%s readiness=%s\n' \
    "$app" "$minimas" "$maximas" "$replicas" "$cpu" "$memoria" "${pool:--}" "$concurrencia" "$sondas" "$estado"

  if [[ "$minimas" != "$min_esperado" || "$maximas" != "$max_esperado" || "$replicas" -lt "$min_esperado" || "$replicas" -gt "$max_esperado" || "$concurrencia" != "20" \
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

echo "✓ Auction/realtime: 4–6 réplicas de 0,5 vCPU / 1 GiB; API: 2–4; sondas y readiness UP."

# Con 4–6 réplicas, 30 % por instancia es imposible. Se exige observar tráfico en al menos
# cuatro instancias y se informa la distribución; no se certifica equidad mediante estas 60 muestras.
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

if ((${#atendidas[@]} < 4)); then
  echo "La prueba de reparto exige al menos 4 instancias y observó ${#atendidas[@]}." >&2
  exit 1
fi
for instancia in "${!atendidas[@]}"; do
  porcentaje=$((atendidas["$instancia"] * 100 / muestras))
  echo "auction instancia=$instancia peticiones=${atendidas[$instancia]}/$muestras (${porcentaje} %)"
done

echo "✓ Se observó tráfico en ${#atendidas[@]} instancias de auction; distribución informativa."
