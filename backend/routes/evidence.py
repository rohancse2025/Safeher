# backend/routes/evidence.py – Evidence Vault Public Keys, Chunk Upload & Hash Chain Verification
import hashlib
import json
from flask import Blueprint, request, jsonify, g
from db import get_db
from routes.alerts import get_user_from_request

evidence_bp = Blueprint('evidence', __name__)

@evidence_bp.route('/api/evidence/key', methods=['POST'])
def register_key():
    data = request.get_json(silent=True) or {}
    public_key = data.get('publicKey')
    if not public_key:
        return jsonify({"ok": False, "error": "publicKey is required"}), 400

    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = str(user['id']) if user else (data.get('userId') or 'guest')

    pk_str = json.dumps(public_key) if isinstance(public_key, dict) else str(public_key)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO evidence_keys (user_id, public_key)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET public_key = excluded.public_key, created_at = CURRENT_TIMESTAMP;
    ''', (user_id, pk_str))
    conn.commit()
    conn.close()

    return jsonify({"ok": True, "message": "Public key registered successfully", "userId": user_id}), 200


@evidence_bp.route('/api/evidence/key', methods=['GET'])
def get_key():
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = str(user['id']) if user else (request.args.get('user_id') or 'guest')

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT public_key, created_at FROM evidence_keys WHERE user_id = ?;', (user_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return jsonify({"ok": False, "error": "Public key not found"}), 404

    pk_data = row['public_key']
    try:
        pk_obj = json.loads(pk_data)
    except Exception:
        pk_obj = pk_data

    return jsonify({"ok": True, "publicKey": pk_obj, "userId": user_id, "createdAt": row['created_at']}), 200


@evidence_bp.route('/api/evidence/chunk', methods=['POST'])
def upload_chunk():
    data = request.get_json(silent=True) or {}
    session_id = data.get('sessionId')
    chunk_index = data.get('index')
    if session_id is None or chunk_index is None:
        return jsonify({"ok": False, "error": "sessionId and index are required"}), 400

    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = str(user['id']) if user else (data.get('userId') or 'guest')

    mime = data.get('mime') or ''
    size = data.get('size') or 0
    encrypted_data = data.get('encryptedData') or ''
    encrypted_key = data.get('encryptedKey') or ''
    iv = data.get('iv') or ''
    sha256 = data.get('sha256') or ''
    prev_hash = data.get('prevHash') or ('0' * 64)
    chain_hash = data.get('chainHash') or ''
    alert_id = str(data.get('alertId') or '')

    # Cryptographic integrity check: chainHash must equal sha256(prevHash + sha256)
    expected_chain = hashlib.sha256((prev_hash + sha256).encode('utf-8')).hexdigest()
    if chain_hash and chain_hash.lower() != expected_chain.lower():
        return jsonify({"ok": False, "error": "Hash chain validation failed: corrupted chunk", "expected": expected_chain}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO evidence_chunks (
            session_id, chunk_index, user_id, alert_id, mime, size,
            encrypted_data, encrypted_key, iv, sha256, prev_hash, chain_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, chunk_index) DO UPDATE SET
            encrypted_data = excluded.encrypted_data,
            encrypted_key = excluded.encrypted_key,
            iv = excluded.iv,
            sha256 = excluded.sha256,
            chain_hash = excluded.chain_hash;
    ''', (
        session_id, chunk_index, user_id, alert_id, mime, size,
        encrypted_data, encrypted_key, iv, sha256, prev_hash, chain_hash or expected_chain
    ))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "sessionId": session_id,
        "index": chunk_index,
        "chainHash": chain_hash or expected_chain
    }), 201


@evidence_bp.route('/api/evidence/verify/<session_id>', methods=['GET'])
def verify_session(session_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT chunk_index, sha256, prev_hash, chain_hash, size, created_at
        FROM evidence_chunks
        WHERE session_id = ?
        ORDER BY chunk_index ASC;
    ''', (session_id,))
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return jsonify({"ok": False, "error": "Session not found", "verified": False}), 404

    expected_prev = '0' * 64
    for r in rows:
        idx = r['chunk_index']
        prev_h = r['prev_hash']
        cur_sha = r['sha256']
        cur_chain = r['chain_hash']

        if prev_h.lower() != expected_prev.lower():
            return jsonify({
                "ok": True,
                "verified": False,
                "error": f"Chain broken at chunk {idx}: prev_hash mismatch",
                "brokenIndex": idx
            }), 200

        computed_chain = hashlib.sha256((prev_h + cur_sha).encode('utf-8')).hexdigest()
        if cur_chain.lower() != computed_chain.lower():
            return jsonify({
                "ok": True,
                "verified": False,
                "error": f"Chain broken at chunk {idx}: hash computation mismatch",
                "brokenIndex": idx
            }), 200

        expected_prev = cur_chain

    return jsonify({
        "ok": True,
        "verified": True,
        "sessionId": session_id,
        "chunksCount": len(rows),
        "finalChainHash": expected_prev
    }), 200


@evidence_bp.route('/api/evidence/session/<session_id>', methods=['DELETE'])
def delete_session(session_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM evidence_chunks WHERE session_id = ?;', (session_id,))
    deleted_count = cursor.rowcount
    conn.commit()
    conn.close()

    return jsonify({"ok": True, "sessionId": session_id, "deletedChunks": deleted_count}), 200
