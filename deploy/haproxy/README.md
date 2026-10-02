# haproxy + acme.sh deployment (host-level TLS)

haproxy runs as a system service on the host, Let's Encrypt certs are
provisioned with acme.sh, and the docker stack (`compose.yaml`) stays on
loopback only.

## Layout

- **haproxy** (host): `:80` (ACME challenge + redirect to https) and
  `:443` (TLS) -> `127.0.0.1:8000`
- **acme-webroot.service**: loopback-only `python3 -m http.server` on
  `127.0.0.1:8081` serving `/var/www/acme`; haproxy routes only
  `/.well-known/acme-challenge` there, so renewals never touch haproxy
- **/etc/certificates/**: one `<domain>.pem` (fullchain) +
  `<domain>.pem.key` pair per domain, loaded by haproxy via
  `ssl crt /etc/certificates` and SNI-selected. (This haproxy build loads
  every `<name>.pem` in the directory and looks for `<name>.pem.key`;
  bare `.key` files are ignored.)
- **docker**: app + postgres; the app is bound to `127.0.0.1:8000`
  (`PORT=127.0.0.1:8000` in `.env`) so only haproxy can reach it

## Setup (on the host)

```sh
apt install haproxy ufw
curl https://get.acme.sh | sh -s email=<you@example.com>

# 1. HTTP phase until the first cert exists
cp haproxy.cfg /etc/haproxy/haproxy.cfg
systemctl reload haproxy

# 2. challenge webroot
cp acme-webroot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now acme-webroot
mkdir -p /var/www/acme /etc/certificates

# 3. issue + stage (the --reloadcmd is stored with the domain and re-run
#    by acme.sh's cron on every renewal, which re-stages the files too)
acme.sh --issue -d <domain> -w /var/www/acme --server letsencrypt
acme.sh --install-cert -d <domain> \
    --key-file /etc/certificates/<domain>.pem.key \
    --fullchain-file /etc/certificates/<domain>.pem \
    --reloadcmd "/usr/sbin/service haproxy reload"

# 4. TLS phase
cp haproxy.cfg.tls /etc/haproxy/haproxy.cfg
systemctl reload haproxy

# 5. firewall
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Then the docker side, with `PORT=127.0.0.1:8000` and
`BASE_URL=https://<domain>` in `.env`:

```sh
docker compose up -d --build
```

## Adding a domain

Point DNS at this host, then repeat step 3 for the new domain. The
`--reloadcmd` reloads haproxy, and `ssl crt <dir>` picks up the new
`<domain>.pem` automatically -- no config change needed.

## Adding a service

Each service gets its own named backend (`backend ucodepen`, later
`backend <other>`, ...) on its own loopback port, and is routed by
frontend ACLs (path or host). Keep backend names service-specific --
never a generic `app` -- so the config stays readable as the list grows.

## Renewal

acme.sh's cron (root, 4x/day) renews ~30 days before expiry and re-runs
the stored install command, which re-stages the files and reloads haproxy.
No extra timers or units required.