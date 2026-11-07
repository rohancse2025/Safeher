# backend/routes/evidence.py – Evidence Vault Storage, Sequential Chunks & Hash Chain Verification
import os
import json
import time
import uuid
import shutil
import hashlib
from flask import Blueprint, request, jsonify, g, send_file
from werkzeug.security import check_password_hash
from db import get_db
from routes.auth import login_required
import base64
from routes.alerts import get_user_from_request
try:
    from services.events import log_event
except ImportError:
    from backend.services.events import log_event

evidence_bp = Blueprint('evidence', __name__)

MAX_CHUNK_SIZE_BYTES = 3 * 1024 * 1024        # 3 MB per chunk
MAX_USER_STORAGE_BYTES = 200 * 1024 * 1024    # 200 MB total per user

def get_evidence_base_dir():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'evidence'))
    os.makedirs(base, exist_ok=True)
    return base


# ─── 1. Register Public & Wrapped Private Keys ────────────────
@evidence_bp.route('/api/evidence/key', methods=['POST'])
@login_required
def register_key():
    """
    Save the public key and wrapped private key (and salt).
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])
    data = request.get_json(silent=True) or {}

    public_key = data.get('publicKey') or data.get('public_key')
    if not public_key:
        return jsonify({"ok": False, "error": "publicKey is required"}), 400

    wrapped_private_key = data.get('wrappedPrivateKey') or data.get('wrapped_private_key') or ''
    salt = data.get('salt') or ''

    pk_str = json.dumps(public_key) if isinstance(public_key, dict) else str(public_key)
    wpk_str = json.dumps(wrapped_private_key) if isinstance(wrapped_private_key, dict) else str(wrapped_private_key)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO evidence_keys (user_id, public_key, wrapped_private_key, salt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            public_key = excluded.public_key,
            wrapped_private_key = excluded.wrapped_private_key,
            salt = excluded.salt,
            created_at = CURRENT_TIMESTAMP;
    ''', (user_id, pk_str, wpk_str, salt))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "message": "Evidence encryption key saved successfully",
        "userId": user_id
    }), 200


# ─── 2. Retrieve Public & Wrapped Private Keys ────────────────
@evidence_bp.route('/api/evidence/key', methods=['GET'])
@login_required
def get_key():
    """
    Retrieve stored evidence keys for the authenticated owner.
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT public_key, wrapped_private_key, salt, created_at
        FROM evidence_keys
        WHERE user_id = ?;
    ''', (user_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return jsonify({"ok": False, "error": "Public key not found"}), 404

    pk_raw = row['public_key']
    try:
        pk_obj = json.loads(pk_raw)
    except Exception:
        pk_obj = pk_raw

    return jsonify({
        "ok": True,
        "publicKey": pk_obj,
        "wrappedPrivateKey": row['wrapped_private_key'],
        "salt": row['salt'],
        "createdAt": row['created_at'],
        "userId": user_id
    }), 200


# ─── 3. Create Evidence Session ───────────────────────────────
@evidence_bp.route('/api/evidence/sessions', methods=['POST'])
@login_required
def create_session():
    """
    Create a new evidence session.
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])
    data = request.get_json(silent=True) or {}

    session_id = str(data.get('id') or f"sess_{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}")
    alert_id = str(data.get('alertId') or data.get('alert_id') or '')
    kind = str(data.get('kind') or 'audio').strip().lower()
    started_at = data.get('startedAt') or data.get('started_at') or time.strftime('%Y-%m-%d %H:%M:%S')

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO evidence_sessions (id, user_id, alert_id, kind, started_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            alert_id = excluded.alert_id,
            kind = excluded.kind;
    ''', (session_id, user_id, alert_id, kind, started_at))

    alert_id_val = int(alert_id) if (alert_id and str(alert_id).strip().isdigit()) else None
    log_event(
        user_id=int(user_id),
        type='evidence_session_started',
        actor='user',
        detail={'session_id': session_id, 'kind': kind},
        alert_id=alert_id_val,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "session": {
            "id": session_id,
            "userId": user_id,
            "alertId": alert_id,
            "kind": kind,
            "startedAt": started_at
        }
    }), 201


