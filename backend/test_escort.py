# backend/test_escort.py – Comprehensive Tests for Escort Mode Backend, Maths, Scheduler & Tracking
import os
import sys
import unittest
import json
import sqlite3
import datetime
import math
import jwt

# Ensure backend root is on sys.path
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app import app
from db import get_db, init_db
from routes.escorts import (
    haversine_m,
    point_to_segment_distance_m,
    point_to_route_distance_m,
    total_route_distance_m,
    check_active_escorts
)
from routes.auth import SECRET_KEY


class EscortModeTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = app.test_client()

    def setUp(self):
        self.conn = get_db()
        self.cursor = self.conn.cursor()

        # Clean test user
        self.cursor.execute("DELETE FROM escort_contacts WHERE escort_id IN (SELECT id FROM escorts WHERE user_id = 77777);")
        self.cursor.execute("DELETE FROM escorts WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM incident_events WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM alerts WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM contacts WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM users WHERE id = 77777;")

        # Create test user
        self.cursor.execute("""
            INSERT OR REPLACE INTO users (id, name, phone, email, password_hash)
            VALUES (77777, 'Ritu Sen', '7777777777', 'ritu@test.com', 'dummy_hash');
        """)

        # Create test contact
        self.cursor.execute("""
            INSERT OR REPLACE INTO contacts (id, user_id, name, phone, email, close)
            VALUES (8888, 77777, 'Sneha Roy', '8888888888', 'sneha@test.com', 1);
        """)
        self.conn.commit()

        # Generate auth token
        self.token = jwt.encode(
            {"user_id": 77777, "phone": "7777777777", "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=2)},
            SECRET_KEY,
            algorithm="HS256"
        )
        self.auth_headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}

    def tearDown(self):
        self.cursor.execute("DELETE FROM escort_contacts WHERE escort_id IN (SELECT id FROM escorts WHERE user_id = 77777);")
        self.cursor.execute("DELETE FROM escorts WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM incident_events WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM alerts WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM contacts WHERE user_id = 77777;")
        self.cursor.execute("DELETE FROM users WHERE id = 77777;")
        self.conn.commit()
        self.conn.close()

    def test_01_route_distance_and_projection_maths(self):
        """Verify local equirectangular point-to-segment projection and polyline distance calculations."""
        # Horizontal east-west segment at latitude 12.0
        # Point A: (12.0, 77.0), Point B: (12.0, 77.01)
        a_lat, a_lng = 12.0, 77.0
        b_lat, b_lng = 12.0, 77.01

        # Point directly on the midpoint
        mid_lat, mid_lng = 12.0, 77.005
        d_mid = point_to_segment_distance_m(mid_lat, mid_lng, a_lat, a_lng, b_lat, b_lng)
        self.assertAlmostEqual(d_mid, 0.0, delta=0.5)

        # Point 100 meters north of midpoint (1 deg latitude is approx 111,139 m -> 100m is ~0.0009 deg)
        north_lat = 12.0 + (100.0 / 111139.0)
        d_north = point_to_segment_distance_m(north_lat, mid_lng, a_lat, a_lng, b_lat, b_lng)
        self.assertAlmostEqual(d_north, 100.0, delta=1.0)

        # Multi-segment polyline
        route = [
            [12.9716, 77.5946],
            [12.9750, 77.5946],
            [12.9750, 77.6000]
        ]
        tot_dist = total_route_distance_m(route)
        self.assertGreater(tot_dist, 500.0)

        # Point close to the second segment
        d_route = point_to_route_distance_m(12.9750, 77.5970, route)
        self.assertAlmostEqual(d_route, 0.0, delta=1.0)

    def test_02_create_escort_and_email_notification(self):
        """Verify POST /api/escorts creates escort row, tokens in escort_contacts, and logs escort_started."""
        route = [
            [12.9716, 77.5946],
            [12.9750, 77.5980]
        ]
        payload = {
            "dest_name": "MG Road Metro",
            "dest_lat": 12.9750,
            "dest_lng": 77.5980,
            "route": route,
            "expected_minutes": 25,
            "checkin_interval": 10,
            "deviation_distance": 200,
            "contact_ids": [8888]
        }
        res = self.client.post('/api/escorts', headers=self.auth_headers, data=json.dumps(payload))
        self.assertEqual(res.status_code, 201)
        data = res.get_json()['data']

        escort_id = data['id']
        self.assertEqual(data['dest_name'], "MG Road Metro")
        self.assertTrue('8888' in data['tokens'] or 8888 in data['tokens'])

        # Verify DB row
        self.cursor.execute("SELECT * FROM escorts WHERE id = ?;", (escort_id,))
        row = self.cursor.fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row['status'], 'active')
        self.assertEqual(row['checkin_interval_min'], 10)
        self.assertEqual(row['deviation_m'], 200.0)

        # Verify token in escort_contacts
        self.cursor.execute("SELECT * FROM escort_contacts WHERE escort_id = ? AND contact_id = 8888;", (escort_id,))
        ec_row = self.cursor.fetchone()
        self.assertIsNotNone(ec_row)
        self.assertEqual(ec_row['token'], data['tokens'].get('8888') or data['tokens'].get(8888))

        # Verify escort_started logged in incident_events
        self.cursor.execute("SELECT * FROM incident_events WHERE escort_id = ? AND type = 'escort_started';", (escort_id,))
        ev = self.cursor.fetchone()
        self.assertIsNotNone(ev)
        self.assertEqual(ev['actor'], 'user')

    def test_03_position_updates_deviation_and_arrival(self):
        """Verify off-route detection and destination arrival detection."""
        # Create an escort
        route = [
            [12.9716, 77.5946],
            [12.9720, 77.5946],
            [12.9750, 77.5946]
        ]
        create_res = self.client.post('/api/escorts', headers=self.auth_headers, data=json.dumps({
            "dest_name": "MG Road",
            "dest_lat": 12.9750,
            "dest_lng": 77.5946,
            "route": route,
            "deviation_distance": 150
        }))
        escort_id = create_res.get_json()['data']['id']

        # 1. Position on-route
        p1 = self.client.post(f'/api/escorts/{escort_id}/position', headers=self.auth_headers, data=json.dumps({
            "lat": 12.9718, "lng": 77.5946
        }))
        self.assertEqual(p1.status_code, 200)
        self.assertFalse(p1.get_json()['data']['off_route'])

        # 2. Position deviated off-route (> 150 m away, e.g. 500 m East)
        deviated_lng = 77.5946 + (500.0 / (111139.0 * math.cos(math.radians(12.97))))
        p2 = self.client.post(f'/api/escorts/{escort_id}/position', headers=self.auth_headers, data=json.dumps({
            "lat": 12.9720, "lng": deviated_lng
        }))
        self.assertEqual(p2.status_code, 200)
        self.assertTrue(p2.get_json()['data']['off_route'])

        # Verify escort_off_route logged
        self.cursor.execute("SELECT * FROM incident_events WHERE escort_id = ? AND type = 'escort_off_route';", (escort_id,))
        self.assertIsNotNone(self.cursor.fetchone())

        # 3. Position returns on-route -> off_route cleared
        p3 = self.client.post(f'/api/escorts/{escort_id}/position', headers=self.auth_headers, data=json.dumps({
            "lat": 12.9730, "lng": 77.5946
        }))
        self.assertFalse(p3.get_json()['data']['off_route'])

        # 4. Position reaches within 100m of destination -> arrived
        p4 = self.client.post(f'/api/escorts/{escort_id}/position', headers=self.auth_headers, data=json.dumps({
            "lat": 12.97495, "lng": 77.5946
        }))
        self.assertTrue(p4.get_json()['data']['arrived'])
        self.assertEqual(p4.get_json()['data']['status'], 'arrived')

        # Verify escort_arrived logged
        self.cursor.execute("SELECT * FROM incident_events WHERE escort_id = ? AND type = 'escort_arrived';", (escort_id,))
        self.assertIsNotNone(self.cursor.fetchone())

    def test_04_checkin_pause_and_reroute(self):
        """Verify safety check-in, journey pause (max 2), and dynamic re-routing."""
        route = [[12.9716, 77.5946], [12.9800, 77.5946]]
        create_res = self.client.post('/api/escorts', headers=self.auth_headers, data=json.dumps({
            "dest_name": "Cubbon Park",
            "dest_lat": 12.9800,
            "dest_lng": 77.5946,
            "route": route,
            "checkin_interval": 15
        }))
        escort_id = create_res.get_json()['data']['id']

        # 1. Check-in
        res_chk = self.client.post(f'/api/escorts/{escort_id}/checkin', headers=self.auth_headers)
        self.assertEqual(res_chk.status_code, 200)
        self.assertIsNotNone(res_chk.get_json()['data']['last_checkin_at'])

        # 2. Pause 1
        res_p1 = self.client.post(f'/api/escorts/{escort_id}/pause', headers=self.auth_headers, data=json.dumps({"minutes": 10}))
        self.assertEqual(res_p1.status_code, 200)
        self.assertEqual(res_p1.get_json()['data']['pauses_used'], 1)

        # Pause 2
        res_p2 = self.client.post(f'/api/escorts/{escort_id}/pause', headers=self.auth_headers, data=json.dumps({"minutes": 15}))
        self.assertEqual(res_p2.status_code, 200)
        self.assertEqual(res_p2.get_json()['data']['pauses_used'], 2)

        # Pause 3 (should fail - max 2 allowed)
        res_p3 = self.client.post(f'/api/escorts/{escort_id}/pause', headers=self.auth_headers, data=json.dumps({"minutes": 5}))
        self.assertEqual(res_p3.status_code, 400)

        # 3. Reroute
        new_route = [[12.9716, 77.5946], [12.9750, 77.5900], [12.9800, 77.5946]]
        res_rr = self.client.post(f'/api/escorts/{escort_id}/reroute', headers=self.auth_headers, data=json.dumps({"route": new_route}))
        self.assertEqual(res_rr.status_code, 200)

        self.cursor.execute("SELECT * FROM incident_events WHERE escort_id = ? AND type = 'escort_rerouted';", (escort_id,))
        self.assertIsNotNone(self.cursor.fetchone())

    def test_05_manual_escalate_and_end(self):
        """Verify POST /api/escorts/<id>/escalate and POST /api/escorts/<id>/end."""
        create_res = self.client.post('/api/escorts', headers=self.auth_headers, data=json.dumps({
            "dest_name": "Indiranagar",
            "dest_lat": 12.9780,
            "dest_lng": 77.6400,
            "route": [[12.9716, 77.5946], [12.9780, 77.6400]]
        }))
        escort_id = create_res.get_json()['data']['id']

        # Escalate
        esc_res = self.client.post(f'/api/escorts/{escort_id}/escalate', headers=self.auth_headers)
        self.assertEqual(esc_res.status_code, 200)
        alert_id = esc_res.get_json()['data']['alert_id']
        self.assertIsNotNone(alert_id)

        # Verify escort status is alerted
        self.cursor.execute("SELECT status, alert_id FROM escorts WHERE id = ?;", (escort_id,))
        row = self.cursor.fetchone()
        self.assertEqual(row['status'], 'alerted')
        self.assertEqual(row['alert_id'], alert_id)

        # End escort
        end_res = self.client.post(f'/api/escorts/{escort_id}/end', headers=self.auth_headers, data=json.dumps({"arrived": False}))
        self.assertEqual(end_res.status_code, 200)
        self.assertEqual(end_res.get_json()['data']['status'], 'ended')

    def test_06_scheduler_rules_deviation_missed_checkin_no_signal_late(self):
        """Verify background scheduler conditions: route_deviation, missed_checkin, no_signal, late_arrival."""
        # 1. Condition (a): Route deviation > 2 min
        self.cursor.execute("""
            INSERT INTO escorts (
                user_id, dest_name, dest_lat, dest_lng, route_json, status,
                off_route_since, started_at, last_update_at
            ) VALUES (
                77777, 'Test Dest', 12.98, 77.60, '[[12.97,77.59],[12.98,77.60]]', 'active',
                datetime('now', '-3 minutes'), datetime('now', '-10 minutes'), datetime('now')
            );
        """)
        escort_a_id = self.cursor.lastrowid
        self.conn.commit()

        # Run scheduler check
        check_active_escorts()

        self.cursor.execute("SELECT status, alert_id FROM escorts WHERE id = ?;", (escort_a_id,))
        row_a = self.cursor.fetchone()
        self.assertEqual(row_a['status'], 'alerted')
        self.assertIsNotNone(row_a['alert_id'])

        # Verify alert created with reason 'route_deviation'
        self.cursor.execute("SELECT reason, mode FROM alerts WHERE id = ?;", (row_a['alert_id'],))
        alert_a = self.cursor.fetchone()
        self.assertEqual(alert_a['reason'], 'route_deviation')

        # 2. Condition (b): Missed check-in > 60s
        self.cursor.execute("""
            INSERT INTO escorts (
                user_id, dest_name, dest_lat, dest_lng, route_json, status,
                checkin_interval_min, next_checkin_due, started_at, last_update_at
            ) VALUES (
                77777, 'Checkin Dest', 12.98, 77.60, '[[12.97,77.59],[12.98,77.60]]', 'active',
                10, datetime('now', '-90 seconds'), datetime('now', '-15 minutes'), datetime('now')
            );
        """)
        escort_b_id = self.cursor.lastrowid
        self.conn.commit()

        check_active_escorts()

        self.cursor.execute("SELECT status, alert_id FROM escorts WHERE id = ?;", (escort_b_id,))
        row_b = self.cursor.fetchone()
        self.assertEqual(row_b['status'], 'alerted')
        self.cursor.execute("SELECT reason FROM alerts WHERE id = ?;", (row_b['alert_id'],))
        self.assertEqual(self.cursor.fetchone()['reason'], 'missed_checkin')

        # 3. Condition (c): No signal > 5 min creates uneasy alert
        self.cursor.execute("""
            INSERT INTO escorts (
                user_id, dest_name, dest_lat, dest_lng, route_json, status,
                started_at, last_update_at
            ) VALUES (
                77777, 'Signal Dest', 12.98, 77.60, '[[12.97,77.59],[12.98,77.60]]', 'active',
                datetime('now', '-20 minutes'), datetime('now', '-6 minutes')
            );
        """)
        escort_c_id = self.cursor.lastrowid
        self.conn.commit()

        check_active_escorts()

        self.cursor.execute("SELECT alert_id FROM escorts WHERE id = ?;", (escort_c_id,))
        aid_c = self.cursor.fetchone()['alert_id']
        self.assertIsNotNone(aid_c)
        self.cursor.execute("SELECT mode, reason FROM alerts WHERE id = ?;", (aid_c,))
        alert_c = self.cursor.fetchone()
        self.assertEqual(alert_c['mode'], 'uneasy')
        self.assertEqual(alert_c['reason'], 'no_signal')

        # Escalates to normal after 10 min
        self.cursor.execute("UPDATE escorts SET last_update_at = datetime('now', '-12 minutes') WHERE id = ?;", (escort_c_id,))
        self.conn.commit()
        check_active_escorts()

        self.cursor.execute("SELECT mode FROM alerts WHERE id = ?;", (aid_c,))
        self.assertEqual(self.cursor.fetchone()['mode'], 'normal')

        # 4. Condition (d): Late arrival > 10 min past expected_end
        self.cursor.execute("""
            INSERT INTO escorts (
                user_id, dest_name, dest_lat, dest_lng, route_json, status,
                started_at, expected_end, last_update_at
            ) VALUES (
                77777, 'Late Dest', 12.98, 77.60, '[[12.97,77.59],[12.98,77.60]]', 'active',
                datetime('now', '-45 minutes'), datetime('now', '-15 minutes'), datetime('now')
            );
        """)
        escort_d_id = self.cursor.lastrowid
        self.conn.commit()

        check_active_escorts()

        self.cursor.execute("SELECT alert_id FROM escorts WHERE id = ?;", (escort_d_id,))
        aid_d = self.cursor.fetchone()['alert_id']
        self.assertIsNotNone(aid_d)
        self.cursor.execute("SELECT reason FROM alerts WHERE id = ?;", (aid_d,))
        self.assertEqual(self.cursor.fetchone()['reason'], 'late_arrival')

    def test_07_public_tracking_escort_tokens_and_expiry(self):
        """Verify GET /api/track/<token> returns type 'escort' and enforces 1-hour expiration post-journey."""
        route = [[12.9716, 77.5946], [12.9800, 77.5946]]
        create_res = self.client.post('/api/escorts', headers=self.auth_headers, data=json.dumps({
            "dest_name": "MG Road Terminal",
            "dest_lat": 12.9800,
            "dest_lng": 77.5946,
            "route": route,
            "contact_ids": [8888]
        }))
        escort_id = create_res.get_json()['data']['id']
        token = create_res.get_json()['data']['tokens'].get('8888') or create_res.get_json()['data']['tokens'].get(8888)

        # 1. Fetch live tracking data via token
        track_res = self.client.get(f'/api/track/{token}')
        self.assertEqual(track_res.status_code, 200)
        track_data = track_res.get_json()['data']

        self.assertEqual(track_data['type'], 'escort')
        self.assertEqual(track_data['first_name'], 'Ritu')
        self.assertEqual(track_data['destination_name'], 'MG Road Terminal')
        self.assertIn('progress_percent', track_data)
        self.assertIn(track_data['status'], ["On route", "Off route", "Paused", "Check-in due", "Alerted", "Arrived"])
        self.assertTrue(track_data['is_contact'])
        self.assertEqual(track_data['contact_first_name'], 'Sneha')

        # 2. Test expiration 1 hour after arrival
        self.cursor.execute("""
            UPDATE escorts
            SET status = 'arrived',
                ended_at = datetime('now', '-2 hours')
            WHERE id = ?;
        """, (escort_id,))
        self.conn.commit()

        expired_res = self.client.get(f'/api/track/{token}')
        self.assertEqual(expired_res.status_code, 404)
        self.assertIn("expired", expired_res.get_json()['error'].lower())


if __name__ == '__main__':
    unittest.main()
