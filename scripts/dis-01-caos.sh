#!/usr/bin/env bash
# Prueba de caos de DIS-01 sobre auction-service.
# Mata el proceso principal de una réplica, mientras consulta una ruta real, y
# comprueba que el balanceador mantiene el servicio y Azure repone la réplica.
# Uso: INTERNAL_TOKEN=... ./scripts/dis-01-caos.sh [qa|prod]
set -euo pipefail

AMBIENTE="${1:-qa}"
GRUPO_RECURSOS="${RESOURCE_GROUP:-cafeorbe-org}"
MUESTRAS="${DIS01_MUESTRAS:-150}"
INTERVALO="${DIS01_INTERVALO:-0.2}"
: "${INTERNAL_TOKEN:?Define INTERNAL_TOKEN para llamar auction-service sin exponer su valor}"

case "$AMBIENTE" in
  qa) APP="auction-service" ;;
  prod) APP="auction-service-prod" ;;
  *) echo "Uso: $0 [qa|prod]" >&2; exit 2 ;;
esac

command -v az >/dev/null || { echo "Falta Azure CLI (az)." >&2; exit 1; }
command -v jq >/dev/null || { echo "Falta jq." >&2; exit 1; }
command -v curl >/dev/null || { echo "Falta curl." >&2; exit 1; }

az extension add --name containerapp --upgrade --only-show-errors

revision="$(az containerapp revision list --name "$APP" --resource-group "$GRUPO_RECURSOS" \
  --query '[?properties.active].name | [0]' --output tsv)"
fqdn="$(az containerapp show --name "$APP" --resource-group "$GRUPO_RECURSOS" \
  --query properties.configuration.ingress.fqdn --output tsv)"
contenedor="$(az containerapp show --name "$APP" --resource-group "$GRUPO_RECURSOS" \
  --query properties.template.containers[0].name --output tsv)"
mapfile -t replicas_antes < <(az containerapp replica list --name "$APP" --resource-group "$GRUPO_RECURSOS" \
  --revision "$revision" --query '[].name' --output tsv)

if ((${#replicas_antes[@]} < 2)); then
  echo "Se necesitan al menos 2 réplicas; hay ${#replicas_antes[@]}. Ejecuta dis-01-configurar.sh primero." >&2
  exit 1
fi

victima="${replicas_antes[0]}"
ruta="https://$fqdn/api/subastas?estado=programada"

codigo_previo="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 \
  --header "X-Internal-Token: $INTERNAL_TOKEN" \
  --header 'X-User-Id: 5e1f0c1a-0000-4000-8000-00000000d101' \
  --header 'X-User-Name: caos-dis-01' \
  --header 'X-User-Role: COMPRADOR' \
  "$ruta" || true)"
if [[ "$codigo_previo" != "200" ]]; then
  echo "La ruta de control no estaba sana antes de la prueba (HTTP $codigo_previo)." >&2
  exit 1
fi
ultimo_exito_ms="$(date +%s%3N)"
max_brecha_ms=0

echo "DIS-01 · ambiente=$AMBIENTE app=$APP revision=$revision réplicas=${#replicas_antes[@]}"
echo "Se terminará una réplica y se harán $MUESTRAS consultas a una ruta real de auction."

# La desconexión de exec es el resultado esperado: PID 1 termina y Azure crea otra réplica.
# - El kernel ignora SIGKILL a PID 1 desde su propio espacio de procesos: `kill -9 1` no hacía nada. La JVM
#   atiende SIGTERM y termina, así que se envía TERM.
# - `az containerapp exec` necesita una terminal (sin TTY no ejecuta el comando): se usa `script`.
# - --command se parte por espacios: no admite `sh -c '...'` con comillas.
script -qec "timeout 25s az containerapp exec --name $APP --resource-group $GRUPO_RECURSOS --revision $revision --replica $victima --container $contenedor --command 'kill -TERM 1'" /dev/null >/dev/null 2>&1 &
pid_caos=$!

errores=0
for ((i = 1; i <= MUESTRAS; i++)); do
  codigo="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 \
    --header "X-Internal-Token: $INTERNAL_TOKEN" \
    --header 'X-User-Id: 5e1f0c1a-0000-4000-8000-00000000d101' \
    --header 'X-User-Name: caos-dis-01' \
    --header 'X-User-Role: COMPRADOR' \
    "$ruta" || true)"
  if [[ "$codigo" == "200" ]]; then
    ahora_ms="$(date +%s%3N)"
    brecha_ms="$((ahora_ms - ultimo_exito_ms))"
    if ((brecha_ms > max_brecha_ms)); then
      max_brecha_ms="$brecha_ms"
    fi
    ultimo_exito_ms="$ahora_ms"
  else
    errores=$((errores + 1))
  fi
  sleep "$INTERVALO"
done
brecha_final_ms="$(( $(date +%s%3N) - ultimo_exito_ms ))"
if ((brecha_final_ms > max_brecha_ms)); then
  max_brecha_ms="$brecha_final_ms"
fi
wait "$pid_caos" || true

reposicion_en=""
for ((i = 0; i < 36; i++)); do
  mapfile -t replicas_despues < <(az containerapp replica list --name "$APP" --resource-group "$GRUPO_RECURSOS" \
    --revision "$revision" --query '[].name' --output tsv)
  if ((${#replicas_despues[@]} >= 2)) && [[ " ${replicas_despues[*]} " != *" $victima "* ]]; then
    reposicion_en="$i"
    break
  fi
  sleep 5
done

porcentaje_errores="$(awk -v e="$errores" -v t="$MUESTRAS" 'BEGIN { printf "%.2f", (e * 100) / t }')"
echo "Resultado: errores=$errores/$MUESTRAS (${porcentaje_errores} %), brecha máxima entre respuestas sanas=${max_brecha_ms} ms."
echo "Réplica eliminada: $victima"
echo "Reposición observada: ${reposicion_en:-no} intervalo(s) de 5 s."

awk -v p="$porcentaje_errores" 'BEGIN { exit !(p < 2.0) }' || {
  echo "Falla DIS-01: los errores fueron ${porcentaje_errores} %, el límite es menor de 2 %." >&2
  exit 1
}
if ((max_brecha_ms >= 10000)); then
  echo "Falla DIS-01: hubo una brecha sin respuestas sanas de ${max_brecha_ms} ms (límite: menos de 10 s)." >&2
  exit 1
fi
if [[ -z "$reposicion_en" ]]; then
  echo "Falla DIS-01: Azure no repuso la segunda réplica en 3 minutos." >&2
  exit 1
fi

echo "✓ El balanceador mantuvo auction-service disponible y Azure repuso la réplica."
