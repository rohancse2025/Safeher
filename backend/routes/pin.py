# backend/routes/pin.py – Safety PIN setup, update, and verification with 30s lock
import time
import re
from flask import Blueprint, request, jsonify, g
from werkzeug.security import generate_password_hash, check_password_hash

from db import get_db
from routes.auth import login_required

pin_bp = Blueprint('pin', __name__)

# In-memory dictionary tracking failed PIN attempts:
# { user_id: { "attempts": int, "locked_until": float timestamp } }
pin_attempts = {}


def is_valid_pin(pin):
    """PIN must be exactly 4 digits."""
    return bool(re.match(r'^\d{4}$', str(pin).strip()))


# ─── Route: POST /api/pin/set ─────────────────────────────────
@pin_bp.route('/api/pin/set', methods=['POST'])
@login_required
def set_pin():
    """
    Set a 4-digit safety PIN and an optional duress PIN.
    Expects JSON: { pin, duress_pin (optional) }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}
    pin = str(data.get('pin') or '').strip()
    duress_pin = str(data.get('duress_pin') or '').strip()

    if not is_valid_pin(pin):
        return jsonify({"ok": False, "error": "PIN must be exactly 4 digits"}), 400

    duress_pin_hash = None
    if duress_pin:
        if not is_valid_pin(duress_pin):
            return jsonify({"ok": False, "error": "Duress PIN must be exactly 4 digits"}), 400
        if duress_pin == pin:
            return jsonify({"ok": False, "error": "Duress PIN cannot be the same as your normal PIN"}), 400
        duress_pin_hash = generate_password_hash(duress_pin)

    pin_hash = generate_password_hash(pin)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'UPDATE users SET pin_hash = ?, duress_pin_hash = ? WHERE id = ?;',
        (pin_hash, duress_pin_hash, user_id)
    )
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "message": "Safety PIN set successfully",
            "has_duress_pin": bool(duress_pin)
        }
    }), 200


# ─── Route: POST /api/pin/change ──────────────────────────────
@pin_bp.route('/api/pin/change', methods=['POST'])
@login_required
def change_pin():
    """
    Change safety PIN. Requires verification of the old PIN.
    Expects JSON: { old_pin, new_pin, duress_pin (optional) }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}
    old_pin = str(data.get('old_pin') or '').strip()
    new_pin = str(data.get('new_pin') or '').strip()
    duress_pin = str(data.get('duress_pin') or '').strip()

    if not is_valid_pin(old_pin):
        return jsonify({"ok": False, "error": "Current PIN must be exactly 4 digits"}), 400
    if not is_valid_pin(new_pin):
        return jsonify({"ok": False, "error": "New PIN must be exactly 4 digits"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT pin_hash FROM users WHERE id = ?;', (user_id,))
    row = cursor.fetchone()

    if not row or not row['pin_hash'] or not check_password_hash(row['pin_hash'], old_pin):
        conn.close()
        return jsonify({"ok": False, "error": "Current PIN is incorrect"}), 403

    duress_pin_hash = None
    if duress_pin:
        if not is_valid_pin(duress_pin):
            conn.close()
            return jsonify({"ok": False, "error": "Duress PIN must be exactly 4 digits"}), 400
        if duress_pin == new_pin:
            conn.close()
            return jsonify({"ok": False, "error": "Duress PIN cannot be the same as your new PIN"}), 400
        duress_pin_hash = generate_password_hash(duress_pin)

    new_pin_hash = generate_password_hash(new_pin)
    cursor.execute(
        'UPDATE users SET pin_hash = ?, duress_pin_hash = ? WHERE id = ?;',
        (new_pin_hash, duress_pin_hash, user_id)
    )
    conn.commit()
    conn.close()

    # Reset any failed verification tracking
    if user_id in pin_attempts:
        del pin_attempts[user_id]

    return jsonify({
        "ok": True,
        "data": {
            "message": "Safety PIN changed successfully"
        }
    }), 200


# ─── Route: POST /api/pin/verify ──────────────────────────────
@pin_bp.route('/api/pin/verify', methods=['POST'])
@login_required
def verify_pin():
    """
    Verify user PIN.
    Returns result as "ok", "duress", or "wrong".
    Implements a 30-second lockout after 5 consecutive wrong attempts.
    """
    user_id = g.current_user['id']
    now = time.time()

    # Check lockout
    user_state = pin_attempts.setdefault(user_id, {"attempts": 0, "locked_until": 0})
    if user_state["locked_until"] > now:
        remaining = int(user_state["locked_until"] - now)
        return jsonify({
            "ok": False,
            "error": f"Too many wrong attempts. Locked for {remaining} seconds."
        }), 429

    data = request.get_json(silent=True) or {}
    pin = str(data.get('pin') or '').strip()

    if not is_valid_pin(pin):
        return jsonify({"ok": False, "error": "PIN must be exactly 4 digits"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT pin_hash, duress_pin_hash FROM users WHERE id = ?;', (user_id,))
    row = cursor.fetchone()
    conn.close()

    if not row or not row['pin_hash']:
        return jsonify({"ok": False, "error": "No safety PIN has been set yet"}), 400

    # 1. Correct normal PIN
    if check_password_hash(row['pin_hash'], pin):
        user_state["attempts"] = 0
        user_state["locked_until"] = 0
        return jsonify({
            "ok": True,
            "data": {
                "result": "ok"
            }
        }), 200

    # 2. Duress PIN match
    if row['duress_pin_hash'] and check_password_hash(row['duress_pin_hash'], pin):
        user_state["attempts"] = 0
        user_state["locked_until"] = 0
        return jsonify({
            "ok": True,
            "data": {
                "result": "duress"
            }
        }), 200

    # 3. Wrong PIN
    user_state["attempts"] += 1
    if user_state["attempts"] >= 5:
        user_state["locked_until"] = now + 30
        user_state["attempts"] = 0
        return jsonify({
            "ok": True,
            "data": {
                "result": "wrong",
                "locked": True,
                "lock_seconds": 30
            }
        }), 200

    return jsonify({
        "ok": True,
        "data": {
            "result": "wrong",
            "attempts_remaining": 5 - user_state["attempts"]
        }
    }), 200
