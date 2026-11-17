#!/usr/bin/env bash
# CaféOrbe · balanceador de carga Azure Front Door (restricción tecnológica de DIS-01). Ver docs/BALANCEADOR.md.
#
# Uso, en Azure Cloud Shell (Bash), desde la raíz de cafeorbe-infra:
#   ./scripts/front-door.sh crear     # instancias B, perfil de Front Door, grupos de orígenes, orígenes y rutas
#   ./scripts/front-door.sh estado    # orígenes, pesos, sondas y salud de cada origen
#   ./scripts/front-door.sh probar    # lecturas y handshake de WebSocket a través de Front Door
#   ./scripts/front-door.sh sincronizar  # copia imagen y variables de A a B (después de cada despliegue)
#   ./scripts/front-door.sh borrar    # elimina el perfil de Front Door y las instancias B (pide confirmación)
#
# Variables opcionales: RESOURCE_GROUP (cafeorbe-org), B_MIN (2), B_MAX (4).
set -euo pipefail

GRUPO="${RESOURCE_GROUP:-cafeorbe-org}"
PERFIL="cafeorbe-fd"
ENDPOINT="cafeorbe"
B_MIN="${B_MIN:-2}" B_MAX="${B_MAX:-4}"
# Instancia A (la que despliegan los pipelines) → instancia B (copia que solo recibe tráfico por Front Door).
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

existe_app() { az containerapp show -n "$1" -g "$GRUPO" -o none 2>/dev/null; }
fqdn() { az containerapp show -n "$1" -g "$GRUPO" --query properties.configuration.ingress.fqdn -o tsv; }

# Crea la instancia B como copia de A (misma imagen, variables, secretos, ingreso y sondas).
# SPRING_APPLICATION_NAME=<nombre>-b separa sus métricas en Grafana: el tablero y la alerta "Réplica caída"
# siguen contando solo las réplicas de A. Los secretos solo tocan archivos temporales 600 que se borran al salir.
clonar() {
  local origen="$1" destino="$2" actual secretos nuevo
  if existe_app "$destino"; then echo "  $destino ya existe: se conserva (usa 'sincronizar' para actualizarla)"; return; fi
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
          | .scale.maxReplicas = $max
          | .containers[0].env = ((.containers[0].env // [] | map(select(.name != "SPRING_APPLICATION_NAME")))
              + [{ "name": "SPRING_APPLICATION_NAME", "value": $nombre }])) } }' "$actual" >"$nuevo"
  echo "  → $destino: copia de $origen con $B_MIN–$B_MAX réplicas"
  az containerapp create -n "$destino" -g "$GRUPO" --yaml "$nuevo" -o none
}

# Grupo de orígenes con sonda HTTPS a la readiness de Spring y reparto 50/50 (mismo peso y prioridad).
grupo_origenes() {
  local nombre="$1"
  if az afd origin-group show -g "$GRUPO" --profile-name "$PERFIL" --origin-group-name "$nombre" -o none 2>/dev/null; then return; fi
  echo "  → grupo de orígenes $nombre"
  az afd origin-group create -g "$GRUPO" --profile-name "$PERFIL" --origin-group-name "$nombre" \
    --probe-request-type GET --probe-protocol Https --probe-path /actuator/health/readiness \
    --probe-interval-in-seconds 10 --sample-size 4 --successful-samples-required 3 \
    --additional-latency-in-milliseconds 1000 -o none
}

origen() {
  local grupo="$1" nombre="$2" host="$3"
  if az afd origin show -g "$GRUPO" --profile-name "$PERFIL" --origin-group-name "$grupo" --origin-name "$nombre" -o none 2>/dev/null; then return; fi
  echo "  → origen $nombre ($host) en $grupo"
  az afd origin create -g "$GRUPO" --profile-name "$PERFIL" --origin-group-name "$grupo" --origin-name "$nombre" \
    --host-name "$host" --origin-host-header "$host" --http-port 80 --https-port 443 \
    --priority 1 --weight 500 --enabled-state Enabled --enforce-certificate-name-check true -o none
}

ruta() {
  local nombre="$1" grupo="$2" patron="$3"
  if az afd route show -g "$GRUPO" --profile-name "$PERFIL" --endpoint-name "$ENDPOINT" --route-name "$nombre" -o none 2>/dev/null; then return; fi
  echo "  → ruta $nombre: $patron → $grupo"
  az afd route create -g "$GRUPO" --profile-name "$PERFIL" --endpoint-name "$ENDPOINT" --route-name "$nombre" \
    --origin-group "$grupo" --patterns-to-match "$patron" --supported-protocols Https \
    --forwarding-protocol HttpsOnly --https-redirect Disabled --link-to-default-domain Enabled -o none
}

host_endpoint() { az afd endpoint show -g "$GRUPO" --profile-name "$PERFIL" --endpoint-name "$ENDPOINT" --query hostName -o tsv; }

