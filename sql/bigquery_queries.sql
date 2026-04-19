-- =============================================================================
-- Consultas BigQuery Standard SQL para el pipeline de On-Time Delivery.
-- Proyecto: mercadolibre-otd-analytics
-- Dataset: `logistics_otd`
-- Tablas: shipments, daily_kpi, site
-- =============================================================================
-- Reemplaza `<project_id>.logistics_otd` por tu proyecto/dataset.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Descomposición de tiempos por etapa (feature engineering base).
-- -----------------------------------------------------------------------------
WITH transit_times AS (
    SELECT
        shipment_id,
        origen_site_id,
        destino_site_id,
        delivery_status,
        created_date,
        fecha_promesa,
        TIMESTAMP_DIFF(fecha_salida_origen,    created_date,          HOUR) AS t_preparacion_h,
        TIMESTAMP_DIFF(fecha_llegada_linehaul, fecha_salida_origen,   HOUR) AS t_linehaul_h,
        TIMESTAMP_DIFF(fecha_entrega,          fecha_llegada_linehaul, HOUR) AS t_ultima_milla_h,
        TIMESTAMP_DIFF(fecha_entrega,          created_date,          HOUR) AS t_total_real_h,
        TIMESTAMP_DIFF(fecha_promesa,          created_date,          HOUR) AS t_promesa_h,
        TIMESTAMP_DIFF(fecha_entrega,          fecha_promesa,         HOUR) AS desviacion_h,
        DATE(created_date) AS fecha_creacion_dia
    FROM `<project_id>.logistics_otd.shipments`
    WHERE fecha_entrega IS NOT NULL
)
SELECT * FROM transit_times;


-- -----------------------------------------------------------------------------
-- 2. Distribución de status por destino.
-- -----------------------------------------------------------------------------
SELECT
    destino_site_id,
    delivery_status,
    COUNT(*) AS envios,
    ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY destino_site_id), 2) AS pct
FROM `<project_id>.logistics_otd.shipments`
GROUP BY destino_site_id, delivery_status
ORDER BY destino_site_id, delivery_status;


-- -----------------------------------------------------------------------------
-- 3. Dataset unificado: shipments + daily_kpi + catálogo de sites.
-- Clave de cruce de KPI: (destino_site_id, fecha de creación truncada a día).
-- -----------------------------------------------------------------------------
WITH transit_times AS (
    SELECT
        sh.shipment_id,
        sh.destino_site_id,
        sh.delivery_status,
        sh.created_date,
        TIMESTAMP_DIFF(sh.fecha_entrega,          sh.fecha_llegada_linehaul, HOUR) AS t_ultima_milla_h,
        TIMESTAMP_DIFF(sh.fecha_entrega,          sh.created_date,           HOUR) AS t_total_real_h,
        TIMESTAMP_DIFF(sh.fecha_promesa,          sh.created_date,           HOUR) AS t_promesa_h,
        DATE(sh.created_date) AS fecha_creacion_dia
    FROM `<project_id>.logistics_otd.shipments` sh
    WHERE sh.fecha_entrega IS NOT NULL
)
SELECT
    tt.*,
    si.site_name        AS destino_nombre,
    si.region_origen    AS destino_region,
    kpi.occ_service_center_pct,
    kpi.delivery_success_pct
FROM transit_times tt
LEFT JOIN `<project_id>.logistics_otd.site` si
       ON si.site_id = tt.destino_site_id
LEFT JOIN `<project_id>.logistics_otd.daily_kpi` kpi
       ON kpi.site_id  = tt.destino_site_id
      AND kpi.log_date = tt.fecha_creacion_dia;


-- -----------------------------------------------------------------------------
-- 4. Promesa actual vs percentil 90 real por destino.
-- Permite cuantificar el margen ajustable de la promesa.
-- -----------------------------------------------------------------------------
SELECT
    destino_site_id,
    ROUND(AVG(TIMESTAMP_DIFF(fecha_promesa, created_date, HOUR)), 1) AS promesa_actual_h,
    ROUND(APPROX_QUANTILES(TIMESTAMP_DIFF(fecha_entrega, created_date, HOUR), 100)[OFFSET(50)], 1) AS p50_real_h,
    ROUND(APPROX_QUANTILES(TIMESTAMP_DIFF(fecha_entrega, created_date, HOUR), 100)[OFFSET(90)], 1) AS p90_real_h,
    ROUND(
        AVG(TIMESTAMP_DIFF(fecha_promesa, created_date, HOUR))
        - APPROX_QUANTILES(TIMESTAMP_DIFF(fecha_entrega, created_date, HOUR), 100)[OFFSET(90)],
        1
    ) AS margen_ajustable_h
FROM `<project_id>.logistics_otd.shipments`
WHERE fecha_entrega IS NOT NULL
GROUP BY destino_site_id
ORDER BY destino_site_id;


-- -----------------------------------------------------------------------------
-- 5. Correlación entre KPIs operativos y tiempo de última milla.
-- -----------------------------------------------------------------------------
WITH dataset AS (
    SELECT
        TIMESTAMP_DIFF(sh.fecha_entrega, sh.fecha_llegada_linehaul, HOUR) AS t_ultima_milla_h,
        kpi.occ_service_center_pct,
        kpi.delivery_success_pct
    FROM `<project_id>.logistics_otd.shipments` sh
    JOIN `<project_id>.logistics_otd.daily_kpi` kpi
         ON kpi.site_id  = sh.destino_site_id
        AND kpi.log_date = DATE(sh.created_date)
)
SELECT
    ROUND(CORR(t_ultima_milla_h, occ_service_center_pct), 3) AS corr_ultima_milla_occ,
    ROUND(CORR(t_ultima_milla_h, delivery_success_pct),   3) AS corr_ultima_milla_ds
