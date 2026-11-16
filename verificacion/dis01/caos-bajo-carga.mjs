// DIS-01 + OBS-01: caída de réplicas BAJO CARGA, medida desde el lado del cliente.
//
// Con N compradores conectados por WebSocket (que se reconectan solos, como el navegador) y pujas sostenidas,
// termina el proceso de 1 réplica de auction-service y 1 de realtime-gateway y mide:
//   - % de errores REST en los 30 s posteriores a la falla (meta < 2 %),
//   - tiempo de reconexión de cada WebSocket cortado (meta < 10 s),
//   - pujas aceptadas perdidas: cada número de puja (cantidadPujas) debe haberlo visto algún comprador (meta 0),
//   - hora exacta de la falla, para medir en Grafana la degradación (≤ 30 s) y la alerta (≤ 2 min).
// Un cierre y un cobro por subasta se comprueban después con verificar-cierre.py, cuando la subasta termina.
//
//   REN01_SUBASTA=<id EN_CURSO> node dis01/caos-bajo-carga.mjs [--clientes 60] [--pps 5] [--antes 30] [--despues 90] [--sin-caos]
// Usa ../ren01/compradores.json (preparar-ren01.mjs). Necesita Azure CLI con acceso a cafeorbe-org.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d }
const API = process.env.API_URL ?? 'https://api-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io'
const WS = process.env.WS_URL ?? 'wss://realtime-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io'
const SUBASTA = process.env.REN01_SUBASTA
const N = arg('--clientes', 60), PPS = arg('--pps', 5), ANTES = arg('--antes', 30), DESPUES = arg('--despues', 90)
const SIN_CAOS = process.argv.includes('--sin-caos')
process.on('SIGINT', () => process.exit(130))
const MAX_REPOSICION = arg('--reposicion', 180)
const GRUPO = process.env.RESOURCE_GROUP ?? 'cafeorbe-org'
if (!SUBASTA) throw new Error('Falta REN01_SUBASTA')

const compradores = JSON.parse(readFileSync(new URL('../ren01/compradores.json', import.meta.url), 'utf8')).slice(0, N)
const ahora = () => Date.now()
const iso = (t) => new Date(t).toISOString()
const horaMx = (t) => new Date(t).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' })
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

