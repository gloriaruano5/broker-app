# Mi Cartera

App Android para seguir mis inversiones (acciones, ETFs, materias primas y criptomonedas).

## Qué hace
- **Cartera**: valor total en euros, ganancia o pérdida y avisos de cambios.
- **Por activo**: análisis orientativo (tendencia, RSI, medias, FOMO, noticias, directivos, grandes fondos), gráfica con historial completo, noticias, geopolítica, cuentas anuales, movimientos de directivos y fondos 13F.
- **Mercado**: índices de miedo y codicia, indicadores clave y noticias geopolíticas de los temas que afectan a la cartera.

Las cantidades y precios de compra se guardan solo en el móvil.

## Instalar
Descarga `MiCartera.apk` de la última versión en **Releases** y ábrelo en el móvil. Cada versión nueva se instala encima sin perder los datos.

## Cómo se actualiza
- Precios y noticias: al abrir la app (Yahoo Finance, Google Noticias, CNN, alternative.me).
- Datos oficiales de la SEC (cuentas, directivos, 13F): cada día con la acción *Actualizar datos oficiales*, que guarda `data/sec.json`.
- `data/analisis.json`: comentario diario opcional que la app muestra si existe.

Opcional: añade el secreto `SEC_CONTACT` con un email de contacto (la SEC lo pide en sus normas de uso).

> Análisis automático y orientativo. **No es asesoramiento financiero.**
