# Huddle — Real-Time Video Conferencing & Collaboration

CodeAlpha Full Stack Development internship, **Task 4: Real-Time Communication App**.

Log in, start a meeting, share the invite link, and talk face to face with a few people.
Inside the room you can share your screen, send files, draw together on a whiteboard and
chat. The chat is end-to-end encrypted.

## Features
| Requirement | How it is built |
|---|---|
| **Multi-user video calling** | WebRTC `RTCPeerConnection`, mesh topology (every user connects to every other user), up to 6 people per room |
| **Screen sharing** | `getDisplayMedia()` + `RTCRtpSender.replaceTrack()`, which swaps camera ↔ screen without reconnecting |
| **File sharing** | `RTCDataChannel`: files go **directly browser to browser** in 16 KB chunks (max 50 MB), never through the server |
| **Whiteboard** | `<canvas>` with strokes synced over Socket.io; the server keeps the board so late joiners see it |
| **Data encryption** | Media + files: DTLS-SRTP (built into WebRTC). Chat: AES-256-GCM in the browser, key in the invite link `#fragment` |
| **User authentication** | Register / login, scrypt-hashed passwords, httpOnly session cookie, checked on REST **and** on the Socket.io handshake |
| Extras | Mute / camera off, copy invite link, join + leave notices, connection state per user |

## Tech stack
- **Frontend:** HTML, CSS, vanilla JavaScript (`public/`)
- **Backend:** Node.js, Express 5, **Socket.io** (signaling, chat relay, whiteboard)
- **Real-time media:** **WebRTC**
- **Database:** SQLite through Node's built-in `node:sqlite` (users + sessions)

## Run it
Requires **Node.js 22.13+**.
```bash
npm install
npm start        # http://localhost:3000
npm test         # auth + socket signaling, chat and whiteboard tests
```
To try a call on one computer, open the app in two different browsers (or one normal and one
private window), sign up as two users, start a meeting in one and paste the invite link into
the other.

> Camera and microphone only work on `localhost` or over **HTTPS**. To use it across devices,
> deploy it behind HTTPS (for example nginx + Let's Encrypt).

## How a call is set up
```
 Alice (already in room)          Server (Socket.io)              Bob (joins)
        |                               |  <-- join(room) ----------- |
        | <-- peer-joined(Bob) -------- |  --- peers: [Alice] ------> |
        |                               |  <-- signal(offer) -------- |   Bob creates the offer
        | <-- signal(offer) ----------- |                             |
        | --- signal(answer) ---------> |  --- signal(answer) ------> |
        | <======== ICE candidates exchanged the same way ==========> |
        | <================ direct P2P video / audio / files ========> |
```
The server only passes small "signal" messages between browsers. Once connected, the video,
audio and files flow **directly between the users**, not through the server.

Only the **newcomer** sends offers, to everyone already in the room. Existing users just
answer. That way two users never send offers to each other at the same moment ("glare").

## Encryption, layer by layer
1. **Video, audio, files:** WebRTC always encrypts media with **DTLS-SRTP** and data channels
   with **DTLS**. It cannot be turned off, and the server never sees this traffic.
2. **Chat:** when you start a meeting, the browser creates a random 256-bit key and puts it in
   the invite link after `#`, e.g. `/room?id=ab12cd34-ef56#k=<key>`. Browsers **never send the
   part after `#` to the server**. Each message is encrypted with **AES-GCM** before it is
   sent, so the server relays ciphertext it cannot read. The test suite checks that the
   server refuses plain-text messages.
3. **Passwords:** stored as **scrypt** hashes with a random salt.
4. **Sessions:** random token in an **httpOnly, SameSite=Lax** cookie. The same cookie is
   checked when the Socket.io connection opens, so logged-out users cannot join rooms or
   send signals.

## Project structure
```
server.js          Express REST auth + Socket.io rooms, signaling, chat relay, whiteboard
auth.js            password hashing, sessions, auth middleware
db.js              SQLite schema (users, sessions)
public/
  index.html       lobby: start / join a meeting
  login.html       sign up / log in
  room.html        the meeting room
  room.js          WebRTC peers, screen share, file transfer, encrypted chat
  whiteboard.js    shared canvas
  common.js        fetch helper, login + lobby logic
test/api.test.js   automated tests
```

## Limitations
- Mesh topology suits small meetings (about 6 people). Bigger rooms would need an SFU media
  server such as mediasoup or LiveKit.
- Only a public STUN server is configured. Some strict networks (corporate, some mobile
  carriers) need a TURN relay server too.
