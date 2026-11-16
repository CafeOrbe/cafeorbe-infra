#!/usr/bin/env bash
# DIS-01: carga las credenciales de auction y wallet desde las Container Apps de QA (sin imprimirlas)
# y ejecuta verificar-cierre.py. Uso: bash dis01/verificar-cierre.sh <subastaId>
set -euo pipefail
GRUPO=cafeorbe-org
SUBASTA="${1:?Falta el id de la subasta}"

valor() { # valor <app> <VARIABLE>: valor directo o resuelto desde el secreto
  local app=$1 nombre=$2 ref
  local v; v=$(az containerapp show -g $GRUPO -n "$app" --query "properties.template.containers[0].env[?name=='$nombre'] | [0].value" -o tsv --only-show-errors)
  if [[ -n "$v" ]]; then printf '%s' "$v"; return; fi
  ref=$(az containerapp show -g $GRUPO -n "$app" --query "properties.template.containers[0].env[?name=='$nombre'] | [0].secretRef" -o tsv --only-show-errors)
  az containerapp secret show -g $GRUPO -n "$app" --secret-name "$ref" --query value -o tsv --only-show-errors
}

export PGHOST=cafeorbe-pg.postgres.database.azure.com
export PGUSER; PGUSER=$(valor auction-service DB_USER)
export PGPASSWORD; PGPASSWORD=$(valor auction-service DB_PASSWORD)
export WPGUSER; WPGUSER=$(valor wallet-service DB_USER)
export WPGPASSWORD; WPGPASSWORD=$(valor wallet-service DB_PASSWORD)
echo "Credenciales cargadas (longitudes): auction ${#PGPASSWORD}, wallet ${#WPGPASSWORD}"

export REN_PY_DEPS="${REN_PY_DEPS:-/tmp/cafeorbe-pg8000}"
[[ -d "$REN_PY_DEPS/pg8000" ]] || python3 -m pip install --quiet --target "$REN_PY_DEPS" pg8000
python3 "$(dirname "$0")/verificar-cierre.py" "$SUBASTA"
