# backend/app.py – SafeHer Flask backend entry point
import os
import re
import time
from urllib.parse import urlparse
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.exceptions import HTTPException

from db import init_db
from logger import app_logger
from routes.health import health_bp
from routes.auth import auth_bp
from routes.pin import pin_bp
from routes.contacts import contacts_bp
from routes.alerts import alerts_bp
from routes.volunteers import volunteers_bp
from routes.timers import timers_bp, start_timer_monitor
from routes.admin import admin_bp
from routes.push import push_bp
from routes.evidence import evidence_bp
from scheduler import start_scheduler

# 1. Load configuration from .env
basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()

SECRET_KEY = os.getenv('SECRET_KEY', 'default-safeher-secret-key')
PORT = int(os.getenv('PORT', 5000))
DEBUG = os.getenv('DEBUG', 'True').lower() in ('true', '1', 'yes')

# Parse allowed CORS origins strictly from .env
allowed_env = os.getenv('ALLOWED_ORIGINS', 'http://localhost:3000,http://localhost:5000,http://localhost:8000,http://127.0.0.1:5500')
frontend_url = os.getenv('FRONTEND_URL', '')

origins_list = [origin.strip() for origin in allowed_env.split(',') if origin.strip()]
if frontend_url:
    parsed_frontend = urlparse(frontend_url)
    origin_base = f"{parsed_frontend.scheme}://{parsed_frontend.netloc}" if parsed_frontend.netloc else frontend_url.strip()
    if origin_base and origin_base not in origins_list:
        origins_list.append(origin_base)

# Limit CORS strictly to configured origins and localhost
cors_origins = [
    re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
] + origins_list


def create_app():
    """Application factory for SafeHer Flask backend."""
    app = Flask(__name__)
    app.config['SECRET_KEY'] = SECRET_KEY

    # 2. Configure CORS strictly to allowed origins
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
    app.register_blueprint(admin_bp)
    app.register_blueprint(push_bp)
    app.register_blueprint(evidence_bp)

    # 5. Start background thread checking for expired running timers & evidence scheduler
    start_timer_monitor()
    start_scheduler()

    # Serve frontend files when accessing backend port directly (e.g. /admin.html)
    frontend_dir = os.path.abspath(os.path.join(basedir, '..'))

    @app.route('/')
    def serve_index():
        return send_from_directory(frontend_dir, 'index.html')

    @app.route('/<path:filename>')
    def serve_frontend_file(filename):
        if filename.startswith('api/') or filename == 'api':
            return jsonify({"ok": False, "error": "Resource not found"}), 404
        file_path = os.path.join(frontend_dir, filename)
        if os.path.isfile(file_path):
            return send_from_directory(frontend_dir, filename)
        return send_from_directory(frontend_dir, 'index.html')

    # 6. Request timing and rotating file logging
    @app.before_request
    def before_request_timer():
        request._start_time = time.time()

    @app.after_request
    def after_request_logger(response):
        duration_ms = 0.0
        if hasattr(request, '_start_time'):
            duration_ms = (time.time() - request._start_time) * 1000

        # Mask tokens or phone numbers in URL path
        raw_path = request.path
        masked_path = re.sub(r'/api/track/[^/]+', '/api/track/[TOKEN]', raw_path)

        app_logger.info(f"[REQUEST] {request.method} {masked_path} {response.status_code} ({duration_ms:.1f}ms)")
        return response

    # 7. Global error handlers (consistent JSON format: {"ok": false, "error": "..."}, no stack traces)
    @app.errorhandler(400)
    def handle_bad_request(e):
        return jsonify({"ok": False, "error": getattr(e, 'description', 'Bad request')}), 400

    @app.errorhandler(401)
    def handle_unauthorized(e):
        return jsonify({"ok": False, "error": getattr(e, 'description', 'Unauthorized')}), 401

    @app.errorhandler(403)
    def handle_forbidden(e):
        return jsonify({"ok": False, "error": getattr(e, 'description', 'Forbidden')}), 403

    @app.errorhandler(404)
    def handle_not_found(e):
        return jsonify({"ok": False, "error": "Resource not found"}), 404

    @app.errorhandler(405)
    def handle_method_not_allowed(e):
        return jsonify({"ok": False, "error": "Method not allowed"}), 405

    @app.errorhandler(429)
    def handle_rate_limited(e):
        return jsonify({"ok": False, "error": getattr(e, 'description', 'Too many requests. Please try again later.')}), 429

    @app.errorhandler(500)
    def handle_server_error(e):
        return jsonify({"ok": False, "error": "Internal server error"}), 500

    @app.errorhandler(Exception)
    def handle_unexpected_exception(e):
        if isinstance(e, HTTPException):
            code = e.code or 500
            desc = getattr(e, 'description', 'An error occurred')
            return jsonify({"ok": False, "error": desc}), code
        app_logger.error(f"[ERROR] Unhandled exception: {e}")
        return jsonify({"ok": False, "error": "Internal server error"}), 500

    return app


app = create_app()

if __name__ == '__main__':
    print(f"Starting SafeHer API on port {PORT} (debug={DEBUG})...")
    app.run(host='0.0.0.0', port=PORT, debug=DEBUG)