# ─── 4. Upload Evidence Chunk (Multipart, <=3MB, Sequential) ──
@evidence_bp.route('/api/evidence/sessions/<session_id>/chunks', methods=['POST'])
@login_required
def upload_session_chunk(session_id):
    """
    Upload an encrypted chunk via multipart form-data.
    Checks:
      1. Session exists and owner matches authenticated user.
      2. Chunk size is at most 3 MB.
      3. User total evidence storage is at most 200 MB.
      4. Chunk index (idx) is strictly sequential.
      5. Recomputes SHA-256 of received bytes and rejects any mismatch.
      6. Computes chain_hash = sha256(prev_hash + sha256).
      7. Saves file under backend/evidence/<user_id>/<session_id>/chunk_<idx>.bin.
    """
    user_id = str(g.current_user['id'])

    # 1. Verify session ownership
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, user_id FROM evidence_sessions WHERE id = ?;', (session_id,))
    session = cursor.fetchone()
    if not session:
        conn.close()
        return jsonify({"ok": False, "error": "Evidence session not found"}), 404

    if str(session['user_id']) != user_id:
        conn.close()
        return jsonify({"ok": False, "error": "Forbidden: You do not own this evidence session"}), 403

    # 2. Extract file payload and form fields
    file_obj = request.files.get('file') or request.files.get('chunk')
    if not file_obj:
        conn.close()
        return jsonify({"ok": False, "error": "File attachment is required in multipart form-data"}), 400

    file_bytes = file_obj.read()
    chunk_size = len(file_bytes)

    # Validate size <= 3 MB
    if chunk_size > MAX_CHUNK_SIZE_BYTES:
        conn.close()
        return jsonify({"ok": False, "error": "Chunk size exceeds maximum limit of 3 MB"}), 413

    # Validate total user storage <= 200 MB
    cursor.execute('''
        SELECT COALESCE(SUM(c.size), 0) AS total_used
        FROM evidence_chunks c
        JOIN evidence_sessions s ON c.session_id = s.id
        WHERE s.user_id = ?;
    ''', (user_id,))
    storage_row = cursor.fetchone()
    total_used = storage_row['total_used'] if storage_row else 0

    if total_used + chunk_size > MAX_USER_STORAGE_BYTES:
        conn.close()
        return jsonify({"ok": False, "error": "User total evidence storage limit of 200 MB exceeded"}), 413

    # Extract form metadata
    try:
        idx = int(request.form.get('idx') or request.form.get('index', 0))
    except (ValueError, TypeError):
        conn.close()
        return jsonify({"ok": False, "error": "idx must be a valid integer"}), 400

    client_sha256 = (request.form.get('sha256') or '').strip()
    client_prev_hash = (request.form.get('prev_hash') or request.form.get('prevHash') or '').strip()
    encrypted_key = request.form.get('encrypted_key') or request.form.get('encryptedKey') or ''
    iv = request.form.get('iv') or ''
    mime = request.form.get('mime') or file_obj.content_type or 'application/octet-stream'

    # 3. Validate sequential index and chain
    cursor.execute('''
        SELECT MAX(idx) AS max_idx
        FROM evidence_chunks
        WHERE session_id = ?;
    ''', (session_id,))
    max_row = cursor.fetchone()
    max_idx = max_row['max_idx'] if max_row and max_row['max_idx'] is not None else None

    if max_idx is None:
        if idx != 0:
            conn.close()
            return jsonify({"ok": False, "error": f"Invalid chunk index: expected 0 for first chunk, got {idx}"}), 400
        expected_prev_hash = '0' * 64
    else:
        expected_idx = max_idx + 1
        if idx != expected_idx:
            conn.close()
            return jsonify({"ok": False, "error": f"Invalid chunk index: expected sequential index {expected_idx}, got {idx}"}), 400

        cursor.execute('''
            SELECT chain_hash FROM evidence_chunks
            WHERE session_id = ? AND idx = ?;
        ''', (session_id, max_idx))
        prev_chunk = cursor.fetchone()
        expected_prev_hash = prev_chunk['chain_hash'] if prev_chunk else ('0' * 64)

    if client_prev_hash and client_prev_hash.lower() != expected_prev_hash.lower():
        conn.close()
        return jsonify({"ok": False, "error": f"prev_hash mismatch: expected {expected_prev_hash}, got {client_prev_hash}"}), 400

    # 4. Recompute SHA-256 and reject mismatch
    computed_sha256 = hashlib.sha256(file_bytes).hexdigest()
    if client_sha256 and computed_sha256.lower() != client_sha256.lower():
        conn.close()
        return jsonify({"ok": False, "error": "SHA-256 mismatch: corrupted or altered chunk payload"}), 400

    # 5. Compute chain_hash = sha256(prev_hash + sha256)
    chain_hash = hashlib.sha256((expected_prev_hash + computed_sha256).encode('utf-8')).hexdigest()

    # 6. Store file on filesystem under backend/evidence/<user_id>/<session_id>/
    evidence_base = get_evidence_base_dir()
    session_dir = os.path.join(evidence_base, str(user_id), str(session_id))
    os.makedirs(session_dir, exist_ok=True)

    file_name = f"chunk_{idx}.bin"
    file_path = os.path.join(session_dir, file_name)

    try:
        with open(file_path, 'wb') as f:
            f.write(file_bytes)
    except IOError as e:
        conn.close()
        return jsonify({"ok": False, "error": f"Failed to save chunk to disk: {str(e)}"}), 500

    # 7. Insert chunk record into database
    chunk_id = f"{session_id}_{idx}"
    cursor.execute('''
        INSERT INTO evidence_chunks (
            id, session_id, idx, mime, size, sha256, prev_hash, chain_hash, file_path, encrypted_key, iv
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, idx) DO UPDATE SET
            size = excluded.size,
            sha256 = excluded.sha256,
            chain_hash = excluded.chain_hash,
            file_path = excluded.file_path,
            encrypted_key = excluded.encrypted_key,
            iv = excluded.iv;
    ''', (
        chunk_id, session_id, idx, mime, chunk_size, computed_sha256,
        expected_prev_hash, chain_hash, file_path, encrypted_key, iv
    ))

    cursor.execute('SELECT COUNT(*) AS cnt FROM evidence_chunks WHERE session_id = ?;', (session_id,))
    c_row = cursor.fetchone()
    chunk_count = c_row['cnt'] if c_row else (idx + 1)

    cursor.execute('SELECT alert_id FROM evidence_sessions WHERE id = ?;', (session_id,))
    s_row = cursor.fetchone()
    alert_id_val = None
    if s_row and s_row['alert_id'] and str(s_row['alert_id']).strip().isdigit():
        alert_id_val = int(s_row['alert_id'])

    log_event(
        user_id=int(user_id),
        type='evidence_chunks_uploaded',
        actor='user',
        detail={'session_id': session_id, 'count': chunk_count},
        alert_id=alert_id_val,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "chunk": {
            "id": chunk_id,
            "sessionId": session_id,
            "idx": idx,
            "mime": mime,
            "size": chunk_size,
            "sha256": computed_sha256,
            "prevHash": expected_prev_hash,
            "chainHash": chain_hash,
            "filePath": file_path
        }
    }), 201


