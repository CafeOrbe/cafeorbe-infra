// REN-01: prepara una corrida nueva en QA.
//   1. Firma 200 sesiones de compradores de prueba y las registra en wallet (Orbes iniciales por el broker).
//   2. Crea con un Subastador de prueba una subasta EN_CURSO que dura lo suficiente para la carga.
//   3. Escribe compradores.json (no se versiona) y deja el id de la subasta en .subasta-ren01.
//
//   JWT_SECRET=... BROKER_API_URL=https://<host> BROKER_USER=... BROKER_PASSWORD=... BROKER_VHOST=... \
//   node preparar-ren01.mjs [--compradores 200] [--minutos 30]
//
// Luego: export REN01_SUBASTA=$(cat .subasta-ren01) y correr evidencia-ren01/EJECUTAR-QA.ps1.
import { writeFileSync } from 'node:fs'
import { sesionDePrueba } from '../sesiones-de-prueba.mjs'

const API = process.env.API_URL ?? 'https://api-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io'
const arg = (nombre, defecto) => { const i = process.argv.indexOf(nombre); return i > 0 ? Number(process.argv[i + 1]) : defecto }
const N = arg('--compradores', 200)
const MINUTOS = arg('--minutos', 30)
// --sufijo reutiliza las mismas personas de una preparación anterior (con SIN_REGISTRO=1 no se vuelven a registrar).
const iSufijo = process.argv.indexOf('--sufijo')
const sufijo = iSufijo > 0 ? process.argv[iSufijo + 1] : Date.now().toString(36)

async function http(metodo, ruta, token, cuerpo) {
  const r = await fetch(API + ruta, { method: metodo, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined, signal: AbortSignal.timeout(20000) })
  const texto = await r.text()
  if (!r.ok) throw new Error(`${metodo} ${ruta} → HTTP ${r.status}: ${texto.slice(0, 200)}`)
  return texto ? JSON.parse(texto) : null
}

console.log(`Registrando ${N} compradores de prueba (sufijo ${sufijo})...`)
const compradores = []
// De a 5 a la vez: la API HTTP del broker (CloudAMQP) se traba con muchas publicaciones simultáneas.
for (let i = 0; i < N; i += 5) {
  const lote = await Promise.all(Array.from({ length: Math.min(5, N - i) }, (_, j) =>
    sesionDePrueba(`ren01-${sufijo}-comprador-${String(i + j + 1).padStart(3, '0')}`, 'COMPRADOR')))
  compradores.push(...lote.map((s) => ({ id: s.usuario.id, nombre: s.usuario.nombre, token: s.token })))
  if (compradores.length % 25 === 0) console.log(`  ${compradores.length}/${N} registrados`)
}
const subastador = await sesionDePrueba(`ren01-${sufijo}-subastador`, 'SUBASTADOR')

// wallet carga los Orbes iniciales por evento (unos 2 por segundo en QA): se espera a que el último tenga saldo.
const ultimo = compradores.at(-1)
for (let intento = 0; ; intento++) {
  try {
    const saldo = await http('GET', '/api/orbes/saldo', ultimo.token)
    if (Number(saldo?.saldo) > 0) { console.log(`Orbes iniciales cargados (saldo ${saldo.saldo}).`); break }
    if (intento % 5 === 0) console.log(`  Esperando los Orbes iniciales del último comprador (saldo ${saldo?.saldo})...`)
  } catch (e) { if (intento === 0) console.log(`Esperando a wallet: ${e.message}`) }
  if (intento > 180) throw new Error('wallet no cargó los Orbes iniciales en 6 min')
  await new Promise((r) => setTimeout(r, 2000))
}

const inicio = new Date(Date.now() + 5 * 60_000).toISOString()
const subasta = await http('POST', '/api/subastas', subastador.token, { nombre: `REN-01 ${sufijo}`, descripcion: 'Carga REN-01 (prueba)', fechaInicio: inicio })
await http('PUT', `/api/subastas/${subasta.id}/ficha`, subastador.token,
  { identificacion: `REN01-${sufijo}`, tipoCafe: 'Prueba de carga', pesoKg: 1, edadMeses: 1, observaciones: 'Datos de prueba REN-01' })
await http('PUT', `/api/subastas/${subasta.id}/reglas`, subastador.token, { duracionMinutos: MINUTOS, precioBase: 1000, incrementoMinimo: 100 })
await http('POST', `/api/subastas/${subasta.id}/iniciar`, subastador.token)
const estado = await http('GET', `/api/subastas/${subasta.id}`, compradores[0].token)
if (estado.estado !== 'EN_CURSO') throw new Error(`La subasta quedó en ${estado.estado}`)

writeFileSync(new URL('./compradores.json', import.meta.url), JSON.stringify(compradores))
writeFileSync(new URL('./.subasta-ren01', import.meta.url), subasta.id + '\n')
console.log(`Listo: ${compradores.length} compradores en compradores.json; subasta ${subasta.id} EN_CURSO hasta ${estado.horaFin}.`)
console.log(`export REN01_SUBASTA=${subasta.id}`)
