#!/usr/bin/env bash
# CaféOrbe · Azure Load Balancer con dos máquinas virtuales NGINX (restricción tecnológica de DIS-01).
# Ver docs/BALANCEADOR.md.
#
#   Navegador ──HTTPS/WSS──► Azure Load Balancer (IP pública + sonda) ──► VM 1 / VM 2 (NGINX + TLS)
#                                                                         └──► api-gateway / realtime-gateway
#
# Uso (Azure Cloud Shell o cualquier Bash con az), desde la raíz de cafeorbe-infra:
#   ./scripts/balanceador-azure.sh crear    # red, IP pública, balanceador, 2 VMs, certificado y NGINX
#   ./scripts/balanceador-azure.sh certificados  # repite el certificado y HTTPS en cada VM
#   ./scripts/balanceador-azure.sh estado   # balanceador, sonda, reglas y salud de cada VM
#   ./scripts/balanceador-azure.sh probar   # 20 lecturas (reparto por VM), WebSocket y CORS
#   ./scripts/balanceador-azure.sh apagar-vm 1|2    # detiene una VM (demostración de la sonda)
#   ./scripts/balanceador-azure.sh encender-vm 1|2
#   ./scripts/balanceador-azure.sh borrar   # elimina todo lo anterior (pide confirmación)
#
# Variables opcionales: RESOURCE_GROUP (cafeorbe-org), REGION (eastus2), ETIQUETA_DNS (cafeorbe-lb),
# TAMANOS_VM (lista de tamaños a probar en orden).
set -euo pipefail
# Git Bash en Windows convierte argumentos como /lb/salud o /subscriptions/... en rutas de disco.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"
# Con la conversión desactivada, curl en Windows no entiende /dev/null.
NULO=/dev/null; [[ "$(uname -s)" == MINGW* ]] && NULO=NUL

GRUPO="${RESOURCE_GROUP:-cafeorbe-org}"
REGION="${REGION:-eastus2}"
ETIQUETA_DNS="${ETIQUETA_DNS:-cafeorbe-lb}"
TAMANOS_VM="${TAMANOS_VM:-Standard_B2ats_v2 Standard_B1s Standard_D2s_v3}"
RED="cafeorbe-lb-vnet" SUBRED="vms" NSG="cafeorbe-lb-nsg"
IP="cafeorbe-lb-ip" LB="cafeorbe-lb" FRONTEND="publico" POOL="vms" SONDA="salud"
VMS=(cafeorbe-lb-vm1 cafeorbe-lb-vm2)
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"

command -v az >/dev/null || { echo "Falta Azure CLI (az)." >&2; exit 1; }
az() { command az "$@" --only-show-errors; }

dominio() { az network public-ip show -g "$GRUPO" -n "$IP" --query dnsSettings.fqdn -o tsv; }
fqdn_app() { az containerapp show -n "$1" -g "$GRUPO" --query properties.configuration.ingress.fqdn -o tsv; }

# Ejecuta un script Bash dentro de una VM (sin SSH) y muestra su salida.
en_vm() {
  local vm="$1" script="$2"
  az vm run-command invoke -g "$GRUPO" -n "$vm" --command-id RunShellScript --scripts "$script" \
    --query "value[0].message" -o tsv | sed -e '/^\[stdout\]$/d' -e 's/^\[stderr\]$/  (stderr)/' -e 's/^/    /'
}

