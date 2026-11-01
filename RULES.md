# SafeHer – Project Rules

## Project
SafeHer, a Women Safety and Emergency Alert web app for mobile browsers.

## Stack
Vanilla HTML, CSS and JavaScript only. No frameworks, no npm, no build tools, no ES modules (it must run by opening index.html).

**File structure:**
- `index.html`
- `css/style.css`
- `js/` — one file per feature
- `assets/`

One global object `SafeHer` for shared code. All data reads and writes go through `js/api.js`, which uses localStorage through `js/storage.js` for now. Put a comment on each api function naming the backend endpoint that will replace it later.

## Look
Simple, plain and hand-built, not a polished template. Mobile-first, centered column max-width 400px on desktop. Font: Poppins. Icons: Material Symbols Rounded.

**Colours:**
- Primary crimson: `#A80F3C`
- Light pink (tiles/backgrounds): `#FCEFF3`
- Cards: white
- Dark text: `#333`
- Gray text: `#777`

**Design rules — flat only:**
- 1px borders (`#EAD3DA`)
- No drop shadows, no glow, no blur, no gradients, no glass effects, no emojis
- Buttons: 6px radius
- Tiles: 8px radius

**SOS button:** solid crimson circle with two plain flat rings around it (2px borders in lighter pinks); one slow pulse is the only animation, apart from screen fades.

**Wording:** plain and short ("Add Contact", "Send OTP", "Next"). Use the same layout patterns on every screen.

**Images:** use from `assets/` where they exist; fall back to a light pink box with an icon if one is missing.

## Quality
- Every button must work or show a short toast message.
- Validate inputs with clear inline errors.
- Nothing may overlap or get cut off at 380px wide.
- Short, simple code: short functions, no classes.
- Don't add features that weren't requested.
- Don't add any names of people, colleges or departments anywhere in the app.
- After every task, fix browser console errors and summarise the changes in 3 lines.