# ─── 4c. Direct Chunk Upload Endpoint (JSON or Multipart) ───────
@evidence_bp.route('/api/evidence/chunk', methods=['POST'])
def upload_direct_chunk():
    """
    Accepts direct chunk uploads from frontend vault (JSON base64 or multipart).
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = str(user['id']) if user else '1'

    if request.is_json:
        data = request.get_json(silent=True) or {}
        session_id = str(data.get('sessionId') or data.get('session_id') or 'session_default')
        idx = int(data.get('index', data.get('idx', 0)))
        mime = str(data.get('mime') or 'audio/webm')
        enc_data_b64 = data.get('encryptedData') or ''
        encrypted_key = data.get('encryptedKey') or ''
        iv = data.get('iv') or ''
        client_sha256 = (data.get('sha256') or '').strip()
        client_prev_hash = (data.get('prevHash') or data.get('prev_hash') or '').strip()

        try:
            file_bytes = base64.b64decode(enc_data_b64) if enc_data_b64 else b''
        except Exception:
            file_bytes = enc_data_b64.encode('utf-8') if isinstance(enc_data_b64, str) else b''

        chunk_size = len(file_bytes)
        computed_sha256 = hashlib.sha256(file_bytes).hexdigest() if file_bytes else (client_sha256 or '0'*64)

        conn = get_db()
        cursor = conn.cursor()

        # Ensure session exists
        cursor.execute('SELECT id FROM evidence_sessions WHERE id = ?;', (session_id,))
        if not cursor.fetchone():
            cursor.execute('''
                INSERT INTO evidence_sessions (id, user_id, alert_id, kind, started_at)
                VALUES (?, ?, ?, 'audio', CURRENT_TIMESTAMP);
            ''', (session_id, user_id, data.get('alertId') or ''))

        # Save file to disk
        evidence_base = get_evidence_base_dir()
        session_dir = os.path.join(evidence_base, str(user_id), str(session_id))
        os.makedirs(session_dir, exist_ok=True)
        file_name = f"chunk_{idx}.bin"
        file_path = os.path.join(session_dir, file_name)
        try:
            with open(file_path, 'wb') as f:
                f.write(file_bytes)
        except Exception:
            pass

        chain_hash = data.get('chainHash') or hashlib.sha256(((client_prev_hash or '0'*64) + computed_sha256).encode('utf-8')).hexdigest()
        chunk_id = f"{session_id}_{idx}"

        cursor.execute('''
            INSERT INTO evidence_chunks (
                id, session_id, idx, mime, size, sha256, prev_hash, chain_hash, file_path, encrypted_key, iv
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, idx) DO UPDATE SET
                size = excluded.size,
                sha256 = excluded.sha256,
                chain_hash = excluded.chain_hash,
                file_path = excluded.file_path,
                encrypted_key = excluded.encrypted_key,
                iv = excluded.iv;
        ''', (
            chunk_id, session_id, idx, mime, chunk_size, computed_sha256,
            client_prev_hash or '0'*64, chain_hash, file_path, encrypted_key, iv
        ))
        conn.commit()
        conn.close()

        return jsonify({
            "ok": True,
            "chunk": {
                "id": chunk_id,
                "sessionId": session_id,
                "idx": idx,
                "size": chunk_size
            }
        }), 201

    file_obj = request.files.get('file') or request.files.get('chunk')
    if file_obj:
        session_id = request.form.get('sessionId') or request.form.get('session_id') or 'session_default'
        return upload_session_chunk(session_id)

    return jsonify({"ok": False, "error": "Invalid chunk payload"}), 400


# ─── 4b. End Evidence Session ──────────────────────────────────
@evidence_bp.route('/api/evidence/sessions/<session_id>/end', methods=['POST'])
@login_required
def end_session(session_id):
    """
    End an active evidence session.
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, user_id, alert_id FROM evidence_sessions WHERE id = ?;', (session_id,))
    sess = cursor.fetchone()
    if not sess:
        conn.close()
        return jsonify({"ok": False, "error": "Evidence session not found"}), 404

    if str(sess['user_id']) != user_id:
        conn.close()
        return jsonify({"ok": False, "error": "Forbidden"}), 403

    cursor.execute("UPDATE evidence_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?;", (session_id,))
    cursor.execute("SELECT COUNT(*) AS cnt FROM evidence_chunks WHERE session_id = ?;", (session_id,))
    c_row = cursor.fetchone()
    chunk_count = c_row['cnt'] if c_row else 0

    alert_id_val = None
    if sess['alert_id'] and str(sess['alert_id']).strip().isdigit():
        alert_id_val = int(sess['alert_id'])

    log_event(
        user_id=int(user_id),
        type='evidence_session_ended',
        actor='user',
        detail={'session_id': session_id, 'count': chunk_count},
        alert_id=alert_id_val,
        cursor=cursor
    )
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "message": "Evidence session ended successfully",
        "sessionId": session_id,
        "chunkCount": chunk_count
    }), 200


