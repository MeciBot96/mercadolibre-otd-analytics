# Arquitectura del Sistema

## Visión general

```
┌────────────────┐    ┌───────────────┐    ┌─────────────────────┐
│  E-commerce    │───▶│  n8n Workflow │───▶│  XGBoost FastAPI    │
│  (checkout)    │    │  Orchestrator │    │  Microservice       │
└────────────────┘    └───────┬───────┘    └──────────┬──────────┘
                              │                       │
                              ▼                       │
                      ┌───────────────┐               │
                      │   BigQuery    │◀──────────────┘
                      │  logistics_otd│
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │   Airflow     │  (reentrenamiento mensual)
                      │   Scheduler   │
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │   Slack       │  (alertas agénticas)
                      │   Control     │
                      │   Tower       │
                      └───────────────┘
```

## Componentes

### BigQuery — `logistics_otd`

Dataset particionado por fecha con 4 tablas:

| Tabla | Partición | Cluster | Propósito |
|---|---|---|---|
| `shipments` | `DATE(created_date)` | `destino_site_id, delivery_status` | Transaccional |
| `daily_kpi` | `log_date` | `site_id` | KPIs operativos diarios |
| `site` | — | — | Catálogo maestro |
| `predictions_log` | `DATE(timestamp)` | `destino_site_id` | Log del modelo (para reentrenamiento) |

### Pipeline de entrenamiento

`src/pipeline.py` se ejecuta mensualmente vía Airflow:

1. Lee de BigQuery vía `google-cloud-bigquery`.
2. Aplica feature engineering (6 variables del Excel original).
3. Entrena XGBoost con split temporal.
4. Serializa modelo a `models/xgb_otd.pkl`.
5. Publica métricas a MLflow.
6. Despliega nueva versión del microservicio (rolling update).

### Microservicio

FastAPI stateless que carga el modelo al arranque:

- `GET /health` — health check
- `POST /predict` — recibe vector de 6 features, devuelve `t_predicho_h`, `promesa_sugerida_h`, `buffer_aplicado_h`

### Workflow n8n

Ciclo de respuesta autonómica: recibe checkout → consulta KPI → arma features → llama XGBoost → evalúa saturación → alerta si es necesario → responde al frontend → loggea predicción.

## Flujo de datos

```
Checkout event
    │
    ▼ (webhook HTTP)
n8n recibe payload: { destino_site_id, created_date, ... }
    │
    ▼ (BigQuery query)
Trae último KPI: { occ_pct, delivery_success_pct }
    │
    ▼ (transform)
Vector features: [dest, region, dow, hour, occ, ds]
    │
    ▼ (HTTP POST)
XGBoost microservice → t_predicho
    │
    ├──── if OCC < 80 ────▶ Slack alert
    │
    ▼
Compose: promesa_sugerida = t_predicho + 2σ
    │
    ▼
Append to BigQuery predictions_log
    │
    ▼
Respond to checkout con promesa calibrada
```

## Aprendizaje continuo

La tabla `predictions_log` acumula el histórico de:
- Features de entrada
- Predicción cruda del modelo
- Promesa final expuesta al cliente
- Timestamp

Al final de cada semana, un job de BigQuery cruza `predictions_log` con `shipments` por `shipment_id` y calcula el error real. Los datos enriquecidos alimentan el reentrenamiento mensual.

## Seguridad

- Credenciales de BigQuery y Slack vía n8n Credential Store.
- Microservicio expuesto solo dentro del VPC corporativo.
- IAM: service account con permisos mínimos (`bigquery.dataViewer` para shipments/kpi, `bigquery.dataEditor` para predictions_log).

## Monitoreo

- **Grafana**: latencia de predicción, throughput, error rate del microservicio.
- **MLflow**: tracking de métricas por versión del modelo.
- **BigQuery**: diferencia semanal entre `promesa_sugerida_h` y tiempo real.
