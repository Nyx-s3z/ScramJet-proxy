// Emnity server: the page files, Scramjet's browser files, and the Wisp relay.
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";

// Some hosts have no working IPv6 route out; prefer IPv4 so connections don't hang.
dns.setDefaultResultOrder("ipv4first");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

// ---------- helpers for loading packages defensively ----------
async function load(spec) {
  try {
    return await import(spec);
  } catch (err) {
    console.warn(`[emnity] could not import ${spec}: ${err.message}`);
    return null;
  }
}

// Packages export the folder holding their browser files under different names.
function pickString(mod, ...names) {
  for (const name of names) {
    const val = mod?.[name] ?? mod?.default?.[name];
    if (typeof val === "string" && fs.existsSync(val)) return val;
  }
  return null;
}

function dirFor(pkg, exported) {
  return exported || path.join(__dirname, "node_modules", pkg, "dist");
}

const scramjetDir = dirFor(
  "@mercuryworkshop/scramjet",
  pickString(await load("@mercuryworkshop/scramjet/path"), "scramjetPath", "path")
);
const libcurlDir = dirFor(
  "@mercuryworkshop/libcurl-transport",
  pickString(await load("@mercuryworkshop/libcurl-transport"), "libcurlPath")
);
const baremuxDir = dirFor(
  "@mercuryworkshop/bare-mux",
  pickString(await load("@mercuryworkshop/bare-mux/node"), "baremuxPath")
);

const mustExist = [
  [scramjetDir, "scramjet.all.js"],
  [scramjetDir, "scramjet.wasm.wasm"],
  [libcurlDir, "index.mjs"],
  [baremuxDir, "worker.js"],
  [baremuxDir, "index.js"],
];
for (const [dir, file] of mustExist) {
  const ok = fs.existsSync(path.join(dir, file));
  console.log(`[emnity] ${ok ? "ok     " : "MISSING"} ${path.join(dir, file)}`);
}

// ---------- Wisp relay (opens the real connections to websites) ----------
const wispMod = await load("@mercuryworkshop/wisp-js/server");
const wisp = wispMod?.server ?? wispMod?.default?.server ?? null;
if (!wisp || typeof wisp.routeRequest !== "function") {
  console.error("[emnity] Wisp server not available. Pages will not load.");
} else {
  try {
    Object.assign(wisp.options, {
      allow_udp_streams: false,
      allow_loopback_ips: false,
      allow_private_ips: false,
    });
  } catch (err) {
    console.warn("[emnity] could not set wisp options:", err.message);
  }
}

// ---------- access code ----------
// Set ACCESS_CODE in Render's Environment settings to change it. Not case sensitive.
const ACCESS_CODE = String(process.env.ACCESS_CODE || "LMA").trim().toLowerCase();
const sha = (text) => crypto.createHash("sha256").update(text).digest();
const SESSION_TOKEN = sha("emnity-session:" + ACCESS_CODE).toString("hex");

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(String(a)), sha(String(b)));
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

const isAuthed = (req) => safeEqual(readCookie(req, "emn_auth"), SESSION_TOKEN);

// Slow down guessing: 10 wrong tries per address every 10 minutes.
const attempts = new Map();
function tooManyTries(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.start > 10 * 60 * 1000) return false;
  return rec.count >= 10;
}
function noteFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.start > 10 * 60 * 1000) attempts.set(ip, { start: now, count: 1 });
  else rec.count += 1;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, rec] of attempts) if (rec.start < cutoff) attempts.delete(ip);
}, 60 * 1000).unref();

function loginPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Emnity</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
background:#e6e8e8;color:#0b0b0b;font-family:"Nunito",system-ui,sans-serif}
h1{margin:0;font-size:64px;letter-spacing:-1px;font-weight:800}h1 i{font-style:normal;color:#14b8a6}
p{margin:0;color:#4b5454;font-weight:600}
form{display:flex;width:min(380px,90vw);background:#fff;border-radius:28px;border:2px solid transparent;box-shadow:0 2px 0 #d4d8d8}
form:focus-within{border-color:#14b8a6}
input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:16px;font-weight:600;padding:14px 20px;border-radius:28px 0 0 28px}
button{border:0;background:#0b0b0b;color:#14b8a6;font:inherit;font-weight:800;padding:0 24px;border-radius:0 26px 26px 0;cursor:pointer}
button:hover{background:#0d9488;color:#fff}
.err{color:#b3261e;min-height:1.2em}
</style></head><body>
<h1>Emn<i>i</i>ty</h1>
<p>Enter the access code.</p>
<form method="post" action="/login"><input type="password" name="code" placeholder="Access code" autocomplete="off" autofocus aria-label="Access code"><button>Enter</button></form>
<p class="err">${message || ""}</p>
</body></html>`;
}

// ---------- web server ----------
const app = express();
app.disable("x-powered-by");

// Optional: cross-origin isolation (set ISOLATE=1 to turn on).
if (process.env.ISOLATE === "1") {
  app.use((_req, res, next) => {
    res.set("Cross-Origin-Opener-Policy", "same-origin");
    res.set("Cross-Origin-Embedder-Policy", "require-corp");
    next();
  });
}

app.set("trust proxy", 1);

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.post("/login", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
  if (tooManyTries(req.ip)) {
    return res.status(429).type("html").send(loginPage("Too many tries. Wait a few minutes."));
  }
  const given = String((req.body && req.body.code) || "").trim().toLowerCase();
  if (safeEqual(given, ACCESS_CODE)) {
    const secure = req.secure ? "; Secure" : "";
    res.set("Set-Cookie", `emn_auth=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    return res.redirect(303, "/");
  }
  noteFailure(req.ip);
  return res.status(401).type("html").send(loginPage("That code isn't right."));
});

// Everything below this line needs the access code.
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.method === "GET" && req.path === "/") return res.type("html").send(loginPage(""));
  return res.status(401).type("text").send("Locked. Open the main page and enter the access code.");
});


// Only these page files are public; server.js and package.json are never served.
const FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/style.css": "style.css",
  "/app.js": "app.js",
  "/sw.js": "sw.js",
};
for (const [route, file] of Object.entries(FILES)) {
  app.get(route, (_req, res) => {
    if (file === "sw.js") res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(__dirname, file));
  });
}

app.use("/scram/", express.static(scramjetDir));
app.use("/libcurl/", express.static(libcurlDir));
app.use("/baremux/", express.static(baremuxDir));

app.use((_req, res) => res.status(404).type("text").send("Not found"));

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  if (!isAuthed(req)) {
    socket.destroy();
    return;
  }
  if (wisp && req.url && req.url.endsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`[emnity] running on port ${PORT}`);
});

function shutdown() {
  console.log("[emnity] shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
