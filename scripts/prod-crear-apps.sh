#!/usr/bin/env bash
# CaféOrbe · crea las seis Container Apps de PROD en el ambiente cafeorbe-prod.
#
# Los pipelines (deploy-prod, etiqueta v*) solo actualizan apps que ya existen: "provisionar apps es tarea de
# cafeorbe-infra". Este script las crea con la forma de QA (puerto, ingreso, sondas, recursos y escalado) y la
# imagen actual de QA, pero SIN variables de entorno: así ninguna app de PROD se conecta a la base, al Redis o al
# broker de QA. Hasta el primer deploy-prod, las apps no arrancan (no tienen configuración); el pipeline les pone
# la imagen de la etiqueta y todas sus variables.
#
# Uso (Azure Cloud Shell o Bash con az y python3), desde la raíz de cafeorbe-infra:
#   ./scripts/prod-crear-apps.sh crear     # crea las que falten
#   ./scripts/prod-crear-apps.sh estado    # apps de PROD, imagen, réplicas y URL
set -euo pipefail
# Git Bash en Windows convierte argumentos como /subscriptions/... en rutas de disco.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

GRUPO="${RESOURCE_GROUP:-cafeorbe-org}"
ENTORNO_PROD="${ENTORNO_PROD:-cafeorbe-prod}"
PYTHON="${PYTHON:-python3}"
APPS=(identity-service wallet-service streaming-service auction-service realtime-gateway api-gateway)

command -v az >/dev/null || { echo "Falta Azure CLI (az)." >&2; exit 1; }
# shellcheck disable=SC2218 # 'command' llama al az real, no a la función de abajo.
command az extension add --name containerapp --upgrade --only-show-errors >/dev/null
az() { command az "$@" --only-show-errors; }

TEMPORALES=()
limpiar() { if ((${#TEMPORALES[@]})); then rm -f -- "${TEMPORALES[@]}"; fi; }
trap limpiar EXIT
temporal() { local f; f="$(mktemp)"; chmod 600 "$f"; TEMPORALES+=("$f"); echo "$f"; }

# Rutas que entiende el python de Windows cuando el script corre en Git Bash.
ruta() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

existe() { az containerapp show -n "$1" -g "$GRUPO" -o none 2>/dev/null; }

crear_app() {
  local qa="$1" prod="$1-prod" actual secretos nuevo entorno
  if existe "$prod"; then echo "  $prod ya existe: se conserva"; return; fi
  actual="$(temporal)" secretos="$(temporal)" nuevo="$(temporal)"
  entorno="$(az containerapp env show -g "$GRUPO" -n "$ENTORNO_PROD" --query id -o tsv)"
  az containerapp show -n "$qa" -g "$GRUPO" -o json >"$actual"
  az containerapp secret list -n "$qa" -g "$GRUPO" --show-values -o json >"$secretos"
  # Solo se copia el secreto del registro de imágenes; variables de entorno vacías.
  "$PYTHON" - "$(ruta "$actual")" "$(ruta "$secretos")" "$(ruta "$nuevo")" "$prod" "$entorno" <<'PY'
import json, sys
actual, secretos, nuevo, nombre, entorno = sys.argv[1:6]
a = json.load(open(actual, encoding="utf-8"))
s = {x["name"]: x.get("value") for x in json.load(open(secretos, encoding="utf-8"))}
conf = a["properties"]["configuration"]
registros = conf.get("registries") or []
usados = {r.get("passwordSecretRef") for r in registros if r.get("passwordSecretRef")}
ingreso = dict(conf["ingress"]); ingreso.pop("fqdn", None)
ingreso["traffic"] = [{"latestRevision": True, "weight": 100}]
plantilla = a["properties"]["template"]; plantilla.pop("revisionSuffix", None)
for c in plantilla["containers"]:
    c["env"] = []
json.dump({"location": a["location"], "name": nombre, "properties": {
    "environmentId": entorno,
    "configuration": {"activeRevisionsMode": conf.get("activeRevisionsMode", "Single"), "ingress": ingreso,
                      "registries": registros,
                      "secrets": [{"name": n, "value": s[n]} for n in sorted(usados) if s.get(n)]},
    "template": plantilla}}, open(nuevo, "w", encoding="utf-8"))
PY
  echo "  → $prod: forma e imagen de $qa, sin variables, en $ENTORNO_PROD"
  az containerapp create -n "$prod" -g "$GRUPO" --yaml "$(ruta "$nuevo")" -o none
}

crear() {
  local app
  for app in "${APPS[@]}"; do crear_app "$app"; done
  estado
}

estado() {
  local app
  for app in "${APPS[@]}"; do
    if existe "$app-prod"; then
      az containerapp show -n "$app-prod" -g "$GRUPO" --query "[name, properties.template.containers[0].image, properties.template.scale.minReplicas, properties.template.scale.maxReplicas, properties.configuration.ingress.fqdn]" -o tsv \
        | paste -sd$'\t' | awk -F'\t' '{ n=split($2,p,"/"); printf "%-24s %-30s réplicas %s–%s  https://%s\n", $1, p[n], $3, $4, $5 }'
    else
      printf "%-24s (no existe)\n" "$app-prod"
    fi
  done
}

case "${1:-}" in
  crear) crear ;;
  estado) estado ;;
  *) echo "Uso: $0 crear|estado" >&2; exit 2 ;;
esac
