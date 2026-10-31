# SafeHer — Women Safety and Emergency Alert Web App

## Team

| Name | Role |
|------|------|
| Rohan P | Developer |
| Pooja M B | Developer |
| Preetem M H | Developer |

**Institution:** Department of Computer Science and Engineering, CMRIT, Bengaluru  
**Course:** Mini Project, 2nd Year B.E. (CSE), 2024–25

---

## Project Description

SafeHer is a mobile-first women's safety web app that runs entirely in a phone browser. No installation, no server, no build step required. Open `index.html` to start.

---

## How to Run

1. Clone or download this repository.
2. Open `index.html` in a mobile browser (Chrome recommended).
3. Allow location access when prompted for the SOS feature to work.

---

## File Structure

```
Safeher/
├── index.html       ← All screens (single-page app)
├── css/
│   └── style.css    ← All styles
├── js/
│   └── app.js       ← All logic
└── README.md
```

---

## Feature List

### Working Features (fully functional)

| Feature | Details |
|---------|---------|
| **SOS Alert** | Press the SOS button to start a 5-second countdown (with Cancel). On expiry, gets GPS location via browser Geolocation API. Falls back to default Bengaluru coordinates (12.9716, 77.5946) if permission is denied. Shows an SOS-sent screen with the exact time, a Google Maps link, and the names of all saved contacts. |
| **Contacts** | Add trusted contacts (name, phone, email). Listed in a table with a Delete button. Saved in `localStorage` — survives page refresh. Contact names are read by the SOS screen. |

### Screen-Only Features (realistic sample data, no backend)

| Feature | Details |
|---------|---------|
| Login / Register | Accepts any input and navigates to the Home screen. |
| Live Location | Map placeholder box with a sample Google Maps link for Bengaluru (12.9716, 77.5946). |
| Nearby Police & Hospitals | Table with 5 sample Bengaluru entries — 3 police stations and 2 hospitals. |
| Helplines | Tap-to-call links: 112, 181, 1091, 100, 108, 1098. |
| Volunteer Mode | Toggle between Available / Unavailable. Shows a sample alert card (Lakshmi R., Silk Board) with an "I'm Coming" button. |
| Safe-Arrival Timer | Set minutes, live countdown display, "I'm Safe" button. Display only — no backend alert. |
| Fake Call | Incoming call screen (Mom, +91 98765 43210) with Accept and Decline. Accept shows a call-in-progress screen. |
| Language Settings | Switches nav labels, all screen headings, and SOS button text to English, Kannada (ಕನ್ನಡ), or Hindi (हिन्दी) using a JavaScript translations object. |

---

## Tech Stack

- HTML5
- CSS3 (no frameworks)
- Vanilla JavaScript (no libraries or build tools)
- Browser APIs used: Geolocation, localStorage