FROM dataset;


-- -----------------------------------------------------------------------------
-- 6. Tendencia semanal de status.
-- -----------------------------------------------------------------------------
SELECT
    DATE_TRUNC(DATE(created_date), WEEK(MONDAY)) AS semana,
    ROUND(100 * SUM(IF(delivery_status='Early',   1, 0)) / COUNT(*), 1) AS pct_early,
    ROUND(100 * SUM(IF(delivery_status='On-Time', 1, 0)) / COUNT(*), 1) AS pct_ontime,
    ROUND(100 * SUM(IF(delivery_status='Delayed', 1, 0)) / COUNT(*), 1) AS pct_delayed,
    COUNT(*) AS envios
FROM `<project_id>.logistics_otd.shipments`
GROUP BY semana
ORDER BY semana;


-- -----------------------------------------------------------------------------
-- 7. Feature table para XGBoost.
-- Produce el dataset exacto que consume el pipeline de Python.
-- -----------------------------------------------------------------------------
SELECT
    sh.shipment_id,
    sh.destino_site_id,
    si.region_origen AS destino_region,
    EXTRACT(DAYOFWEEK FROM sh.created_date) AS create_day_of_week,
    EXTRACT(HOUR      FROM sh.created_date) AS create_hour,
    kpi.occ_service_center_pct,
    kpi.delivery_success_pct,
    TIMESTAMP_DIFF(sh.fecha_entrega, sh.created_date, HOUR) AS t_total_real_h
FROM `<project_id>.logistics_otd.shipments` sh
LEFT JOIN `<project_id>.logistics_otd.site` si
       ON si.site_id = sh.destino_site_id
LEFT JOIN `<project_id>.logistics_otd.daily_kpi` kpi
       ON kpi.site_id  = sh.destino_site_id
      AND kpi.log_date = DATE(sh.created_date)
WHERE sh.fecha_entrega IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 8. Fechas dobles (02/02 y 03/03) vs resto del trimestre.
-- -----------------------------------------------------------------------------
WITH etiquetado AS (
    SELECT
        shipment_id,
        destino_site_id,
        delivery_status,
        TIMESTAMP_DIFF(fecha_salida_origen,    created_date,          HOUR) AS t_preparacion_h,
        TIMESTAMP_DIFF(fecha_llegada_linehaul, fecha_salida_origen,   HOUR) AS t_linehaul_h,
        TIMESTAMP_DIFF(fecha_entrega,          fecha_llegada_linehaul, HOUR) AS t_ultima_milla_h,
        TIMESTAMP_DIFF(fecha_entrega,          created_date,          HOUR) AS t_total_real_h,
        IF(DATE(created_date) IN (DATE '2026-02-02', DATE '2026-03-03'),
           'Fechas dobles', 'Resto Q1') AS grupo
    FROM `<project_id>.logistics_otd.shipments`
    WHERE fecha_entrega IS NOT NULL
)
SELECT
    grupo,
    COUNT(*) AS envios,
    ROUND(AVG(t_preparacion_h),  2) AS avg_prep_h,
    ROUND(AVG(t_linehaul_h),     2) AS avg_linehaul_h,
    ROUND(AVG(t_ultima_milla_h), 2) AS avg_ultima_milla_h,
    ROUND(AVG(t_total_real_h),   2) AS avg_total_real_h,
    ROUND(100 * SUM(IF(delivery_status='Early',   1, 0)) / COUNT(*), 1) AS pct_early,
    ROUND(100 * SUM(IF(delivery_status='On-Time', 1, 0)) / COUNT(*), 1) AS pct_ontime,
    ROUND(100 * SUM(IF(delivery_status='Delayed', 1, 0)) / COUNT(*), 1) AS pct_delayed
FROM etiquetado
GROUP BY grupo
ORDER BY grupo;


-- -----------------------------------------------------------------------------
-- 9. Detalle de fechas dobles por destino.
-- -----------------------------------------------------------------------------
SELECT
    DATE(created_date) AS fecha_creacion,
    destino_site_id,
    COUNT(*) AS envios,
    ROUND(AVG(TIMESTAMP_DIFF(fecha_entrega, fecha_llegada_linehaul, HOUR)), 1) AS avg_ultima_milla_h,
    ROUND(100 * SUM(IF(delivery_status='Early',   1, 0)) / COUNT(*), 1) AS pct_early,
    ROUND(100 * SUM(IF(delivery_status='Delayed', 1, 0)) / COUNT(*), 1) AS pct_delayed
FROM `<project_id>.logistics_otd.shipments`
WHERE DATE(created_date) IN (DATE '2026-02-02', DATE '2026-03-03')
GROUP BY fecha_creacion, destino_site_id
ORDER BY fecha_creacion, destino_site_id;


-- -----------------------------------------------------------------------------
-- 10. KPIs operativos de los SC en fechas dobles.
-- -----------------------------------------------------------------------------
SELECT
    log_date,
    site_id,
    occ_service_center_pct,
    delivery_success_pct
FROM `<project_id>.logistics_otd.daily_kpi`
WHERE log_date IN (DATE '2026-02-02', DATE '2026-03-03')
ORDER BY log_date, site_id;
