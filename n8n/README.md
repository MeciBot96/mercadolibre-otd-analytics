# Integración n8n: Ciclo de Respuesta Autonómica

Este workflow implementa el **ciclo de respuesta autonómica (Reinforcement Learning Operational)** descrito en la propuesta. Cada evento de checkout dispara una cadena de 8 nodos que calculan la promesa óptima, vigilan la saturación del SC destino y registran el resultado para re-entrenamiento.

## Diagrama del flujo

```
Webhook Checkout
      │
      ▼
BigQuery — Get Latest KPI        (lee OCC y Delivery Success del SC destino)
      │
      ▼
Build Feature Vector              (ensambla vector de 6 features)
      │
      ▼
Call XGBoost Microservice         (POST a /predict del servicio FastAPI)
      │
      ▼
IF OCC Below 80%
      │              │
      │ true         │ false
      ▼              ▼
Slack Alert     Compose Response
   │                 │
   └────────┬────────┘
            ▼
   Log Prediction BigQuery        (append a predictions_log)
            │
            ▼
   Respond to Checkout            (devuelve promesa al frontend)
```

## Nodos

| # | Nodo | Propósito |
|---|------|-----------|
| 1 | **Webhook Checkout** | Endpoint `POST /shipment-checkout` que recibe el evento de compra del e-commerce. |
| 2 | **BigQuery — Get Latest KPI** | Consulta el último registro de `daily_kpi` para el SC destino. |
| 3 | **Build Feature Vector** | Construye el vector de 6 features que espera el modelo, derivando `day_of_week` y `hour` de `created_date`. |
| 4 | **Call XGBoost Microservice** | Llama al endpoint `/predict` del servicio FastAPI (`src/api_predict.py`). |
| 5 | **IF OCC Below 80%** | Bifurca el flujo si el SC destino está operando por debajo del umbral operativo. |
| 6 | **Slack Alert — Control Tower** | Notifica a la mesa de control con el detalle de la anomalía. |
| 7 | **Compose Response** | Arma el JSON de respuesta con promesa final + metadata. |
| 8 | **Log Prediction BigQuery** | Persiste la predicción en `predictions_log` para el ciclo de aprendizaje continuo. |
| 9 | **Respond to Checkout** | Devuelve la promesa calibrada al frontend para que la muestre al cliente. |

## Colchón asimétrico

La propuesta técnica aplica dos desviaciones estándar del residual del modelo a la predicción cruda, garantizando ~95% de confianza en el cumplimiento:

```
promesa_sugerida_h = t_predicho_h + (2 × σ_residual)
```

El valor actual de `σ_residual` calibrado durante el entrenamiento es **~20.2 h**, por lo que el buffer efectivo es **~40.3 h**. Este valor se actualiza tras cada reentrenamiento mensual y se inyecta en el microservicio como variable de entorno.

## Aprendizaje continuo

La tabla `predictions_log` acumula cada predicción y se cruza semanalmente contra el `delivery_status` real de la tabla `shipments`. El error por bucket (destino, día, hora) alimenta el reentrenamiento mensual del modelo.

## Cómo importar

1. Abrir n8n y entrar a **Workflows → Import from File**.
2. Seleccionar `n8n/workflow_otd_promise.json`.
3. Configurar credenciales:
    - **Google BigQuery**: OAuth2 con acceso al proyecto `<project_id>`.
    - **Slack**: OAuth token con permisos `chat:write` sobre `#logistics-control-tower`.
4. Actualizar `YOUR_GCP_PROJECT` por el ID real del proyecto.
5. Activar el workflow.

## Variables de entorno requeridas

```bash
GCP_PROJECT_ID=<project_id>
OTD_PREDICTOR_URL=http://otd-predictor:8000
SLACK_ALERT_CHANNEL=#logistics-control-tower
OCC_CRITICAL_THRESHOLD=80
```