red_y_balanceador() {
  echo "1/4 · Red, IP pública y Azure Load Balancer"
  if ! az network vnet show -g "$GRUPO" -n "$RED" -o none 2>/dev/null; then
    az network vnet create -g "$GRUPO" -n "$RED" -l "$REGION" --address-prefixes 10.60.0.0/16 \
      --subnet-name "$SUBRED" --subnet-prefixes 10.60.1.0/24 -o none
  fi
  if ! az network nsg show -g "$GRUPO" -n "$NSG" -o none 2>/dev/null; then
    az network nsg create -g "$GRUPO" -n "$NSG" -l "$REGION" -o none
    az network nsg rule create -g "$GRUPO" --nsg-name "$NSG" -n web --priority 100 --access Allow \
      --direction Inbound --protocol Tcp --source-address-prefixes Internet --destination-port-ranges 80 443 -o none
    az network vnet subnet update -g "$GRUPO" --vnet-name "$RED" -n "$SUBRED" --network-security-group "$NSG" -o none
  fi
  if ! az network public-ip show -g "$GRUPO" -n "$IP" -o none 2>/dev/null; then
    az network public-ip create -g "$GRUPO" -n "$IP" -l "$REGION" --sku Standard --allocation-method Static \
      --dns-name "$ETIQUETA_DNS" -o none
  fi
  if ! az network lb show -g "$GRUPO" -n "$LB" -o none 2>/dev/null; then
    az network lb create -g "$GRUPO" -n "$LB" -l "$REGION" --sku Standard --public-ip-address "$IP" \
      --frontend-ip-name "$FRONTEND" --backend-pool-name "$POOL" -o none
    # Sonda HTTP a NGINX de cada VM: cada 5 s; 2 fallos seguidos sacan a la VM del reparto.
    az network lb probe create -g "$GRUPO" --lb-name "$LB" -n "$SONDA" --protocol Http --port 80 \
      --path /lb/salud --interval 5 --probe-threshold 2 -o none
    local puerto
    for puerto in 443 80; do
      az network lb rule create -g "$GRUPO" --lb-name "$LB" -n "tcp-$puerto" --protocol Tcp \
        --frontend-port "$puerto" --backend-port "$puerto" --frontend-ip-name "$FRONTEND" \
        --backend-pool-name "$POOL" --probe-name "$SONDA" --idle-timeout 30 --enable-tcp-reset true \
        --disable-outbound-snat true -o none
    done
    # Salida a Internet de las VMs (paquetes, Let's Encrypt y Container Apps) por la misma IP pública.
    az network lb outbound-rule create -g "$GRUPO" --lb-name "$LB" -n salida --protocol All \
      --frontend-ip-configs "$FRONTEND" --address-pool "$POOL" --idle-timeout 15 --enable-tcp-reset true -o none
  fi
  echo "  Balanceador $LB en https://$(dominio)"
}

# Crea la VM, la agrega al pool del balanceador e instala NGINX con la configuración de puerto 80.
crear_vm() {
  local vm="$1" nic ipconfig http
  if ! az vm show -g "$GRUPO" -n "$vm" -o none 2>/dev/null; then
    # La capacidad de cada tamaño cambia por región y momento (SkuNotAvailable): se prueban en orden.
    local tamano creada=no
    for tamano in $TAMANOS_VM; do
      echo "  → $vm ($tamano, Ubuntu 24.04, sin IP pública)"
      if az vm create -g "$GRUPO" -n "$vm" -l "$REGION" --image Ubuntu2404 --size "$tamano" \
          --vnet-name "$RED" --subnet "$SUBRED" --nsg "" --public-ip-address "" \
          --admin-username cafeorbe --generate-ssh-keys --storage-sku StandardSSD_LRS -o none 2>/dev/null; then
        creada=si; break
      fi
      echo "    $tamano no disponible; se prueba el siguiente"
    done
    [[ "$creada" == si ]] || { echo "  Ningún tamaño de VM disponible en $REGION: $TAMANOS_VM" >&2; exit 1; }
  fi
  nic="$(az vm show -g "$GRUPO" -n "$vm" --query 'networkProfile.networkInterfaces[0].id' -o tsv)"
  ipconfig="$(az network nic show --ids "$nic" --query 'ipConfigurations[0].name' -o tsv)"
  az network nic ip-config address-pool add -g "$GRUPO" --nic-name "${nic##*/}" --ip-config-name "$ipconfig" \
    --lb-name "$LB" --address-pool "$POOL" -o none
  http="$(base64 -w0 <"$RAIZ/balanceador-vm/cafeorbe-http.conf")"
  echo "  → $vm: NGINX y certbot"
  en_vm "$vm" "set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq nginx certbot >/dev/null
mkdir -p /var/www/certbot
echo '$http' | base64 -d > /etc/nginx/conf.d/cafeorbe-http.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx && echo \"NGINX listo en \$(hostname)\""
}

