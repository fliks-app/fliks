# Optimization workers

The server's own engine optimizes the library. More machines can help: each one runs the Fliks engine as a worker with a token made in Settings > Optimization workers.

Start a worker with two variables (the Workers screen shows the command when it issues a token):

```
FLIKS_WORKER_URL=https://fliks.example.com FLIKS_WORKER_TOKEN=fkw_... fliks-engine
```

- Use an `https://` URL outside your LAN. The token and the encoded files travel in it.
- Set the server's public URL in General settings: a worker without library access reads files from it.
- Behind nginx, set `client_max_body_size 16m;` or more: files are uploaded in 8 MiB pieces.
- `FLIKS_TRANSCODE_DIR` is the worker's work folder; keep room for one output per running job.

## Docker

Run the engine image with the two variables and a volume on `FLIKS_TRANSCODE_DIR`.

## Windows

Run the released `fliks-engine.exe` as a service, for example with NSSM:

```
nssm install FliksWorker C:\fliks\fliks-engine.exe
nssm set FliksWorker AppEnvironmentExtra FLIKS_WORKER_URL=https://fliks.example.com FLIKS_WORKER_TOKEN=fkw_... FLIKS_TRANSCODE_DIR=D:\fliks-work
nssm start FliksWorker
```

## macOS

Create `~/Library/LaunchAgents/app.fliks.worker.plist` with the binary as `ProgramArguments`, the three variables under `EnvironmentVariables`, and `RunAtLoad` and `KeepAlive` set to true, then:

```
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/app.fliks.worker.plist
```

## Shared folders

A worker that mounts the library (access "Shared folders") needs path mappings when its paths differ from the server's, for example `/media/films` on the server and `Z:\films` on a Windows worker.
