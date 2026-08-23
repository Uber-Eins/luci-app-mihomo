include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mihomo
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0 MIT BSD-3-Clause
PKG_LICENSE_FILES:=LICENSE src/vendor/go.etcd.io/bbolt/LICENSE src/vendor/golang.org/x/sys/LICENSE src/vendor/gopkg.in/yaml.v3/LICENSE
PKG_MAINTAINER:=Camellia
PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_FLAGS:=no-mips16
PKG_BUILD_PARALLEL:=1

LUCI_TITLE:=Lightweight Mihomo management panel
LUCI_DESCRIPTION:=A lightweight LuCI panel with persistent Mihomo statistics, atomic YAML editing and ordered overrides.
LUCI_DEPENDS=+luci-base +ucode-mod-socket +ca-bundle $(GO_ARCH_DEPENDS)
LUCI_MAINTAINER:=Camellia
LUCI_URL:=https://github.com/camellia/luci-app-mihomo
LUCI_MINIFY_CSS:=0

define Package/luci-app-mihomo/preinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${PKG_UPGRADE:-0}" = "1" ] && exit 0

target=/etc/init.d/mihomo
state_dir=/etc/mihomo
backup="$${state_dir}/.mihomo.init.core"
absent="$${state_dir}/.mihomo.init.core.absent"
enabled="$${state_dir}/.mihomo.init.core.enabled"
running="$${state_dir}/.mihomo.init.core.running"
marker='# Managed by luci-app-mihomo.'

mkdir -p "$${state_dir}" || exit 1
chown root:root "$${state_dir}" || exit 1
chmod 0700 "$${state_dir}" || exit 1

[ ! -L "$${target}" ] || {
	echo "luci-mihomo: refusing symlink init script: $${target}" >&2
	exit 1
}
[ ! -e "$${target}" ] || [ -f "$${target}" ] || {
	echo "luci-mihomo: refusing non-regular init script: $${target}" >&2
	exit 1
}

if [ -f "$${target}" ] && ! grep -Fq "$${marker}" "$${target}"; then
	temporary="$${backup}.new"
	rm -f "$${temporary}"
	cp "$${target}" "$${temporary}" || exit 1
	chown root:root "$${temporary}" || exit 1
	chmod 0600 "$${temporary}" || exit 1
	mv -f "$${temporary}" "$${backup}" || exit 1
	rm -f "$${absent}" "$${enabled}" "$${running}"
	"$${target}" enabled >/dev/null 2>&1 && : > "$${enabled}"
	"$${target}" running >/dev/null 2>&1 && : > "$${running}"
	chmod 0600 "$${enabled}" "$${running}" 2>/dev/null || true
elif [ ! -e "$${target}" ] && [ ! -f "$${backup}" ]; then
	: > "$${absent}"
	chmod 0600 "$${absent}"
fi

exit 0
endef

define Package/luci-app-mihomo/postinst
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
}
exit 0
endef

define Package/luci-app-mihomo/prerm
[ -n "$${IPKG_INSTROOT}" ] || {
	case "$${PKG_UPGRADE:-0}:$${1:-remove}" in
		1:*|*:upgrade) ;;
		*)
			state_dir=/etc/mihomo
			backup="$${state_dir}/.mihomo.init.core"
			absent="$${state_dir}/.mihomo.init.core.absent"
			fallback=/usr/share/luci-mihomo/mihomo.init.core
			mkdir -p "$${state_dir}" || exit 1
			chown root:root "$${state_dir}" || exit 1
			chmod 0700 "$${state_dir}" || exit 1
			if [ ! -f "$${backup}" ] && [ ! -f "$${absent}" ]; then
				cp "$${fallback}" "$${backup}" || exit 1
				chown root:root "$${backup}" || exit 1
				chmod 0600 "$${backup}" || exit 1
			fi
			;;
	esac
}
exit 0
endef

define Package/luci-app-mihomo/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${PKG_UPGRADE:-0}" = "1" ] && exit 0

target=/etc/init.d/mihomo
state_dir=/etc/mihomo
backup="$${state_dir}/.mihomo.init.core"
absent="$${state_dir}/.mihomo.init.core.absent"
enabled="$${state_dir}/.mihomo.init.core.enabled"
running="$${state_dir}/.mihomo.init.core.running"

if [ -f "$${backup}" ] && [ ! -L "$${backup}" ]; then
	temporary="$${target}.restore"
	rm -f "$${temporary}"
	cp "$${backup}" "$${temporary}" || exit 1
	chown root:root "$${temporary}" || exit 1
	chmod 0755 "$${temporary}" || exit 1
	mv -f "$${temporary}" "$${target}" || exit 1
	[ ! -f "$${enabled}" ] || "$${target}" enable
	[ ! -f "$${running}" ] || "$${target}" start
elif [ ! -f "$${absent}" ]; then
	echo "luci-mihomo: original Mihomo init script is unavailable" >&2
	exit 1
fi

rm -f "$${backup}" "$${absent}" "$${enabled}" "$${running}"
exit 0
endef

include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

export GO:=$(STAGING_DIR_HOSTPKG)/lib/go-$(GO_HOST_VERSION)/bin/go
export GOOS:=$(GO_OS)
export GOARCH:=$(GO_ARCH)
export GO386:=$(GO_386)
export GOAMD64:=$(GO_AMD64)
export GOARM:=$(GO_ARM)
export GOARM64:=$(GO_ARM64)
export GOMIPS:=$(GO_MIPS)
export GOMIPS64:=$(GO_MIPS64)
export GOPPC64:=$(GO_PPC64)
export GOCACHE:=$(GO_BUILD_CACHE_DIR)
export GOMODCACHE:=$(GO_MOD_CACHE_DIR)
export GOENV:=off
export GOTOOLCHAIN:=local

# ImmortalWrt's APK packer does not expose apk-tools' replaces metadata.
# This scoped fakeroot wrapper adds it only to the main application APK.
FAKEROOT=$(PKG_BUILD_DIR)/apk-fakeroot

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
