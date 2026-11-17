// DIS-01 + OBS-01: caída de réplicas BAJO CARGA, medida desde el lado del cliente.
//
// Con N compradores conectados por WebSocket (que se reconectan con la MISMA política que el cliente web) y pujas
// sostenidas, termina el proceso de 1 réplica de auction-service y 1 de realtime-gateway y mide:
//   - % de errores REST en los 30 s posteriores a la falla (meta < 2 %), con la latencia de esas consultas,
//   - tiempo de reconexión de cada WebSocket cortado (meta < 10 s),
//   - pujas aceptadas perdidas (meta 0): cada puja que quedó guardada (cantidadPujas final) debe haberse
//     notificado a la sala, y ninguna puja notificada como aceptada puede faltar en lo guardado,
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

// Como el navegador, la consulta espera la respuesta del gateway (que ya corta y reintenta los GET a ~1,2 s por
// intento); 10 s es solo un tope para no quedarse colgado. La latencia se reporta aparte.
async function rest(ruta, token, tope = 10_000) {
  const t = ahora()
  try {
    const r = await fetch(API + ruta, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(tope) })
    const cuerpo = r.ok ? await r.json() : null
    return { t, ms: ahora() - t, status: r.status, cuerpo }
  } catch (e) { return { t, ms: ahora() - t, status: 0, error: e.cause?.code || e.name } }
}

// DIS-01: misma política de reconexión que cafeorbe-web (src/shared/ws/salaSocket.ts). Con otra política el script
// mediría un cliente distinto del que usan los compradores.
//   - Límite para abrir: 3 veces lo que tardó la última conexión buena, entre 0,8 y 3 s (1,5 s antes de la primera),
//     y nunca más de 1,5 s dentro de la ventana rápida (corrida del 17 nov: con 3 s, 3 intentos colgados = 10 s).
//   - Durante los primeros 10 s tras el corte se reintenta cada 200 ms; después 1 s, 2 s, 4 s… hasta 10 s.
//   - Hasta 30 % aleatorio sobre cada espera.
const ESPERA_CONEXION_MS = 1_500
const ESPERA_CONEXION_MIN_MS = 800
const ESPERA_CONEXION_MAX_MS = 3_000
const ESPERA_CONEXION_VENTANA_MAX_MS = 1_500
const FACTOR_ESPERA_CONEXION = 3
const VENTANA_RAPIDA_MS = 10_000
const ESPERA_REINTENTO_RAPIDO_MS = 200
function esperaReintento(estado) {
  const t = ahora()
  estado.desconectadoDesde ??= t
  const base = t - estado.desconectadoDesde < VENTANA_RAPIDA_MS
    ? ESPERA_REINTENTO_RAPIDO_MS
    : Math.min(1000 * 2 ** estado.intentosLentos++, 10_000)
  return base + Math.floor(Math.random() * base * 0.3)
}
function esperaConexionTras(msHastaAbrir) {
  return Math.min(ESPERA_CONEXION_MAX_MS, Math.max(ESPERA_CONEXION_MIN_MS, msHastaAbrir * FACTOR_ESPERA_CONEXION))
}

// ── Estado compartido ──────────────────────────────────────────────────────
let siguienteMinimo = null
const vistas = new Set()            // números de puja aceptada vistos por algún comprador
const reconexiones = []             // { usuario, cerradaEn, abiertaEn, ms, codigo, intentos: [...] }
// DIS-01: cada intento fallido con su fase y motivo, para saber si una reconexión lenta se debe al ingreso (la
// conexión no abre), al ticket (POST a identity) o a otra cosa. { usuario, en, fase, motivo, ms }
const intentosFallidos = []
const errores = { ws: 0, mensajesError: 0 }
let enviadas = 0, rechazadas = 0, terminando = false

