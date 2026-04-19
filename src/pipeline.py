"""
Pipeline de predicción de tiempos de tránsito logístico.
FC origen: MXCD10 (Cuautitlán Izcalli) → SCs: SMT01, SME03, SMX11.
Modelo: XGBoost Regressor sobre variables del archivo DataBase.xlsx.
"""

import json
from pathlib import Path
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

# Rutas
BASE_DIR = Path(__file__).resolve().parent.parent
INPUT_FILE = BASE_DIR / 'data' / 'DataBase.xlsx'
OUTPUT_JSON = BASE_DIR / 'dashboard' / 'data' / 'dashboard_data.json'
OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)


def cargar_datos(path):
    """Lee las 3 hojas del Excel y parsea timestamps."""
    shipments = pd.read_excel(path, sheet_name='shipments')
    daily_kpi = pd.read_excel(path, sheet_name='daily kpi')
    sites     = pd.read_excel(path, sheet_name='site')
    daily_kpi['log_date'] = pd.to_datetime(daily_kpi['log_date']).dt.normalize()
    return shipments, daily_kpi, sites


def descomponer_tiempos(shipments):
    """Calcula las 3 fases del ciclo logístico en horas."""
    s = shipments.copy()
    s['t_preparacion_h']  = (s['fecha_salida_origen']    - s['created_date']          ).dt.total_seconds() / 3600
    s['t_linehaul_h']     = (s['fecha_llegada_linehaul'] - s['fecha_salida_origen']   ).dt.total_seconds() / 3600
    s['t_ultima_milla_h'] = (s['fecha_entrega']          - s['fecha_llegada_linehaul']).dt.total_seconds() / 3600
    s['t_total_real_h']   = (s['fecha_entrega']          - s['created_date']          ).dt.total_seconds() / 3600
    s['t_promesa_h']      = (s['fecha_promesa']          - s['created_date']          ).dt.total_seconds() / 3600
    s['desviacion_h']     = s['t_total_real_h'] - s['t_promesa_h']
    return s


def construir_dataset(shipments_t, daily_kpi, sites):
    """JOIN de shipments con KPIs diarios del SC destino y catálogo de sites."""
    s = shipments_t.copy()
    s['fecha_creacion_dia'] = s['created_date'].dt.normalize()
    df = s.merge(
        daily_kpi,
        left_on=['fecha_creacion_dia', 'destino_site_id'],
        right_on=['log_date', 'site_id'],
        how='left'
    )
    df = df.merge(
        sites.rename(columns={
            'site_id': 'destino_site_id',
            'site_name': 'destino_nombre',
            'region_origen': 'destino_region'
        })[['destino_site_id', 'destino_nombre', 'destino_region']],
        on='destino_site_id',
        how='left'
    )
    # Imputar KPIs faltantes con mediana por SC
    for col in ['occ_service_center_pct', 'delivery_success_pct']:
        df[col] = df.groupby('destino_site_id')[col].transform(lambda x: x.fillna(x.median()))
    return df


def entrenar_modelo(df):
    """Entrena XGBoost Regressor para predecir tiempo total real."""
    ml = df.copy()
    ml['create_day_of_week'] = ml['created_date'].dt.dayofweek
    ml['create_hour']        = ml['created_date'].dt.hour

    # Features exclusivamente derivadas del Excel original
    features = [
        'destino_site_id', 'destino_region',
        'create_day_of_week', 'create_hour',
        'occ_service_center_pct', 'delivery_success_pct'
    ]
    X = ml[features].copy()
    y = ml['t_total_real_h']

    X['destino_site_id'] = LabelEncoder().fit_transform(X['destino_site_id'])
    X['destino_region']  = LabelEncoder().fit_transform(X['destino_region'])

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = xgb.XGBRegressor(
        n_estimators=300,
        learning_rate=0.05,
        max_depth=5,
        subsample=0.8,
        colsample_bytree=0.8,
        objective='reg:squarederror',
        random_state=42
    )
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    metrics = {
        'mae':  float(mean_absolute_error(y_test, y_pred)),
        'rmse': float(np.sqrt(mean_squared_error(y_test, y_pred))),
        'r2':   float(r2_score(y_test, y_pred))
    }

    fi = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)

    # Colchón asimétrico: promesa sugerida = predicho + 2 desviaciones estándar del residual
    residuales = y_test.values - y_pred
    sigma = float(np.std(residuales))
    metrics['sigma_residual'] = sigma
    metrics['buffer_2sigma'] = 2 * sigma

    return model, metrics, fi


