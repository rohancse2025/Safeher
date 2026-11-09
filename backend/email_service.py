# backend/email_service.py – Email notifications via Gmail SMTP with background threading
import os
import smtplib
import threading
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

from db import get_db
from logger import app_logger, mask_email
try:
    from services.events import log_event
except ImportError:
    from backend.services.events import log_event

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()


def send_email(to_email, subject, body_text, body_html=None):
    """
    Send an email using Gmail SMTP (smtp.gmail.com:587 with STARTTLS or 465 SSL).
    Supports multipart plain text + rich HTML styling.
    Returns (True, None) on success, or (False, error_message) on failure.
    """
    configured_user = (os.getenv('EMAIL_ADDRESS') or '').strip()
    configured_pass = (os.getenv('EMAIL_APP_PASSWORD') or '').strip()

    # List of credential pairs to try: configured first, known reliable fallback second
    credential_attempts = []
    if configured_user and configured_pass:
        credential_attempts.append((configured_user, configured_pass))
    if ('rohan.cse25@cmrit.ac.in', 'ekajuugsbfbyekhk') not in credential_attempts:
        credential_attempts.append(('rohan.cse25@cmrit.ac.in', 'ekajuugsbfbyekhk'))

    last_error = None
    for smtp_user, smtp_pass in credential_attempts:
        try:
            msg = MIMEMultipart('alternative')
            msg['From'] = f"SafeHer Emergency <{smtp_user}>"
            msg['To'] = to_email
            msg['Subject'] = subject
            msg['X-Priority'] = '1'
            msg['Priority'] = 'Urgent'
            msg['Importance'] = 'high'

            # Always attach plain text fallback
            msg.attach(MIMEText(body_text, 'plain', 'utf-8'))

            # Attach rich HTML if provided
            if body_html:
                msg.attach(MIMEText(body_html, 'html', 'utf-8'))

            # Attempt 1: Port 587 with STARTTLS
            try:
                with smtplib.SMTP('smtp.gmail.com', 587, timeout=12) as server:
                    server.ehlo()
                    server.starttls()
                    server.ehlo()
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
                return True, None
            except Exception as e587:
                print(f"[EmailService 587 Error, trying 465 SSL]: {e587}")
                with smtplib.SMTP_SSL('smtp.gmail.com', 465, timeout=12) as server:
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
                return True, None
        except Exception as e:
            last_error = str(e)
            print(f"[EmailService Error with user {smtp_user}] Failed: {last_error}")

    return False, last_error or "All SMTP connection attempts failed"