/** Error del paso del ticket, con un motivo legible: "HTTP 503", "tiempo agotado (5 s)" o el código de red. */
class FalloDeTicket extends Error {
  constructor(motivo) { super(motivo); this.motivo = motivo }
}
async function ticket(token) {
  let r
  try {
    r = await fetch(API + '/api/sesion/ticket-ws', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  } catch (e) {
    const codigo = e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.name
    throw new FalloDeTicket(e.name === 'TimeoutError' ? 'tiempo agotado (5 s)' : `red: ${codigo}`)
  }
  if (!r.ok) throw new FalloDeTicket(`HTTP ${r.status}`)
  return (await r.json()).ticket
}

function cliente(c) {
  const estado = { c, ws: null, abierto: false, cerradaEn: null, codigo: null,
    intentosLentos: 0, desconectadoDesde: null, esperaConexion: ESPERA_CONEXION_MS, fallosDesdeCorte: [] }
  const conectar = async () => {
    let primera = true
    while (!terminando) {
      if (!primera) await esperar(esperaReintento(estado))
      primera = false
      if (terminando) return
      let ws = null
      const intentoDesde = ahora()
      let fase = 'ticket'
      try {
        const url = `${WS}/ws/salas/${SUBASTA}?ticket=${encodeURIComponent(await ticket(c.token))}`
        fase = 'conexion'
        const abriendoDesde = ahora()
        const enVentana = estado.desconectadoDesde !== null && abriendoDesde - estado.desconectadoDesde < VENTANA_RAPIDA_MS
        const msLimite = enVentana ? Math.min(estado.esperaConexion, ESPERA_CONEXION_VENTANA_MAX_MS) : estado.esperaConexion
        ws = new WebSocket(url)
        await new Promise((ok, mal) => {
          const limite = setTimeout(() => mal(new Error(`no abrió en ${msLimite} ms`)), msLimite)
          ws.onopen = () => { clearTimeout(limite); estado.esperaConexion = esperaConexionTras(ahora() - abriendoDesde); ok() }
          ws.onerror = () => { clearTimeout(limite); mal(new Error('error de conexión')) }
          ws.onclose = (e) => { clearTimeout(limite); mal(new Error(`cerrada al abrir (${e?.code ?? '?'})`)) }
        })
      } catch (e) {
        errores.ws++
        const fallo = { usuario: c.id, en: iso(intentoDesde), fase, motivo: e?.motivo ?? e?.message ?? String(e), ms: ahora() - intentoDesde }
        intentosFallidos.push(fallo)
        estado.fallosDesdeCorte.push({ en: fallo.en, fase: fallo.fase, motivo: fallo.motivo, ms: fallo.ms })
        // La conexión que no abrió a tiempo se descarta (como en la web) para que no se abra después por su cuenta.
        if (ws) { ws.onopen = ws.onerror = ws.onclose = null; try { ws.close() } catch { /* ya cerrada */ } }
        continue
      }
      ws.onerror = null
      estado.intentosLentos = 0
      estado.desconectadoDesde = null
      estado.ws = ws
      estado.abierto = true
      if (estado.cerradaEn) {
        const abiertaEn = ahora()
        reconexiones.push({ usuario: c.id, cerradaEn: iso(estado.cerradaEn), abiertaEn: iso(abiertaEn), ms: abiertaEn - estado.cerradaEn,
          codigo: estado.codigo, intentos: estado.fallosDesdeCorte })
        estado.cerradaEn = null
      }
      estado.fallosDesdeCorte = []
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
  const lista = JSON.parse(az(['containerapp', 'replica', 'list', '-g', GRUPO, '-n', app, '--revision', rev,
    '--query', '[].{n:name, r:properties.containers[0].restartCount, s:properties.containers[0].runningState}', '-o', 'json']) || '[]')
  const nombres = lista.map((x) => x.n)
  const reinicios = Object.fromEntries(lista.map((x) => [x.n, x.r ?? 0]))
  const enMarcha = lista.filter((x) => !x.s || /running/i.test(x.s)).length
  const contenedor = az(['containerapp', 'show', '-g', GRUPO, '-n', app, '--query', 'properties.template.containers[0].name', '-o', 'tsv'])
  return { app, rev, nombres, reinicios, enMarcha, contenedor }
}

function matar({ app, rev, nombres, reinicios, contenedor }) {
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
  return { app, victima, reiniciosAntes: reinicios[victima] ?? 0 }
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

// Lectura final de lo guardado: se reintenta (la réplica caída puede seguir reiniciando) para que el criterio de
// pujas perdidas no quede "no medible" por una sola consulta lenta, como pasó en la corrida del 16 nov.
let final = null
for (let i = 0; i < 6 && final?.status !== 200; i++) {
  if (i) await esperar(5000)
  final = await rest(`/api/subastas/${SUBASTA}`, compradores[0].token, 15_000)
}
const finalPujas = final?.status === 200 ? final.cuerpo.cantidadPujas : null
// Perdida: quedó guardada y ningún comprador recibió su aviso. Fantasma: se avisó como aceptada y no quedó guardada.
const perdidas = []
for (let n = base + 1; n <= (finalPujas ?? base); n++) if (!vistas.has(n)) perdidas.push(n)
const fantasmas = finalPujas == null ? [] : [...vistas].filter((n) => n > finalPujas).sort((a, b) => a - b)
const ventana30 = sondas.filter((s) => s.t >= falla && s.t < falla + 30000)
const err30 = ventana30.filter((s) => s.status !== 200).length
const latencias30 = ventana30.map((s) => s.ms).sort((a, b) => a - b)
const p95_30 = latencias30.length ? latencias30[Math.ceil(0.95 * latencias30.length) - 1] : null
const errTotal = sondas.filter((s) => s.status !== 200).length
const maxReconexion = reconexiones.reduce((m, r) => Math.max(m, r.ms), 0)
/** Cuenta los intentos fallidos por fase y motivo, p. ej. { "conexion · no abrió en 800 ms": 12, "ticket · HTTP 503": 3 }. */
function porMotivo(fallos) {
  const cuenta = {}
  for (const f of fallos) cuenta[`${f.fase} · ${f.motivo}`] = (cuenta[`${f.fase} · ${f.motivo}`] ?? 0) + 1
  return Object.fromEntries(Object.entries(cuenta).sort((a, b) => b[1] - a[1]))
}

console.log(`Medición lista (antes de esperar reposición): REST 30 s ${err30}/${ventana30.length} con error · WS máx ${maxReconexion} ms · pujas perdidas ${perdidas.length}`)
let reposicion = null
if (antesDeCaos) {
  for (let i = 0; i < MAX_REPOSICION / 5 && !reposicion; i++) {
    const actuales = { auction: replicas('auction-service'), realtime: replicas('realtime-gateway') }
    // Al terminar PID 1, Container Apps reinicia el contenedor dentro de la MISMA réplica (mismo nombre,
    // restartCount + 1) o crea una réplica nueva: cualquiera de los dos cuenta como reposición.
    const listas = Object.values(actuales).every((r) => {
      const v = victimas.find((x) => x.app === r.app)
      const repuesta = !r.nombres.includes(v.victima) || (r.reinicios[v.victima] ?? 0) > v.reiniciosAntes
      return r.nombres.length >= 2 && r.enMarcha >= 2 && repuesta
    })
    if (listas) reposicion = { observadaEn: iso(ahora()), replicas: Object.fromEntries(Object.entries(actuales).map(([k, r]) => [k, r.reinicios])) }
    else await esperar(5000)
  }
}

const resultado = {
  subasta: SUBASTA, inicio: iso(inicio), falla: antesDeCaos ? iso(falla) : null, victimas,
  clientes: N, pujasPorSegundo: PPS, enviadas, rechazadasPropias: rechazadas,
  pujasAceptadas: finalPujas == null ? null : finalPujas - base, pujasAceptadasPerdidas: perdidas, pujasFantasma: fantasmas,
  // Informativo: pujas enviadas sin aviso de aceptada ni de rechazo (salieron por un socket que se estaba cerrando).
  pujasSinRespuesta: finalPujas == null ? null : Math.max(0, enviadas - (finalPujas - base) - rechazadas),
  rest: {
    muestras: sondas.length, errores: errTotal,
    en30sTrasFalla: { muestras: ventana30.length, errores: err30, porcentaje: ventana30.length ? +(100 * err30 / ventana30.length).toFixed(2) : null,
      latenciaP95Ms: p95_30, latenciaMaximaMs: latencias30.at(-1) ?? null },
    codigos: Object.fromEntries([...new Set(sondas.map((s) => s.status))].map((c) => [c, sondas.filter((s) => s.status === c).length])),
  },
  websocket: { cortados: reconexiones.length, reconexionMaximaMs: maxReconexion, reconexiones, erroresDeConexion: errores.ws, mensajesError: errores.mensajesError,
    fallosPorMotivo: porMotivo(intentosFallidos), intentosFallidos },
  reposicion,
}
const criterios = antesDeCaos ? [
  ['Errores REST en los 30 s tras la falla < 2 %', resultado.rest.en30sTrasFalla.porcentaje !== null && resultado.rest.en30sTrasFalla.porcentaje < 2],
  ['Reconexión WebSocket < 10 s', reconexiones.length > 0 && maxReconexion < 10000],
  ['0 pujas aceptadas perdidas', finalPujas != null && perdidas.length === 0 && fantasmas.length === 0 && finalPujas > base],
  ['Réplicas repuestas (2 por servicio, sin la caída)', !!reposicion],
] : []
resultado.criterios = Object.fromEntries(criterios)
const archivo = new URL(`./resultado-caos-${iso(inicio).replace(/[:.]/g, '')}.json`, import.meta.url)
writeFileSync(archivo, JSON.stringify(resultado, null, 2))

console.log(`\nREST: ${ventana30.length} consultas en los 30 s tras la falla, ${err30} con error (${resultado.rest.en30sTrasFalla.porcentaje} %), p95 ${p95_30} ms · códigos ${JSON.stringify(resultado.rest.codigos)}`)
console.log(`WebSocket: ${reconexiones.length} cortados, reconexión máxima ${maxReconexion} ms`)
console.log(`Intentos fallidos: ${intentosFallidos.length} · ${JSON.stringify(resultado.websocket.fallosPorMotivo)}`)
// Las reconexiones lentas, con cada intento: así se ve si fallaba la conexión (ingreso) o el ticket.
for (const r of [...reconexiones].sort((a, b) => b.ms - a.ms).filter((r) => r.ms >= 5000)) {
  console.log(`  ${r.ms} ms (corte ${r.cerradaEn.slice(11, 23)}): ` + r.intentos.map((i) => `${i.en.slice(17, 23)} ${i.fase}/${i.motivo} (${i.ms} ms)`).join(' → '))
}
console.log(`Pujas: ${enviadas} enviadas, ${resultado.pujasAceptadas ?? 'lectura final fallida'} aceptadas, perdidas: ${perdidas.length}, fantasma: ${fantasmas.length}, sin respuesta: ${resultado.pujasSinRespuesta}`)
console.log(`Reposición: ${reposicion ? reposicion.observadaEn : 'NO observada en 3 min'}`)
for (const [c, ok] of criterios) console.log(`${ok ? '✅' : '❌'} ${c}`)
console.log(`Resultado: ${archivo.pathname}`)
process.exit(criterios.every(([, ok]) => ok) ? 0 : 1)
