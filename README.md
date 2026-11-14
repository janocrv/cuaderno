# Cuaderno

Aplicación de estudio para Mac y Windows. Versión preparada para revisión, sin publicar.

## Generar instaladores en GitHub

Subir el contenido de esta carpeta a la raíz del repositorio, incluida `.github`.
Actions → Compilar instaladores (borrador) → Run workflow.
Genera Cuaderno-mac-arm64.dmg, Cuaderno-mac-x64.dmg y Cuaderno-win-x64.exe en una release **borrador**.
Revisar y probar antes de pulsar Publish release. El flujo solo se ejecuta manualmente.

El empaquetado usa Electron 43 para admitir macOS Monterey 12. Los instaladores conservan firma ad hoc en Mac y no tienen firma de Windows.

## Desarrollo

El código principal está en main.js y cuaderno-apuntes.html. Fuente del editor, reconstrucción y licencias en editor/.
Las pruebas de interfaz usan Playwright y Chrome con perfiles temporales y datos ficticios. No emplear datos personales para probar.
La edición táctil se prepara con `python3 ipad/preparar.py`; consultar ipad/LEEME.md para sus límites.

Este paquete se genera por lista permitida: no incluye datos de usuario, copias, correos, contraseñas ni instaladores antiguos.
