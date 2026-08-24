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

define Package/luci-app-mihomo/postinst
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f \
		/etc/mihomo/.mihomo.init.core \
		/etc/mihomo/.mihomo.init.core.absent \
		/etc/mihomo/.mihomo.init.core.enabled \
		/etc/mihomo/.mihomo.init.core.running
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
	/etc/init.d/luci-mihomo enable 2>/dev/null
	/etc/init.d/luci-mihomo restart 2>/dev/null || /etc/init.d/luci-mihomo start
}
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

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
