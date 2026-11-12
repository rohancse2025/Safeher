# backend/routes/health.py – Health check, version, and deep diagnostic routes
import os
import json
import urllib.request
import urllib.error
import datetime
from flask import Blueprint, jsonify
from db import get_db

health_bp = Blueprint('health', __name__)

BUILD_VERSION = "v93"
BUILD_TIMESTAMP = datetime.datetime.now().isoformat()


def mask_email_local(email):
    if not email or '@' not in email:
        return 'N/A'
    parts = email.split('@', 1)
    u, d = parts[0], parts[1]
    if len(u) <= 1:
        return f"{u}***@{d}"
    elif len(u) == 2:
        return f"{u[0]}***@{d}"
    return f"{u[0]}***{u[-1]}@{d}"


@health_bp.route('/api/health', methods=['GET'])
def health_check():
    """
    Basic health check endpoint to verify backend server and SQLite database status.
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
            "central brevo email notification engine",
            "idempotent outbox with automatic retries",
            "delivery tracking webhook",
            "1-click consent opt-out & welcome emails",
            "contacts email coverage diagnostics",
            "1-tap whatsapp response without app",
            "automated escort & timer alerts"
        ],
        "timestamp": BUILD_TIMESTAMP
    }), 200


@health_bp.route('/api/health/deep', methods=['GET'])
def health_deep():
    """
    Deep diagnostic health check.
    Verifies:
      - SQLite database connectivity
      - Brevo API configuration and credentials check (GET https://api.brevo.com/v3/account)
      - Notification metrics: queued count, failures in last hour, last successful send, sent today
      - Warns if sent_today >= 250 (Brevo free plan allows 300/day)
    """
    db_ok = False
    db_error = None
    notif_metrics = {
        "queued": 0,
        "sending": 0,
        "failed_last_hour": 0,
        "last_successful_send": None,
        "sent_today": 0,
        "daily_limit": 300,
        "daily_warning": False
    }

    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT 1;')
        db_ok = True

        # Query notification stats
        try:
            cursor.execute("SELECT COUNT(*) AS cnt FROM notifications WHERE channel = 'email' AND status = 'queued';")
            notif_metrics["queued"] = cursor.fetchone()['cnt']

            cursor.execute("SELECT COUNT(*) AS cnt FROM notifications WHERE channel = 'email' AND status = 'sending';")
            notif_metrics["sending"] = cursor.fetchone()['cnt']

            cursor.execute('''
                SELECT COUNT(*) AS cnt FROM notifications
                WHERE channel = 'email'
                  AND status IN ('failed', 'bounced', 'blocked')
                  AND created_at >= datetime('now', '-1 hour');
            ''')
            notif_metrics["failed_last_hour"] = cursor.fetchone()['cnt']

            cursor.execute('''
                SELECT sent_at FROM notifications
                WHERE channel = 'email' AND status IN ('sent', 'delivered')
                ORDER BY sent_at DESC LIMIT 1;
            ''')
            row = cursor.fetchone()
            if row and row['sent_at']:
                notif_metrics["last_successful_send"] = row['sent_at']

            cursor.execute('''
                SELECT COUNT(*) AS cnt FROM notifications
                WHERE channel = 'email'
                  AND status IN ('sent', 'delivered')
                  AND date(sent_at) = date('now');
            ''')
            sent_today = cursor.fetchone()['cnt']
            notif_metrics["sent_today"] = sent_today
            notif_metrics["daily_warning"] = (sent_today >= 250)

        except Exception as q_err:
            notif_metrics["query_error"] = str(q_err)

        conn.close()

    except Exception as e:
        db_error = str(e)

    # Check Brevo API
    brevo_api_key = os.getenv('BREVO_API_KEY')
    brevo_info = {
        "configured": bool(brevo_api_key),
        "valid": False,
        "status": "not_configured" if not brevo_api_key else "unknown",
        "account_email": None,
        "plan_type": None
    }

    if brevo_api_key:
        try:
            req = urllib.request.Request(
                "https://api.brevo.com/v3/account",
                headers={
                    "api-key": brevo_api_key.strip(),
                    "Accept": "application/json"
                },
                method='GET'
            )
            with urllib.request.urlopen(req, timeout=4.0) as res:
                if res.getcode() == 200:
                    acct_data = json.loads(res.read().decode('utf-8'))
                    brevo_info["valid"] = True
                    brevo_info["status"] = "connected"
                    raw_email = acct_data.get('email')
                    brevo_info["account_email"] = mask_email_local(raw_email)
                    plans = acct_data.get('plan') or []
                    if plans and isinstance(plans, list):
                        brevo_info["plan_type"] = plans[0].get('type')
                    else:
                        brevo_info["plan_type"] = "standard"
                else:
                    brevo_info["status"] = f"HTTP {res.getcode()}"
        except urllib.error.HTTPError as he:
            brevo_info["valid"] = False
            if he.code in (401, 403):
                brevo_info["status"] = "invalid_api_key"
            else:
                brevo_info["status"] = f"HTTP {he.code}"
        except Exception as ex:
            brevo_info["valid"] = False
            brevo_info["status"] = "unreachable"

    overall_healthy = db_ok and (not brevo_api_key or brevo_info["valid"])
    warning_flag = notif_metrics["daily_warning"] or (not brevo_api_key)

    response_data = {
        "status": "healthy" if overall_healthy and not warning_flag else ("warning" if overall_healthy else "degraded"),
        "service": "SafeHer Backend API",
        "version": BUILD_VERSION,
        "timestamp": datetime.datetime.now().isoformat(),
        "database": {
            "status": "connected" if db_ok else "failed",
            "error": db_error
        },
        "brevo": brevo_info,
        "notifications": notif_metrics
    }

    return jsonify({
        "ok": overall_healthy,
        "data": response_data
    }), 200 if overall_healthy else 500
