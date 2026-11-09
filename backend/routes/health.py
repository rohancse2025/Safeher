# backend/routes/health.py – Health check and version routes
import datetime
from flask import Blueprint, jsonify
from db import get_db

health_bp = Blueprint('health', __name__)

BUILD_VERSION = "v46"
BUILD_TIMESTAMP = datetime.datetime.now().isoformat()


@health_bp.route('/api/health', methods=['GET'])
def health_check():
    """
    Health check endpoint to verify backend server and SQLite database status.
    Returns:
        JSON response with status {"ok": true, "data": ...}
    """
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT 1;')
        conn.close()

        return jsonify({
            "ok": True,
            "data": {
                "status": "healthy",
                "service": "SafeHer Backend API",
                "database": "connected",
                "version": BUILD_VERSION,
                "timestamp": BUILD_TIMESTAMP
            }
        }), 200

    except Exception as e:
        return jsonify({
            "ok": False,
            "error": "Database check failed",
            "details": str(e)
        }), 500


@health_bp.route('/api/version', methods=['GET'])
def get_version():
    """
    Quick version check to verify deployed build on cloud host.
    """
    return jsonify({
        "ok": True,
        "version": BUILD_VERSION,
        "features": [
            "1-tap whatsapp response without app",
            "1-tap email response without app",
            "automated escort & timer alerts",
            "osm photon geocoding with local bias",
            "google maps street tiles"
        ],
        "timestamp": BUILD_TIMESTAMP
    }), 200
