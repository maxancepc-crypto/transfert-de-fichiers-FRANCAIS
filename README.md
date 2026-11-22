# 📁 Transfert de fichiers

Petit service : on envoie un fichier, on obtient un lien de téléchargement temporaire.

## Lancer en local
```bash
npm install
npm start
# http://localhost:3000
```

## Variables d'environnement
| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_FILE_MB` | 100 | Taille max par fichier |
| `EXPIRY_HOURS` | 24 | Durée de vie des liens |
| `UPLOAD_PASSWORD` | (vide) | Si défini, il faut ce mot de passe pour envoyer un fichier |
| `UPLOAD_DIR` | `./uploads` | Dossier de stockage (mettre le chemin du disque Render si vous en avez un) |

## Mettre sur GitHub
```bash
git init
git add .
git commit -m "Premier commit"
git branch -M main
git remote add origin https://github.com/VOTRE-PSEUDO/file-transfer.git
git push -u origin main
```

## Déployer sur Render
1. Render → **New +** → **Web Service** → connecter le dépôt GitHub.
2. Build Command : `npm install` — Start Command : `npm start`.
3. Ajouter la variable `UPLOAD_PASSWORD` (recommandé).
4. **Important** : sur l'offre gratuite, le stockage est éphémère (les fichiers disparaissent au redémarrage/redéploiement). Pour un stockage durable, ajouter un **Disk** (offre payante) monté sur `/var/data` et définir `UPLOAD_DIR=/var/data`.
