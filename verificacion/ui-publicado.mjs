// Verificación del sitio publicado con un navegador real (Chrome sin interfaz, controlado por CDP).
// Cubre lo que un script de API no ve: CORS, rutas de la SPA y el WebSocket desde el navegador.
// Uso: node ui-publicado.mjs [https://cafeorbe-web.vercel.app]
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sesionDePrueba } from './sesiones-de-prueba.mjs'

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const WEB = process.argv[2] ?? 'https://cafeorbe-web.vercel.app'
const PUERTO = 9334
const SALDO = process.env.SALDO_INICIAL ?? '100000000'
const orbes = (n) => `${Number(n).toLocaleString('es-CO')} Orbes` // la pantalla separa los miles: "100.000.000 Orbes"
const sufijo = Date.now().toString(36)
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

const resultados = []
function comprobar(nombre, ok, detalle = '') {
  resultados.push(ok)
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${nombre}${ok ? '' : `  → ${detalle}`}`)
}

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PUERTO}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cafeorbe-pub-'))}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

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
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errores.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`.slice(0, 200))
    }
  }
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Log.enable')
}

async function js(expresion) {
  const r = await cdp('Runtime.evaluate', { expression: expresion, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function hasta(expresion, ms = 15000) {
  const fin = Date.now() + ms
  for (;;) {
    const v = await js(expresion).catch(() => null)
    if (v) return v
    if (Date.now() > fin) return null
    await esperar(250)
  }
}

const ir = async (ruta) => {
  await cdp('Page.navigate', { url: WEB + ruta })
  await esperar(800)
}
const texto = () => js('document.body.innerText')
const clicBoton = (rotulo) =>
  js(`(() => { const b = [...document.querySelectorAll('button, a')].find((e) => e.innerText.trim().includes(${JSON.stringify(rotulo)})); if (!b) return false; b.click(); return true })()`)

/**
 * SEG-01: el sitio solo deja entrar con Google, que un navegador automatizado no puede usar. La sesión la firma
 * la herramienta del operador y se guarda donde la dejaría el ingreso con Google; luego se abre el home del rol.
 */
async function ingresar(nombre, rol) {
  const sesion = await sesionDePrueba(nombre, rol)
  await ir('/login')
  await js(`sessionStorage.setItem('cafeorbe.sesion', ${JSON.stringify(JSON.stringify({ token: sesion.token, usuario: sesion.usuario }))})`)
  await ir(rol === 'SUBASTADOR' ? '/subastador' : '/comprador')
}

async function main() {
  await conectar()

  // Recargar una ruta interna no debe dar 404 (reescritura de Vercel).
  await ir('/comprador')
  const enLogin = await hasta(`location.pathname === '/login' && document.body.innerText.includes('Entra a la subasta')`)
  comprobar('abrir una ruta interna sin sesión lleva a la pantalla de acceso (no 404)', !!enLogin, await js('location.pathname + " | " + document.title'))
  const sinLoginPropio = await js(`!document.querySelector('input[type="text"], input[type="password"]')`)
  comprobar('SEG-01: el acceso no tiene login propio (ni nombre ni contraseña), solo Google', sinLoginPropio === true, (await texto()).slice(0, 200))

  // Subastador: ingreso, crear subasta, reglas e inicio, todo desde la interfaz.
  await ingresar(`Luis pub ${sufijo}`, 'SUBASTADOR')
  const homeSub = await hasta(`location.pathname === '/subastador'`)
  comprobar('home del Subastador con sesión (pasa CORS y el api-gateway)', !!homeSub, (await texto()).slice(0, 200))

  await ir('/subastador/subastas/nueva')
  await hasta(`!!document.querySelector('form')`)
  await js(`document.querySelector('form input[type="text"]').focus()`)
  await cdp('Input.insertText', { text: `Lote pub ${sufijo}` })
  const fecha = await js(`(() => { const f = new Date(Date.now() + 3600e3); const p = (n) => String(n).padStart(2, '0'); return f.getFullYear() + '-' + p(f.getMonth() + 1) + '-' + p(f.getDate()) + 'T' + p(f.getHours()) + ':' + p(f.getMinutes()) })()`)
  await js(`(() => { const i = document.querySelector('input[type="datetime-local"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(fecha)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await clicBoton('Guardar')
  const gestion = await hasta(`/^\\/subastador\\/subastas\\/[0-9a-f-]{36}$/.test(location.pathname) && location.pathname`)
  comprobar('crear subasta desde el formulario (POST con content-type y authorization)', !!gestion, (await texto()).slice(0, 200))
  const subastaId = gestion ? gestion.split('/').pop() : null

  // Reglas por el formulario (PUT).
  await hasta(`document.querySelectorAll('form').length >= 2`)
  await js(`(() => { const campos = [...document.querySelectorAll('form')][1].querySelectorAll('input[type="number"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; [['10'], ['100'], ['10']].forEach(([v], i) => { set.call(campos[i], v); campos[i].dispatchEvent(new Event('input', { bubbles: true })) }) })()`)
  await clicBoton('Guardar reglas')
  const reglas = await hasta(`document.body.innerText.includes('Reglas de puja guardadas')`, 10000)
  comprobar('guardar reglas (PUT)', !!reglas, (await texto()).slice(0, 200))
  await clicBoton('Iniciar subasta')
  const enSala = await hasta(`location.pathname.endsWith('/sala') && document.body.innerText.includes('En curso')`, 15000)
  comprobar('iniciar la subasta y entrar a la sala', !!enSala, await js('location.pathname'))
  const conectadoSub = await hasta(`!document.querySelector('.conexion') && /[1-9]/.test(document.querySelector('.conectados')?.innerText ?? '')`, 15000)
  comprobar('la sala del Subastador abre el WebSocket (cuenta de conectados)', !!conectadoSub, await js(`(document.querySelector('.conexion')?.innerText ?? '') + ' | ' + (document.querySelector('.conectados')?.innerText ?? '')`))

  // Comprador en la misma pestaña: sesión nueva.
  await clicBoton('Cerrar sesión')
  await js(`document.querySelector('button[aria-label="Cerrar sesión"]')?.click()`)
  await hasta(`location.pathname === '/login'`)
  await ingresar(`Ana pub ${sufijo}`, 'COMPRADOR')
  const homeCom = await hasta(`location.pathname === '/comprador'`)
  comprobar('ingreso como Comprador', !!homeCom)
  const saldo = await hasta(`document.querySelector('.saldo')?.innerText.includes('${orbes(SALDO)}')`, 15000)
  comprobar(`la barra muestra ${orbes(SALDO)} (carga automática por evento)`, !!saldo, await js(`document.querySelector('.saldo')?.innerText`))
  const listada = await hasta(`document.body.innerText.includes('Lote pub ${sufijo}')`, 10000)
  comprobar('la subasta creada aparece en el home del Comprador', !!listada)

  if (subastaId) {
    await ir(`/subastas/${subastaId}/sala`)
    const boton = await hasta(`(() => { const b = document.querySelector('.boton--puja'); return b && !b.disabled && b.innerText.replace(/\\s+/g, ' ').includes('Pujar 110') })()`, 20000)
    comprobar('la sala carga y ofrece "Pujar 110"', !!boton, await js(`document.querySelector('.boton--puja')?.innerText ?? document.body.innerText.slice(0, 200)`))
    await js(`document.querySelector('.boton--puja').click()`)
    const lider = await hasta(`(() => { const b = document.querySelector('.boton--puja'); return b && b.disabled && b.innerText.includes('Vas ganando') })()`, 10000)
    comprobar('puja por WebSocket: precio 110 y "Vas ganando"', !!lider && (await js(`document.querySelector('.precio__valor')?.innerText`)) === '110', await js(`document.querySelector('.boton--puja')?.innerText + ' | ' + (document.querySelector('.panel-puja__error')?.innerText ?? '')`))
  }

  const graves = errores.filter((e) => !/favicon/.test(e))
  comprobar(`sin errores de red ni de consola (${graves.length})`, graves.length === 0, graves.slice(0, 4).join(' | '))

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
