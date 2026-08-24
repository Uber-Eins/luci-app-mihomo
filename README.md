# luci-app-mihomo

A lightweight, native LuCI management panel for Mihomo, built for ImmortalWrt 25.12 and modern JavaScript LuCI.

The package intentionally uses native LuCI components and Canvas/SVG instead of Vue, ECharts, external fonts, or a second web server. A small local manager provides:

- a Zashboard-inspired overview with live traffic, memory, connections, providers, rule hits, topology, and 1 hour to 30 day history;
- silent local connection aggregation by source IP, destination, process, outbound, proxy group, and rule;
- a privacy-preserving public-IP check that runs only on demand and travels through Mihomo's configured HTTP/mixed port;
- atomic source configuration editing and rollback after a failed reload health check;
- ordered Clash Party-style YAML overrides with separate draft, preview, and active states;
- bounded live log viewing over Mihomo's Unix controller.

## Configuration model

The browser edits `/etc/mihomo/config.base.yaml`. Enabled overrides are merged from top to bottom and produce `/etc/mihomo/config.yaml`. The effective configuration always contains:

```yaml
external-controller-unix: /run/mihomo/mihomo.sock
```

On first start, an existing `config.yaml` is adopted as the source and safely reconciled to enable the fixed Unix socket. Mihomo does not validate `secret` for Unix-socket API requests, so the panel deliberately sends no bearer credential. Mihomo creates the socket itself with mode `0666`; the panel therefore creates and reasserts the real security boundary, the root-owned `/run/mihomo` directory, with mode `0700` at panel startup and before it starts or reloads Mihomo. The controller socket and the panel's mode-`0600` manager socket share that runtime directory as `/run/mihomo/mihomo.sock` and `/run/mihomo/manager.sock`.

An apply operation stages `/tmp/mihomo-config.yaml.new`, invokes `mihomo -t -d /etc/mihomo -f /tmp/mihomo-config.yaml.new`, performs same-filesystem atomic renames, and reloads Mihomo only when it was already running. If the Unix controller does not become healthy, the old files are restored and the old service is restarted. A stopped service remains stopped.

Overrides implement recursive map merging, ordinary replacement for scalars and arrays, `key!` force replacement, `+key` array prepend, `key+` array append, and `<key>` escaping. Editing an override changes only the draft; activation requires an explicit preview and a digest-matched apply.

Statistics are stored in `/etc/mihomo/statistics.db`, flushed periodically, and pruned after 30 days. The collector and LuCI bridge expose no general-purpose file or command execution API.

The panel APK directly provides `/etc/init.d/mihomo`; the core package keeps its
optional init-script template outside `/etc/init.d`, so service takeover and
restore hooks are unnecessary. The panel-provided service sets procd `stdout`
and `stderr` forwarding to false, because the panel already consumes Mihomo's
`/logs` stream over the protected Unix controller and keeps it in a bounded
in-memory ring. Manager diagnostics still go to the system log; high-volume
Mihomo runtime logs do not.

## Build

Link this repository into an ImmortalWrt/OpenWrt feed, select `luci-app-mihomo`, then run:

```sh
make package/luci-app-mihomo/compile V=s
```

Go module sources are vendored, so the target package build does not fetch dependencies from the network.
On ImmortalWrt/OpenWrt 25.12 this produces APK packages under `bin/packages/<arch>/base/`; no IPK packaging path is used.

The checked-in workflow cross-compiles against the official ImmortalWrt 25.12.1
`mediatek/filogic` SDK (`aarch64_cortex-a53`). Every branch push first verifies
the SDK checksum, package architecture, APK metadata, and package integrity. A
successful push then updates that branch's `prerelease-<branch>` GitHub
prerelease; manual runs build an artifact without publishing a release.

The runtime expects Mihomo to be installed separately and to provide
`/usr/bin/mihomo`. It is intentionally not declared as a package dependency
because ImmortalWrt's official feeds do not provide a `mihomo` package; this
keeps the panel compatible with whichever Mihomo package source the firmware
uses. The panel APK provides the active `/etc/init.d/mihomo`, and both panel
services are enabled automatically after installation.

## Development checks

```sh
cd src
go test ./...
make clean compile
```

Tests exercise the user-visible manager API, including validation failures, revision conflicts, override preview semantics, stopped-state preservation, reload rollback, service controls, public IP handling, logs, and persistent history.
