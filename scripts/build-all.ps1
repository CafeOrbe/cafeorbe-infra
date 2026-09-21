# Compila e instala los contratos y empaqueta todos los servicios (orden obligatorio).
# Uso (desde cafeorbe-infra):  .\scripts\build-all.ps1 [-SkipTests]
param([switch]$SkipTests)

$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$mvnArgs = @('-B', '-q')
if ($SkipTests) { $mvnArgs += '-DskipTests' }

function Invoke-Mvn($carpeta, $meta) {
    Write-Host ">> $carpeta ($meta)"
    Push-Location (Join-Path $raiz $carpeta)
    try {
        mvn @mvnArgs $meta
        if ($LASTEXITCODE -ne 0) { throw "Falló $carpeta" }
    } finally { Pop-Location }
}

Invoke-Mvn 'cafeorbe-contracts' 'install'
foreach ($s in 'identity-service', 'wallet-service', 'auction-service', 'streaming-service', 'realtime-gateway', 'api-gateway') {
    Invoke-Mvn "cafeorbe-$s" 'package'
}
Write-Host 'Listo.'
