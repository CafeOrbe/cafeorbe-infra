// Verificación de la interfaz del Sprint 2 con un navegador real (Chrome sin interfaz, controlado por CDP).
// Usa subastas de 1 minuto, así que tarda cerca de 2 minutos.
// Uso: node ui-sprint2.mjs   (variables opcionales: WEB_URL, API_URL, SALDO_INICIAL, CHROME)
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sesionDePrueba } from './sesiones-de-prueba.mjs'

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://localhost:8080'
const SALDO = Number(process.env.SALDO_INICIAL ?? 100000000)
const orbes = (n) => `${Number(n).toLocaleString('es-CO')} Orbes` // la pantalla separa los miles: "100.000.000 Orbes"
const PUERTO = 9335
const sufijo = Date.now().toString(36)
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

const resultados = []
function comprobar(hu, nombre, ok, detalle = '') {
  resultados.push(ok)
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${hu} · ${nombre}${ok ? '' : `  → ${detalle}`}`)
}

async function http(metodo, ruta, token, cuerpo) {
  const headers = {}
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(API + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) })
  const t = await r.text()
  return t ? JSON.parse(t) : null
}

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PUERTO}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cafeorbe-s2-'))}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

let ws
let siguienteId = 1
const pendientes = new Map()
const errores = []

function cdp(method, params = {}) {
  const id = siguienteId++
  return new Promise((resolver, rechazar) => {
    pendientes.set(id, (m) => (m.error ? rechazar(new Error(m.error.message)) : resolver(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function conectar() {
  let objetivos = null
  for (let i = 0; i < 50 && !objetivos; i++) {
    objetivos = await fetch(`http://localhost:${PUERTO}/json/list`).then((r) => r.json()).catch(() => null)
    if (!objetivos) await esperar(200)
  }
  ws = new WebSocket(objetivos.find((o) => o.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pendientes.has(m.id)) {
      pendientes.get(m.id)(m)
      pendientes.delete(m.id)
    } else if (m.method === 'Runtime.exceptionThrown') {
      errores.push('excepción: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 200))
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errores.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    }
  }
  await cdp('Runtime.enable')
  await cdp('Page.enable')
}