# ─── 5. List Evidence Sessions for Authenticated Owner ─────────
@evidence_bp.route('/api/evidence/sessions', methods=['GET'])
@login_required
def list_sessions():
    """
    List all evidence sessions belonging to the authenticated user.
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT s.id, s.user_id, s.alert_id, s.kind, s.started_at, s.ended_at,
               COUNT(c.id) AS chunk_count,
               COALESCE(SUM(c.size), 0) AS total_size
        FROM evidence_sessions s
        LEFT JOIN evidence_chunks c ON s.id = c.session_id
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY s.started_at DESC;
    ''', (user_id,))
    rows = cursor.fetchall()
    conn.close()

    sessions = []
    for r in rows:
        sessions.append({
            "id": r['id'],
            "userId": r['user_id'],
            "alertId": r['alert_id'],
            "kind": r['kind'],
            "startedAt": r['started_at'],
            "endedAt": r['ended_at'],
            "chunkCount": r['chunk_count'],
            "totalSize": r['total_size']
        })

    return jsonify({"ok": True, "sessions": sessions}), 200


# ─── 6. Verify Evidence Session Hash Chain ─────────────────────
@evidence_bp.route('/api/evidence/sessions/<session_id>/verify', methods=['GET'])
@login_required
def verify_session_chain(session_id):
    """
    Re-checks the whole cryptographic hash chain and files on disk.
    Returns valid=True or the first broken index.
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, user_id FROM evidence_sessions WHERE id = ?;', (session_id,))
    session = cursor.fetchone()
    if not session:
        conn.close()
        return jsonify({"ok": False, "error": "Evidence session not found"}), 404

    if str(session['user_id']) != user_id:
        conn.close()
        return jsonify({"ok": False, "error": "Forbidden: You do not own this evidence session"}), 403

    cursor.execute('''
        SELECT idx, mime, size, sha256, prev_hash, chain_hash, file_path
        FROM evidence_chunks
        WHERE session_id = ?
        ORDER BY idx ASC;
    ''', (session_id,))
    chunks = cursor.fetchall()
    conn.close()

    if not chunks:
        return jsonify({
            "ok": True,
            "verified": True,
            "sessionId": session_id,
            "chunksCount": 0,
            "message": "Empty session: no chunks to verify"
        }), 200

    expected_prev = '0' * 64

    for i, c in enumerate(chunks):
        chunk_idx = c['idx']
        c_prev = c['prev_hash']
        c_sha = c['sha256']
        c_chain = c['chain_hash']
        fpath = c['file_path']

        # Check sequential index
        if chunk_idx != i:
            return jsonify({
                "ok": True,
                "verified": False,
                "brokenIndex": chunk_idx,
                "error": f"Non-sequential index at position {i}: chunk idx is {chunk_idx}"
            }), 200

        # Check prev_hash
        if c_prev.lower() != expected_prev.lower():
            return jsonify({
                "ok": True,
                "verified": False,
                "brokenIndex": chunk_idx,
                "error": f"Hash chain broken at chunk {chunk_idx}: prev_hash mismatch"
            }), 200

        # Check on-disk file existence and integrity
        if not os.path.exists(fpath):
            return jsonify({
                "ok": True,
                "verified": False,
                "brokenIndex": chunk_idx,
                "error": f"Missing chunk file on disk at chunk {chunk_idx}"
            }), 200

        try:
            with open(fpath, 'rb') as f:
                disk_bytes = f.read()
            computed_sha = hashlib.sha256(disk_bytes).hexdigest()
            if computed_sha.lower() != c_sha.lower():
                return jsonify({
                    "ok": True,
                    "verified": False,
                    "brokenIndex": chunk_idx,
                    "error": f"File tampering detected at chunk {chunk_idx}: SHA-256 mismatch"
                }), 200
        except Exception as e:
            return jsonify({
                "ok": True,
                "verified": False,
                "brokenIndex": chunk_idx,
                "error": f"Cannot read chunk file at index {chunk_idx}: {str(e)}"
            }), 200

        # Check chain_hash computation: sha256(prev_hash + sha256)
        expected_chain = hashlib.sha256((expected_prev + c_sha).encode('utf-8')).hexdigest()
        if c_chain.lower() != expected_chain.lower():
            return jsonify({
                "ok": True,
                "verified": False,
                "brokenIndex": chunk_idx,
                "error": f"Hash computation mismatch at chunk {chunk_idx}"
            }), 200

        expected_prev = c_chain

    return jsonify({
        "ok": True,
        "verified": True,
        "sessionId": session_id,
        "chunksCount": len(chunks),
        "finalChainHash": expected_prev
    }), 200


