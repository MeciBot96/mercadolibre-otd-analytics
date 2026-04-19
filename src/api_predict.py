"""
Microservicio de inferencia para predicción de tiempo de entrega.
Consumido por el workflow de n8n via HTTP POST.
"""

from pathlib import Path
import joblib
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel

MODEL_PATH = Path(__file__).resolve().parent.parent / 'models' / 'xgb_otd.pkl'

app = FastAPI(title='OTD Predictor', version='1.0.0')


class PredictRequest(BaseModel):
    destino_site_id: int        # encoded
    destino_region: int         # encoded
    create_day_of_week: int     # 0-6
    create_hour: int            # 0-23
    occ_service_center_pct: float
    delivery_success_pct: float


class PredictResponse(BaseModel):
    t_predicho_h: float
    promesa_sugerida_h: float   # predicho + 2σ
    buffer_aplicado_h: float
    confianza: float            # 0.95


BUFFER_2SIGMA = 40.3  # calibrado del pipeline de entrenamiento
model = joblib.load(MODEL_PATH) if MODEL_PATH.exists() else None


@app.get('/health')
def health():
    return {'status': 'ok', 'model_loaded': model is not None}


@app.post('/predict', response_model=PredictResponse)
def predict(req: PredictRequest):
    X = np.array([[
        req.destino_site_id, req.destino_region,
        req.create_day_of_week, req.create_hour,
        req.occ_service_center_pct, req.delivery_success_pct
    ]])
    t_predicho = float(model.predict(X)[0])
    return PredictResponse(
        t_predicho_h=round(t_predicho, 2),
        promesa_sugerida_h=round(t_predicho + BUFFER_2SIGMA, 2),
        buffer_aplicado_h=BUFFER_2SIGMA,
        confianza=0.95
    )
