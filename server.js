// Emnity server: the page files, Scramjet's browser files, and the Wisp relay.
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
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

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

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
