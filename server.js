const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_MB = Number(process.env.MAX_FILE_MB || 100);        // taille max par fichier
const MAX_FILES = Number(process.env.MAX_FILES || 100);       // nombre max de fichiers par envoi
const EXPIRY_HOURS = Number(process.env.EXPIRY_HOURS || 24);
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || '';    // vide = pas de mot de passe

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ID_RE = /^[a-f0-9]{16}$/;
const dirOf = (id) => path.join(UPLOAD_DIR, id);
const metaOf = (id) => path.join(dirOf(id), 'meta.json');

function readMeta(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaOf(id), 'utf8'));
    if (Date.now() > meta.expiresAt) return null;
    return meta;
  } catch {
    return null;
  }
}

function checkPassword(req, res, next) {
  if (UPLOAD_PASSWORD && req.get('x-upload-password') !== UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  next();
}

// Chaque envoi = un « transfert » avec son propre dossier
function newTransfer(req, res, next) {
  req.transferId = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(dirOf(req.transferId), { recursive: true });
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, dirOf(req.transferId)),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex')),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES },
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    maxMb: MAX_MB,
    maxFiles: MAX_FILES,
    expiryHours: EXPIRY_HOURS,
    passwordRequired: Boolean(UPLOAD_PASSWORD),
  });
});

app.post('/api/upload', checkPassword, newTransfer, upload.array('files', MAX_FILES), (req, res) => {
  const id = req.transferId;
  if (!req.files || !req.files.length) {
    fs.rmSync(dirOf(id), { recursive: true, force: true });
    return res.status(400).json({ error: 'Aucun fichier reçu.' });
  }
  const files = req.files.map((f, i) => ({
    index: i,
    // multer décode les noms en latin1 : on remet en UTF-8 (accents)
    name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    size: f.size,
    stored: f.filename,
  }));
  const meta = {
    id,
    files,
    totalSize: files.reduce((s, f) => s + f.size, 0),
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPIRY_HOURS * 3600 * 1000,
  };
  fs.writeFileSync(metaOf(id), JSON.stringify(meta));
  res.json({ id, url: `${req.protocol}://${req.get('host')}/f/${id}`, count: files.length, totalSize: meta.totalSize, files: files.map(({ stored, ...f }) => f) });
});

app.get('/api/info/:id', (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Transfert introuvable ou expiré.' });
  res.json({
    id: meta.id,
    count: meta.files.length,
    totalSize: meta.totalSize,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    files: meta.files.map(({ stored, ...f }) => f),
  });
});

app.get('/f/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// Tout télécharger en .zip (sans compression : rapide, même pour les gros fichiers)
app.get('/d/:id/zip', (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).send('Transfert introuvable ou expiré.');
  res.attachment('transfert.zip');
  const archive = archiver('zip', { store: true });
  archive.on('error', () => res.destroy());
  res.on('close', () => archive.abort());
  archive.pipe(res);
  const used = new Set();
  for (const f of meta.files) {
    let name = f.name;
    let n = 1;
    while (used.has(name)) {
      const ext = path.extname(f.name);
      name = `${path.basename(f.name, ext)} (${n++})${ext}`;
    }
    used.add(name);
    archive.file(path.join(dirOf(meta.id), f.stored), { name });
  }
  archive.finalize();
});

// Télécharger un seul fichier du transfert
app.get('/d/:id/:index', (req, res) => {
  const meta = readMeta(req.params.id);
  const f = meta && meta.files[Number(req.params.index)];
  if (!f) return res.status(404).send('Fichier introuvable ou expiré.');
  res.download(path.join(dirOf(meta.id), f.stored), f.name);
});

// Gestion des erreurs (fichier trop gros, trop de fichiers…)
app.use((err, req, res, next) => {
  if (req.transferId && !fs.existsSync(metaOf(req.transferId))) {
    fs.rmSync(dirOf(req.transferId), { recursive: true, force: true });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Un fichier dépasse la taille maximale (${MAX_MB} Mo).` });
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(413).json({ error: `Trop de fichiers (max ${MAX_FILES}).` });
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

// Nettoyage des transferts expirés (toutes les 10 minutes)
function cleanup() {
  const now = Date.now();
  for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    const full = path.join(UPLOAD_DIR, entry.name);
    try {
      if (!entry.isDirectory()) {
        // anciens fichiers de la version 1
        if (now - fs.statSync(full).mtimeMs > EXPIRY_HOURS * 3600 * 1000) fs.rmSync(full, { force: true });
        continue;
      }
      let expired;
      try {
        expired = now > JSON.parse(fs.readFileSync(path.join(full, 'meta.json'), 'utf8')).expiresAt;
      } catch {
        // pas de meta.json = envoi interrompu : on laisse 12 h de marge pour les très gros envois
        expired = now - fs.statSync(full).mtimeMs > 12 * 3600 * 1000;
      }
      if (expired) fs.rmSync(full, { recursive: true, force: true });
    } catch {}
  }
}
cleanup();
setInterval(cleanup, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
