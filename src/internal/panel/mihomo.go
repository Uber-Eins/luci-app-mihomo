package panel

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type mihomoClient struct {
	httpClient *http.Client
}

func newMihomoClient(socketPath string) *mihomoClient {
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns:          4,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
	}
	return &mihomoClient{httpClient: &http.Client{Transport: transport}}
}

func (client *mihomoClient) request(ctx context.Context, path string) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://mihomo"+path, nil)
	if err != nil {
		return nil, err
	}
	return request, nil
}

func (client *mihomoClient) getJSON(ctx context.Context, path string, target interface{}) error {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := client.request(requestCtx, path)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("Mihomo API %s returned %s: %s", path, response.Status, strings.TrimSpace(string(message)))
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16<<20))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode Mihomo API %s: %w", path, err)
	}
	return nil
}

func (client *mihomoClient) streamJSON(ctx context.Context, path string, consume func(json.RawMessage)) error {
	request, err := client.request(ctx, path)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("Mihomo API %s returned %s: %s", path, response.Status, strings.TrimSpace(string(message)))
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(strings.TrimSpace(string(line))) > 0 {
			consume(json.RawMessage(line))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

type connectionSnapshot struct {
	DownloadTotal uint64             `json:"downloadTotal"`
	UploadTotal   uint64             `json:"uploadTotal"`
	Connections   []mihomoConnection `json:"connections"`
}

type mihomoConnection struct {
	ID       string             `json:"id"`
	Metadata connectionMetadata `json:"metadata"`
	Upload   uint64             `json:"upload"`
	Download uint64             `json:"download"`
	Start    time.Time          `json:"start"`
	Chains   []string           `json:"chains"`
	Rule     string             `json:"rule"`
	Payload  string             `json:"rulePayload"`
}

type connectionMetadata struct {
	Network         string `json:"network"`
	Type            string `json:"type"`
	SourceIP        string `json:"sourceIP"`
	DestinationIP   string `json:"destinationIP"`
	SourcePort      string `json:"sourcePort"`
	DestinationPort string `json:"destinationPort"`
	Host            string `json:"host"`
	SniffHost       string `json:"sniffHost"`
	Process         string `json:"process"`
	ProcessPath     string `json:"processPath"`
}

type topologyConnection struct {
	ID          string   `json:"id"`
	Source      string   `json:"source"`
	Destination string   `json:"destination"`
	Process     string   `json:"process"`
	Network     string   `json:"network"`
	Upload      uint64   `json:"upload"`
	Download    uint64   `json:"download"`
	Chains      []string `json:"chains"`
	Rule        string   `json:"rule"`
}

type trackedConnection struct {
	SourceIP    string
	Destination string
	Process     string
	Outbound    string
	ProxyGroup  string
	Rule        string
	Upload      uint64
	Download    uint64
}

type providerSummary struct {
	Name        string    `json:"name"`
	Type        string    `json:"type"`
	VehicleType string    `json:"vehicleType"`
	UpdatedAt   time.Time `json:"updatedAt,omitempty"`
	Total       int       `json:"total"`
	Alive       int       `json:"alive"`
	Used        uint64    `json:"used,omitempty"`
	Limit       uint64    `json:"limit,omitempty"`
	Expire      int64     `json:"expire,omitempty"`
}

type providersResponse struct {
	Providers map[string]struct {
		Name        string    `json:"name"`
		Type        string    `json:"type"`
		VehicleType string    `json:"vehicleType"`
		UpdatedAt   time.Time `json:"updatedAt"`
		Proxies     []struct {
			Alive bool `json:"alive"`
		} `json:"proxies"`
		SubscriptionInfo struct {
			Upload   uint64 `json:"Upload"`
			Download uint64 `json:"Download"`
			Total    uint64 `json:"Total"`
			Expire   int64  `json:"Expire"`
		} `json:"subscriptionInfo"`
	} `json:"providers"`
}

type ruleSummary struct {
	Type     string `json:"type"`
	Payload  string `json:"payload"`
	Proxy    string `json:"proxy"`
	HitCount uint64 `json:"hitCount"`
}

type rulesResponse struct {
	Rules []struct {
		Type    string `json:"type"`
		Payload string `json:"payload"`
		Proxy   string `json:"proxy"`
		Extra   struct {
			HitCount uint64 `json:"hitCount"`
		} `json:"extra"`
	} `json:"rules"`
}

func destinationFor(connection mihomoConnection) string {
	for _, value := range []string{connection.Metadata.SniffHost, connection.Metadata.Host, connection.Metadata.DestinationIP} {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return "Unknown"
}

func trackConnection(connection mihomoConnection) trackedConnection {
	process := connection.Metadata.Process
	if process == "" {
		process = connection.Metadata.ProcessPath
	}
	outbound, group := "Unknown", "Unknown"
	if len(connection.Chains) > 0 {
		outbound = connection.Chains[0]
		group = connection.Chains[len(connection.Chains)-1]
	}
	rule := connection.Rule
	if connection.Payload != "" {
		rule += " / " + connection.Payload
	}
	return trackedConnection{
		SourceIP: connection.Metadata.SourceIP, Destination: destinationFor(connection), Process: process,
		Outbound: outbound, ProxyGroup: group, Rule: rule, Upload: connection.Upload, Download: connection.Download,
	}
}

func (connection trackedConnection) dimensions() map[string]string {
	return map[string]string{
		"source_ip":   connection.SourceIP,
		"destination": connection.Destination,
		"process":     connection.Process,
		"outbound":    connection.Outbound,
		"proxy_group": connection.ProxyGroup,
		"rule":        connection.Rule,
	}
}

func topologyFromConnection(connection mihomoConnection) topologyConnection {
	source := net.JoinHostPort(connection.Metadata.SourceIP, connection.Metadata.SourcePort)
	if connection.Metadata.SourceIP == "" {
		source = "Unknown"
	}
	process := connection.Metadata.Process
	if process == "" {
		process = connection.Metadata.ProcessPath
	}
	rule := connection.Rule
	if connection.Payload != "" {
		rule += " / " + connection.Payload
	}
	return topologyConnection{ID: connection.ID, Source: source, Destination: destinationFor(connection), Process: process, Network: connection.Metadata.Network, Upload: connection.Upload, Download: connection.Download, Chains: append([]string(nil), connection.Chains...), Rule: rule}
}

func defaultPublicIPFetcher(endpoint string) PublicIPFunc {
	return func(ctx context.Context, effectiveConfig string) (PublicIP, error) {
		port, err := proxyPortFromYAML(effectiveConfig)
		if err != nil {
			return PublicIP{}, err
		}
		proxy, _ := url.Parse("http://127.0.0.1:" + strconv.Itoa(port))
		client := &http.Client{
			Transport: &http.Transport{Proxy: http.ProxyURL(proxy), DialContext: (&net.Dialer{Timeout: 4 * time.Second}).DialContext, TLSHandshakeTimeout: 4 * time.Second, DisableKeepAlives: true},
			Timeout:   8 * time.Second,
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return PublicIP{}, err
		}
		request.Header.Set("Accept", "application/json")
		response, err := client.Do(request)
		if err != nil {
			return PublicIP{}, fmt.Errorf("request through Mihomo proxy: %w", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return PublicIP{}, fmt.Errorf("public IP service returned %s", response.Status)
		}
		var payload struct {
			IP string `json:"ip"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&payload); err != nil {
			return PublicIP{}, err
		}
		address := net.ParseIP(strings.TrimSpace(payload.IP))
		if address == nil {
			return PublicIP{}, fmt.Errorf("public IP service returned an invalid address")
		}
		family := "IPv6"
		if address.To4() != nil {
			family = "IPv4"
		}
		return PublicIP{Address: address.String(), Family: family}, nil
	}
}
