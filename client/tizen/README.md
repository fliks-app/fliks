# Tizen (Samsung Smart TV) build & deploy

End-to-end guide to build, sign, install, debug and run the Fliks
Tizen app on a Samsung Smart TV in developer mode.

The flow is fully CLI — no Tizen Studio GUI needed. Each contributor
generates their own Samsung-issued signing certificates tied to the
DUID of their own TV. No signing material is ever committed.

---

## 1. One-time prerequisites

### 1.1 Tizen Studio CLI

Download `tizen-studio-cli_X.X_ubuntu-64.bin` from the official Tizen
Studio download page on `developer.tizen.org` and install it (default
path: `~/tizen-studio`).

Add the CLIs to your `PATH` (or persist in your shell profile):

```bash
export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"
```

Verify:

```bash
sdb version
tizen version
```

### 1.2 Other tooling

- `openssl` (any recent version with `-legacy` provider)
- `uv` — Python package runner used by `tizencertificates`
  (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- `git`, `node`, `npm` — already required by the client

### 1.3 Enable Developer Mode on the TV

On the TV, open **Apps** and type `12345` with the remote. A dialog
appears:

- Toggle Developer Mode **On**
- **Host PC IP**: the IP of your laptop on the same LAN
- Reboot the TV

### 1.4 Connect `sdb` to the TV

```bash
sdb connect <TV_IP>:26101
sdb devices    # should show the TV as "device"
```

The default port is `26101`. Keep the connection idempotent —
`sdb connect` is safe to re-run.

### 1.5 Get the TV's DUID

The DUID is a per-device identifier the distributor certificate
binds to. Read it from the TV:

```bash
sdb -s <TV_IP>:26101 shell 0 getduid
```

Note it down (looks like a 12-char alphanumeric string).

### 1.6 Generate the Samsung certificates

Samsung's distributor certificate must be signed by Samsung's CA —
there is no purely-local path. We use the open-source
[`sreyemnayr/tizencertificates`](https://github.com/sreyemnayr/tizencertificates)
which automates the Samsung SSO + CA-fetch flow without requiring the
Tizen Studio GUI.

```bash
mkdir -p ~/tools && cd ~/tools
git clone https://github.com/sreyemnayr/tizencertificates.git
cd tizencertificates

uv run tv \
  --device-id "<YOUR_TV_DUID>" \
  --email "<your.samsung.account@example.com>"
```

The tool starts a local FastAPI server, opens your browser to
Samsung's OAuth page, captures the token, and writes both
`author.p12` and `distributor.p12` into `./certificates/`.

Move them somewhere stable, outside the Fliks repo:

```bash
mkdir -p ~/tizen-studio-data/certs/fliks
cp ~/tools/tizencertificates/certificates/author.p12 \
   ~/tizen-studio-data/certs/fliks/author.p12
cp ~/tools/tizencertificates/certificates/distributor.p12 \
   ~/tizen-studio-data/certs/fliks/distributor.p12
```

### 1.7 Re-encrypt the p12s with a non-empty password

`tizencertificates` produces certificates with an empty password.
Tizen CLI's signing engine misbehaves with empty-password p12s
(`Invaild password` at `tizen package` time). Re-encrypt them with
a real password:

```bash
cd ~/tizen-studio-data/certs/fliks
for cert in author distributor; do
  openssl pkcs12 -in $cert.p12 -passin pass: -nodes -legacy -out $cert.pem
  openssl pkcs12 -export -in $cert.pem -out $cert.p12 -password pass:fliks -legacy
  rm $cert.pem
done
```

(Pick any password you like in place of `fliks` — it never leaves
your machine.)

### 1.8 Register the signing profile

```bash
tizen security-profiles add -n fliks \
  -a ~/tizen-studio-data/certs/fliks/author.p12 \
  -p fliks \
  -d ~/tizen-studio-data/certs/fliks/distributor.p12 \
  -dp fliks

# Tizen CLI doesn't always write the `.pwd` companion files. Create
# them explicitly (plain text password, matching what you used above):
echo -n "fliks" > ~/tizen-studio-data/certs/fliks/author.pwd
echo -n "fliks" > ~/tizen-studio-data/certs/fliks/distributor.pwd

# Activate the profile globally for the CLI:
tizen cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml"

# Verify:
tizen security-profiles list
```

You should see `fliks` with `Active = O`.

---

## 2. Build / sign / install / run

From `client/`:

```bash
# 1. Build the Angular bundle and package an unsigned .wgt
npm run tizen:build
# → writes dist/tizen-stage/ + dist/Fliks-<version>.wgt

# 2. Sign the staged bundle with the `fliks` profile
tizen package -t wgt -s fliks -- dist/tizen-stage
# → writes dist/tizen-stage/Fliks.wgt (signed)

# 3. Install on the TV
tizen install -n Fliks.wgt -s <TV_IP>:26101 -- dist/tizen-stage

# 4. Launch
tizen run -p abcdefghij.Fliks -s <TV_IP>:26101
```

The application ID `abcdefghij.Fliks` comes from `config.xml`. It is
a placeholder until/unless a real Samsung Seller Office package ID is
registered.

To stop the app:

```bash
sdb -s <TV_IP>:26101 shell 0 was_kill abcdefghij.Fliks
```

To uninstall:

```bash
tizen uninstall -p abcdefghij.Fliks -s <TV_IP>:26101
```

---

## 3. Debug — Chrome DevTools on the TV

Tizen WebApps expose a remote Web Inspector when launched with
`debug`. Forward the port and open it in Chrome:

```bash
# Launch with debug; the command prints the assigned port
sdb -s <TV_IP>:26101 shell 0 debug abcdefghij.Fliks
# → "... successfully launched pid = N with debug 1 port: <PORT>"

# Forward the inspector port to localhost
sdb -s <TV_IP>:26101 forward tcp:9222 tcp:<PORT>

# Open in your browser
xdg-open http://localhost:9222
```

Click the page entry to open the full DevTools (Console, Network,
Sources, …) attached to the live WebApp.

For console output without DevTools:

```bash
sdb -s <TV_IP>:26101 dlog -v time | grep -i fliks
```

(Note: some TV firmware variants restrict `dlog` to the system
account; the Web Inspector is the reliable path.)

---

## 4. Signing material is never committed

The repo `.gitignore` excludes:

- `*.p12` — author/distributor certificates
- `*.pwd` — Tizen CLI password files
- `client/tizen-studio-cli.bin` — the Tizen Studio CLI installer
- `client/webos/*.ipk` — webOS package output

Recommended layout (mirrors the Android keystore policy):

| What                     | Where                                      |
| ------------------------ | ------------------------------------------ |
| Tizen Studio install     | `~/tizen-studio/`                          |
| Per-contributor certs    | `~/tizen-studio-data/certs/<project>/`     |
| Tizen security profiles  | `~/tizen-studio-data/profile/profiles.xml` |
| `tizencertificates` tool | `~/tools/tizencertificates/`               |

CI receives the distributor `.p12` as a base64-encoded repo secret
decoded at build time (same pattern as `client/android/app/fliks-upload.jks`).

---

## 5. Notes on the build pipeline

- `client/tizen/config.xml` declares the W3C widget manifest, the
  CSP, Tizen privileges and the application ID. Bumping the widget
  `version` field controls the output filename (`Fliks-<version>.wgt`).
- `client/tizen/build-wgt.mjs` stages the Angular build into
  `dist/tizen-stage/`, copies `config.xml` + `icon.png`, and zips
  the result. Signing is intentionally a separate step (`tizen package
  -t wgt -s <profile>`) so the same staged bundle can be signed with
  different profiles (dev TV vs. Seller Office submission).
- The Angular `tizen` build configuration disables
  `optimization.styles.inlineCritical`: the critters fallback uses
  an inline `onload` handler on `<link rel="stylesheet">` which the
  Tizen WebApp CSP (`script-src 'self' 'unsafe-eval'` — no
  `'unsafe-inline'`) blocks, leaving the page un-styled.
- The `serverConfigGuard` redirects to `/setup` on any standalone
  build (Capacitor native **or** Smart TV), prompting the user to
  enter their Fliks backend URL. The TV bundle, unlike a web build,
  is not served by the backend, so `/api/...` must be rewritten to
  an absolute URL by the `serverUrlInterceptor`.
