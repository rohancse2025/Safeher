# backend/app.py – SafeHer Flask backend entry point
import os
import re
from flask import Flask, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

from db import init_db
from routes.health import health_bp
from routes.auth import auth_bp
from routes.pin import pin_bp
from routes.contacts import contacts_bp
from routes.alerts import alerts_bp
from routes.volunteers import volunteers_bp
from routes.timers import timers_bp, start_timer_monitor

# 1. Load configuration from .env
load_dotenv()

SECRET_KEY = os.getenv('SECRET_KEY', 'default-safeher-secret-key')
PORT = int(os.getenv('PORT', 5000))
DEBUG = os.getenv('DEBUG', 'True').lower() in ('true', '1', 'yes')

# Parse allowed CORS origins from .env
allowed_env = os.getenv('ALLOWED_ORIGINS', 'http://localhost:3000,http://localhost:5000,http://localhost:8000,http://127.0.0.1:5500')
frontend_url = os.getenv('FRONTEND_URL', '')

origins_list = [origin.strip() for origin in allowed_env.split(',') if origin.strip()]
if frontend_url and frontend_url not in origins_list:
    origins_list.append(frontend_url)

# Also support regex patterns for any local dev port
cors_origins = [
    re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
] + origins_list


def create_app():
    """Application factory for SafeHer Flask backend."""
    app = Flask(__name__)
    app.config['SECRET_KEY'] = SECRET_KEY

    # 2. Configure CORS
    CORS(app, origins=cors_origins, supports_credentials=True)

    # 3. Automatically initialize SQLite tables on startup
    with app.app_context():
        init_db()

    # 4. Register route blueprints
    app.register_blueprint(health_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(pin_bp)
    app.register_blueprint(contacts_bp)
    app.register_blueprint(alerts_bp)
    app.register_blueprint(volunteers_bp)
    app.register_blueprint(timers_bp)

    # 5. Start background thread checking for expired running timers
    start_timer_monitor()

    # 5. Global error handlers (consistent JSON format: {"ok": false, "error": "..."})
    @app.errorhandler(404)
    def handle_not_found(e):
        return jsonify({"ok": False, "error": "Resource not found"}), 404

    @app.errorhandler(405)
    def handle_method_not_allowed(e):
        return jsonify({"ok": False, "error": "Method not allowed"}), 405

    @app.errorhandler(500)
    def handle_server_error(e):
        return jsonify({"ok": False, "error": "Internal server error"}), 500

    return app


app = create_app()

if __name__ == '__main__':
    print(f"Starting SafeHer API on port {PORT} (debug={DEBUG})...")
    app.run(host='0.0.0.0', port=PORT, debug=DEBUG)