sacar_del_pool() { # sacar_del_pool <vm>: para que el reto de Let's Encrypt llegue siempre a la otra VM
  local nic ipconfig
  nic="$(az vm show -g "$GRUPO" -n "$1" --query 'networkProfile.networkInterfaces[0].id' -o tsv)"
  ipconfig="$(az network nic show --ids "$nic" --query 'ipConfigurations[0].name' -o tsv)"
  az network nic ip-config address-pool remove -g "$GRUPO" --nic-name "${nic##*/}" --ip-config-name "$ipconfig" \
    --lb-name "$LB" --address-pool "$POOL" -o none
}
volver_al_pool() {
  local nic ipconfig
  nic="$(az vm show -g "$GRUPO" -n "$1" --query 'networkProfile.networkInterfaces[0].id' -o tsv)"
  ipconfig="$(az network nic show --ids "$nic" --query 'ipConfigurations[0].name' -o tsv)"
  az network nic ip-config address-pool add -g "$GRUPO" --nic-name "${nic##*/}" --ip-config-name "$ipconfig" \
    --lb-name "$LB" --address-pool "$POOL" -o none
}

# Pide el certificado de Let's Encrypt en la VM (debe ser la única del pool) y activa HTTPS con el proxy.
certificado_y_https() {
  local vm="$1" dom api ws https
  dom="$(dominio)" api="$(fqdn_app api-gateway)" ws="$(fqdn_app realtime-gateway)"
  https="$(sed -e "s/__DOMINIO__/$dom/g" -e "s/__API_HOST__/$api/g" -e "s/__WS_HOST__/$ws/g" \
    "$RAIZ/balanceador-vm/cafeorbe-https.conf.template" | base64 -w0)"
  echo "  → $vm: certificado Let's Encrypt para $dom y HTTPS hacia api-gateway / realtime-gateway"
  en_vm "$vm" "set -e
if [ ! -f /etc/letsencrypt/live/$dom/fullchain.pem ]; then
  certbot certonly --webroot -w /var/www/certbot -d $dom --non-interactive --agree-tos \
    --register-unsafely-without-email --quiet
fi
echo '$https' | base64 -d > /etc/nginx/conf.d/cafeorbe-https.conf
nginx -t && systemctl reload nginx && echo \"HTTPS listo en \$(hostname)\""
}

crear() {
  red_y_balanceador
  echo "2/4 · VM 1 (sola en el pool para obtener el certificado)"
  crear_vm "${VMS[0]}"
  # Tolerancia a la propagación de la sonda: Let's Encrypt necesita que el puerto 80 ya llegue a la VM.
  sleep 30
  certificado_y_https "${VMS[0]}"
  echo "3/4 · VM 2 (la VM 1 sale del pool mientras la VM 2 obtiene su certificado)"
  crear_vm "${VMS[1]}"
  sacar_del_pool "${VMS[0]}"
  sleep 30
  certificado_y_https "${VMS[1]}"
  volver_al_pool "${VMS[0]}"
  echo "4/4 · Listo"
  echo "✓ Balanceador: https://$(dominio)"
  echo "  Siguiente: ./scripts/balanceador-azure.sh probar"
}

# Repite solo el certificado y HTTPS en cada VM, dejando en el pool únicamente a la que lo pide
# (el reto HTTP-01 de Let's Encrypt debe llegar a esa VM).
certificados() {
  local i vm otra
  for i in 0 1; do
    vm="${VMS[$i]}" otra="${VMS[$((1 - i))]}"
    sacar_del_pool "$otra"
    sleep 20
    certificado_y_https "$vm"
    volver_al_pool "$otra"
  done
  curl -fsS -m 10 "https://$(dominio)/lb/salud" >/dev/null && echo "✓ HTTPS válido en https://$(dominio)" \
    || { echo "✗ HTTPS todavía no responde en https://$(dominio)" >&2; exit 1; }
}

