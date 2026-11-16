"""Consulta QA de solo lectura; credenciales por entorno, nunca en la salida."""
import os, sys, json, ssl, uuid
if os.environ.get('REN_PY_DEPS'):
    sys.path.insert(0, os.environ['REN_PY_DEPS'])
import pg8000.native

def snapshot():
    host = os.environ['PGHOST']
    if host != 'cafeorbe-pg.postgres.database.azure.com' or os.environ['PGDATABASE'] != 'auction_db':
        raise ValueError('Destino PostgreSQL distinto de QA esperado')
    conn = pg8000.native.Connection(os.environ['PGUSER'], password=os.environ['PGPASSWORD'],
        host=host, database='auction_db', port=5432, ssl_context=ssl.create_default_context(), timeout=20)
    try:
        conn.run('BEGIN READ ONLY')
        observed, connections = conn.run("SELECT clock_timestamp(), count(*) FROM pg_stat_activity WHERE backend_type='client backend'")[0]
        if '--count-only' in sys.argv:
            conn.run('COMMIT')
            return {'observadoEn':str(observed), 'conexionesCliente':connections}
        state = conn.run('SELECT estado, precio_actual, cantidad_pujas, hora_fin FROM subasta WHERE id=:id', id=uuid.UUID('79ff79c1-195f-4864-8f32-165e701ba84c'))[0]
        rows = conn.run('SELECT id, monto, usuario_id, creada_en FROM puja WHERE subasta_id=:id ORDER BY monto, id', id=uuid.UUID('79ff79c1-195f-4864-8f32-165e701ba84c'))
        conn.run('COMMIT')
        return {'observadoEn':str(observed), 'conexionesCliente':connections,
            'notaConexiones':'Incluye la conexion de este observador; cuenta sesiones activas e inactivas de todas las bases.',
            'subasta':dict(zip(['estado','precioActual','cantidadPujas','horaFin'],state)),
            'pujas':[dict(zip(['id','monto','usuarioId','creadaEn'],r)) for r in rows]}
    finally:
        conn.close()

if __name__ == '__main__':
    try:
        result = snapshot()
        print(json.dumps(result, default=str))
    except Exception as exc:
        # No imprimir mensaje de conexion: algunos drivers incluyen detalles de autenticacion.
        print(json.dumps({'error':type(exc).__name__, 'operacion':'snapshot PostgreSQL QA'}))
        sys.exit(1)
