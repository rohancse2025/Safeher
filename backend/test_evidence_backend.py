# backend/test_evidence_backend.py – Complete Test Suite for Evidence Backend
import os
import io
import time
import shutil
import hashlib
import requests
from datetime import datetime, timedelta
import sqlite3

BASE_URL = "http://127.0.0.1:5000"

def run_tests():
    print("=" * 60)
    print("   SafeHer Evidence Backend Automated Test Suite")
    print("=" * 60)

    # 1. Setup two test users for ownership testing
    timestamp = int(time.time() * 1000)
    user_a_phone = f"98{timestamp % 100000000:08d}"
    user_b_phone = f"99{timestamp % 100000000:08d}"
    pin = "4321"

    # Register & Login User A
    requests.post(f"{BASE_URL}/api/register", json={
        "name": "User Alpha", "phone": user_a_phone, "password": "Password123!"
    })
    res_a = requests.post(f"{BASE_URL}/api/login", json={
        "phone": user_a_phone, "password": "Password123!"
    }).json()
    token_a = res_a["data"]["token"]
    user_a_id = str(res_a["data"]["user"]["id"])
    headers_a = {"Authorization": f"Bearer {token_a}"}

    # Set PIN for User A
    requests.post(f"{BASE_URL}/api/pin/set", headers=headers_a, json={"pin": pin})

    # Register & Login User B
    requests.post(f"{BASE_URL}/api/register", json={
        "name": "User Beta", "phone": user_b_phone, "password": "Password123!"
    })
    res_b = requests.post(f"{BASE_URL}/api/login", json={
        "phone": user_b_phone, "password": "Password123!"
    }).json()
    token_b = res_b["data"]["token"]
    user_b_id = str(res_b["data"]["user"]["id"])
    headers_b = {"Authorization": f"Bearer {token_b}"}

    # 2. Test Login Required (401 without auth)
    r = requests.get(f"{BASE_URL}/api/evidence/key")
    assert r.status_code == 401, f"Expected 401 without token, got {r.status_code}"
    r = requests.post(f"{BASE_URL}/api/evidence/sessions", json={})
    assert r.status_code == 401, f"Expected 401 without token, got {r.status_code}"
    print("[PASS] Routes Require Login (401 unauthorized)")

    # 3. Test POST & GET /api/evidence/key
    dummy_pub = {"kty": "RSA", "n": "alpha-public-modulus", "e": "AQAB"}
    r = requests.post(f"{BASE_URL}/api/evidence/key", headers=headers_a, json={
        "publicKey": dummy_pub,
        "wrappedPrivateKey": "encrypted-base64-privkey",
        "salt": "random-salt-16bytes"
    })
    assert r.status_code == 200, f"Failed to save key: {r.text}"

    r = requests.get(f"{BASE_URL}/api/evidence/key", headers=headers_a)
    assert r.status_code == 200, f"Failed to get key: {r.text}"
    key_data = r.json()
    assert key_data["publicKey"]["n"] == "alpha-public-modulus"
    assert key_data["wrappedPrivateKey"] == "encrypted-base64-privkey"
    assert key_data["salt"] == "random-salt-16bytes"
    print("[PASS] POST & GET /api/evidence/key (Public & Wrapped Private Key)")

    # User B should not see User A's key
    r = requests.get(f"{BASE_URL}/api/evidence/key", headers=headers_b)
    assert r.status_code == 404, "User B should not have a key yet"
    print("[PASS] Key Access Isolation (Owner only)")

    # 4. Test POST & GET /api/evidence/sessions
    sess_id = f"sess_{int(time.time()*1000)}_test"
    r = requests.post(f"{BASE_URL}/api/evidence/sessions", headers=headers_a, json={
        "id": sess_id,
        "alertId": "alert_999",
        "kind": "video"
    })
    assert r.status_code == 201, f"Failed to create session: {r.text}"

    r = requests.get(f"{BASE_URL}/api/evidence/sessions", headers=headers_a)
    assert r.status_code == 200
    sessions = r.json()["sessions"]
    assert any(s["id"] == sess_id for s in sessions), "Created session not found in list"

    # User B lists sessions -> should be empty
    r = requests.get(f"{BASE_URL}/api/evidence/sessions", headers=headers_b)
    assert len(r.json()["sessions"]) == 0, "User B should see 0 sessions"
    print("[PASS] POST & GET /api/evidence/sessions (Owner isolated)")

    # User B tries to upload chunk to User A's session -> 403 Forbidden
    r = requests.post(f"{BASE_URL}/api/evidence/sessions/{sess_id}/chunks", headers=headers_b, files={
        "file": ("chunk_0.bin", b"test data")
    }, data={"idx": 0})
    assert r.status_code == 403, f"Expected 403 for non-owner upload, got {r.status_code}"
    print("[PASS] Non-Owner Chunk Upload Blocked (403 Forbidden)")

    # 5. Chunk Size Limit (> 3 MB rejected with 413)
    oversized_data = b"X" * (3 * 1024 * 1024 + 1024)
    r = requests.post(f"{BASE_URL}/api/evidence/sessions/{sess_id}/chunks", headers=headers_a, files={
        "file": ("oversized.bin", oversized_data)
    }, data={"idx": 0})
    assert r.status_code in (413, 400), f"Expected 413 for oversized chunk, got {r.status_code}"
    print("[PASS] Chunk Size Limit Enforcement (>3MB rejected with 413)")

    # 6. Sequential idx Enforcement (cannot upload idx=1 before idx=0)
    fake_chunk_1 = b"second chunk data"
    sha_1 = hashlib.sha256(fake_chunk_1).hexdigest()
    r = requests.post(f"{BASE_URL}/api/evidence/sessions/{sess_id}/chunks", headers=headers_a, files={
        "file": ("chunk_1.bin", fake_chunk_1)
    }, data={"idx": 1, "sha256": sha_1})
    assert r.status_code == 400, f"Expected 400 for non-sequential first chunk, got {r.status_code}"
    print("[PASS] Non-sequential first chunk (idx=1) rejected")

    # 7. Upload chunk 0: SHA-256 mismatch rejection
    fake_chunk_0 = b"first chunk binary data payload"
    wrong_sha = "0" * 64
    r = requests.post(f"{BASE_URL}/api/evidence/sessions/{sess_id}/chunks", headers=headers_a, files={
        "file": ("chunk_0.bin", fake_chunk_0)
    }, data={"idx": 0, "sha256": wrong_sha})
    assert r.status_code == 400, f"Expected 400 for SHA mismatch, got {r.status_code}"
    print("[PASS] Corrupted chunk / SHA-256 mismatch rejected")

    # 8. Upload valid chunk 0
    correct_sha_0 = hashlib.sha256(fake_chunk_0).hexdigest()
    r = requests.post(f"{BASE_URL}/api/evidence/sessions/{sess_id}/chunks", headers=headers_a, files={
        "file": ("chunk_0.bin", fake_chunk_0)
    }, data={
        "idx": 0,
        "sha256": correct_sha_0,
        "prev_hash": "0" * 64,
        "encrypted_key": "enc_key_0",
        "iv": "iv_0"
    })
    assert r.status_code == 201, f"Failed to upload chunk 0: {r.text}"
    chunk_0_data = r.json()["chunk"]
    chain_0 = chunk_0_data["chainHash"]
    chunk_0_id = chunk_0_data["id"]
    file_path_0 = chunk_0_data["filePath"]
    assert os.path.exists(file_path_0), f"File was not saved to disk at {file_path_0}"
    print("[PASS] Valid Chunk 0 Uploaded and Saved to backend/evidence/<user_id>/<session_id>/")

    # 9. Upload valid chunk 1 (sequential)
    fake_chunk_1 = b"second chunk binary data payload"
    correct_sha_1 = hashlib.sha256(fake_chunk_1).hexdigest()
    r = requests.post(f"{BASE_URL}/api/evidence/sessions/{sess_id}/chunks", headers=headers_a, files={
        "file": ("chunk_1.bin", fake_chunk_1)
    }, data={
        "idx": 1,
        "sha256": correct_sha_1,
        "prev_hash": chain_0,
        "encrypted_key": "enc_key_1",
        "iv": "iv_1"
    })
    assert r.status_code == 201, f"Failed to upload chunk 1: {r.text}"
    chunk_1_data = r.json()["chunk"]
    chain_1 = chunk_1_data["chainHash"]
    print("[PASS] Sequential Chunk 1 Uploaded with Cryptographic Chaining")

    # 10. Verify Hash Chain (/verify)
    r = requests.get(f"{BASE_URL}/api/evidence/sessions/{sess_id}/verify", headers=headers_a)
    assert r.status_code == 200
    v_data = r.json()
    assert v_data["verified"] is True
    assert v_data["chunksCount"] == 2
    print("[PASS] Cryptographic Hash Chain Verification Passed (/api/evidence/sessions/<id>/verify)")

    # Non-owner verify -> 403
    r = requests.get(f"{BASE_URL}/api/evidence/sessions/{sess_id}/verify", headers=headers_b)
    assert r.status_code == 403
    print("[PASS] Non-Owner Session Verification Blocked (403 Forbidden)")

    # 11. Tamper Detection Test
    # Manually tamper with file on disk
    with open(file_path_0, "wb") as f:
        f.write(b"tampered evil file contents")
    r = requests.get(f"{BASE_URL}/api/evidence/sessions/{sess_id}/verify", headers=headers_a)
    assert r.status_code == 200
    v_tampered = r.json()
    assert v_tampered["verified"] is False
    assert v_tampered["brokenIndex"] == 0
    print("[PASS] Tampered File Detected by /verify (brokenIndex=0)")

    # Restore chunk 0
    with open(file_path_0, "wb") as f:
        f.write(fake_chunk_0)

    # 12. GET /api/evidence/chunks/<id> (Download File)
    r = requests.get(f"{BASE_URL}/api/evidence/chunks/{chunk_0_id}", headers=headers_a)
    assert r.status_code == 200
    assert r.content == fake_chunk_0, "Returned file bytes did not match chunk 0"
    print("[PASS] GET /api/evidence/chunks/<id> returns exact file bytes")

    # Non-owner download -> 403
    r = requests.get(f"{BASE_URL}/api/evidence/chunks/{chunk_0_id}", headers=headers_b)
    assert r.status_code == 403
    print("[PASS] Non-Owner Chunk Download Blocked (403 Forbidden)")

    # 13. DELETE /api/evidence/sessions/<id> (Requires PIN)
    # Missing PIN -> 400
    r = requests.delete(f"{BASE_URL}/api/evidence/sessions/{sess_id}", headers=headers_a, json={})
    assert r.status_code == 400, "Missing PIN should be 400"
    # Wrong PIN -> 401
    r = requests.delete(f"{BASE_URL}/api/evidence/sessions/{sess_id}", headers=headers_a, json={"pin": "0000"})
    assert r.status_code == 401, "Wrong PIN should be 401"
    print("[PASS] Delete Session Protected by PIN (Requires 4-digit Safety PIN)")

    # Correct PIN -> 200 and deletes from DB & files
    r = requests.delete(f"{BASE_URL}/api/evidence/sessions/{sess_id}", headers=headers_a, json={"pin": pin})
    assert r.status_code == 200, f"Failed to delete session: {r.text}"
    assert not os.path.exists(file_path_0), "Chunk 0 file still exists on disk after deletion"
    r = requests.get(f"{BASE_URL}/api/evidence/sessions/{sess_id}/verify", headers=headers_a)
    assert r.status_code == 404, "Deleted session still found"
    print("[PASS] DELETE Session with Correct PIN Successfully Removes DB records and on-disk files")

    # 14. Scheduler 30-Day Expiration Test
    from scheduler import cleanup_old_evidence_sessions
    db_path = os.path.join(os.path.dirname(__file__), "safeher.db")
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    old_sess_id = f"old_sess_{int(time.time()*1000)}"
    old_date = (datetime.utcnow() - timedelta(days=35)).strftime("%Y-%m-%d %H:%M:%S")
    cur.execute("INSERT INTO evidence_sessions (id, user_id, alert_id, kind, started_at) VALUES (?, ?, ?, ?, ?);",
                (old_sess_id, user_a_id, "alert_old", "audio", old_date))

    old_evidence_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "evidence", user_a_id, old_sess_id))
    os.makedirs(old_evidence_dir, exist_ok=True)
    old_file_path = os.path.join(old_evidence_dir, "chunk_0.bin")
    with open(old_file_path, "wb") as f:
        f.write(b"expired chunk data")

    cur.execute('''
        INSERT INTO evidence_chunks (id, session_id, idx, mime, size, sha256, prev_hash, chain_hash, file_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    ''', (f"{old_sess_id}_0", old_sess_id, 0, "audio/webm", 18, "fake_sha", "0"*64, "fake_chain", old_file_path))
    conn.commit()
    conn.close()

    purged = cleanup_old_evidence_sessions()
    assert purged >= 1, "Scheduler failed to purge expired session"
    assert not os.path.exists(old_file_path), "Expired chunk file still on disk after scheduler cleanup"
    print("[PASS] Scheduler Cleanup Purges Sessions and Files Older Than 30 Days")

    print("=" * 60)
    print("   ALL EVIDENCE BACKEND TESTS PASSED SUCCESSFULLY! ")
    print("=" * 60)

if __name__ == "__main__":
    run_tests()
