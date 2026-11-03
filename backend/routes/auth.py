# backend/routes/auth.py – User registration, login (JWT), profile, and auth decorator
import os
import re
import time
import datetime
from functools import wraps
from flask import Blueprint, request, jsonify, g
from werkzeug.security import generate_password_hash, check_password_hash
import jwt
from dotenv import load_dotenv

from db import get_db

basedir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()
SECRET_KEY = os.getenv('SECRET_KEY', 'default-safeher-secret-key')

auth_bp = Blueprint('auth', __name__)

# In-memory store for login rate limiting: max 10 attempts per 15 minutes per phone
# { phone: [timestamp1, timestamp2, ...] }
login_attempts = {}


# ─── Auth Helper: Login Required Decorator ────────────────────
def login_required(f):
    """
    Decorator that requires a valid JWT in the Authorization header:
    Authorization: Bearer <token>
    Sets g.current_user and passes it to the wrapped function.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header or not auth_header.startswith('Bearer '):
            return jsonify({"ok": False, "error": "Authorization token required"}), 401

        token = auth_header.split(' ', 1)[1].strip()

        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
            user_id = payload.get('user_id')
        except jwt.ExpiredSignatureError:
            return jsonify({"ok": False, "error": "Token has expired. Please login again."}), 401
        except jwt.InvalidTokenError:
            return jsonify({"ok": False, "error": "Invalid authorization token"}), 401

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT id, name, phone, email, pin_hash, duress_pin_hash, created_at FROM users WHERE id = ?;', (user_id,))
        user = cursor.fetchone()
        conn.close()

        if not user:
            return jsonify({"ok": False, "error": "User no longer exists"}), 401

        g.current_user = dict(user)
        return f(*args, **kwargs)

    return decorated_function


# ─── Input Validation Helpers ─────────────────────────────────
def is_valid_phone(phone):
    return bool(re.match(r'^\d{10}$', str(phone).strip()))


def is_valid_email(email):
    return bool(re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', str(email).strip()))


# ─── Route: POST /api/register ───────────────────────────────
@auth_bp.route('/api/register', methods=['POST'])
def register():
    """
    Register a new user account.
    Expects JSON: { name, phone, email, password }
    """
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    phone = (data.get('phone') or '').strip()
    email = (data.get('email') or '').strip()
    password = data.get('password') or ''

    # Validations
    if not name:
        return jsonify({"ok": False, "error": "Name is required"}), 400

    if not phone:
        return jsonify({"ok": False, "error": "Phone number is required"}), 400
    if not is_valid_phone(phone):
        return jsonify({"ok": False, "error": "Phone must be a valid 10-digit number"}), 400

    if email and not is_valid_email(email):
        return jsonify({"ok": False, "error": "Invalid email address format"}), 400

    if not password:
        return jsonify({"ok": False, "error": "Password is required"}), 400
    if len(password) < 6:
        return jsonify({"ok": False, "error": "Password must be at least 6 characters long"}), 400

    # Hash password using werkzeug
    password_hash = generate_password_hash(password)

    conn = get_db()
    cursor = conn.cursor()

    # Check if phone is already registered
    cursor.execute('SELECT id FROM users WHERE phone = ?;', (phone,))
    if cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Phone number is already registered"}), 409

    try:
        cursor.execute(
            'INSERT INTO users (name, phone, email, password_hash) VALUES (?, ?, ?, ?);',
            (name, phone, email or None, password_hash)
        )
        user_id = cursor.lastrowid
        conn.commit()
    except Exception:
        conn.close()
        return jsonify({"ok": False, "error": "Registration failed. Please try again."}), 500

    conn.close()

    # Generate JWT token valid for 7 days
    token = jwt.encode({
        "user_id": user_id,
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)
    }, SECRET_KEY, algorithm='HS256')

    return jsonify({
        "ok": True,
        "data": {
            "token": token,
            "user": {
                "id": user_id,
                "name": name,
                "phone": phone,
                "email": email or None,
                "has_pin": False
            }
        }
    }), 201


# ─── Route: POST /api/login ──────────────────────────────────
@auth_bp.route('/api/login', methods=['POST'])
def login():
    """
    Log in an existing user with phone and password. Returns JWT token.
    Rate limited to 10 attempts per 15 minutes per phone number.
    Expects JSON: { phone, password }
    """
    data = request.get_json(silent=True) or {}
    phone = (data.get('phone') or '').strip()
    password = data.get('password') or ''

    if not phone or not password:
        return jsonify({"ok": False, "error": "Phone and password are required"}), 400

    now = time.time()
    # Rate limit: max 10 attempts per 15 minutes (900 seconds) per phone number
    recent_attempts = [t for t in login_attempts.get(phone, []) if now - t < 900]
    if len(recent_attempts) >= 10:
        oldest = recent_attempts[0]
        retry_seconds = max(1, int(900 - (now - oldest)))
        retry_minutes = max(1, (retry_seconds + 59) // 60)
        return jsonify({
            "ok": False,
            "error": f"Too many login attempts. Please try again in {retry_minutes} minute{'s' if retry_minutes > 1 else ''}."
        }), 429

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, name, phone, email, password_hash, pin_hash FROM users WHERE phone = ?;', (phone,))
    user = cursor.fetchone()
    conn.close()

    if not user or not check_password_hash(user['password_hash'], password):
        recent_attempts.append(now)
        login_attempts[phone] = recent_attempts
        return jsonify({"ok": False, "error": "Invalid phone number or password"}), 401

    # Successful login resets failed attempts for this phone number
    if phone in login_attempts:
        del login_attempts[phone]

    # Generate JWT token valid for 7 days
    token = jwt.encode({
        "user_id": user['id'],
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)
    }, SECRET_KEY, algorithm='HS256')

    return jsonify({
        "ok": True,
        "data": {
            "token": token,
            "user": {
                "id": user['id'],
                "name": user['name'],
                "phone": user['phone'],
                "email": user['email'],
                "has_pin": bool(user['pin_hash'])
            }
        }
    }), 200


# ─── Route: GET /api/me ──────────────────────────────────────
@auth_bp.route('/api/me', methods=['GET'])
@login_required
def get_current_user():
    """
    Fetch profile information for the authenticated user.
    """
    user = g.current_user
    return jsonify({
        "ok": True,
        "data": {
            "id": user['id'],
            "name": user['name'],
            "phone": user['phone'],
            "email": user['email'],
            "has_pin": bool(user.get('pin_hash')),
            "has_duress_pin": bool(user.get('duress_pin_hash')),
            "created_at": user.get('created_at')
        }
    }), 200


# ─── Route: PUT /api/me ──────────────────────────────────────
@auth_bp.route('/api/me', methods=['PUT'])
@login_required
def update_current_user():
    """
    Update profile information (name, phone) for the authenticated user.
    Expects JSON: { name, phone }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    phone = (data.get('phone') or '').strip()

    if not name:
        return jsonify({"ok": False, "error": "Name is required"}), 400
    if not phone or not is_valid_phone(phone):
        return jsonify({"ok": False, "error": "Phone must be a valid 10-digit number"}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Check if new phone is already taken by another user
    cursor.execute('SELECT id FROM users WHERE phone = ? AND id != ?;', (phone, user_id))
    if cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Phone number is already in use by another account"}), 409

    cursor.execute('UPDATE users SET name = ?, phone = ? WHERE id = ?;', (name, phone, user_id))
    conn.commit()

    cursor.execute('SELECT id, name, phone, email, pin_hash, duress_pin_hash, created_at FROM users WHERE id = ?;', (user_id,))
    updated = cursor.fetchone()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": updated['id'],
            "name": updated['name'],
            "phone": updated['phone'],
            "email": updated['email'],
            "has_pin": bool(updated['pin_hash']),
            "has_duress_pin": bool(updated['duress_pin_hash']),
            "created_at": updated['created_at']
        }
    }), 200


