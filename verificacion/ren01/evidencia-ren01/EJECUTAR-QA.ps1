param([string]$Az='C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd')
$ErrorActionPreference='Stop'
# Windows PowerShell o pwsh (Cloud Shell), python o python3.
$renPs=if(Get-Command pwsh -ErrorAction SilentlyContinue){'pwsh'}else{'powershell'}
$renPy=if(Get-Command python -ErrorAction SilentlyContinue){'python'}else{'python3'}
$renRoot=Split-Path $PSScriptRoot -Parent
$renOutput=Join-Path $PSScriptRoot ('corrida-'+[datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $renOutput | Out-Null
$renObserver=$null
$renSub='837dbf3b-86e9-4dee-9fa9-1d1dce8af6e0'
$renSavedEnv=@{}
foreach($renName in @('PGHOST','PGDATABASE','PGUSER','PGPASSWORD','REN_PY_DEPS')) { $renSavedEnv[$renName]=[Environment]::GetEnvironmentVariable($renName,'Process') }
function Invoke-RenAz([string[]]$Arguments) {
  $renRaw=& $Az @Arguments --only-show-errors -o json
  if($LASTEXITCODE -ne 0) { throw 'Consulta Azure fallida.' }
  return (($renRaw -join "`n") | ConvertFrom-Json)
}
function Read-RenEnv($Container,[string]$Name) {
  $renEntry=@($Container.env | Where-Object { $_.name -eq $Name })
  if($renEntry.Count -ne 1) { throw "Falta variable $Name en auction QA." }
  if($renEntry[0].secretRef) {
    $renSecrets=Invoke-RenAz @('containerapp','secret','list','--subscription',$renSub,'--resource-group','cafeorbe-org','--name','auction-service','--show-values')
    $renSecret=@($renSecrets | Where-Object { $_.name -eq $renEntry[0].secretRef })
    if($renSecret.Count -ne 1 -or -not $renSecret[0].value) { throw "No se pudo resolver secreto de $Name." }
    return $renSecret[0].value
  }
  return $renEntry[0].value
}
try {
  & $renPs -NoProfile -File (Join-Path $PSScriptRoot 'PRECHECK-QA.ps1') -Az $Az
  if($LASTEXITCODE -ne 0) { throw 'Precheck QA fallido; no se lanzo carga.' }
  $renPre=Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'precheck-qa-*.json' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  Copy-Item -LiteralPath $renPre.FullName -Destination (Join-Path $renOutput 'precheck.json')
  $renConfig=Invoke-RenAz @('containerapp','show','--subscription',$renSub,'--resource-group','cafeorbe-org','--name','auction-service')
  $renEnv=$renConfig.properties.environmentId
  if(-not $renEnv) { $renEnv=$renConfig.properties.managedEnvironmentId }
  if($renEnv -notmatch '/managedEnvironments/cafeorbe-qa$') { throw 'Destino fuera de QA.' }
  $renContainer=$renConfig.properties.template.containers | Where-Object { $_.name -eq 'auction-service' }
  $renDbUrl=Read-RenEnv $renContainer 'DB_URL'
  if($renDbUrl -notmatch '^jdbc:postgresql://cafeorbe-pg\.postgres\.database\.azure\.com:5432/auction_db(?:\?.*)?$') { throw 'PostgreSQL no corresponde a auction_db QA.' }
  $env:PGHOST='cafeorbe-pg.postgres.database.azure.com'
  $env:PGDATABASE='auction_db'
  $env:PGUSER=Read-RenEnv $renContainer 'DB_USER'
  $env:PGPASSWORD=Read-RenEnv $renContainer 'DB_PASSWORD'
  $env:REN_PY_DEPS=Join-Path ([IO.Path]::GetTempPath()) 'cafeorbe-ren01-pg8000'
  if(-not (Test-Path -LiteralPath (Join-Path $env:REN_PY_DEPS 'pg8000'))) {
    & $renPy -m pip install --quiet --target $env:REN_PY_DEPS pg8000
    if($LASTEXITCODE -ne 0) { throw 'No se pudo instalar pg8000 en la carpeta temporal.' }
  }
  $renBefore=& $renPy (Join-Path $PSScriptRoot 'snapshot-pg.py')
  if($LASTEXITCODE -ne 0) { throw "No se pudo consultar PostgreSQL: $renBefore" }
  $renPg=$renBefore | ConvertFrom-Json
  $renBefore | Set-Content -LiteralPath (Join-Path $renOutput 'postgres-antes.json') -Encoding UTF8
  if($renPg.conexionesCliente -ge 25) { throw "PostgreSQL tiene $($renPg.conexionesCliente) conexiones; se exige <25 antes de carga." }
  Write-Output "PostgreSQL: $($renPg.conexionesCliente) conexiones. Ejecutando carga; evidencia en $renOutput"
  $renObserver=Start-Job -ArgumentList $Az,$renSub,$renOutput,$PSScriptRoot,$renPy -ScriptBlock {
    param($renAzLocal,$renSubscription,$renFolder,$renScripts,$renPyLocal)
    while(-not (Test-Path -LiteralPath (Join-Path $renFolder 'fin-observador'))) {
      foreach($renApp in @('auction-service','realtime-gateway')) {
        $renRaw=& $renAzLocal containerapp replica list --subscription $renSubscription --resource-group cafeorbe-org --name $renApp -o json --only-show-errors
        $renExit=$LASTEXITCODE
        try { $renReplicas=(($renRaw -join "`n") | ConvertFrom-Json) } catch { $renReplicas=@(); $renExit=1 }
        [ordered]@{observadoEn=[datetimeoffset]::UtcNow.ToString('o'); app=$renApp; error=$renExit; replicas=@($renReplicas | ForEach-Object { [ordered]@{nombre=$_.name; runningState=$_.properties.runningState; containers=$_.properties.containers | Select-Object name,ready,restartCount,runningState} })} | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath (Join-Path $renFolder 'replicas.ndjson') -Encoding UTF8
      }
      $renPgRaw=& $renPyLocal (Join-Path $renScripts 'snapshot-pg.py') --count-only
      $renPgRaw | Add-Content -LiteralPath (Join-Path $renFolder 'postgres-conexiones.ndjson') -Encoding UTF8
      Start-Sleep -Seconds 15
    }
  }
  Push-Location $renRoot
  try {
    & node carga-sala.mjs --etapa objetivo --usuarios 200 --tasa 20 --duracion 600 --rampup 25 --salida (Join-Path $renOutput 'resultado-objetivo.json') --html (Join-Path $renOutput 'resultado-objetivo.html') | Tee-Object -FilePath (Join-Path $renOutput 'carga.log')
    $renLoadExit=$LASTEXITCODE
  } finally { Pop-Location }
  New-Item -ItemType File -Path (Join-Path $renOutput 'fin-observador') | Out-Null
  Wait-Job $renObserver -Timeout 60 | Out-Null
  if($renObserver.State -ne 'Completed') { Stop-Job $renObserver; throw 'Observador incompleto; evidencia no certificable.' }
  Receive-Job $renObserver -ErrorAction Stop | Out-Null
  $renAfter=& $renPy (Join-Path $PSScriptRoot 'snapshot-pg.py')
  if($LASTEXITCODE -ne 0) { throw 'No se pudo consultar PostgreSQL al finalizar.' }
  $renAfter | Set-Content -LiteralPath (Join-Path $renOutput 'postgres-despues.json') -Encoding UTF8
  $renRun=Get-Content -LiteralPath (Join-Path $renOutput 'resultado-objetivo.json') -Raw | ConvertFrom-Json
  if($renLoadExit -ne 0 -or -not $renRun.ventana.inicioIso -or -not $renRun.ventana.finIso) { throw 'La carga no se completo. Se conservaron los resultados parciales.' }
  Write-Output 'Carga terminada. Esperando 60 s para publicacion de metricas Azure Monitor.'
  Start-Sleep -Seconds 60
  & (Join-Path $PSScriptRoot 'RECABAR-CPU.ps1') -Inicio $renRun.ventana.inicioIso -Fin $renRun.ventana.finIso -Az $Az -Destino $renOutput
  & node (Join-Path $PSScriptRoot 'certificar.mjs') $renOutput
  if($LASTEXITCODE -ne 0) { throw 'REN-01 no cumple o falta evidencia. Consultar INFORME.md de la corrida.' }
} catch {
  Write-Output ('REN-01 NO CERTIFICADO: '+$_.Exception.Message)
  Write-Output ('Evidencia conservada en '+$renOutput)
  exit 1
} finally {
  if($renObserver) { Stop-Job $renObserver -ErrorAction SilentlyContinue; Remove-Job $renObserver -ErrorAction SilentlyContinue }
  foreach($renName in $renSavedEnv.Keys) { [Environment]::SetEnvironmentVariable($renName,$renSavedEnv[$renName],'Process') }
}
