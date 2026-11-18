#!/usr/bin/env bash
# DIS-01: carga las credenciales de auction y wallet desde las Container Apps del ambiente seleccionado
# y ejecuta verificar-cierre.py. Uso: bash dis01/verificar-cierre.sh <subastaId> [qa|prod]
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
GRUPO=cafeorbe-org
SUBASTA="${1:?Falta el id de la subasta}"
case "${2:-qa}" in
  qa) sufijo=""; host=cafeorbe-pg.postgres.database.azure.com ;;
  prod) sufijo=-prod; host=cafeorbe-pg-prod.postgres.database.azure.com ;;
  *) echo "Indica qa o prod." >&2; exit 2 ;;
esac

valor() { # valor <app> <VARIABLE>: valor directo o resuelto desde el secreto
  local app=$1 nombre=$2 ref
  local v; v=$(az containerapp show -g $GRUPO -n "$app" --query "properties.template.containers[0].env[?name=='$nombre'] | [0].value" -o tsv --only-show-errors)
  if [[ -n "$v" ]]; then printf '%s' "$v"; return; fi
  ref=$(az containerapp show -g $GRUPO -n "$app" --query "properties.template.containers[0].env[?name=='$nombre'] | [0].secretRef" -o tsv --only-show-errors)
  az containerapp secret show -g $GRUPO -n "$app" --secret-name "$ref" --query value -o tsv --only-show-errors
}

export PGHOST="$host"
export PGUSER; PGUSER=$(valor "auction-service$sufijo" DB_USER)
export PGPASSWORD; PGPASSWORD=$(valor "auction-service$sufijo" DB_PASSWORD)
export WPGUSER; WPGUSER=$(valor "wallet-service$sufijo" DB_USER)
export WPGPASSWORD; WPGPASSWORD=$(valor "wallet-service$sufijo" DB_PASSWORD)

export REN_PY_DEPS="${REN_PY_DEPS:-/tmp/cafeorbe-pg8000}"
[[ -d "$REN_PY_DEPS/pg8000" ]] || python3 -m pip install --quiet --target "$REN_PY_DEPS" pg8000
python3 "$(dirname "$0")/verificar-cierre.py" "$SUBASTA"
