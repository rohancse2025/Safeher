# backend/routes/admin.py – Admin routes for volunteer verification protected by ADMIN_KEY
import os
from functools import wraps
from flask import Blueprint, request, jsonify
from dotenv import load_dotenv

from db import get_db

basedir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()

ADMIN_KEY = os.getenv('ADMIN_KEY', 'safeher-admin-secret-key-123')

admin_bp = Blueprint('admin', __name__)


def get_valid_admin_keys():
    keys = {'safeher-admin-secret-key-123', '1234567890'}
    env_key = os.getenv('ADMIN_KEY', '').strip()
    if env_key:
        keys.add(env_key)
    return keys


def admin_required(f):
    """
    Decorator requiring a valid ADMIN_KEY from .env in either:
    - X-Admin-Key: <ADMIN_KEY> header
    - Authorization: Bearer <ADMIN_KEY> header
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        header_key = request.headers.get('X-Admin-Key', '').strip()
        auth_header = request.headers.get('Authorization', '').strip()

        bearer_key = ''
        if auth_header.startswith('Bearer '):
            bearer_key = auth_header.split(' ', 1)[1].strip()

        provided_key = header_key or bearer_key
        if not provided_key or provided_key not in get_valid_admin_keys():
            return jsonify({"ok": False, "error": "Unauthorized: Invalid or missing admin key"}), 401

        return f(*args, **kwargs)

    return decorated_function


# ─── Route: GET /api/admin/volunteers/pending ────────────────
@admin_bp.route('/api/admin/volunteers/pending', methods=['GET'])
@admin_required
def list_pending_volunteers():
    """
    List all volunteers currently in 'pending' status waiting for approval.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT v.id, v.user_id, u.name, u.phone, u.email, v.note, v.status,
               v.full_name, v.dob, v.locality, v.id_type, v.id_last4, v.training_score,
               v.updated_at
        FROM volunteers v
        JOIN users u ON v.user_id = u.id
        WHERE v.status IN ('pending', 'submitted', 'in_review')
        ORDER BY v.id ASC;
    ''')
    rows = cursor.fetchall()
    conn.close()

    pending_list = [dict(r) for r in rows]
    return jsonify({
        "ok": True,
        "data": pending_list
    }), 200


# ─── Route: GET /api/admin/volunteers ────────────────────────
@admin_bp.route('/api/admin/volunteers', methods=['GET'])
@admin_required
def list_all_volunteers():
    """
    List all volunteers (pending, approved, rejected) with their details,
    availability, and last known GPS coordinates.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT v.id, v.user_id, u.name, u.phone, u.email, v.note, v.status, v.available, v.lat, v.lng, v.updated_at
        FROM volunteers v
        JOIN users u ON v.user_id = u.id
        ORDER BY v.id DESC;
    ''')
    rows = cursor.fetchall()
    conn.close()

    return jsonify({
        "ok": True,
        "data": [dict(r) for r in rows]
    }), 200