# ─── Route: DELETE /api/me ─────────────────────────────────────
@auth_bp.route('/api/me', methods=['DELETE'])
@auth_bp.route('/api/me/delete', methods=['POST'])
@login_required
def delete_current_user():
    """
    Permanently delete the authenticated user and all related rows:
    contacts, alerts, locations, responses, volunteers, timers, push_subscriptions.
    Requires validation of the user's 4-digit safety PIN.
    Expects JSON: { pin: "1234" }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}
    pin = (data.get('pin') or '').strip()

    if not pin:
        return jsonify({"ok": False, "error": "Safety PIN is required to delete your account"}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, pin_hash FROM users WHERE id = ?;', (user_id,))
    user_row = cursor.fetchone()
    if not user_row:
        conn.close()
        return jsonify({"ok": False, "error": "User not found"}), 404

    # Verify PIN hash if user has set a PIN
    pin_hash = user_row['pin_hash']
    if pin_hash and not check_password_hash(pin_hash, pin):
        conn.close()
        return jsonify({"ok": False, "error": "Invalid safety PIN"}), 400

    # Delete all associated rows in dependency order
    cursor.execute('DELETE FROM timers WHERE user_id = ?;', (user_id,))
    cursor.execute('DELETE FROM contacts WHERE user_id = ?;', (user_id,))
    cursor.execute('DELETE FROM locations WHERE alert_id IN (SELECT id FROM alerts WHERE user_id = ?);', (user_id,))
    cursor.execute('''
        DELETE FROM responses 
        WHERE alert_id IN (SELECT id FROM alerts WHERE user_id = ?)
           OR volunteer_id IN (SELECT id FROM volunteers WHERE user_id = ?);
    ''', (user_id, user_id))
    cursor.execute('DELETE FROM alerts WHERE user_id = ?;', (user_id,))
    cursor.execute('DELETE FROM volunteers WHERE user_id = ?;', (user_id,))
    cursor.execute('DELETE FROM push_subscriptions WHERE user_id = ?;', (user_id,))
    cursor.execute('DELETE FROM users WHERE id = ?;', (user_id,))

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "message": "User account and all associated data deleted successfully"
        }
    }), 200
