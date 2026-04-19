-- =============================================================================
-- DDL para crear el dataset y las tablas base en BigQuery.
-- Ejecutar una vez antes de correr las consultas de bigquery_queries.sql
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS `<project_id>.logistics_otd`
OPTIONS (
    location = 'us-central1',
    description = 'On-Time Delivery Analytics - MercadoLibre MX'
);


CREATE TABLE IF NOT EXISTS `<project_id>.logistics_otd.shipments` (
    shipment_id            STRING    NOT NULL,
    origen_site_id         STRING    NOT NULL,
    destino_site_id        STRING    NOT NULL,
    created_date           TIMESTAMP NOT NULL,
    fecha_promesa          TIMESTAMP,
    fecha_salida_origen    TIMESTAMP,
    fecha_llegada_linehaul TIMESTAMP,
    fecha_entrega          TIMESTAMP,
    delivery_status        STRING
)
PARTITION BY DATE(created_date)
CLUSTER BY destino_site_id, delivery_status
OPTIONS (description = 'Historial transaccional de envíos');


CREATE TABLE IF NOT EXISTS `<project_id>.logistics_otd.daily_kpi` (
    log_date               DATE    NOT NULL,
    site_id                STRING  NOT NULL,
    occ_service_center_pct FLOAT64,
    delivery_success_pct   FLOAT64
)
PARTITION BY log_date
CLUSTER BY site_id
OPTIONS (description = 'KPIs diarios de eficiencia por Service Center');


CREATE TABLE IF NOT EXISTS `<project_id>.logistics_otd.site` (
    site_id       STRING NOT NULL,
    site_name     STRING,
    site_type     STRING,
    region_origen STRING
)
OPTIONS (description = 'Catálogo maestro de instalaciones (FC y SCs)');


-- Cargar datos desde GCS (ejemplo):
-- LOAD DATA OVERWRITE `<project_id>.logistics_otd.shipments`
-- FROM FILES (format = 'PARQUET', uris = ['gs://<bucket>/shipments/*.parquet']);
