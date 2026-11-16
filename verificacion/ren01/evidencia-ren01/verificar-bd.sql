-- Ejecutar con sesión de solo lectura contra auction_db de QA.
BEGIN READ ONLY;
SELECT clock_timestamp() AS observado_en,
       count(*) AS conexiones_cliente
FROM pg_stat_activity
WHERE backend_type = 'client backend';

SELECT id, estado, hora_fin, precio_actual, cantidad_pujas
FROM subasta WHERE id = '79ff79c1-195f-4864-8f32-165e701ba84c';

-- Baseline y cierre: guardar resultados antes y después de la carga.
SELECT count(*) AS filas, count(DISTINCT monto) AS incrementos,
       min(monto) AS monto_minimo, max(monto) AS monto_maximo
FROM puja WHERE subasta_id = '79ff79c1-195f-4864-8f32-165e701ba84c';

-- Debe estar vacío: cada monto aceptado identifica un único ganador.
SELECT monto, count(*) AS filas, count(DISTINCT usuario_id) AS ganadores
FROM puja WHERE subasta_id = '79ff79c1-195f-4864-8f32-165e701ba84c'
GROUP BY monto HAVING count(*) <> 1 OR count(DISTINCT usuario_id) <> 1;
COMMIT;
