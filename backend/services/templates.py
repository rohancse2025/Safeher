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
            parsed = datetime.datetime.fromisoformat(dt.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                dt = parsed.replace(tzinfo=datetime.timezone.utc).astimezone(IST_TZ)
            else:
                dt = parsed.astimezone(IST_TZ)
        except Exception:
            try:
                parsed = datetime.datetime.strptime(dt, "%Y-%m-%d %H:%M:%S")
                dt = parsed.replace(tzinfo=datetime.timezone.utc).astimezone(IST_TZ)
            except Exception:
                dt = get_ist_now()

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
    .notice-info {{ background-color: #EFF6FF; border-left: 4px solid #3B82F6; padding: 12px 14px; font-size: 13px; color: #1E40AF; margin: 18px 0; border-radius: 0 6px 6px 0; }}
    .notice-warning {{ background-color: #FFFBEB; border-left: 4px solid #F59E0B; padding: 12px 14px; font-size: 13px; color: #92400E; margin: 18px 0; border-radius: 0 6px 6px 0; }}
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
    """
    user_name = context.get('user_name') or 'A SafeHer user'
    time_str = context.get('time_str') or format_ist_time()
    lat = context.get('lat')
    lng = context.get('lng')
    track_url = context.get('track_url') or 'https://rohancse2025.github.io/Safeher/track.html'
    optout_url = context.get('optout_url')
    mode = (context.get('mode') or 'normal').strip().lower()
    dest = context.get('destination') or 'Destination'

    map_url = None
    if lat is not None and lng is not None:
        try:
            f_lat, f_lng = float(lat), float(lng)
            map_url = f"https://www.google.com/maps?q={f_lat},{f_lng}"
        except (ValueError, TypeError):
            map_url = None

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
    time_short = time_str.split(' IST')[0]

    norm_event = str(event_type).strip().lower()

    # 1. Alert Created (normal, silent, emergency, or generic alert_created / sos)
    if norm_event in ('alert_created', 'sos', 'emergency', 'silent', 'normal'):
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

    # 2. Alert Uneasy (Quiet Check-in)
    elif norm_event in ('alert_uneasy', 'uneasy'):
        subject = f"SafeHer: {user_name} is feeling unsafe ({time_short})"
        preview = f"{user_name} activated Uneasy Mode and requested monitoring."
        body_text = (
            f"SafeHer Safety Notice – Uneasy Check-in\n\n"
            f"{user_name} is in an uncomfortable or uneasy situation and requested safety monitoring.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">{user_name} requested safety check-in</h2>
              <div class="notice-warning">
                <strong>Uneasy Mode:</strong> {user_name} is feeling unsafe and requested monitoring at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">Please keep your phone handy and check her location below.</p>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 3. Alert Escalated
    elif norm_event in ('alert_escalated', 'escalated'):
        subject = f"SafeHer: {user_name} alert escalated (Emergency at {time_short})"
        preview = f"{user_name}'s safety status escalated to an Emergency SOS."
        body_text = (
            f"SafeHer Safety Alert – Escalated\n\n"
            f"{user_name}'s safety alert has been escalated to an Emergency SOS.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Alert Escalated to Emergency</h2>
              <div class="notice">
                <strong>Immediate Attention:</strong> {user_name}'s situation has escalated to an Emergency SOS at {time_str}.
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 4. Alert Ended / Safe
    elif norm_event in ('alert_ended', 'sos_safe', 'alert_resolved', 'safe'):
        subject = f"SafeHer: {user_name} is safe (Alert ended)"
        preview = f"{user_name} has marked herself safe."
        body_text = (
            f"SafeHer Safety Update\n\n"
            f"{user_name} has confirmed she is safe and the alert has ended.\n"
            f"Time: {time_str}\n\n"
            f"No further emergency action is required."
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
                <strong>Status Update:</strong> {user_name} confirmed she is safe at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">The safety alert has ended. No further action is required.</p>
            """
        )

    # 5. Volunteer Coming
    elif norm_event in ('volunteer_coming', 'volunteer_responding'):
        vol_name = context.get('volunteer_name') or 'A verified community volunteer'
        subject = f"SafeHer: Verified volunteer responding to {user_name}'s alert"
        preview = f"{vol_name} has confirmed they are on their way to assist {user_name}."
        body_text = (
            f"SafeHer Volunteer Response Update\n\n"
            f"{vol_name} has confirmed they are on their way to assist {user_name}.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Volunteer On The Way</h2>
              <div class="notice-info">
                <strong>Community Responder:</strong> {vol_name} has confirmed response to {user_name}'s alert at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">They are proceeding towards {user_name}'s location.</p>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 6. Escort Started
    elif norm_event in ('escort_started', 'escort_start'):
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

    # 7. Escort Arrived Safely
    elif norm_event in ('escort_arrived', 'escort_safe'):
        subject = f"SafeHer: {user_name} arrived safely at {dest}"
        preview = f"{user_name} safely reached {dest}."
        body_text = (
            f"SafeHer Journey Update\n\n"
            f"{user_name} has arrived safely at {dest}.\n"
            f"Time: {time_str}\n\n"
            f"Journey monitoring has concluded safely."
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
                <strong>Arrival Confirmed:</strong> {user_name} reached <strong>{dest}</strong> safely at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">Journey monitoring has concluded safely.</p>
            """
        )

    # 8. Escort Off Route
    elif norm_event in ('escort_off_route', 'route_deviation'):
        subject = f"SafeHer: {user_name} moved off route ({dest})"
        preview = f"SafeHer detected {user_name} has moved away from the planned route to {dest}."
        body_text = (
            f"SafeHer Journey Alert – Off Route\n\n"
            f"{user_name} has deviated from the planned route towards {dest}.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Off-Route Alert</h2>
              <div class="notice">
                <strong>Route Deviation:</strong> {user_name} has moved off the planned route towards <strong>{dest}</strong> at {time_str}.
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 9. Escort Missed Check-in
    elif norm_event in ('escort_missed_checkin', 'missed_checkin'):
        subject = f"SafeHer: {user_name} missed scheduled check-in"
        preview = f"{user_name} did not answer a scheduled safety check-in."
        body_text = (
            f"SafeHer Journey Alert – Missed Check-in\n\n"
            f"{user_name} did not answer a scheduled safety check-in while traveling to {dest}.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Missed Safety Check-in</h2>
              <div class="notice">
                <strong>Attention:</strong> {user_name} did not confirm her scheduled check-in at {time_str}.
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 10. Escort No Signal
    elif norm_event in ('escort_no_signal', 'no_signal'):
        subject = f"SafeHer: No signal from {user_name}'s device"
        preview = f"SafeHer has not received GPS updates from {user_name}'s phone."
        body_text = (
            f"SafeHer Journey Alert – No Signal\n\n"
            f"SafeHer has not received location updates from {user_name}'s device for an extended period.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Device Signal Lost</h2>
              <div class="notice-warning">
                <strong>No Location Updates:</strong> No GPS signal received from {user_name}'s device as of {time_str}.
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 11. Escort Late Arrival
    elif norm_event in ('escort_late_arrival', 'late_arrival'):
        subject = f"SafeHer: {user_name} overdue at destination"
        preview = f"{user_name} has not arrived at {dest} by expected arrival time."
        body_text = (
            f"SafeHer Journey Alert – Late Arrival\n\n"
            f"{user_name} has not confirmed arrival at {dest} and is past expected arrival time.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Journey Overdue</h2>
              <div class="notice">
                <strong>Late Arrival:</strong> {user_name} has not checked in at <strong>{dest}</strong> past the scheduled arrival time ({time_str}).
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 12. Escort Ended
    elif norm_event in ('escort_ended', 'escort_end'):
        subject = f"SafeHer: {user_name} ended journey escort"
        preview = f"{user_name} has ended journey monitoring."
        body_text = (
            f"SafeHer Journey Update\n\n"
            f"{user_name} has concluded her journey monitoring session.\n"
            f"Time: {time_str}\n"
            f"{make_optout_text()}"
        )
        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Journey Escort Ended</h2>
              <p style="margin: 0 0 12px 0; color: #4B5563;">{user_name} ended the journey monitoring session at {time_str}.</p>
            """
        )

    # 13. Safety Timer Expired
    elif norm_event in ('timer_expired', 'timer_alert'):
        subject = f"SafeHer: {user_name} timer expired without check-in"
        preview = f"{user_name}'s safety timer expired without a confirmation check-in."
        body_text = (
            f"SafeHer Safety Alert – Timer Expired\n\n"
            f"{user_name}'s safety timer has expired without a safe check-in.\n"
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
                <strong>Attention:</strong> {user_name}'s countdown timer reached zero without a check-in at {time_str}.
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 13b. Safety Timer Start
    elif norm_event == 'timer_start':
        minutes = context.get('minutes') or 15
        subject = f"SafeHer: {user_name} set a {minutes}-min safety timer"
        preview = f"{user_name} activated a {minutes}-min safety timer."
        body_text = (
            f"SafeHer Safety Timer\n\n"
            f"{user_name} set a {minutes}-minute safety timer at {time_str}.\n"
            f"If she does not check in before expiration, SafeHer will automatically alert you.\n\n"
            f"{call_112_text}"
            f"{make_optout_text()}"
        )
        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Safety Timer Started</h2>
              <p style="margin: 0 0 16px 0; color: #4B5563;">{user_name} set a <strong>{minutes}-minute</strong> safety timer at {time_str}.</p>
              {call_112_html}
            """
        )

    # 13c. Safety Timer Safe
    elif norm_event == 'timer_safe':
        subject = f"SafeHer: {user_name} checked in safely (Timer stopped)"
        preview = f"{user_name} disarmed her safety timer."
        body_text = (
            f"SafeHer Safety Timer Disarmed\n\n"
            f"{user_name} safely checked in and stopped her safety timer at {time_str}.\n"
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
                <strong>Check-in Confirmed:</strong> {user_name} safely disarmed her timer at {time_str}.
              </div>
            """
        )

    # 14. Live Location Sharing Start
    elif norm_event in ('share_started', 'share_start'):
        duration_str = context.get('duration_str') or '1 hour'
        subject = f"SafeHer: {user_name} shared live location ({duration_str})"
        preview = f"{user_name} is sharing real-time location with you."
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

    # 15. Live Location Sharing Stop
    elif norm_event in ('share_ended', 'share_stop'):
        subject = f"SafeHer: {user_name} stopped sharing location"
        preview = f"{user_name} ended live location sharing."
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
              <p style="margin: 0 0 12px 0; color: #4B5563;">{user_name} concluded live location sharing at {time_str}.</p>
            """
        )

    # 16. Ride Safety Started
    elif norm_event in ('ride_started', 'ride_start'):
        v_type = context.get('vehicle_type') or 'Cab'
        v_num = context.get('vehicle_number') or ''
        vehicle_desc = f"{v_type} {v_num}".strip()
        dest_desc = f" to {dest}" if dest and dest != 'Destination' else ""
        subject = f"SafeHer: {user_name} started a ride ({vehicle_desc})"
        preview = f"{user_name} boarded a ride{dest_desc} and started safety monitoring."
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

    # 17. Ride Safety Ended
    elif norm_event in ('ride_ended', 'ride_safe'):
        dest_desc = f" at {dest}" if dest and dest != 'Destination' else ""
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
                <strong>Status:</strong> {user_name} reached destination safely at {time_str}.
              </div>
              <p style="margin: 12px 0 0 0; color: #4B5563;">Ride monitoring has ended safely.</p>
            """
        )

    # 18. Ride Late
    elif norm_event in ('ride_late', 'ride_overdue'):
        subject = f"SafeHer: {user_name}'s ride is overdue"
        preview = f"{user_name}'s ride is past expected arrival time."
        body_text = (
            f"SafeHer Ride Alert – Overdue\n\n"
            f"{user_name}'s ride is past expected arrival time and has not checked in as completed.\n"
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
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Ride Overdue Alert</h2>
              <div class="notice">
                <strong>Attention:</strong> {user_name}'s ride is past the expected arrival time at {time_str}.
              </div>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 20. Alert Reminder (at 3 min & 10 min)
    elif norm_event in ('alert_reminder', 'reminder', 'alert_reminder_1', 'alert_reminder_2'):
        alert_time_ist = context.get('alert_time_ist') or time_short
        subject = f"SafeHer: Reminder - {user_name}'s alert is still active (from {alert_time_ist})"
        preview = f"Reminder: {user_name}'s alert from {alert_time_ist} is still active."
        body_text = (
            f"Reminder: {user_name}'s alert from {alert_time_ist} is still active.\n\n"
            f"Open her live location here:\n{track_url or map_url}\n\n"
            f"If you cannot reach her, call 112.\n"
            f"{make_optout_text()}"
        )
        body_html = build_base_html(
            subject=subject,
            preview_text=preview,
            user_name=user_name,
            optout_url=optout_url,
            content_html=f"""
              <h2 style="font-size: 18px; margin: 0 0 10px 0; color: #111827; font-weight: 600;">Alert Still Active</h2>
              <div class="notice">
                <strong>Reminder:</strong> {user_name}'s alert from {alert_time_ist} is still active and waiting for a response.
              </div>
              <p style="margin: 14px 0 0 0; color: #374151; font-size: 13px;">Please check on her immediately using the live location below.</p>
              {make_links_html()}
              {call_112_html}
            """
        )

    # 19. Contact Added / Welcome
    elif norm_event in ('contact_added', 'welcome'):
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
