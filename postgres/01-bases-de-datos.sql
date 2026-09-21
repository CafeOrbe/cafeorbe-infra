-- Una base de datos y un usuario por servicio: ningún servicio puede leer la base de otro.
-- Solo se ejecuta la primera vez que se crea el volumen de Postgres.

CREATE ROLE identity  LOGIN PASSWORD 'identity';
CREATE ROLE auction   LOGIN PASSWORD 'auction';
CREATE ROLE wallet    LOGIN PASSWORD 'wallet';
CREATE ROLE streaming LOGIN PASSWORD 'streaming';

CREATE DATABASE identity_db  OWNER identity;
CREATE DATABASE auction_db   OWNER auction;
CREATE DATABASE wallet_db    OWNER wallet;
CREATE DATABASE streaming_db OWNER streaming;

REVOKE CONNECT ON DATABASE identity_db  FROM PUBLIC;
REVOKE CONNECT ON DATABASE auction_db   FROM PUBLIC;
REVOKE CONNECT ON DATABASE wallet_db    FROM PUBLIC;
REVOKE CONNECT ON DATABASE streaming_db FROM PUBLIC;
