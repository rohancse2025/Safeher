# backend/routes/health.py – Health check route
from flask import Blueprint, jsonify
from db import get_db

health_bp = Blueprint('health', __name__)


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
                "database": "connected"
            }
        }), 200

    except Exception as e:
        return jsonify({
            "ok": False,
            "error": f"Database check failed: {str(e)}"
        }), 500
