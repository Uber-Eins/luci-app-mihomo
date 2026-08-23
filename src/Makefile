GO ?= go
GOCACHE ?= $(CURDIR)/.go-build
GOMODCACHE ?= $(CURDIR)/.go-mod-cache
LUCI_VERSION ?= dev
TARGET := luci-mihomo

.PHONY: clean compile install test

compile:
	mkdir -p $(GOCACHE) $(GOMODCACHE)
	GOOS="$(GOOS)" GOARCH="$(GOARCH)" GO386="$(GO386)" GOAMD64="$(GOAMD64)" \
		GOARM="$(GOARM)" GOARM64="$(GOARM64)" GOMIPS="$(GOMIPS)" \
		GOMIPS64="$(GOMIPS64)" GOPPC64="$(GOPPC64)" \
		GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE) CGO_ENABLED=0 \
		$(GO) build -mod=vendor -modcacherw -buildvcs=false -trimpath -ldflags='-s -w -X main.version=$(LUCI_VERSION)' -o $(TARGET) ./cmd/luci-mihomo

install:
	mkdir -p $(DESTDIR)/usr/sbin
	cp $(TARGET) $(DESTDIR)/usr/sbin/$(TARGET)

clean:
	chmod -R u+w $(CURDIR)/.go-build $(CURDIR)/.go-mod-cache 2>/dev/null || true
	rm -rf $(TARGET) $(CURDIR)/.go-build $(CURDIR)/.go-mod-cache

test:
	$(GO) test ./...
