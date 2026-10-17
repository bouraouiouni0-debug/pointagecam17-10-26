const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- File de commandes (navigateur -> ESP32) ----------
let queue = [];            // commandes en attente pour l'ESP32
const waiting = {};        // id -> { res, timer, type }
let nextId = 1;
let lastSeen = 0;          // derniere fois que l'ESP32 a contacte le serveur

function sendCommand(cmd, res, timeoutMs = 25000) {
  if (Date.now() - lastSeen > 30000) {
    return res.status(503).json({ error: "ESP32 hors ligne" });
  }
  const id = nextId++;
  cmd.id = id;
  queue.push(cmd);
  const timer = setTimeout(() => {
    delete waiting[id];
    queue = queue.filter(c => c.id !== id);
    res.status(504).json({ error: "ESP32 ne repond pas" });
  }, timeoutMs);
  waiting[id] = { res, timer, type: cmd.type };
}

// ---------- Cote ESP32 ----------
// L'ESP32 appelle /esp/poll toutes les 1-2 s
app.get("/esp/poll", (req, res) => {
  lastSeen = Date.now();
  const cmd = queue.shift();
  res.json(cmd || {});
});

// Reponse JSON (list, delete, deleteall)
app.post("/esp/result/:id", express.json({ limit: "1mb" }), (req, res) => {
  const w = waiting[req.params.id];
  if (w) {
    clearTimeout(w.timer);
    delete waiting[req.params.id];
    w.res.json(req.body);
  }
  res.send("ok");
});

// Fichier brut (download)
app.post("/esp/upload/:id",
  express.raw({ type: "*/*", limit: "30mb" }),
  (req, res) => {
    const w = waiting[req.params.id];
    if (w) {
      clearTimeout(w.timer);
      delete waiting[req.params.id];
      const name = req.query.file || "fichier.bin";
      w.res.setHeader("Content-Type", "application/octet-stream");
      w.res.setHeader("Content-Disposition",
        `attachment; filename="${name}"`);
      w.res.send(req.body);
    }
    res.send("ok");
  });

// ---------- Cote navigateur ----------
app.get("/api/list", (req, res) => sendCommand({ type: "list" }, res));

app.get("/api/delete", (req, res) =>
  sendCommand({ type: "delete", file: req.query.file }, res));

app.get("/api/deleteall", (req, res) =>
  sendCommand({ type: "deleteall" }, res));

app.get("/api/download", (req, res) =>
  sendCommand({ type: "download", file: req.query.file }, res, 60000));

app.get("/api/status", (req, res) =>
  res.json({ online: Date.now() - lastSeen < 30000 }));

// ---------- Page web /sd ----------
const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gestion SD Card</title>
<style>
body { font-family: Arial; text-align: center; }
button { margin: 5px; padding: 8px; cursor: pointer; }
#status { margin: 10px; font-weight: bold; }
.row { margin: 6px; }
</style>
</head>
<body>
<h2>Gestion SD Card (cloud)</h2>
<div id="status">...</div>
<button onclick="loadFiles()">Actualiser fichiers</button>
<button onclick="deleteAllFiles()" style="background:red;color:white;">Delete All</button>
<div id="fileList"></div>
<script>
function setStatus(t){ document.getElementById("status").textContent = t; }

function loadFiles(){
  setStatus("Chargement...");
  fetch('/api/list')
    .then(r => r.json())
    .then(data => {
      if (data.error) { setStatus(data.error); return; }
      setStatus("ESP32 en ligne");
      let html = "";
      (data.files || []).forEach(f => {
        const name = f.replace(/^\\//, "");
        html += '<div class="row">' + name +
          ' <a href="/api/download?file=' + encodeURIComponent(name) + '">' +
          '<button>Telecharger</button></a>' +
          '<button onclick="deleteFile(\\'' + name + '\\')">Supprimer</button></div>';
      });
      document.getElementById("fileList").innerHTML = html;
    })
    .catch(() => setStatus("Erreur serveur"));
}

function deleteFile(f){
  fetch('/api/delete?file=' + encodeURIComponent(f)).then(loadFiles);
}

function deleteAllFiles(){
  if (confirm("Supprimer tous les fichiers de la carte SD ?")) {
    fetch('/api/deleteall').then(loadFiles);
  }
}
loadFiles();
</script>
</body>
</html>`;

app.get("/", (req, res) => res.redirect("/sd"));
app.get("/sd", (req, res) => res.send(PAGE));

app.listen(PORT, () => console.log("Serveur sur le port " + PORT));