estado() {
  echo "Balanceador: https://$(dominio)"
  az network lb show -g "$GRUPO" -n "$LB" --query "{sku:sku.name, reglas:join(', ', loadBalancingRules[].name), sonda:join(', ', probes[].requestPath)}" -o table
  local vm
  for vm in "${VMS[@]}"; do
    printf "%-18s %s\n" "$vm" "$(az vm get-instance-view -g "$GRUPO" -n "$vm" --query "instanceView.statuses[?starts_with(code,'PowerState')].displayStatus | [0]" -o tsv 2>/dev/null || echo 'no existe')"
  done
  az network lb show -g "$GRUPO" -n "$LB" --query "backendAddressPools[0].backendIPConfigurations[].id" -o tsv \
    | sed -E 's#.*/networkInterfaces/([^/]+)/.*#  en el pool: \1#'
}

probar() {
  local url
  url="https://$(dominio)"
  echo "20 lecturas a $url/actuator/health/readiness (estado · VM que atendió):"
  for _ in $(seq 1 20); do
    curl -s -o "$NULO" -D - -m 10 "$url/actuator/health/readiness" | tr -d '\r' \
      | awk '/^HTTP/{c=$2} tolower($1)=="x-cafeorbe-vm:"{v=$2} END{print c, v}'
  done | sort | uniq -c
  echo "WebSocket sin ticket (debe responder realtime con 4xx):"
  curl -s -o "$NULO" -w "  HTTP %{http_code}\n" --http1.1 -m 10 -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$url/ws/salas/prueba"
  echo "CORS desde la web:"
  curl -s -o "$NULO" -D - -X OPTIONS "$url/api/subastas" -H "Origin: https://cafeorbe-web.vercel.app" \
    -H "Access-Control-Request-Method: GET" | tr -d '\r' | grep -iE "^HTTP|access-control-allow-origin" | sed 's/^/  /'
}

vm_por_numero() { [[ "${1:-}" =~ ^[12]$ ]] || { echo "Indica 1 o 2." >&2; exit 2; }; echo "${VMS[$(( $1 - 1 ))]}"; }

borrar() {
  read -r -p "Se eliminan $LB, ${VMS[*]}, sus discos y NIC, $IP, $NSG y $RED. Escribe 'borrar': " r
  [[ "$r" == borrar ]] || { echo "Cancelado."; exit 1; }
  local vm disco nic
  for vm in "${VMS[@]}"; do
    az vm show -g "$GRUPO" -n "$vm" -o none 2>/dev/null || continue
    disco="$(az vm show -g "$GRUPO" -n "$vm" --query storageProfile.osDisk.managedDisk.id -o tsv)"
    nic="$(az vm show -g "$GRUPO" -n "$vm" --query 'networkProfile.networkInterfaces[0].id' -o tsv)"
    az vm delete -g "$GRUPO" -n "$vm" -y -o none && az disk delete --ids "$disco" -y -o none \
      && az network nic delete --ids "$nic" -o none && echo "  $vm eliminada"
  done
  az network lb delete -g "$GRUPO" -n "$LB" -o none 2>/dev/null && echo "  $LB eliminado" || true
  az network public-ip delete -g "$GRUPO" -n "$IP" -o none 2>/dev/null && echo "  $IP eliminada" || true
  az network vnet delete -g "$GRUPO" -n "$RED" -o none 2>/dev/null && echo "  $RED eliminada" || true
  az network nsg delete -g "$GRUPO" -n "$NSG" -o none 2>/dev/null && echo "  $NSG eliminado" || true
}

case "${1:-}" in
  crear) crear ;;
  certificados) certificados ;;
  estado) estado ;;
  probar) probar ;;
  apagar-vm) az vm stop -g "$GRUPO" -n "$(vm_por_numero "${2:-}")" -o none && echo "VM detenida: la sonda la saca del reparto en ~10 s" ;;
  encender-vm) az vm start -g "$GRUPO" -n "$(vm_por_numero "${2:-}")" -o none && echo "VM encendida: vuelve al reparto cuando la sonda responda" ;;
  borrar) borrar ;;
  *) echo "Uso: $0 crear|certificados|estado|probar|apagar-vm N|encender-vm N|borrar" >&2; exit 2 ;;
esac
