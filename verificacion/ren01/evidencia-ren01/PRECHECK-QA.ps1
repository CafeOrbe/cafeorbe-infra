param([string]$Az = 'C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd')
$ErrorActionPreference = 'Stop'
$renSub = '837dbf3b-86e9-4dee-9fa9-1d1dce8af6e0'
$renGroup = 'cafeorbe-org'
$renResult = [ordered]@{ observadoEn=[datetimeoffset]::UtcNow.ToString('o'); suscripcion=$renSub; grupo=$renGroup; apps=@(); errores=@(); postgres='NO VERIFICADO: ejecutar verificar-bd.sql'; dictamen='NO CERTIFICADO' }
function Get-RenAzJson([string[]]$Arguments) {
  $renRaw = & $Az @Arguments --only-show-errors -o json
  if ($LASTEXITCODE -ne 0) { throw 'Consulta Azure fallida; revisar el error de CLI.' }
  return (($renRaw -join "`n") | ConvertFrom-Json)
}
foreach($renApp in @('auction-service','realtime-gateway')) {
  try {
    $renConfig=Get-RenAzJson @('containerapp','show','--subscription',$renSub,'--resource-group',$renGroup,'--name',$renApp)
    $renEnv=$renConfig.properties.environmentId
    if(-not $renEnv) { $renEnv=$renConfig.properties.managedEnvironmentId }
    if($renEnv -notmatch '/managedEnvironments/cafeorbe-qa$' -or $renConfig.location.Replace(' ','') -ne 'eastus2') { throw 'Destino distinto de cafeorbe-qa en East US 2.' }
    $renRevisions=@(Get-RenAzJson @('containerapp','revision','list','--subscription',$renSub,'--resource-group',$renGroup,'--name',$renApp))
    $renActive=@($renRevisions | Where-Object { $_.properties.active })
    $renReplicaEvidence=@()
    foreach($renRevision in $renActive) {
      $renReplicas=@(Get-RenAzJson @('containerapp','replica','list','--subscription',$renSub,'--resource-group',$renGroup,'--name',$renApp,'--revision',$renRevision.name))
      foreach($renReplica in $renReplicas) {
        $renReplicaEvidence += [ordered]@{revision=$renRevision.name; nombre=$renReplica.name; runningState=$renReplica.properties.runningState; containers=$renReplica.properties.containers | Select-Object name,ready,restartCount,runningState}
      }
    }
    $renHealth=Invoke-RestMethod -Uri ('https://'+$renConfig.properties.configuration.ingress.fqdn+'/actuator/health/readiness') -TimeoutSec 15
    $renSafe=[ordered]@{nombre=$renApp; ambiente=$renEnv; region=$renConfig.location; readiness=$renHealth.status; trafico=$renConfig.properties.configuration.ingress.traffic; escala=$renConfig.properties.template.scale; revisiones=@($renActive | ForEach-Object { [ordered]@{nombre=$_.name; healthState=$_.properties.healthState; replicas=$_.properties.replicas; containers=@($_.properties.template.containers | ForEach-Object { [ordered]@{nombre=$_.name; imagen=$_.image; cpu=$_.resources.cpu; memoria=$_.resources.memory} })} }); replicas=$renReplicaEvidence}
    $renResult.apps += $renSafe
    if($renHealth.status -ne 'UP' -or $renReplicaEvidence.Count -ne 2) { $renResult.errores += "${renApp}: se exigen readiness UP y exactamente 2 replicas observadas; revisar ready de cada contenedor." }
    if(@($renReplicaEvidence | Where-Object { @($_.containers | Where-Object { $_.ready -ne $true }).Count -gt 0 -or @($_.containers).Count -eq 0 }).Count -gt 0) { $renResult.errores += "${renApp}: no se pudo demostrar que todos los contenedores estan ready." }
  } catch { $renResult.errores += "${renApp}: $($_.Exception.Message)" }
}
try {
  $renApiRaw = & node (Join-Path $PSScriptRoot 'precheck-api.mjs')
  $renApiExit = $LASTEXITCODE
  $renResult.api=($renApiRaw | ConvertFrom-Json)
  if($renApiExit -ne 0) { $renResult.errores += 'API, estado de subasta o compradores no cumplen precondiciones.' }
} catch { $renResult.errores += "API: $($_.Exception.Message)" }
$renPath=Join-Path $PSScriptRoot ('precheck-qa-'+[datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'.json')
$renResult | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $renPath -Encoding UTF8
Write-Output ('Evidencia sin secretos: '+$renPath)
$renResult | ConvertTo-Json -Depth 20 | Write-Output
if($renResult.errores.Count) { exit 1 }
Write-Output 'Precheck ACA/API sin errores. Falta PostgreSQL y verificar capacidad de medicion antes de la carga; esto no es CUMPLE REN-01.'
