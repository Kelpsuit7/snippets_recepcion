# Snippets Recepcion

Aplicacion Electron para expandir snippets de texto con escucha global de teclado.

## Preview en Windows

```powershell
npm install
$env:ELECTRON_RUN_AS_NODE=$null
.\node_modules\.bin\electron.cmd .
```

Tambien puedes usar:

```powershell
npm run preview:win
```

## Instalador de Windows

Build local:

```powershell
npm install
npm run dist:win
```

El instalador queda en `dist/Snippets Recepcion-Setup-1.0.0.exe`.

Nota: el build local necesita Visual Studio Build Tools con la carga `Desktop development with C++`, porque `uiohook-napi` es una dependencia nativa.

Build con GitHub:

1. Sube este proyecto a un repositorio de GitHub.
2. En GitHub abre `Actions > Windows Installer`.
3. Ejecuta `Run workflow`.
4. Descarga el artefacto `windows-installer`.

Para publicar un Release automaticamente:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions compila el instalador y lo adjunta al Release del tag.

## Preview en macOS

```bash
npm install
unset ELECTRON_RUN_AS_NODE
./node_modules/.bin/electron .
```

Tambien puedes usar:

```bash
npm run preview:mac
```

## Instalador de macOS

Build local en una Mac:

```bash
npm install
npm run dist:mac
```

El build genera `.dmg` y `.zip` en `dist/` para Intel (`x64`) y Apple Silicon (`arm64`).

Build con GitHub:

1. Sube este proyecto a un repositorio de GitHub.
2. En GitHub abre `Actions > macOS Installer`.
3. Ejecuta `Run workflow`.
4. Descarga el artefacto `macos-installer`.

Para publicar Release automaticamente:

```bash
git tag v1.0.0
git push origin v1.0.0
```

El workflow adjunta los `.dmg` y `.zip` al Release del tag.

Nota sobre icono: Windows usa exactamente `2.ico` y macOS usa exactamente `2.icns`.

## Permisos necesarios

Windows:
- Funciona con apps normales.
- Si quieres expandir texto dentro de una app ejecutada como administrador, esta app tambien debe ejecutarse como administrador.

macOS:
- Concede permisos en `System Settings > Privacy & Security`.
- Activa `Accessibility` para Terminal, VS Code o la app instalada, segun desde donde la ejecutes.
- Activa `Input Monitoring` para Terminal, VS Code o la app instalada si macOS lo solicita.

## Datos guardados

Los snippets se guardan en `app.getPath('userData')/snippets.json`, que apunta a una ruta distinta en Windows y macOS. Electron elige la ubicacion correcta para cada sistema.

## Nota tecnica

`uiohook-napi` escucha teclado globalmente, pero no cancela de forma nativa el evento `TAB` antes del sistema operativo. La app compensa borrando la abreviatura mas el `TAB` e inmediatamente pega el reemplazo desde el portapapeles.
