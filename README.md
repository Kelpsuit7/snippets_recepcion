# VetSnippets

Aplicacion Electron para expandir snippets de texto con escucha global de teclado.

## Funcionalidades

La aplicación ofrece una interfaz gráfica para gestionar tus snippets, con las siguientes características:

*   **Gestión de Snippets:** Crea, busca y administra tus snippets de texto. Cada snippet consiste en una abreviatura (el `trigger`), el texto de reemplazo y puede ser asignado a una colección.
*   **Colecciones:** Organiza tus snippets en colecciones para mantener todo ordenado. Puedes crear y nombrar nuevas colecciones según necesites.
*   **Expansión Global de Texto:** La aplicación escucha lo que escribes en cualquier programa y expande automáticamente las abreviaturas al presionar `TAB`.
*   **Temas Personalizables:** Personaliza la apariencia de la aplicación con varias paletas de colores pastel, incluyendo Menta, Rosa, Cielo, Lavanda y Durazno.
*   **Ajustes Flexibles:**
    *   Activa o desactiva la función de expansión de snippets en cualquier momento.
    *   Muestra u oculta un aviso flotante que aparece cuando escribes una abreviatura.
*   **Importación y Exportación:** Respalda tus snippets o compártelos fácilmente importando y exportando la lista completa en formato CSV.
*   **Multiplataforma:** Compatible con Windows y macOS.

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

El instalador queda en `dist/VetSnippets-Setup-1.0.0.exe`.

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

Nota sobre icono: la ventana de la app y el instalador NSIS de Windows usan `2.ico`, generado desde `story.png` con capa 256x256. macOS usa `2.icns`, tambien generado desde el mismo logo.

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

## CSV

La pantalla principal exporta un CSV global con todos los snippets y su coleccion:

```csv
"coleccion","abreviatura","texto html","etiqueta"
"Correos","fac1","Hola, favor enviar copia de la factura. <br /><br />Muchas gracias","fac1"
"Informes","inf1","<span style=""font-size:14px;"">Hola</span>",""
```

Al exportar, todos los snippets llevan un valor en la columna `coleccion`; los que no esten asignados salen como `Sin coleccion`. Al importar, la app entiende ese respaldo global y reconstruye las colecciones desde la columna `coleccion`.

Tambien puede importar archivos sin encabezado compatibles con TextExpander:

```csv
"fac1","Hola, favor enviar copia de la factura. <br /><br />Muchas gracias","fac1"
"fac2","<span style=""font-size:14px;"">Hola</span>",""
```

En archivos sin encabezado, la tercera columna se trata como etiqueta del snippet y no como coleccion. La coleccion se crea automaticamente desde el nombre del archivo importado: `Correos.csv` crea o reutiliza la coleccion `Correos` y asigna ahi todos sus snippets. Si una abreviatura ya existe, la fila importada reemplaza ese snippet.

## Nota tecnica

`uiohook-napi` escucha el texto escrito y Electron registra `TAB` como atajo global cuando la expansion esta activa. Asi el foco no avanza a otro campo antes de borrar la abreviatura y pegar el reemplazo.
