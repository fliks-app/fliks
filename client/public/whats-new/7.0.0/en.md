## Your music library
![Album page](music.webp)
Music joins films, series and books, from acquisition to playback.

### Albums as they were released
- An album is one MusicBrainz release, with its cover from the Cover Art Archive. Other versions of the same album fold into a row on its page.
- Follow an artist to get the new albums of their discography, filtered by the types your library accepts (albums, EPs, singles, live...).
- Follow lists from ListenBrainz, Last.fm, Spotify, Deezer or MusicBrainz.

### Import what you already have
- Fliks reads your tags: the folder is the album, disc folders are merged, and MusicBrainz ids decide the match.
- Writing tags back to your files is opt-in. A Lidarr library can be imported.

### Lyrics
- From your files (embedded or .lrc, .elrc, .ttml, .srt, .txt beside the track), from LRCLIB, or written by you with a tap-to-sync editor.
- Word-by-word lyrics when the source has them. Reorder or turn off the lyrics sources.

## Search, listen, take it with you
![Music search](music-search.webp)

### One search
- A top result, then tracks, albums and artists, with what is trending today and this week.
- Add a single track or a whole album, or send a request: users ask, admins approve.
- The add preview shows the tracklist before anything is downloaded.

### Players
- A mini player that opens into the full player, with the queue, lyrics and volume levelling by track or album (ReplayGain).
- Smart playlists and m3u import.
- Keep tracks, albums, playlists or artists offline.

### Your favourite apps
- Fliks speaks OpenSubsonic: connect a compatible music app with a token from your account.

## Karaoke
Sing any track of your library. An admin turns karaoke on and installs a voice separation model from the Karaoke page.

### Prepared by Fliks
- The voice is separated from the music, on demand when you open a track, or in the background on your music libraries.
- Without word-timed lyrics, Fliks aligns the existing text word by word. Guessed backing words appear dimmed.
- A reference melody is drawn so you can follow the notes.
- The work can run on a GPU, on the processor, or on your optimization workers.

### On stage
- A score per singer, from Easy to Hard, with golden notes worth double and a scoreboard.
- Duets and overlapping voices show which singer sings which line.
- Change the key to fit your voice.

## Karaoke parties

### Everyone sings
- In a party, phones become microphones: only the pitch is sent, never your voice.
- The party programme is the singer queue, with a switch to make singers take turns.

### On every screen
- Lyrics and separated tracks play on a Chromecast.

### Bring your songs
- Import UltraStar songs, separated tracks included, and MP3+G discs with their CD+G graphics.

## Library optimization
![Optimization tracking](optimize.webp)
Re-encode or remux your video files to save space or to play directly on your devices.

### One profile per library
- Start from Balanced, Cleanup only or Direct playback, then tune video, audio, subtitles and safeguards.
- Video is re-encoded to HEVC or AV1 only when it is really more efficient than the source. Black bars can be cropped, HDR10+ and Dolby Vision files can be left alone.
- Audio and subtitle tracks are sorted and trimmed by language. Commentary tracks go, unknown languages always stay.
- Preview the effect per file and per library before starting. New files can be queued automatically once old enough.

### Safe replacement
- Every output is checked before it replaces the original, which goes to a trash you can restore from until it is purged.
- A file being played is never swapped: the job waits.
- Scheduled checks can read your whole library to find damaged files.

### More machines
- Add remote workers with a token, and use several GPUs per machine with a reserve kept for playback.
- Follow the queue, failures and finished jobs on the Optimization page, with a time window, pause and priority.
