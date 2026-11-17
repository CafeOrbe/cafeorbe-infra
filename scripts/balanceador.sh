#!/usr/bin/env bash
# CaféOrbe · balanceador de carga NGINX (restricción tecnológica de DIS-01). Ver docs/BALANCEADOR.md.
#
# Uso, en Azure Cloud Shell (Bash), desde la raíz de cafeorbe-infra:
#   ./scripts/balanceador.sh crear        # instancias B, imagen NGINX y Container App cafeorbe-lb
#   ./scripts/balanceador.sh sincronizar  # copia imagen y variables de A a B (después de cada despliegue)
#   ./scripts/balanceador.sh estado       # apps, réplicas, imágenes y URL del balanceador
#   ./scripts/balanceador.sh probar       # 40 peticiones: reparto entre A y B por la cabecera X-CafeOrbe-Instancia
#   ./scripts/balanceador.sh borrar       # elimina cafeorbe-lb y las instancias B (pide confirmación)
#
# Variables opcionales: RESOURCE_GROUP (cafeorbe-org), ENTORNO (cafeorbe-qa), B_MIN (2), B_MAX (4),
# LB_MIN (2), LB_MAX (4), ETIQUETA (fecha y hora UTC).
set -euo pipefail

GRUPO="${RESOURCE_GROUP:-cafeorbe-org}"
ENTORNO="${ENTORNO:-cafeorbe-qa}"
LB="cafeorbe-lb"
B_MIN="${B_MIN:-2}" B_MAX="${B_MAX:-4}"
LB_MIN="${LB_MIN:-2}" LB_MAX="${LB_MAX:-4}"
ETIQUETA="${ETIQUETA:-$(date -u +%Y%m%dT%H%M%SZ)}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
# Instancia A (la que despliegan los pipelines) → instancia B (copia que solo existe detrás del balanceador).
PARES=("api-gateway:api-gateway-b" "realtime-gateway:realtime-gateway-b")

command -v az >/dev/null || { echo "Falta Azure CLI (az): usa Azure Cloud Shell." >&2; exit 1; }
command -v jq >/dev/null || { echo "Falta jq." >&2; exit 1; }
# shellcheck disable=SC2218 # 'command' llama al az real, no a la función de abajo.
command az extension add --name containerapp --upgrade --only-show-errors >/dev/null
az() { command az "$@" --only-show-errors; }

