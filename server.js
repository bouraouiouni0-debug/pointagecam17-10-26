// server.js - pont Cloud <-> ESP32-CAM pour la page "Gestion SD Card"
// Variables d'environnement à définir sur Render :
//   ADMIN_PASS : mot de passe demandé dans le navigateur (identifiant : n'importe lequel)
//   DEVICE_KEY : clé secrète de l'ESP32 (même valeur que CLOUD_KEY dans cloud_sd.h)
const express = require('express');
const app = express();

const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const DEVICE_KEY = process.env.DEVICE_KEY || 'esp32key';
const JOB_TIMEOUT_MS = 40000;   // attente max d'une réponse de l'ESP32
const ONLINE_MS = 20000;        // ESP32 considéré en ligne s'il a interrogé le serveur il y a moins de 20 s

let jobs = [];                  // commandes en attente pour l'ESP32
const pending = new Map();      // id -> { res, timer, cmd, file }
let nextId = 1;
let lastSeen = 0;

// ---------- Authentification ----------
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const [scheme, b64] = h.split(' ');
  if (scheme === 'Basic' && b64) {
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    if (pass === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SD ESP32"').status(401).send('Authentification requise');
}

function deviceAuth(req, res, next) {
  if (req.query.key === DEVICE_KEY) return next();
  res.status(403).send('forbidden');
}

function safeFile(f) {
  return typeof f === 'string' && f.length > 0 && f.length < 120 &&
         !/[|\r\n]/.test(f) && !f.includes('..');
}

// ---------- File de commandes ----------
function sendJob(res, cmd, file) {
  if (Date.now() - lastSeen > ONLINE_MS) {
    return res.status(503).json({ error: 'ESP32 hors ligne' });
  }
  const id = nextId++;
  jobs.push({ id, cmd, file: file || '' });
  const timer = setTimeout(() => {
    pending.delete(id);
    jobs = jobs.filter(j => j.id !== id);
    res.status(504).json({ error: "Pas de réponse de l'ESP32" });
  }, JOB_TIMEOUT_MS);
  pending.set(id, { res, timer, cmd, file: file || '' });
}

// ---------- Routes navigateur ----------
app.get('/', (req, res) => res.redirect('/sd'));
app.get('/sd', adminAuth, (req, res) => res.type('html').send(PAGE));

app.get('/api/status', adminAuth, (req, res) =>
  res.json({ online: Date.now() - lastSeen < ONLINE_MS }));

app.get('/api/list', adminAuth, (req, res) => sendJob(res, 'list'));

app.get('/api/download', adminAuth, (req, res) => {
  const f = req.query.file;
  if (!safeFile(f)) return res.status(400).json({ error: 'Nom invalide' });
  sendJob(res, 'download', f);
});

app.post('/api/delete', adminAuth, (req, res) => {
  const f = req.query.file;
  if (!safeFile(f)) return res.status(400).json({ error: 'Nom invalide' });
  sendJob(res, 'delete', f);
});

app.post('/api/deleteall', adminAuth, (req, res) => sendJob(res, 'deleteall'));

// ---------- Routes ESP32 ----------
// L'ESP32 demande s'il y a du travail. Réponse : "id|commande|fichier" ou 204 si rien.
app.get('/esp/poll', deviceAuth, (req, res) => {
  lastSeen = Date.now();
  const j = jobs.shift();
  if (!j) return res.status(204).end();
  res.type('text').send(j.id + '|' + j.cmd + '|' + j.file);
});

// L'ESP32 renvoie le résultat (JSON ou contenu du fichier) -> transmis au navigateur en attente.
app.post('/esp/result/:id', deviceAuth,
  express.raw({ type: '*/*', limit: '30mb' }),
  (req, res) => {
    lastSeen = Date.now();
    const id = Number(req.params.id);
    const p = pending.get(id);
    res.send('ok');
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);

    const status = Number(req.query.status) || 200;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (p.cmd === 'download' && status === 200) {
      const name = p.file.replace(/^\//, '').replace(/["\\]/g, '_');
      p.res.set('Content-Disposition', 'attachment; filename="' + name + '"');
      p.res.type('application/octet-stream').send(body);
    } else {
      p.res.status(status).type('json').send(body.toString());
    }
  });

// ---------- Page web (version cloud de sdpage) ----------
const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gestion SD Card</title>
<style>
body { font-family: Arial; text-align: center; }
button { margin: 5px; padding: 8px; cursor: pointer; }
#fileList div { margin: 6px 0; }
#state { font-weight: bold; }
</style>
</head>
<body>
<h2>Gestion SD Card</h2>
<p>ESP32 : <span id="state">...</span></p>
<button onclick="loadFiles()">Actualiser fichiers</button>
<button onclick="deleteAllFiles()" style="background:red;color:white;">Delete All</button>
<div id="fileList"></div>

<script>
async function checkState() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    const s = document.getElementById('state');
    s.textContent = d.online ? 'en ligne' : 'hors ligne';
    s.style.color = d.online ? 'green' : 'red';
  } catch (e) {}
}

async function loadFiles() {
  const box = document.getElementById('fileList');
  box.textContent = 'Chargement...';
  try {
    const r = await fetch('/api/list');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    box.textContent = '';
    data.files.forEach(function (f) {
      const row = document.createElement('div');
      row.append(f + ' ');
      const a = document.createElement('a');
      a.href = '/api/download?file=' + encodeURIComponent(f);
      a.download = f;
      const dl = document.createElement('button');
      dl.textContent = 'Telecharger';
      a.append(dl);
      const del = document.createElement('button');
      del.textContent = 'Supprimer';
      del.onclick = function () { deleteFile(f); };
      row.append(a, del);
      box.append(row);
    });
    if (!data.files.length) box.textContent = 'Carte SD vide';
  } catch (e) {
    box.textContent = 'Erreur : ' + e.message;
  }
}

async function deleteFile(f) {
  try {
    const r = await fetch('/api/delete?file=' + encodeURIComponent(f), { method: 'POST' });
    if (!r.ok) { const d = await r.json(); alert(d.error || 'Erreur'); }
  } catch (e) { alert('Erreur : ' + e.message); }
  loadFiles();
}

async function deleteAllFiles() {
  if (!confirm('Voulez-vous vraiment supprimer tous les fichiers de la carte SD ?')) return;
  try {
    const r = await fetch('/api/deleteall', { method: 'POST' });
    const d = await r.json();
    alert(r.ok ? d.deleted + ' fichier(s) supprime(s)' : (d.error || 'Erreur'));
  } catch (e) { alert('Erreur : ' + e.message); }
  loadFiles();
}

checkState();
setInterval(checkState, 5000);
loadFiles();
</script>
</body>
</html>`;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur démarré sur le port ' + PORT));
