## Su biblioteca de música
![Página de álbum](music.webp)
La música se une a las películas, las series y los libros, desde la adquisición hasta la reproducción.

### Álbumes tal como se publicaron
- Un álbum es una edición de MusicBrainz, con su portada del Cover Art Archive e imágenes de artistas de Fanart.tv. Ambas llegan mediante plugins instalados con Fliks. Las otras versiones del mismo álbum se agrupan en una fila en su página.
- Siga a un artista para recibir los nuevos álbumes de su discografía, filtrados por los tipos que acepta su biblioteca (álbumes, EP, sencillos, directos...).
- Siga listas de ListenBrainz, Last.fm, Spotify, Deezer o MusicBrainz con el plugin Music lists, del catálogo.

### Importe lo que ya tiene
- Fliks lee sus etiquetas: la carpeta es el álbum, las carpetas de disco se fusionan y los identificadores de MusicBrainz deciden la coincidencia.
- Escribir las etiquetas de vuelta en sus archivos es opcional. Se puede importar una biblioteca de Lidarr.

### Letras
- Desde sus archivos (incrustadas o .lrc, .elrc, .ttml, .srt, .txt junto a la pista), desde LRCLIB (un plugin instalado con Fliks), o escritas por usted con un editor para sincronizar con un toque.
- Letras palabra por palabra cuando la fuente las tiene. Reordene o desactive las fuentes de letras.

## Buscar, escuchar, llevarse la música
![Búsqueda de música](music-search.webp)

### Una sola búsqueda
- Un resultado principal, luego pistas, álbumes y artistas, con lo que es tendencia hoy y esta semana.
- Añada una sola pista o un álbum entero, o envíe una solicitud: los usuarios piden, los administradores aprueban.
- La vista previa al añadir muestra la lista de pistas antes de descargar nada.

### Reproductores
- Un minirreproductor que se abre en el reproductor completo, con la cola, las letras y la nivelación de volumen por pista o álbum (ReplayGain).
- Listas inteligentes e importación de m3u.
- Conserve pistas, álbumes, listas o artistas sin conexión.

### Sus aplicaciones favoritas
- Fliks habla OpenSubsonic: conecte una aplicación de música compatible con un token de su cuenta.

## Karaoke
Cante cualquier pista de su biblioteca. Un administrador activa el karaoke e instala un modelo de separación de voz desde la página Karaoke.

### Preparado por Fliks
- La voz se separa de la música, bajo demanda al abrir una pista, o en segundo plano en sus bibliotecas de música.
- Sin letras con tiempos por palabra, Fliks alinea el texto existente palabra por palabra. Las palabras de coros supuestas aparecen atenuadas.
- Se dibuja una melodía de referencia para que pueda seguir las notas.
- El trabajo puede ejecutarse en una GPU, en el procesador o en sus workers de optimización.

### En el escenario
- Una puntuación por cantante, de Fácil a Difícil, con notas doradas que valen el doble y un marcador.
- Los dúos y las voces superpuestas muestran qué cantante canta cada línea.
- Cambie la tonalidad para adaptarla a su voz.

## Fiestas de karaoke

### Todos cantan
- En una fiesta, los teléfonos se convierten en micrófonos: solo se envía el tono, nunca su voz.
- El programa de la fiesta es la cola de cantantes, con un interruptor para que los cantantes se turnen.

### En todas las pantallas
- Las letras y las pistas separadas se reproducen en un Chromecast.

### Traiga sus canciones
- Importe canciones UltraStar, con las pistas separadas incluidas, y discos MP3+G con sus gráficos CD+G.

## Optimización de la biblioteca
![Seguimiento de la optimización](optimize.webp)
Recodifique o remuxe sus archivos de vídeo para ahorrar espacio o para reproducirlos directamente en sus dispositivos.

### Un perfil por biblioteca
- Parta de Equilibrado, Solo limpieza o Reproducción directa, y ajuste después el vídeo, el audio, los subtítulos y las salvaguardas.
- El vídeo se recodifica a HEVC o AV1 solo cuando es realmente más eficiente que el origen. Se pueden recortar las barras negras y dejar intactos los archivos HDR10+ y Dolby Vision.
- Las pistas de audio y de subtítulos se ordenan y recortan por idioma. Las pistas de comentarios se eliminan, los idiomas desconocidos siempre se conservan.
- Previsualice el efecto por archivo y por biblioteca antes de empezar. Los archivos nuevos pueden ponerse en cola automáticamente cuando tengan suficiente antigüedad.

### Sustitución segura
- Cada resultado se comprueba antes de sustituir al original, que va a una papelera de la que puede restaurarlo hasta que se purgue.
- Un archivo que se está reproduciendo nunca se cambia: la tarea espera.
- Las comprobaciones programadas pueden leer toda su biblioteca para encontrar archivos dañados.

### Más máquinas
- Añada workers remotos con un token y use varias GPU por máquina, con una reserva guardada para la reproducción.
- Siga la cola, los fallos y las tareas terminadas en la página Optimización, con ventana horaria, pausa y prioridad.
