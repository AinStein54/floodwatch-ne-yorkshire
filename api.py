"""
Flood Risk Prediction API
Flask backend — serves the web app and exposes /predict endpoint.

Run locally:   python api.py
Deploy:        gunicorn api:app  (Render / Heroku)
"""

import os
import json
import traceback

import joblib
import numpy as np
import pandas as pd
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

# ── App setup ─────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="/static")
CORS(app)                       # allow cross-origin requests during development

# ── Load model artefacts ──────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def _load(filename):
    path = os.path.join(BASE_DIR, filename)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"'{filename}' not found. Run Step 15 in the notebook first."
        )
    return path

try:
    MODEL         = joblib.load(_load("flood_model.pkl"))
    FEATURE_ORDER = json.load(open(_load("feature_order.json")))
    RISK_MAPPING  = json.load(open(_load("risk_mapping.json")))
    METADATA      = json.load(open(_load("model_metadata.json")))
    TOWNS         = METADATA.get("towns", [])
    SUITABILITY   = METADATA.get("suitability_types", [])
    print(f"✅ Model loaded  ({METADATA.get('model_name')})  "
          f"F1={METADATA.get('test_f1_weighted')}  "
          f"Features={len(FEATURE_ORDER)}")
except FileNotFoundError as e:
    print(f"⚠️  {e}")
    MODEL = None


# ── Helper ────────────────────────────────────────────────────────────────────
def build_feature_row(day: dict) -> pd.DataFrame:
    """
    Turn a single day's weather + context dict into a 1-row DataFrame
    with exactly the columns the model expects, in the right order.
    """
    row = {col: 0.0 for col in FEATURE_ORDER}

    # Numeric weather + geography features
    numeric_fields = [
        "latitude", "longitude",
        "temp_mean", "temp_max", "temp_min",
        "precipitation_sum", "rain_sum", "snowfall_sum",
        "wind_speed_max", "wind_gusts_max",
        "humidity_mean", "soil_moisture_mean",
    ]
    for field in numeric_fields:
        if field in row and day.get(field) is not None:
            try:
                row[field] = float(day[field])
            except (TypeError, ValueError):
                pass

    # One-hot: town
    town_key = f"town_{day.get('town', '')}"
    if town_key in row:
        row[town_key] = 1.0

    # One-hot: suitability
    suit_key = f"suitability_{day.get('suitability', '')}"
    if suit_key in row:
        row[suit_key] = 1.0

    return pd.DataFrame([row])[FEATURE_ORDER]


# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    """Serve the main web app."""
    return send_from_directory("static", "index.html")


@app.route("/api/health")
def health():
    """Liveness check — useful for Render's health-check URL."""
    return jsonify({
        "status": "ok",
        "model_loaded": MODEL is not None,
        "model_name":  METADATA.get("model_name") if MODEL else None,
    })


@app.route("/api/options")
def options():
    """
    Return the towns and suitability types the model was trained on.
    The frontend uses this to build its dropdowns dynamically.
    """
    return jsonify({
        "towns":            TOWNS,
        "suitability_types": SUITABILITY,
        "model_name":       METADATA.get("model_name", "Unknown"),
        "test_f1":          METADATA.get("test_f1_weighted"),
        "training_region":  METADATA.get("training_region", "North East & Yorkshire, UK"),
    })


@app.route("/predict", methods=["POST"])
def predict():
    """
    Predict flood risk for 1–7 days.

    Expected JSON body:
    {
      "days": [
        {
          "date":             "2025-04-15",
          "latitude":         53.80,
          "longitude":        -1.55,
          "town":             "Leeds",
          "suitability":      "County to District",
          "temp_mean":        10.5,
          "temp_max":         14.2,
          "temp_min":         6.8,
          "precipitation_sum": 3.2,
          "rain_sum":          3.2,
          "snowfall_sum":      0.0,
          "wind_speed_max":   22.0,
          "wind_gusts_max":   38.5,
          "humidity_mean":    78.0,
          "soil_moisture_mean": 0.34
        },
        ...
      ]
    }
    """
    if MODEL is None:
        return jsonify({
            "status":  "error",
            "message": "Model not loaded. Run Step 15 in the notebook first."
        }), 503

    try:
        payload = request.get_json(force=True)
        days    = payload.get("days", [])

        if not days:
            return jsonify({"status": "error", "message": "No days provided."}), 400

        results = []
        for day in days:
            X       = build_feature_row(day)
            pred    = int(MODEL.predict(X)[0])
            proba   = MODEL.predict_proba(X)[0].tolist()
            label   = RISK_MAPPING.get(str(pred), "Unknown")

            # Build labelled probability dict
            prob_dict = {
                RISK_MAPPING.get(str(i), str(i)): round(float(p), 4)
                for i, p in enumerate(proba)
            }

            results.append({
                "date":            day.get("date"),
                "predicted_class": pred,
                "predicted_label": label,
                "probabilities":   prob_dict,
                "max_prob":        round(float(max(proba)), 4),
            })

        return jsonify({"status": "ok", "predictions": results})

    except Exception:
        return jsonify({
            "status":  "error",
            "message": traceback.format_exc()
        }), 500


# ── Dev server ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