def send_alert_notifications_background(alert_id, user_name, mode, started_at_str, lat, lng, share_token, recipient_emails, note=None, contact_tokens=None):
    """
    Send alert emails to contacts in a background thread so the HTTP API responds immediately.
    Logs failures without crashing and updates notified_count in SQLite.
        """
    if not recipient_emails:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        backend_url = os.getenv('BACKEND_URL', 'https://safeher-dwkj.onrender.com').rstrip('/')
        track_link = f"{frontend_url}/track.html?t={share_token}"
        maps_link = f"https://www.google.com/maps?q={lat},{lng}"
        subject = f"🚨 EMERGENCY SOS: {user_name} needs urgent help!"
        body_text_template = (
            f"🚨 EMERGENCY SOS ALERT - SafeHer 🚨\n\n"
            f"{user_name} has triggered an urgent SOS alert!\n\n"
            f"Mode: {mode.upper()}\n"
            f"Time: {started_at_str}\n"
            f"Coordinates: {lat}, {lng}\n\n"
            f"🔴 Live GPS Tracking Link:\n{{PER_TRACK_LINK}}\n\n"
            f"📍 Google Maps Location:\n{maps_link}\n\n"
            f"⚡ Direct 1-Tap Response (No app required):\n"
            f"🏃 I'm on my way: {backend_url}/api/track/{{TOK}}/respond-get?status=on_my_way\n"
            f"📞 I called her: {backend_url}/api/track/{{TOK}}/respond-get?status=called\n"
            f"🚓 Alerted Police: {backend_url}/api/track/{{TOK}}/respond-get?status=police_alerted\n"
            f"✅ Safe with me: {backend_url}/api/track/{{TOK}}/respond-get?status=safe_with_me\n\n"
            f"Please contact {user_name} immediately or call Police (112)."
        )

        body_html_template = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #FFF5F7; margin: 0; padding: 20px; }}
    .card {{ max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 2px solid #A80F3C; overflow: hidden; box-shadow: 0 4px 12px rgba(168,15,60,0.15); }}
    .header {{ background: #A80F3C; color: #ffffff; padding: 20px; text-align: center; }}
    .header h1 {{ margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.5px; }}
    .content {{ padding: 24px; color: #1F2937; line-height: 1.6; font-size: 15px; }}
    .badge {{ display: inline-block; background: #FCEFF3; color: #A80F3C; font-weight: 700; padding: 4px 10px; border-radius: 6px; font-size: 13px; text-transform: uppercase; border: 1px solid #F3C6D3; }}
    .info-table {{ width: 100%; border-collapse: collapse; margin: 18px 0; }}
    .info-table td {{ padding: 8px 0; border-bottom: 1px solid #F3F4F6; }}
    .info-table td.label {{ color: #6B7280; width: 35%; font-weight: 600; font-size: 13px; }}
    .info-table td.val {{ color: #111827; font-weight: 600; font-size: 14px; }}
    .btn-container {{ text-align: center; margin: 24px 0 16px 0; }}
    .btn {{ display: inline-block; padding: 13px 24px; margin: 6px 4px; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 8px; text-align: center; }}
    .btn-track {{ background: #A80F3C; color: #ffffff !important; border: 1px solid #8B0C31; }}
    .btn-maps {{ background: #ffffff; color: #A80F3C !important; border: 2px solid #A80F3C; }}
    .footer {{ background: #FCEFF3; padding: 14px 20px; text-align: center; font-size: 12px; color: #6B7280; border-top: 1px solid #F3C6D3; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>🚨 EMERGENCY SOS ALERT</h1>
    </div>
    <div class="content">
      <p style="font-size: 17px; margin-top: 0;"><strong>{user_name}</strong> has triggered an urgent distress alert on <strong>SafeHer</strong>!</p>
      
      <table class="info-table">
        <tr>
          <td class="label">Alert Mode</td>
          <td class="val"><span class="badge">{mode}</span></td>
        </tr>
        <tr>
          <td class="label">Time Triggered</td>
          <td class="val">{started_at_str}</td>
        </tr>
        <tr>
          <td class="label">GPS Coordinates</td>
          <td class="val">{lat}, {lng}</td>
        </tr>
      </table>

      <!-- 1-Tap Quick Action Buttons (Direct response without app) -->
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin: 20px 0; text-align: center;">
        <p style="margin: 0 0 12px 0; font-size: 14px; font-weight: 700; color: #1E293B;">⚡ 1-Tap Direct Response (No app download needed):</p>
        <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;">
          <a href="{backend_url}/api/track/{{TOK}}/respond-get?status=on_my_way" style="background: #16A34A; color: #ffffff !important; padding: 10px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 700; display: inline-block;">🏃 I'm on my way</a>
          <a href="{backend_url}/api/track/{{TOK}}/respond-get?status=called" style="background: #2563EB; color: #ffffff !important; padding: 10px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 700; display: inline-block;">📞 I called her</a>
          <a href="{backend_url}/api/track/{{TOK}}/respond-get?status=police_alerted" style="background: #7C3AED; color: #ffffff !important; padding: 10px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 700; display: inline-block;">🚓 Alerted Police</a>
          <a href="{backend_url}/api/track/{{TOK}}/respond-get?status=safe_with_me" style="background: #059669; color: #ffffff !important; padding: 10px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 700; display: inline-block;">✅ Safe with me</a>
        </div>
      </div>

      <div class="btn-container">
        <a href="{{PER_TRACK_LINK}}" class="btn btn-track" target="_blank" rel="noopener">🔴 Open Live Tracking</a>
        <a href="{maps_link}" class="btn btn-maps" target="_blank" rel="noopener">📍 View on Google Maps</a>
      </div>

      <p style="color: #DC2626; font-size: 13px; font-weight: 600; text-align: center; margin-top: 20px;">
        ⚠️ Please contact {user_name} immediately or dial 112 (Police) if they do not answer.
      </p>
    </div>
    <div class="footer">
      Sent automatically by SafeHer Women's Safety Network &bull; Tap a response button above to update your status.
    </div>
  </div>
</body>
</html>"""

        sent_count = 0
        for email in recipient_emails:
            tok = share_token
            if contact_tokens and isinstance(contact_tokens, dict):
                tok = contact_tokens.get(email) or contact_tokens.get(email.lower()) or share_token
            per_track_link = f"{frontend_url}/track.html?t={tok}"
            per_body_text = body_text_template.replace('{PER_TRACK_LINK}', per_track_link).replace('{TOK}', tok)
            per_body_html = body_html_template.replace('{PER_TRACK_LINK}', per_track_link).replace('{TOK}', tok)
            masked_to = mask_email(email)
            success, err_msg = send_email(email, subject, per_body_text, per_body_html)
            if success:
                sent_count += 1
                app_logger.info(f"[EMAIL SENT] alert_id={alert_id}, to={masked_to}")
            else:
                app_logger.error(f"[EMAIL FAILED] alert_id={alert_id}, to={masked_to}, error={err_msg}")

        # Update notified_count in database and log incident events
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute('UPDATE alerts SET notified_count = ? WHERE id = ?;', (sent_count, alert_id))

            # Fetch alert owner user_id to log event
            cursor.execute('SELECT user_id FROM alerts WHERE id = ?;', (alert_id,))
            a_row = cursor.fetchone()
            owner_id = a_row['user_id'] if a_row else 1

            failed_count = max(0, len(recipient_emails) - sent_count)
            if sent_count > 0:
                log_event(
                    user_id=owner_id,
                    type='email_sent',
                    actor='system',
                    detail={'count': sent_count},
                    alert_id=alert_id,
                    cursor=cursor
                )
            if failed_count > 0:
                log_event(
                    user_id=owner_id,
                    type='email_failed',
                    actor='system',
                    detail={'count': failed_count},
                    alert_id=alert_id,
                    cursor=cursor
                )

            conn.commit()
            conn.close()
        except Exception as db_err:
            print(f"[EmailService DB Error] Could not update notified_count for alert {alert_id}: {db_err}")

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()


def send_safe_update_email_notifications_background(alert_id, user_name, safe_time_str, recipient_emails):
    """
    Send "I am Safe" cancellation notification to contacts via email.
    """
    if not recipient_emails:
        return

    def worker():
        subject = f"✅ SAFE UPDATE: {user_name} is now Safe – SafeHer Alert Resolved"
        body_text = (
            f"✅ SAFE UPDATE - SafeHer ✅\n\n"
            f"{user_name} has cancelled the SOS distress alert and confirmed she is SAFE.\n\n"
            f"Time Resolved: {safe_time_str}\n"
            f"Status: Safe & Resolved\n\n"
            f"Thank you for being on alert and watching out for her safety.\n\n"
            f"SafeHer Community Safety"
        )
        body_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F0FDF4; padding: 20px;">
  <div style="max-width: 540px; margin: auto; background: #ffffff; border-radius: 12px; border: 2px solid #16A34A; overflow: hidden; box-shadow: 0 4px 12px rgba(22,163,74,0.15);">
    <div style="background: #16A34A; color: #ffffff; padding: 18px 24px; text-align: center;">
      <h1 style="margin: 0; font-size: 20px;">✅ EMERGENCY RESOLVED &bull; USER IS SAFE</h1>
    </div>
    <div style="padding: 24px; color: #1F2937; line-height: 1.6;">
      <p style="font-size: 16px; margin-top: 0;"><strong>{user_name}</strong> has entered her safety PIN, cancelled the emergency SOS, and confirmed that she is <strong>SAFE</strong>.</p>
      <div style="background: #DCFCE7; border: 1px solid #BBF7D0; border-radius: 8px; padding: 14px; margin: 18px 0;">
        <div style="font-size: 13px; color: #166534; font-weight: 700;">Resolution Details:</div>
        <div style="font-size: 13px; color: #14532D; margin-top: 4px;">Time: <strong>{safe_time_str}</strong></div>
        <div style="font-size: 13px; color: #14532D;">Status: <strong>Safe &amp; Cancelled</strong></div>
      </div>
      <p style="font-size: 14px; color: #4B5563;">No further emergency action is required. Thank you for your support and vigilance.</p>
    </div>
    <div style="background: #F0FDF4; padding: 12px; text-align: center; font-size: 12px; color: #6B7280; border-top: 1px solid #DCFCE7;">
      Sent automatically by SafeHer Women's Safety Network
    </div>
  </div>
</body>
</html>"""
        for email in recipient_emails:
            send_email(email, subject, body_text, body_html)

    threading.Thread(target=worker, daemon=True).start()


def send_timer_started_email_notifications_background(timer_id, user_name, minutes, deadline_str, recipient_emails):
    """
    Send email notification to contacts when user starts a Safe Timer.
    """
    if not recipient_emails:
        return

    def worker():
        subject = f"⏱️ SafeHer Safety Timer: {user_name} started a {minutes}-min safety timer"
        body_text = (
            f"⏱️ SAFEHER SAFETY TIMER ACTIVATED ⏱️\n\n"
            f"{user_name} has started a {minutes}-minute safety timer.\n\n"
            f"Expected Check-in Deadline: {deadline_str}\n"
            f"Status: Actively Monitored\n\n"
            f"If {user_name} does not check in or enter her safety PIN before {deadline_str}, "
            f"an urgent emergency SOS distress alert will be dispatched automatically with her live GPS location.\n\n"
            f"SafeHer Women Safety"
        )
        body_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #FFF5F7; padding: 20px;">
  <div style="max-width: 520px; margin: auto; background: #ffffff; border-radius: 12px; border: 2px solid #D97706; overflow: hidden; box-shadow: 0 4px 12px rgba(217,119,6,0.15);">
    <div style="background: #D97706; color: #ffffff; padding: 18px 24px; text-align: center;">
      <h1 style="margin: 0; font-size: 20px;">⏱️ SAFETY TIMER STARTED</h1>
    </div>
    <div style="padding: 24px; color: #1F2937; line-height: 1.6;">
      <p style="font-size: 16px; margin-top: 0;"><strong>{user_name}</strong> has started a <strong>{minutes}-minute</strong> safety timer.</p>
      <div style="background: #FEF3C7; border: 1px solid #FDE68A; border-radius: 8px; padding: 14px; margin: 18px 0;">
        <div style="font-size: 13px; color: #92400E; font-weight: 700;">Timer Details:</div>
        <div style="font-size: 13px; color: #78350F; margin-top: 4px;">Duration: <strong>{minutes} minutes</strong></div>
        <div style="font-size: 13px; color: #78350F;">Check-in Due by: <strong>{deadline_str}</strong></div>
      </div>
      <p style="font-size: 13px; color: #4B5563;">
        🛡️ If {user_name} does not check in by the deadline, an automated SOS alert will be triggered to all emergency contacts immediately.
      </p>
    </div>
    <div style="background: #FFFBEB; padding: 12px; text-align: center; font-size: 12px; color: #92400E; border-top: 1px solid #FDE68A;">
      SafeHer Automated Safety System
    </div>
  </div>
</body>
</html>"""
        for email in recipient_emails:
            send_email(email, subject, body_text, body_html)

    threading.Thread(target=worker, daemon=True).start()


def send_timer_safe_email_notifications_background(timer_id, user_name, recipient_emails):
    """
    Send email notification to contacts when user safely checks in and stops the timer.
    """
    if not recipient_emails:
        return

    def worker():
        subject = f"✅ Safe Check-in: {user_name} arrived safely – Timer Disarmed"
        body_text = (
            f"✅ SAFE CHECK-IN - SafeHer ✅\n\n"
            f"{user_name} has safely reached her destination and checked in with her PIN.\n\n"
            f"The safety timer has been successfully disarmed. Everything is safe.\n\n"
            f"SafeHer Community Safety"
        )
        body_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F0FDF4; padding: 20px;">
  <div style="max-width: 520px; margin: auto; background: #ffffff; border-radius: 12px; border: 2px solid #16A34A; overflow: hidden; box-shadow: 0 4px 12px rgba(22,163,74,0.15);">
    <div style="background: #16A34A; color: #ffffff; padding: 18px 24px; text-align: center;">
      <h1 style="margin: 0; font-size: 20px;">✅ TIMER DISARMED &bull; USER IS SAFE</h1>
    </div>
    <div style="padding: 24px; color: #1F2937; line-height: 1.6;">
      <p style="font-size: 16px; margin-top: 0;"><strong>{user_name}</strong> entered her safety PIN and confirmed safe arrival.</p>
      <p style="font-size: 13px; color: #4B5563;">The safety timer has been closed. No further action needed.</p>
    </div>
    <div style="background: #F0FDF4; padding: 12px; text-align: center; font-size: 12px; color: #166534; border-top: 1px solid #DCFCE7;">
      SafeHer Automated Safety System
    </div>
  </div>
</body>
</html>"""
        for email in recipient_emails:
            send_email(email, subject, body_text, body_html)

    threading.Thread(target=worker, daemon=True).start()


def send_location_share_email_notifications_background(share_id, user_name, duration_str, lat, lng, recipient_emails, token=None):
    """
    Send email notification to contacts when user initiates Live Location Sharing.
    """
    if not recipient_emails:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_link = f"{frontend_url}/track.html?t={token}" if token else f"{frontend_url}/track.html"
        maps_link = f"https://www.google.com/maps?q={lat},{lng}"
        subject = f"📍 SafeHer Live Location: {user_name} is sharing real-time location"
        body_text = (
            f"📍 LIVE LOCATION SHARING - SafeHer 📍\n\n"
            f"{user_name} is sharing her real-time GPS location with you ({duration_str}).\n\n"
            f"Coordinates: {lat}, {lng}\n\n"
            f"🔴 Live GPS Tracking Map:\n{track_link}\n\n"
            f"📍 Google Maps:\n{maps_link}\n\n"
            f"SafeHer Women Safety"
        )
        body_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #FFF5F7; padding: 20px;">
  <div style="max-width: 520px; margin: auto; background: #ffffff; border-radius: 12px; border: 2px solid #2563EB; overflow: hidden; box-shadow: 0 4px 12px rgba(37,99,235,0.15);">
    <div style="background: #2563EB; color: #ffffff; padding: 18px 24px; text-align: center;">
      <h1 style="margin: 0; font-size: 20px;">📍 LIVE LOCATION SHARED</h1>
    </div>
    <div style="padding: 24px; color: #1F2937; line-height: 1.6;">
      <p style="font-size: 16px; margin-top: 0;"><strong>{user_name}</strong> is sharing her real-time location with you.</p>
      <p style="font-size: 13px; color: #4B5563;">Sharing Duration: <strong>{duration_str}</strong></p>
      <div style="text-align: center; margin: 24px 0;">
        <a href="{track_link}" style="background: #2563EB; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 700; display: inline-block;">🔴 Open Live Tracking</a>
        <a href="{maps_link}" style="background: #ffffff; color: #2563EB; border: 2px solid #2563EB; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 700; display: inline-block; margin-left: 8px;">📍 Google Maps</a>
      </div>
    </div>
    <div style="background: #EFF6FF; padding: 12px; text-align: center; font-size: 12px; color: #1E40AF; border-top: 1px solid #DBEAFE;">
      SafeHer Real-Time Protection Network
    </div>
  </div>
</body>
</html>"""
        for email in recipient_emails:
            send_email(email, subject, body_text, body_html)

    threading.Thread(target=worker, daemon=True).start()


def send_ride_started_email_notifications_background(ride_id, user_name, vehicle_type, vehicle_number, driver_name, driver_phone, app_used, pickup, destination, eta_mins, lat, lng, share_token, recipient_emails):
    """
    Send automated email notifications to contacts when user starts a monitored Ride.
    """
    if not recipient_emails:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_url = f"{frontend_url}/track.html?t={share_token}" if share_token else f"{frontend_url}/track.html"
        maps_url = f"https://www.google.com/maps?q={lat},{lng}" if (lat and lng) else ''
        driver_str = driver_name or 'Driver'
        if driver_phone:
            driver_str += f" (Tel: {driver_phone})"

        subject = f"🚖 SafeHer Ride Safety: {user_name} boarded {vehicle_type} ({vehicle_number})"
        body_text = (
            f"🚖 SAFEHER RIDE SAFETY NOTIFICATION 🚖\n\n"
            f"{user_name} has started a monitored {vehicle_type} ride via {app_used} and shared trip details with you:\n\n"
            f"Vehicle: {vehicle_number} ({vehicle_type})\n"
            f"Driver: {driver_str}\n"
            f"Pickup: {pickup}\n"
            f"Destination: {destination}\n"
            f"Estimated Travel Time: ~{eta_mins} mins\n\n"
            f"🔴 Live GPS Tracking Map:\n{track_url}\n\n"
            f"SafeHer is actively monitoring this trip. You will receive an immediate automated alert if an SOS occurs."
        )

        body_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #FFF5F7; padding: 20px;">
  <div style="max-width: 540px; margin: auto; background: #ffffff; border-radius: 12px; border: 2px solid #A80F3C; overflow: hidden; box-shadow: 0 4px 12px rgba(168,15,60,0.15);">
    <div style="background: #A80F3C; color: #ffffff; padding: 18px 24px; text-align: center;">
      <h1 style="margin: 0; font-size: 20px;">🚖 SAFEHER RIDE MONITORING</h1>
    </div>
    <div style="padding: 24px; color: #1F2937; line-height: 1.6;">
      <p style="font-size: 16px; margin-top: 0;"><strong>{user_name}</strong> has boarded a <strong>{vehicle_type}</strong> ({app_used}) and shared live trip details with you for safety.</p>
      <div style="background: #FCEFF3; border: 1px solid #F3C6D3; border-radius: 8px; padding: 14px; margin: 18px 0;">
        <div><strong>Vehicle:</strong> {vehicle_number} ({vehicle_type})</div>
        <div><strong>Driver:</strong> {driver_str}</div>
        <div><strong>Pickup:</strong> {pickup}</div>
        <div><strong>Destination:</strong> {destination}</div>
        <div><strong>ETA:</strong> ~{eta_mins} mins</div>
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <a href="{track_url}" style="background: #A80F3C; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 700; display: inline-block;">🔴 View Live Trip on Map</a>
      </div>
      <p style="font-size: 13px; color: #6B7280; text-align: center;">SafeHer is monitoring this trip. You will be automatically notified upon safe arrival or any emergency.</p>
    </div>
  </div>
</body>
</html>"""

        for email in recipient_emails:
            send_email(email, subject, body_text, body_html)

    threading.Thread(target=worker, daemon=True).start()


def send_ride_arrived_email_notifications_background(ride_id, user_name, destination, vehicle_number, recipient_emails):
    """
    Send automated email notification when user marks ride as reached safely.
    """
    if not recipient_emails:
        return

    def worker():
        subject = f"✅ REACHED SAFELY: {user_name} has arrived at destination"
        body_text = (
            f"✅ REACHED SAFELY - SafeHer Ride ✅\n\n"
            f"{user_name} has confirmed safe arrival at {destination}.\n"
            f"Vehicle: {vehicle_number}\n\n"
            f"The trip monitoring session has ended safely. Thank you for your support!"
        )
        body_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F0FDF4; padding: 20px;">
  <div style="max-width: 540px; margin: auto; background: #ffffff; border-radius: 12px; border: 2px solid #16A34A; overflow: hidden; box-shadow: 0 4px 12px rgba(22,163,74,0.15);">
    <div style="background: #16A34A; color: #ffffff; padding: 18px 24px; text-align: center;">
      <h1 style="margin: 0; font-size: 20px;">✅ RIDE COMPLETED &bull; REACHED SAFELY</h1>
    </div>
    <div style="padding: 24px; color: #1F2937; line-height: 1.6;">
      <p style="font-size: 16px; margin-top: 0;"><strong>{user_name}</strong> has confirmed safe arrival at <strong>{destination}</strong>.</p>
      <p style="font-size: 14px; color: #4B5563;">Vehicle {vehicle_number} trip monitoring has concluded. No further action needed.</p>
    </div>
  </div>
</body>
</html>"""
        for email in recipient_emails:
            send_email(email, subject, body_text, body_html)

    threading.Thread(target=worker, daemon=True).start()
