import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analizar } from './analizar-carga.mjs';
function fixture() {
  const row={monto:1100,usuarioId:'u1'};
  const m={versionMedicion:2,configuracion:{usuarios:200,duracionSegundos:600,tasaObjetivo:20},
    ventana:{duracionRealMs:600001},conexiones:{minimoDuranteCarga:200,finalesActivas:200,desconexiones:0,erroresConexion:0},
    enviosPorSegundo:Array(600).fill(20),pujas:{enviadas:12000,aceptadas:1,rechazadas:11999,pendientes:0,respuestasNoCorrelacionadas:0,erroresHttpOTransporte:0,
      intentos:Array.from({length:12000},(_,i)=>({estado:i?'rechazada':'aceptada',receptores:i?0:200}))},
    eventos:{aceptadosPorSocket:Array.from({length:200},()=>[{cantidad:11,...row,latenciaMs:400}]),duplicados:0,fueraDeOrden:0,perdidosGaps:0,erroresAplicacion:0,mensajesInvalidos:0},
    latenciasMs:Array(200).fill(400),resumenLatencia:{p95:400,p99:400},baseline:{cantidadPujas:10,precioActual:1000},estadoFinal:{cantidadPujas:11}};
  const pg={subasta:{cantidadPujas:11},pujas:[row]};return {m,pg};
}
const passes=(m,pg)=>analizar(m,pg).every(c=>c.cumple);
test('acepta evidencia completa de los criterios del cliente y PostgreSQL',()=>{const {m,pg}=fixture();assert(passes(m,pg));});
test('detecta perdida final aunque el contador de gaps diga cero',()=>{const {m,pg}=fixture();m.eventos.aceptadosPorSocket[199]=[];assert(!passes(m,pg));});
test('detecta 2 filas ganadoras para el mismo monto',()=>{const {m,pg}=fixture();pg.pujas.push({...pg.pujas[0],usuarioId:'u2'});assert(!passes(m,pg));});
test('no acepta menos compradores aunque no haya desconexiones',()=>{const {m,pg}=fixture();m.conexiones.minimoDuranteCarga=199;assert(!passes(m,pg));});
test('no acepta una media de 20/s si hubo una ventana sin carga',()=>{const {m,pg}=fixture();m.enviosPorSegundo.splice(0,10,...Array(10).fill(0));m.enviosPorSegundo.splice(10,10,...Array(10).fill(40));assert(!passes(m,pg));});
test('no acepta latencias vacias aunque los percentiles guardados sean cero',()=>{const {m,pg}=fixture();m.latenciasMs=[];m.resumenLatencia={p95:0,p99:0};assert(!passes(m,pg));});
test('no acepta intentos pendientes ni ejecucion abortada',()=>{const {m,pg}=fixture();m.pujas.pendientes=1;m.errorEjecucion='abortada';assert(!passes(m,pg));});
test('sin PostgreSQL no certifica ganador ni entrega completa',()=>{const {m}=fixture();assert(!passes(m,null));});
