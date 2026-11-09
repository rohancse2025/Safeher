# backend/test_notifications.py – Comprehensive unit & integration tests for notification engine
import os
import sys

# Set isolated test database and test environment before importing backend modules
os.environ['TESTING'] = 'true'
os.environ['DATABASE_PATH'] = 'test_safeher.db'
os.environ['BREVO_API_KEY'] = 'xkeysib-mock-key-12345'
os.environ['BREVO_WEBHOOK_SECRET'] = 'test_webhook_secret_999'

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

import unittest
from unittest.mock import patch, MagicMock
import json
import sqlite3
import datetime
import urllib.error
import jwt

from db import get_db, init_db, DB_PATH
from app import app
from services.notify import notify, process_outbox, mask_email
from services.templates import render_template, format_ist_time


class NotificationSystemTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    @classmethod
    def tearDownClass(cls):
        try:
            if os.path.exists(DB_PATH):
                os.remove(DB_PATH)
        except Exception:
            pass

    def setUp(self):
        app.config['TESTING'] = True
        app.config['SECRET_KEY'] = 'test-secret-key-123456789012345678901234'
        self.client = app.test_client()

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM notifications;")
        cursor.execute("DELETE FROM notification_settings;")
        cursor.execute("DELETE FROM contacts WHERE user_id = 99999;")
        cursor.execute("DELETE FROM users WHERE id = 99999;")
        
        # Create test user
        cursor.execute("""
            INSERT INTO users (id, name, phone, password_hash)
            VALUES (99999, 'Priya Sharma', '919876543210', 'dummy_hash');
        """)

        # Create test contacts:
        # 1: Normal with valid email
        # 2: Opted-out contact
        # 3: Contact without email
        # 4: Contact with bounced email
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99001, 99999, 'Rohit Sharma', '919876543211', 'rohit@example.com', 0, 'ok', 'tok_rohit_123');
        """)
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99002, 99999, 'Anita Sharma', '919876543212', 'anita@example.com', 1, 'ok', 'tok_anita_456');
        """)
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99003, 99999, 'Sunil Sharma', '919876543213', NULL, 0, 'unknown', 'tok_sunil_789');
        """)
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99004, 99999, 'Bounced Contact', '919876543214', 'bounced@example.com', 0, 'bounced', 'tok_bounce_000');
        """)
        conn.commit()
        conn.close()

    def tearDown(self):
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("DELETE FROM notifications WHERE user_id = 99999;")
            cursor.execute("DELETE FROM notification_settings WHERE user_id = 99999;")
            cursor.execute("DELETE FROM contacts WHERE user_id = 99999;")
            cursor.execute("DELETE FROM users WHERE id = 99999;")
            conn.commit()
            conn.close()
        except Exception:
            pass

    # ─── 1. Template Rendering & Privacy ─────────────────────
    def test_templates_and_masking(self):
        """Verify calm subject, IST time, 112 notice, and email masking."""
        subject, text_body, html_body = render_template('sos', {
            'user_name': 'Priya',
            'time_str': '9:42 PM IST, 9 Nov 2026',
            'lat': 12.9716,
            'lng': 77.5946,
            'track_url': 'https://safeher.org/track.html?t=abc123xyz'
        })

        self.assertIn('SafeHer: Priya needs help', subject)
        self.assertNotIn('URGENT', subject)
        self.assertNotIn('HELP ME', subject)
        self.assertIn('call 112', text_body.lower())
        self.assertIn('112', html_body)
        self.assertIn('google.com/maps', text_body)

        # Masking verification
        self.assertEqual(mask_email('rohit.sharma@example.com'), 'r***a@example.com')
        self.assertEqual(mask_email('ab@test.com'), 'a***@test.com')
        self.assertEqual(mask_email(None), 'N/A')

    # ─── 2. Idempotency Test ─────────────────────────────────
    @patch('services.notify.process_outbox')
    def test_idempotent_event_key(self, mock_outbox):
        """Verify the exact same event_key never creates duplicate queued rows for the same contact."""
        created1 = notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya', 'lat': 12.9716, 'lng': 77.5946},
            contact_ids=[99001],
            event_key='test_sos_unique_001'
        )
        self.assertEqual(len(created1), 1)

        # Second notify with identical event_key
        created2 = notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya', 'lat': 12.9716, 'lng': 77.5946},
            contact_ids=[99001],
            event_key='test_sos_unique_001'
        )
        self.assertEqual(len(created2), 0)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key = 'test_sos_unique_001';")
        count = cursor.fetchone()['count']
        conn.close()
        self.assertEqual(count, 1)

    # ─── 3. Skipped Contacts Handling ────────────────────────
    @patch('services.notify.process_outbox')
    def test_skipped_reasons_visible(self, mock_outbox):
        """Opted-out, no email, and bounced contacts must be recorded as 'skipped' with visible reason."""
        created = notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya'},
            contact_ids=[99001, 99002, 99003, 99004],
            event_key='test_sos_skipped_check'
        )

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT contact_id, status, last_error FROM notifications WHERE event_key = 'test_sos_skipped_check';")
        rows = {r['contact_id']: dict(r) for r in cursor.fetchall()}
        conn.close()

        # Normal contact should be queued
        self.assertEqual(rows[99001]['status'], 'queued')

        # Opted-out contact should be skipped with visible reason
        self.assertEqual(rows[99002]['status'], 'skipped')
        self.assertIn('Opted out', rows[99002]['last_error'])

        # No email contact should be skipped with visible reason
        self.assertEqual(rows[99003]['status'], 'skipped')
        self.assertIn('No email address', rows[99003]['last_error'])

        # Bounced contact should be skipped
        self.assertEqual(rows[99004]['status'], 'skipped')
        self.assertIn('bounced', rows[99004]['last_error'])

    # ─── 4. Outbox Sending & Retries ─────────────────────────
    @patch('services.notify._trigger_outbox_background')
    @patch('urllib.request.urlopen')
    def test_process_outbox_success(self, mock_urlopen, mock_bg):
        """Verify successful Brevo dispatch records provider_message_id and sets sent status."""
        mock_response = MagicMock()
        mock_response.getcode.return_value = 201
        mock_response.read.return_value = json.dumps({"messageId": "<brevo-test-msg-12345@smtp-relay.mailin.fr>"}).encode('utf-8')
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya'},
            contact_ids=[99001],
            event_key='test_sos_send_success'
        )

        sent_count = process_outbox(limit=10)
        self.assertGreaterEqual(sent_count, 1)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status, attempts, provider_message_id FROM notifications WHERE event_key = 'test_sos_send_success';")
        row = cursor.fetchone()
        conn.close()

        self.assertEqual(row['status'], 'sent')
        self.assertEqual(row['attempts'], 1)
        self.assertIn('brevo-test-msg-12345', row['provider_message_id'])

    @patch('services.notify._trigger_outbox_background')
    @patch('urllib.request.urlopen')
    def test_process_outbox_failure_and_retry(self, mock_urlopen, mock_bg):
        """Verify failed HTTP dispatch increments attempts, records last_error, and schedules next_attempt_at."""
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url='https://api.brevo.com/v3/smtp/email',
            code=500,
            msg='Internal Server Error',
            hdrs={},
            fp=MagicMock(read=lambda: b'{"message": "Brevo internal server error"}')
        )

        notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya'},
            contact_ids=[99001],
            event_key='test_sos_send_fail'
        )

        process_outbox(limit=10)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status, attempts, last_error, next_attempt_at FROM notifications WHERE event_key = 'test_sos_send_fail';")
        row = cursor.fetchone()
        conn.close()

        self.assertEqual(row['status'], 'queued')
        self.assertEqual(row['attempts'], 1)
        self.assertIn('Brevo internal server error', row['last_error'])
        self.assertIsNotNone(row['next_attempt_at'])

    # ─── 5. Brevo Webhook Handling ───────────────────────────
    def test_brevo_webhook_hard_bounce(self):
        """Brevo hard_bounce event must update notification status to bounced and contact email_status to bounced."""
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO notifications (user_id, event_type, event_key, contact_id, channel, recipient_masked, recipient_email, subject, body_text, body_html, status, provider_message_id)
            VALUES (99999, 'sos', 'test_key_wb', 99001, 'email', 'r***t@example.com', 'rohit@example.com', 'Subject', 'Text', '<p>Html</p>', 'sent', '<msg-bounce-test-999@relay>');
        """)
        conn.commit()
        conn.close()

        secret = os.getenv('BREVO_WEBHOOK_SECRET', 'test_webhook_secret_999')
        payload = {
            "event": "hard_bounce",
            "email": "rohit@example.com",
            "message-id": "<msg-bounce-test-999@relay>",
            "reason": "Mailbox does not exist"
        }

        resp = self.client.post(
            f'/api/brevo/webhook/{secret}',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 200)

        # Check DB state
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status, last_error FROM notifications WHERE event_key = 'test_key_wb';")
        notif_row = cursor.fetchone()
        self.assertEqual(notif_row['status'], 'bounced')
        self.assertIn('Mailbox does not exist', notif_row['last_error'])

        cursor.execute("SELECT email_status FROM contacts WHERE id = 99001;")
        contact_row = cursor.fetchone()
        self.assertEqual(contact_row['email_status'], 'bounced')
        conn.close()

    # ─── 6. Notification Settings (SOS Cannot Be Disabled) ───
    def test_notification_settings_sos_locked(self):
        """Notification settings must not allow disabling SOS events."""
        token = jwt.encode({'user_id': 99999, 'phone': '919876543210'}, app.config['SECRET_KEY'], algorithm='HS256')
        headers = {'Authorization': f'Bearer {token}'}

        # Attempt to disable SOS and timer
        resp = self.client.put(
            '/api/notification-settings',
            headers=headers,
            data=json.dumps({
                'settings': {
                    'sos': False,
                    'timer_start': False
                }
            }),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 200)

        # Verify persisted settings via GET
        get_resp = self.client.get('/api/notification-settings', headers=headers)
        self.assertEqual(get_resp.status_code, 200)
        settings = get_resp.get_json()['data']['settings']
        self.assertTrue(settings['sos'], "SOS event must remain enabled despite client request")
        self.assertFalse(settings['timer_start'], "Non-SOS event should be allowed to disable")

    # ─── 7. Opt-Out Endpoint ─────────────────────────────────
    def test_optout_endpoint(self):
        """GET /api/optout/<token> must mark contact as opted_out=1 and return HTML."""
        resp = self.client.get('/api/optout/tok_rohit_123')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Opt-Out Confirmed', resp.data)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT opted_out FROM contacts WHERE id = 99001;")
        row = cursor.fetchone()
        conn.close()
        self.assertEqual(row['opted_out'], 1)

    # ─── 8. Contact Coverage Endpoint ────────────────────────
    def test_contacts_coverage_endpoint(self):
        """GET /api/contacts/coverage returns coverage metrics and warnings."""
        token = jwt.encode({'user_id': 99999, 'phone': '919876543210'}, app.config['SECRET_KEY'], algorithm='HS256')
        headers = {'Authorization': f'Bearer {token}'}

        resp = self.client.get('/api/contacts/coverage', headers=headers)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()['data']

        self.assertEqual(data['total_contacts'], 4)
        self.assertEqual(data['with_email'], 3)
        self.assertEqual(data['opted_out'], 1)
        self.assertEqual(data['bounced'], 1)
        self.assertEqual(data['active_email_contacts'], 1)


    # ─── 9. Comprehensive Event Types & Queue Tests ───────────
    @patch('services.notify.process_outbox')
    def test_all_event_types_queue_correct_contacts(self, mock_outbox):
        """
        Verify each required event type queues the eligible contact (99001)
        and skips opted_out (99002), no email (99003), and bounced (99004).
        """
        event_types = [
            'alert_created',
            'alert_uneasy',
            'alert_escalated',
            'alert_ended',
            'volunteer_coming',
            'escort_started',
            'escort_arrived',
            'escort_off_route',
            'escort_missed_checkin',
            'escort_no_signal',
            'escort_late_arrival',
            'escort_ended',
            'timer_expired',
            'share_started',
            'share_ended',
            'ride_started',
            'ride_ended',
            'ride_late',
            'contact_added'
        ]

        for et in event_types:
            key = f"evt_{et}_test_001"
            created_ids = notify(
                event_type=et,
                user_id=99999,
                context={
                    'user_name': 'Priya Sharma',
                    'destination': 'MG Road Metro',
                    'lat': 12.9716,
                    'lng': 77.5946
                },
                event_key=key
            )
            # 4 contacts: 1 queued, 3 skipped
            self.assertEqual(len(created_ids), 4, f"Event {et} did not process all 4 contacts")

            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("SELECT contact_id, status, last_error FROM notifications WHERE event_key = ? ORDER BY contact_id ASC;", (key,))
            rows = cursor.fetchall()
            conn.close()

            status_map = {r['contact_id']: r['status'] for r in rows}
            self.assertEqual(status_map.get(99001), 'queued', f"Event {et}: eligible contact 99001 must be queued")
            self.assertEqual(status_map.get(99002), 'skipped', f"Event {et}: opted out contact 99002 must be skipped")
            self.assertEqual(status_map.get(99003), 'skipped', f"Event {et}: no-email contact 99003 must be skipped")
            self.assertEqual(status_map.get(99004), 'skipped', f"Event {et}: bounced contact 99004 must be skipped")

    # ─── 10. Duress PIN Security Test ─────────────────────────
    def test_duress_pin_never_sends_notifications(self):
        """
        Verify ending an alert with a duress PIN marks duress=1, keeps alert active,
        and does NOT send any notification or log alert_ended.
        """
        conn = get_db()
        cursor = conn.cursor()
        from werkzeug.security import generate_password_hash
        cursor.execute("UPDATE users SET pin_hash = ?, duress_pin_hash = ? WHERE id = 99999;",
                       (generate_password_hash('1234'), generate_password_hash('9999')))
        
        cursor.execute('''
            INSERT INTO alerts (user_id, mode, status, lat, lng, share_token)
            VALUES (99999, 'emergency', 'active', 12.9716, 77.5946, 'duress_test_token_999');
        ''')
        alert_id = cursor.lastrowid
        conn.commit()
        conn.close()

        token = jwt.encode({'user_id': 99999, 'phone': '919876543210'}, app.config['SECRET_KEY'], algorithm='HS256')
        headers = {'Authorization': f'Bearer {token}'}

        # End with duress PIN '9999'
        resp = self.client.post(f'/api/alerts/{alert_id}/end', headers=headers, json={'pin': '9999'})
        self.assertEqual(resp.status_code, 200)

        # Check alert state: must remain 'active' and duress=1
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status, duress FROM alerts WHERE id = ?;", (alert_id,))
        a_row = cursor.fetchone()
        self.assertEqual(a_row['status'], 'active')
        self.assertEqual(a_row['duress'], 1)

        # Check notifications: NO notification for this alert end must be queued
        cursor.execute("SELECT COUNT(*) AS cnt FROM notifications WHERE event_key = ?;", (f"alert:{alert_id}:ended",))
        cnt = cursor.fetchone()['cnt']
        conn.close()
        self.assertEqual(cnt, 0, "Duress PIN must NEVER queue an alert_ended notification")

    # ─── 11. Shares & Rides Routes Test ───────────────────────
    @patch('services.notify.process_outbox')
    def test_shares_and_rides_endpoints(self, mock_outbox):
        """Test POST /api/shares and POST /api/rides with public tracking tokens."""
        token = jwt.encode({'user_id': 99999, 'phone': '919876543210'}, app.config['SECRET_KEY'], algorithm='HS256')
        headers = {'Authorization': f'Bearer {token}'}

        # 1. Start share
        s_resp = self.client.post('/api/shares', headers=headers, json={
            'duration_minutes': 45,
            'contact_ids': [99001],
            'lat': 12.9716,
            'lng': 77.5946
        })
        self.assertEqual(s_resp.status_code, 201)
        s_data = s_resp.get_json()['data']
        share_id = s_data['id']
        share_tok = s_data['tokens'][0]['token']

        # Public tracking for share token
        track_resp = self.client.get(f'/api/track/{share_tok}')
        self.assertEqual(track_resp.status_code, 200)
        track_data = track_resp.get_json()['data']
        self.assertEqual(track_data['type'], 'share')
        self.assertEqual(track_data['status'], 'active')

        # Stop share
        stop_resp = self.client.post(f'/api/shares/{share_id}/stop', headers=headers)
        self.assertEqual(stop_resp.status_code, 200)

        # 2. Start ride
        r_resp = self.client.post('/api/rides', headers=headers, json={
            'vehicle_type': 'Auto',
            'vehicle_number': 'KA-01-EE-5555',
            'driver_name': 'Ramesh',
            'destination': 'Indiranagar',
            'expected_minutes': 25,
            'contact_ids': [99001]
        })
        self.assertEqual(r_resp.status_code, 201)
        r_data = r_resp.get_json()['data']
        ride_id = r_data['id']
        ride_tok = r_data['tokens'][0]['token']

        # Public tracking for ride token
        r_track_resp = self.client.get(f'/api/track/{ride_tok}')
        self.assertEqual(r_track_resp.status_code, 200)
        r_track_data = r_track_resp.get_json()['data']
        self.assertEqual(r_track_data['type'], 'ride')
        self.assertEqual(r_track_data['status'], 'active')
        self.assertEqual(r_track_data['vehicle_number'], 'KA-01-EE-5555')

        # End ride
        end_r_resp = self.client.post(f'/api/rides/{ride_id}/end', headers=headers)
        self.assertEqual(end_r_resp.status_code, 200)


    # ─── 13. Alert Reminders at 3m & 10m Tests ──────────────────
    @patch('services.notify.process_outbox')
    def test_alert_reminders_timing_cancellation_and_duress(self, mock_outbox):
        """
        Verify reminder emails:
        - 3-min reminder sent after 180s
        - 10-min reminder sent after 600s
        - stopped as soon as contact responds
        - stopped when alert ends
        - continues as normal for duress PIN alerts (status='active', duress=1)
        - no duplicates (idempotent)
        - respects 'alert_reminders' disabled setting
        """
        from scheduler import check_alert_reminders

        conn = get_db()
        cursor = conn.cursor()

        # (A) Create active alert from 4 minutes ago (240s ago)
        cursor.execute("""
            INSERT INTO alerts (user_id, mode, status, reason, lat, lng, started_at, share_token, duress)
            VALUES (99999, 'normal', 'active', 'test_sos', 12.9716, 77.5946, datetime('now', '-240 seconds'), 'tok_rem_001', 0);
        """)
        alert_id_1 = cursor.lastrowid
        cursor.execute("INSERT INTO alert_contacts (alert_id, contact_id, token) VALUES (?, 99001, 'tok_c_001');", (alert_id_1,))
        conn.commit()

        # Run scheduler tick
        queued = check_alert_reminders()
        self.assertGreaterEqual(queued, 1)

        # Verify reminder1 was created with key alert:<id>:reminder1
        cursor.execute("SELECT event_key, status, subject FROM notifications WHERE event_key = ?;", (f"alert:{alert_id_1}:reminder1",))
        row = cursor.fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row['event_key'], f"alert:{alert_id_1}:reminder1")
        self.assertIn("Reminder", row['subject'])

        # Run again immediately -> no duplicates!
        queued_dup = check_alert_reminders()
        cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key = ?;", (f"alert:{alert_id_1}:reminder1",))
        self.assertEqual(cursor.fetchone()['count'], 1)

        # (B) Advance alert to 12 minutes ago -> reminder2 queued
        cursor.execute("UPDATE alerts SET started_at = datetime('now', '-720 seconds') WHERE id = ?;", (alert_id_1,))
        conn.commit()
        queued_2 = check_alert_reminders()
        self.assertGreaterEqual(queued_2, 1)
        cursor.execute("SELECT event_key FROM notifications WHERE event_key = ?;", (f"alert:{alert_id_1}:reminder2",))
        self.assertIsNotNone(cursor.fetchone())

        # (C) Stopping on contact response:
        # Create alert 2 from 5 minutes ago, but contact responds
        cursor.execute("""
            INSERT INTO alerts (user_id, mode, status, reason, lat, lng, started_at, share_token, duress)
            VALUES (99999, 'normal', 'active', 'test_sos', 12.9716, 77.5946, datetime('now', '-300 seconds'), 'tok_rem_002', 0);
        """)
        alert_id_2 = cursor.lastrowid
        cursor.execute("INSERT INTO alert_contacts (alert_id, contact_id, token) VALUES (?, 99001, 'tok_c_002');", (alert_id_2,))
        cursor.execute("INSERT INTO contact_responses (alert_id, contact_id, status) VALUES (?, 99001, 'on_the_way');", (alert_id_2,))
        conn.commit()

        check_alert_reminders()
        cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key LIKE ?;", (f"alert:{alert_id_2}:%",))
        self.assertEqual(cursor.fetchone()['count'], 0, "No reminder should be sent after contact responds")

        # (D) Stopping when alert ends:
        cursor.execute("""
            INSERT INTO alerts (user_id, mode, status, reason, lat, lng, started_at, share_token, duress)
            VALUES (99999, 'normal', 'ended', 'test_sos', 12.9716, 77.5946, datetime('now', '-300 seconds'), 'tok_rem_003', 0);
        """)
        alert_id_3 = cursor.lastrowid
        cursor.execute("INSERT INTO alert_contacts (alert_id, contact_id, token) VALUES (?, 99001, 'tok_c_003');", (alert_id_3,))
        conn.commit()

        check_alert_reminders()
        cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key LIKE ?;", (f"alert:{alert_id_3}:%",))
        self.assertEqual(cursor.fetchone()['count'], 0, "No reminder should be sent when alert has ended")

        # (E) Silent-mode ended with Duress PIN: status remains 'active', duress=1
        # Reminders MUST continue to send as normal!
        cursor.execute("""
            INSERT INTO alerts (user_id, mode, status, reason, lat, lng, started_at, share_token, duress)
            VALUES (99999, 'silent', 'active', 'duress_test', 12.9716, 77.5946, datetime('now', '-300 seconds'), 'tok_rem_004', 1);
        """)
        alert_id_4 = cursor.lastrowid
        cursor.execute("INSERT INTO alert_contacts (alert_id, contact_id, token) VALUES (?, 99001, 'tok_c_004');", (alert_id_4,))
        conn.commit()

        check_alert_reminders()
        cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key = ?;", (f"alert:{alert_id_4}:reminder1",))
        self.assertEqual(cursor.fetchone()['count'], 1, "Duress PIN alert stays active and keeps sending reminders as normal")

        # (F) Respects disabled setting
        cursor.execute("""
            INSERT INTO alerts (user_id, mode, status, reason, lat, lng, started_at, share_token, duress)
            VALUES (99999, 'normal', 'active', 'disabled_setting_test', 12.9716, 77.5946, datetime('now', '-300 seconds'), 'tok_rem_005', 0);
        """)
        alert_id_5 = cursor.lastrowid
        cursor.execute("INSERT INTO alert_contacts (alert_id, contact_id, token) VALUES (?, 99001, 'tok_c_005');", (alert_id_5,))
        # Turn off reminder emails for user 99999
        cursor.execute("INSERT OR REPLACE INTO notification_settings (user_id, event_type, enabled) VALUES (99999, 'alert_reminders', 0);")
        conn.commit()

        check_alert_reminders()
        cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key LIKE ?;", (f"alert:{alert_id_5}:%",))
        self.assertEqual(cursor.fetchone()['count'], 0, "No reminder when alert_reminders setting is disabled")

        conn.close()


if __name__ == '__main__':
    unittest.main()
