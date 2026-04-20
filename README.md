# Mercado Libre · On-Time Delivery Analytics

Sistema de predicción dinámica de promesa de entrega para la red logística de Mercado Libre México. Combina un modelo **XGBoost** entrenado sobre el histórico transaccional con un **workflow de n8n** que orquesta predicción, alertas agénticas y aprendizaje continuo.

![Stack](https://img.shields.io/badge/python-3.10%2B-blue) ![XGBoost](https://img.shields.io/badge/XGBoost-2.0-orange) ![BigQuery](https://img.shields.io/badge/BigQuery-ready-brightgreen) ![n8n](https://img.shields.io/badge/n8n-workflow-EA4B71)

## Contexto

El Fulfillment Center **MXCD10 en Cuautitlán Izcalli** procesa envíos hacia 3 Service Centers (CDMX, Monterrey, Mérida). Durante Q1 2026, **el 81.7% de los envíos llegaron Early** (antes de la promesa), con un adelanto promedio de 2 días — señal de que el modelo estático de promesa está excesivamente conservador y está costando ventas.

Este repo implementa un sistema que predice el tiempo real y expone una promesa agresiva al cliente, manteniendo 95% de confianza en el cumplimiento.

## Estructura

```
mercadolibre-otd-analytics/
├── data/                    # Dataset fuente (DataBase.xlsx)
├── src/
│   ├── pipeline.py          # Pipeline de entrenamiento + export a JSON
│   └── api_predict.py       # Microservicio FastAPI para n8n
├── sql/
│   ├── bigquery_ddl.sql     # DDL de tablas en BigQuery
│   └── bigquery_queries.sql # 10 queries de análisis y feature engineering
├── n8n/
│   ├── workflow_otd_promise.json  # Workflow importable
│   └── README.md            # Documentación del ciclo autonómico
├── dashboard/
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js
│   └── data/dashboard_data.json
├── docs/
│   └── arquitectura.md
├── requirements.txt
└── README.md
```

## Quick start

```bash
# 1. Clonar
git clone https://github.com/<usuario>/mercadolibre-otd-analytics.git
cd mercadolibre-otd-analytics

# 2. Instalar
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3. Entrenar y generar el JSON del dashboard
python src/pipeline.py

# 4. Servir el dashboard
cd dashboard && python -m http.server 8080
# Abrir http://localhost:8080
```

## Componentes

### 1. Pipeline Python (`src/pipeline.py`)

Carga el Excel, descompone tiempos por etapa, hace JOIN con `daily_kpi` y `site`, entrena XGBoost con 6 features del dataset original y exporta `dashboard_data.json`.

```bash
python src/pipeline.py
```

### 2. SQL BigQuery (`sql/`)

- `bigquery_ddl.sql` — crea dataset `logistics_otd` con las 3 tablas particionadas por fecha.
- `bigquery_queries.sql` — 10 queries: descomposición de tiempos, unión con KPIs, percentiles por destino, correlaciones, tendencia semanal, feature table para el modelo, análisis de fechas dobles.

Reemplaza `<project_id>` por el ID real del proyecto antes de ejecutar.

### 3. Modelo XGBoost

- 6 features del Excel: `destino_site_id`, `destino_region`, `create_day_of_week`, `create_hour`, `occ_service_center_pct`, `delivery_success_pct`.
- Hiperparámetros: `n_estimators=300`, `learning_rate=0.05`, `max_depth=5`, `subsample=0.8`.
- Métricas baseline: MAE ~14 h, RMSE ~20 h.
- Buffer aplicado: 2σ del residual (~40 h) → 95% de confianza en la promesa.

### 4. Microservicio de inferencia (`src/api_predict.py`)

FastAPI con endpoint `POST /predict` que n8n invoca en cada checkout.

```bash
uvicorn src.api_predict:app --host 0.0.0.0 --port 8000
```

### 5. Workflow n8n (`n8n/workflow_otd_promise.json`)

Ciclo de respuesta autonómica en 9 nodos:

1. Webhook de checkout
2. Lee KPI reciente del SC desde BigQuery
3. Construye vector de features
4. Llama al microservicio XGBoost
5. Evalúa si OCC < 80%
6. Alerta Slack si hay saturación
7. Compone respuesta con promesa final
8. Loggea predicción en BigQuery (para reentrenamiento)
9. Responde al frontend

Ver `n8n/README.md` para detalle de configuración.

### 6. Dashboard (`dashboard/`)

Tablero interactivo con paleta de marca Mercado Libre. Carga `dashboard_data.json` vía fetch y renderiza con Chart.js:

- Matriz de dispersión diagnóstica (promesa vs real)
- Mapa topológico de fricción (OCC por SC × día)
- Boxplots segmentados por etapa
- Tendencia semanal de status
- Análisis de fechas dobles (2/2 y 3/3)
- Feature importance del modelo XGBoost

## Hallazgos principales

| Métrica | Valor |
|---|---|
| Envíos analizados | 3,203 |
| % Early | 81.7% |
| % On-Time | 10.0% |
| % Delayed | 8.2% |
| Adelanto medio | 48 h (2 días) |
| Correlación OCC ↔ última milla | −0.01 (nula) |
| MAE del modelo | ~14 h |

**Conclusión central:** el problema no es operativo; es que la promesa está mal calibrada por ruta. La solución es un sistema ML que exponga promesas agresivas manteniendo confiabilidad.

## Stack técnico

| Capa | Herramienta |
|---|---|
| Data Warehouse | BigQuery |
| ML Framework | XGBoost 2.0 |
| Feature store | BigQuery + pandas |
| Orquestación | n8n |
| Serving | FastAPI + uvicorn |
| Dashboard | HTML + Chart.js |
| Messaging | Slack |
| Scheduling | Airflow (fase 3) |

## Roadmap

- **P1** (2 sem): recalibrar promesa al P90 por destino en BigQuery
- **P2** (6-8 sem): desplegar XGBoost + n8n en producción con A/B test
- **P3** (3-6 meses): aprendizaje continuo + desvío a 3PL ante saturación

## Autor

Isaac Mecinas — Senior Data Analyst candidate · Mercado Libre México · 2026
