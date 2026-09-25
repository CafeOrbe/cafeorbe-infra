#!/usr/bin/env bash
# ============================================================
# CaféOrbe · APAGAR infraestructura Azure (ahorro de crédito)
# Uso: ./azure-apagar.sh
# Detiene Postgres y escala las 6 container apps a 0.
# Los datos se conservan. Para volver: ./azure-encender.sh
# ============================================================
set -euo pipefail

RG="cafeorbe-org"
APPS="identity-service auction-service wallet-service streaming-service realtime-gateway api-gateway"

echo "🌙 Apagando infraestructura CaféOrbe..."

echo "→ Deteniendo PostgreSQL (conserva datos)..."
az postgres flexible-server stop -n cafeorbe-pg -g "$RG"

echo "→ Escalando container apps a 0..."
for app in $APPS; do
  echo "  · $app → 0 réplicas"
  az containerapp update -n "$app" -g "$RG" --min-replicas 0 --only-show-errors
done

echo ""
echo "✅ Infraestructura apagada. Ahorro estimado: ~\$25-35/mes."
echo "   Para volver a encender: ./azure-encender.sh"