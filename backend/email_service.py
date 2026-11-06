# backend/email_service.py – Email notifications via Gmail SMTP with background threading
import os
import smtplib
import threading
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

from db import get_db
from logger import app_logger, mask_email

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()


def send_email(to_email, subject, body_text, body_html=None):
    """
    Send an email using Gmail SMTP (smtp.gmail.com:587 with STARTTLS).
    Supports multipart plain text + rich HTML styling.
    Returns (True, None) on success, or (False, error_message) on failure.
    """
    smtp_user = os.getenv('EMAIL_ADDRESS', '').strip()
    smtp_pass = os.getenv('EMAIL_APP_PASSWORD', '').strip()

    if not smtp_user or not smtp_pass:
        return False, "EMAIL_ADDRESS or EMAIL_APP_PASSWORD is not configured in .env"

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

        with smtplib.SMTP('smtp.gmail.com', 587, timeout=15) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)

        return True, None
    except Exception as e:
        err_msg = str(e)
        print(f"[EmailService Error] Failed to send email to {to_email}: {err_msg}")
        return False, err_msg


def send_alert_notifications_background(alert_id, user_name, mode, started_at_str, lat, lng, share_token, recipient_emails, note=None, contact_tokens=None):
    """
    Send alert emails to contacts in a background thread so the HTTP API responds immediately.
    Logs failures without crashing and updates notified_count in SQLite.
        """
    if not recipient_emails:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_link = f"{frontend_url}/track.html?t={share_token}"
        maps_link = f"https://www.google.com/maps?q={lat},{lng}"
        subject = f"🚨 EMERGENCY SOS: {user_name} needs urgent help!"
        body_text = (
            f"🚨 EMERGENCY SOS ALERT - SafeHer 🚨\n\n"
            f"{user_name} has triggered an urgent SOS alert!\n\n"
            f"Mode: {mode.upper()}\n"
            f"Time: {started_at_str}\n"
            f"Coordinates: {lat}, {lng}\n\n"
            f"🔴 Live GPS Tracking Link:\n{track_link}\n\n"
            f"📍 Google Maps Location:\n{maps_link}\n\n"
            f"Please contact {user_name} immediately or call Police (112)."
        )

        body_html = f"""<!DOCTYPE html>
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

      <div class="btn-container">
        <a href="{track_link}" class="btn btn-track" target="_blank" rel="noopener">🔴 Open Live Tracking</a>
        <a href="{maps_link}" class="btn btn-maps" target="_blank" rel="noopener">📍 View on Google Maps</a>
      </div>

      <p style="color: #DC2626; font-size: 13px; font-weight: 600; text-align: center; margin-top: 20px;">
        ⚠️ Please contact {user_name} immediately or dial 112 (Police) if they do not answer.
      </p>
    </div>
    <div class="footer">
      Sent automatically by SafeHer Women's Safety Network &bull; Do not reply to this email.
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
            per_body_text = body_text.replace(track_link, per_track_link)
            per_body_html = body_html.replace(track_link, per_track_link)
            masked_to = mask_email(email)
            success, err_msg = send_email(email, subject, per_body_text, per_body_html)
            if success:
                sent_count += 1
                app_logger.info(f"[EMAIL SENT] alert_id={alert_id}, to={masked_to}")
            else:
                app_logger.error(f"[EMAIL FAILED] alert_id={alert_id}, to={masked_to}, error={err_msg}")

        # Update notified_count in database in this thread's own connection
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute('UPDATE alerts SET notified_count = ? WHERE id = ?;', (sent_count, alert_id))
            conn.commit()
            conn.close()
        except Exception as db_err:
            print(f"[EmailService DB Error] Could not update notified_count for alert {alert_id}: {db_err}")

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