# ─── 7. Download / Retrieve Evidence Chunk File ───────────────
@evidence_bp.route('/api/evidence/chunks/<chunk_id>', methods=['GET'])
@login_required
def get_chunk_file(chunk_id):
    """
    Returns the raw encrypted evidence chunk file.
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT c.id, c.session_id, c.idx, c.mime, c.file_path, s.user_id
        FROM evidence_chunks c
        JOIN evidence_sessions s ON c.session_id = s.id
        WHERE c.id = ?;
    ''', (chunk_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return jsonify({"ok": False, "error": "Evidence chunk not found"}), 404

    if str(row['user_id']) != user_id:
        return jsonify({"ok": False, "error": "Forbidden: You do not own this evidence chunk"}), 403

    file_path = row['file_path']
    if not os.path.exists(file_path):
        return jsonify({"ok": False, "error": "Chunk file missing on server disk"}), 404

    mime = row['mime'] or 'application/octet-stream'
    return send_file(file_path, mimetype=mime, as_attachment=False)


# ─── 8. Delete Evidence Session (Needs PIN) ───────────────────
@evidence_bp.route('/api/evidence/sessions/<session_id>', methods=['DELETE'])
@login_required
def delete_evidence_session(session_id):
    """
    Delete evidence session and on-disk files.
    Requires user's Safety PIN for confirmation.
    Login required, owner only.
    """
    user_id = str(g.current_user['id'])
    data = request.get_json(silent=True) or {}
    pin = str(data.get('pin') or request.args.get('pin') or '').strip()

    if not pin:
        return jsonify({"ok": False, "error": "Safety PIN is required to delete evidence session"}), 400

    # Verify PIN against authenticated user
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT pin_hash FROM users WHERE id = ?;', (user_id,))
    user_row = cursor.fetchone()

    if not user_row or not user_row['pin_hash']:
        conn.close()
        return jsonify({"ok": False, "error": "No safety PIN configured for this account"}), 400

    if not check_password_hash(user_row['pin_hash'], pin):
        conn.close()
        return jsonify({"ok": False, "error": "Incorrect safety PIN"}), 401

    # Check session ownership
    cursor.execute('SELECT id, user_id FROM evidence_sessions WHERE id = ?;', (session_id,))
    session = cursor.fetchone()
    if not session:
        conn.close()
        return jsonify({"ok": False, "error": "Evidence session not found"}), 404

    if str(session['user_id']) != user_id:
        conn.close()
        return jsonify({"ok": False, "error": "Forbidden: You do not own this evidence session"}), 403

    # Delete on-disk files under backend/evidence/<user_id>/<session_id>/
    evidence_base = get_evidence_base_dir()
    session_dir = os.path.join(evidence_base, str(user_id), str(session_id))
    if os.path.exists(session_dir):
        shutil.rmtree(session_dir, ignore_errors=True)

    # Delete database records
    cursor.execute('DELETE FROM evidence_chunks WHERE session_id = ?;', (session_id,))
    cursor.execute('DELETE FROM evidence_sessions WHERE id = ?;', (session_id,))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "message": "Evidence session and files deleted successfully",
        "sessionId": session_id
    }), 200
