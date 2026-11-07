# backend/test_incident_events.py – Comprehensive Tests for Central Incident Event Log
import os
import sys
import unittest
import json
import sqlite3
import datetime
from dotenv import load_dotenv

# Ensure backend root is on sys.path
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

load_dotenv(os.path.join(backend_dir, '.env'))

from app import app
from db import get_db, init_db
from services.events import (
    log_event,
    sanitize_detail_dict,
    get_volunteer_alert_label,
    VALID_ALERT_REASONS,
    ALLOWED_ACTORS
)
from scheduler import cleanup_old_incident_events


class IncidentEventsTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = app.test_client()

    def setUp(self):
        self.conn = get_db()
        self.cursor = self.conn.cursor()
        # Clean test entries
        self.cursor.execute("DELETE FROM incident_events WHERE user_id IN (99999, 88881, 88882);")
        self.cursor.execute("DELETE FROM responses WHERE alert_id IN (SELECT id FROM alerts WHERE user_id = 99999);")
        self.cursor.execute("DELETE FROM alerts WHERE user_id = 99999;")
        self.cursor.execute("DELETE FROM volunteers WHERE id IN (101, 202);")
        self.cursor.execute("DELETE FROM users WHERE id IN (99999, 88881, 88882);")
        self.cursor.execute("DELETE FROM contacts WHERE user_id = 99999;")
        self.cursor.execute("DELETE FROM timers WHERE user_id = 99999;")
        self.cursor.execute("DELETE FROM evidence_sessions WHERE user_id = '99999';")

        # Create test user
        self.cursor.execute("""
            INSERT OR REPLACE INTO users (id, name, phone, email, password_hash, pin_hash, duress_pin_hash)
            VALUES (99999, 'Test Subject', '9999999999', 'tester99999@test.com', 'dummy_hash', '1234', '9999');
        """)
        self.conn.commit()

    def tearDown(self):
        self.cursor.execute("DELETE FROM incident_events WHERE user_id IN (99999, 88881, 88882);")
        self.cursor.execute("DELETE FROM responses WHERE alert_id IN (SELECT id FROM alerts WHERE user_id = 99999);")
        self.cursor.execute("DELETE FROM alerts WHERE user_id = 99999;")
        self.cursor.execute("DELETE FROM volunteers WHERE id IN (101, 202);")
        self.cursor.execute("DELETE FROM users WHERE id IN (99999, 88881, 88882);")
        self.cursor.execute("DELETE FROM contacts WHERE user_id = 99999;")
        self.cursor.execute("DELETE FROM timers WHERE user_id = 99999;")
        self.cursor.execute("DELETE FROM evidence_sessions WHERE user_id = '99999';")
        self.conn.commit()
        self.conn.close()

    def test_01_schema_and_reason_column(self):
        """Verify incident_events table structure and alerts.reason column defaults."""
        self.cursor.execute("PRAGMA table_info(incident_events);")
        cols = {row['name']: row['type'].upper() for row in self.cursor.fetchall()}
        required_cols = ['id', 'user_id', 'alert_id', 'escort_id', 'seq', 'ts', 'type', 'actor', 'detail_json']
        for col in required_cols:
            self.assertIn(col, cols, f"Missing column {col} in incident_events")

        self.cursor.execute("PRAGMA table_info(alerts);")
        alert_cols = {row['name']: row['dflt_value'] for row in self.cursor.fetchall()}
        self.assertIn('reason', alert_cols, "alerts table must have reason column")
        default_val = str(alert_cols['reason']).replace("'", "").replace('"', '').strip()
        self.assertEqual(default_val, 'manual')

    def test_02_sequential_seq_and_utc_timestamp(self):
        """Verify seq increments sequentially per alert and ts is formatted as UTC ISO text."""
        # Create an alert
        self.cursor.execute("""
            INSERT INTO alerts (user_id, mode, reason, status, lat, lng, share_token)
            VALUES (99999, 'emergency', 'manual', 'active', 12.97, 77.59, 'test_token_1');
        """)
        alert_id = self.cursor.lastrowid
        self.conn.commit()

        ev1 = log_event(99999, 'alert_created', 'user', {'mode': 'emergency'}, alert_id=alert_id, cursor=self.cursor)
        ev2 = log_event(99999, 'alert_mode_changed', 'user', {'old_mode': 'emergency', 'new_mode': 'silent'}, alert_id=alert_id, cursor=self.cursor)
        ev3 = log_event(99999, 'email_sent', 'system', {'count': 2}, alert_id=alert_id, cursor=self.cursor)
        self.conn.commit()

        self.assertEqual(ev1['seq'], 1)
        self.assertEqual(ev2['seq'], 2)
        self.assertEqual(ev3['seq'], 3)

        # Check UTC ISO timestamp format (e.g. 2026-11-07T12:00:00Z)
        self.assertTrue(ev1['ts'].endswith('Z'))
        self.assertIn('T', ev1['ts'])

    def test_03_actor_whitelist_validation(self):
        """Verify allowed actors: user, system, contact, volunteer, safepoint."""
        for actor in ['user', 'system', 'contact', 'volunteer', 'safepoint']:
            ev = log_event(99999, 'test_event', actor, {'actor_tested': actor}, cursor=self.cursor)
            self.assertEqual(ev['actor'], actor)

        # Unknown actor falls back safely to 'system'
        invalid_ev = log_event(99999, 'test_event', 'hacker_actor', {}, cursor=self.cursor)
        self.assertEqual(invalid_ev['actor'], 'system')

    def test_04_detail_sanitization(self):
        """Ensure phones, emails, tokens, PINs, full addresses are NEVER stored in detail_json."""
        dirty_detail = {
            "phone": "+919876543210",
            "mobile": "9876543210",
            "email": "victim@example.com",
            "token": "secret_session_token_12345",
            "pin": "1234",
            "address": "123 SafeHer Lane, Bangalore",
            "message": "Call me at +919876543210 or email test@gmail.com",
            "contact": "Priya Sharma",
            "count": 3
        }

        sanitized = sanitize_detail_dict(dirty_detail)

        # Forbidden keys removed
        for forbidden in ['phone', 'mobile', 'email', 'token', 'pin', 'address']:
            self.assertNotIn(forbidden, sanitized)

        # Contact reduced to first name only
        self.assertEqual(sanitized['contact'], 'Priya')

        # Embedded phone and email masked in strings
        self.assertNotIn('9876543210', sanitized['message'])
        self.assertNotIn('test@gmail.com', sanitized['message'])
        self.assertIn('[MASKED]', sanitized['message'])

        # Allowed keys preserved
        self.assertEqual(sanitized['count'], 3)

    def test_05_volunteer_anonymous_labeling(self):
        """Volunteers must be labeled as 'Volunteer 1', 'Volunteer 2'."""
        self.cursor.execute("""
            INSERT INTO alerts (user_id, mode, status, lat, lng, share_token)
            VALUES (99999, 'emergency', 'active', 12.97, 77.59, 'token_vol');
        """)
        alert_id = self.cursor.lastrowid

        # Insert dummy users and volunteers
        self.cursor.execute("INSERT OR REPLACE INTO users (id, name, phone, email, password_hash) VALUES (88881, 'V1', '8888188881', 'v1@test.com', 'h');")
        self.cursor.execute("INSERT OR REPLACE INTO users (id, name, phone, email, password_hash) VALUES (88882, 'V2', '8888288882', 'v2@test.com', 'h');")
        self.cursor.execute("INSERT OR REPLACE INTO volunteers (id, user_id, status) VALUES (101, 88881, 'approved');")
        self.cursor.execute("INSERT OR REPLACE INTO volunteers (id, user_id, status) VALUES (202, 88882, 'approved');")

        # Insert responses for 2 volunteers
        self.cursor.execute("INSERT INTO responses (alert_id, volunteer_id, status) VALUES (?, 101, 'coming');", (alert_id,))
        self.cursor.execute("INSERT INTO responses (alert_id, volunteer_id, status) VALUES (?, 202, 'coming');", (alert_id,))
        self.conn.commit()

        label1 = get_volunteer_alert_label(self.cursor, alert_id, 101)
        label2 = get_volunteer_alert_label(self.cursor, alert_id, 202)
        label3 = get_volunteer_alert_label(self.cursor, alert_id, 303)

        self.assertEqual(label1, "Volunteer 1")
        self.assertEqual(label2, "Volunteer 2")
        self.assertEqual(label3, "Volunteer 3")

    def test_06_duress_pin_never_logged(self):
        """CRITICAL: Duress PIN must never appear in events, and alert_ended must NOT be logged on duress."""
        # Attempt to log alert_ended with duress flag
        res = log_event(
            user_id=99999,
            type='alert_ended',
            actor='user',
            detail={'duress': True, 'pin': '9999'},
            alert_id=1,
            cursor=self.cursor
        )
        self.assertIsNone(res, "alert_ended must NEVER be logged when duress is true")

        # Attempt to log explicit duress event
        res_duress_type = log_event(
            user_id=99999,
            type='duress_activated',
            actor='user',
            detail={'note': 'under threat'},
            alert_id=1,
            cursor=self.cursor
        )
        self.assertIsNone(res_duress_type, "Events with duress in type must be blocked")

        # Verify no incident_events were created with duress
        self.cursor.execute("SELECT COUNT(*) AS cnt FROM incident_events WHERE user_id = 99999 AND detail_json LIKE '%duress%';")
        cnt = self.cursor.fetchone()['cnt']
        self.assertEqual(cnt, 0)

    def test_07_all_thirteen_flow_event_types(self):
        """Verify all specified event types can be logged cleanly."""
        self.cursor.execute("""
            INSERT INTO alerts (user_id, mode, reason, status, lat, lng, share_token)
            VALUES (99999, 'emergency', 'manual', 'active', 12.97, 77.59, 'flow_test');
        """)
        alert_id = self.cursor.lastrowid
        self.conn.commit()

        flow_events = [
            ("alert_created", "user", {"mode": "emergency", "reason": "manual"}),
            ("alert_mode_changed", "user", {"old_mode": "emergency", "new_mode": "silent"}),
            ("alert_ended", "user", {"by": "pin"}),
            ("email_sent", "system", {"count": 2}),
            ("email_failed", "system", {"count": 1}),
            ("push_sent", "system", {"count": 3}),
            ("volunteer_notified", "system", {"count": 4}),
            ("volunteer_responded", "volunteer", {"volunteer": "Volunteer 1", "status": "coming"}),
            ("contact_responded", "contact", {"contact": "Ananya", "status": "on_my_way"}),
            ("user_checkin_ok", "user", {"mode": "uneasy"}),
            ("timer_expired", "system", {"timer_id": 555}),
            ("evidence_session_started", "user", {"session_id": "sess_123", "kind": "audio"}),
            ("evidence_session_ended", "user", {"session_id": "sess_123", "count": 5}),
            ("evidence_chunks_uploaded", "user", {"session_id": "sess_123", "count": 5}),
        ]

        for etype, actor, detail in flow_events:
            ev = log_event(
                user_id=99999,
                type=etype,
                actor=actor,
                detail=detail,
                alert_id=alert_id,
                cursor=self.cursor
            )
            self.assertIsNotNone(ev, f"Failed to log flow event: {etype}")
            self.assertEqual(ev['type'], etype)
            self.assertEqual(ev['actor'], actor)

        self.conn.commit()

        # Check total sequence count
        self.cursor.execute("SELECT COUNT(*) AS cnt, MAX(seq) AS max_seq FROM incident_events WHERE alert_id = ?;", (alert_id,))
        row = self.cursor.fetchone()
        self.assertEqual(row['cnt'], len(flow_events))
        self.assertEqual(row['max_seq'], len(flow_events))

    def test_08_scheduler_retention_30_days(self):
        """Verify scheduler deletes events older than 30 days and preserves newer events."""
        # Insert a 40-day old event
        old_ts = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.cursor.execute("""
            INSERT INTO incident_events (user_id, seq, ts, type, actor, detail_json, created_at)
            VALUES (99999, 1, ?, 'old_event', 'system', '{}', datetime('now', '-40 days'));
        """, (old_ts,))

        # Insert a 5-day old event
        new_ts = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.cursor.execute("""
            INSERT INTO incident_events (user_id, seq, ts, type, actor, detail_json, created_at)
            VALUES (99999, 2, ?, 'new_event', 'system', '{}', datetime('now', '-5 days'));
        """, (new_ts,))
        self.conn.commit()

        # Run scheduler purge
        purged = cleanup_old_incident_events()
        self.assertGreaterEqual(purged, 1)

        # Verify old event is gone, new event remains
        self.cursor.execute("SELECT type FROM incident_events WHERE user_id = 99999;")
        types = [r['type'] for r in self.cursor.fetchall()]
        self.assertNotIn('old_event', types)
        self.assertIn('new_event', types)


if __name__ == '__main__':
    unittest.main()
