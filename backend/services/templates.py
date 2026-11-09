# backend/services/templates.py – Calm, clear email templates for SafeHer events
import datetime
from urllib.parse import quote

# IST Timezone (UTC + 5:30)
IST_OFFSET = datetime.timedelta(hours=5, minutes=30)
IST_TZ = datetime.timezone(IST_OFFSET, 'IST')


def get_ist_now():
    """Return current datetime in Indian Standard Time (IST)."""
    return datetime.datetime.now(datetime.timezone.utc).astimezone(IST_TZ)


def format_ist_time(dt=None):
    """Format datetime into a calm, human-friendly IST string like '9:42 PM IST, 9 Nov 2026'."""
    if dt is None:
        dt = get_ist_now()
    elif isinstance(dt, str):
        try:
            # Parse ISO or standard string
            parsed = datetime.datetime.fromisoformat(dt.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                dt = parsed.replace(tzinfo=datetime.timezone.utc).astimezone(IST_TZ)
            else:
                dt = parsed.astimezone(IST_TZ)
        except Exception:
            dt = get_ist_now()

    # Format like '9:42 PM IST' or '9:42 PM IST, 9 Nov 2026'
    time_part = dt.strftime("%I:%M %p").lstrip('0')
    date_part = dt.strftime("%d %b %Y")
    return f"{time_part} IST, {date_part}"


def build_base_html(subject, preview_text, content_html, optout_url=None, user_name="the user"):
    """
    Wrap content in a clean, high-deliverability HTML layout.
    Avoids spam triggers, uses neutral colors, and provides an accessible unsubscribe footer.
    """
    optout_html = ""
    if optout_url:
        optout_html = f"""
        <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #E5E7EB; font-size: 11px; color: #6B7280; line-height: 1.5; text-align: center;">
          <p style="margin: 0 0 6px 0;">You are receiving this alert because {user_name} designated you as a trusted safety contact on SafeHer.</p>
          <p style="margin: 0;">If you received this in error, you can <a href="{optout_url}" style="color: #6B7280; text-decoration: underline;">opt out of alerts here</a>.</p>
        </div>
        """

    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F9FAFB; color: #1F2937; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }}
    .container {{ max-width: 560px; margin: 20px auto; background-color: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; }}
    .header {{ padding: 18px 24px; border-bottom: 1px solid #F3F4F6; background-color: #FFFFFF; }}
    .logo {{ font-size: 16px; font-weight: 700; color: #9E1B32; letter-spacing: -0.3px; text-decoration: none; }}
    .body {{ padding: 24px; font-size: 14px; line-height: 1.6; color: #374151; }}
    .card {{ background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 14px 16px; margin: 16px 0; }}
    .btn {{ display: inline-block; padding: 10px 20px; font-size: 13px; font-weight: 600; text-decoration: none; border-radius: 6px; }}
    .btn-primary {{ background-color: #9E1B32; color: #FFFFFF !important; }}
    .btn-secondary {{ background-color: #F3F4F6; color: #374151 !important; border: 1px solid #D1D5DB; margin-left: 8px; }}
    .notice {{ background-color: #FEF2F2; border-left: 4px solid #DC2626; padding: 12px 14px; font-size: 13px; color: #991B1B; margin: 18px 0; border-radius: 0 6px 6px 0; }}
    .notice-safe {{ background-color: #F0FDF4; border-left: 4px solid #16A34A; padding: 12px 14px; font-size: 13px; color: #166534; margin: 18px 0; border-radius: 0 6px 6px 0; }}
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#F9FAFB;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    {preview_text}
  </div>
  <div class="container">
    <div class="header">
      <span class="logo">SafeHer Safety Alert</span>
    </div>
    <div class="body">
      {content_html}
      {optout_html}
    </div>
  </div>
</body>
</html>"""


def render_template(event_type, context):
    """
    Renders (subject, body_text, body_html) for a given event_type.
    Context keys:
      - user_name: str
      - time_str: str (optional, defaults to now in IST)
      - lat, lng: float (optional)
      - track_url: str (optional)
      - destination: str (optional)
      - vehicle_type, vehicle_number, app_used: str (optional)
      - minutes: int (optional)
      - optout_url: str (optional)
      - note, reason: str (optional)
    """
    user_name = context.get('user_name') or 'A SafeHer user'
    time_str = context.get('time_str') or format_ist_time()
    lat = context.get('lat')
    lng = context.get('lng')
    track_url = context.get('track_url') or 'https://rohancse2025.github.io/Safeher/track.html'
    optout_url = context.get('optout_url')

    map_url = None
    if lat is not None and lng is not None:
        try:
            f_lat, f_lng = float(lat), float(lng)
            map_url = f"https://www.google.com/maps?q={f_lat},{f_lng}"
        except (ValueError, TypeError):
            map_url = None

    # Helper text blocks
    def make_links_text():
        lines = []
        if map_url:
            lines.append(f"Map Location: {map_url}")
        if track_url:
            lines.append(f"Live Tracking: {track_url}")
        return "\n".join(lines)

    def make_links_html():
        buttons = []
        if track_url:
            buttons.append(f'<a href="{track_url}" class="btn btn-primary" target="_blank">View Live Tracking</a>')
        if map_url:
            buttons.append(f'<a href="{map_url}" class="btn btn-secondary" target="_blank">Google Maps</a>')
        if not buttons:
            return ""
        return f'<div style="margin: 20px 0 16px 0;">{" ".join(buttons)}</div>'

    def make_optout_text():
        if optout_url:
            return f"\n\nYou are receiving this because {user_name} listed you as an emergency contact.\nTo opt out of future alerts, visit: {optout_url}"
        return ""

    call_112_text = "If you cannot reach her, call 112."
    call_112_html = '<div class="notice"><strong>Emergency Helpline:</strong> If you cannot reach her, call 112.</div>'

    # 1. SOS Alert
    if event_type in ('sos', 'emergency', 'silent', 'uneasy'):
        time_short = time_str.split(' IST')[0]
        subject = f"SafeHer: {user_name} needs help (SOS at {time_short})"
        preview = f"{user_name} has triggered an urgent safety alert on SafeHer."
        
        body_text = (
            f"SafeHer Safety Alert\n\n"
            f"{user_name} has triggered an emergency SOS alert.\n"
            f"Time: {time_str}\n\n"
            f"{make_links_text()}\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">{user_name} needs help</h2>
              <p style="margin: 0 0 16px 0; color: #4B5563;">{user_name} has triggered an emergency SOS alert at {time_str}.</p>
              
              <div class="card">
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 4px;">Alert Time</div>
                <div style="font-weight: 600; color: #111827;">{time_str}</div>
              </div>

              {make_links_html()}
              {call_112_html}
            """
        )

    # 2. SOS Safe / Resolved
    elif event_type in ('sos_safe', 'alert_resolved', 'safe'):
        subject = f"SafeHer: {user_name} is safe (SOS resolved)"
        preview = f"{user_name} has marked herself safe."

        body_text = (
            f"SafeHer Safety Update\n\n"
            f"{user_name} has resolved the emergency alert and marked herself safe.\n"
            f"Time: {time_str}\n\n"
            f"No further action is required."
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">{user_name} is safe</h2>
              <div class="notice-safe">
                <strong>Status Update:</strong> {user_name} has resolved the emergency alert at {time_str} and checked in safely.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">No further action is required on your part.</p>
            """
        )

    # 3. Escort Journey Start
    elif event_type == 'escort_start':
        dest = context.get('destination') or 'Destination'
        subject = f"SafeHer: {user_name} started a journey to {dest}"
        preview = f"{user_name} is using Escort Mode for journey monitoring."

        body_text = (
            f"SafeHer Journey Monitoring\n\n"
            f"{user_name} has started an escorted journey to {dest}.\n"
            f"Time: {time_str}\n\n"
            f"{make_links_text()}\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Journey Monitoring Started</h2>
              <p style="margin: 0 0 16px 0; color: #4B5563;">{user_name} has started a monitored journey to <strong>{dest}</strong>.</p>
              
              <div class="card">
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Destination</div>
                <div style="font-weight: 600; color: #111827; margin-bottom: 8px;">{dest}</div>
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Started At</div>
                <div style="font-weight: 600; color: #111827;">{time_str}</div>
              </div>

              {make_links_html()}
              {call_112_html}
            """
        )

    # 4. Escort Arrived Safely
    elif event_type == 'escort_safe':
        dest = context.get('destination') or 'Destination'
        subject = f"SafeHer: {user_name} arrived safely at {dest}"
        preview = f"{user_name} has safely arrived at her destination."

        body_text = (
            f"SafeHer Journey Update\n\n"
            f"{user_name} has arrived safely at {dest}.\n"
            f"Time: {time_str}\n\n"
            f"The journey monitoring session has concluded safely."
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Arrived Safely</h2>
              <div class="notice-safe">
                <strong>Arrival Confirmed:</strong> {user_name} safely reached <strong>{dest}</strong> at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">Journey monitoring has ended safely.</p>
            """
        )

    # 5. Escort Route / Check-in Alert
    elif event_type == 'escort_alert':
        reason = context.get('reason') or 'Route deviation or missed check-in'
        subject = f"SafeHer: {user_name} journey alert ({reason})"
        preview = f"Alert during {user_name}'s journey: {reason}."

        body_text = (
            f"SafeHer Journey Alert\n\n"
            f"{user_name}'s journey has triggered an alert: {reason}.\n"
            f"Time: {time_str}\n\n"
            f"{make_links_text()}\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Journey Safety Alert</h2>
              <div class="notice">
                <strong>Trigger:</strong> {reason} at {time_str}.
              </div>
              
              {make_links_html()}
              {call_112_html}
            """
        )

    # 6. Live Location Sharing Start
    elif event_type == 'share_start':
        duration_str = context.get('duration_str') or '1 hour'
        subject = f"SafeHer: {user_name} shared live location ({duration_str})"
        preview = f"{user_name} is sharing her real-time location with you."

        body_text = (
            f"SafeHer Live Location Sharing\n\n"
            f"{user_name} has started sharing her live location with you for {duration_str}.\n"
            f"Time: {time_str}\n\n"
            f"{make_links_text()}\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Live Location Shared</h2>
              <p style="margin: 0 0 16px 0; color: #4B5563;">{user_name} is sharing her live location with you for {duration_str}.</p>
              
              <div class="card">
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Duration</div>
                <div style="font-weight: 600; color: #111827; margin-bottom: 8px;">{duration_str}</div>
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Shared At</div>
                <div style="font-weight: 600; color: #111827;">{time_str}</div>
              </div>

              {make_links_html()}
              {call_112_html}
            """
        )

    # 7. Live Location Sharing Stop
    elif event_type == 'share_stop':
        subject = f"SafeHer: {user_name} stopped sharing location"
        preview = f"{user_name} has ended live location sharing."

        body_text = (
            f"SafeHer Location Sharing Ended\n\n"
            f"{user_name} has stopped sharing her live location.\n"
            f"Time: {time_str}\n"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Location Sharing Ended</h2>
              <p style="margin: 0 0 12px 0; color: #4B5563;">{user_name} has concluded her live location sharing session at {time_str}.</p>
            """
        )

    # 8. Safety Timer Start
    elif event_type == 'timer_start':
        minutes = context.get('minutes') or 15
        subject = f"SafeHer: {user_name} set a {minutes}-min safety timer"
        preview = f"{user_name} has activated a safety countdown timer."

        body_text = (
            f"SafeHer Safety Timer\n\n"
            f"{user_name} has set a {minutes}-minute safety timer.\n"
            f"Started: {time_str}\n"
            f"If she does not disarm the timer within {minutes} minutes, SafeHer will automatically alert you with her location.\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Safety Timer Activated</h2>
              <p style="margin: 0 0 16px 0; color: #4B5563;">{user_name} has started a <strong>{minutes}-minute</strong> safety timer.</p>
              
              <div class="card">
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Duration</div>
                <div style="font-weight: 600; color: #111827; margin-bottom: 8px;">{minutes} minutes</div>
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Started At</div>
                <div style="font-weight: 600; color: #111827;">{time_str}</div>
              </div>

              <p style="font-size: 13px; color: #4B5563;">SafeHer will automatically dispatch an emergency alert with her coordinates if she does not check in before the timer expires.</p>
              {call_112_html}
            """
        )

    # 9. Safety Timer Safe / Disarmed
    elif event_type == 'timer_safe':
        subject = f"SafeHer: {user_name} checked in safely (Timer stopped)"
        preview = f"{user_name} disarmed her safety timer."

        body_text = (
            f"SafeHer Safety Timer Disarmed\n\n"
            f"{user_name} has safely checked in and stopped her safety timer.\n"
            f"Time: {time_str}\n\n"
            f"No action is required."
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Safety Timer Disarmed</h2>
              <div class="notice-safe">
                <strong>Check-in Confirmed:</strong> {user_name} safely disarmed her safety timer at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">No further action is required.</p>
            """
        )

    # 10. Safety Timer Expired
    elif event_type == 'timer_expired':
        subject = f"SafeHer: {user_name} timer expired without check-in"
        preview = f"{user_name}'s safety timer expired without a safe check-in."

        body_text = (
            f"SafeHer Safety Alert – Timer Expired\n\n"
            f"{user_name}'s safety timer has expired without a check-in.\n"
            f"Time: {time_str}\n\n"
            f"{make_links_text()}\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Safety Timer Expired</h2>
              <div class="notice">
                <strong>Attention:</strong> {user_name}'s safety timer expired without a confirmation check-in at {time_str}.
              </div>
              
              {make_links_html()}
              {call_112_html}
            """
        )

    # 11. Monitored Ride Start
    elif event_type == 'ride_start':
        v_type = context.get('vehicle_type') or 'Cab'
        v_num = context.get('vehicle_number') or ''
        vehicle_desc = f"{v_type} {v_num}".strip()
        dest = context.get('destination') or ''
        dest_desc = f" to {dest}" if dest else ""

        subject = f"SafeHer: {user_name} started a ride ({vehicle_desc})"
        preview = f"{user_name} has boarded a ride{dest_desc} and started safety monitoring."

        body_text = (
            f"SafeHer Monitored Ride\n\n"
            f"{user_name} has started a monitored ride{dest_desc}.\n"
            f"Vehicle: {vehicle_desc}\n"
            f"Time: {time_str}\n\n"
            f"{make_links_text()}\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Monitored Ride Started</h2>
              <p style="margin: 0 0 16px 0; color: #4B5563;">{user_name} has boarded a ride{dest_desc}.</p>
              
              <div class="card">
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Vehicle</div>
                <div style="font-weight: 600; color: #111827; margin-bottom: 8px;">{vehicle_desc}</div>
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Started At</div>
                <div style="font-weight: 600; color: #111827;">{time_str}</div>
              </div>

              {make_links_html()}
              {call_112_html}
            """
        )

    # 12. Monitored Ride Safe
    elif event_type == 'ride_safe':
        dest = context.get('destination') or ''
        dest_desc = f" at {dest}" if dest else ""
        subject = f"SafeHer: {user_name} reached destination safely"
        preview = f"{user_name} completed her ride safely."

        body_text = (
            f"SafeHer Ride Complete\n\n"
            f"{user_name} has completed her ride safely{dest_desc}.\n"
            f"Time: {time_str}\n\n"
            f"Ride monitoring has concluded safely."
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Ride Completed Safely</h2>
              <div class="notice-safe">
                <strong>Status:</strong> {user_name} reached her destination safely at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">Ride monitoring has ended safely.</p>
            """
        )

    # 13. Welcome / Consent Notice
    elif event_type == 'welcome':
        subject = f"SafeHer: {user_name} added you as a trusted safety contact"
        preview = f"{user_name} added you as an emergency contact on SafeHer."

        body_text = (
            f"SafeHer Safety Notice\n\n"
            f"{user_name} added you as a trusted contact for SafeHer alerts.\n\n"
            f"If {user_name} ever triggers an SOS or uses journey monitoring, you will receive real-time alerts with her coordinates and a live tracking link.\n\n"
            f"If you did not expect this or do not wish to receive alerts, you can opt out anytime here:\n"
            f"{optout_url or 'https://rohancse2025.github.io/Safeher'}\n"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Trusted Safety Contact Confirmation</h2>
              <p style="margin: 0 0 14px 0; color: #374151;"><strong>{user_name}</strong> has added you as a trusted emergency contact on SafeHer.</p>
              
              <div class="card">
                <p style="margin: 0; font-size: 13px; color: #4B5563; line-height: 1.5;">
                  As an emergency contact, you will receive automated notifications with map coordinates and a live tracking link whenever {user_name} triggers an SOS or uses journey escort features.
                </p>
              </div>

              <p style="font-size: 13px; color: #6B7280; margin: 16px 0 0 0;">
                If you did not agree to this or prefer not to receive alerts, you can opt out anytime below.
              </p>
            """
        )

    # Fallback generic
    else:
        subject = f"SafeHer: Notification from {user_name}"
        preview = f"Notification from SafeHer for {user_name}."
        note = context.get('note') or 'Safety alert notification'

        body_text = (
            f"SafeHer Notification\n\n"
            f"{user_name}: {note}\n"
            f"Time: {time_str}\n\n"
            f"{make_links_text()}\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )

        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">SafeHer Safety Notification</h2>
              <p style="margin: 0 0 16px 0; color: #4B5563;">{note}</p>
              <div class="card">
                <div style="font-size: 13px; color: #6B7280; margin-bottom: 2px;">Time</div>
                <div style="font-weight: 600; color: #111827;">{time_str}</div>
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    return subject, body_text.strip(), body_html.strip()