def analizar_fechas_dobles(df):
    """Compara comportamiento en 02/02 y 03/03 vs resto del trimestre."""
    fechas = [pd.Timestamp('2026-02-02'), pd.Timestamp('2026-03-03')]
    df['fecha_creacion_dia'] = df['created_date'].dt.normalize()
    dobles = df[df['fecha_creacion_dia'].isin(fechas)]
    resto  = df[~df['fecha_creacion_dia'].isin(fechas)]

    def pct_status(sub, status):
        return round((sub['delivery_status'] == status).mean() * 100, 1)

    return {
        'envios_22': int((df['fecha_creacion_dia'] == fechas[0]).sum()),
        'envios_33': int((df['fecha_creacion_dia'] == fechas[1]).sum()),
        'total_dobles': int(len(dobles)),
        'dist_dobles': {s.lower().replace('-', ''): pct_status(dobles, s) for s in ['Early', 'On-Time', 'Delayed']},
        'dist_resto':  {s.lower().replace('-', ''): pct_status(resto,  s) for s in ['Early', 'On-Time', 'Delayed']},
        'tiempos': {
            etapa: {
                'dobles': round(dobles[col].mean(), 1),
                'resto':  round(resto[col].mean(), 1)
            }
            for etapa, col in [
                ('preparacion', 't_preparacion_h'),
                ('linehaul',    't_linehaul_h'),
                ('ultima_milla','t_ultima_milla_h'),
                ('total',       't_total_real_h')
            ]
        },
        'detalle_por_destino': [
            {
                'fecha': str(fecha.date()),
                'sc': row['destino_nombre'].iloc[0],
                'envios': int(len(row)),
                't_ultima_milla_h': round(row['t_ultima_milla_h'].mean(), 1),
                'pct_early':   pct_status(row, 'Early'),
                'pct_delayed': pct_status(row, 'Delayed'),
            }
            for (fecha, _), row in dobles.groupby(['fecha_creacion_dia', 'destino_site_id'])
        ]
    }


