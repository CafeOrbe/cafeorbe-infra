import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutosDeLaVentana, evaluarCpuReplica } from './analizar-cpu.mjs';

const INICIO = Date.parse('2026-11-16T13:28:02Z');
const FIN = Date.parse('2026-11-16T13:38:02Z');
const VCPU = 0.25;
const nano = (porcentaje) => (porcentaje / 100) * VCPU * 1e9;
const punto = (hhmm, porcentaje) => ({ timeStamp: `2026-11-16T${hhmm}:00Z`, maximum: nano(porcentaje) });
const minutosCompletos = (porcentaje) => Array.from({ length: 11 }, (_, i) => punto(`13:${String(28 + i).padStart(2, '0')}`, porcentaje));

test('la ventana 13:28:02-13:38:02 incluye 11 minutos, también el último parcial', () => {
  const minutos = minutosDeLaVentana(INICIO, FIN).map((m) => new Date(m * 60000).toISOString().slice(11, 16));
  assert.deepEqual(minutos, ['13:28', '13:29', '13:30', '13:31', '13:32', '13:33', '13:34', '13:35', '13:36', '13:37', '13:38']);
});

test('una ventana que termina justo en el minuto no agrega el minuto siguiente', () => {
  const minutos = minutosDeLaVentana(Date.parse('2026-11-16T13:28:00Z'), Date.parse('2026-11-16T13:38:00Z'));
  assert.equal(minutos.length, 10);
});

test('aprueba con todos los minutos bajo 80 %', () => {
  const r = evaluarCpuReplica(minutosCompletos(60), INICIO, FIN, VCPU);
  assert.equal(r.cumple, true);
  assert.equal(r.minutosEsperados, 11);
});

test('REGRESION: un pico en el último minuto parcial ya no da falso aprobado', () => {
  const puntos = minutosCompletos(60);
  puntos[10] = punto('13:38', 95);
  const r = evaluarCpuReplica(puntos, INICIO, FIN, VCPU);
  assert.equal(r.cumple, false);
  assert.ok(r.maximoPorcentaje > 90);
});

test('REGRESION: si falta el último minuto no hay dictamen (antes aprobaba con 10)', () => {
  const r = evaluarCpuReplica(minutosCompletos(60).slice(0, 10), INICIO, FIN, VCPU);
  assert.equal(r.cumple, null);
  assert.deepEqual(r.minutosFaltantes, ['2026-11-16T13:38:00.000Z']);
});

test('un pico en el minuto anterior a la ventana no cuenta', () => {
  const r = evaluarCpuReplica([punto('13:27', 99), ...minutosCompletos(60)], INICIO, FIN, VCPU);
  assert.equal(r.cumple, true);
});

test('sin series (timeseries vacío) no se interpreta como CPU cero', () => {
  assert.equal(evaluarCpuReplica([], INICIO, FIN, VCPU).cumple, null);
});

test('sin vCPU conocida no hay dictamen', () => {
  assert.equal(evaluarCpuReplica(minutosCompletos(60), INICIO, FIN, NaN).cumple, null);
});
