# DSH Databases Plugin Index

Índice del plugin market de DSH (format 1) para el paquete `dsh-databases`.

- **Servidor:** https://nvznc.github.io/dsh-databases/index.json
- **Repo:** https://github.com/nvznc/dsh-databases

## Publicar / actualizar

```powershell
npm run index -- --repo https://github.com/nvznc/dsh-databases --commit <sha40> --version 1.0.0
npm run index:check
git add site && git commit -m "market: index" && git push
```

GitHub Pages: Settings → Pages → Deploy from a branch → `main` / `/site`.