crear() {
  echo "1/3 · Instancias B de los servicios de entrada"
  local par
  for par in "${PARES[@]}"; do clonar "${par%%:*}" "${par##*:}"; done

  echo "2/3 · Perfil y endpoint de Azure Front Door"
  # Registrar el proveedor exige permisos sobre la suscripción; si ya está registrado no hace falta.
  local registro
  registro="$(az provider show --namespace Microsoft.Cdn --query registrationState -o tsv 2>/dev/null || echo desconocido)"
  if [[ "$registro" != Registered ]]; then
    echo "  El proveedor Microsoft.Cdn está en estado '$registro'. Debe registrarlo quien administre la suscripción:" >&2
    echo "    az provider register --namespace Microsoft.Cdn   (o portal: Suscripción → Proveedores de recursos)" >&2
    exit 1
  fi
  if ! az afd profile show -g "$GRUPO" --profile-name "$PERFIL" -o none 2>/dev/null; then
    az afd profile create -g "$GRUPO" --profile-name "$PERFIL" --sku Standard_AzureFrontDoor -o none
  fi
  if ! az afd endpoint show -g "$GRUPO" --profile-name "$PERFIL" --endpoint-name "$ENDPOINT" -o none 2>/dev/null; then
    az afd endpoint create -g "$GRUPO" --profile-name "$PERFIL" --endpoint-name "$ENDPOINT" --enabled-state Enabled -o none
  fi

  echo "3/3 · Grupos de orígenes, orígenes A/B y rutas"
  grupo_origenes og-api
  grupo_origenes og-ws
  origen og-api api-a "$(fqdn api-gateway)"
  origen og-api api-b "$(fqdn api-gateway-b)"
  origen og-ws realtime-a "$(fqdn realtime-gateway)"
  origen og-ws realtime-b "$(fqdn realtime-gateway-b)"
  ruta ruta-ws og-ws "/ws/*"
  ruta ruta-api og-api "/*"

  echo "✓ Balanceador: https://$(host_endpoint)"
  echo "  Front Door tarda entre 5 y 20 min en propagar la configuración: repite 'probar' hasta ver 200."
}

sincronizar() {
  local par origen destino imagen
  for par in "${PARES[@]}"; do
    origen="${par%%:*}" destino="${par##*:}"
    existe_app "$destino" || { echo "  $destino no existe: ejecuta 'crear'" >&2; continue; }
    imagen="$(az containerapp show -n "$origen" -g "$GRUPO" --query 'properties.template.containers[0].image' -o tsv)"
    mapfile -t variables < <(az containerapp show -n "$origen" -g "$GRUPO" -o json \
      | jq -r '.properties.template.containers[0].env[]? | select(.value != null and .name != "SPRING_APPLICATION_NAME") | "\(.name)=\(.value)"')
    echo "  → $destino: ${imagen##*/} y ${#variables[@]} variables de $origen"
    az containerapp update -n "$destino" -g "$GRUPO" --image "$imagen" \
      --set-env-vars "${variables[@]}" "SPRING_APPLICATION_NAME=$destino" -o none
  done
}

estado() {
  local grupo
  echo "Endpoint: https://$(host_endpoint)"
  for grupo in og-api og-ws; do
    echo "== $grupo"
    az afd origin-group show -g "$GRUPO" --profile-name "$PERFIL" --origin-group-name "$grupo" \
      --query "{sonda:healthProbeSettings.probePath, cadaSegundos:healthProbeSettings.probeIntervalInSeconds, muestras:loadBalancingSettings.sampleSize, exitosas:loadBalancingSettings.successfulSamplesRequired}" -o tsv
    az afd origin list -g "$GRUPO" --profile-name "$PERFIL" --origin-group-name "$grupo" \
      --query "[].{origen:name, host:hostName, peso:weight, prioridad:priority, estado:enabledState}" -o table
  done
  az afd route list -g "$GRUPO" --profile-name "$PERFIL" --endpoint-name "$ENDPOINT" \
    --query "[].{ruta:name, patron:join(',', patternsToMatch), grupo:originGroup.id, despliegue:deploymentStatus}" -o table \
    | sed -E 's#/subscriptions/.*/originGroups/##'
}

probar() {
  local url
  url="https://$(host_endpoint)"
  echo "20 lecturas a $url/actuator/health/readiness:"
  for _ in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code}\n" -m 10 "$url/actuator/health/readiness"; done | sort | uniq -c
  echo "WebSocket sin ticket (debe responder realtime con 4xx; 101 no aplica sin ticket):"
  curl -s -o /dev/null -w "  HTTP %{http_code}\n" --http1.1 -m 10 -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$url/ws/salas/prueba"
  echo "CORS desde la web:"
  curl -s -o /dev/null -D - -X OPTIONS "$url/api/subastas" -H "Origin: https://cafeorbe-web.vercel.app" \
    -H "Access-Control-Request-Method: GET" | tr -d '\r' | grep -iE "^HTTP|access-control-allow-origin" | sed 's/^/  /'
}

borrar() {
  read -r -p "Se eliminan el perfil $PERFIL, api-gateway-b y realtime-gateway-b (la web debe volver a las URL directas). Escribe 'borrar': " r
  [[ "$r" == borrar ]] || { echo "Cancelado."; exit 1; }
  az afd profile delete -g "$GRUPO" --profile-name "$PERFIL" --yes -o none 2>/dev/null && echo "  $PERFIL eliminado" || true
  local app
  for app in api-gateway-b realtime-gateway-b; do
    existe_app "$app" && az containerapp delete -n "$app" -g "$GRUPO" -y -o none && echo "  $app eliminada"
  done
}

case "${1:-}" in
  crear) crear ;;
  estado) estado ;;
  probar) probar ;;
  sincronizar) sincronizar ;;
  borrar) borrar ;;
  *) echo "Uso: $0 crear|estado|probar|sincronizar|borrar" >&2; exit 2 ;;
esac
