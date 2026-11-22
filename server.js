const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_MB = Number(process.env.MAX_FILE_MB || 100);
const EXPIRY_HOURS = Number(process.env.EXPIRY_HOURS || 24);
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || ''; // vide = pas de mot de passe

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ID_RE = /^[a-f0-9]{16}$/;
const filePath = (id) => path.join(UPLOAD_DIR, id);
const metaPath = (id) => path.join(UPLOAD_DIR, id + '.json');

function readMeta(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    if (Date.now() > meta.expiresAt) return null;
    return meta;
  } catch {
    return null;
  }
}

// Vérification du mot de passe avant de recevoir le fichier
function checkPassword(req, res, next) {
  if (UPLOAD_PASSWORD && req.get('x-upload-password') !== UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex')),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    maxMb: MAX_MB,
    expiryHours: EXPIRY_HOURS,
    passwordRequired: Boolean(UPLOAD_PASSWORD),
  });
});

app.post('/api/upload', checkPassword, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const id = req.file.filename;
  const meta = {
    id,
    // multer décode les noms en latin1 : on remet en UTF-8 (accents)
    name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    size: req.file.size,
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPIRY_HOURS * 3600 * 1000,
  };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta));
  res.json({ id, url: `${req.protocol}://${req.get('host')}/f/${id}`, ...meta });
});

app.get('/api/info/:id', (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Fichier introuvable ou expiré.' });
  res.json(meta);
});

app.get('/f/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

app.get('/d/:id', (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).send('Fichier introuvable ou expiré.');
  res.download(filePath(meta.id), meta.name);
});

// Gestion des erreurs (ex. fichier trop gros)
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Fichier trop volumineux (max ${MAX_MB} Mo).` });
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

// Nettoyage des fichiers expirés (toutes les 10 minutes)
function cleanup() {
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace('.json', '');
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
      if (Date.now() > meta.expiresAt) {
        fs.rmSync(filePath(id), { force: true });
        fs.rmSync(metaPath(id), { force: true });
      }
    } catch {}
  }
}
cleanup();
setInterval(cleanup, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
