# home — household environment dashboard

`home.xinutec.org`: indoor climate and air quality per room, plus Claude Code
usage. Readings go into MariaDB and are served by a public Angular/Material
dashboard.

The sensors are on the home LAN, which isis (in a datacenter) cannot reach, so
readings are pushed to the API rather than pulled: the IQAir AirVisual Pro by a
Mac poller, the Govee BLE thermometers by the Mac and a phone listening for
them. The Mac's pushers live in `xinutec-infra/mac-mini/`.

```
IQAir (SMB), Govee (BLE) ──▶ Mac / phone ──HTTPS POST /api/ingest──▶ home.xinutec.org
                                                                        │
                                                      MariaDB ◀── Hono API ──▶ Angular
```

## Android app

A full-screen WebView onto the dashboard: [`android/README.md`](android/README.md).

## Stack
- Backend: Hono + Kysely + MariaDB (TypeScript, Node 24). Serves the built
  Angular app and the JSON API. Migrations run on startup.
- Frontend: Angular + Material 3, Chart.js. Built into the same image.
- API writes, Bearer `INGEST_TOKEN`: `POST /api/ingest`, `/api/ingest/batch`,
  `/api/usage`. `POST /api/telemetry` needs a Nextcloud sign-in.
- API reads, public: `GET /api/devices`, `/api/measurements?from&to&device&limit`,
  `/api/receivers`, `/api/usage`.

## Deploy (isis k3s, namespace `home`)
The `k8s/…` manifests live in the home monorepo (`xinutec/pippijn`
`code/kubes/home/k8s/`); run the manifest steps from that checkout.

First time:

1. DNS: `home` CNAME → `isis.xinutec.org` (in `code/dns/xinutec_org.tf`, `tofu apply`).
2. Secret: `ssh root@isis.xinutec.org 'bash -s' < k8s/secret.sh` (prints the INGEST_TOKEN).
3. Apply manifests (in order):
   ```
   ssh root@isis.xinutec.org 'kubectl apply -f -' < k8s/00-namespace.yaml
   # ...01-pvc, 02-db, 03-app, 05-ingress
   ```
4. Point the pushers at it (the INGEST_TOKEN goes in the Mac Keychain), then
   enable their launchd timers.

Every change: push to `main` (CI builds `xinutec/home:latest`), then
`scripts/deploy.sh`.
