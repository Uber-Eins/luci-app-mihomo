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
	"sync"
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
	Connections []mihomoConnection `json:"connections"`
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

func defaultPublicIPFetcher(ipipEndpoint, ipsbEndpoint string) PublicIPFunc {
	return func(ctx context.Context, effectiveConfig string) (NetworkInformation, error) {
		port, err := proxyPortFromYAML(effectiveConfig)
		if err != nil {
			return NetworkInformation{}, err
		}
		proxy, _ := url.Parse("http://127.0.0.1:" + strconv.Itoa(port))
		transport := &http.Transport{
			Proxy:               http.ProxyURL(proxy),
			DialContext:         (&net.Dialer{Timeout: 4 * time.Second}).DialContext,
			TLSHandshakeTimeout: 4 * time.Second,
			DisableKeepAlives:   true,
		}
		defer transport.CloseIdleConnections()
		client := &http.Client{
			Transport: transport,
			Timeout:   10 * time.Second,
		}
		var information NetworkInformation
		var wait sync.WaitGroup
		wait.Add(2)
		go func() {
			defer wait.Done()
			information.IPIP = fetchIPIP(ctx, client, ipipEndpoint)
		}()
		go func() {
			defer wait.Done()
			information.IPSB = fetchIPSB(ctx, client, ipsbEndpoint)
		}()
		wait.Wait()
		return information, nil
	}
}

func fetchIPIP(ctx context.Context, client *http.Client, endpoint string) NetworkInformationSource {
	var payload struct {
		Ret  string `json:"ret"`
		Data struct {
			IP       string   `json:"ip"`
			Location []string `json:"location"`
		} `json:"data"`
	}
	if err := fetchPublicIPJSON(ctx, client, endpoint, &payload); err != nil {
		return NetworkInformationSource{Error: err.Error()}
	}
	if payload.Ret != "" && payload.Ret != "ok" {
		return NetworkInformationSource{Error: "ipip.net returned an unsuccessful response"}
	}
	location := make([]string, 0, len(payload.Data.Location))
	for _, part := range payload.Data.Location {
		if part = strings.TrimSpace(part); part != "" {
			location = append(location, part)
		}
	}
	return publicIPSource(payload.Data.IP, strings.Join(location, " "))
}

func fetchIPSB(ctx context.Context, client *http.Client, endpoint string) NetworkInformationSource {
	var payload struct {
		IP              string `json:"ip"`
		Country         string `json:"country"`
		Organization    string `json:"organization"`
		ASNOrganization string `json:"asn_organization"`
		ISP             string `json:"isp"`
	}
	if err := fetchPublicIPJSON(ctx, client, endpoint, &payload); err != nil {
		return NetworkInformationSource{Error: err.Error()}
	}
	organization := firstNonempty(payload.Organization, payload.ASNOrganization, payload.ISP)
	summary := strings.TrimSpace(strings.TrimSpace(payload.Country) + " " + organization)
	return publicIPSource(payload.IP, summary)
}

func fetchPublicIPJSON(ctx context.Context, client *http.Client, endpoint string, target interface{}) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("request through Mihomo proxy: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("network information service returned %s", response.Status)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(target); err != nil {
		return fmt.Errorf("decode network information: %w", err)
	}
	return nil
}

func publicIPSource(value, summary string) NetworkInformationSource {
	address := net.ParseIP(strings.TrimSpace(value))
	if address == nil {
		return NetworkInformationSource{Error: "network information service returned an invalid address"}
	}
	family := "IPv6"
	if address.To4() != nil {
		family = "IPv4"
	}
	return NetworkInformationSource{Address: address.String(), Family: family, Summary: strings.TrimSpace(summary)}
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
