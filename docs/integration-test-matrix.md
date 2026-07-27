# Matriz de integracion de expansion

## Pruebas automatizadas disponibles

| Destino | Comando | Verificacion |
| --- | --- | --- |
| Bloc de notas | `npm run test:integration:win` | Lee el contenido mediante UI Automation |
| Bloc de notas, doble Shift | `npm run test:integration:win:double` | Verifica dos pulsaciones dentro de la ventana temporal |
| Microsoft Edge | `npm run test:integration:win:edge` | Lee el valor expandido desde el titulo de la ventana |

Ambas pruebas usan un directorio `userData` temporal, desactivan el registro de
inicio automatico y eliminan sus procesos y archivos al finalizar.

## Matriz de aplicaciones

| Aplicacion | Estado en este equipo |
| --- | --- |
| Bloc de notas | Automatizada |
| Microsoft Edge | Automatizada |
| Google Chrome | No instalado |
| Microsoft Word | No instalado |
| Microsoft Excel | No instalado |
| Microsoft Outlook | No instalado |

Cuando Office o Chrome esten disponibles, deben probarse con:

- Escalado de Windows en 100%, 125% y 150%.
- Una pantalla y multiples monitores con escalas diferentes.
- Shift simple, doble Shift y modo automatico.
- Texto plano, saltos de linea, acentos y caracteres `ñ`.
- Ventanas normales y aplicaciones ejecutadas como administrador.
