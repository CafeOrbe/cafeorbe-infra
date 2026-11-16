param(
  [Parameter(Mandatory=$true)][datetimeoffset]$Inicio,
  [Parameter(Mandatory=$true)][datetimeoffset]$Fin,
  [string]$Az = 'C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd',
  [string]$Destino = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$renSubscription = '837dbf3b-86e9-4dee-9fa9-1d1dce8af6e0'
$renGroup = 'cafeorbe-org'
if ($Fin -le $Inicio) { throw 'Fin debe ser posterior a Inicio.' }
# El lanzador az.cmd reinterpreta los & de la URL mediante cmd.exe.
# Usar el mismo Python/modulo que declara az.cmd, sin pasar por otro shell.
$renAzurePython = $null
if ([IO.Path]::GetExtension($Az) -ieq '.cmd') {
  $renCandidate = Join-Path (Split-Path (Split-Path $Az -Parent) -Parent) 'python.exe'
  if (-not (Test-Path -LiteralPath $renCandidate)) { throw 'No se encontro Python de Azure CLI; no se pasa una URL REST con & por az.cmd.' }
  $renAzurePython = $renCandidate
}
function Invoke-RenAzure([string[]]$Arguments) {
  if ($renAzurePython) {
    & $renAzurePython -IBm azure.cli @Arguments
  } else {
    & $Az @Arguments
  }
  # Publicar el codigo del proceso, no un LASTEXITCODE anterior del llamador.
  $script:renAzureExit = $LASTEXITCODE
}
foreach ($renApp in @('auction-service','realtime-gateway')) {
  $renRaw = Invoke-RenAzure @('containerapp','show','--subscription',$renSubscription,'--resource-group',$renGroup,'--name',$renApp,'-o','json')
  if ($renAzureExit -ne 0) { throw "No se pudo consultar $renApp" }
  $renConfig = ($renRaw -join "`n") | ConvertFrom-Json
  $renEnvironment = $renConfig.properties.environmentId
  if (-not $renEnvironment) { $renEnvironment = $renConfig.properties.managedEnvironmentId }
  if ($renEnvironment -notmatch '/managedEnvironments/cafeorbe-qa$' -or $renConfig.location.Replace(' ','') -ne 'eastus2') {
    throw "La app $renApp no pertenece a cafeorbe-qa en East US 2."
  }
  # Solo configuración no sensible: no guardar variables de entorno ni secretos.
  $renConfig.properties.template.containers | ForEach-Object {
    [pscustomobject]@{ name=$_.name; image=$_.image; cpu=$_.resources.cpu }
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Destino "cpu-config-$renApp.json") -Encoding UTF8
  # GET directo: evita la ruta az monitor metrics list que sigue produciendo
  # revisionname/podname en este entorno. No desactivar ValidateDimensions.
  $renFilter = "revisionName eq '*' and podName eq '*'"
  $renSpan = $Inicio.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + '/' + $Fin.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $renQuery = [ordered]@{
    'api-version'='2023-10-01'
    'metricnamespace'='Microsoft.App/containerapps'
    'metricnames'='UsageNanoCores'
    'timespan'=$renSpan
    'interval'='PT1M'
    'aggregation'='Maximum,Average'
    '$filter'=$renFilter
    'ValidateDimensions'='true'
    'top'='1000'
  }
  $renQueryText = ($renQuery.GetEnumerator() | ForEach-Object {
    [Uri]::EscapeDataString([string]$_.Key) + '=' + [Uri]::EscapeDataString([string]$_.Value)
  }) -join '&'
  $renUrl = 'https://management.azure.com' + $renConfig.id + '/providers/Microsoft.Insights/metrics?' + $renQueryText
  # Solo URL de recurso/ventana, sin token: conservar la consulta exacta para diagnostico.
  $renUrl | Set-Content -LiteralPath (Join-Path $Destino "cpu-consulta-$renApp.txt") -Encoding UTF8
  $renMetrics = Invoke-RenAzure @('rest','--subscription',$renSubscription,'--method','get','--url',$renUrl,'--only-show-errors','-o','json')
  if ($renAzureExit -ne 0) { throw "No se pudo consultar CPU por REST de $renApp; ver cpu-consulta-$renApp.txt" }
  $renParsed = ($renMetrics -join "`n") | ConvertFrom-Json
  if (-not $renParsed.value -or -not (@($renParsed.value | Where-Object { $_.name.value -eq 'UsageNanoCores' }).Count)) {
    throw "Respuesta CPU sin UsageNanoCores para $renApp. No se reemplaza evidencia anterior."
  }
  $renMetrics | Set-Content -LiteralPath (Join-Path $Destino "cpu-$renApp.json") -Encoding UTF8
}
Write-Output 'CPU cruda por podName/revisionName guardada; comprobar cobertura completa de la ventana y normalizar por CPU de cada revisión.'
