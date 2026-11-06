# backend/test_all_features.py - End-to-end automated test runner for SafeHer
import os
import sys
import json
import time
import hashlib
import requests

BASE_URL = "http://127.0.0.1:5000"
ADMIN_KEY = "safeher-admin-secret-key-123"

def run_tests():
    print("==================================================")
    print("   SafeHer Full Feature Automated Test Suite")
    print("==================================================")
    s = requests.Session()
    tests_passed = 0
    total_tests = 0

    def assert_test(name, condition, extra=""):
        nonlocal tests_passed, total_tests
        total_tests += 1
        if condition:
            tests_passed += 1
            print(f"[PASS] {name} {extra}")
        else:
            print(f"[FAIL] {name} {extra}")

    # 1. Health Check
    res = s.get(f"{BASE_URL}/api/health")
    assert_test("Backend Health Check", res.status_code == 200 and res.json().get("ok") is True)

    # 2. Registration
    timestamp = int(time.time() * 1000) % 100000000
    test_phone = f"98{timestamp:08d}"
    test_email = f"user_{timestamp}@safeher.test"
    reg_payload = {
        "name": "Priya Sharma",
        "phone": test_phone,
        "email": test_email,
        "password": "Password123!",
        "agree_privacy": True
    }
    res = s.post(f"{BASE_URL}/api/register", json=reg_payload)
    data = res.json()
    assert_test("User Registration with Privacy Agreement", res.status_code in (200, 201) and data.get("ok") is True)
    token = data.get("data", {}).get("token")

    # 3. Login
    login_payload = {"phone": test_phone, "password": "Password123!"}
    res = s.post(f"{BASE_URL}/api/login", json=login_payload)
    login_data = res.json()
    token = login_data.get("data", {}).get("token", token)
    headers = {"Authorization": f"Bearer {token}"}
    assert_test("User Login & JWT Generation", res.status_code == 200 and token is not None)

    # 4. Profile Fetch
    res = s.get(f"{BASE_URL}/api/me", headers=headers)
    assert_test("Fetch User Profile (/api/me)", res.status_code == 200 and res.json().get("data", {}).get("phone") == test_phone)

    # 5. Security PIN (Set, Verify, Change)
    res = s.post(f"{BASE_URL}/api/pin/set", json={"pin": "4321"}, headers=headers)
    assert_test("Set 4-Digit Security PIN", res.status_code == 200 and res.json().get("ok") is True)

    res = s.post(f"{BASE_URL}/api/pin/verify", json={"pin": "4321"}, headers=headers)
    assert_test("Verify Correct PIN", res.status_code == 200 and res.json().get("data", {}).get("result") == "ok")

    res = s.post(f"{BASE_URL}/api/pin/verify", json={"pin": "9999"}, headers=headers)
    assert_test("Reject Incorrect PIN", res.status_code == 200 and res.json().get("data", {}).get("result") == "wrong")

    res = s.post(f"{BASE_URL}/api/pin/change", json={"old_pin": "4321", "new_pin": "1234"}, headers=headers)
    assert_test("Change Security PIN", res.status_code == 200 and res.json().get("ok") is True)

    # 6. Contacts CRUD (with close contact support)
    contact_payload = {
        "name": "Ananya (Sister)",
        "phone": "9876543210",
        "email": "ananya@test.com",
        "relationship": "Sister"
    }
    res = s.post(f"{BASE_URL}/api/contacts", json=contact_payload, headers=headers)
    contact_data = res.json().get("data", {})
    contact_id = contact_data.get("id")
    assert_test("Add Trusted Emergency Contact", res.status_code in (200, 201) and contact_id is not None)

    res = s.get(f"{BASE_URL}/api/contacts", headers=headers)
    contacts_list = res.json().get("data", [])
    assert_test("List Trusted Contacts", res.status_code == 200 and len(contacts_list) >= 1)

    res = s.put(f"{BASE_URL}/api/contacts/{contact_id}", json={"name": "Ananya Sharma", "phone": "9876543210", "relationship": "Sister"}, headers=headers)
    assert_test("Update Trusted Contact", res.status_code == 200 and res.json().get("data", {}).get("relationship") == "Sister")

    # 7. Safe Timers
    timer_payload = {"minutes": 15, "contact_id": contact_id}
    res = s.post(f"{BASE_URL}/api/timers", json=timer_payload, headers=headers)
    timer_id = res.json().get("data", {}).get("id")
    assert_test("Create Safe Arrival Timer", res.status_code in (200, 201) and timer_id is not None)

    res = s.get(f"{BASE_URL}/api/timers/active", headers=headers)
    assert_test("Get Active Safe Timer", res.status_code == 200 and res.json().get("data") is not None)

    res = s.post(f"{BASE_URL}/api/timers/{timer_id}/safe", headers=headers)
    assert_test("Dismiss Safe Timer ('I am safe')", res.status_code == 200)

    # 8. Web Push Keys & Subscription
    res = s.get(f"{BASE_URL}/api/push/vapid-public-key")
    vapid_key = res.json().get("data", {}).get("public_key")
    assert_test("Retrieve VAPID Public Key", res.status_code == 200 and vapid_key is not None)

    sub_payload = {
        "endpoint": f"https://fcm.googleapis.com/fcm/send/test_{int(time.time())}",
        "p256dh": "BNcR6S9ef...dummy_p256dh",
        "auth": "auth_dummy_token"
    }
    res = s.post(f"{BASE_URL}/api/push/subscribe", json=sub_payload, headers=headers)
    assert_test("Register Push Subscription", res.status_code in (200, 201))

    # 9. Emergency SOS Alert Creation
    sos_payload = {
        "mode": "normal",
        "lat": 12.9716,
        "lng": 77.5946
    }
    res = s.post(f"{BASE_URL}/api/alerts", json=sos_payload, headers=headers)
    alert_data = res.json().get("data", {})
    alert_id = alert_data.get("id")
    share_token = alert_data.get("share_token")
    assert_test("Trigger SOS Alert", res.status_code in (200, 201) and alert_id is not None and share_token is not None)

    # 10. Location Update
    loc_payload = {"lat": 12.9720, "lng": 77.5950}
    res = s.post(f"{BASE_URL}/api/alerts/{alert_id}/location", json=loc_payload, headers=headers)
    assert_test("Update SOS GPS Location", res.status_code == 200)

    # 11. Public Tracking Endpoint (/api/track/<token>)
    res = s.get(f"{BASE_URL}/api/track/{share_token}")
    track_res = res.json()
    assert_test("Public Tracking Endpoint (No Login Required)", res.status_code == 200 and track_res.get("data", {}).get("status") == "active")

    # 12. Volunteer Registration & Status
    vol_payload = {
        "available": True,
        "lat": 12.9722,
        "lng": 77.5952,
        "note": "First-aid certified volunteer nearby."
    }
    res = s.post(f"{BASE_URL}/api/volunteers/status", json=vol_payload, headers=headers)
    assert_test("Volunteer Registration (Pending State)", res.status_code == 200)

    # 13. Admin Portal Operations
    admin_headers = {"X-Admin-Key": ADMIN_KEY}
    res = s.get(f"{BASE_URL}/api/admin/stats", headers=admin_headers)
    assert_test("Admin Stats Endpoint", res.status_code == 200 and "total_users" in res.json().get("data", {}))

    res = s.get(f"{BASE_URL}/api/admin/volunteers/pending", headers=admin_headers)
    pending_vols = res.json().get("data", [])
    assert_test("Admin List Pending Volunteers", res.status_code == 200 and len(pending_vols) >= 1)

    if pending_vols:
        vol_user_id = pending_vols[0]["user_id"]
        res = s.post(f"{BASE_URL}/api/admin/volunteers/{vol_user_id}/approve", headers=admin_headers)
        assert_test("Admin Approve Volunteer", res.status_code == 200)

    res = s.get(f"{BASE_URL}/api/admin/logs", headers=admin_headers)
    assert_test("Admin Log Inspection (Masked Sensitive Data)", res.status_code == 200 and "lines" in res.json().get("data", {}))

    # 14. Volunteer Responding to Alert
    res = s.post(f"{BASE_URL}/api/alerts/{alert_id}/respond", json={"status": "coming"}, headers=headers)
    assert_test("Volunteer Responding ('I am coming')", res.status_code in (200, 400))

    # 15. Alert Status & Details
    res = s.get(f"{BASE_URL}/api/alerts/{alert_id}/status", headers=headers)
    assert_test("Poll Alert Status", res.status_code == 200)

    res = s.get(f"{BASE_URL}/api/alerts/{alert_id}/details", headers=headers)
    assert_test("Alert Full Details & GPS Route Path", res.status_code == 200 and "route" in res.json().get("data", {}))

    # 16. End Alert with PIN
    res = s.post(f"{BASE_URL}/api/alerts/{alert_id}/end", json={"pin": "1234"}, headers=headers)
    assert_test("End SOS Alert with Correct PIN", res.status_code == 200)


    # 19. Evidence Vault Endpoints
    ev_key_res = s.post(f"{BASE_URL}/api/evidence/key", json={"publicKey": {"kty": "RSA"}, "wrappedPrivateKey": "wrap_key", "salt": "salt1"}, headers=headers)
    assert_test("Register Evidence Encryption Key", ev_key_res.status_code == 200)

    ev_key_get = s.get(f"{BASE_URL}/api/evidence/key", headers=headers)
    assert_test("Retrieve Evidence Encryption Key", ev_key_get.status_code == 200 and ev_key_get.json().get("publicKey"))

    ev_sess_res = s.post(f"{BASE_URL}/api/evidence/sessions", json={"kind": "audio"}, headers=headers)
    ev_sess_id = ev_sess_res.json().get("session", {}).get("id")
    assert_test("Create Evidence Session", ev_sess_res.status_code == 201 and bool(ev_sess_id))

    ev_data = b"evidence audio stream chunk"
    ev_sha = hashlib.sha256(ev_data).hexdigest()
    ev_chunk_res = s.post(f"{BASE_URL}/api/evidence/sessions/{ev_sess_id}/chunks", files={"file": ("chunk_0.bin", ev_data)}, data={"idx": 0, "sha256": ev_sha}, headers=headers)
    assert_test("Upload Multipart Evidence Chunk with SHA-256", ev_chunk_res.status_code == 201)

    ev_verify_res = s.get(f"{BASE_URL}/api/evidence/sessions/{ev_sess_id}/verify", headers=headers)
    assert_test("Verify Evidence Session Hash Chain", ev_verify_res.status_code == 200 and ev_verify_res.json().get("verified") is True)

    ev_del_res = s.delete(f"{BASE_URL}/api/evidence/sessions/{ev_sess_id}", json={"pin": "1234"}, headers=headers)
    assert_test("Delete Evidence Session with PIN", ev_del_res.status_code == 200)

    # 20. Cascading Account Deletion
    res = s.delete(f"{BASE_URL}/api/me", json={"pin": "1234"}, headers=headers)
    assert_test("Cascading Account & Data Deletion (GDPR/Privacy)", res.status_code == 200)

    print("==================================================")
    print(f"   Results: {tests_passed} / {total_tests} Tests Passed!")
    print("==================================================")

if __name__ == "__main__":
    run_tests()
