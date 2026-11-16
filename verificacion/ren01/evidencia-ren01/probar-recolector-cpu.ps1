$ErrorActionPreference='Stop'
$renFixtureOutput=Join-Path ([IO.Path]::GetTempPath()) ('cafeorbe-cpu-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $renFixtureOutput | Out-Null
$global:renFixtureCalls=0
function global:Invoke-RenMetricFixture {
  $global:LASTEXITCODE=0
  if($args[0] -eq 'containerapp') {
    $renApp=$args[[array]::IndexOf($args,'--name')+1]
    @{id="/fixture/$renApp";location='East US 2';properties=@{environmentId='/subscriptions/fixture/resourceGroups/cafeorbe-org/providers/Microsoft.App/managedEnvironments/cafeorbe-qa';template=@{containers=@(@{name=$renApp;image='fixture-sin-red';resources=@{cpu=0.25}})}}} | ConvertTo-Json -Depth 8 -Compress
  } elseif($args[0] -eq 'rest') {
    $renUrl=$args[[array]::IndexOf($args,'--url')+1]
    $renDecoded=[Uri]::UnescapeDataString(([Uri]$renUrl).Query)
    if($renDecoded -cnotmatch "\u0024filter=revisionName eq '\*' and podName eq '\*'(&|$)") { throw "Filtro REST incorrecto: $renDecoded" }
    if($renDecoded -notmatch 'ValidateDimensions=true' -or $renDecoded -notmatch 'timespan=2026-11-16T13:28:02Z/2026-11-16T13:38:02Z' -or $args[[array]::IndexOf($args,'--method')+1] -ne 'get') { throw 'Consulta REST distinta de la ventana esperada.' }
    $global:renFixtureCalls++
    '{"fixture":"SIN RED","value":[{"name":{"value":"UsageNanoCores"},"timeseries":[]}]}'
  } else { throw 'Comando inesperado en fixture.' }
}
& (Join-Path $PSScriptRoot 'RECABAR-CPU.ps1') -Inicio '2026-11-16T13:28:02Z' -Fin '2026-11-16T13:38:02Z' -Az 'Invoke-RenMetricFixture' -Destino $renFixtureOutput
if($global:renFixtureCalls -ne 2) { throw 'Se esperaban dos consultas CPU.' }
foreach($renApp in @('auction-service','realtime-gateway')) {
  $renData=Get-Content -LiteralPath (Join-Path $renFixtureOutput "cpu-$renApp.json") -Raw | ConvertFrom-Json
  if($renData.fixture -ne 'SIN RED') { throw 'No se conservo la respuesta cruda.' }
}
Write-Output 'PASS SIN RED: GET REST conserva dimensiones, ventana y validacion; respuestas crudas conservadas para ambas apps.'
