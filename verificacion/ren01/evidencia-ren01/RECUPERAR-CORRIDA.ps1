param(
  [string]$Corrida = (Join-Path $PSScriptRoot 'corrida-20261116T132531Z'),
  [string]$Az = 'C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd'
)
$ErrorActionPreference = 'Stop'
$renFile = Join-Path $Corrida 'resultado-objetivo.json'
$renRun = Get-Content -LiteralPath $renFile -Raw | ConvertFrom-Json
if (-not $renRun.ventana.inicioIso -or -not $renRun.ventana.finIso) { throw 'No hay ventana formal registrada.' }
try {
  & (Join-Path $PSScriptRoot 'RECABAR-CPU.ps1') -Inicio $renRun.ventana.inicioIso -Fin $renRun.ventana.finIso -Destino $Corrida -Az $Az
} finally {
  # Emitir informe aun si falta CPU; ausencia de datos nunca equivale a cero.
  & node (Join-Path $PSScriptRoot 'certificar.mjs') $Corrida
}