async function js(expresion) {
  const r = await cdp('Runtime.evaluate', { expression: expresion, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function hasta(expresion, ms = 12000) {
  const fin = Date.now() + ms
  for (;;) {
    const v = await js(expresion).catch(() => null)
    if (v) return v
    if (Date.now() > fin) return null
    await esperar(200)
  }
}

const ir = async (ruta) => {
  await cdp('Page.navigate', { url: WEB + ruta })
  await esperar(800)
}
const texto = () => js('document.body.innerText')
const clicEn = (rotulo) =>
  js(`(() => { const b = [...document.querySelectorAll('button, a')].find((e) => e.innerText.trim().includes(${JSON.stringify(rotulo)})); if (!b) return false; b.click(); return true })()`)
/** Segundos que muestra el temporizador de la pantalla, o null si no está. */
const reloj = () => js(`(() => { const v = document.querySelector('.temporizador__valor')?.innerText; if (!v) return null; const p = v.split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : null })()`)

async function sesionApi(nombre, rol) {
  // SEG-01: no hay login propio; la sesión la firma la herramienta del operador (sesiones-de-prueba.mjs).
  const r = await sesionDePrueba(nombre, rol)
  return { token: r.token, usuario: r.usuario }
}

async function crearSubasta(luis, nombre, minutos) {
  const id = (await http('POST', '/api/subastas', luis.token, { nombre, descripcion: 'Verificación de interfaz', fechaInicio: new Date(Date.now() + 1800_000).toISOString() })).id
  await http('PUT', `/api/subastas/${id}/ficha`, luis.token, { identificacion: 'UI2-001', tipoCafe: 'Castillo', pesoKg: 40, edadMeses: 1, observaciones: '' })
  await http('PUT', `/api/subastas/${id}/reglas`, luis.token, { duracionMinutos: minutos, precioBase: 100, incrementoMinimo: 10 })
  return id
}

async function main() {
  await conectar()

  const luis = await sesionApi(`Luis ui2 ${sufijo}`, 'SUBASTADOR')
  const bea = await sesionApi(`Bea ui2 ${sufijo}`, 'COMPRADOR')
  const corta = await crearSubasta(luis, `Lote ui2 ${sufijo}`, 1)
  const larga = await crearSubasta(luis, `Lote largo ${sufijo}`, 3)
  const desierta = await crearSubasta(luis, `Lote desierto ${sufijo}`, 1)

  // Ana entra con su sesión de prueba (SEG-01: solo Google, que no se puede automatizar).
  const ana = await sesionApi(`Ana ui2 ${sufijo}`, 'COMPRADOR')
  await ir('/login')
  await hasta(`document.body.innerText.includes('Entra a la subasta')`, 30000)
  await js(`sessionStorage.setItem('cafeorbe.sesion', ${JSON.stringify(JSON.stringify({ token: ana.token, usuario: ana.usuario }))})`)
  await ir('/comprador')
  await hasta(`location.pathname === '/comprador'`)
  await hasta(`document.querySelector('.saldo')?.innerText.includes('${orbes(SALDO)}')`, 15000)

  // ── HU-17 · Temporizador sin alerta (subasta de 3 minutos) ─────────────
  await http('POST', `/api/subastas/${larga}/iniciar`, luis.token)
  await ir(`/subastas/${larga}/sala`)
  const relojLargo = await hasta(`!!document.querySelector('.temporizador__valor') && document.querySelector('.temporizador__valor').innerText`)
  const segLargo = await reloj()
  comprobar('HU-17', `la sala muestra la cuenta regresiva en mm:ss (${relojLargo})`, /^\d{2}:\d{2}$/.test(relojLargo ?? '') && segLargo > 150 && segLargo <= 180, String(relojLargo))
  comprobar('HU-17', 'con más de un minuto el temporizador no está en alerta', (await js(`document.querySelector('.temporizador').classList.contains('temporizador--alerta')`)) === false)
  const antes = await reloj()
  await ir(`/subastas/${larga}/sala`)
  await hasta(`!!document.querySelector('.temporizador__valor')`)
  const despues = await reloj()
  comprobar('HU-17', `no se desfasa al recargar (antes ${antes} s, después ${despues} s)`, despues <= antes && antes - despues <= 4, `${antes} → ${despues}`)

  // ── Sala de la subasta corta: Programada, sin temporizador ─────────────
  await ir(`/subastas/${corta}/sala`)
  await hasta(`document.body.innerText.includes('Lote ui2 ${sufijo}') && !!document.querySelector('.boton--puja')`)
  comprobar('HU-17', 'una subasta que no ha iniciado no muestra temporizador', (await js(`!document.querySelector('.temporizador')`)) === true)

  // Se inician la corta y la desierta. Bea puja primero por API: Ana ve al líder y el precio.
  await http('POST', `/api/subastas/${desierta}/iniciar`, luis.token)
  await http('POST', `/api/subastas/${corta}/iniciar`, luis.token)
  const arranco = await hasta(`!!document.querySelector('.temporizador__valor')`, 6000)
  comprobar('HU-17', 'al iniciar la subasta el temporizador aparece sin recargar', !!arranco)
  comprobar('HU-16', 'subasta sin pujas: precio base y la leyenda "Sin pujas"', (await texto()).includes('Sin pujas') && (await js(`document.querySelector('.precio__valor')?.innerText`)) === '100')
  await http('POST', `/api/subastas/${corta}/pujas`, bea.token, { monto: 110 })
  const lidera = await hasta(`document.body.innerText.includes('Lidera Bea ui2 ${sufijo}') && document.querySelector('.precio__valor')?.innerText === '110'`, 6000)
  comprobar('HU-16', 'tras la puja de otro comprador se ve el precio en 110 y el nuevo líder sin recargar', !!lidera)

  // ── HU-17 · Alerta del último minuto ───────────────────────────────────
  const alerta = await hasta(`document.querySelector('.temporizador')?.classList.contains('temporizador--alerta')`, 8000)
  comprobar('HU-17', 'con menos de 60 segundos el temporizador cambia de color como alerta', !!alerta)

  // ── HU-18 · Ana puja con menos de 15 s: tiempo extendido ───────────────
  console.log(`       (esperando a que el temporizador baje a 15 s; va en ${await reloj()} s)`)
  const fin = Date.now() + 70_000
  while ((await reloj()) > 15 && Date.now() < fin) await esperar(250)
  const antesDeExtender = await reloj()
  await js(`document.querySelector('.boton--puja').click()`)
  const aviso = await hasta(`document.querySelector('.conexion--extension')?.innerText`, 6000)
  comprobar('HU-18', 'se muestra el aviso "Tiempo extendido"', (aviso ?? '').includes('Tiempo extendido'), String(aviso))
  const trasExtender = await reloj()
  comprobar('HU-18', `el temporizador refleja el nuevo tiempo (de ${antesDeExtender} s a ${trasExtender} s)`, trasExtender > antesDeExtender + 20, `${antesDeExtender} → ${trasExtender}`)
  comprobar('HU-16', 'cuando el líder soy yo, el panel lo resalta', (await js(`!!document.querySelector('.panel-puja--lider')`)) === true)

  // ── HU-19 y HU-21 · Cierre con ganador ─────────────────────────────────
  console.log(`       (esperando el cierre; quedan ${await reloj()} s)`)
  const anuncio = await hasta(`document.querySelector('.anuncio')?.innerText`, 70_000)
  comprobar('HU-21', 'al cerrar aparece el anuncio del ganador sin recargar', (anuncio ?? '').includes(`Ganaste, Ana ui2 ${sufijo}`) && (anuncio ?? '').includes('120 Orbes'), String(anuncio))
  const boton = await js(`(() => { const b = document.querySelector('.boton--puja'); return { texto: b.innerText.trim(), deshabilitado: b.disabled } })()`)
  comprobar('HU-19', 'la sala pasa a Finalizada y deshabilita las pujas sin recargar', boton.deshabilitado && boton.texto.includes('Subasta cerrada') && (await texto()).includes('Finalizada'), JSON.stringify(boton))
  comprobar('HU-19', 'el temporizador desaparece al cerrar', (await js(`!document.querySelector('.temporizador')`)) === true)

  // ── HU-20 · El saldo se refresca solo ──────────────────────────────────
  const saldo = await hasta(`document.querySelector('.saldo')?.innerText.includes('${orbes(SALDO - 120)}')`, 12000)
  comprobar('HU-20', `el saldo de la barra baja a ${orbes(SALDO - 120)} sin recargar`, !!saldo, await js(`document.querySelector('.saldo')?.innerText`))

  // ── HU-22 · Resultados ─────────────────────────────────────────────────
  await clicEn('Ver resultados')
  const enResultados = await hasta(`location.pathname.endsWith('/resultados') && document.body.innerText.includes('Últimas pujas') && !!document.querySelector('.ganador')`)
  const t = await texto()
  comprobar('HU-22', 'la pantalla de resultados muestra lote, ganador, monto final y cantidad de pujas', !!enResultados && t.includes(`Ana ui2 ${sufijo}`) && t.includes('120 Orbes') && t.includes('Castillo') && t.includes('2 pujas'), t.slice(0, 400))
  const filas = await js(`[...document.querySelectorAll('.puja')].map((p) => p.innerText.replace(/\\s+/g, ' ').trim())`)
  comprobar('HU-22', 'el historial muestra las últimas pujas con su hora', filas.length === 2 && /\d{1,2}:\d{2}/.test(filas[0]) && filas[0].includes('120'), JSON.stringify(filas))

  // ── HU-23 · Volver al home ─────────────────────────────────────────────
  await clicEn('Volver al home')
  const home = await hasta(`location.pathname === '/comprador'`)
  await esperar(1500)
  comprobar('HU-23', 'Volver al home lleva al home del Comprador', !!home)
  comprobar('HU-19', 'la subasta cerrada ya no aparece entre las disponibles', !(await texto()).includes(`Lote ui2 ${sufijo}`))

  // ── HU-05 y HU-21 · Subasta desierta ───────────────────────────────────
  await ir(`/subastas/${desierta}/sala`)
  const redirigida = await hasta(`location.pathname.endsWith('/resultados') && document.body.innerText.includes('Subasta desierta: no hubo ganador')`, 20000)
  comprobar('HU-21', 'una subasta sin pujas muestra "Subasta desierta: no hubo ganador"', !!redirigida, (await texto()).slice(0, 300))

  // ── HU-22 · El Subastador ve el mismo resumen ──────────────────────────
  await js(`sessionStorage.setItem('cafeorbe.sesion', ${JSON.stringify(JSON.stringify(luis))})`)
  await ir(`/subastas/${corta}/resultados`)
  const comoLuis = await hasta(`document.body.innerText.includes('Ana ui2 ${sufijo}') && document.body.innerText.includes('120 Orbes')`)
  comprobar('HU-22', 'el Subastador ve el mismo resumen', !!comoLuis)
  await clicEn('Volver al home')
  comprobar('HU-23', 'el Subastador vuelve a su propio home', !!(await hasta(`location.pathname === '/subastador'`)))

  comprobar('DoD', `sin errores en consola (${errores.length})`, errores.length === 0, errores.slice(0, 4).join(' | '))

  console.log(`\nTOTAL: ${resultados.filter(Boolean).length}/${resultados.length}`)
  return resultados.every(Boolean) ? 0 : 1
}

let codigo = 2
try {
  codigo = await main()
} catch (e) {
  console.error('ERROR INESPERADO', e)
} finally {
  try { await cdp('Browser.close') } catch { /* ya cerrado */ }
  chrome.kill()
}
process.exit(codigo)