def armar_payload(df, metrics, fi, dobles):
    """Construye el JSON para el dashboard."""
    # Scatter promesa vs real (muestreo para performance)
    scatter = df[['t_promesa_h', 't_total_real_h', 'delivery_status', 'destino_site_id']].sample(
        min(800, len(df)), random_state=42
    ).round(1).to_dict(orient='records')

    # Boxplot por etapa y destino (P25, P50, P75, P5, P95)
    boxplots = []
    for dest in df['destino_site_id'].unique():
        sub = df[df['destino_site_id'] == dest]
        for etapa, col in [('Preparación', 't_preparacion_h'),
                            ('Linehaul', 't_linehaul_h'),
                            ('Última milla', 't_ultima_milla_h')]:
            vals = sub[col].dropna()
            boxplots.append({
                'destino': sub['destino_nombre'].iloc[0],
                'etapa': etapa,
                'min': round(float(vals.quantile(0.05)), 1),
                'q1':  round(float(vals.quantile(0.25)), 1),
                'median': round(float(vals.quantile(0.50)), 1),
                'q3':  round(float(vals.quantile(0.75)), 1),
                'max': round(float(vals.quantile(0.95)), 1)
            })

    # Heatmap OCC por SC y día
    df['fecha_dia'] = df['created_date'].dt.date.astype(str)
    heatmap = (df.groupby(['fecha_dia', 'destino_site_id'])
                 .agg(occ=('occ_service_center_pct', 'mean'),
                      ds=('delivery_success_pct', 'mean'),
                      envios=('shipment_id', 'count'))
                 .reset_index()
                 .round(2)
                 .to_dict(orient='records'))

    # Por destino
    por_destino = []
    for dest_id in df['destino_site_id'].unique():
        sub = df[df['destino_site_id'] == dest_id]
        por_destino.append({
            'site_id': dest_id,
            'nombre': sub['destino_nombre'].iloc[0],
            'region': sub['destino_region'].iloc[0],
            'envios': int(len(sub)),
            't_preparacion': round(sub['t_preparacion_h'].mean(), 1),
            't_linehaul':    round(sub['t_linehaul_h'].mean(), 1),
            't_ultima_milla':round(sub['t_ultima_milla_h'].mean(), 1),
            't_total_real':  round(sub['t_total_real_h'].mean(), 1),
            't_promesa':     round(sub['t_promesa_h'].mean(), 1),
            'p90_real':      round(sub['t_total_real_h'].quantile(0.90), 1),
            'pct_early':     round((sub['delivery_status'] == 'Early').mean() * 100, 1),
            'pct_ontime':    round((sub['delivery_status'] == 'On-Time').mean() * 100, 1),
            'pct_delayed':   round((sub['delivery_status'] == 'Delayed').mean() * 100, 1),
        })

    # Tendencia semanal
    df['semana'] = df['created_date'].dt.to_period('W').dt.start_time.dt.strftime('%b %d')
    tendencia = []
    for sem, grp in df.groupby('semana', sort=False):
        tendencia.append({
            'semana': sem,
            'Early':   round((grp['delivery_status'] == 'Early').mean() * 100, 1),
            'OnTime':  round((grp['delivery_status'] == 'On-Time').mean() * 100, 1),
            'Delayed': round((grp['delivery_status'] == 'Delayed').mean() * 100, 1)
        })

    kpis = {
        'total_envios': int(len(df)),
        'pct_early':   round((df['delivery_status'] == 'Early').mean() * 100, 1),
        'pct_ontime':  round((df['delivery_status'] == 'On-Time').mean() * 100, 1),
        'pct_delayed': round((df['delivery_status'] == 'Delayed').mean() * 100, 1),
        'adelanto_medio_h': round(
            (df[df['delivery_status'] == 'Early']['t_promesa_h'] -
             df[df['delivery_status'] == 'Early']['t_total_real_h']).mean(), 1
        ),
        'mae': round(metrics['mae'], 2),
        'rmse': round(metrics['rmse'], 2),
        'r2': round(metrics['r2'], 3),
        'buffer_2sigma': round(metrics['buffer_2sigma'], 1)
    }

    return {
        'kpis': kpis,
        'por_destino': por_destino,
        'tendencia': tendencia,
        'feature_importance': fi.round(3).to_dict(orient='records'),
        'scatter': scatter,
        'boxplots': boxplots,
        'heatmap': heatmap,
        'fechas_dobles': dobles
    }


def main():
    print("→ Cargando datos")
    shipments, daily_kpi, sites = cargar_datos(INPUT_FILE)

    print("→ Descomponiendo tiempos por etapa")
    shipments_t = descomponer_tiempos(shipments)

    print("→ Construyendo dataset unificado")
    df = construir_dataset(shipments_t, daily_kpi, sites)

    print("→ Entrenando XGBoost")
    model, metrics, fi = entrenar_modelo(df)
    print(f"   MAE:   {metrics['mae']:.2f} h")
    print(f"   RMSE:  {metrics['rmse']:.2f} h")
    print(f"   R²:    {metrics['r2']:.3f}")
    print(f"   Buffer 2σ: {metrics['buffer_2sigma']:.1f} h")

    print("→ Analizando fechas dobles (2/2 y 3/3)")
    dobles = analizar_fechas_dobles(df)

    print("→ Exportando payload del dashboard")
    payload = armar_payload(df, metrics, fi, dobles)
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=str)
    print(f"✓ {OUTPUT_JSON}")


if __name__ == '__main__':
    main()