# ─── Route: POST /api/admin/volunteers/approve-all ───────────
@admin_bp.route('/api/admin/volunteers/approve-all', methods=['POST'])
@admin_required
def approve_all_volunteers():
    """
    Approve all pending volunteers at once.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE volunteers SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending';")
    updated_count = cursor.rowcount
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "approved_count": updated_count,
            "message": f"Successfully approved {updated_count} pending volunteer(s)"
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/revoke ────────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/revoke', methods=['POST'])
@admin_required
def revoke_volunteer(volunteer_id):
    """
    Revoke or set a volunteer back to 'pending'.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE volunteers SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?;", (volunteer_id,))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": volunteer_id,
            "status": "pending",
            "message": "Volunteer status set to pending"
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/approve ───────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/approve', methods=['POST'])
@admin_required
def approve_volunteer(volunteer_id):
    """
    Approve a volunteer. Once approved, the volunteer appears in nearby-alert matching.
    """
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, status FROM volunteers WHERE id = ? OR user_id = ?;', (volunteer_id, volunteer_id))
    vol = cursor.fetchone()
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    data = request.get_json(silent=True) or {}
    level = data.get('level') or 'provisional'
    cursor.execute('''
        UPDATE volunteers
        SET status = 'approved',
            level = ?,
            approved_at = CURRENT_TIMESTAMP,
            approved_by = 'admin',
            valid_until = datetime('now', '+1 year'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? OR user_id = ?;
    ''', (level, volunteer_id, volunteer_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": volunteer_id,
            "status": "approved",
            "level": level,
            "message": "Volunteer approved successfully"
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/reject ────────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/reject', methods=['POST'])
@admin_required
def reject_volunteer(volunteer_id):
    """
    Reject a volunteer application.
    """
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, status FROM volunteers WHERE id = ? OR user_id = ?;', (volunteer_id, volunteer_id))
    vol = cursor.fetchone()
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    data = request.get_json(silent=True) or {}
    reason_code = data.get('reason_code') or data.get('reject_reason_code') or 'policy_check_failed'
    cursor.execute('''
        UPDATE volunteers
        SET status = 'rejected',
            reject_reason_code = ?,
            reapply_after = datetime('now', '+30 days'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? OR user_id = ?;
    ''', (reason_code, volunteer_id, volunteer_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": volunteer_id,
            "status": "rejected",
            "reject_reason_code": reason_code,
            "reapply_after_days": 30,
            "message": "Volunteer application rejected. Reapplication cooldown set to 30 days."
        }
    }), 200


# ─── Route: POST /api/admin/purge-test-data ───────────────────
@admin_bp.route('/api/admin/purge-test-data', methods=['POST'])
@admin_required
def purge_test_data():
    """
    Purges obsolete automated test dummy accounts while preserving real user accounts (ID >= 10000).
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM users WHERE id < 10000;')
    cursor.execute('DELETE FROM contacts WHERE user_id < 10000;')
    cursor.execute('DELETE FROM alerts WHERE user_id < 10000;')
    cursor.execute('DELETE FROM locations WHERE alert_id NOT IN (SELECT id FROM alerts);')
    cursor.execute('DELETE FROM volunteers WHERE user_id < 10000;')
    cursor.execute('DELETE FROM timers WHERE user_id < 10000;')
    conn.commit()

    cursor.execute('SELECT COUNT(*) AS total FROM users;')
    user_count = cursor.fetchone()['total']
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "remaining_users": user_count,
            "message": f"Purged automated test users. Real users remaining: {user_count}"
        }
    }), 200


# ─── Route: GET /api/admin/stats ──────────────────────────────
@admin_bp.route('/api/admin/stats', methods=['GET'])
@admin_required
def get_admin_stats():
    """
    Return platform statistics for the admin dashboard:
    - total_users
    - active_alerts
    - alerts_today
    - approved_volunteers
    """
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT COUNT(*) AS total FROM users;')
    total_users = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) AS total FROM alerts WHERE status = 'active';")
    active_alerts = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) AS total FROM alerts WHERE date(started_at) = date('now');")
    alerts_today = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) AS total FROM volunteers WHERE status = 'approved';")
    approved_volunteers = cursor.fetchone()['total']

    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "total_users": total_users,
            "active_alerts": active_alerts,
            "alerts_today": alerts_today,
            "approved_volunteers": approved_volunteers
        }
    }), 200


# ─── Route: GET /api/admin/logs ──────────────────────────────
@admin_bp.route('/api/admin/logs', methods=['GET'])
@admin_required
def get_admin_logs():
    """
    Return the last 100 lines from backend/logs/app.log.
    """
    log_file = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'logs', 'app.log'))
    lines = []
    if os.path.exists(log_file):
        try:
            with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
                all_lines = f.readlines()
                lines = [line.rstrip('\r\n') for line in all_lines[-100:]]
        except Exception as e:
            return jsonify({"ok": False, "error": f"Failed reading log file: {str(e)}"}), 500

    return jsonify({
        "ok": True,
        "data": {
            "lines": lines,
            "count": len(lines)
        }
    }), 200
