You are an expert full-stack engineer. Build a minimal but production-quality **watch party web application** that streams a local video from the host machine and synchronizes playback between two users in real time.

---

# 🎯 Core Requirements

* Host streams a **local video file** to a remote user
* Both users can:

  * Play
  * Pause
  * Seek
* Playback must stay **synchronized continuously**
* App runs locally and is exposed via a tunnel (e.g., ngrok)
* Works in browser (no install required)
* Only support **2 users (MVP)**

---

# 🧱 Tech Stack (STRICT)

* Backend: Node.js + Express
* Realtime: Socket.IO
* Frontend: Vanilla HTML, CSS, JavaScript
* Video: HTML5 `<video>`
* Streaming: HTTP Range Requests (MUST use 206 Partial Content)

---

# 🏗️ System Architecture

## Backend

* Serve frontend
* Stream video using range requests
* Maintain session state:

  * currentTime
  * isPlaying
  * lastUpdateTimestamp
* Handle WebSocket events
* Broadcast sync updates

## Frontend

* Render video player
* Connect to WebSocket
* Emit user actions
* Apply sync updates from server

---

# 📁 Project Structure

project-root/
│
├── server/
│   ├── index.js
│   ├── socket.js
│   ├── videoController.js
│
├── client/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│
└── package.json

---

# 🎥 Video Streaming (CRITICAL)

Implement `/video` endpoint using HTTP Range Requests.

Requirements:

* Read `Range` header
* Parse byte range
* Return:

  * Status: 206
  * Headers:

    * Content-Range
    * Accept-Ranges
    * Content-Length
    * Content-Type: video/mp4
* Stream file chunk using `fs.createReadStream`

The browser video player depends on this behavior ([j2i.net][1]).

Use a hardcoded video path:

```js
const VIDEO_PATH = "./video/sample.mp4";
```

---

# 🔄 WebSocket Event Design

Use Socket.IO.

### Events

#### 1. `play`

```json
{ "time": number, "timestamp": number }
```

#### 2. `pause`

```json
{ "time": number, "timestamp": number }
```

#### 3. `seek`

```json
{ "time": number, "timestamp": number }
```

#### 4. `sync`

```json
{ "time": number, "isPlaying": boolean, "timestamp": number }
```

---

# 🧠 Sync Algorithm (IMPORTANT)

Implement **Smart Sync**:

* Every 2–3 seconds:

  * Server broadcasts current state

* On client:

  * Compare:

    ```
    drift = abs(localTime - serverTime)
    ```
  * If drift > 0.3 seconds:

    * Adjust video.currentTime

* If playing:

  * Continue playback

* If paused:

  * pause()

This approach (master time broadcast) is commonly used in sync systems ([Stack Overflow][2]).

---

# ⚔️ Conflict Handling (Both Users Control)

Implement **Last Action Wins**:

* Each event includes `timestamp`
* Server:

  * Accepts latest timestamp
  * Overrides previous state
* Broadcast authoritative state

---

# 🧪 Edge Cases (MUST HANDLE)

* User joins late → sync immediately
* Network lag → auto-correct drift
* Rapid seek spam → debounce (300ms)
* Disconnect/reconnect → resync
* Video buffering → reapply sync after `waiting` event

---

# 🖥️ Frontend Behavior

### index.html

* `<video id="player" controls src="/video"></video>`

### app.js

* Connect to socket
* Add listeners:

  * play
  * pause
  * seeked
* Emit events
* Listen for `sync` and update player

---

# 🔐 Constraints

* No frameworks (React, etc.)
* No database
* Single room only
* Keep code clean and modular

---

# 🚀 Run Instructions

1. Install dependencies:

```bash
npm install express socket.io
```

2. Start server:

```bash
node server/index.js
```

3. Expose using ngrok:

```bash
ngrok http 3000
```

4. Share URL

---

# ✅ Expected Output

* Fully working Node.js project
* Stream video from host
* Sync playback between two users
* Smooth playback with minimal drift

---

# ⚠️ Non-Goals

* Authentication
* Multiple rooms
* Chat
* UI polish

---

# 💡 Implementation Notes

* Use event-driven architecture (Node.js is ideal for WebSockets) ([Medium][3])
* Keep server authoritative for sync
* Avoid over-engineering

---

Generate:

* All backend files
* All frontend files
* Working code (not pseudo-code)
* Clear comments

[1]: https://blog.j2i.net/2021/01/10/video-streaming-with-node-and-express/?utm_source=chatgpt.com "Video Streaming with Node and Express - j2i.net"
[2]: https://stackoverflow.com/questions/71227699/best-way-to-sync-video-playback-on-multiple-devices-using-nodejs-and-websockets?utm_source=chatgpt.com "Best way to sync video playback on multiple devices using ..."
[3]: https://medium.com/%40PubNub/node-js-websocket-programming-examples-f6b8e15f8f85?utm_source=chatgpt.com "Node JS WebSocket Programming Examples | by PubNub"