TEMPORALES=()
limpiar() { if ((${#TEMPORALES[@]})); then rm -f -- "${TEMPORALES[@]}"; fi; }
trap limpiar EXIT
temporal() { local f; f="$(mktemp)"; chmod 600 "$f"; TEMPORALES+=("$f"); echo "$f"; }

existe() { az containerapp show -n "$1" -g "$GRUPO" -o none 2>/dev/null; }
fqdn() { az containerapp show -n "$1" -g "$GRUPO" --query properties.configuration.ingress.fqdn -o tsv; }

# Crea la instancia B como copia de A: misma imagen, variables, secretos, ingreso y sondas.
# Los secretos se leen y se escriben solo en archivos temporales con permisos 600 que se borran al salir.
clonar() {
  local origen="$1" destino="$2" actual secretos nuevo
  if existe "$destino"; then echo "  $destino ya existe: se conserva (usa 'sincronizar' para actualizarla)"; return; fi
  actual="$(temporal)" secretos="$(temporal)" nuevo="$(temporal)"
  az containerapp show -n "$origen" -g "$GRUPO" -o json >"$actual"
  if jq -e '[.properties.configuration.registries[]? | select(.identity != null and .identity != "")] | length > 0' "$actual" >/dev/null; then
    echo "  $origen descarga su imagen con identidad administrada: dale a $destino el rol AcrPull antes de crearla." >&2
    exit 1
  fi
  az containerapp secret list -n "$origen" -g "$GRUPO" --show-values -o json >"$secretos"
  jq --arg nombre "$destino" --slurpfile secretos "$secretos" --argjson min "$B_MIN" --argjson max "$B_MAX" '
    { location: .location, name: $nombre,
      properties: {
        environmentId: (.properties.environmentId // .properties.managedEnvironmentId),
        configuration: (.properties.configuration
          | del(.ingress.fqdn)
          | .ingress.traffic = [{ "latestRevision": true, "weight": 100 }]
          | .secrets = ($secretos[0] | map({ name, value }))),
        template: (.properties.template
          | del(.revisionSuffix)
          | .scale.minReplicas = $min
          | .scale.maxReplicas = $max) } }' "$actual" >"$nuevo"
  echo "  → $destino: copia de $origen con $B_MIN–$B_MAX réplicas"
  az containerapp create -n "$destino" -g "$GRUPO" --yaml "$nuevo" -o none
}

crear() {
  echo "1/3 · Instancias B de los servicios de entrada"
  local par
  for par in "${PARES[@]}"; do clonar "${par%%:*}" "${par##*:}"; done

  echo "2/3 · Imagen del balanceador ($ETIQUETA)"
  local servidor registro usuario clave
  servidor="$(az containerapp show -n api-gateway -g "$GRUPO" --query 'properties.configuration.registries[0].server' -o tsv)"
  registro="${servidor%%.*}"
  az acr build -r "$registro" -t "cafeorbe-lb:$ETIQUETA" "$RAIZ/balanceador" -o none
  usuario="$(az acr credential show -n "$registro" --query username -o tsv)"
  clave="$(az acr credential show -n "$registro" --query 'passwords[0].value' -o tsv)"

  echo "3/3 · Container App $LB"
  local hosts=(
    "API_A_HOST=$(fqdn api-gateway)" "API_B_HOST=$(fqdn api-gateway-b)"
    "WS_A_HOST=$(fqdn realtime-gateway)" "WS_B_HOST=$(fqdn realtime-gateway-b)"
  )
  if existe "$LB"; then
    az containerapp update -n "$LB" -g "$GRUPO" --image "$servidor/cafeorbe-lb:$ETIQUETA" \
      --min-replicas "$LB_MIN" --max-replicas "$LB_MAX" --set-env-vars "${hosts[@]}" -o none
  else
    az containerapp create -n "$LB" -g "$GRUPO" --environment "$ENTORNO" \
      --image "$servidor/cafeorbe-lb:$ETIQUETA" \
      --registry-server "$servidor" --registry-username "$usuario" --registry-password "$clave" \
      --ingress external --target-port 8080 \
      --cpu 0.25 --memory 0.5Gi --min-replicas "$LB_MIN" --max-replicas "$LB_MAX" \
      --env-vars "${hosts[@]}" -o none
  fi
  echo "✓ Balanceador: https://$(fqdn "$LB")"
  echo "  Siguiente: ./scripts/balanceador.sh probar · luego apunta la web (Vercel) a esa URL: ver docs/BALANCEADOR.md"
}

# Los pipelines solo despliegan la instancia A: después de cada despliegue se copia su imagen y sus variables a B.
sincronizar() {
  local par origen destino imagen
  for par in "${PARES[@]}"; do
    origen="${par%%:*}" destino="${par##*:}"
    existe "$destino" || { echo "  $destino no existe: ejecuta 'crear'" >&2; continue; }
    imagen="$(az containerapp show -n "$origen" -g "$GRUPO" --query 'properties.template.containers[0].image' -o tsv)"
    mapfile -t variables < <(az containerapp show -n "$origen" -g "$GRUPO" -o json \
      | jq -r '.properties.template.containers[0].env[]? | select(.value != null) | "\(.name)=\(.value)"')
    echo "  → $destino: ${imagen##*/} y ${#variables[@]} variables de $origen"
    az containerapp update -n "$destino" -g "$GRUPO" --image "$imagen" --set-env-vars "${variables[@]}" -o none
  done
}

estado() {
  local app
  for app in "$LB" api-gateway api-gateway-b realtime-gateway realtime-gateway-b; do
    if existe "$app"; then
      az containerapp show -n "$app" -g "$GRUPO" --query "{app:name, imagen:properties.template.containers[0].image, cpu:properties.template.containers[0].resources.cpu, min:properties.template.scale.minReplicas, max:properties.template.scale.maxReplicas}" -o tsv \
        | awk -F'\t' '{ n=split($2,p,"/"); printf "%-20s %-40s cpu=%s réplicas=%s–%s\n", $1, p[n], $3, $4, $5 }'
    else
      printf "%-20s (no existe)\n" "$app"
    fi
  done
  existe "$LB" && echo "URL del balanceador: https://$(fqdn "$LB")"
}

probar() {
  local url
  url="https://$(fqdn "$LB")"
  echo "40 lecturas a $url/actuator/health/readiness (estado HTTP · instancia que respondió):"
  for _ in $(seq 1 40); do
    curl -s -o /dev/null -D - -m 10 "$url/actuator/health/readiness" | tr -d '\r' \
      | awk '/^HTTP/{c=$2} tolower($1)=="x-cafeorbe-instancia:"{i=$2} END{print c, i}'
  done | sort | uniq -c
  echo "WebSocket sin ticket (debe responder realtime con 4xx, no el balanceador con 5xx):"
  curl -s -o /dev/null -w "  HTTP %{http_code}\n" --http1.1 -m 10 -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$url/ws/salas/prueba"
}

borrar() {
  read -r -p "Se eliminan $LB, api-gateway-b y realtime-gateway-b (la web debe volver a las URL directas). Escribe 'borrar': " r
  [[ "$r" == borrar ]] || { echo "Cancelado."; exit 1; }
  local app
  for app in "$LB" api-gateway-b realtime-gateway-b; do
    existe "$app" && az containerapp delete -n "$app" -g "$GRUPO" -y -o none && echo "  $app eliminada"
  done
}

case "${1:-}" in
  crear) crear ;;
  sincronizar) sincronizar ;;
  estado) estado ;;
  probar) probar ;;
  borrar) borrar ;;
  *) echo "Uso: $0 crear|sincronizar|estado|probar|borrar" >&2; exit 2 ;;
esac