async function rest(ruta, token) {
  const t = ahora()
  try {
    const r = await fetch(API + ruta, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
    const cuerpo = r.ok ? await r.json() : null
    return { t, status: r.status, cuerpo }
  } catch (e) { return { t, status: 0, error: e.cause?.code || e.name } }
}

// ── Estado compartido ──────────────────────────────────────────────────────
let siguienteMinimo = null
const vistas = new Set()            // números de puja aceptada vistos por algún comprador
const reconexiones = []             // { usuario, cerradaEn, abiertaEn, ms, codigo }
const errores = { ws: 0, mensajesError: 0 }
let enviadas = 0, rechazadas = 0, terminando = false

async function ticket(token) {
  const r = await fetch(API + '/api/sesion/ticket-ws', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error('ticket HTTP ' + r.status)
  return (await r.json()).ticket
}

function cliente(c) {
  const estado = { c, ws: null, abierto: false, cerradaEn: null, codigo: null }
  const conectar = async () => {
    while (!terminando) {
      try {
        const ws = new WebSocket(`${WS}/ws/salas/${SUBASTA}?ticket=${encodeURIComponent(await ticket(c.token))}`)
        await new Promise((ok, mal) => { ws.onopen = ok; ws.onerror = mal; setTimeout(() => mal(new Error('timeout')), 8000) })
        estado.ws = ws
        estado.abierto = true
        if (estado.cerradaEn) {
          const abiertaEn = ahora()
          reconexiones.push({ usuario: c.id, cerradaEn: iso(estado.cerradaEn), abiertaEn: iso(abiertaEn), ms: abiertaEn - estado.cerradaEn, codigo: estado.codigo })
          estado.cerradaEn = null
        }
        ws.onmessage = (m) => {
          let msg
          try { msg = JSON.parse(m.data) } catch { return }
          if (msg.tipo === 'PUJA_ACEPTADA') {
            vistas.add(Number(msg.datos.cantidadPujas))
            siguienteMinimo = Math.max(siguienteMinimo ?? 0, Number(msg.datos.siguienteMinimo))
          } else if (msg.tipo === 'PUJA_RECHAZADA') {
            if (msg.datos?.usuarioId === c.id) rechazadas++
            if (msg.datos?.siguienteMinimo) siguienteMinimo = Math.max(siguienteMinimo ?? 0, Number(msg.datos.siguienteMinimo))
          } else if (msg.tipo === 'ERROR') errores.mensajesError++
        }
        await new Promise((fin) => { ws.onclose = (e) => { estado.codigo = e.code; fin() } })
        estado.abierto = false
        if (terminando) return
        estado.cerradaEn = ahora()      // corte inesperado: se reconecta como el navegador
      } catch {
        errores.ws++
        await esperar(500)
      }
    }
  }
  estado.listo = conectar()
  return estado
}

function az(args) {
  return execFileSync('az', [...args, '--only-show-errors'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function replicas(app) {
  const rev = az(['containerapp', 'revision', 'list', '-g', GRUPO, '-n', app, '--query', '[?properties.active].name | [0]', '-o', 'tsv'])
  const nombres = az(['containerapp', 'replica', 'list', '-g', GRUPO, '-n', app, '--revision', rev, '--query', '[].name', '-o', 'tsv']).split('\n').filter(Boolean)
  const contenedor = az(['containerapp', 'show', '-g', GRUPO, '-n', app, '--query', 'properties.template.containers[0].name', '-o', 'tsv'])
  return { app, rev, nombres, contenedor }
}

function matar({ app, rev, nombres, contenedor }) {
  const victima = nombres[0]
  // Detiene el proceso del servicio (PID 1) y Azure repone la réplica. Detalles que hacían que no pasara nada:
  //  - el kernel ignora SIGKILL enviado a PID 1 desde su propio espacio de procesos: `kill -9 1` no hace nada;
  //    la JVM sí atiende SIGTERM y termina, así que se usa `kill -TERM 1` (detención de la réplica);
  //  - `az containerapp exec` necesita una terminal: va dentro de `script`;
  //  - --command se parte por espacios: no admite comillas ni `sh -c '...'`.
  const cmd = `timeout 25s az containerapp exec -g ${GRUPO} -n ${app} --revision ${rev} --replica ${victima} --container ${contenedor} --command "kill -TERM 1"`
  const p = spawn('script', ['-qec', cmd, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let salida = ''
  p.stdout.on('data', (d) => { salida += d })
  p.on('exit', () => { if (!/Connect|Disconnect/i.test(salida)) console.log(`⚠️ exec en ${app}: ${salida.slice(-300)}`) })
  return { app, victima }
}

// ── Corrida ────────────────────────────────────────────────────────────────
const detalle = await rest(`/api/subastas/${SUBASTA}`, compradores[0].token)
if (detalle.status !== 200 || detalle.cuerpo.estado !== 'EN_CURSO') throw new Error(`La subasta no está EN_CURSO (HTTP ${detalle.status})`)
siguienteMinimo = detalle.cuerpo.siguienteMinimo
const base = detalle.cuerpo.cantidadPujas

const antesDeCaos = SIN_CAOS ? null : { auction: replicas('auction-service'), realtime: replicas('realtime-gateway') }
if (antesDeCaos) for (const r of Object.values(antesDeCaos)) if (r.nombres.length < 2) throw new Error(`${r.app} tiene ${r.nombres.length} réplica(s); DIS-01 exige 2`)

console.log(`DIS-01 · ${N} compradores, ${PPS} pujas/s, falla a los ${ANTES} s, observación ${DESPUES} s después`)
const clientes = compradores.map(cliente)
for (let i = 0; i < 40 && clientes.filter((s) => s.abierto).length < N; i++) await esperar(500)
console.log(`Conectados: ${clientes.filter((s) => s.abierto).length}/${N}`)

const sondas = []
let sondeando = true
;(async () => { while (sondeando) { sondas.push(await rest(`/api/subastas/${SUBASTA}`, compradores[0].token)); await esperar(200) } })()

let pujando = true
;(async () => {
  for (let k = 0; pujando; k++) {
    const abiertos = clientes.filter((s) => s.abierto)
    const s = abiertos[k % Math.max(1, abiertos.length)]
    if (s && siguienteMinimo) { try { s.ws.send(JSON.stringify({ tipo: 'PUJAR', monto: siguienteMinimo })); enviadas++ } catch { /* reconectando */ } }
    await esperar(1000 / PPS)
  }
})()

const inicio = ahora()
await esperar(ANTES * 1000)
const falla = ahora()
let victimas = []
if (antesDeCaos) {
  victimas = [matar(antesDeCaos.auction), matar(antesDeCaos.realtime)]
  console.log(`💥 Falla a las ${iso(falla)} (${horaMx(falla)} hora de México): ${victimas.map((v) => `${v.app}/${v.victima}`).join(', ')}`)
}
await esperar(DESPUES * 1000)
pujando = false
sondeando = false
await esperar(5000)                      // eventos en vuelo
terminando = true
for (const s of clientes) try { s.ws?.close() } catch { /* ya cerrado */ }

const final = await rest(`/api/subastas/${SUBASTA}`, compradores[0].token)
const finalPujas = final.cuerpo?.cantidadPujas ?? null
const perdidas = []
for (let n = base + 1; n <= (finalPujas ?? base); n++) if (!vistas.has(n)) perdidas.push(n)
const ventana30 = sondas.filter((s) => s.t >= falla && s.t < falla + 30000)
const err30 = ventana30.filter((s) => s.status !== 200).length
const errTotal = sondas.filter((s) => s.status !== 200).length
const maxReconexion = reconexiones.reduce((m, r) => Math.max(m, r.ms), 0)

let reposicion = null
if (antesDeCaos) {
  for (let i = 0; i < MAX_REPOSICION / 5 && !reposicion; i++) {
    const actuales = { auction: replicas('auction-service'), realtime: replicas('realtime-gateway') }
    const listas = Object.values(actuales).every((r) => r.nombres.length >= 2 && !r.nombres.includes(victimas.find((v) => v.app === r.app).victima))
    if (listas) reposicion = { observadaEn: iso(ahora()), replicas: Object.fromEntries(Object.entries(actuales).map(([k, r]) => [k, r.nombres])) }
    else await esperar(5000)
  }
}

const resultado = {
  subasta: SUBASTA, inicio: iso(inicio), falla: antesDeCaos ? iso(falla) : null, victimas,
  clientes: N, pujasPorSegundo: PPS, enviadas, rechazadasPropias: rechazadas,
  pujasAceptadas: finalPujas == null ? null : finalPujas - base, pujasAceptadasPerdidas: perdidas,
  rest: {
    muestras: sondas.length, errores: errTotal,
    en30sTrasFalla: { muestras: ventana30.length, errores: err30, porcentaje: ventana30.length ? +(100 * err30 / ventana30.length).toFixed(2) : null },
    codigos: Object.fromEntries([...new Set(sondas.map((s) => s.status))].map((c) => [c, sondas.filter((s) => s.status === c).length])),
  },
  websocket: { cortados: reconexiones.length, reconexionMaximaMs: maxReconexion, reconexiones, erroresDeConexion: errores.ws, mensajesError: errores.mensajesError },
  reposicion,
}
const criterios = antesDeCaos ? [
  ['Errores REST en los 30 s tras la falla < 2 %', resultado.rest.en30sTrasFalla.porcentaje !== null && resultado.rest.en30sTrasFalla.porcentaje < 2],
  ['Reconexión WebSocket < 10 s', reconexiones.length > 0 && maxReconexion < 10000],
  ['0 pujas aceptadas perdidas', finalPujas != null && perdidas.length === 0 && finalPujas > base],
  ['Réplicas repuestas (2 por servicio, sin la caída)', !!reposicion],
] : []
resultado.criterios = Object.fromEntries(criterios)
const archivo = new URL(`./resultado-caos-${iso(inicio).replace(/[:.]/g, '')}.json`, import.meta.url)
writeFileSync(archivo, JSON.stringify(resultado, null, 2))

console.log(`\nREST: ${ventana30.length} consultas en los 30 s tras la falla, ${err30} con error (${resultado.rest.en30sTrasFalla.porcentaje} %) · códigos ${JSON.stringify(resultado.rest.codigos)}`)
console.log(`WebSocket: ${reconexiones.length} cortados, reconexión máxima ${maxReconexion} ms`)
console.log(`Pujas: ${enviadas} enviadas, ${resultado.pujasAceptadas} aceptadas, perdidas: ${perdidas.length}`)
console.log(`Reposición: ${reposicion ? reposicion.observadaEn : 'NO observada en 3 min'}`)
for (const [c, ok] of criterios) console.log(`${ok ? '✅' : '❌'} ${c}`)
console.log(`Resultado: ${archivo.pathname}`)
process.exit(criterios.every(([, ok]) => ok) ? 0 : 1)
