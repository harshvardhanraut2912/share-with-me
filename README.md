# sharewithme

A minimal WhatsApp-style app for direct file transfer:
- Sign in with Google
- Claim an address like `yourname@sharewithme`
- Search someone else's address, send a connect request
- Once they accept, files move **peer-to-peer over WebRTC** — encrypted in transit,
  never uploaded to any server, never seen by Firebase or Netlify.

Firebase is used only for two small things: Google login, and passing tiny
"A wants to connect to B" / WebRTC handshake messages. It never touches your
file contents.

---

## 1. Create a free Firebase project (this is where your Google login lives)

1. Go to https://console.firebase.google.com → **Add project** → give it any name → finish the wizard.
2. In the left sidebar: **Build → Authentication → Get started**.
3. Under **Sign-in method**, enable **Google**, pick a support email, save.
   This is the actual "Google auth id" setup you asked about — Firebase manages
   the Google OAuth client for you, so you don't need a separate Google Cloud
   console project for a basic setup.
4. In the left sidebar: **Build → Firestore Database → Create database** →
   start in **production mode** → pick any region.
5. Go to **Project settings** (gear icon, top left) → scroll to **Your apps** →
   click the **</> (web)** icon → register an app (any nickname, no need for
   Firebase Hosting) → it will show you a `firebaseConfig` object like:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "yourproject.firebaseapp.com",
     projectId: "yourproject",
     storageBucket: "yourproject.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef"
   };
   ```

6. Open **`firebase-config.js`** in this project and paste those exact values in.
   **This is the only file you need to edit.**

7. Still in the Firebase console, go to **Authentication → Settings →
   Authorized domains** and add:
   - `localhost` (already there by default, for testing)
   - your Netlify domain once you have it, e.g. `your-site-name.netlify.app`
   (Google sign-in will fail with an "unauthorized domain" error until you add it.)

## 2. Set Firestore security rules

In Firestore → **Rules**, replace the default with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
    match /requests/{requestId} {
      allow read, write: if request.auth != null;
      match /{sub}/{docId} {
        allow read, write: if request.auth != null;
      }
    }
  }
}
```

This keeps it simple (any signed-in user can read/write requests) which is fine
for a small personal tool. If you open this up publicly, tighten it so only
the two participants (`fromUid`/`toUid`) can touch a given request doc.

## 3. Run it locally (optional, before deploying)

Any static file server works, e.g.:

```
npx serve .
```

Open the printed `localhost` URL in two different browsers (or normal +
incognito window) signed into two different Google accounts to test a real
A→B connection on one machine.

## 4. Deploy to Netlify (free)

1. Push this folder to a GitHub repo (or drag-and-drop the folder directly into
   Netlify's "Deploys" tab — no build step needed, it's static files).
2. In Netlify: **Add new site → Import an existing project** → pick the repo.
   - Build command: leave blank
   - Publish directory: `.`
3. Deploy. Netlify gives you a URL like `random-name-123.netlify.app`.
4. Go back to Firebase → Authentication → Settings → Authorized domains →
   add that exact Netlify domain.
5. Open the site, sign in with Google, claim your address, and test with a
   friend.

---

## Honest limitations to know about

- **Both people need the tab open** for a transfer — this isn't a mailbox that
  holds a file for later, it's a live pipeline, exactly like you described.
- **Large files (multi-GB)**: this works, but speed depends on both people's
  upload/download bandwidth (true P2P), and the sending browser tab must
  stay open and awake for the whole transfer. Mobile browsers may throttle
  background tabs — keep the app in the foreground during big transfers.
- **NAT traversal**: this uses only free public STUN servers. Most home/mobile
  networks work fine, but some restrictive corporate or carrier-grade NATs
  block direct P2P connections — the fix for that is a TURN server, which
  isn't free at scale (services like Twilio or a self-hosted coturn box).
  If a connection gets permanently stuck on "connecting…", that's usually why.
- **Presence ("online" dot)** is a simple heartbeat (updated every 20s), not
  instant — someone who just closed their laptop lid may show "online" for
  up to ~20-40 seconds after disconnecting.
- **Handles are first-come, first-served** with no reservation system beyond
  "not already taken."
